"""Privacy router: aggregierte, bereits geschwärzte Sicht auf das Broker-Audit.

Speist den DSGVO-Workspace. Liest ausschließlich aus der separaten Broker-DB
(`data/broker.db`, siehe tools/storage.py) und gibt nur Aggregate plus bereits
geschwärzte, gekappte Vorschauen zurück. KEINE Rohdaten, keine Klartext-PII.

Wichtige Grenze (die der Nutzer mehrfach bestätigt hat): geschwärzt wird nur das
Protokoll der Werkzeug-Läufe, niemals die eigentlichen Quellen (people.db, Chats,
Kalender). Diese Route liest darum bewusst nur die Audit-Tabelle.

Route:
- GET /api/privacy/audit — Status der zwei Schwärzungsstufen, Zähl-Statistik der
  ersetzten Felder nach Typ, 14-Tage-Zeitachse, Top-Werkzeuge und die letzten
  geschwärzten Vorschauen.

Die Zähl-Statistik scannt die bereits in der DB liegenden, geschwärzten Strings
nach den festen Markern ([PERSON], [IBAN], [REDACTED] ...). Damit braucht es kein
Schema und keine zweite Auswertung im Hot-Path des Schreibens.
"""
from __future__ import annotations

import importlib.util
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body
from fastapi.responses import PlainTextResponse

from tools.storage import get_db
from tools.audit import ensure_tool_audit_table
import tools.redaction as redaction

router = APIRouter()

# Repo-Wurzel: routers/ -> backend/ -> agent/. Fuer die Datenkarte, die die
# lokalen Datenquellen zaehlt (read-only, nie schreibend).
_DATA_ROOT = Path(__file__).resolve().parents[2] / "data"

# Marker -> (key, deutsches Label) in Anzeigereihenfolge.
_PII_MARKERS = [
    ("[PERSON]", "person", "Namen"),
    ("[LOCATION]", "location", "Orte"),
    ("[PHONE]", "phone", "Telefonnummern"),
    ("[EMAIL]", "email", "E-Mail-Adressen"),
    ("[IBAN]", "iban", "IBANs"),
    ("[CARD]", "card", "Kartennummern"),
    ("[PII]", "pii", "Sonstige Personendaten"),
]
_SECRET_MARKERS = [
    ("[REDACTED_PATH]", "secret_path", "Sensible Pfade"),
    ("[REDACTED]", "secret", "Secrets / Tokens"),
]

# Zeilen-Limit für die Statistik. Lokal reicht das dicke; hält den Endpoint schnell.
_SCAN_LIMIT = 5000
_RECENT_LIMIT = 14
_PREVIEW_LEN = 220


def _stage2_status() -> dict:
    """Ehrlicher, billiger Status der PII-Stufe ohne das NLP-Modell zu laden."""
    available = importlib.util.find_spec("presidio_analyzer") is not None
    return {
        "enabled": redaction.PII_ENABLED,
        "available": available,
        "loaded": redaction._analyzer is not None,
        "failed": redaction._analyzer_failed,
        "lang": redaction.PII_LANG,
        "min_score": redaction.PII_MIN_SCORE,
        "entities": list(redaction.PII_ENTITIES),
    }


def _count_ro(db_name: str, sql: str) -> int | None:
    """Zaehlt read-only in einer Daten-DB. None, wenn DB/Tabelle fehlt."""
    path = _DATA_ROOT / db_name
    if not path.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        n = con.execute(sql).fetchone()[0]
        con.close()
        return int(n or 0)
    except Exception:
        return None


def _data_map() -> list[dict]:
    """Datenkarte: wo personenbezogene Daten liegen und wie sie behandelt werden.
    handling-Werte spiegeln die Schutzschichten: lokal Klartext, vor Cloud
    tokenisiert (Stufe 3), oder im Protokoll geschwaerzt (Stufe 1+2)."""
    return [
        {
            "key": "contacts", "label": "Kontakte", "unit": "Personen",
            "count": _count_ro("people.db", "SELECT COUNT(*) FROM people"),
            "where": "data/people.db", "handling": "lokal · vor Cloud tokenisiert",
        },
        {
            "key": "chat", "label": "Chat-Nachrichten", "unit": "Nachrichten",
            "count": _count_ro("chat.db", "SELECT COUNT(*) FROM messages"),
            "where": "data/chat.db", "handling": "lokal · Klartext",
        },
        {
            "key": "whatsapp", "label": "WhatsApp", "unit": "Nachrichten",
            "count": _count_ro("whatsapp/whatsapp.db", "SELECT COUNT(*) FROM messages"),
            "where": "data/whatsapp/whatsapp.db", "handling": "lokal · Klartext",
        },
        {
            "key": "calendar", "label": "Termine", "unit": "Einträge",
            "count": _count_ro("chat.db", "SELECT COUNT(*) FROM calendar_events"),
            "where": "data/chat.db", "handling": "lokal · Klartext",
        },
        {
            "key": "audit", "label": "Werkzeug-Protokoll", "unit": "Läufe",
            "count": _count_ro("broker.db", "SELECT COUNT(*) FROM tool_broker_audit"),
            "where": "data/broker.db", "handling": "geschwärzt (Stufe 1+2)",
        },
    ]


def _stage3_status() -> dict:
    """Stufe 3: reversibler Cloud-Schutz vor Mail-Entwuerfen. Maskiert echte
    Kontaktdaten im Prompt und stellt sie in der Antwort wieder her. Kein
    NLP-Modell, sondern Abgleich gegen people.db plus Telefon/Mail/IBAN-Muster."""
    available = False
    contacts = None
    try:
        import pii_redact  # noqa: F401
        contacts = _count_ro("people.db", "SELECT COUNT(*) FROM people")
        available = True
    except Exception:
        available = False
    return {
        "enabled": available,
        "available": available,
        "where": "Mail-Entwürfe vor dem Cloud-Call",
        "source": "people.db",
        "contacts": contacts,
        "masks": ["Name", "Firma", "Telefon", "E-Mail", "IBAN"],
        "reversible": True,
    }


def _count_markers(blob: str, counts: dict[str, int]) -> int:
    hits = 0
    for marker, key, _label in (*_PII_MARKERS, *_SECRET_MARKERS):
        c = blob.count(marker)
        if c:
            counts[key] = counts.get(key, 0) + c
            hits += c
    return hits


@router.get("/api/privacy/audit")
async def privacy_audit() -> dict:
    ensure_tool_audit_table()

    counts: dict[str, int] = {}
    total_redactions = 0
    entries_with_redaction = 0
    by_day: dict[str, dict[str, int]] = {}
    by_tool: dict[str, dict[str, int]] = {}
    recent: list[dict] = []

    with get_db() as db:
        row = db.execute(
            "SELECT COUNT(*), MIN(ts), MAX(ts) FROM tool_broker_audit"
        ).fetchone()
        total_entries = int(row[0] or 0)
        oldest_ts = float(row[1]) if row[1] is not None else None
        newest_ts = float(row[2]) if row[2] is not None else None

        rows = db.execute(
            """SELECT ts, tool_name, decision, ok, arguments_json, output_summary, error
               FROM tool_broker_audit ORDER BY ts DESC LIMIT ?""",
            (_SCAN_LIMIT,),
        ).fetchall()

    for ts, tool_name, decision, ok, args_json, out_summary, error in rows:
        blob = " ".join(str(p) for p in (args_json, out_summary, error) if p)
        hits = _count_markers(blob, counts)
        total_redactions += hits
        if hits:
            entries_with_redaction += 1

        day = datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d")
        d = by_day.setdefault(day, {"entries": 0, "redactions": 0})
        d["entries"] += 1
        d["redactions"] += hits

        t = by_tool.setdefault(tool_name or "?", {"entries": 0, "redactions": 0})
        t["entries"] += 1
        t["redactions"] += hits

        if len(recent) < 12:
            preview = (out_summary or args_json or "").strip()
            if len(preview) > _PREVIEW_LEN:
                preview = preview[:_PREVIEW_LEN] + "…"
            recent.append({
                "ts": float(ts),
                "tool": tool_name or "?",
                "decision": decision or "",
                "ok": bool(ok),
                "redactions": hits,
                "preview": preview,
            })

    by_type = []
    for marker, key, label in (*_PII_MARKERS, *_SECRET_MARKERS):
        by_type.append({
            "key": key,
            "label": label,
            "marker": marker,
            "kind": "pii" if (marker, key, label) in _PII_MARKERS else "secret",
            "count": counts.get(key, 0),
        })

    # 14-Tage-Zeitachse, lückenlos (auch leere Tage), älteste zuerst.
    timeline = []
    today = datetime.now(tz=timezone.utc).date()
    for i in range(_RECENT_LIMIT - 1, -1, -1):
        day = today.fromordinal(today.toordinal() - i)
        key = day.strftime("%Y-%m-%d")
        d = by_day.get(key, {"entries": 0, "redactions": 0})
        timeline.append({"date": key, "entries": d["entries"], "redactions": d["redactions"]})

    top_tools = sorted(
        ({"tool": k, **v} for k, v in by_tool.items()),
        key=lambda x: (x["redactions"], x["entries"]),
        reverse=True,
    )[:6]

    return {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "stage2": _stage2_status(),
        "stage3": _stage3_status(),
        "data_map": _data_map(),
        "totals": {
            "entries": total_entries,
            "scanned": len(rows),
            "redactions": total_redactions,
            "entries_with_redaction": entries_with_redaction,
            "oldest_ts": oldest_ts,
            "newest_ts": newest_ts,
        },
        "by_type": by_type,
        "timeline": timeline,
        "top_tools": top_tools,
        "recent": recent,
    }


def _fmt_int(n: int | None) -> str:
    return "—" if n is None else f"{n:,}".replace(",", ".")


@router.get("/api/privacy/export")
async def privacy_export() -> PlainTextResponse:
    """DSGVO-Nachweis als lesbare Markdown-Datei zum Herunterladen und Vorzeigen.

    Fasst die drei Schutzschichten, die Datenkarte und die Protokoll-Statistik in
    einem Dokument zusammen, das auch jemand ohne Code-Zugang versteht. Enthaelt
    KEINE Klartext-Personendaten, nur Aggregate und bereits geschwaerzte Beispiele.
    """
    data = await privacy_audit()
    s2, s3 = data["stage2"], data["stage3"]
    t = data["totals"]
    now = datetime.now(tz=timezone.utc).strftime("%d.%m.%Y %H:%M")
    s2_on = bool(s2["enabled"] and s2["available"] and not s2["failed"])

    lines: list[str] = []
    lines.append("# Datenschutz-Nachweis · Agent Control")
    lines.append(f"\nStand: {now} · automatisch erzeugt, kein Klartext personenbezogener Daten enthalten.\n")

    lines.append("## Die drei Schutzschichten\n")
    lines.append("**Stufe 1 · Secrets** (aktiv). API-Keys, Tokens, private Schlüssel und "
                 "sensible Pfade werden vor jedem Protokoll-Eintrag durch Platzhalter ersetzt.\n")
    lines.append(f"**Stufe 2 · Personendaten** ({'aktiv' if s2_on else 'nicht aktiv'}). "
                 "Ein lokales deutsches Sprachmodell (Presidio) maskiert Namen, Orte, Telefon, "
                 "Mail und IBAN im Werkzeug-Protokoll. Läuft offline, kein API-Aufruf.\n")
    lines.append(f"**Stufe 3 · Cloud-Schutz** ({'aktiv' if s3['enabled'] else 'nicht aktiv'}). "
                 "Vor einem Mail-Entwurf über ein Cloud-Modell werden echte Kontaktdaten "
                 f"({', '.join(s3['masks'])}) durch Platzhalter ersetzt und in der fertigen "
                 "Antwort wieder eingesetzt. Reversibel, der Abgleich läuft gegen die eigenen "
                 f"Kontakte ({_fmt_int(s3['contacts'])} Personen) plus Telefon-, Mail- und IBAN-Muster.\n")

    lines.append("## Datenkarte · wo liegen welche Daten\n")
    lines.append("| Quelle | Menge | Ort | Behandlung |")
    lines.append("| --- | ---: | --- | --- |")
    for d in data["data_map"]:
        lines.append(f"| {d['label']} | {_fmt_int(d['count'])} {d['unit']} | `{d['where']}` | {d['handling']} |")
    lines.append("\nAlle Quellen liegen lokal auf der eigenen Maschine. Sie bleiben im Klartext "
                 "nutzbar; geschützt wird, was nach außen geht (Cloud-Modelle) oder protokolliert wird.\n")

    lines.append("## Werkzeug-Protokoll · Statistik\n")
    lines.append(f"- Protokoll-Läufe gesamt: **{_fmt_int(t['entries'])}**")
    lines.append(f"- davon mit Schwärzung: **{_fmt_int(t['entries_with_redaction'])}**")
    lines.append(f"- ersetzte Felder gesamt: **{_fmt_int(t['redactions'])}**")
    lines.append("\nErsetzt nach Typ:")
    for b in data["by_type"]:
        if b["count"]:
            art = "Personendaten" if b["kind"] == "pii" else "Secret"
            lines.append(f"- {b['label']} (`{b['marker']}`, {art}): {_fmt_int(b['count'])}")

    lines.append("\n## Wie wir es machen\n")
    lines.append("Jeder Werkzeug-Lauf des Agenten wird protokolliert. Bevor ein Eintrag "
                 "gespeichert wird, laufen Stufe 1 und Stufe 2 darüber, sodass weder Secrets "
                 "noch Personendaten im Protokoll landen. Geht etwas an ein Cloud-Modell "
                 "(Mail-Entwürfe), greift zusätzlich Stufe 3 und hält echte Kontaktdaten "
                 "zurück. Die Originalquellen werden nie verändert, sie bleiben lokal lesbar.\n")
    lines.append("## Auskunft und Löschung\n")
    lines.append("Auskunft (Art. 15) und Löschung (Art. 17) zu einer einzelnen Person erfolgen "
                 "direkt über die Kontaktverwaltung (people.db) und die jeweiligen lokalen "
                 "Speicher. Dieses Dokument belegt die technischen Schutzmaßnahmen.\n")
    lines.append("---\n*Technischer Schutz und Nachweis der Schwärzung, keine vollständige "
                 "DSGVO-Zertifizierung. Erzeugt von Agent Control.*\n")

    md = "\n".join(lines)
    fname = f"datenschutz-nachweis-{datetime.now(tz=timezone.utc).strftime('%Y-%m-%d')}.md"
    return PlainTextResponse(
        md, media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Betroffenenrechte pro Person (Art. 15 Auskunft, Art. 17 Anonymisierung) ──
# people.db liegt unter data/. Diese Endpunkte geben bewusst Klartext-Daten der
# EINEN betroffenen Person aus (Auskunftsrecht) bzw. anonymisieren sie. Token-gated.
_PEOPLE_DB = _DATA_ROOT / "people.db"

# In der people-Zeile geleerte, direkt identifizierende Felder.
_ANON_CLEAR = [
    "phone", "whatsapp_chat_id", "email", "instagram", "billing_email",
    "billing_address", "ust_idnr", "aliases", "customer_notes", "agent_notes",
    "birthday", "city", "slug", "anrede", "next_step_text",
]
# Nebentabellen, deren Zeilen der Person komplett entfernt werden.
_ANON_DELETE = [
    "people_phones", "person_identities", "person_summary",
    "person_summary_history", "person_agent_events", "person_agent_suggestions",
]
# Verknuepfte Tabellen, die fuer die Auskunft mitgelesen werden (sofern vorhanden).
_RELATED_READ = [
    "customers", "offers", "pt_cards", "pt_appointments", "person_identities",
    "people_phones", "person_pipeline_memberships", "person_summary",
]


def _people_ro():
    con = sqlite3.connect(f"file:{_PEOPLE_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


@router.get("/api/privacy/person/search")
async def person_search(q: str) -> dict:
    """Findet Personen fuer die Auskunft/Anonymisierung. q sucht in Name, Mail,
    Telefon, Firma. Gibt nur die Treffer-Stammzeile knapp zurueck."""
    q = (q or "").strip()
    if len(q) < 2:
        return {"results": []}
    like = f"%{q}%"
    out = []
    try:
        con = _people_ro()
        rows = con.execute(
            """SELECT id, name, email, company, status FROM people
               WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ?
               ORDER BY last_interaction_ts DESC LIMIT 20""",
            (like, like, like, like),
        ).fetchall()
        con.close()
        out = [{"id": r["id"], "name": r["name"] or "—", "email": r["email"] or "",
                "company": r["company"] or "", "status": r["status"] or ""} for r in rows]
    except Exception:
        out = []
    return {"results": out}


def _collect_person(pid: int) -> dict | None:
    try:
        con = _people_ro()
    except Exception:
        return None
    person = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
    if not person:
        con.close()
        return None
    related: dict[str, int] = {}
    for t in _RELATED_READ:
        try:
            n = con.execute(f"SELECT COUNT(*) FROM {t} WHERE person_id=?", (pid,)).fetchone()[0]
            if n:
                related[t] = int(n)
        except Exception:
            pass
    con.close()
    return {"person": dict(person), "related": related}


@router.get("/api/privacy/person/{pid}/export")
async def person_export(pid: int) -> PlainTextResponse:
    """Art. 15 Auskunft: alle gespeicherten Daten der Person als lesbare Datei."""
    data = _collect_person(pid)
    if not data:
        return PlainTextResponse("Person nicht gefunden.", status_code=404)
    p = data["person"]
    now = datetime.now(tz=timezone.utc).strftime("%d.%m.%Y %H:%M")
    lines = [f"# Datenauskunft (Art. 15 DSGVO)\n", f"Stand: {now}\n", "## Stammdaten\n"]
    for k, v in p.items():
        if v not in (None, "", 0):
            lines.append(f"- **{k}**: {v}")
    lines.append("\n## Verknüpfte Datensätze\n")
    if data["related"]:
        for t, n in data["related"].items():
            lines.append(f"- {t}: {n} Eintrag/Einträge")
    else:
        lines.append("- keine")
    lines.append("\n## Hinweis\n")
    lines.append("Nachrichtenverläufe (WhatsApp, Chat) liegen in separaten lokalen Speichern "
                 "und können auf Wunsch gesondert ausgegeben werden. Diese Auskunft umfasst "
                 "die strukturierten Stammdaten der Kontaktverwaltung.\n")
    md = "\n".join(lines)
    fname = f"auskunft-person-{pid}-{datetime.now(tz=timezone.utc).strftime('%Y-%m-%d')}.md"
    return PlainTextResponse(
        md, media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.post("/api/privacy/person/{pid}/anonymize")
async def person_anonymize(pid: int, payload: dict = Body(default={})) -> dict:
    """Art. 17: ohne confirm eine Vorschau, was entfernt wird; mit confirm=true
    wird ausgefuehrt. Name und Kontaktfelder werden geleert, PII-Nebentabellen
    entfernt; Betrag und Verlauf von Angeboten bleiben fuer die Buchhaltung."""
    confirm = bool(payload.get("confirm"))
    # Vorschau immer read-only ermitteln.
    pre = _collect_person(pid)
    if not pre:
        return {"error": "not_found"}
    plan = {
        "person_id": pid,
        "name_present": bool(pre["person"].get("name")),
        "fields_cleared": [c for c in dict.fromkeys(_ANON_CLEAR)],
        "tables_purged": [{"table": t, "rows": n} for t, n in pre["related"].items() if t in _ANON_DELETE],
        "offers_kept": pre["related"].get("offers", 0),
    }
    if not confirm:
        return {"preview": True, "plan": plan}

    stamp = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    con = sqlite3.connect(str(_PEOPLE_DB))
    try:
        set_clause = ", ".join(f"{f}=''" for f in dict.fromkeys(_ANON_CLEAR))
        con.execute(
            f"UPDATE people SET name=?, status='anonymisiert', notes=?, {set_clause} WHERE id=?",
            (f"[anonymisiert #{pid}]", f"anonymisiert (Art. 17) am {stamp}", pid),
        )
        for t in _ANON_DELETE:
            try:
                con.execute(f"DELETE FROM {t} WHERE person_id=?", (pid,))
            except Exception:
                pass
        try:
            con.execute("UPDATE offers SET accepted_name='', accepted_email='' WHERE person_id=?", (pid,))
        except Exception:
            pass
        con.commit()
    finally:
        con.close()
    return {"preview": False, "done": True, "plan": plan}
