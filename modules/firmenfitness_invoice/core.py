"""Firmenfitness-Invoice-Detector.

Jane/Jule schicken am Monatsende eine kurze Bilanz:
"Sport hat diesen Monat 16x stattgefunden.", "Im Maerz hat es dann 18x
stattgefunden." oder "im Mai kommen wir ... auf 6 Stunden". Daraus wird ein
Lexware-Rechnungs-Draft fuer Wiedemann erzeugt (Kleinunternehmer,
50,00 EUR/Einheit, Position "Firmen Fitness Wiedemann, {Monat} {Jahr}").
Idempotent ueber UNIQUE(scope, year, month).
"""
from __future__ import annotations

import logging
import re
import sqlite3
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CHAT_DB = _REPO_ROOT / "data" / "chat.db"

# Konfiguration pro Sender. Wenn weitere Firmen dazukommen, hier eintragen.
SENDERS: dict[str, dict] = {
    "39810119004272@lid": {  # Jane → Wiedemann GmbH
        "company": "Wiedemann",
        "dedupe_scope": "wiedemann",
        "lexware_contact_id": "9d891a5e-a2ee-47ba-ad73-858fdcf81625",
        "unit_price": 50.0,
        "unit_name": "Einheit",
        "position_template": "Firmen Fitness Wiedemann, {month_name} {year}",
    },
    "201206483972238@lid": {  # Jule → Wiedemann
        "company": "Wiedemann",
        "dedupe_scope": "wiedemann",
        "lexware_contact_id": "9d891a5e-a2ee-47ba-ad73-858fdcf81625",
        "unit_price": 50.0,
        "unit_name": "Einheit",
        "position_template": "Firmen Fitness Wiedemann, {month_name} {year}",
    },
}

MONTHS = {
    "januar": 1, "februar": 2, "märz": 3, "maerz": 3, "april": 4,
    "mai": 5, "juni": 6, "juli": 7, "august": 8, "september": 9,
    "oktober": 10, "november": 11, "dezember": 12,
}
MONTH_NAMES = [
    "", "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]

# Pattern A: "Im Maerz hat es (dann) 18x stattgefunden"
RE_WITH_MONTH = re.compile(
    r"Im\s+(\w+)\s+hat\s+es(?:\s+dann)?\s+(\d+)\s*x\s*stattgefunden",
    re.IGNORECASE,
)
# Pattern B: "Sport hat diesen Monat 16x stattgefunden"
RE_THIS_MONTH = re.compile(
    r"diesen\s+Monat\s+(\d+)\s*x\s*stattgefunden",
    re.IGNORECASE,
)
# Pattern C: "im Mai kommen wir tatsächlich nur auf 6 Stunden"
RE_MONTH_HOURS = re.compile(
    r"im\s+(\w+).*?\b(?:auf|bei)\s+(\d+)\s*(?:stunden|std\.?|einheiten)\b",
    re.IGNORECASE | re.DOTALL,
)


def _ensure_table() -> None:
    with sqlite3.connect(CHAT_DB) as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS firmenfitness_invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_chat_id TEXT NOT NULL,
                year INTEGER NOT NULL,
                month INTEGER NOT NULL,
                count INTEGER NOT NULL,
                lexware_voucher_id TEXT,
                source_message_id TEXT,
                detected_at INTEGER NOT NULL,
                UNIQUE(sender_chat_id, year, month)
            )
            """
        )
        con.commit()


def _parse(text: str, msg_ts: int) -> tuple[int, int, int] | None:
    """Liefert (year, month, count) oder None."""
    if not text:
        return None
    m = RE_WITH_MONTH.search(text)
    if m:
        month_word = m.group(1).strip().lower()
        month_idx = MONTHS.get(month_word)
        if not month_idx:
            return None
        count = int(m.group(2))
        dt = datetime.fromtimestamp(msg_ts)
        year = dt.year
        # Sonderfall: Nachricht im Januar beschreibt Dezember-Vormonat
        if dt.month == 1 and month_idx == 12:
            year -= 1
        return year, month_idx, count
    m = RE_THIS_MONTH.search(text)
    if m:
        count = int(m.group(1))
        dt = datetime.fromtimestamp(msg_ts)
        return dt.year, dt.month, count
    m = RE_MONTH_HOURS.search(text)
    if m:
        month_word = m.group(1).strip().lower()
        month_idx = MONTHS.get(month_word)
        if not month_idx:
            return None
        count = int(m.group(2))
        dt = datetime.fromtimestamp(msg_ts)
        year = dt.year
        if dt.month == 1 and month_idx == 12:
            year -= 1
        return year, month_idx, count
    return None


async def maybe_create(*, text: str, wa_chat_id: str, message_id: str, msg_ts: int) -> dict | None:
    """Wird pro klassifizierter WhatsApp-Message aufgerufen. Idempotent."""
    cfg = SENDERS.get(wa_chat_id)
    if not cfg:
        return None
    parsed = _parse(text, msg_ts)
    if not parsed:
        return None
    year, month, count = parsed
    dedupe_scope = cfg.get("dedupe_scope") or wa_chat_id

    _ensure_table()
    with sqlite3.connect(CHAT_DB) as con:
        con.row_factory = sqlite3.Row
        existing = con.execute(
            "SELECT id FROM firmenfitness_invoices "
            "WHERE sender_chat_id=? AND year=? AND month=?",
            (dedupe_scope, year, month),
        ).fetchone()
        if existing:
            return None
        con.execute(
            "INSERT INTO firmenfitness_invoices "
            "(sender_chat_id, year, month, count, source_message_id, detected_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (dedupe_scope, year, month, count, message_id, int(datetime.now().timestamp())),
        )
        con.commit()

    position = cfg["position_template"].format(
        month_name=MONTH_NAMES[month], year=year,
    )
    total = count * cfg["unit_price"]

    voucher_id = ""
    voucher_err = ""
    try:
        from modules.lexware.providers.lexoffice import (
            build_line_item, create_invoice,
        )
        line = build_line_item(
            name=position,
            quantity=float(count),
            unit_price=cfg["unit_price"],
            unit_name=cfg["unit_name"],
        )
        res = await create_invoice(
            contact_id=cfg["lexware_contact_id"],
            line_items=[line],
            finalize=False,  # bleibt Draft — der Nutzer prueft und versendet
        )
        voucher_id = res.get("id", "")
        if voucher_id:
            with sqlite3.connect(CHAT_DB) as con:
                con.execute(
                    "UPDATE firmenfitness_invoices SET lexware_voucher_id=? "
                    "WHERE sender_chat_id=? AND year=? AND month=?",
                    (voucher_id, dedupe_scope, year, month),
                )
                con.commit()
    except Exception as e:
        voucher_err = str(e)
        log.warning("firmenfitness create_invoice failed: %s", e)

    try:
        from modules.klaus_channel.core import post
        if voucher_id:
            body = (
                f"**Rechnung {cfg['company']} {MONTH_NAMES[month]} {year}** als Draft "
                f"in Lexware. Jane meldete {count}x stattgefunden → "
                f"{count} × {cfg['unit_price']:.2f} € = {total:.2f} €. "
                f"Position: \"{position}\". Bitte in Lexware pruefen und versenden."
            )
        else:
            body = (
                f"**Jane-Meldung erkannt:** {cfg['company']} {MONTH_NAMES[month]} {year}, "
                f"{count}x stattgefunden. Lexware-Draft konnte nicht angelegt werden "
                f"({voucher_err or 'unbekannter Fehler'}). Bitte manuell anlegen."
            )
        post(
            text=body,
            source="firmenfitness_invoice",
            dedupe_key=f"firmenfitness:{dedupe_scope}:{year}:{month}",
            force=True,
        )
    except Exception as e:
        log.warning("klaus_channel.post failed: %s", e)

    try:
        import sys as _sys
        from pathlib import Path as _P
        _sys.path.insert(0, str(_P(__file__).resolve().parent.parent.parent / "backend"))
        from automation_registry import mark_tick as _amt
        _amt("hook", "firmenfitness-invoice", status="found",
             message=f"{year}-{month:02d}: {count}x → {total:.2f} EUR"[:200],
             payload={"year": year, "month": month, "count": count, "voucher_id": voucher_id})
    except Exception:
        pass

    return {
        "year": year, "month": month, "count": count,
        "voucher_id": voucher_id, "position": position, "total": total,
    }
