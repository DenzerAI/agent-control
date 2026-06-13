"""Dreaming module helpers for Agent Control.

The nightly job remains scripts/dreaming.py. This module exposes it as an
insight surface: latest pattern analysis, lightweight review and on-demand naps.
Dreaming reads threads as context, but does not promote tasks by default.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
BRAIN = ROOT / "brain"
DREAMS = BRAIN / "dreams"
THREADS = BRAIN / "threads.md"
DAILY = BRAIN / "daily-log"
CHAT_DB = ROOT / "data" / "chat.db"
DECISIONS_PATH = ROOT / "data" / "dreaming" / "decisions.json"
SCRIPT = ROOT / "scripts" / "dreaming.py"
STRONG_SCORE_THRESHOLD = 0.72
EVIDENCE_WINDOW = 8
_STOPWORDS = {
    "aber", "alle", "alten", "alter", "auch", "aufgaben", "christian", "daraus",
    "dass", "deine", "dieser", "dieses", "durch", "einem", "einen", "einer",
    "eines", "etwas", "heute", "klaus", "nicht", "noch", "oder", "ohne",
    "soll", "sollte", "steht", "wird", "wieder", "wenn", "werden", "wurde",
}


try:
    from identity import get_owner as _gow
except ImportError:
    from backend.identity import get_owner as _gow
_OWNER_FIRST = _gow()["first_name"]

def _read(path: Path, cap: int | None = None) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    return text[:cap] if cap else text


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _clip_words(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    clipped = text[:limit].rsplit(" ", 1)[0].strip()
    return (clipped or text[:limit].strip()).rstrip(".,;:") + "…"


def _load_decisions() -> dict[str, str]:
    try:
        data = json.loads(DECISIONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items()}


def set_decision(candidate_id: str, status: str) -> dict[str, Any]:
    status = status if status in {"accepted", "rejected", "deferred", "open"} else "open"
    DECISIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = _load_decisions()
    data[candidate_id] = status
    DECISIONS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "id": candidate_id, "status": status}


def _dream_files() -> list[Path]:
    if not DREAMS.is_dir():
        return []
    return sorted(DREAMS.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)


def _latest(kind: str = "night") -> dict[str, Any] | None:
    for path in _dream_files():
        is_nap = "-nap-" in path.stem
        if kind == "nap" and not is_nap:
            continue
        if kind == "night" and is_nap:
            continue
        text = _read(path)
        if not text.strip():
            continue
        stat = path.stat()
        return {
            "path": str(path),
            "relativePath": _rel(path),
            "name": path.name,
            "mtime": stat.st_mtime,
            "text": text,
            "summary": _summary(text),
            "tonus": _tonus(text),
        }
    return None


def _summary(text: str) -> str:
    m = re.search(r"\*\*(?:Kern|Signal):\*\*\s*(.+?)(?:\n\n|\n\*\*|\Z)", text, re.S)
    if m:
        return _clip_words(m.group(1), 260)
    lines = [line.strip("#* -") for line in text.splitlines() if line.strip()]
    return _clip_words(lines[0], 260) if lines else ""


def _tonus(text: str) -> str:
    m = re.search(r"(?im)^Tonus:\s*([^\n]+)", text)
    return m.group(1).strip().lower() if m else ""


def _section_bullets(text: str, heading: str) -> list[str]:
    m = re.search(rf"\*\*{re.escape(heading)}:\*\*\s*(.+?)(?:\n\n\*\*|\nTonus:|\Z)", text, re.S)
    if not m:
        return []
    body = m.group(1)
    bullets: list[str] = []
    for line in body.splitlines():
        clean = line.strip().removeprefix("-").strip()
        if clean:
            bullets.append(clean)
    return bullets[:4]


def _thread_counts(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for heading in ("CRM / Termine", "Deck / Produkt", "Finance / Jobs", "Sicherheit / Stabilität", "Stack-Migration & Tools"):
        m = re.search(rf"### {re.escape(heading)}\n(.+?)(?:\n### |\n## |\Z)", text, re.S)
        if not m:
            counts[heading] = 0
            continue
        counts[heading] = sum(1 for line in m.group(1).splitlines() if line.strip().startswith("- "))
    counts["gesamt"] = sum(counts.values())
    return counts


def _recent_dates() -> list[dict[str, Any]]:
    out = []
    for path in _dream_files()[:12]:
        out.append({
            "name": path.name,
            "relativePath": _rel(path),
            "mtime": path.stat().st_mtime,
            "kind": "nap" if "-nap-" in path.stem else "night",
            "tonus": _tonus(_read(path, 1800)),
        })
    return out


def _candidate_id(kind: str, text: str, source: str) -> str:
    digest = hashlib.sha1(f"{kind}\n{source}\n{text}".encode("utf-8")).hexdigest()[:12]
    return f"dreaming:{kind}:{digest}"


def _night_files(limit: int = EVIDENCE_WINDOW) -> list[Path]:
    files = []
    for path in _dream_files():
        if "-nap-" in path.stem:
            continue
        files.append(path)
        if len(files) >= limit:
            break
    return files


def _keywords(text: str) -> list[str]:
    words = re.findall(r"[a-zäöüß0-9][a-zäöüß0-9-]{4,}", text.lower())
    seen: set[str] = set()
    out: list[str] = []
    for word in words:
        word = word.strip("-")
        if not word or word in _STOPWORDS or word in seen:
            continue
        seen.add(word)
        out.append(word)
    return out[:8]


def _candidate_evidence(body: str, source: str) -> dict[str, Any]:
    keywords = _keywords(body)
    sources: list[str] = []
    if not keywords:
        return {"frequency": 1, "sources": [source] if source else []}

    for path in _night_files():
        text = _read(path, 8000).lower()
        hits = sum(1 for keyword in keywords if keyword in text)
        needed = 1 if len(keywords) <= 2 else 2
        if hits >= needed:
            sources.append(_rel(path))

    if source and source not in sources:
        sources.insert(0, source)
    return {"frequency": max(1, len(sources)), "sources": sources[:4]}


def _score_candidate(kind: str, frequency: int) -> float:
    base = 0.48 if kind == "pattern" else 0.52
    kind_bonus = 0.04 if kind == "insight" else 0.0
    score = base + kind_bonus + min(max(frequency, 1), 4) * 0.10
    return round(min(score, 0.92), 2)


def _is_promoted(item: dict[str, Any]) -> bool:
    status = str(item.get("status") or "open")
    if status == "rejected":
        return False
    return status == "accepted" or float(item.get("score") or 0) >= STRONG_SCORE_THRESHOLD


def _candidates(latest: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not latest:
        return []
    decisions = _load_decisions()
    text = str(latest.get("text") or "")
    source = str(latest.get("relativePath") or "")
    candidates: list[dict[str, Any]] = []

    for bullet in _section_bullets(text, "Einsicht"):
        cid = _candidate_id("insight", bullet, source)
        evidence = _candidate_evidence(bullet, source)
        score = _score_candidate("insight", int(evidence.get("frequency") or 1))
        status = decisions.get(cid, "open")
        candidates.append({
            "id": cid,
            "kind": "insight",
            "title": bullet[:120],
            "body": bullet,
            "score": score,
            "frequency": evidence.get("frequency") or 1,
            "promoted": status == "accepted" or (status != "rejected" and score >= STRONG_SCORE_THRESHOLD),
            "status": status,
            "source": source,
            "evidenceSources": evidence.get("sources") or [],
            "why": "Nur über Schwelle steuert diese Einsicht Klaus automatisch.",
        })

    for bullet in _section_bullets(text, "Muster"):
        cid = _candidate_id("pattern", bullet, source)
        evidence = _candidate_evidence(bullet, source)
        score = _score_candidate("pattern", int(evidence.get("frequency") or 1))
        status = decisions.get(cid, "open")
        candidates.append({
            "id": cid,
            "kind": "pattern",
            "title": bullet[:120],
            "body": bullet,
            "score": score,
            "frequency": evidence.get("frequency") or 1,
            "promoted": status == "accepted" or (status != "rejected" and score >= STRONG_SCORE_THRESHOLD),
            "status": status,
            "source": source,
            "evidenceSources": evidence.get("sources") or [],
            "why": "Nur häufige oder bestätigte Muster kommen in Live-Kontext und Briefing.",
        })

    return sorted(candidates, key=lambda item: (item.get("promoted", False), item.get("score", 0)), reverse=True)[:5]


def compact_insights(limit: int = 3) -> dict[str, Any]:
    """Small reusable Dreaming digest for UI, chat context and briefings.

    This is intentionally not a task list. It is a behavioral hint for Klaus:
    patterns to keep in mind when answering, not work Christian has to review.
    """
    latest = _latest("night")
    if not latest:
        return {"ok": False, "summary": "", "insights": [], "source": "", "mtime": 0, "threshold": STRONG_SCORE_THRESHOLD}

    seen: set[str] = set()
    insights: list[str] = []
    for item in _candidates(latest):
        if not _is_promoted(item):
            continue
        body = str(item.get("body") or "").strip()
        if not body or body in seen:
            continue
        seen.add(body)
        insights.append(body)
        if len(insights) >= limit:
            break

    if not insights:
        return {
            "ok": False,
            "summary": "",
            "insights": [],
            "source": str(latest.get("relativePath") or ""),
            "mtime": latest.get("mtime") or 0,
            "threshold": STRONG_SCORE_THRESHOLD,
        }

    return {
        "ok": True,
        "summary": str(latest.get("summary") or ""),
        "insights": insights,
        "source": str(latest.get("relativePath") or ""),
        "mtime": latest.get("mtime") or 0,
        "threshold": STRONG_SCORE_THRESHOLD,
    }


def strongest_unshown_pattern(shown_ids: set[str] | None = None) -> dict[str, Any] | None:
    """Strongest promoted pattern/insight not yet surfaced in the Klaus channel.

    Returns the highest-scored candidate over the threshold whose id is not in
    `shown_ids`, or None. Powers the quiet pattern-ping: each gefestigtes Muster
    erscheint hoechstens einmal im Gespraechsfluss.
    """
    shown = shown_ids or set()
    latest = _latest("night")
    if not latest:
        return None
    for item in _candidates(latest):
        if not _is_promoted(item):
            continue
        cid = str(item.get("id") or "")
        if not cid or cid in shown:
            continue
        body = str(item.get("body") or "").strip()
        if not body:
            continue
        return {
            "id": cid,
            "body": body,
            "score": float(item.get("score") or 0),
            "source": str(item.get("source") or ""),
        }
    return None


def live_context(max_age_days: int = 4) -> str:
    digest = compact_insights(limit=3)
    if not digest.get("ok"):
        return ""

    mtime = float(digest.get("mtime") or 0)
    if mtime and time.time() - mtime > max_age_days * 86400:
        return ""

    lines = [
        "Dreaming-Kontext (automatisch, leise verwenden; nicht als Aufgabe erwähnen):",
        f"- Zweck: Klaus soll {_OWNER_FIRST}s wiederkehrende Muster mitdenken, ohne neue To-dos daraus zu machen.",
        f"- Schwelle: Nur Muster ab Score {STRONG_SCORE_THRESHOLD:.2f} oder explizit bestätigte Einsichten steuern Live-Antworten.",
    ]
    for insight in digest.get("insights") or []:
        lines.append(f"- Muster: {insight}")
    source = str(digest.get("source") or "").strip()
    if source:
        lines.append(f"- Quelle: {source}")
    return "\n".join(lines) + "\n\n"


def _chat_count_today() -> int:
    if not CHAT_DB.exists():
        return 0
    try:
        con = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
        row = con.execute(
            "SELECT COUNT(*) FROM messages WHERE date(ts,'unixepoch','localtime') = date('now','localtime') AND content != ''"
        ).fetchone()
        con.close()
        return int(row[0] or 0)
    except sqlite3.Error:
        return 0


def overview() -> dict[str, Any]:
    latest_night = _latest("night")
    latest_nap = _latest("nap")
    threads_text = _read(THREADS)
    candidates = _candidates(latest_night)
    open_candidates = [c for c in candidates if c.get("status") == "open"]
    promoted_candidates = [c for c in candidates if _is_promoted(c)]
    daily_today = DAILY / f"{datetime.now().date().isoformat()}.md"
    return {
        "ok": True,
        "module": {
            "name": "Dreaming",
            "status": "mvp",
            "current": "Heute verdichtet ein Nachtjob Daily Log, Fokus, Roh-Chat, alte Echos, Job-Outputs und Fäden zu Mustern über uns.",
            "future": "Als Modul speist Dreaming nur starke, belegte Einsichten in Morgenbriefing und Chat-Kontext ein; unter der Schwelle bleibt es Nachtdatei.",
            "benefit": f"{_OWNER_FIRST} bekommt morgens Orientierung über wiederkehrende Muster, Reibung, Energie und Drift; Klaus lernt, besser zu begleiten.",
        },
        "automation": {
            "nightly": "05:45 täglich: Nachtanalyse als Einsicht; kein automatisches threads.md-Update",
            "nap": "manuell: kurzer Zwischenlauf ohne Fäden-, Memory- oder Aufgaben-Schreibzugriff",
            "weeklyDeep": "Schwelle: Score, Häufigkeit und Belege über mehrere Nächte; schwache Kandidaten steuern nichts",
            "review": "keine Klick-Pflicht: starke Einsichten fließen leise; falsche Muster können später verworfen werden.",
        },
        "latestNight": latest_night,
        "latestNap": latest_nap,
        "recent": _recent_dates(),
        "threads": {
            "path": str(THREADS),
            "relativePath": _rel(THREADS),
            "counts": _thread_counts(threads_text),
            "summary": _summary(threads_text),
        },
        "sources": {
            "dailyLogToday": str(daily_today),
            "dailyLogTodayExists": daily_today.exists(),
            "chatMessagesToday": _chat_count_today(),
            "dreamsCount": len(_dream_files()),
        },
        "threshold": STRONG_SCORE_THRESHOLD,
        "candidates": candidates,
        "openCandidateCount": len(open_candidates),
        "promotedCandidateCount": len(promoted_candidates),
    }


def run_nap(model: str = "sonnet") -> dict[str, Any]:
    started = time.time()
    cmd = [str(SCRIPT), "--nap", "--model", model]
    result = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        return {
            "ok": False,
            "status": "error",
            "durationMs": int((time.time() - started) * 1000),
            "error": (result.stderr or result.stdout)[-1200:],
        }
    latest_nap = _latest("nap")
    return {
        "ok": True,
        "status": "ok",
        "durationMs": int((time.time() - started) * 1000),
        "stdout": result.stdout[-1200:],
        "latestNap": latest_nap,
    }
