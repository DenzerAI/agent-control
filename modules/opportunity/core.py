"""Opportunity-Scanner — ein Agent nach agents/STANDARD.md.

Liest Christians eigene Daten (Kundenstamm, Markt-Radar) und sucht konkrete
Service-as-Software-Gelegenheiten: welche Dienstleistung könnte Christian als
"wir machen das für dich"-Service anbieten. Meldet zwei bis drei Funde knapp in
den Klaus-Channel. Sendet nichts an Fremde, der Ping geht nur an Christian.

Sechs Bausteine: Trigger (manual/cron) · Schritte (collect/analyze/selfcheck/
ping) · Routing (entfällt, eine Kette) · Selbst-Check · Freigabe (nur interner
Ping, kein Outbound) · Gedächtnis (config/opportunity-learning.json).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PEOPLE_DB = ROOT / "data" / "people.db"
RADAR_DIR = ROOT / "jobs" / "radar-konsolidiert" / "data"
LEARN_PATH = ROOT / "config" / "opportunity-learning.json"

WORKFLOW_KEY = "agent.opportunity"
PING_SOURCE = "opportunity-scanner"
MAX_IDEAS = 3


# ── Baustein 6: Lernspeicher (kuratiert, kein Verlauf) ───────────────────────
def _load_learning() -> dict:
    try:
        d = json.loads(LEARN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        d = {}
    d.setdefault("dismissed", [])   # Ideen-Slugs, die Christian verworfen hat
    d.setdefault("confirmed", [])   # Slugs, die er gut fand (bevorzugen)
    d.setdefault("rules", [])       # freie Regeln, die der Prompt erbt
    return d


def _save_learning(d: dict) -> None:
    LEARN_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEARN_PATH.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:48]


def dismiss(slug: str) -> dict:
    """Signal: diese Idee war nichts. Künftig überspringen."""
    d = _load_learning()
    s = _slug(slug)
    if s and s not in d["dismissed"]:
        d["dismissed"].append(s)
    if s in d["confirmed"]:
        d["confirmed"].remove(s)
    _save_learning(d)
    return d


def confirm(slug: str) -> dict:
    """Signal: das war gut. Künftig bevorzugen."""
    d = _load_learning()
    s = _slug(slug)
    if s and s not in d["confirmed"]:
        d["confirmed"].append(s)
    _save_learning(d)
    return d


# ── Baustein 2a: collect — eigene Daten querlesen ────────────────────────────
def _read_customers() -> str:
    if not PEOPLE_DB.exists():
        return ""
    try:
        c = sqlite3.connect(f"file:{PEOPLE_DB}?mode=ro", uri=True)
        rows = c.execute(
            "SELECT name, role, company, tags FROM people "
            "WHERE COALESCE(role,'')<>'' OR COALESCE(company,'')<>'' LIMIT 200"
        ).fetchall()
    except sqlite3.Error:
        return ""
    out = []
    for name, role, company, tags in rows:
        bits = [b for b in (role, company) if b]
        try:
            tg = ", ".join(json.loads(tags)) if tags else ""
        except (TypeError, json.JSONDecodeError):
            tg = ""
        if tg:
            bits.append(tg)
        if bits:
            out.append(f"- {name}: {'; '.join(bits)}")
    return "\n".join(out[:120])


def _read_market() -> str:
    if not RADAR_DIR.exists():
        return ""
    today = date.today().isoformat()
    pref = RADAR_DIR / f"{today}-radar-konsolidiert.md"
    if pref.exists():
        path = pref
    else:
        cands = sorted(RADAR_DIR.glob("*-radar-konsolidiert.md"), reverse=True)
        path = cands[0] if cands else None
    if not path:
        return ""
    try:
        return path.read_text(encoding="utf-8")[:6000]
    except OSError:
        return ""


# ── Baustein 2b: analyze — der LLM-Schritt ───────────────────────────────────
def _build_prompt(customers: str, market: str, learn: dict) -> str:
    avoid = ", ".join(learn["dismissed"][-20:]) or "noch nichts"
    liked = ", ".join(learn["confirmed"][-20:]) or "noch nichts"
    rules = "\n".join(f"- {r}" for r in learn["rules"]) or "- (keine)"
    return f"""Du bist Klaus, Christians Geschäftspartner. Christian baut Denzer AI und
will sich als AI-Dienstleister positionieren nach dem Service-as-Software-Modell:
nicht Software verkaufen, sondern eine ganze Dienstleistung übernehmen (Buchhaltung,
Recruiting, Marketing, IT-Support), die im Hintergrund auf AI läuft.

Finde aus seinen echten Daten zwei bis drei KONKRETE Opportunities: eine Service-
Kategorie, die er einem seiner Kunden- oder Markttypen als "wir machen das für dich"
anbieten könnte. Jede Idee muss aus den Daten ableitbar sein, nicht generisch geraten.

KUNDENSTAMM (Rollen, Firmen, Branchen):
{customers or "(keine Kundendaten lesbar)"}

MARKT-SIGNALE HEUTE (aus dem Radar):
{market or "(keine Markt-Signale)"}

Schon verworfen, nicht erneut vorschlagen: {avoid}
Hat er gut gefunden, ähnliche bevorzugen: {liked}
Zusätzliche Regeln:
{rules}

Antworte NUR mit JSON, keine Vorrede, kein Markdown-Zaun:
{{"ideas":[{{"title":"kurzer Name der Opportunity","kategorie":"z.B. Buchhaltung",
"zielkunde":"welcher Typ aus dem Stamm","warum":"ein Satz, woran du es festmachst",
"erster_schritt":"ein konkreter erster Schritt fuer Christian"}}]}}
Keine Bindestriche als Gedankenstriche im Text. Maximal drei Ideen."""


async def _call_llm(prompt: str) -> tuple[list[dict], str]:
    model = os.environ.get("OPPORTUNITY_MODEL", "gpt-5.1")
    try:
        from openai import AsyncOpenAI
        from server import _get_openai_key
        key = _get_openai_key()
        if not key:
            return [], "kein OpenAI-Key"
        client = AsyncOpenAI(api_key=key)
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            reasoning_effort=os.environ.get("OPPORTUNITY_EFFORT", "low"),
            max_completion_tokens=4000,
            timeout=90.0,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "").strip()
    except Exception as e:  # noqa: BLE001 — Fehler wird als Schrittstatus geloggt
        return [], f"openai: {e}"[:200]
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return [], "keine JSON-Antwort"
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return [], "JSON nicht lesbar"
    ideas = data.get("ideas") if isinstance(data, dict) else None
    return (ideas if isinstance(ideas, list) else []), ""


# ── Baustein 4: Selbst-Check ─────────────────────────────────────────────────
def _clean_ideas(ideas: list[dict], learn: dict) -> list[dict]:
    seen, out = set(), []
    for it in ideas:
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        s = _slug(title)
        if s in seen or s in learn["dismissed"]:
            continue
        seen.add(s)
        it["slug"] = s
        # Klaus-Regel: keine Gedankenstriche im Text
        for k in ("title", "kategorie", "zielkunde", "warum", "erster_schritt"):
            if it.get(k):
                it[k] = str(it[k]).replace(" — ", ", ").replace(" – ", ", ").strip()
        out.append(it)
        if len(out) >= MAX_IDEAS:
            break
    return out


def _format_ping(ideas: list[dict]) -> str:
    lines = ["**Opportunity-Scanner**", ""]
    for i, it in enumerate(ideas, 1):
        lines.append(f"{i}. **{it.get('title')}** ({it.get('kategorie','')})")
        if it.get("zielkunde"):
            lines.append(f"   Für: {it['zielkunde']}")
        if it.get("warum"):
            lines.append(f"   Warum: {it['warum']}")
        if it.get("erster_schritt"):
            lines.append(f"   Erster Schritt: {it['erster_schritt']}")
        lines.append("")
    return "\n".join(lines).strip()


# ── Baustein 1+2: der Lauf ───────────────────────────────────────────────────
async def run_scan(trigger: str = "manual") -> dict:
    from workflows import start_run, add_step, finish_run, review_background_run

    run_id = start_run(WORKFLOW_KEY, "Opportunity-Scan", trigger=trigger)
    try:
        learn = _load_learning()
        customers = _read_customers()
        market = _read_market()
        add_step(run_id, "collect", "Eigene Daten gelesen", "ok",
                 f"{customers.count(chr(10))+1 if customers else 0} Kundenzeilen, "
                 f"Markt {'ja' if market else 'nein'}",
                 {"has_customers": bool(customers), "has_market": bool(market)})

        if not customers and not market:
            add_step(run_id, "skip", "Keine Datenbasis, Lauf beendet", "warning")
            finish_run(run_id, "done", result={"ideas": [], "reason": "keine Daten"})
            review_background_run(run_id)
            return {"ok": True, "ideas": [], "run_id": run_id, "reason": "keine Daten"}

        add_step(run_id, "learned", "Lernspeicher angewandt", "ok",
                 f"{len(learn['dismissed'])} verworfen, {len(learn['confirmed'])} bestätigt")

        ideas, err = await _call_llm(_build_prompt(customers, market, learn))
        if err:
            add_step(run_id, "analyze", "LLM nicht durch", "error", err)
            finish_run(run_id, "error", error=err)
            review_background_run(run_id)
            return {"ok": False, "error": err, "run_id": run_id}
        add_step(run_id, "analyze", f"{len(ideas)} Roh-Ideen", "ok")

        ideas = _clean_ideas(ideas, learn)
        add_step(run_id, "review", f"{len(ideas)} nach Selbst-Check", "ok" if ideas else "warning")

        posted = False
        if ideas:
            try:
                from modules import klaus_channel as kc
                res = kc.post(text=_format_ping(ideas), source=PING_SOURCE,
                              dedupe_key=f"opportunity-{date.today().isoformat()}")
                posted = bool(res.get("posted"))
            except Exception as e:  # noqa: BLE001
                add_step(run_id, "ping", "Ping fehlgeschlagen", "warning", str(e)[:160])
            else:
                add_step(run_id, "ping", "In Klaus-Channel gemeldet" if posted else "Ping gedämpft (Dedup)",
                         "ok", f"{len(ideas)} Ideen")
        else:
            add_step(run_id, "ping", "Nichts Belastbares, kein Ping", "ok")

        finish_run(run_id, "done", result={"ideas": ideas, "posted": posted})
        review_background_run(run_id)
        return {"ok": True, "ideas": ideas, "posted": posted, "run_id": run_id}
    except Exception as e:  # noqa: BLE001
        try:
            finish_run(run_id, "error", error=str(e)[:200])
        except Exception:
            pass
        return {"ok": False, "error": str(e)[:200], "run_id": run_id}
