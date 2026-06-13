"""Problem-Radar — ein Agent nach agents/STANDARD.md (build-agent Skill).

Einmal taeglich durchsucht er X/Twitter ueber kuratierte Themen-Queries nach
echten Schmerzpunkten rund um AI-Agents, Automatisierung und typische
KMU-Frustration. Er sammelt NICHT alles ab, sondern faehrt feste Queries.
Jeder Fund wird hart gegen unser Profil bewertet (Haben wir Infra? Wissen? Bei
uns machbar? Passt es zu Agent Control / KMU?). Nur Funde ueber Schwelle
ueberleben und wandern mit kurzem Loesungsvorschlag als geparkte Idee nach
brain/ideas/. Ping nur bei starkem Fund, sonst still.

Sechs Bausteine:
  1. Trigger   run_radar(trigger="manual"|"cron"); Pulse fuer einmal-taeglich.
  2. Schritte  collect (Queries fahren) -> analyze (LLM-Score) -> review
               (Selbst-Check) -> park (Idee ablegen) -> ping. Stopp: feste
               Query-Liste, harte Treffer-Obergrenze MAX_HITS.
  3. Routing   keine Verzweigung, eine Kette.
  4. Selbst-Check + Lauf-Urteil (review_background_run).
  5. Freigabe  KEIN Outbound an Menschen. Nur interne Ablage + Klaus-Ping.
  6. Gedaechtnis config/problem_radar-learning.json (dismissed/confirmed/rules
               + nachschaerfbare Schwelle).

QUELLE (kapselbar): X hat fuer uns aktuell keine saubere/bezahlte API. Die
Anbindung laeuft daher ueber Brave Search mit site:-Filter auf x.com/twitter.com
(`_search_source`). Sobald ein echter X-API-Key vorliegt, wird nur diese eine
Funktion getauscht, der Rest bleibt. Siehe brain/INFRA.md (BRAVE_API_KEY).
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IDEAS_DIR = ROOT / "brain" / "ideas"
QUERIES_PATH = ROOT / "config" / "problem_radar-queries.json"
LEARN_PATH = ROOT / "config" / "problem_radar-learning.json"

WORKFLOW_KEY = "agent.problem_radar"
PING_SOURCE = "problem-radar"
REGISTRY_NAME = "problem_radar"

# Stopp-Bedingungen (Anthropic-Guardrail): feste Query-Liste + harte Obergrenzen.
MAX_HITS_PER_QUERY = 5
MAX_HITS_TOTAL = 24
MAX_PARK = 3

# Konservative Defaults: lieber an einem Tag NICHTS melden als Muell.
DEFAULT_KEEP_THRESHOLD = 0.78   # darunter fliegt der Fund raus
DEFAULT_PING_THRESHOLD = 0.86   # erst ein wirklich starker Fund pingt Christian


# ── Baustein 6: Lernspeicher (kuratiert, kein Verlauf) ───────────────────────
def _load_learning() -> dict:
    try:
        d = json.loads(LEARN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        d = {}
    d.setdefault("dismissed", [])   # Idee-Slugs, die Christian verworfen hat
    d.setdefault("confirmed", [])   # Slugs, die er gut fand (bevorzugen)
    d.setdefault("rules", [])       # freie Regeln, die der Prompt erbt
    d.setdefault("seen_urls", [])   # schon verarbeitete Quell-URLs, nicht doppeln
    d.setdefault("keep_threshold", DEFAULT_KEEP_THRESHOLD)
    d.setdefault("ping_threshold", DEFAULT_PING_THRESHOLD)
    return d


def _save_learning(d: dict) -> None:
    LEARN_PATH.parent.mkdir(parents=True, exist_ok=True)
    d["seen_urls"] = list(d.get("seen_urls", []))[-400:]
    LEARN_PATH.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:48]


def dismiss(slug: str) -> dict:
    """Signal: dieser Fund war nichts. Slug kuenftig nicht erneut vorschlagen."""
    d = _load_learning()
    s = _slug(slug)
    if s and s not in d["dismissed"]:
        d["dismissed"].append(s)
    if s in d["confirmed"]:
        d["confirmed"].remove(s)
    _save_learning(d)
    return d


def confirm(slug: str) -> dict:
    """Signal: starker Fund. Aehnliche kuenftig bevorzugen."""
    d = _load_learning()
    s = _slug(slug)
    if s and s not in d["confirmed"]:
        d["confirmed"].append(s)
    _save_learning(d)
    return d


# ── Baustein 2a: collect — die Quelle (kapselbar) ────────────────────────────
def _load_queries() -> list[str]:
    try:
        d = json.loads(QUERIES_PATH.read_text(encoding="utf-8"))
        qs = d.get("queries") if isinstance(d, dict) else d
        return [q for q in (qs or []) if isinstance(q, str) and q.strip()]
    except (OSError, json.JSONDecodeError):
        return []


def _search_source(query: str, *, limit: int = MAX_HITS_PER_QUERY) -> list[dict]:
    """Eine Themen-Query gegen die Quelle fahren. Gibt rohe Treffer zurueck.

    KAPSELBAR: heute Brave Search mit site:-Filter auf X. Wenn spaeter ein
    echter X-API-Key da ist, wird NUR diese Funktion getauscht (selbe Rueckgabe:
    Liste aus {title, url, text}). Der Rest des Agenten bleibt unveraendert.
    """
    key = os.environ.get("BRAVE_API_KEY", "").strip()
    if not key:
        return []
    q = f"({query}) (site:x.com OR site:twitter.com OR site:nitter.net)"
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({
        "q": q,
        "count": max(1, min(limit, 10)),
        "freshness": "pw",          # nur die letzte Woche, Schmerz von heute
        "safesearch": "off",
    })
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "X-Subscription-Token": key,
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return []
    out: list[dict] = []
    for r in (data.get("web", {}).get("results") or [])[:limit]:
        title = (r.get("title") or "").strip()
        text = (r.get("description") or "").strip()
        link = (r.get("url") or "").strip()
        if not link:
            continue
        out.append({"title": title, "url": link, "text": text, "query": query})
    return out


def _collect(queries: list[str], seen_urls: set[str]) -> list[dict]:
    """Alle Queries fahren, gegen schon Gesehenes entdoppeln, hart deckeln."""
    hits: list[dict] = []
    seen_now: set[str] = set()
    for q in queries:
        for h in _search_source(q):
            u = h["url"]
            if u in seen_urls or u in seen_now:
                continue
            seen_now.add(u)
            hits.append(h)
            if len(hits) >= MAX_HITS_TOTAL:
                return hits
    return hits


# ── Baustein 2b: analyze — der Filter mit harter Relevanz-Schwelle ───────────
def _build_prompt(hits: list[dict], learn: dict) -> str:
    avoid = ", ".join(learn["dismissed"][-20:]) or "noch nichts"
    liked = ", ".join(learn["confirmed"][-20:]) or "noch nichts"
    rules = "\n".join(f"- {r}" for r in learn["rules"]) or "- (keine)"
    items = "\n".join(
        f'{i}. "{h["title"]}" — {h["text"]}'[:400] for i, h in enumerate(hits)
    )
    return f"""Du bist Klaus, Christians Geschaeftspartner. Christian betreibt Denzer AI
und baut Agent Control: eine lokale, deutsche, DSGVO-nahe Plattform fuer kleine
spezialisierte AI-Agents fuer KMU (Service-as-Software: wir uebernehmen eine
Dienstleistung, die im Hintergrund auf AI laeuft). Wir haben echte Infra
(eigener Server, Worker-Agents, Memory, Skills, lokale + Cloud-LLMs).

Hier sind rohe Fundstuecke aus X/Twitter (Menschen, die ueber Probleme rund um
AI-Agents, Automatisierung und KMU-Frust reden). Bewerte JEDEN Fund streng nach
EINER Frage: Ist das ein echter Schmerzpunkt, den WIR mit unserer Infra und
unserem Wissen loesen koennten und der zu Agent Control / KMU passt?

Sei HART. Generisches Gejammer, Hype, Promo, Crypto, reine Tech-Demos, nichts
Machbares: niedriger Score. Nur ein konkreter, fuer uns loesbarer Schmerz, der
zu unserem Stack passt, bekommt einen hohen Score. Im Zweifel niedrig.

FUNDE:
{items}

Schon verworfen, aehnliche niedrig bewerten: {avoid}
Hat er gut gefunden, aehnliche bevorzugen: {liked}
Zusaetzliche Regeln:
{rules}

Antworte NUR mit JSON, keine Vorrede, kein Markdown-Zaun:
{{"funde":[{{"idx":0,"score":0.0,"problem":"der Schmerz in einem Satz",
"loesung":"wie WIR das mit Agent Control loesen wuerden, ein bis zwei Saetze",
"warum_passt":"woran du festmachst, dass es zu uns passt"}}]}}
score ist 0.0 bis 1.0. Keine Bindestriche als Gedankenstriche im Text."""


async def _call_llm(prompt: str) -> tuple[list[dict], str]:
    model = os.environ.get("PROBLEM_RADAR_MODEL", "gpt-5.1")
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
            reasoning_effort=os.environ.get("PROBLEM_RADAR_EFFORT", "low"),
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
    funde = data.get("funde") if isinstance(data, dict) else None
    return (funde if isinstance(funde, list) else []), ""


def _no_dash(s: str) -> str:
    return str(s or "").replace(" — ", ", ").replace(" – ", ", ").strip()


# ── Baustein 4: Selbst-Check — Schwelle anwenden, entdoppeln ─────────────────
def _filter(funde: list[dict], hits: list[dict], learn: dict) -> tuple[list[dict], list[dict]]:
    """Trennt in (ueberlebt, verworfen). Wendet harte Schwelle + Lernspeicher an."""
    keep_th = float(learn.get("keep_threshold", DEFAULT_KEEP_THRESHOLD))
    kept, dropped, seen = [], [], set()
    for f in funde:
        if not isinstance(f, dict):
            continue
        try:
            idx = int(f.get("idx"))
            score = float(f.get("score"))
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= len(hits):
            continue
        src = hits[idx]
        problem = _no_dash(f.get("problem"))
        if not problem:
            continue
        s = _slug(problem)
        item = {
            "slug": s, "score": round(score, 3),
            "problem": problem,
            "loesung": _no_dash(f.get("loesung")),
            "warum_passt": _no_dash(f.get("warum_passt")),
            "url": src["url"], "title": src["title"], "query": src["query"],
        }
        if s in seen:
            continue
        seen.add(s)
        if s in learn["dismissed"] or score < keep_th:
            dropped.append(item)
            continue
        kept.append(item)
    kept.sort(key=lambda x: x["score"], reverse=True)
    return kept[:MAX_PARK], dropped


# ── Baustein 2c: park — ueberlebenden Fund als Idee in brain/ideas/ ablegen ──
def _park_idea(item: dict) -> str:
    """Schreibt den Fund als geparkte Idee in brain/ideas/ (gleiches Format wie
    die bestehenden Ideen-Dateien). Gibt den relativen Pfad zurueck."""
    IDEAS_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    base = _slug(item["problem"]) or "problem-radar-fund"
    fname = f"problem-radar-{today}-{base}.md"
    path = IDEAS_DIR / fname
    n = 2
    while path.exists():
        path = IDEAS_DIR / f"problem-radar-{today}-{base}-{n}.md"
        n += 1
    title = item["problem"][:80].rstrip(" .,")
    body = (
        f"# {title}\n\n"
        f"**Status:** Idee, geparkt\n"
        f"**Datum:** {today}\n"
        f"**Quelle:** Problem-Radar (X/Twitter), Score {item['score']}\n\n"
        f"## Schmerzpunkt\n\n{item['problem']}\n\n"
        f"## Loesungsidee\n\n{item['loesung'] or '(noch offen)'}\n\n"
        f"## Warum das zu uns passt\n\n{item['warum_passt'] or '(noch offen)'}\n\n"
        f"## Fundstelle\n\n- Query: {item['query']}\n- {item['title']}\n- {item['url']}\n"
    )
    path.write_text(body, encoding="utf-8")
    return str(path.relative_to(ROOT))


# ── Baustein 5: Ping (nur interner Klaus-Ping, kein Outbound an Menschen) ─────
def _format_ping(item: dict) -> str:
    lines = [
        f"**Problem-Radar: {item['problem']}**",
        "",
        f"- **Gefunden:** auf X, passt zu Agent Control (Score {item['score']}).",
    ]
    if item.get("loesung"):
        lines.append(f"- **Loesung:** {item['loesung']}")
    lines.append("- **Abgelegt:** als geparkte Idee, magst du sie ansehen?")
    return "\n".join(lines)


# ── Baustein 1+2: der Lauf ───────────────────────────────────────────────────
async def run_radar(trigger: str = "manual") -> dict:
    import sys
    backend = str(ROOT / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from workflows import start_run, add_step, finish_run, review_background_run

    run_id = start_run(WORKFLOW_KEY, "Problem-Radar", trigger=trigger)
    parked: list[dict] = []
    try:
        learn = _load_learning()
        queries = _load_queries()
        if not queries:
            add_step(run_id, "skip", "Keine Queries konfiguriert", "warning")
            finish_run(run_id, "done", result={"reason": "keine Queries"})
            review_background_run(run_id)
            _tick("ok", "keine Queries")
            return {"ok": True, "parked": [], "run_id": run_id, "reason": "keine Queries"}

        seen_urls = set(learn.get("seen_urls", []))
        hits = _collect(queries, seen_urls)
        add_step(run_id, "collect", f"{len(hits)} rohe Treffer aus {len(queries)} Queries",
                 "ok", f"{len(hits)} Treffer", {"raw": len(hits), "queries": len(queries)})

        if not hits:
            add_step(run_id, "ping", "Keine Treffer, kein Ping", "ok")
            finish_run(run_id, "done", result={"parked": [], "reason": "keine Treffer"})
            review_background_run(run_id)
            _tick("ok", "keine Treffer")
            return {"ok": True, "parked": [], "run_id": run_id, "reason": "keine Treffer"}

        funde, err = await _call_llm(_build_prompt(hits, learn))
        if err:
            add_step(run_id, "analyze", "LLM nicht durch", "error", err)
            finish_run(run_id, "error", error=err)
            review_background_run(run_id)
            _tick("error", err)
            return {"ok": False, "error": err, "run_id": run_id}

        kept, dropped = _filter(funde, hits, learn)
        add_step(run_id, "review",
                 f"{len(kept)} ueber Schwelle, {len(dropped)} verworfen",
                 "ok" if kept else "warning",
                 f"keep>={learn.get('keep_threshold')}",
                 {"kept": [k["slug"] for k in kept], "dropped": len(dropped)})

        for item in kept:
            rel = _park_idea(item)
            item["parked_path"] = rel
            parked.append(item)
            learn["seen_urls"].append(item["url"])
        if parked:
            add_step(run_id, "park", f"{len(parked)} Idee(n) in brain/ideas/ abgelegt",
                     "ok", ", ".join(p["parked_path"] for p in parked))

        # Ping nur bei wirklich starkem Fund.
        ping_th = float(learn.get("ping_threshold", DEFAULT_PING_THRESHOLD))
        strong = [p for p in parked if p["score"] >= ping_th]
        posted = False
        if strong:
            top = strong[0]
            try:
                from modules import klaus_channel as kc
                res = kc.post(text=_format_ping(top), source=PING_SOURCE,
                              dedupe_key=f"problem-radar-{top['slug']}")
                posted = bool(res.get("posted"))
            except Exception as e:  # noqa: BLE001
                add_step(run_id, "ping", "Ping fehlgeschlagen", "warning", str(e)[:160])
            else:
                add_step(run_id, "ping",
                         "Starker Fund gemeldet" if posted else "Ping gedaempft (Dedup)",
                         "ok", top["problem"][:80])
        else:
            add_step(run_id, "ping", "Kein starker Fund, kein Ping", "ok")

        _save_learning(learn)
        finish_run(run_id, "done", result={
            "parked": [{"slug": p["slug"], "score": p["score"], "path": p["parked_path"]} for p in parked],
            "dropped": len(dropped), "posted": posted,
        })
        review_background_run(run_id)
        _tick("found" if parked else "ok",
              f"{len(parked)} geparkt, {len(dropped)} verworfen",
              {"parked": len(parked), "dropped": len(dropped), "posted": posted,
               "changed": bool(parked)})
        return {"ok": True, "parked": parked, "dropped": dropped,
                "posted": posted, "run_id": run_id}
    except Exception as e:  # noqa: BLE001
        try:
            finish_run(run_id, "error", error=str(e)[:200])
        except Exception:
            pass
        _tick("error", str(e)[:200])
        return {"ok": False, "error": str(e)[:200], "run_id": run_id}


def _tick(status: str, message: str, payload: dict | None = None) -> None:
    """Status in die Automation-Registry schreiben (InfoPane > Agents)."""
    try:
        import sys
        backend = str(ROOT / "backend")
        if backend not in sys.path:
            sys.path.insert(0, backend)
        from automation_registry import mark_tick
        mark_tick("worker", REGISTRY_NAME, status=status, message=message[:200],
                  payload=payload or {})
    except Exception:
        pass


# ── Pulse-Einstieg: einmal pro Tag, sync Wrapper um den async Lauf ───────────
def run_pulse() -> dict:
    """Pulse-Tick: feuert den Radar hoechstens einmal pro Tag (ab 09:00).
    Gibt das pulses-payload zurueck, das als Tages-Sperre dient."""
    import asyncio
    from datetime import datetime
    now = datetime.now()
    if now.hour < 9:
        return {"status": "ok", "message": "vor 09:00", "payload": {}}

    today = now.strftime("%Y-%m-%d")
    try:
        import sys
        backend = str(ROOT / "backend")
        if backend not in sys.path:
            sys.path.insert(0, backend)
        from pulses import _get_pulse_state
        state = _get_pulse_state("problem-radar")
    except Exception:
        state = {}
    if state.get("last_run_day") == today:
        return {"status": "ok", "message": "heute schon gelaufen", "payload": state}

    res = asyncio.run(run_radar(trigger="cron"))
    parked = len(res.get("parked") or [])
    status = "found" if parked else ("error" if not res.get("ok") else "ok")
    msg = res.get("error") or f"{parked} Idee(n) geparkt"
    return {"status": status, "message": msg[:200],
            "payload": {"last_run_day": today, "parked": parked,
                        "posted": bool(res.get("posted"))}}
