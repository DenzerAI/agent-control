"""Klaus-Channel — ein ewiger, proaktiver Chat-Faden.

Heartbeat-Watcher und andere Quellen rufen hier ein, wenn sie etwas Relevantes
finden, von dem der Nutzer wissen soll. Die Nachricht landet als Assistant-Turn
in der stabilen Conversation `klaus-channel`, die Conv wird `highlight=1`
markiert (orange im Switcher), und das Frontend zieht sie spätestens beim
nächsten `/api/conversations`-Poll nach.

Dedup + Rate-Limit verhindern Spam. Tonfall-Formung (LLM-Wrapper) ist Phase 2 —
hier landet, was der Aufrufer mitgibt, 1:1.
"""
from __future__ import annotations

import json
import re
import time
from typing import Optional, Sequence
from datetime import datetime
from pathlib import Path

from db import edit_msg, get_db, save_msg

KLAUS_CHANNEL_ID = "klaus-channel"
KLAUS_CHANNEL_AGENT = "main"
KLAUS_CHANNEL_TITLE = "Klaus"
ROOT = Path(__file__).resolve().parents[2]
LEARNINGS = ROOT / "brain" / "LEARNINGS.md"
PROPOSED_HEADER = "## Vorgeschlagene Learnings"

# Marker, der den Source/Dedup-Key in den Message-Content schreibt. HTML-Kommentar,
# damit er im normalen Chat-Rendering unsichtbar bleibt, aber für Dedup-Lookup
# auffindbar ist.
_DEDUP_MARKER = "<!--klaus-channel:{source}:{key}-->"

# Rate-Limit: pro Tag, und Mindestabstand zwischen zwei Posts.
# Bewusst locker, der Nutzer will organische Frequenz statt künstlicher Stille.
# Dedup-Key pro Source verhindert, dass dasselbe Thema in Schleife kommt.
MAX_POSTS_PER_DAY = 15
MIN_GAP_SEC = 5 * 60

# Default-Cooldown pro Source: nicht zweimal in 2h dasselbe Thema anpingen.
DEFAULT_COOLDOWN_SEC = 2 * 3600


def ensure_klaus_channel() -> None:
    """Legt die Klaus-Channel-Conv an, falls noch nicht vorhanden. Idempotent."""
    now = time.time()
    with get_db() as db:
        row = db.execute("SELECT id FROM conversations WHERE id = ?", (KLAUS_CHANNEL_ID,)).fetchone()
        if row:
            return
        db.execute(
            "INSERT INTO conversations (id, agent, project, title, created_at, updated_at, engine) "
            "VALUES (?, ?, '', ?, ?, ?, 'claude')",
            (KLAUS_CHANNEL_ID, KLAUS_CHANNEL_AGENT, KLAUS_CHANNEL_TITLE, now, now),
        )
        print(f"[klaus-channel] Conv erstellt: {KLAUS_CHANNEL_ID}", flush=True)


def backfill_pulse_posts(limit: int = 500) -> dict:
    """Einmaliger Backfill: bestehende Marker-Posts aus `messages` in `klaus_pulse_posts`
    überführen. Idempotent über msg_id. Setzt response_seen, wenn eine User-Message
    innerhalb 24h nach dem Post in der Conv liegt."""
    import re as _re
    pattern = _re.compile(r"<!--klaus-channel:([^:]*):([^>]*)-->")
    inserted = 0
    with get_db() as db:
        existing = {r[0] for r in db.execute("SELECT msg_id FROM klaus_pulse_posts").fetchall()}
        rows = db.execute(
            "SELECT id, content, ts FROM messages WHERE conversation_id = ? AND author = 'assistant' "
            "AND content LIKE '%<!--klaus-channel:%' ORDER BY ts ASC LIMIT ?",
            (KLAUS_CHANNEL_ID, limit),
        ).fetchall()
        for (mid, content, ts) in rows:
            if mid in existing:
                continue
            m = pattern.search(content or "")
            source = m.group(1) if m else ""
            key = m.group(2) if m else ""
            reply = db.execute(
                "SELECT ts FROM messages WHERE conversation_id = ? AND author = 'user' "
                "AND ts > ? AND ts <= ? ORDER BY ts ASC LIMIT 1",
                (KLAUS_CHANNEL_ID, ts, ts + 86400),
            ).fetchone()
            seen = 1 if reply else 0
            resp_ts = reply[0] if reply else None
            db.execute(
                "INSERT INTO klaus_pulse_posts (msg_id, source, dedupe_key, ts, response_seen, response_ts) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (mid, source, key, ts, seen, resp_ts),
            )
            inserted += 1
    return {"inserted": inserted}


def _is_duplicate(source: str, dedupe_key: str, within_sec: int = 24 * 3600) -> bool:
    """True, wenn schon eine Message mit demselben Source+Key in den letzten
    `within_sec` Sekunden im Channel liegt."""
    if not dedupe_key:
        return False
    marker = _DEDUP_MARKER.format(source=source, key=dedupe_key)
    cutoff = time.time() - within_sec
    with get_db() as db:
        row = db.execute(
            "SELECT 1 FROM messages WHERE conversation_id = ? AND ts >= ? AND content LIKE ? LIMIT 1",
            (KLAUS_CHANNEL_ID, cutoff, f"%{marker}%"),
        ).fetchone()
    return row is not None


def _source_cooldown_hit(source: str, cooldown_sec: int) -> bool:
    """True, wenn diese Source in den letzten `cooldown_sec` Sekunden schon
    proaktiv gepostet hat. Dedup-Marker mit `klaus-channel:{source}:` greift."""
    if cooldown_sec <= 0:
        return False
    cutoff = time.time() - cooldown_sec
    needle = f"<!--klaus-channel:{source}:"
    with get_db() as db:
        row = db.execute(
            "SELECT 1 FROM messages WHERE conversation_id = ? AND ts >= ? "
            "AND author = 'assistant' AND content LIKE ? LIMIT 1",
            (KLAUS_CHANNEL_ID, cutoff, f"%{needle}%"),
        ).fetchone()
    return row is not None


def _rotation_index(source: str = "", window_sec: int = 7 * 86400) -> int:
    """Zählt proaktive Klaus-Posts pro Source im Fenster. Eigene Rotation je
    Quelle, damit eine selten feuernde Source ihre Varianten sauber durchläuft
    statt vom globalen Zähler überrollt zu werden."""
    cutoff = time.time() - window_sec
    needle = f"<!--klaus-channel:{source}:" if source else "<!--klaus-channel:"
    with get_db() as db:
        row = db.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND ts >= ? "
            "AND author = 'assistant' AND content LIKE ?",
            (KLAUS_CHANNEL_ID, cutoff, f"%{needle}%"),
        ).fetchone()
    return int(row[0] if row else 0)


def _response_rate(source: str, last_n: int = 5, window_sec: int = 14 * 86400) -> tuple[int, int]:
    """Wie oft hat der Nutzer auf die letzten N proaktiven Posts dieser Source
    geantwortet? Nutzt `klaus_pulse_posts.response_seen` (durch `mark_user_response`
    gesetzt). Returns (responses, total)."""
    cutoff = time.time() - window_sec
    with get_db() as db:
        rows = db.execute(
            "SELECT response_seen FROM klaus_pulse_posts "
            "WHERE source = ? AND ts >= ? ORDER BY ts DESC LIMIT ?",
            (source, cutoff, last_n),
        ).fetchall()
    if not rows:
        return (0, 0)
    responses = sum(1 for (s,) in rows if s)
    return (responses, len(rows))


def _adaptive_cooldown(source: str, base_cooldown: int) -> int:
    """Reaktivität: schweigsame Sources werden leiser, lebendige bleiben normal.
    Greift erst ab 3 echten Datenpunkten, damit neue Sources nicht sofort gedrosselt
    werden."""
    if not source or base_cooldown <= 0:
        return base_cooldown
    responses, total = _response_rate(source, last_n=5)
    if total < 3:
        return base_cooldown
    rate = responses / total
    if rate >= 0.4:
        return base_cooldown
    if rate >= 0.2:
        return int(base_cooldown * 1.5)
    return base_cooldown * 3


def _rate_limited() -> Optional[str]:
    """Gibt einen Grund zurück, wenn aktuell nicht gepostet werden darf, sonst None.

    Zählt nur proaktive Klaus-Posts (assistant-Messages mit Dedup-Marker).
    des Nutzers eigene Antworten zählen nicht."""
    now = time.time()
    day_ago = now - 86400
    gap_ago = now - MIN_GAP_SEC
    with get_db() as db:
        # Letzte proaktive Posts heute
        rows = db.execute(
            "SELECT ts FROM messages WHERE conversation_id = ? AND author = 'assistant' "
            "AND ts >= ? AND content LIKE '%<!--klaus-channel:%' ORDER BY ts DESC",
            (KLAUS_CHANNEL_ID, day_ago),
        ).fetchall()
    if len(rows) >= MAX_POSTS_PER_DAY:
        return f"max {MAX_POSTS_PER_DAY} Posts in 24h erreicht"
    if rows and rows[0][0] >= gap_ago:
        return f"letzter Post < {MIN_GAP_SEC // 60} min her"
    return None


def post(
    text: str | None = None,
    source: str = "",
    dedupe_key: Optional[str] = None,
    force: bool = False,
    variants: Optional[Sequence[str]] = None,
    cooldown_sec: Optional[int] = None,
) -> dict:
    """Postet eine Nachricht in den Klaus-Channel.

    Args:
        text: Fester Nachrichtentext. Wenn `variants` gesetzt ist, wird `text`
            ignoriert und stattdessen rotiert ausgewählt.
        source: Wer hat ausgelöst, z.B. "lead-reconciler", "mail-scanner".
        dedupe_key: Optional. Wenn gesetzt, wird in den letzten 48h nach
            demselben (source, key)-Paar gesucht und ggf. übersprungen.
        force: Wenn True, ignoriert Rate-Limit und Cooldown (für kritische
            Trigger wie Termin-in-8-min).
        variants: Liste von Phrasierungen (Frage / Beobachtung / Vorschlag).
            Rotiert über alle Klaus-Posts der letzten 48h.
        cooldown_sec: Mindestabstand zwischen zwei Posts derselben Source.
            Default 48h. 0 schaltet ab.

    Returns:
        Dict mit `posted: bool` und ggf. `reason: str`. Bei Erfolg auch `msg_id`.
    """
    variant_idx = 0
    if variants:
        variant_idx = _rotation_index(source=source) % len(variants)
        text = variants[variant_idx]
    text = (text or "").strip()
    if not text:
        return {"posted": False, "reason": "leerer Text"}

    ensure_klaus_channel()

    if dedupe_key and _is_duplicate(source, dedupe_key, within_sec=DEFAULT_COOLDOWN_SEC):
        return {"posted": False, "reason": "dedup-hit", "source": source, "key": dedupe_key}

    if not force:
        cd_base = DEFAULT_COOLDOWN_SEC if cooldown_sec is None else cooldown_sec
        cd = _adaptive_cooldown(source, cd_base)
        if cd > 0 and _source_cooldown_hit(source, cd):
            return {"posted": False, "reason": f"cooldown < {cd // 3600}h (adaptiv)"}
        rl = _rate_limited()
        if rl:
            return {"posted": False, "reason": rl}

    # Marker im Content unsichtbar verstecken, damit Dedup auch nach Restart greift.
    marker = _DEDUP_MARKER.format(source=source, key=dedupe_key or "")
    content = f"{text}\n\n{marker}"

    msg_id = save_msg(
        agent=KLAUS_CHANNEL_AGENT,
        project="",
        author="assistant",
        content=content,
        conversation_id=KLAUS_CHANNEL_ID,
    )
    now = time.time()
    with get_db() as db:
        db.execute(
            "UPDATE conversations SET highlight = 1, updated_at = ? WHERE id = ?",
            (now, KLAUS_CHANNEL_ID),
        )
        db.execute(
            "INSERT INTO klaus_pulse_posts (msg_id, source, dedupe_key, variant_idx, ts) "
            "VALUES (?, ?, ?, ?, ?)",
            (msg_id, source, dedupe_key or "", variant_idx, now),
        )
    return {"posted": True, "msg_id": msg_id, "source": source}


def mark_user_response(ts: float, within_sec: int = 24 * 3600) -> int:
    """Markiert alle proaktiven Posts der letzten `within_sec` Sekunden als beantwortet.
    Wird aus `save_msg` aufgerufen, sobald der Nutzer in den Klaus-Channel schreibt.

    Returns: Anzahl der Posts, die jetzt als gesehen markiert wurden.
    """
    cutoff = ts - within_sec
    with get_db() as db:
        cur = db.execute(
            "UPDATE klaus_pulse_posts SET response_seen = 1, response_ts = ? "
            "WHERE response_seen = 0 AND ts >= ? AND ts <= ?",
            (ts, cutoff, ts),
        )
        return cur.rowcount


def consecutive_ignored(source: str, n: int = 3, window_sec: int = 14 * 86400) -> int:
    """Wie viele Posts dieser Quelle hat der Nutzer zuletzt am Stück ignoriert?
    Bricht ab, sobald er auf einen geantwortet hat. Returns: Anzahl unbeantwortet,
    maximal `n`."""
    if not source:
        return 0
    cutoff = time.time() - window_sec
    with get_db() as db:
        rows = db.execute(
            "SELECT response_seen FROM klaus_pulse_posts "
            "WHERE source = ? AND ts >= ? ORDER BY ts DESC LIMIT ?",
            (source, cutoff, n),
        ).fetchall()
    streak = 0
    for (seen,) in rows:
        if seen:
            break
        streak += 1
    return streak


def recent_posts(window_sec: int = 12 * 3600, limit: int = 50) -> list[dict]:
    """Letzte proaktive Posts mit Source + Reaktions-Flag. Für Cross-Talk und Reflektor."""
    cutoff = time.time() - window_sec
    with get_db() as db:
        db.row_factory = __import__("sqlite3").Row
        rows = db.execute(
            "SELECT p.id, p.msg_id, p.source, p.dedupe_key, p.ts, p.response_seen, m.content "
            "FROM klaus_pulse_posts p LEFT JOIN messages m ON m.id = p.msg_id "
            "WHERE p.ts >= ? ORDER BY p.ts DESC LIMIT ?",
            (cutoff, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def _field(block: str, name: str) -> str:
    m = re.search(rf"^- {re.escape(name)}:\s*(.+)$", block, flags=re.MULTILINE)
    if not m:
        return ""
    return m.group(1).strip().strip("`")


def _proposal_title(block: str) -> str:
    m = re.search(r"^###\s+(?:Vorschlag|Übernommen|Abgelehnt):\s*(.+)$", block, flags=re.MULTILINE)
    return (m.group(1).strip() if m else "Learning-Vorschlag")


def _proposal_blocks(text: str) -> list[tuple[str, str]]:
    if PROPOSED_HEADER not in text:
        return []
    tail = text.split(PROPOSED_HEADER, 1)[1]
    matches = list(re.finditer(r"^###\s+.*$", tail, flags=re.MULTILINE))
    blocks: list[tuple[str, str]] = []
    for idx, match in enumerate(matches):
        start = match.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(tail)
        block = tail[start:end].strip()
        sid = _field(block, "source_run_id")
        if sid:
            blocks.append((sid, block))
    return blocks


def _replace_status(block: str, status: str, decision: str) -> str:
    heading = "Übernommen" if status == "accepted" else "Abgelehnt"
    block = re.sub(r"^###\s+(?:Vorschlag|Übernommen|Abgelehnt):", f"### {heading}:", block, count=1, flags=re.MULTILINE)
    block = re.sub(r"^- status:\s*`[^`]+`$", f"- status: `{status}`", block, count=1, flags=re.MULTILINE)
    if re.search(r"^- Entscheidung:", block, flags=re.MULTILINE):
        block = re.sub(r"^- Entscheidung:.*$", f"- Entscheidung: {decision}", block, count=1, flags=re.MULTILINE)
    else:
        block = block.rstrip() + f"\n- Entscheidung: {decision}"
    return block


def _active_learning_block(source_id: str, proposal_block: str) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    title = _proposal_title(proposal_block)
    Anlass = _field(proposal_block, "Anlass")
    vorschlag = _field(proposal_block, "Vorschlag")
    return (
        f"## Übernommenes Learning: {title} ({today})\n\n"
        f"source_run_id: `{source_id}`\n\n"
        f"Auslöser: {Anlass or 'auffälliger Workflow-Run'}.\n\n"
        "**Why:** Der Lauf zeigte ein Muster, das später wieder Zeit kosten kann.\n\n"
        f"**How to apply:** {vorschlag or 'Beim nächsten ähnlichen Lauf Ursache prüfen, bevor der Ablauf als zuverlässig gilt.'}\n\n"
        "---"
    )


def _update_learning_action_message(message_id: int | None, status: str, source_run_ids: list[str]) -> None:
    if not message_id:
        return
    with get_db() as db:
        row = db.execute("SELECT content FROM messages WHERE id = ?", (message_id,)).fetchone()
    if not row:
        return
    content = row[0] or ""
    marker = re.search(r"<!--learning-curator-actions:([\s\S]*?)-->", content)
    if not marker:
        return
    try:
        meta = json.loads(marker.group(1) or "{}")
    except Exception:
        meta = {}
    meta["source_run_ids"] = source_run_ids
    meta["status"] = status
    meta["decided_at"] = datetime.now().isoformat(timespec="seconds")
    meta["decision_label"] = "Übernommen" if status == "accepted" else "Abgelehnt"
    replacement = "<!--learning-curator-actions:" + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "-->"
    edit_msg(message_id, content[: marker.start()] + replacement + content[marker.end():])


def decide_learning_proposals(source_run_ids: list[str], action: str, message_id: int | None = None) -> dict:
    """Setzt vorgeschlagene Learnings auf accepted/rejected.

    Bei `accept` wird zusätzlich ein normaler Learning-Eintrag vor dem
    Vorschlagsabschnitt eingefügt. `source_run_id` bleibt die Nachvollziehbarkeit.
    """
    action = (action or "").strip().lower()
    if action not in {"accept", "reject"}:
        return {"ok": False, "error": "unknown-action"}
    source_run_ids = [str(s).strip() for s in source_run_ids if str(s).strip()]
    if not source_run_ids:
        return {"ok": False, "error": "missing-source-run-ids"}

    status = "accepted" if action == "accept" else "rejected"
    decision = ("übernommen" if status == "accepted" else "abgelehnt") + " am " + datetime.now().strftime("%Y-%m-%d %H:%M")

    text = LEARNINGS.read_text(encoding="utf-8")
    active_zone = text.split(PROPOSED_HEADER, 1)[0]
    blocks_by_id = dict(_proposal_blocks(text))
    changed = 0
    active_blocks: list[str] = []

    for source_id in source_run_ids:
        block = blocks_by_id.get(source_id)
        if not block:
            continue
        current_status = _field(block, "status")
        if current_status in {"accepted", "rejected"}:
            continue
        if status == "accepted" and f"source_run_id: `{source_id}`" not in active_zone:
            active_blocks.append(_active_learning_block(source_id, block))
        new_block = _replace_status(block, status, decision)
        text = text.replace(block, new_block, 1)
        changed += 1

    if active_blocks:
        before, after = text.split(PROPOSED_HEADER, 1)
        text = before.rstrip() + "\n\n" + "\n\n".join(active_blocks) + "\n\n" + PROPOSED_HEADER + after

    if changed:
        LEARNINGS.write_text(text.rstrip() + "\n", encoding="utf-8")
        _update_learning_action_message(message_id, status, source_run_ids)

    return {"ok": True, "status": status, "changed": changed, "source_run_ids": source_run_ids}
