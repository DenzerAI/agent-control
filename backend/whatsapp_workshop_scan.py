"""WhatsApp → Workshop-Absage-Scanner.

Pollt eingehende WhatsApp-Nachrichten (from_me=0, keine Gruppen, letzten N
Tagen) von Personen, die in der Workshops-Pipeline auf 'lead', 'anmeldung'
oder 'gebucht' stehen, und scannt sie auf Absage-Phrasen. Bei Treffer:
events-Insert mit klassifikation='workshop-absage'. Der nachfolgende
lead_pipeline_sync übernimmt dann das pausiert-Setzen + Note.

Keine LLMs. Erweiterte Keyword-Liste deckt die häufigsten direkten und
indirekten Absage-Formulierungen ab.

Aufruf: aus `eingang.reconcile_denzer_leads()` heraus, idempotent.
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from eingang import record_event


_ROOT = Path(__file__).resolve().parent.parent
_WA_DB = _ROOT / "data" / "whatsapp" / "whatsapp.db"
_PEOPLE_DB = _ROOT / "data" / "people.db"


# Eindeutige Absage-Phrasen — matchen direkt
_STRONG_PHRASES = (
    "muss absagen", "muss leider absagen", "leider absagen",
    "möchte absagen", "moechte absagen", "möchte ich absagen",
    "absage hiermit", "hiermit absagen",
    "kann doch nicht teilnehmen", "kann nicht teilnehmen",
    "kann am workshop nicht", "kann doch nicht dabei",
    "nicht teilnehmen kann", "leider nicht teilnehmen",
    "fall raus", "falle raus", "fall leider raus", "falle leider raus",
    "muss canceln", "müssen wir canceln", "muessen wir canceln",
    "stornier",
)

# Schwächere Signale — nur in Kombination mit einer Datums-Erwähnung des
# Workshops zählen sie als Absage.
_WEAK_PHRASES = (
    "leider", "verhindert", "gebunden", "bin im urlaub",
    "klappt nicht", "klappt leider", "passt nicht", "passt leider",
    "schaffe ich nicht", "schaff ich nicht",
    "verschieb", "verschoben",
)

# Datums-Hints, die auf den AI-Sprint zeigen. Erweiterbar — aktuell
# Juni-Workshop.
_DATE_HINTS = (
    "10. juni", "10.06", "10/6", "am 10. juni", "10ten juni",
    "ai-sprint", "ai sprint",
)


def scan_whatsapp_for_workshop_absagen(lookback_days: int = 30) -> dict:
    out = {"candidates": 0, "scanned": 0, "absagen": 0, "skipped": 0, "error": None}
    if not _WA_DB.exists() or not _PEOPLE_DB.exists():
        out["error"] = "db missing"
        return out

    try:
        with sqlite3.connect(_PEOPLE_DB) as p_con:
            p_con.row_factory = sqlite3.Row
            rows = p_con.execute(
                """SELECT id, name, email, phone, whatsapp_chat_id
                     FROM people
                    WHERE pipeline_stream='workshops'
                      AND pipeline_stage IN ('anmeldung','gebucht')
                      AND whatsapp_chat_id IS NOT NULL
                      AND whatsapp_chat_id != ''"""
            ).fetchall()
    except Exception as e:
        out["error"] = f"people-lookup: {e}"
        return out

    by_chat = {r["whatsapp_chat_id"]: dict(r) for r in rows}
    out["candidates"] = len(by_chat)
    if not by_chat:
        return out

    cutoff = time.time() - lookback_days * 86400

    try:
        with sqlite3.connect(_WA_DB) as w_con:
            w_con.row_factory = sqlite3.Row
            placeholders = ",".join("?" for _ in by_chat)
            msgs = w_con.execute(
                f"""SELECT id, chat_id, ts, body, transcript
                      FROM messages
                     WHERE chat_id IN ({placeholders})
                       AND from_me = 0
                       AND ts > ?
                       AND (
                            COALESCE(body,'') != '' OR COALESCE(transcript,'') != ''
                       )""",
                (*by_chat.keys(), cutoff),
            ).fetchall()
    except Exception as e:
        out["error"] = f"wa-lookup: {e}"
        return out

    for m in msgs:
        out["scanned"] += 1
        text = ((m["transcript"] or m["body"] or "")).strip()
        if not text:
            continue
        lower = text.lower()
        strong = any(p in lower for p in _STRONG_PHRASES)
        weak = any(p in lower for p in _WEAK_PHRASES)
        date_hit = any(d in lower for d in _DATE_HINTS)
        if not (strong or (weak and date_hit)):
            continue
        person = by_chat.get(m["chat_id"])
        if not person:
            continue

        external_id = f"wa-absage:{m['id']}"
        result = record_event(
            source="whatsapp-workshop-scan",
            external_id=external_id,
            klassifikation="workshop-absage",
            subject=text[:200],
            excerpt=text[:1000],
            person_email=person["email"] or "",
            person_phone=person["phone"] or "",
            person_name=person["name"] or "",
            payload={"chat_id": m["chat_id"], "wa_msg_id": m["id"]},
            ts=float(m["ts"]),
            silent=True,
        )
        if result.get("inserted"):
            out["absagen"] += 1
        else:
            out["skipped"] += 1
    return out
