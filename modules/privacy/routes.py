"""Privacy- und DSGVO-Audit fuer den Workspace.

Die Route liest nur den Broker-Audit-Snapshot. Sie gibt keine Rohargumente aus,
sondern Zaehler, Status und bereits geschwaerzte Kurzvorschauen.
"""
from __future__ import annotations

import importlib.util
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from tools.audit import ensure_tool_audit_table
from tools.storage import DB_PATH, get_db
from tools import redaction

router = APIRouter()
TZ = ZoneInfo("Europe/Berlin")


def _one(sql: str, params: tuple = ()) -> int:
    with get_db() as db:
        row = db.execute(sql, params).fetchone()
        return int(row[0] or 0) if row else 0


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    with get_db() as db:
        cur = db.execute(sql, params)
        cols = [col[0] for col in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _iso(ts: float | int | None) -> str:
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(float(ts), TZ).isoformat(timespec="minutes")
    except Exception:
        return ""


def _text(value: object, limit: int = 220) -> str:
    text = str(value or "").replace("\x00", "")
    text = " ".join(text.split())
    return text[:limit]


def _dependency_status() -> dict:
    presidio = importlib.util.find_spec("presidio_analyzer") is not None
    spacy = importlib.util.find_spec("spacy") is not None
    model = False
    if spacy:
        try:
            import spacy as _spacy

            model = bool(_spacy.util.is_package("de_core_news_sm"))
        except Exception:
            model = False
    return {
        "piiEnabled": bool(redaction.PII_ENABLED),
        "presidioInstalled": presidio,
        "spacyInstalled": spacy,
        "germanModelInstalled": model,
        "piiReady": bool(redaction.PII_ENABLED and presidio and spacy and model),
        "language": redaction.PII_LANG,
        "minScore": redaction.PII_MIN_SCORE,
    }


@router.get("/api/privacy/audit")
async def privacy_audit():
    ensure_tool_audit_table()
    now = datetime.now(TZ)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    dep = _dependency_status()

    total = _one("SELECT COUNT(*) FROM tool_broker_audit")
    today = _one("SELECT COUNT(*) FROM tool_broker_audit WHERE ts >= ?", (today_start,))
    allowed = _one("SELECT COUNT(*) FROM tool_broker_audit WHERE decision = 'allow'")
    denied = _one("SELECT COUNT(*) FROM tool_broker_audit WHERE decision != 'allow'")
    errors = _one("SELECT COUNT(*) FROM tool_broker_audit WHERE ok = 0 OR decision = 'error'")
    read_runs = _one("SELECT COUNT(*) FROM tool_broker_audit WHERE risk = 'read'")
    write_runs = _one("SELECT COUNT(*) FROM tool_broker_audit WHERE risk != '' AND risk != 'read'")
    redacted_rows = _one(
        """SELECT COUNT(*) FROM tool_broker_audit
           WHERE arguments_json LIKE '%[REDACTED]%'
              OR arguments_json LIKE '%[REDACTED_PATH]%'
              OR arguments_json LIKE '%[PERSON]%'
              OR arguments_json LIKE '%[EMAIL]%'
              OR arguments_json LIKE '%[PHONE]%'
              OR output_summary LIKE '%[REDACTED]%'
              OR output_summary LIKE '%[REDACTED_PATH]%'
              OR output_summary LIKE '%[PERSON]%'
              OR output_summary LIKE '%[EMAIL]%'
              OR output_summary LIKE '%[PHONE]%'
              OR error LIKE '%[REDACTED]%'
              OR error LIKE '%[PERSON]%'"""
    )

    minmax = _rows("SELECT MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM tool_broker_audit")[0]
    decisions = _rows(
        "SELECT decision AS label, COUNT(*) AS count FROM tool_broker_audit GROUP BY decision ORDER BY count DESC"
    )
    risks = _rows(
        "SELECT COALESCE(NULLIF(risk, ''), 'unknown') AS label, COUNT(*) AS count FROM tool_broker_audit GROUP BY label ORDER BY count DESC"
    )
    tools = _rows(
        "SELECT tool_name AS name, COUNT(*) AS count, MAX(ts) AS lastTs FROM tool_broker_audit GROUP BY tool_name ORDER BY count DESC, lastTs DESC LIMIT 8"
    )
    recent = _rows(
        """SELECT id, ts, tool_name AS toolName, decision, risk, sandbox, ok, error, output_summary AS outputSummary
           FROM tool_broker_audit
           ORDER BY id DESC
           LIMIT 10"""
    )

    status = "ok" if dep["piiReady"] else ("warn" if dep["piiEnabled"] else "off")
    if not total:
        status = "empty"

    payload = {
        "ok": True,
        "generatedAt": now.isoformat(timespec="minutes"),
        "status": status,
        "module": {
            "title": "DSGVO Schutz",
            "subtitle": "Audit, Schwärzung und Nachweis",
            "summary": "Arbeitsdaten bleiben vollständig, Werkzeug-Protokolle werden vor dem Speichern geschwärzt.",
        },
        "stats": {
            "total": total,
            "today": today,
            "allowed": allowed,
            "denied": denied,
            "errors": errors,
            "readRuns": read_runs,
            "writeRuns": write_runs,
            "redactedRows": redacted_rows,
            "firstTs": _iso(minmax.get("firstTs")),
            "lastTs": _iso(minmax.get("lastTs")),
        },
        "protection": {
            "auditOnly": True,
            "rawDataUntouched": True,
            "secrets": True,
            "pii": dep["piiReady"],
            "fallbackSafe": True,
            "database": str(DB_PATH),
        },
        "dependencies": dep,
        "timeline": [
            {
                "label": "Werkzeuglauf",
                "status": "ok",
                "detail": "Jeder Broker-Lauf schreibt einen Audit-Eintrag.",
            },
            {
                "label": "Secret-Schutz",
                "status": "ok",
                "detail": "API-Keys, Token, Private Keys und Secret-Pfade werden ersetzt.",
            },
            {
                "label": "Personendaten",
                "status": "ok" if dep["piiReady"] else "warn",
                "detail": "Presidio erkennt Namen, Telefon, E-Mail, IBAN und Orte lokal." if dep["piiReady"] else "Konfiguriert, aber im laufenden Python noch nicht installiert.",
            },
            {
                "label": "Speicherung",
                "status": "ok",
                "detail": "Gespeichert wird nur der geschwärzte Audit-Snapshot.",
            },
        ],
        "decisions": decisions,
        "risks": risks,
        "tools": [
            {**tool, "lastTs": _iso(tool.get("lastTs"))}
            for tool in tools
        ],
        "recent": [
            {
                **row,
                "ts": _iso(row.get("ts")),
                "ok": bool(row.get("ok")),
                "error": _text(row.get("error")),
                "outputSummary": _text(row.get("outputSummary")),
            }
            for row in recent
        ],
        "nextActions": [
            "Presidio im Server-Environment installieren, falls die PII-Stufe noch gelb ist.",
            "Nach dem nächsten echten Lauf prüfen, ob Redaktionsmarker in Statistik und Recent-Log auftauchen.",
            "Optional später: Tagesexport als prüffähigen Datenschutz-Bericht ergänzen.",
        ],
    }
    return JSONResponse(payload)
