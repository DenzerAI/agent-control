"""Lokale Loop-Sessions fuer Agent Control.

Der erste konkrete Loop ist der Angebotsloop: Er bindet sich an einen
Ursprungschat, zieht dessen letzte Nachrichten, erzeugt einen Angebotsentwurf,
prueft offene Punkte und meldet knapp in den Ursprungschat zurueck.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import get_conversation, get_db, get_msgs, save_msg

router = APIRouter()

ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = ROOT / "work" / "loops" / "runs"
OFFERS_DIR = ROOT / "work" / "loops" / "offers"
LOCKS_DIR = ROOT / "work" / "loops" / "locks"
BAUHOF_DIR = ROOT / "work" / "werkbank"
BAUHOF_TASKS_DIR = BAUHOF_DIR / "tasks"
BAUHOF_STATE_PATH = BAUHOF_DIR / "state.json"
ARTIFACTS_DIR = ROOT / "work" / "artifacts"
WEBSITE_DIR = ROOT / "work" / "denzer-ai" / "website"
WERKBANK_ENABLED = True
SERVICE_SOURCE_PATHS = [
    WEBSITE_DIR / "leistungen" / "index.html",
    WEBSITE_DIR / "_archive" / "katalog-vorschau.html",
    WEBSITE_DIR / "ai-sprint" / "index.html",
    WEBSITE_DIR / "wissen" / "welcher-ki-agent-passt-fuer-kmu" / "index.html",
]
LOCK_TTL_SECONDS = 15 * 60
SOURCE_READ_LIMIT = 180_000
BAUHOF_RATE_WINDOW_SECONDS = 60 * 60
BAUHOF_RATE_LIMIT_DEFAULT = 12
WORK_SESSION_TOOL_BUDGET_DEFAULT = 12
WORK_SESSION_TOKEN_BUDGET_DEFAULT = 250_000
WORK_SESSION_AUTO_ROUNDS_DEFAULT = 3


def _ensure_dirs() -> None:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    OFFERS_DIR.mkdir(parents=True, exist_ok=True)
    LOCKS_DIR.mkdir(parents=True, exist_ok=True)
    BAUHOF_TASKS_DIR.mkdir(parents=True, exist_ok=True)


def _now() -> float:
    return time.time()


def _iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or _now()).isoformat(timespec="seconds")


def _slug(text: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").lower()).strip("-")
    return value[:48] or "angebot"


def _clean(text: object, limit: int = 1200) -> str:
    value = str(text or "").replace("\x00", "")
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def _format_duration_ms(ms: int) -> str:
    seconds = max(0, round(int(ms or 0) / 1000))
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    rest = seconds % 60
    if minutes < 60:
        return f"{minutes}m{rest:02d}s"
    return f"{minutes // 60}h{minutes % 60:02d}m"


def _format_token_count(tokens: int) -> str:
    n = max(0, int(tokens or 0))
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")
    if n >= 1_000:
        return f"{n / 1_000:.1f}K".replace(".0K", "K")
    return str(n)


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "svg", "noscript"}:
            self._skip_depth += 1
        if tag in {"p", "li", "h1", "h2", "h3", "h4", "div", "section", "br"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "svg", "noscript"} and self._skip_depth:
            self._skip_depth -= 1
        if tag in {"p", "li", "h1", "h2", "h3", "h4", "div", "section"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self.parts.append(data)

    def text(self) -> str:
        return _clean(unescape(" ".join(self.parts)), 80_000)


def _run_path(run_id: str) -> Path:
    return RUNS_DIR / f"{run_id}.json"


def _read_run(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _write_run(run: dict[str, Any]) -> None:
    _ensure_dirs()
    path = _run_path(run["id"])
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _write_json(path: Path, data: Any) -> None:
    _ensure_dirs()
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _audit(
    *,
    action: str,
    parent: str,
    conv: dict[str, Any] | None,
    ok: bool,
    arguments: dict[str, Any],
    output: Any = None,
    error: str = "",
) -> int | None:
    try:
        from tools.audit import log_tool_audit

        tool_name = action if "." in action else f"loop.offer.{action}"
        return log_tool_audit(
            agent=(conv or {}).get("agent") or "main",
            project=(conv or {}).get("project") or "",
            conversation_id=parent or "",
            tool_name=tool_name,
            decision="allow" if ok else "error",
            risk="write",
            sandbox="loop-module",
            ok=ok,
            arguments=arguments,
            output=output,
            error=error,
        )
    except Exception:
        return None


@contextmanager
def _loop_lock(parent: str, customer: str):
    _ensure_dirs()
    key = _slug(f"{parent}-{customer}")
    path = LOCKS_DIR / f"{key}.lock"
    try:
        if path.exists() and (_now() - path.stat().st_mtime) > LOCK_TTL_SECONDS:
            path.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError("Für diesen Chat/Kunden läuft bereits ein Angebotsloop.") from exc
    try:
        os.write(fd, json.dumps({"parent": parent, "customer": customer, "ts": _now()}, ensure_ascii=False).encode("utf-8"))
        yield
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def _list_runs(limit: int = 30) -> list[dict[str, Any]]:
    _ensure_dirs()
    rows: list[dict[str, Any]] = []
    for path in sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        run = _read_run(path)
        if run:
            rows.append(run)
        if len(rows) >= max(1, min(limit, 100)):
            break
    return rows


def _recent_context(parent_conversation_id: str, limit: int = 18) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if not parent_conversation_id:
        return [], None
    conv = get_conversation(parent_conversation_id)
    if not conv:
        return [], None
    msgs = get_msgs(conv.get("agent") or "main", conv.get("project") or "", limit=limit, conversation_id=parent_conversation_id)
    compact = [
        {
            "author": m.get("author") or "",
            "content": _clean(m.get("content") or "", 900),
            "ts": m.get("ts"),
        }
        for m in msgs
        if _clean(m.get("content") or "", 20)
    ]
    return compact, conv


def _html_to_text(raw: str) -> str:
    parser = _HTMLTextExtractor()
    try:
        parser.feed(raw)
        return parser.text()
    except Exception:
        return _clean(re.sub(r"<[^>]+>", " ", raw), 80_000)


def _read_source_text(path: Path) -> str:
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")[:SOURCE_READ_LIMIT]
    except Exception:
        return ""
    if path.suffix.lower() in {".html", ".htm"}:
        return _html_to_text(raw)
    return _clean(raw, 80_000)


def _sentences(text: str) -> list[str]:
    compact = _clean(text, 80_000)
    rows = re.split(r"(?<=[.!?])\s+|\s+[·•]\s+|\n+", compact)
    return [_clean(row, 360) for row in rows if len(_clean(row, 360)) > 10]


def _keywords(customer: str, goal: str, notes: str) -> set[str]:
    stop = {
        "angebot", "angebote", "kunde", "kunden", "bitte", "einen", "eine", "oder", "und", "mit", "für", "fuer",
        "aus", "dem", "den", "der", "die", "das", "ist", "soll", "werden", "vorbereiten", "max", "mustermann",
    }
    text = f"{customer} {goal} {notes}".lower()
    words = {w for w in re.findall(r"[a-zäöüß0-9]{4,}", text) if w not in stop}
    return set(list(words)[:18])


def _score(text: str, keys: set[str]) -> int:
    lower = text.lower()
    return sum(1 for key in keys if key in lower)


def _has_unresolved_marker(text: str) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in ("fehlt", "unklar", "offen", "unbekannt", "tbd", "noch nicht", "nicht klar", "weiß ich nicht", "weiss ich nicht"))


def _price_items(text: str, limit: int = 4) -> list[str]:
    items: list[str] = []
    price_like = re.compile(
        r"(\d[\d.\s]{0,8}(?:,\d{2})?\s*(?:€|eur|euro)|(?:budget|preis|kosten|honorar|pauschal|netto|stundensatz)\s*[^\n.;]{0,24}\d|/h|pro stunde)",
        re.I,
    )
    for sentence in _sentences(text):
        if price_like.search(sentence) and not _has_unresolved_marker(sentence):
            items.append(sentence)
        if len(items) >= limit:
            break
    return items


def _scope_items(text: str, limit: int = 5) -> list[str]:
    items: list[str] = []
    scope_words = ("leistung", "paket", "umfang", "scope", "baustein", "modul", "setup", "workshop", "begleitung", "agent", "automatisierung", "angebot")
    for sentence in _sentences(text):
        lower = sentence.lower()
        if any(word in lower for word in scope_words) and not _has_unresolved_marker(sentence):
            items.append(sentence)
        if len(items) >= limit:
            break
    return items


def _timeline_items(text: str, limit: int = 3) -> list[str]:
    items: list[str] = []
    time_words = ("termin", "deadline", "start", "zeitplan", "woche", "wochen", "monat", "bis ", "ab ")
    value_words = ("januar", "februar", "märz", "maerz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember", "kw")
    for sentence in _sentences(text):
        lower = sentence.lower()
        has_time_value = bool(re.search(r"\d", lower)) or any(word in lower for word in value_words) or any(word in lower for word in ("woche", "wochen", "monat", "monate"))
        if any(word in lower for word in time_words) and has_time_value and not _has_unresolved_marker(sentence):
            items.append(sentence)
        if len(items) >= limit:
            break
    return items


def _source_document(path: Path, kind: str, keys: set[str]) -> dict[str, Any] | None:
    text = _read_source_text(path)
    if not text:
        return None
    price = _price_items(text)
    scope = _scope_items(text)
    timeline = _timeline_items(text)
    if not (price or scope or timeline):
        return None
    rel = str(path.relative_to(ROOT))
    return {
        "kind": kind,
        "label": rel,
        "path": rel,
        "score": _score(text, keys),
        "price": price,
        "scope": scope,
        "timeline": timeline,
    }


def _offer_sources(customer: str, goal: str, notes: str) -> list[dict[str, Any]]:
    keys = _keywords(customer, goal, notes)
    docs: list[dict[str, Any]] = []
    for path in (WEBSITE_DIR / "angebot").glob("**/index.html"):
        doc = _source_document(path, "previous_offer", keys)
        if doc:
            docs.append(doc)
    docs.sort(
        key=lambda row: (
            row.get("score") or 0,
            (ROOT / str(row.get("path") or "")).stat().st_mtime if (ROOT / str(row.get("path") or "")).exists() else 0,
        ),
        reverse=True,
    )
    return docs[:4]


def _catalog_sources(customer: str, goal: str, notes: str) -> list[dict[str, Any]]:
    keys = _keywords(customer, goal, notes)
    docs: list[dict[str, Any]] = []
    for path in SERVICE_SOURCE_PATHS:
        doc = _source_document(path, "service_catalog", keys)
        if doc:
            docs.append(doc)
    docs.sort(key=lambda row: row.get("score") or 0, reverse=True)
    return docs[:3]


def _first_source_value(sources: list[dict[str, Any]], field: str) -> tuple[dict[str, Any] | None, list[str]]:
    for source in sources:
        items = source.get(field) or []
        if items:
            return source, items
    return None, []


def _decision(label: str, field: str, source_sets: list[tuple[str, str, list[dict[str, Any]]]], placeholder: str) -> dict[str, Any]:
    for status, source_label, sources in source_sets:
        source, items = _first_source_value(sources, field)
        if source and items:
            return {
                "label": label,
                "status": status,
                "source": source.get("kind"),
                "source_label": source_label,
                "path": source.get("path") or "",
                "items": items[:4],
                "recommendation": items[0],
                "requires_approval": status != "resolved",
            }
    return {
        "label": label,
        "status": "placeholder",
        "source": "placeholder",
        "source_label": "Platzhalter",
        "path": "",
        "items": [placeholder],
        "recommendation": placeholder,
        "requires_approval": True,
    }


def _offer_basis(customer: str, goal: str, messages: list[dict[str, Any]], notes: str) -> dict[str, Any]:
    conversation_text = " ".join([notes, *[_clean(m.get("content"), 900) for m in messages[-12:]]])
    conversation_source = {
        "kind": "conversation_notes",
        "label": "Gesprächsnotizen und Ursprungschat",
        "path": "",
        "score": 999,
        "price": _price_items(conversation_text),
        "scope": _scope_items(conversation_text),
        "timeline": _timeline_items(conversation_text),
    }
    conversations = [conversation_source]
    offers = _offer_sources(customer, goal, notes)
    catalog = _catalog_sources(customer, goal, notes)
    source_sets = [
        ("resolved", "Gesprächsnotizen / Ursprungschat", conversations),
        ("suggested", "Ähnliche alte Angebote", offers),
        ("suggested", "Website-Leistungskatalog", catalog),
    ]
    return {
        "policy": {
            "start": "manual_only",
            "hook": "draft_only",
            "finalization": "human_approval_required",
        },
        "source_order": ["conversation_notes", "previous_offer", "service_catalog", "placeholder"],
        "sources": [conversation_source, *offers, *catalog],
        "pricing": _decision("Preis/Budget", "price", source_sets, "[Preis oder Budgetlogik ergänzen]"),
        "scope": _decision("Leistungsumfang", "scope", source_sets, "[Leistung, Bausteine und Grenzen ergänzen]"),
        "timeline": _decision("Zeitplan", "timeline", source_sets[:1], "[Starttermin und Zeitplan ergänzen]"),
    }


def _extract_signals(messages: list[dict[str, Any]]) -> dict[str, list[str]]:
    pain: list[str] = []
    scope: list[str] = []
    proof: list[str] = []
    for msg in messages[-12:]:
        text = _clean(msg.get("content"), 700)
        lower = text.lower()
        if any(k in lower for k in ("problem", "brauchen", "soll", "ziel", "wollen", "müssen", "muessen")):
            scope.append(text)
        if any(k in lower for k in ("schmerz", "aufwand", "zeit", "chaos", "fehler", "block", "belegt")):
            pain.append(text)
        if any(k in lower for k in ("beispiel", "angebot", "modul", "preview", "bericht", "loop")):
            proof.append(text)
    return {
        "pain": pain[-3:],
        "scope": scope[-4:],
        "proof": proof[-3:],
    }


def _decision_lines(decision: dict[str, Any]) -> list[str]:
    status = {
        "resolved": "belegt",
        "suggested": "Vorschlag",
        "placeholder": "Platzhalter",
    }.get(decision.get("status"), decision.get("status") or "offen")
    lines = [f"- **{decision.get('label')}**: {status} aus {decision.get('source_label')}"]
    for item in (decision.get("items") or [])[:3]:
        lines.append(f"  - {item}")
    if decision.get("requires_approval"):
        lines.append("  - Freigabe nötig, bevor daraus ein verbindliches Angebot wird.")
    return lines


def _offer_markdown(run: dict[str, Any], signals: dict[str, list[str]], missing: list[str], basis: dict[str, Any]) -> str:
    customer = run["input"]["customer"]
    goal = run["input"]["goal"]
    notes = run["input"].get("notes") or ""
    scope = signals.get("scope") or []
    pain = signals.get("pain") or []
    proof = signals.get("proof") or []
    lines = [
        f"# Angebotsskizze: {customer}",
        "",
        "## Ziel",
        goal,
        "",
        "## Ausgangslage",
    ]
    if pain or scope:
        for item in (pain + scope)[:5]:
            lines.append(f"- {item}")
    else:
        lines.append("- Noch keine belastbare Ausgangslage im Kontext erkannt.")
    lines += [
        "",
        "## Vorschlag",
        "- Angebot wird manuell gestartet, nicht automatisch finalisiert.",
        "- Quellen-Reihenfolge: Gesprächsnotizen → alte Angebote → Website-Leistungskatalog → Platzhalter.",
        "- Preis und Leistung werden nur übernommen, wenn sie belegt sind; sonst entstehen Vorschläge mit Freigabepflicht.",
        "",
        "## Preis- und Leistungslogik",
        *_decision_lines(basis.get("pricing") or {}),
        *_decision_lines(basis.get("scope") or {}),
        *_decision_lines(basis.get("timeline") or {}),
        "",
        "## Startlogik",
        "- Manueller Start im Loop-Modul erzeugt Lauf, Audit, Lock, HTML-Entwurf und Chat-Rückmeldung.",
        "- Hook/Shortcut bereitet nur Felder vor und öffnet das Modul.",
        "- Finalisierung bleibt menschliche Freigabe.",
        "",
        "## Belege aus dem Kontext",
    ]
    if proof:
        lines.extend(f"- {item}" for item in proof)
    else:
        lines.append("- Noch keine konkreten Belege erkannt.")
    if notes:
        lines += ["", "## Notizen", notes]
    lines += ["", "## Offene Punkte"]
    lines.extend(f"- {item}" for item in missing) if missing else lines.append("- Keine harten Lücken erkannt; fachliche Freigabe fehlt noch.")
    lines += [
        "",
        "## Nächster Schritt",
        "Entwurf im Modul prüfen, offene Punkte ergänzen, danach als verbindliches Angebot ausformulieren.",
    ]
    return "\n".join(lines).strip() + "\n"


def _html_items(items: list[str], fallback: str) -> str:
    rows = items or [fallback]
    return "\n".join(f"<li>{escape(item)}</li>" for item in rows)


def _html_decision(decision: dict[str, Any]) -> str:
    status = {
        "resolved": "belegt",
        "suggested": "Vorschlag",
        "placeholder": "Platzhalter",
    }.get(decision.get("status"), decision.get("status") or "offen")
    approval = "<p class=\"fine\">Freigabe nötig, bevor daraus ein verbindliches Angebot wird.</p>" if decision.get("requires_approval") else ""
    return f"""
      <article class="card">
        <div class="eyebrow">{escape(str(decision.get("label") or "Logik"))}</div>
        <h2>{escape(status)} <span class="muted">aus {escape(str(decision.get("source_label") or "Quelle"))}</span></h2>
        <ul>{_html_items([str(item) for item in (decision.get("items") or [])[:3]], "Noch kein belastbarer Inhalt.")}</ul>
        {approval}
      </article>
    """


def _source_rows(basis: dict[str, Any]) -> str:
    rows: list[str] = []
    for source in (basis.get("sources") or [])[:7]:
        label = source.get("label") or source.get("kind") or "Quelle"
        found = []
        if source.get("price"):
            found.append("Preis")
        if source.get("scope"):
            found.append("Leistung")
        if source.get("timeline"):
            found.append("Zeit")
        rows.append(f"{label} · {', '.join(found) if found else 'keine harten Treffer'}")
    return _html_items(rows, "Noch keine Quellen bewertet.")


def _offer_html(run: dict[str, Any], signals: dict[str, list[str]], missing: list[str], basis: dict[str, Any]) -> str:
    customer = run["input"]["customer"]
    goal = run["input"]["goal"]
    notes = run["input"].get("notes") or ""
    scope = signals.get("scope") or []
    pain = signals.get("pain") or []
    proof = signals.get("proof") or []
    status = "Offene Punkte" if missing else "Bereit zur Freigabe"
    generated = _iso(run.get("created_at"))
    context_items = (pain + scope)[:5]
    missing_items = missing or ["Keine harten Lücken erkannt; fachliche Freigabe fehlt noch."]
    notes_html = f"""
      <section>
        <div class="wrap">
          <div class="eyebrow">Notizen</div>
          <h2>Zusatzkontext</h2>
          <p>{escape(notes)}</p>
        </div>
      </section>
    """ if notes else ""
    return f"""<!doctype html>
<html lang="de" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Angebotsskizze: {escape(customer)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=Lora:ital,wght@1,400;1,700&display=swap" rel="stylesheet">
<style>
:root {{
  --bg:#1F1F1E; --bg-1:#2C2C2B; --bg-2:#353533; --border:#3A3A38; --border-soft:#2A2A29;
  --t1:#E6E6E3; --t2:#A1A1A0; --t3:#8A8278; --accent:#D97757; --accent-soft:rgba(217,119,87,.12);
  --warm:#D6C9A8; --ok:#9BBF8B; --max:980px;
}}
:root[data-theme="light"] {{
  --bg:#FAF9F5; --bg-1:#F5F3EC; --bg-2:#F0EEE6; --border:#E4E0D2; --border-soft:#ECEAE0;
  --t1:#1F1F1E; --t2:#5C5B57; --t3:#8A8983; --accent:#E07A4F; --accent-soft:rgba(224,122,79,.10);
  --warm:#9A8C68; --ok:#4D7F45;
}}
* {{ box-sizing:border-box; }}
html, body {{ margin:0; background:var(--bg); color:var(--t1); font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-size:17px; line-height:1.55; -webkit-font-smoothing:antialiased; }}
.wrap {{ max-width:var(--max); margin:0 auto; padding:0 24px; }}
.italic {{ font-family:'Lora',Georgia,serif; font-style:italic; font-weight:400; }}
header {{ padding:72px 0 56px; }}
section {{ padding:48px 0; border-top:1px solid var(--border-soft); }}
h1 {{ max-width:760px; margin:0 0 18px; font-size:clamp(40px,8vw,72px); font-weight:800; letter-spacing:0; line-height:1.03; }}
h2 {{ margin:0 0 16px; font-size:32px; font-weight:700; letter-spacing:0; line-height:1.15; }}
h3 {{ margin:0 0 10px; font-size:20px; font-weight:700; }}
p {{ margin:0; color:var(--t2); }}
.lead {{ max-width:700px; font-size:20px; color:var(--t2); }}
.eyebrow {{ margin-bottom:18px; color:var(--accent); font-size:13px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }}
.meta {{ display:flex; flex-wrap:wrap; gap:10px; margin-top:28px; color:var(--t3); font-size:14px; }}
.pill {{ border:1px solid var(--border); border-radius:999px; padding:7px 11px; background:var(--bg-1); }}
.grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }}
.card {{ background:var(--bg-1); border:1px solid var(--border); border-radius:14px; padding:24px; }}
.wide {{ grid-column:1/-1; }}
.muted {{ color:var(--t3); font-size:18px; font-weight:500; }}
.fine {{ margin-top:12px; color:var(--warm); font-size:14px; }}
ul {{ margin:0; padding:0; list-style:none; color:var(--t2); }}
li {{ position:relative; padding-left:20px; margin:9px 0; }}
li::before {{ content:"·"; position:absolute; left:0; top:-1px; color:var(--accent); font-size:20px; font-weight:800; }}
.status {{ color:{'var(--warm)' if missing else 'var(--ok)'}; }}
.quote {{ border-left:3px solid var(--accent); padding-left:18px; color:var(--t1); font-size:22px; line-height:1.35; }}
@media (max-width:760px) {{
  header {{ padding:52px 0 40px; }}
  section {{ padding:36px 0; }}
  .grid {{ grid-template-columns:1fr; }}
  .wide {{ grid-column:auto; }}
}}
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="eyebrow">Angebotsloop</div>
      <h1>Angebotsskizze für <span class="italic">{escape(customer)}</span></h1>
      <p class="lead">{escape(goal)}</p>
      <div class="meta">
        <span class="pill status">{escape(status)}</span>
        <span class="pill">Run {escape(run["id"])}</span>
        <span class="pill">{escape(generated)}</span>
      </div>
    </div>
  </header>
  <section>
    <div class="wrap grid">
      <article class="card wide">
        <div class="eyebrow">Ausgangslage</div>
        <h2>Was aus dem Kontext erkennbar ist</h2>
        <ul>{_html_items(context_items, "Noch keine belastbare Ausgangslage im Kontext erkannt.")}</ul>
      </article>
      <article class="card">
        <div class="eyebrow">Vorschlag</div>
        <h2>Entwurf statt geratenem Angebot</h2>
        <ul>
          <li>Quellen-Reihenfolge: Gesprächsnotizen, alte Angebote, Website-Leistungskatalog, Platzhalter.</li>
          <li>Preis und Leistung werden nur als belegt markiert, wenn sie im Gespräch oder in Notizen stehen.</li>
          <li>Alte Angebote und Website liefern Vorschläge, keine automatische Wahrheit.</li>
        </ul>
      </article>
      <article class="card">
        <div class="eyebrow">Startlogik</div>
        <h2>Manuell zuerst</h2>
        <ul>
          <li>Der Button im Modul erzeugt den echten Lauf mit Lock, Audit und HTML.</li>
          <li>Ein Hook darf nur vorbefüllen und das Modul öffnen.</li>
          <li>Finalisierung bleibt Freigabe durch der Nutzer.</li>
        </ul>
      </article>
    </div>
  </section>
  <section>
    <div class="wrap grid">
      {_html_decision(basis.get("pricing") or {})}
      {_html_decision(basis.get("scope") or {})}
      {_html_decision(basis.get("timeline") or {})}
      <article class="card">
        <div class="eyebrow">Quellen</div>
        <h2>Bewertete Grundlage</h2>
        <ul>{_source_rows(basis)}</ul>
      </article>
    </div>
  </section>
  <section>
    <div class="wrap grid">
      <article class="card">
        <div class="eyebrow">Belege</div>
        <h2>Signale aus dem Chat</h2>
        <ul>{_html_items(proof, "Noch keine konkreten Belege erkannt.")}</ul>
      </article>
      <article class="card">
        <div class="eyebrow">Verifier</div>
        <h2>Offene Punkte</h2>
        <ul>{_html_items(missing_items, "Keine harten Lücken erkannt; fachliche Freigabe fehlt noch.")}</ul>
      </article>
    </div>
  </section>
  {notes_html}
  <section>
    <div class="wrap">
      <p class="quote">Nächster Schritt: Entwurf im Modul prüfen, offene Punkte ergänzen, danach als verbindliches Angebot ausformulieren.</p>
    </div>
  </section>
</body>
</html>
"""


def _verify(customer: str, goal: str, basis: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if len(customer.strip()) < 2:
        missing.append("Kunde/Empfänger fehlt.")
    if len(goal.strip()) < 12:
        missing.append("Ziel ist noch zu kurz für ein belastbares Angebot.")
    pricing = basis.get("pricing") or {}
    scope = basis.get("scope") or {}
    timeline = basis.get("timeline") or {}
    if pricing.get("status") != "resolved":
        missing.append("Preis/Budget ist nicht hart belegt; Vorschlag oder Platzhalter braucht Freigabe.")
    if scope.get("status") != "resolved":
        missing.append("Leistungsumfang ist nicht hart belegt; Vorschlag oder Platzhalter braucht Freigabe.")
    if timeline.get("status") != "resolved":
        missing.append("Zeitplan/Starttermin fehlt als harte Vorgabe.")
    return missing


async def _report_to_parent(run: dict[str, Any]) -> None:
    parent = run.get("parent_conversation_id") or ""
    if not parent:
        return
    conv = get_conversation(parent)
    if not conv:
        return
    missing = run.get("verifier", {}).get("missing") or []
    status = "fertig, aber mit offenen Punkten" if missing else "fertig"
    preview = run.get("artifacts", {}).get("html_path") or run.get("artifacts", {}).get("markdown_path") or ""
    lines = [
        f"Angebotsloop {status}: {run['input']['customer']}.",
        "",
        f"Run: {run['id']}",
    ]
    if missing:
        lines += ["", "Offen:", *[f"- {item}" for item in missing[:4]]]
    if preview:
        lines += ["", f"HTML-Entwurf: `{preview}`"]
    save_msg(
        agent=conv.get("agent") or "main",
        project=conv.get("project") or "",
        author="assistant",
        content="\n".join(lines),
        conversation_id=parent,
    )
    try:
        from streaming import broadcast_sync

        await broadcast_sync(conv.get("agent") or "main", parent, source="loops")
    except Exception:
        pass


def _bauhof_task_path(task_id: str) -> Path:
    return BAUHOF_TASKS_DIR / f"{_slug(task_id)}.json"


def _bauhof_protocol_path(task_id: str) -> Path:
    return BAUHOF_DIR / task_id / "protokoll.md"


def _read_bauhof_task(path: Path) -> dict[str, Any] | None:
    data = _read_json(path, None)
    return data if isinstance(data, dict) else None


def _write_bauhof_task(task: dict[str, Any]) -> None:
    _write_json(_bauhof_task_path(task["id"]), task)


def create_werkbank_chat_task(
    *,
    parent_conversation_id: str,
    title: str,
    brief: str,
    engine: str = "",
    project: str = "",
    reason: str = "",
    acceptance: str = "",
    worker_conversation_id: str = "",
    initial_status: str = "running",
    pane_index: int | None = None,
) -> dict[str, Any] | None:
    """Register a chat turn as Werkbank work without starting another worker.

    The active chat engine is the worker. This only makes the handoff visible:
    origin, task, current state, and later the result.
    """
    if not WERKBANK_ENABLED:
        return None
    parent = _clean(parent_conversation_id, 80)
    brief = _clean(brief, 4000)
    if not parent or not brief:
        return None
    title = re.sub(r"^(Werkbank|Arbeitsauftrag)\s*[:·-]\s*", "", _clean(title, 90), flags=re.I).strip() or "Auftrag aus Chat"
    acceptance = _clean(acceptance, 1000) or "Der Werkbank-Worker liefert Ergebnis, geänderte Dateien oder klaren Blocker zurück in den Ursprungschat."
    worker_conversation_id = _clean(worker_conversation_id, 80)
    status = initial_status if initial_status in {"queued", "running"} else "running"
    worker_status = "queued" if status == "queued" else "running"
    task_id = f"werk-chat-{int(_now())}-{uuid.uuid4().hex[:6]}"
    task: dict[str, Any] = {
        "id": task_id,
        "kind": "werkbank",
        "title": title,
        "status": status,
        "priority": "normal",
        "created_at": _now(),
        "updated_at": _now(),
        "origin": _bauhof_origin(parent, pane_index),
        "request": {
            "brief": brief,
            "acceptance": acceptance,
            "notes": _clean(f"Auslöser: {reason or 'Chat-Arbeitslauf'}. Engine: {engine}. Projekt: {project}. Worker-Chat: {worker_conversation_id}.", 3000),
            "source": "work_session" if worker_conversation_id else "chat",
            "worker_conversation_id": worker_conversation_id,
        },
        "loop": {
            "round": 1,
            "max_rounds": WORK_SESSION_AUTO_ROUNDS_DEFAULT if worker_conversation_id else 1,
            "policy": "chat -> work-session -> result",
        },
        "workers": [
            {"id": "chat-runner", "role": "Arbeitslauf-Worker", "status": worker_status, "summary": worker_conversation_id or engine or "laufender Chat"},
            {"id": "verifier", "role": "Verifier", "status": "queued"},
        ],
        "verifier": {"decision": "pending", "findings": []},
        "artifacts": {},
        "history": [
            _bauhof_event("Übergabe", "Aus dem Ursprungschat als sichtbarer Arbeitslauf angelegt."),
            _bauhof_event("Start", "Arbeitslauf-Worker wartet im Hintergrund." if worker_conversation_id else "Chat-Worker arbeitet im Ursprungschat weiter."),
        ],
        "next_action": "Läuft im Hintergrund; Ergebnis wird nach Abschluss zurückgemeldet." if worker_conversation_id else "Läuft im Ursprungschat; Ergebnis wird nach Abschluss hier vermerkt.",
    }
    task["artifacts"] = {"protocol_path": _bauhof_write_protocol(task)}
    _write_bauhof_task(task)
    return task


def _bauhof_worker_conv(task: dict[str, Any]) -> str:
    return _clean((task.get("request") or {}).get("worker_conversation_id"), 80)


def _bauhof_pending_followups(task: dict[str, Any]) -> list[dict[str, Any]]:
    return [f for f in (task.get("followups") or []) if isinstance(f, dict) and f.get("status") == "pending"]


def _bauhof_append_followup(task: dict[str, Any], text: str) -> dict[str, Any] | None:
    """Haengt einen Nachtrag ins Postfach des Auftrags. Wird beim naechsten
    Lauf-Ende automatisch gezogen, ruht der Auftrag schon, startet ihn der
    Endpunkt sofort als Folge-Lauf."""
    text = _clean(text, 2000)
    if not text:
        return None
    entry = {"id": uuid.uuid4().hex[:8], "text": text, "created_at": _now(), "status": "pending"}
    task.setdefault("followups", []).append(entry)
    task["updated_at"] = _now()
    task.setdefault("history", []).append(_bauhof_event("Nachtrag", _clean(text, 160), "ok"))
    return entry


def _bauhof_enqueue_followup_run(task: dict[str, Any]) -> bool:
    """Zieht alle offenen Nachtraege und reiht einen Folge-Lauf fuer den
    Worker-Chat ein. Der Folge-Prompt traegt wieder die Werkbank-Task-ID, damit
    der Lauf am Ende erneut durchs Postfach geht (mehrere Nachtraege in Folge)."""
    pending = _bauhof_pending_followups(task)
    work_conv = _bauhof_worker_conv(task)
    if not pending or not work_conv:
        return False
    conv = get_conversation(work_conv) or {}
    agent_id = conv.get("agent") or "main"
    task_id = task.get("id") or ""
    notes = "\n".join(f"- {f.get('text')}" for f in pending)
    prompt = (
        f"Werkbank-Task-ID: {task_id}\n"
        "Folge-Lauf mit Nachtraegen aus dem Ursprungschat. Der vorige Lauf dieses Auftrags ist durch; "
        "der Nutzer hat waehrenddessen noch Folgendes nachgereicht. Arbeite es auf dem bisherigen Stand ein, "
        "ohne von vorne zu beginnen, und melde dein Ergebnis danach knapp zurueck.\n\n"
        f"Nachtraege:\n{notes}"
    )
    item_id = f"werkbank-followup-{task_id}-{int(_now())}"
    try:
        with get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (item_id, work_conv, prompt, "[]", agent_id, time.time()),
            )
    except Exception as e:  # noqa: BLE001
        print(f"[werkbank] followup enqueue failed: {e}", flush=True)
        return False
    for f in pending:
        f["status"] = "consumed"
        f["consumed_at"] = _now()
    task["status"] = "running"
    task["reported_at"] = 0
    for worker in task.get("workers") or []:
        if worker.get("id") == "chat-runner":
            worker["status"] = "running"
    task.setdefault("history", []).append(_bauhof_event("Nachtrag", f"{len(pending)} Nachtrag(e) als Folge-Lauf eingereiht.", "ok"))
    task["next_action"] = "Folge-Lauf mit deinen Nachträgen läuft im Hintergrund."
    task["updated_at"] = _now()
    return True



_WERKBANK_CLOSING_LABELS = (
    ("fertig", ("FERTIG", "ERGEBNIS")),
    ("geaendert", ("GEAENDERT", "GEÄNDERT", "GEAENDERTE", "GEÄNDERTE DATEIEN")),
    ("du_kannst", ("DU KANNST", "DU-KANNST", "NAECHSTER SCHRITT", "NÄCHSTER SCHRITT")),
)


def _parse_werkbank_closing(text: str) -> dict:
    """Extrahiert den dreizeiligen Worker-Abschluss (FERTIG/GEAENDERT/DU KANNST).
    Gibt leeres Dict zurueck, wenn keiner der Marker gefunden wurde."""
    out: dict = {}
    if not text:
        return out
    for raw_line in str(text).splitlines():
        line = raw_line.strip().lstrip("*-•").strip()
        for key, labels in _WERKBANK_CLOSING_LABELS:
            for lab in labels:
                if line.upper().startswith(lab + ":") or line.upper().startswith(lab + " :"):
                    val = line.split(":", 1)[1].strip()
                    if val:
                        out[key] = val
                    break
    return out


def _werkbank_report_body(summary: str, title: str, final_status: str, next_action: str) -> str:
    """Baut den editorialen Abschluss-Post: klarer Status, was gebaut wurde,
    was der Nutzer tun kann. Faellt auf gekuerzten Rohtext zurueck."""
    text = (summary or "").strip()
    fields = _parse_werkbank_closing(text)
    parts: list[str] = []
    if final_status == "done":
        parts.append(f"**{title}** ist fertig.")
    else:
        parts.append(f"**{title}** hängt noch und braucht eine Nacharbeit.")
    if fields.get("fertig"):
        parts.append(_clean(fields["fertig"], 400))
    elif not fields:
        first = _clean(text, 360)
        if first:
            parts.append(first)
    if fields.get("geaendert"):
        parts.append(f"**Geändert:** {_clean(fields['geaendert'], 320)}")
    tun = fields.get("du_kannst") or (next_action or "")
    if tun:
        parts.append(f"**Du kannst:** {_clean(tun, 300)}")
    return "\n\n".join(p for p in parts if p)


_ACCEPTANCE_FALLBACK = "Der Werkbank-Worker liefert Ergebnis, geänderte Dateien oder klaren Blocker zurück in den Ursprungschat."


def _bauhof_acceptance_check(task: dict[str, Any], summary: str, changed: dict[str, int]) -> dict[str, Any] | None:
    """Haelt das gemeldete Ergebnis gegen die Abnahme des Auftrags.

    Verdikt: erfuellt / halb / zurueck / unklar. Ohne echte Abnahme (nur die
    Fallback-Floskel) gibt es nichts zu pruefen. Bei unklar wird nicht
    automatisch nachgearbeitet, aber auch nicht als fertig abgeschlossen.
    """
    request = task.get("request") or {}
    acceptance = _clean(request.get("acceptance"), 1000)
    if not acceptance or acceptance == _ACCEPTANCE_FALLBACK:
        return None
    brief = _clean(request.get("brief"), 1500)
    result = _clean(summary, 1200) or "(keine Ergebnis-Zusammenfassung gemeldet)"
    added = int((changed or {}).get("added", 0) or 0)
    removed = int((changed or {}).get("removed", 0) or 0)
    prompt = (
        f"Auftrag:\n{brief}\n\n"
        f"Abnahme:\n{acceptance}\n\n"
        f"Gemeldetes Ergebnis:\n{result}\nGeaenderte Zeilen: +{added} / -{removed}\n\n"
        "Urteile streng nach der Abnahme, nicht nach dem Fleiss des Laufs."
    )
    system = (
        "Du bist der Abnahme-Pruefer einer Werkbank. Vergleiche das gemeldete Ergebnis mit der Abnahme. "
        'Antworte NUR mit einem JSON-Objekt: {"decision": "erfuellt"|"halb"|"zurueck", "maengel": ["..."]}. '
        "erfuellt = Abnahme plausibel erfuellt. halb = Kern erledigt, konkrete Punkte fehlen. "
        "zurueck = Abnahme verfehlt. maengel nur bei halb oder zurueck, je ein konkreter pruefbarer Satz auf Deutsch."
    )
    verdict, maengel, model = "unklar", [], ""
    try:
        from local_llm import LOCAL_LLM_MODEL, call_local_sync
        raw = call_local_sync(prompt, system=system, max_tokens=260, temperature=0.1, timeout=12.0, feature="werkbank_verifier")
        data: dict[str, Any] = {}
        idx = raw.find("{")
        while idx != -1:
            try:
                candidate, _ = json.JSONDecoder().raw_decode(raw[idx:])
                if isinstance(candidate, dict):
                    data = candidate
                    break
            except ValueError:
                pass
            idx = raw.find("{", idx + 1)
        decision = str(data.get("decision") or "").strip().lower()
        decision = {"erfüllt": "erfuellt", "zurück": "zurueck"}.get(decision, decision)
        if decision in {"erfuellt", "halb", "zurueck"}:
            verdict = decision
            maengel = [_clean(m, 240) for m in (data.get("maengel") or []) if _clean(m, 240)][:5]
        model = LOCAL_LLM_MODEL
    except Exception as e:  # noqa: BLE001
        print(f"[werkbank] acceptance check failed: {e}", flush=True)
    if verdict in {"halb", "zurueck"} and not maengel:
        verdict = "unklar"
    return {"verdict": verdict, "maengel": maengel, "model": model, "checked_at": _now()}


def _werkbank_blocker_findings(summary: str, status: str) -> list[str]:
    text = f"{status}\n{summary or ''}".lower()
    findings: list[str] = []

    sandbox_degraded_intentionally = any(
        marker in text
        for marker in (
            "sandbox_exec_required\": false",
            "sandbox_exec_required': false",
            "sandbox-exec ist kein pflichtpfad",
            "sandbox-exec ist deprecated und nicht mehr pflichtpfad",
            "nicht mehr pflichtpfad für shell.run",
            "not required for shell.run",
            "shell.run does not depend on it",
            "deprecated_optional_for_code_run_only",
            "code_sandbox_unavailable",
        )
    )
    if ("sandbox-exec" in text or "operation not permitted" in text) and not sandbox_degraded_intentionally:
        findings.append("Sandbox-Ausführung blockiert den Lauf.")
    if "no module named fastapi" in text:
        findings.append("Werkbank-Spawn traf einen falschen Python-Kontext ohne FastAPI.")
    blocker_words = (
        "blockiert", "blocked", "fehlgeschlagen", "failed", "konnte nicht",
        "nicht möglich", "nicht moeglich", "haengt", "hängt",
    )
    blocked_domains = (
        "deploy", "deployment", "live-check", "live check", "netzwerk", "network",
        "sandbox", "permission", "freigabe", "approval", "admin", "external",
        "extern", "secret", "sensible",
    )
    if any(word in text for word in blocker_words) and any(domain in text for domain in blocked_domains):
        findings.append("Worker meldet einen belegten Blocker statt ein abgeschlossenes Ergebnis.")
    return list(dict.fromkeys(findings))


def _bauhof_enqueue_verifier_rerun(task: dict[str, Any], check: dict[str, Any]) -> bool:
    """Reiht nach einem halb/zurueck-Verdikt genau einen Korrektur-Lauf ein.

    Hartes Limit von einem Auto-Nachlauf pro Auftrag, damit Pruefer und Worker
    sich nicht gegenseitig in einer Schleife halten. Ohne eigenen Worker-Chat
    (Auftrag lief im Ursprungschat) wird nie automatisch nachgestartet.
    """
    if int(task.get("verifier_reruns") or 0) >= 1:
        return False
    work_conv = _bauhof_worker_conv(task)
    if not work_conv:
        return False
    maengel = [_clean(m, 240) for m in (check.get("maengel") or []) if _clean(m, 240)][:5]
    if not maengel:
        return False
    conv = get_conversation(work_conv) or {}
    agent_id = conv.get("agent") or "main"
    task_id = task.get("id") or ""
    notes = "\n".join(f"- {m}" for m in maengel)
    prompt = (
        f"Werkbank-Task-ID: {task_id}\n"
        "Abnahme-Pruefung: Der vorige Lauf dieses Auftrags erfuellt die Abnahme noch nicht voll. "
        "Behebe genau diese Maengel auf dem bisherigen Stand, ohne von vorne zu beginnen, "
        "und melde dein Ergebnis danach knapp zurueck.\n\n"
        f"Maengel:\n{notes}"
    )
    item_id = f"werkbank-verifier-{task_id}-{int(_now())}"
    try:
        with get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (item_id, work_conv, prompt, "[]", agent_id, time.time()),
            )
    except Exception as e:  # noqa: BLE001
        print(f"[werkbank] verifier rerun enqueue failed: {e}", flush=True)
        return False
    task["verifier_reruns"] = int(task.get("verifier_reruns") or 0) + 1
    task["status"] = "running"
    task["reported_at"] = 0
    for worker in task.get("workers") or []:
        if worker.get("id") == "chat-runner":
            worker["status"] = "running"
        if worker.get("id") == "verifier":
            worker["status"] = "running"
            worker["summary"] = "Abnahme-Prüfung fand Mängel, Korrektur-Lauf läuft."
    task["verifier"] = {
        "decision": "stay",
        "findings": maengel,
        "checked_at": _now(),
        "summary": "Stay: Abnahme noch nicht erfüllt, Korrektur-Lauf eingereiht.",
        "acceptance_check": check,
    }
    task.setdefault("history", []).append(_bauhof_event("Abnahme-Prüfung", f"Korrektur-Lauf eingereiht: {len(maengel)} Mangelpunkt(e).", "needs_work"))
    task["next_action"] = "Korrektur-Lauf zur Abnahme läuft im Hintergrund."
    task["updated_at"] = _now()
    return True


def _bauhof_auto_round_limit(task: dict[str, Any]) -> int:
    loop = task.setdefault("loop", {})
    configured = max(1, min(int(loop.get("max_rounds") or 1), 8))
    if (task.get("request") or {}).get("source") == "work_session" and configured < WORK_SESSION_AUTO_ROUNDS_DEFAULT:
        configured = WORK_SESSION_AUTO_ROUNDS_DEFAULT
        loop["max_rounds"] = configured
    return configured


def _bauhof_enqueue_auto_rerun(task: dict[str, Any], findings: list[str], reason: str) -> bool:
    """Schickt einen unklaren/blockierten Werkbank-Lauf automatisch zurück
    in denselben Worker-Chat, solange das Rundenlimit nicht erreicht ist.

    der Nutzer soll keinen technischen Blocker lösen müssen. Erst wenn die
    automatische Nacharbeit ausgeschöpft ist oder kein Worker-Chat existiert,
    bleibt der Auftrag sichtbar stehen.
    """
    if task.get("status") in {"canceled", "deleted", "rate_limited"}:
        return False
    work_conv = _bauhof_worker_conv(task)
    if not work_conv:
        return False
    loop = task.setdefault("loop", {})
    current_round = max(1, int(loop.get("round") or 1))
    max_rounds = _bauhof_auto_round_limit(task)
    if current_round >= max_rounds:
        return False
    clean_findings = [_clean(item, 260) for item in findings if _clean(item, 260)]
    if not clean_findings:
        clean_findings = [_clean(reason or "Abnahme unklar.", 260)]
    conv = get_conversation(work_conv) or {}
    agent_id = conv.get("agent") or "main"
    task_id = task.get("id") or ""
    notes = "\n".join(f"- {item}" for item in clean_findings[:8])
    prompt = (
        f"Werkbank-Task-ID: {task_id}\n"
        "Automatische Werkbank-Nacharbeit. Der vorige Lauf ist nicht abnahmefähig "
        "und darf nicht als Aufgabe bei der Nutzer landen. Arbeite auf dem bisherigen "
        "Stand weiter, löse den Befund ursächlich oder liefere einen wirklich belegten "
        "externen Blocker. Wenn du nicht verifizieren kannst, baue den fehlenden Check "
        "oder markiere präzise, welche Systemgrenze außerhalb der Werkbank liegt.\n\n"
        f"Grund: {reason}\n\n"
        f"Befund:\n{notes}"
    )
    item_id = f"werkbank-auto-{task_id}-{int(_now())}"
    try:
        with get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (item_id, work_conv, prompt, "[]", agent_id, time.time()),
            )
    except Exception as e:  # noqa: BLE001
        print(f"[werkbank] auto rerun enqueue failed: {e}", flush=True)
        return False
    loop["round"] = current_round + 1
    task["auto_reruns"] = int(task.get("auto_reruns") or 0) + 1
    task["status"] = "running"
    task["reported_at"] = 0
    for worker in task.get("workers") or []:
        if worker.get("id") == "chat-runner":
            worker["status"] = "running"
            worker["summary"] = f"Automatische Nacharbeit läuft: {reason}"
        if worker.get("id") == "verifier":
            worker["status"] = "running"
            worker["summary"] = "Blocker/unklare Abnahme wurde automatisch zurück in die Werkbank geschickt."
    task["verifier"] = {
        "decision": "stay",
        "findings": clean_findings,
        "checked_at": _now(),
        "summary": "Stay: automatische Nacharbeit eingereiht.",
    }
    task.setdefault("history", []).append(_bauhof_event("Auto-Nacharbeit", f"Runde {loop['round']} / {max_rounds} eingereiht: {reason}", "needs_work"))
    task["next_action"] = "Automatische Nacharbeit läuft im Hintergrund."
    task["updated_at"] = _now()
    return True


def finish_werkbank_chat_task(
    task_id: str | None,
    *,
    status: str,
    summary: str = "",
    did_work: bool = False,
    tool_count: int = 0,
    elapsed_ms: int | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    changed_lines: dict[str, int] | None = None,
) -> str | None:
    if not task_id:
        return None
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return None
    # Postfach: Kamen waehrend des Laufs Nachtraege, nicht abschliessen, sondern
    # sie als Folge-Lauf auf dem bisherigen Stand einarbeiten.
    if _bauhof_pending_followups(task) and _bauhof_enqueue_followup_run(task):
        task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
        _write_bauhof_task(task)
        return None
    final_status = "blocked" if status in {"stopped", "blocked"} else ("done" if status == "ok" else "needs_work")
    blocker_findings = _werkbank_blocker_findings(summary, status)
    if final_status == "done" and blocker_findings:
        final_status = "blocked"
    if final_status == "blocked" and status != "stopped":
        if _bauhof_enqueue_auto_rerun(task, blocker_findings, "Blocker erkannt"):
            task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
            _write_bauhof_task(task)
            return None
    acceptance_check: dict[str, Any] | None = None
    if final_status == "done":
        acceptance_check = _bauhof_acceptance_check(task, summary, changed_lines or {})
        if (acceptance_check or {}).get("verdict") in {"halb", "zurueck"}:
            if _bauhof_enqueue_verifier_rerun(task, acceptance_check or {}):
                # Nicht abschliessen: der Korrektur-Lauf kommt nach seinem Ende
                # erneut hier durch und wird dann regulaer abgenommen.
                task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
                _write_bauhof_task(task)
                return None
            final_status = "needs_work"
        elif (acceptance_check or {}).get("verdict") == "unklar":
            if _bauhof_enqueue_auto_rerun(task, ["Abnahme nicht maschinell prüfbar; Ergebnis bleibt unklar."], "Abnahme unklar"):
                task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
                _write_bauhof_task(task)
                return None
            final_status = "needs_work"
    acc_verdict = str((acceptance_check or {}).get("verdict") or "")
    task["status"] = final_status
    task["updated_at"] = _now()
    changed = changed_lines or {}
    token_count = int(input_tokens or 0) + int(output_tokens or 0)
    is_work_session = (task.get("request") or {}).get("source") == "work_session"
    tool_budget = 0  # Sparziel lebt nur als Prompt-Nudge; in der UI keinen Nenner/Strafanzeige zeigen
    token_budget = WORK_SESSION_TOKEN_BUDGET_DEFAULT if is_work_session else 0
    task["metrics"] = {
        **(task.get("metrics") or {}),
        "elapsed_ms": int(elapsed_ms or 0),
        "tool_count": int(tool_count or 0),
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "tool_budget": tool_budget,
        "token_budget": token_budget,
        "tool_budget_exceeded": bool(tool_budget and int(tool_count or 0) > tool_budget),
        "token_budget_exceeded": bool(token_budget and token_count > token_budget),
        "changed_lines": {
            "added": int(changed.get("added", 0) or 0),
            "removed": int(changed.get("removed", 0) or 0),
        },
    }
    for worker in task.get("workers") or []:
        if worker.get("id") == "chat-runner":
            worker["status"] = "done" if final_status == "done" else final_status
            worker["summary"] = _clean(summary or "Chat-Lauf abgeschlossen.", 500)
        if worker.get("id") == "verifier":
            worker["status"] = "done" if final_status == "done" else ("blocked" if final_status == "blocked" else "needs_work")
            if acc_verdict == "erfuellt":
                worker["summary"] = "Abnahme geprüft: erfüllt."
            elif acc_verdict in {"halb", "zurueck"}:
                worker["summary"] = "Abnahme nicht erfüllt, Korrektur-Limit erreicht."
            elif acc_verdict == "unklar":
                worker["summary"] = "Abnahme nicht maschinell prüfbar; Auftrag nicht als fertig gewertet."
            elif final_status == "blocked":
                worker["summary"] = "Blocker erkannt; Auftrag nicht als fertig gewertet."
            else:
                worker["summary"] = "Werkzeuge genutzt." if did_work else "Chat-Ergebnis liegt vor."
    findings: list[str] = []
    findings.extend(blocker_findings)
    if acc_verdict in {"halb", "zurueck"}:
        findings.extend((acceptance_check or {}).get("maengel") or [])
    elif acc_verdict == "unklar":
        findings.append("Abnahme nicht maschinell prüfbar; Auftrag nicht als fertig gewertet.")
    if final_status != "done" and not did_work:
        findings.append("Der Lauf hat keine größeren Datei- oder Codeänderungen gemeldet.")
    if status == "stopped":
        findings.append("Der Lauf wurde gestoppt.")
    if tool_budget and int(tool_count or 0) > tool_budget:
        findings.append(f"Werkzeugbudget überschritten: {int(tool_count or 0)} / {tool_budget} Calls.")
    if token_budget and token_count > token_budget:
        findings.append(f"Token-Warnschwelle überschritten: {_format_token_count(token_count)} / {_format_token_count(token_budget)}.")
    task["verifier"] = {
        "decision": "stop" if final_status == "done" else "stay",
        "findings": findings,
        "checked_at": _now(),
        "summary": "Stop: Ergebnis liegt im Ursprungschat." if final_status == "done" else "Stay: Auftrag braucht Nacharbeit oder erneuten Lauf.",
    }
    if acceptance_check:
        task["verifier"]["acceptance_check"] = acceptance_check
    elapsed = f" in {int(elapsed_ms / 1000)}s" if elapsed_ms else ""
    task.setdefault("history", []).append(_bauhof_event("Abschluss", f"Chat-Lauf abgeschlossen{elapsed}; {tool_count} Werkzeug-Calls.", "ok" if final_status == "done" else ("blocked" if final_status == "blocked" else "needs_work")))
    task["next_action"] = "Im Ursprungschat prüfen; bei Bedarf erneut schärfen." if final_status == "done" else ("Automatische Nacharbeit ausgeschöpft; Blocker braucht bewusste Entscheidung." if final_status == "blocked" else "Automatische Nacharbeit ausgeschöpft; Auftrag braucht bewusste Entscheidung.")
    task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
    report_parent = ""
    request = task.get("request") or {}
    if request.get("source") in {"auto_background", "work_session"} and not task.get("reported_at"):
        origin = task.get("origin") or {}
        parent = origin.get("conversation_id") or ""
        conv = get_conversation(parent) if parent else None
        if conv:
            # Editorialer Ping im Klaus-Stil: kleines Terracotta-Eyebrow plus
            # duenne Akzentlinie, sonst normaler Chatfluss. Kein Praefix, keine
            # Metrikzeile, kein Protokoll-Link mehr. Das Protokoll bleibt nur
            # ueber die Werkbank-Detailansicht erreichbar.
            marker = f"<!--klaus-channel:werkbank:{task.get('id') or ''}-->"
            title = task.get("title") or task.get("id") or "Der Auftrag"
            body = _werkbank_report_body(summary, title, final_status, task.get("next_action") or "")
            if not body:
                body = f"**{title}** ist fertig." if final_status == "done" else f"**{title}** hängt noch und braucht eine Nacharbeit."
            save_msg(
                agent=conv.get("agent") or "main",
                project=conv.get("project") or "",
                author="assistant",
                content=f"{marker}\n{body}",
                conversation_id=parent,
            )
            task["reported_at"] = _now()
            task.setdefault("history", []).append(_bauhof_event("Rückmeldung", "Ergebnis in den Ursprungschat zurückgemeldet."))
            report_parent = parent
    _write_bauhof_task(task)
    return report_parent


def mark_werkbank_chat_task_running(task_id: str | None) -> None:
    if not task_id:
        return
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task or task.get("status") != "queued":
        return
    task["status"] = "running"
    task["updated_at"] = _now()
    for worker in task.get("workers") or []:
        if worker.get("id") == "chat-runner":
            worker["status"] = "running"
    task.setdefault("history", []).append(_bauhof_event("Worker", "Werkbank-Worker gestartet."))
    task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
    _write_bauhof_task(task)


def _bauhof_is_deleted(task: dict[str, Any]) -> bool:
    return bool(task.get("deleted_at")) or task.get("status") == "deleted"


def _bauhof_drop_queue_items(task: dict[str, Any]) -> int:
    request = task.get("request") or {}
    task_id = str(task.get("id") or "")
    worker_conv_id = _clean(request.get("worker_conversation_id"), 80)
    removed = 0
    try:
        with get_db() as db:
            cur = db.execute("DELETE FROM message_queue WHERE id = ?", (f"werkbank-{task_id}",))
            removed += int(cur.rowcount or 0)
            if worker_conv_id:
                cur = db.execute(
                    "DELETE FROM message_queue WHERE conv_id = ? AND status IN ('pending', 'processing')",
                    (worker_conv_id,),
                )
                removed += int(cur.rowcount or 0)
    except Exception:
        return removed
    return removed


async def _bauhof_request_stop(task: dict[str, Any]) -> bool:
    request = task.get("request") or {}
    worker_conv_id = _clean(request.get("worker_conversation_id"), 80)
    if not worker_conv_id:
        return False
    try:
        from streaming import request_stop

        return bool(await request_stop(worker_conv_id))
    except Exception:
        return False


async def _bauhof_stop_task(task: dict[str, Any], *, reason: str = "Manuell gestoppt.") -> dict[str, Any]:
    if _bauhof_is_deleted(task):
        return task
    previous = str(task.get("status") or "")
    stopped = await _bauhof_request_stop(task)
    removed = _bauhof_drop_queue_items(task)
    task["status"] = "canceled"
    task["updated_at"] = _now()
    for worker in task.get("workers") or []:
        if worker.get("status") in {"queued", "running", "idle"}:
            worker["status"] = "canceled"
            worker["summary"] = "Gestoppt."
    findings = list((task.get("verifier") or {}).get("findings") or [])
    if "Der Auftrag wurde gestoppt." not in findings:
        findings.append("Der Auftrag wurde gestoppt.")
    task["verifier"] = {
        **(task.get("verifier") or {}),
        "decision": "stop",
        "findings": findings,
        "checked_at": _now(),
        "summary": "Gestoppt: Auftrag bleibt als Protokoll erhalten.",
    }
    detail = f"{reason} Vorheriger Status: {previous or 'unbekannt'}."
    if stopped or removed:
        detail += f" Lauf gestoppt: {'ja' if stopped else 'nein'}, Queue entfernt: {removed}."
    task.setdefault("history", []).append(_bauhof_event("Stopp", detail, "blocked"))
    task["next_action"] = "Gestoppt; Protokoll bleibt erhalten."
    task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
    _write_bauhof_task(task)
    return task


def _bauhof_soft_delete_task(task: dict[str, Any]) -> dict[str, Any]:
    task["status"] = "deleted"
    task["deleted_at"] = _now()
    task["updated_at"] = _now()
    task["hidden"] = True
    task.setdefault("history", []).append(_bauhof_event("Gelöscht", "Aus der Werkbank-Liste entfernt; Protokoll bleibt erhalten.", "blocked"))
    task["next_action"] = "Aus der Werkbank-Liste entfernt; über Protokoll oder Ursprungschat weiter auffindbar."
    task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
    _write_bauhof_task(task)
    return task


def _list_bauhof_tasks(limit: int = 80, *, include_deleted: bool = False) -> list[dict[str, Any]]:
    _ensure_dirs()
    _sync_artifact_tasks(limit=60)
    rows: list[dict[str, Any]] = []
    for path in sorted(BAUHOF_TASKS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        task = _read_bauhof_task(path)
        if task and (include_deleted or not _bauhof_is_deleted(task)):
            rows.append(task)
        if len(rows) >= max(1, min(limit, 200)):
            break
    return rows


def _artifact_task_id(path: Path) -> str:
    return f"artifact-{_slug(path.stem)}"


def _sync_artifact_tasks(limit: int = 60) -> None:
    if not ARTIFACTS_DIR.exists():
        return
    paths = sorted(
        ARTIFACTS_DIR.glob("*.html"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )[: max(1, min(limit, 120))]
    state = _bauhof_state()
    current = [str(path.relative_to(ROOT)) for path in paths]
    if not isinstance(state.get("artifact_seen"), list):
        state["artifact_seen"] = current
        _write_json(BAUHOF_STATE_PATH, state)
        return
    seen = {str(item) for item in state.get("artifact_seen") or []}
    next_seen = list(current)
    for path in paths:
        rel_html = str(path.relative_to(ROOT))
        if rel_html in seen:
            continue
        task_id = _artifact_task_id(path)
        task_path = _bauhof_task_path(task_id)
        if task_path.exists():
            seen.add(rel_html)
            continue
        md_path = path.with_suffix(".md")
        rel_md = str(md_path.relative_to(ROOT)) if md_path.exists() else ""
        title = path.stem
        task = {
            "id": task_id,
            "kind": "werkbank",
            "title": f"HTML-Artefakt: {title}",
            "status": "done",
            "priority": "normal",
            "created_at": path.stat().st_mtime,
            "updated_at": path.stat().st_mtime,
            "origin": {"conversation_id": "", "title": "Automatisch aus Artefakten", "agent": "main", "project": ""},
            "request": {
                "brief": f"HTML wurde erzeugt und als Werkbank-Output registriert: {rel_html}",
                "acceptance": "HTML-Artefakt ist vorhanden, auffindbar und kann im Workspace geöffnet werden.",
                "notes": rel_md,
                "source": "artifact",
            },
            "loop": {"round": 1, "max_rounds": 1, "policy": "artifact -> register -> output"},
            "workers": [
                {"id": "artifact", "role": "Artefakt", "status": "done", "summary": rel_html},
                {"id": "verifier", "role": "Verifier", "status": "done", "summary": "Datei ist registriert."},
            ],
            "verifier": {
                "decision": "stop",
                "findings": [],
                "checked_at": path.stat().st_mtime,
                "summary": "Stop: Artefakt ist als Ergebnis sichtbar.",
            },
            "artifacts": {"html_path": rel_html, "markdown_path": rel_md},
            "history": [
                {"ts": path.stat().st_mtime, "label": "Output", "summary": f"HTML-Artefakt automatisch registriert: {rel_html}", "status": "ok"},
            ],
            "next_action": "Im Artefakte-Workspace öffnen oder im Ursprungschat weiterverwenden.",
        }
        task["artifacts"] = {**task["artifacts"], "protocol_path": _bauhof_write_protocol(task)}
        _write_bauhof_task(task)
        seen.add(rel_html)
    for item in state.get("artifact_seen") or []:
        if item not in next_seen:
            next_seen.append(str(item))
        if len(next_seen) >= 300:
            break
    state["artifact_seen"] = next_seen
    _write_json(BAUHOF_STATE_PATH, state)


def _bauhof_origin(parent: str, pane_index: int | None = None) -> dict[str, Any]:
    pane = pane_index if isinstance(pane_index, int) and pane_index >= 0 else None
    conv = get_conversation(parent) if parent else None
    if not conv:
        return {"conversation_id": parent, "title": "Ohne Ursprungschat", "agent": "main", "project": "", "pane": pane}
    return {
        "conversation_id": parent,
        "title": conv.get("title") or parent,
        "agent": conv.get("agent") or "main",
        "project": conv.get("project") or "",
        "pane": pane,
    }


def _bauhof_event(label: str, summary: str, status: str = "ok") -> dict[str, Any]:
    return {"ts": _now(), "label": label, "summary": summary, "status": status}


def _bauhof_state() -> dict[str, Any]:
    data = _read_json(BAUHOF_STATE_PATH, {})
    if not isinstance(data, dict):
        data = {}
    data.setdefault("limit_per_hour", BAUHOF_RATE_LIMIT_DEFAULT)
    data.setdefault("events", [])
    return data


def _bauhof_rate() -> dict[str, Any]:
    state = _bauhof_state()
    cutoff = _now() - BAUHOF_RATE_WINDOW_SECONDS
    events = [float(ts) for ts in (state.get("events") or []) if isinstance(ts, (int, float)) and float(ts) >= cutoff]
    limit = int(state.get("limit_per_hour") or BAUHOF_RATE_LIMIT_DEFAULT)
    remaining = max(0, limit - len(events))
    reset_at = (min(events) + BAUHOF_RATE_WINDOW_SECONDS) if events else _now()
    state["events"] = events
    _write_json(BAUHOF_STATE_PATH, state)
    return {
        "limit_per_hour": limit,
        "used": len(events),
        "remaining": remaining,
        "reset_at": reset_at,
        "blocked": remaining <= 0,
    }


def _bauhof_spend_round() -> dict[str, Any]:
    state = _bauhof_state()
    cutoff = _now() - BAUHOF_RATE_WINDOW_SECONDS
    events = [float(ts) for ts in (state.get("events") or []) if isinstance(ts, (int, float)) and float(ts) >= cutoff]
    limit = int(state.get("limit_per_hour") or BAUHOF_RATE_LIMIT_DEFAULT)
    if len(events) >= limit:
        return {
            "ok": False,
            "limit_per_hour": limit,
            "used": len(events),
            "remaining": 0,
            "reset_at": (min(events) + BAUHOF_RATE_WINDOW_SECONDS) if events else _now(),
        }
    events.append(_now())
    state["events"] = events
    _write_json(BAUHOF_STATE_PATH, state)
    return {
        "ok": True,
        "limit_per_hour": limit,
        "used": len(events),
        "remaining": max(0, limit - len(events)),
        "reset_at": (min(events) + BAUHOF_RATE_WINDOW_SECONDS) if events else _now(),
    }


def _bauhof_findings(task: dict[str, Any]) -> list[str]:
    request = task.get("request") or {}
    brief = _clean(request.get("brief"), 4000)
    acceptance = _clean(request.get("acceptance"), 3000)
    notes = _clean(request.get("notes"), 3000)
    text = f"{brief} {acceptance} {notes}".lower()
    findings: list[str] = []
    if len(brief) < 30:
        findings.append("Auftrag ist zu kurz; der Builder braucht Ziel und gewünschtes Ergebnis.")
    if len(acceptance) < 20:
        findings.append("Abnahmekriterien fehlen; der Verifier kann sonst nicht hart entscheiden.")
    if any(marker in text for marker in ("weiß nicht", "weiss nicht", "unklar", "vielleicht", "irgendwie", "tbd")):
        findings.append("Unklare Stellen erkannt; als Platzhalter markieren oder konkretisieren.")
    if not (task.get("origin") or {}).get("conversation_id"):
        findings.append("Kein Ursprungschat gebunden; Rückgabe und Historie bleiben weniger sauber.")
    if "parallel" in text or "mehrere agent" in text or "sub-agent" in text:
        if "prüf" not in text and "verifier" not in text and "abnahme" not in text:
            findings.append("Mehrere Worker erwähnt; Verifier- und Abnahmegrenze müssen dafür ausdrücklich drinstehen.")
    return findings


def _bauhof_next_action(task: dict[str, Any], findings: list[str], decision: str) -> str:
    if task.get("status") == "rate_limited":
        return "Warten, bis die Startbremse wieder frei ist."
    if findings and decision == "stay":
        return "Auftrag im Cockpit nachschärfen und Nacharbeit starten."
    if findings:
        return "Nacharbeitslimit erreicht: bewusst neu öffnen oder Auftrag kleiner schneiden."
    return "Abgeben: Protokoll prüfen und bei Bedarf im Ursprungschat weiterarbeiten."


def _bauhof_protocol(task: dict[str, Any]) -> str:
    request = task.get("request") or {}
    origin = task.get("origin") or {}
    verifier = task.get("verifier") or {}
    artifacts = task.get("artifacts") or {}
    lines = [
        f"# Werkbank-Protokoll: {task.get('title') or task.get('id')}",
        "",
        f"- Status: {task.get('status')}",
        f"- Herkunft: {origin.get('title') or 'Ohne Ursprungschat'}",
        f"- Nacharbeit: {task.get('loop', {}).get('round', 0)} / {task.get('loop', {}).get('max_rounds', 3)}",
        f"- Entscheidung: {verifier.get('decision') or 'offen'}",
        f"- Nächster Schritt: {task.get('next_action') or 'offen'}",
        f"- HTML: {artifacts.get('html_path') or 'nicht gesetzt'}",
        f"- Markdown: {artifacts.get('markdown_path') or 'nicht gesetzt'}",
        "",
        "## Auftrag",
        request.get("brief") or "",
        "",
        "## Abnahmekriterien",
        request.get("acceptance") or "Noch nicht gesetzt.",
        "",
        "## Verifier",
    ]
    findings = verifier.get("findings") or []
    lines.extend([f"- {item}" for item in findings] if findings else ["- Keine harten Mängel erkannt."])
    lines += ["", "## Historie"]
    for event in task.get("history") or []:
        lines.append(f"- {_iso(event.get('ts'))} · {event.get('label')}: {event.get('summary')}")
    return "\n".join(lines).strip() + "\n"


def _bauhof_write_protocol(task: dict[str, Any]) -> str:
    path = _bauhof_protocol_path(task["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(_bauhof_protocol(task), encoding="utf-8")
    tmp.replace(path)
    return str(path.relative_to(ROOT))


async def _bauhof_report_to_parent(task: dict[str, Any]) -> None:
    origin = task.get("origin") or {}
    parent = origin.get("conversation_id") or ""
    if not parent:
        return
    conv = get_conversation(parent)
    if not conv:
        return
    verifier = task.get("verifier") or {}
    findings = verifier.get("findings") or []
    status = "Stop" if verifier.get("decision") == "stop" else "Stay"
    lines = [
        f"Werkbank-Nacharbeit {task.get('loop', {}).get('round', 0)}: {task.get('title')}.",
        f"Entscheid: {status}. Status: {task.get('status')}.",
    ]
    if findings:
        lines += ["", "Verifier:", *[f"- {item}" for item in findings[:4]]]
    if task.get("next_action"):
        lines += ["", f"Nächster Schritt: {task['next_action']}"]
    protocol = (task.get("artifacts") or {}).get("protocol_path")
    if protocol:
        lines += ["", f"Protokoll: `{protocol}`"]
    save_msg(
        agent=conv.get("agent") or "main",
        project=conv.get("project") or "",
        author="assistant",
        content="\n".join(lines),
        conversation_id=parent,
    )
    try:
        from streaming import broadcast_sync

        await broadcast_sync(conv.get("agent") or "main", parent, source="werkbank")
    except Exception:
        pass


async def _bauhof_run_round(task: dict[str, Any], *, report: bool = True) -> dict[str, Any]:
    rate = _bauhof_spend_round()
    if not rate.get("ok"):
        task["status"] = "rate_limited"
        task["updated_at"] = _now()
        task.setdefault("history", []).append(_bauhof_event("Bremse", "Startlimit erreicht; nächste Nacharbeit wartet.", "blocked"))
        task["rate"] = rate
        task["next_action"] = _bauhof_next_action(task, [], "stay")
        task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
        _write_bauhof_task(task)
        return task

    loop = task.setdefault("loop", {})
    loop["round"] = int(loop.get("round") or 0) + 1
    max_rounds = int(loop.get("max_rounds") or 3)
    task["status"] = "running"
    task["updated_at"] = _now()
    task["rate"] = rate
    task.setdefault("workers", [
        {"id": "builder", "role": "Builder", "status": "idle"},
        {"id": "verifier", "role": "Verifier", "status": "idle"},
    ])
    task.setdefault("history", []).append(_bauhof_event("Builder", "Werkbank-Auftrag übernommen und Nacharbeit gestartet."))

    findings = _bauhof_findings(task)
    decision = "stay" if findings else "stop"
    if loop["round"] >= max_rounds and findings:
        decision = "stop"
        findings = [*findings, "Nacharbeitslimit erreicht; weitere Nacharbeit braucht bewusste Freigabe."]
        task["status"] = "blocked"
    else:
        task["status"] = "needs_work" if findings else "done"

    task["workers"] = [
        {"id": "builder", "role": "Builder", "status": "done", "summary": "Auftrag strukturiert, Herkunft und Ziel geprüft."},
        {"id": "verifier", "role": "Verifier", "status": "done", "summary": f"{len(findings)} Mängel gefunden." if findings else "Abnahmebedingungen erfüllt."},
    ]
    task["verifier"] = {
        "decision": decision,
        "findings": findings,
        "checked_at": _now(),
        "summary": "Stay: nacharbeiten." if decision == "stay" else "Stop: abgeben oder bewusst neu öffnen.",
    }
    task["next_action"] = _bauhof_next_action(task, findings, decision)
    task.setdefault("history", []).append(_bauhof_event("Verifier", task["verifier"]["summary"], "needs_work" if findings else "ok"))
    task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
    task["updated_at"] = _now()
    _write_bauhof_task(task)
    if report:
        await _bauhof_report_to_parent(task)
    return task


@router.get("/api/loops/runs")
async def loops_runs(limit: int = 30):
    return JSONResponse({"runs": _list_runs(limit=limit)})


@router.get("/api/loops/werkbank")
@router.get("/api/loops/bauhof")
async def bauhof_overview(limit: int = 80, include_deleted: bool = False):
    tasks = _list_bauhof_tasks(limit=limit, include_deleted=include_deleted)
    for t in tasks:
        if t.get("status") == "running":
            try:
                t["live"] = _bauhof_tool_feed(t).get("live")
            except Exception:
                t["live"] = None
    active = [t for t in tasks if t.get("status") in {"queued", "running", "needs_work", "rate_limited"}]
    done = [t for t in tasks if t.get("status") == "done"]
    blocked = [t for t in tasks if t.get("status") == "blocked"]
    return JSONResponse({
        "ok": True,
        "tasks": tasks,
        "rate": _bauhof_rate(),
        "summary": {
            "active": len(active),
            "done": len(done),
            "blocked": len(blocked),
            "total": len(tasks),
        },
    })


@router.post("/api/loops/werkbank/tasks")
@router.post("/api/loops/bauhof/tasks")
async def bauhof_create_task(req: Request):
    if not WERKBANK_ENABLED:
        return JSONResponse({"ok": False, "error": "Werkbank ist deaktiviert"}, status_code=410)
    body = await req.json()
    parent = _clean(body.get("parent_conversation_id"), 80)
    title = _clean(body.get("title"), 180)
    brief = _clean(body.get("brief"), 4000)
    acceptance = _clean(body.get("acceptance"), 3000)
    notes = _clean(body.get("notes"), 3000)
    priority = _clean(body.get("priority") or "normal", 40)
    run_now = bool(body.get("run_now", True))
    max_rounds = int(body.get("max_rounds") or 3)
    max_rounds = max(1, min(max_rounds, 8))
    if not brief:
        return JSONResponse({"ok": False, "error": "Auftrag fehlt"}, status_code=400)
    if not title:
        words = [w.strip(".,;:!?()[]{}\"'`") for w in brief.split()]
        stop = {"ich", "du", "wir", "das", "dass", "der", "die", "den", "dem", "und", "oder", "aber", "bitte", "jetzt", "hier", "mal"}
        title = " ".join([w for w in words if len(w) > 2 and w.lower() not in stop][:5])[:80] or "Werkbank-Auftrag"
    task_id = f"werk-{int(_now())}-{uuid.uuid4().hex[:6]}"
    task: dict[str, Any] = {
        "id": task_id,
        "kind": "werkbank",
        "title": title,
        "status": "queued",
        "priority": priority,
        "created_at": _now(),
        "updated_at": _now(),
        "origin": _bauhof_origin(parent),
        "request": {
            "brief": brief,
            "acceptance": acceptance,
            "notes": notes,
            "source": "manual",
        },
        "loop": {
            "round": 0,
            "max_rounds": max_rounds,
            "policy": "trigger -> builder -> verifier -> stay/stop",
        },
        "workers": [
            {"id": "builder", "role": "Builder", "status": "queued"},
            {"id": "verifier", "role": "Verifier", "status": "queued"},
        ],
        "verifier": {"decision": "pending", "findings": []},
        "artifacts": {},
        "history": [
            _bauhof_event("Auftrag", "Werkbank-Auftrag angelegt."),
        ],
    }
    _write_bauhof_task(task)
    if run_now:
        task = await _bauhof_run_round(task)
    return JSONResponse({"ok": True, "task": task, "rate": _bauhof_rate()})


@router.post("/api/loops/werkbank/spawn")
async def werkbank_spawn(req: Request):
    """Bewusster Werkbank-Spawn aus einer Hand.

    Kein Stichwort-Trigger: hier landet nur ein expliziter Auftrag. Klaus zieht den
    Hebel bewusst per curl, der Nutzer per Button. Body: conversationId + brief,
    optional title/acceptance/project/agentId.
    """
    if not WERKBANK_ENABLED:
        return JSONResponse({"ok": False, "error": "Werkbank ist deaktiviert"}, status_code=410)
    body = await req.json()
    conv_id = _clean(body.get("conversationId") or body.get("parent_conversation_id"), 80)
    brief = _clean(body.get("brief") or body.get("message"), 4000)
    title = _clean(body.get("title"), 180)
    acceptance = _clean(body.get("acceptance"), 3000)
    project = _clean(body.get("project"), 80)
    agent_id = _clean(body.get("agentId") or body.get("agent_id") or "main", 40)
    engine = _clean(body.get("engine"), 80)
    network_access = bool(body.get("networkAccess") or body.get("network_access") or body.get("requiresNetwork") or body.get("requires_network"))
    if not conv_id:
        return JSONResponse({"ok": False, "error": "conversationId fehlt"}, status_code=400)
    if not brief:
        return JSONResponse({"ok": False, "error": "Auftrag fehlt"}, status_code=400)
    audit_args = {
        "conversationId": conv_id,
        "brief": brief,
        "title": title,
        "acceptance": acceptance,
        "project": project,
        "agentId": agent_id or "main",
        "engine": engine,
        "networkAccess": network_access,
    }
    try:
        from streaming import spawn_work_session_from_request
        result = await spawn_work_session_from_request(
            conv_id=conv_id,
            brief=brief,
            title=title,
            acceptance=acceptance,
            agent_id=agent_id or "main",
            project=project,
            engine=engine,
            network_access=network_access,
        )
    except Exception as e:
        audit_id = _audit(action="werkbank.task.create", parent=conv_id, conv=get_conversation(conv_id), ok=False, arguments=audit_args, error=str(e))
        return JSONResponse({"ok": False, "error": f"Spawn fehlgeschlagen: {e}", "audit_id": audit_id}, status_code=500)
    if not result:
        audit_id = _audit(action="werkbank.task.create", parent=conv_id, conv=get_conversation(conv_id), ok=False, arguments=audit_args, error="spawn_failed")
        return JSONResponse({"ok": False, "error": "Spawn fehlgeschlagen", "audit_id": audit_id}, status_code=500)
    audit_id = _audit(action="werkbank.task.create", parent=conv_id, conv=get_conversation(conv_id), ok=True, arguments=audit_args, output=result)
    return JSONResponse({"ok": True, **result, "audit_id": audit_id})


@router.patch("/api/loops/werkbank/tasks/{task_id}")
@router.patch("/api/loops/bauhof/tasks/{task_id}")
async def bauhof_update_task(task_id: str, req: Request):
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return JSONResponse({"ok": False, "error": "Werkbank-Auftrag nicht gefunden"}, status_code=404)
    body = await req.json()
    request_data = task.setdefault("request", {})
    changed: list[str] = []
    for key, limit in (("brief", 4000), ("acceptance", 3000), ("notes", 3000)):
        if key in body:
            request_data[key] = _clean(body.get(key), limit)
            changed.append(key)
    if "priority" in body:
        task["priority"] = _clean(body.get("priority") or "normal", 40)
        changed.append("priority")
    if "max_rounds" in body:
        max_rounds = max(1, min(int(body.get("max_rounds") or 3), 8))
        task.setdefault("loop", {})["max_rounds"] = max_rounds
        changed.append("max_rounds")
    if changed:
        task["status"] = "queued"
        task["updated_at"] = _now()
        task.setdefault("history", []).append(_bauhof_event("Nacharbeit", f"Auftrag geschärft: {', '.join(changed)}."))
        task["verifier"] = {"decision": "pending", "findings": [], "summary": "Wartet auf nächste Prüfung."}
        task["next_action"] = "Nacharbeit starten."
        task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
        _write_bauhof_task(task)
    return JSONResponse({"ok": True, "task": task, "rate": _bauhof_rate()})


def _short_tool_label(name: str, inp: Any) -> str:
    if isinstance(inp, dict):
        for key in ("file_path", "path", "notebook_path"):
            if inp.get(key):
                return str(inp[key])
        if inp.get("command"):
            return " ".join(str(inp["command"]).split())[:140]
        for key in ("description", "query", "pattern", "url", "prompt", "title"):
            if inp.get(key):
                return str(inp[key])[:140]
    return ""


def _tool_status(result: str) -> str:
    low = (result or "").strip()[:120].lower()
    if low.startswith("error") or "traceback (most recent call last)" in (result or "").lower():
        return "error"
    return "ok"


def _bauhof_tool_feed(task: dict[str, Any]) -> dict[str, Any]:
    """Strukturierter Tool-Feed eines Werkbank-Laufs, gelesen aus der Worker-Conversation."""
    req = task.get("request") or {}
    conv = _clean(req.get("worker_conversation_id"), 80)
    task_id = _clean(task.get("id"), 100)
    feed: list[dict[str, Any]] = []
    live = {
        "running": False,
        "elapsed_ms": None,
        "output_tokens": 0,
        "input_tokens": 0,
        "tool_count": 0,
        "added": 0,
        "removed": 0,
        "last_activity_at": None,
    }
    queue: dict[str, Any] | None = None
    if conv or task_id:
        try:
            with get_db() as db:
                row = db.execute(
                    """
                    SELECT id, status, created_at
                    FROM message_queue
                    WHERE (? != '' AND conv_id = ?)
                       OR (? != '' AND id = ?)
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (conv, conv, task_id, f"werkbank-{task_id}"),
                ).fetchone()
            if row:
                queue = {"id": row[0], "status": row[1], "created_at": row[2]}
        except Exception:
            queue = None
    if not conv:
        return {"conversation_id": "", "items": feed, "live": live, "queue": queue, "available": False}
    try:
        msgs = get_msgs("", "", limit=12, conversation_id=conv)
    except Exception:
        msgs = []
    target = None
    for m in reversed(msgs):
        if (m.get("author") or "") in ("Du", "User", "user"):
            continue
        raw = m.get("tools") or "[]"
        try:
            arr = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            arr = []
        if arr:
            target = (m, arr)
            break
        if target is None:
            target = (m, [])
    if target is None:
        return {"conversation_id": conv, "items": feed, "live": live, "queue": queue, "available": False}
    msg, arr = target
    for i, t in enumerate(arr if isinstance(arr, list) else []):
        if not isinstance(t, dict):
            continue
        name = str(t.get("name") or "tool")
        inp = t.get("input") if isinstance(t.get("input"), dict) else {}
        result = t.get("result")
        result_str = result if isinstance(result, str) else _safe_json(result)
        diff = t.get("diffStats") if isinstance(t.get("diffStats"), dict) else None
        added = int((diff or {}).get("added") or 0)
        removed = int((diff or {}).get("removed") or 0)
        live["added"] += added
        live["removed"] += removed
        feed.append({
            "index": i,
            "name": name,
            "label": _short_tool_label(name, inp),
            "status": _tool_status(result_str),
            "result_snippet": " ".join((result_str or "").split())[:600],
            "args": inp,
            "added": added,
            "removed": removed,
        })
    live["running"] = bool(msg.get("incomplete"))
    live["elapsed_ms"] = msg.get("elapsed_ms")
    live["output_tokens"] = int(msg.get("output_tokens") or 0)
    live["input_tokens"] = int(msg.get("input_tokens") or 0)
    live["tool_count"] = len(feed)
    live["last_activity_at"] = msg.get("ts") or task.get("updated_at")
    return {"conversation_id": conv, "items": feed, "live": live, "queue": queue, "available": True}


@router.get("/api/loops/werkbank/tasks/{task_id}")
@router.get("/api/loops/bauhof/tasks/{task_id}")
async def bauhof_task_detail(task_id: str):
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return JSONResponse({"ok": False, "error": "Werkbank-Auftrag nicht gefunden"}, status_code=404)
    feed = _bauhof_tool_feed(task)
    return JSONResponse({"ok": True, "task": task, "feed": feed, "rate": _bauhof_rate()})


@router.post("/api/loops/werkbank/tasks/{task_id}/run")
@router.post("/api/loops/bauhof/tasks/{task_id}/run")
async def bauhof_run_task(task_id: str):
    if not WERKBANK_ENABLED:
        return JSONResponse({"ok": False, "error": "Werkbank ist deaktiviert"}, status_code=410)
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return JSONResponse({"ok": False, "error": "Werkbank-Auftrag nicht gefunden"}, status_code=404)
    if task.get("status") == "done":
        task["status"] = "queued"
        task.setdefault("history", []).append(_bauhof_event("Neu öffnen", "Fertigen Auftrag für weitere Nacharbeit geöffnet."))
    task = await _bauhof_run_round(task)
    return JSONResponse({"ok": True, "task": task, "rate": _bauhof_rate()})


@router.post("/api/loops/werkbank/tasks/{task_id}/followup")
@router.post("/api/loops/bauhof/tasks/{task_id}/followup")
async def bauhof_followup_task(task_id: str, req: Request):
    if not WERKBANK_ENABLED:
        return JSONResponse({"ok": False, "error": "Werkbank ist deaktiviert"}, status_code=410)
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return JSONResponse({"ok": False, "error": "Werkbank-Auftrag nicht gefunden"}, status_code=404)
    body = await req.json()
    text = str((body or {}).get("text") or "").strip()
    entry = _bauhof_append_followup(task, text)
    if not entry:
        return JSONResponse({"ok": False, "error": "Nachtrag ist leer"}, status_code=400)
    # Laeuft der Worker noch (running/queued), zieht der Lauf den Nachtrag selbst
    # am Ende. Ruht der Auftrag schon, sofort als Folge-Lauf starten.
    queued = False
    if task.get("status") not in {"running", "queued"}:
        queued = _bauhof_enqueue_followup_run(task)
    task["artifacts"] = {**(task.get("artifacts") or {}), "protocol_path": _bauhof_write_protocol(task)}
    _write_bauhof_task(task)
    return JSONResponse({
        "ok": True,
        "task": task,
        "queued_followup_run": queued,
        "pending": len(_bauhof_pending_followups(task)),
        "rate": _bauhof_rate(),
    })


@router.post("/api/loops/werkbank/tasks/{task_id}/stop")
@router.post("/api/loops/bauhof/tasks/{task_id}/stop")
async def bauhof_stop_task(task_id: str):
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return JSONResponse({"ok": False, "error": "Werkbank-Auftrag nicht gefunden"}, status_code=404)
    task = await _bauhof_stop_task(task, reason="Manuell in der Werkbank gestoppt.")
    return JSONResponse({"ok": True, "task": task, "rate": _bauhof_rate()})


@router.delete("/api/loops/werkbank/tasks/{task_id}")
@router.delete("/api/loops/bauhof/tasks/{task_id}")
@router.post("/api/loops/werkbank/tasks/{task_id}/delete")
@router.post("/api/loops/bauhof/tasks/{task_id}/delete")
async def bauhof_delete_task(task_id: str):
    task = _read_bauhof_task(_bauhof_task_path(task_id))
    if not task:
        return JSONResponse({"ok": False, "error": "Werkbank-Auftrag nicht gefunden"}, status_code=404)
    if not _bauhof_is_deleted(task):
        if task.get("status") in {"queued", "running", "needs_work", "needs_input", "blocked", "rate_limited", "idle"}:
            task = await _bauhof_stop_task(task, reason="Vor dem Löschen gestoppt.")
        else:
            _bauhof_drop_queue_items(task)
        task = _bauhof_soft_delete_task(task)
    return JSONResponse({"ok": True, "task": task, "rate": _bauhof_rate()})


@router.get("/api/loops/runs/{run_id}")
async def loops_run(run_id: str):
    run = _read_run(_run_path(run_id))
    if not run:
        return JSONResponse({"ok": False, "error": "run nicht gefunden"}, status_code=404)
    return JSONResponse({"ok": True, "run": run})


@router.post("/api/loops/offer/start")
async def loops_offer_start(req: Request):
    body = await req.json()
    parent = _clean(body.get("parent_conversation_id"), 80)
    customer = _clean(body.get("customer"), 160)
    goal = _clean(body.get("goal"), 1000)
    notes = _clean(body.get("notes"), 2000)
    trigger = _clean(body.get("trigger") or "manual", 40)
    if not customer:
        return JSONResponse({"ok": False, "error": "customer fehlt"}, status_code=400)
    if not goal:
        return JSONResponse({"ok": False, "error": "goal fehlt"}, status_code=400)
    if trigger != "manual":
        return JSONResponse({"ok": False, "error": "Hooks dürfen nur Entwürfe vorbereiten, nicht den Angebotsloop starten."}, status_code=409)

    try:
        with _loop_lock(parent, customer):
            run_id = f"loop-{int(_now())}-{uuid.uuid4().hex[:6]}"
            messages, conv = _recent_context(parent)
            audit_id = _audit(
                action="start",
                parent=parent,
                conv=conv,
                ok=True,
                arguments={"parent_conversation_id": parent, "customer": customer, "goal": goal, "notes": notes},
                output={"run_id": run_id},
            )
            signals = _extract_signals(messages)
            basis = _offer_basis(customer, goal, messages, notes)
            missing = _verify(customer, goal, basis)
            offer_dir = OFFERS_DIR / f"{_slug(customer)}-{run_id}"
            offer_dir.mkdir(parents=True, exist_ok=True)

            run: dict[str, Any] = {
                "id": run_id,
                "kind": "offer",
                "status": "running",
                "created_at": _now(),
                "updated_at": _now(),
                "parent_conversation_id": parent,
                "parent": conv or None,
                "input": {"customer": customer, "goal": goal, "notes": notes, "trigger": trigger},
                "steps": [
                    {"key": "lock", "label": "Lock setzen", "status": "ok", "summary": "Chat/Kunde exklusiv übernommen", "ts": _now()},
                    {"key": "audit", "label": "Audit schreiben", "status": "ok" if audit_id else "skipped", "summary": f"Audit #{audit_id}" if audit_id else "Audit nicht verfügbar", "ts": _now()},
                    {"key": "context", "label": "Kontext ziehen", "status": "ok", "summary": f"{len(messages)} Chatnachrichten übernommen", "ts": _now()},
                    {"key": "basis", "label": "Quellen bewerten", "status": "ok", "summary": "Notizen, Angebote, Website", "ts": _now()},
                    {"key": "draft", "label": "Entwurf bauen", "status": "running", "summary": "Angebotsskizze wird erzeugt", "ts": _now()},
                ],
                "context": {"messages": messages, "signals": signals, "basis": basis},
                "verifier": {"missing": []},
                "artifacts": {},
                "audit": {"start_audit_id": audit_id},
            }
            _write_run(run)

            markdown = _offer_markdown(run, signals, missing, basis)
            html = _offer_html(run, signals, missing, basis)
            md_path = offer_dir / "angebot.md"
            html_path = offer_dir / "angebot.html"
            tmp_md = md_path.with_name(f".{md_path.name}.{uuid.uuid4().hex}.tmp")
            tmp_md.write_text(markdown, encoding="utf-8")
            tmp_md.replace(md_path)
            tmp_html = html_path.with_name(f".{html_path.name}.{uuid.uuid4().hex}.tmp")
            tmp_html.write_text(html, encoding="utf-8")
            tmp_html.replace(html_path)

            run["steps"][-1] = {"key": "draft", "label": "Entwurf bauen", "status": "ok", "summary": "Angebotsskizze erzeugt", "ts": _now()}
            run["steps"].append({
                "key": "verify",
                "label": "Prüfen",
                "status": "needs_input" if missing else "ok",
                "summary": f"{len(missing)} offene Punkte" if missing else "Keine harten Lücken erkannt",
                "ts": _now(),
            })
            run["steps"].append({
                "key": "report",
                "label": "Zurückmelden",
                "status": "ok" if parent else "skipped",
                "summary": "Kurzbericht im Ursprungschat" if parent else "Ohne Ursprungschat gestartet",
                "ts": _now(),
            })
            run["status"] = "needs_input" if missing else "done"
            run["updated_at"] = _now()
            run["verifier"] = {"missing": missing}
            run["artifacts"] = {
                "html_path": str(html_path.relative_to(ROOT)),
                "markdown_path": str(md_path.relative_to(ROOT)),
                "offer_dir": str(offer_dir.relative_to(ROOT)),
            }
            run["preview_html"] = html
            run["preview_markdown"] = markdown
            _write_run(run)
            await _report_to_parent(run)
            _audit(
                action="finish",
                parent=parent,
                conv=conv,
                ok=True,
                arguments={"run_id": run_id, "customer": customer},
                output={"status": run["status"], "missing": missing, "html_path": run["artifacts"]["html_path"]},
            )
            return JSONResponse({"ok": True, "run": run})
    except RuntimeError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=409)
