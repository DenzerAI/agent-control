"""People CRM + Customers + Marketing Campaigns: alle Daten zu Personen,
Kundenstatus, Pipeline-Stages und Kampagnen.

Vorher: ~2.000 Zeilen verstreut in `backend/server.py` (Helper bei 5446, dann
Mail/Inbox dazwischen, dann People-Routen 5765, Customers 6233, weitere
People-Routen 7019, Marketing-Campaigns 7239, Customers-Mentions 7404).

Cross-Deps:
- `from db import get_db` (chat.db, fuer customers/mentions)
- `from db import DB_PATH as _CHAT_DB` (lazy, fuer crm-status upcoming_events)
- `from backend import entities` (Identity-Mentions)
- `from modules.whatsapp.core import WHATSAPP_DB, _wa_db, _wa_chat_display_name`
- `from modules.fokus.core import _focus_list_items` (LAZY, inside function,
  vermeidet Circular-Import)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from db import get_db

# backend/ ins sys.path fuer `from backend import entities`
_REPO_ROOT = str(Path(__file__).parent.parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from modules.whatsapp.core import WHATSAPP_DB, _wa_db, _wa_chat_display_name  # noqa: E402


# ── DB-Helper + Konstanten ───────────────────────────────────────────────

PEOPLE_DB = Path.home() / "agent/data/people.db"

# brain/people-Verzeichnis fuer Journal-Eintraege (Auto-Journal aus Meetings)
_BRAIN_PEOPLE_DIR = Path.home() / "agent/brain/people"
_BRAIN_PEOPLE_INDEX = _BRAIN_PEOPLE_DIR / "_index.json"


def _people_db():
    con = sqlite3.connect(PEOPLE_DB)
    con.row_factory = sqlite3.Row
    return con


PEOPLE_FIELDS = [
    "name", "phone", "whatsapp_chat_id", "email", "instagram",
    "role", "relation", "status", "company", "company_cluster",
    "city", "anrede", "offer_eur", "tags", "birthday", "notes",
    "source", "last_interaction_ts",
    "agent_enabled", "agent_name", "agent_system", "agent_model",
    "agent_status", "agent_workspace", "agent_notes",
]

# Erlaubte Werte fuer people.relation. Hierarchie-Anker: jede Person bekommt
# eindeutig einen Bezug, daraus leitet alles ab (Pipeline, Dossier, Filter).
PEOPLE_RELATIONS = (
    "kunde", "lead", "freund", "familie",
    "partner", "lieferant", "kollege", "kontakt",
)


def _person_row_to_dict(r) -> dict:
    d = dict(r)
    if d.get("tags"):
        try:
            d["tags"] = json.loads(d["tags"])
        except Exception:
            d["tags"] = []
    else:
        d["tags"] = []
    if d.get("aliases"):
        try:
            d["aliases"] = json.loads(d["aliases"])
        except Exception:
            d["aliases"] = []
    else:
        d["aliases"] = []
    d["agent_enabled"] = int(d.get("agent_enabled") or 0)
    d["agent"] = {
        "enabled": bool(d["agent_enabled"]),
        "name": d.get("agent_name") or "",
        "system": d.get("agent_system") or "",
        "model": d.get("agent_model") or "",
        "status": d.get("agent_status") or "",
        "workspace": d.get("agent_workspace") or "",
        "notes": d.get("agent_notes") or "",
    }
    return d


def _agent_row_to_dict(r) -> dict:
    try:
        stage_progress = json.loads(r["stage_progress"]) if r["stage_progress"] else {}
        if not isinstance(stage_progress, dict):
            stage_progress = {}
    except Exception:
        stage_progress = {}
    last_activity = None
    if "last_activity_summary" in r.keys() and r["last_activity_summary"]:
        last_activity = {
            "summary": r["last_activity_summary"],
            "source": r["last_activity_source"] if "last_activity_source" in r.keys() else None,
            "created_at": r["last_activity_ts"] if "last_activity_ts" in r.keys() else None,
        }
    return {
        "id": r["id"],
        "person_id": r["person_id"],
        "company_cluster": r["company_cluster"],
        "project_slug": r["project_slug"],
        "name": r["name"],
        "system": r["system"],
        "model": r["model"],
        "status": r["status"],
        "workspace": r["workspace"],
        "notes": r["notes"],
        "stage_progress": stage_progress,
        "next_step_text": r["next_step_text"] if "next_step_text" in r.keys() else None,
        "next_step_due": r["next_step_due"] if "next_step_due" in r.keys() else None,
        "scope_start_date": r["scope_start_date"] if "scope_start_date" in r.keys() else None,
        "scope_weeks": r["scope_weeks"] if "scope_weeks" in r.keys() else None,
        "scope_done_date": r["scope_done_date"] if "scope_done_date" in r.keys() else None,
        "last_activity": last_activity,
        "is_primary": int(r["is_primary"] or 0),
        "created_at": r["created_at"] if "created_at" in r.keys() else None,
        "updated_at": r["updated_at"] if "updated_at" in r.keys() else None,
    }


# ── Customer-Konstanten ──────────────────────────────────────────────────

CUSTOMER_CATEGORIES = ("personal-training", "workshops", "agent")
CATEGORY_LABELS = {
    "personal-training": "Personal Training",
    "workshops": "Workshops",
    "agent": "Agenten",
}

# Pipeline-Streams + Stages. PT ist absichtlich draussen — Personal-Training
# laeuft ueber pt_cards/pt_appointments, nicht ueber Pipeline.
PIPELINE_STREAMS = ("leads", "agent", "workshops")
PIPELINE_STREAM_LABELS = {
    "leads": "Leads",
    "agent": "AI-Agent",
    "workshops": "Workshops",
}
# Stages, die Kunden in die Historie schicken: sichtbar bleibt nur ein
# rollendes Fenster (siehe END_STAGE_FRESH_DAYS), Älteres versteckt FE bis
# zum Toggle. Wer hier landet, ist nicht mehr aktiv.
# leads hat keine End-Stage mehr: ein Lead verlaesst den Trichter durch
# Handoff (-> agent/workshops) oder wird mit Grund abgelegt (status=lost).
END_STAGES: dict[str, set[str]] = {
    "leads": set(),
    "agent": {"abgeschlossen"},
    "workshops": {"abgeschlossen"},
}
END_STAGE_FRESH_DAYS = 60

# Eine Karte verschwindet nicht hart, sie wird mit Grund abgelegt. Status 'lost'
# in der Membership nimmt sie aus den aktiven Lanes, hält sie aber als
# "Abgelegt"-Spur traceable und reaktivierbar.
LOST_REASONS = {
    "nicht_gemeldet": "Nicht gemeldet",
    "abgesagt": "Abgesagt",
    "kein_bedarf": "Kein Bedarf",
}

# Pro (stream, stage): nach wie vielen Tagen ohne echte Antwort ist der Nutzer dran.
# "Echter Kontakt" = WhatsApp/Mail in beide Richtungen, kein Pageview, kein Kalender.
# End-Stages bekommen keinen Eintrag, dort wird nicht gewarnt.
STAGE_ATTENTION_DAYS: dict[str, dict[str, int]] = {
    "leads": {
        "new": 1,
        "kontaktiert": 5,
        "bedarf": 5,
    },
    "agent": {
        "angebot": 5,
        "onboarding": 10,
        "aufbau": 14,
        "golive": 14,
        "betreuung": 21,
    },
    "workshops": {
        "anmeldung": 3,
        "gebucht": 7,
        "durchgefuehrt": 7,
        "nachfass": 5,
    },
}

# Mentions-source_kinds, die als bilaterale Kommunikation zählen.
REAL_CONTACT_SOURCES = ("whatsapp", "email")
PIPELINE_STAGES: dict[str, list[tuple[str, str]]] = {
    "leads": [
        ("new", "Neu"),
        ("kontaktiert", "Kontaktiert"),
        ("erstgespraech", "Erstgespräch"),
        ("bedarf", "Bedarf geklärt"),
    ],
    "agent": [
        ("angebot", "Angebot"),
        ("onboarding", "Kickoff"),
        ("aufbau", "Aufbau"),
        ("golive", "Go-Live"),
        ("betreuung", "Betreuung"),
        ("abgeschlossen", "Abgeschlossen"),
    ],
    "workshops": [
        ("anmeldung", "Anmeldung"),
        ("gebucht", "Gebucht"),
        ("durchgefuehrt", "Durchgeführt"),
        ("nachfass", "Nachfass"),
        ("abgeschlossen", "Abgeschlossen"),
    ],
}
# Default-Abschlusswahrscheinlichkeit pro (stream, stage) in Prozent (Pipedrive-
# Prinzip). Der gewichtete Forecast = value_eur * probability/100. Im Leads-
# Trichter steigt sie mit der Qualifizierung; ab dem Moment, wo ein Auftrag
# steht (agent ab onboarding, workshops ab gebucht), gilt 100.
STAGE_PROBABILITY: dict[str, dict[str, int]] = {
    "leads": {
        "new": 10,
        "kontaktiert": 25,
        "erstgespraech": 50,
        "bedarf": 70,
    },
    "agent": {
        "angebot": 60,
        "onboarding": 100,
        "aufbau": 100,
        "golive": 100,
        "betreuung": 100,
        "abgeschlossen": 100,
    },
    "workshops": {
        "anmeldung": 80,
        "gebucht": 100,
        "durchgefuehrt": 100,
        "nachfass": 100,
        "abgeschlossen": 100,
    },
}
LEAD_SOURCES = (
    "empfehlung",
    "instagram",
    "whatsapp",
    "linkedin",
    "workshop",
    "kaltakquise",
    "formular",
    "lead-magnet",
    "event",
    "sonstige",
)
LEAD_SOURCE_LABELS = {
    "empfehlung": "Empfehlung",
    "instagram": "Instagram",
    "whatsapp": "WhatsApp",
    "linkedin": "LinkedIn",
    "workshop": "Workshop",
    "kaltakquise": "Kaltakquise",
    "formular": "Formular",
    "lead-magnet": "Lead-Magnet",
    "event": "Event",
    "sonstige": "Sonstige",
}
CAMPAIGN_STAGES = (
    ("idee", "Idee"),
    ("vorbereitung", "Vorbereitung"),
    ("live", "Live"),
    ("auswertung", "Auswertung"),
    ("abgeschlossen", "Abgeschlossen"),
)
CAMPAIGN_CHANNELS = (
    "instagram",
    "linkedin",
    "whatsapp",
    "mail",
    "event",
    "kaltakquise",
    "lead-magnet",
    "sonstiges",
)
WORKSHOP_KINDS = (
    "ai-sprint",
    "agent-bound",
    "dsgvo",
    "sonstige",
)
AGENT_SYSTEMS = (
    "openclaw",
    "agent-control",
    "hermes-agent",
    "custom",
)

# Pro (stream, stage) feste Reihenfolge von Mikroschritten. Items sind
# (key, label). Frontend rendert sie als anklickbare Checkliste. Bei Firmen-
# Karten wird per OR ueber alle Members aggregiert.
STAGE_CHECKLISTS: dict[str, dict[str, list[tuple[str, str]]]] = {
    "leads": {},
    "agent": {
        "angebot": [
            ("umfang", "Leistungsumfang sauber"),
            ("preis", "Preis und Laufzeit klar"),
            ("angebot_verschickt", "Angebot verschickt"),
        ],
        "onboarding": [
            ("rechnung_geschickt", "Rechnung verschickt"),
            ("zahlung_eingegangen", "Zahlung eingegangen"),
            ("kickoff_termin", "Kickoff-Termin gesetzt"),
            ("kpis", "3 KPIs festgelegt"),
            ("daten_eingegangen", "Zugänge und Daten erhalten"),
        ],
        "aufbau": [
            ("agent_art", "Agent-Art entschieden"),
            ("workspace", "Workspace eingerichtet"),
            ("tools", "Tools installiert"),
            ("basis_prompt", "Basis-Prompt gebaut"),
            ("datenquellen", "Datenquellen angebunden"),
            ("apis_rechte", "APIs und Rechte geprüft"),
            ("testfaelle", "Testfälle gegen KPIs geprüft"),
            ("fehlerliste", "Fehlerliste abgearbeitet"),
            ("freigabe", "Kundenfreigabe erhalten"),
        ],
        "golive": [
            ("live", "Agent live geschaltet"),
            ("schulung", "Schulung durchgeführt"),
            ("uebergabe", "An Kunde übergeben"),
        ],
        "betreuung": [
            ("woche_1", "Woche 1 Review"),
            ("woche_2", "Woche 2 Review"),
            ("woche_3", "Woche 3 Review"),
            ("woche_4", "Woche 4 Review"),
        ],
    },
    "workshops": {
        "anmeldung": [
            ("anmeldung_eingegangen", "Anmeldung erhalten"),
            ("bestaetigung", "Bestätigung verschickt"),
        ],
        "gebucht": [
            ("rechnung", "Rechnung verschickt"),
            ("zahlung", "Zahlung eingegangen"),
        ],
        "durchgefuehrt": [
            ("durchgefuehrt", "Workshop durchgeführt"),
            ("doku", "Doku/Slides verschickt"),
        ],
        "nachfass": [
            ("nachfass_mail", "Nachfass-Mail verschickt"),
            ("kundenstimme", "Kundenstimme eingeholt"),
        ],
    },
}


def _checklist_label(stream: str, stage_id: str, item_key: str) -> str:
    for key, label in STAGE_CHECKLISTS.get(stream, {}).get(stage_id, []):
        if key == item_key:
            return label
    return item_key.replace("_", " ")


_AGENT_STAGE_ALIASES = {
    "lead": None,
    "erstgespraech": None,
    "einrichtung": "aufbau",
    "integrationen": "aufbau",
    "test": "aufbau",
}

_AGENT_PROGRESS_KEY_ALIASES = {
    "einrichtung:agent_art": "aufbau:agent_art",
    "einrichtung:workspace": "aufbau:workspace",
    "einrichtung:tools": "aufbau:tools",
    "einrichtung:basis_prompt": "aufbau:basis_prompt",
    "integrationen:datenquellen": "aufbau:datenquellen",
    "integrationen:apis": "aufbau:apis_rechte",
    "integrationen:rechte": "aufbau:apis_rechte",
    "test:testfaelle": "aufbau:testfaelle",
    "test:fehlerliste": "aufbau:fehlerliste",
    "test:freigabe": "aufbau:freigabe",
}


def _normalize_agent_stage(stage: str | None) -> str | None:
    if stage in _AGENT_STAGE_ALIASES:
        return _AGENT_STAGE_ALIASES[stage]
    return stage


def _normalize_agent_progress(stage_progress: dict | None) -> dict:
    if not isinstance(stage_progress, dict):
        return {}
    out = dict(stage_progress)
    for old_key, new_key in _AGENT_PROGRESS_KEY_ALIASES.items():
        if stage_progress.get(old_key):
            out[new_key] = True
    return out


def _agent_progress_complete(stage_progress: dict) -> bool:
    stage_progress = _normalize_agent_progress(stage_progress)
    total = 0
    done = 0
    for stage_id, items in STAGE_CHECKLISTS.get("agent", {}).items():
        for key, _label in items:
            total += 1
            if stage_progress.get(f"{stage_id}:{key}"):
                done += 1
    return total > 0 and done >= total


def _agent_progress_stage(stage_progress: dict, fallback_stage: str = "onboarding") -> str:
    stage_progress = _normalize_agent_progress(stage_progress)
    fallback_stage = _normalize_agent_stage(fallback_stage) or "onboarding"
    for stage_id, items in STAGE_CHECKLISTS.get("agent", {}).items():
        if any(not stage_progress.get(f"{stage_id}:{key}") for key, _label in items):
            return stage_id
    return "abgeschlossen" if _agent_progress_complete(stage_progress) else fallback_stage


def _agent_next_step_text(stage_progress: dict, fallback_stage: str = "onboarding") -> str | None:
    stage_progress = _normalize_agent_progress(stage_progress)
    fallback_stage = _normalize_agent_stage(fallback_stage) or "onboarding"
    if _agent_progress_complete(stage_progress):
        return None
    stage_id = _agent_progress_stage(stage_progress, fallback_stage)
    for key, _label in STAGE_CHECKLISTS.get("agent", {}).get(stage_id, []):
        if not stage_progress.get(f"{stage_id}:{key}"):
            return f"Offen: {_checklist_label('agent', stage_id, key)}"
    return "Offen: nächsten prüfbaren Agent-Schritt festlegen"


def _agent_suggestion_dict(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "agent_id": r["agent_id"],
        "person_id": r["person_id"],
        "kind": r["kind"],
        "title": r["title"],
        "body": r["body"],
        "source_kind": r["source_kind"],
        "source_ref": r["source_ref"],
        "source_label": r["source_label"],
        "source_ts": r["source_ts"] if "source_ts" in r.keys() else None,
        "confidence": float(r["confidence"] or 0),
        "status": r["status"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


def _agent_suggestion_fingerprint(agent_id: int, kind: str, source_kind: str, source_ref: str, title: str, body: str) -> str:
    raw = f"{agent_id}|{kind}|{source_kind}|{source_ref}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _upsert_agent_suggestion(
    con: sqlite3.Connection,
    *,
    agent_id: int,
    person_id: int,
    kind: str,
    title: str,
    body: str,
    source_kind: str,
    source_ref: str,
    source_label: str,
    confidence: float,
    now: int,
    source_ts: int | None = None,
) -> None:
    title = title.strip()
    body = body.strip()
    if not title or not body:
        return
    fingerprint = _agent_suggestion_fingerprint(agent_id, kind, source_kind, source_ref, title, body)
    con.execute(
        """
        INSERT INTO person_agent_suggestions
            (agent_id, person_id, kind, title, body, source_kind, source_ref,
             source_label, source_ts, confidence, status, fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
            body=excluded.body,
            source_label=excluded.source_label,
            source_ts=excluded.source_ts,
            confidence=excluded.confidence,
            updated_at=excluded.updated_at
        """,
        (
            agent_id, person_id, kind, title, body, source_kind, source_ref,
            source_label, source_ts, confidence, fingerprint, now, now,
        ),
    )


def _agent_source_person_ids(con: sqlite3.Connection, person_id: int, agent: sqlite3.Row) -> list[int]:
    ids: list[int] = [person_id]
    cluster = (agent["company_cluster"] or "").strip() if "company_cluster" in agent.keys() else ""
    if cluster:
        rows = con.execute("SELECT id FROM people WHERE company_cluster=? ORDER BY id", (cluster,)).fetchall()
        ids.extend(int(r["id"]) for r in rows)
    out: list[int] = []
    seen: set[int] = set()
    for pid in ids:
        if pid and pid not in seen:
            seen.add(pid)
            out.append(pid)
    return out


def _agent_fresh_contact_floor(con: sqlite3.Connection, person_id: int, agent_id: int | None) -> int:
    agents: list[sqlite3.Row] = []
    if agent_id:
        agent = con.execute("SELECT * FROM person_agents WHERE id=? AND person_id=?", (agent_id, person_id)).fetchone()
        if agent:
            agents = [agent]
    else:
        agents = con.execute("SELECT * FROM person_agents WHERE person_id=?", (person_id,)).fetchall()
    source_ids: set[int] = {person_id}
    for agent in agents:
        source_ids.update(_agent_source_person_ids(con, person_id, agent))
    ph = ",".join("?" * len(source_ids))
    latest = con.execute(
        f"""
        SELECT MAX(ts)
          FROM mentions
         WHERE entity_type='person'
           AND entity_id IN ({ph})
           AND source_kind IN ('whatsapp','email','chat')
        """,
        list(source_ids),
    ).fetchone()[0]
    latest_ts = int(latest or 0)
    return latest_ts - 6 * 86400 if latest_ts else 0


def _refresh_agent_suggestions(con: sqlite3.Connection, person_id: int, agent_id: int | None = None) -> None:
    """Deterministische Vorschlags-Schicht aus belegbaren Quellen.
    Schreibt nur Hinweise, keine echten Projektfelder."""
    now = int(time.time())
    q = "SELECT * FROM person_agents WHERE person_id=?"
    params: list[object] = [person_id]
    if agent_id:
        q += " AND id=?"
        params.append(agent_id)
    agents = con.execute(q, params).fetchall()
    if not agents:
        return

    signal_words = (
        "kpi", "ziel", "workshop", "weiterbildung", "team", "scan",
        "eingang", "firmengedächtnis", "firmengedaechtnis", "lovable",
        "rechnung", "bezahlt", "angebot", "phase",
    )

    for agent in agents:
        aid = int(agent["id"])
        source_person_ids = _agent_source_person_ids(con, person_id, agent)
        ph_people = ",".join("?" * len(source_person_ids))
        source_names = {
            int(r["id"]): r["name"]
            for r in con.execute(
                f"SELECT id, name FROM people WHERE id IN ({ph_people})",
                source_person_ids,
            ).fetchall()
        }
        offer_rows = con.execute(
            f"SELECT * FROM offers WHERE person_id IN ({ph_people}) "
            "ORDER BY COALESCE(accepted_at, sent_at, created_at) DESC LIMIT 6",
            source_person_ids,
        ).fetchall()
        offers: list[sqlite3.Row] = []
        seen_offer_keys: set[tuple[str, str, str, int]] = set()
        for offer in offer_rows:
            key = (
                (offer["url"] or "").strip().lower(),
                (offer["slug"] or "").strip().lower(),
                (offer["package"] or "").strip().lower(),
                int(offer["amount_eur"] or 0),
            )
            if key in seen_offer_keys:
                continue
            seen_offer_keys.add(key)
            offers.append(offer)
        mentions = con.execute(
            f"SELECT entity_id, source_kind, source_id, snippet, ts FROM mentions "
            f"WHERE entity_type='person' AND entity_id IN ({ph_people}) "
            "AND source_kind IN ('whatsapp','email','chat') "
            "ORDER BY ts DESC LIMIT 30",
            source_person_ids,
        ).fetchall()
        latest_contact_ts = max(
            (int(m["ts"] or 0) for m in mentions if m["source_kind"] in {"whatsapp", "email", "chat"}),
            default=0,
        )
        fresh_contact_floor = latest_contact_ts - 6 * 86400 if latest_contact_ts else 0
        upcoming_events: list[sqlite3.Row] = []
        try:
            cal_rows = con.execute(
                f"SELECT source_id FROM mentions "
                f"WHERE entity_type='person' AND entity_id IN ({ph_people}) AND source_kind='calendar'",
                source_person_ids,
            ).fetchall()
            cal_ids = {r["source_id"] for r in cal_rows}
            if cal_ids:
                from db import DB_PATH as _CHAT_DB
                today_iso = datetime.now().date().isoformat()
                with sqlite3.connect(_CHAT_DB) as cdb:
                    cdb.row_factory = sqlite3.Row
                    ph_cal = ",".join("?" * len(cal_ids))
                    upcoming_events = cdb.execute(
                        f"SELECT id, start_iso, title, category FROM calendar_events "
                        f"WHERE (id IN ({ph_cal}) OR gcal_event_id IN ({ph_cal})) "
                        f"AND substr(start_iso, 1, 10) >= ? "
                        f"ORDER BY start_iso ASC LIMIT 5",
                        (*cal_ids, *cal_ids, today_iso),
                    ).fetchall()
        except Exception:
            upcoming_events = []
        try:
            sp = json.loads(agent["stage_progress"]) if agent["stage_progress"] else {}
            if not isinstance(sp, dict):
                sp = {}
        except Exception:
            sp = {}
        next_step = _agent_next_step_text(sp)
        if next_step:
            _upsert_agent_suggestion(
                con,
                agent_id=aid,
                person_id=person_id,
                kind="workflow",
                title="Nächsten Haken prüfen",
                body=next_step,
                source_kind="workflow",
                source_ref=f"agent:{aid}:next",
                source_label="Agent-Ablauf",
                source_ts=now,
                confidence=0.82,
                now=now,
            )
        for offer in offers:
            status = (offer["status"] or "").strip()
            amount = f"{int(offer['amount_eur']):,} €".replace(",", ".") if offer["amount_eur"] else "Betrag offen"
            if status in {"accepted", "paid"}:
                title = "Angebot als Projektstand prüfen"
                body = f"{offer['package'] or offer['slug'] or 'Angebot'} ist {status}; {amount}."
            elif status in {"sent", "opened", "draft", "archived"}:
                title = "Angebotsstand abgleichen"
                body = f"{offer['package'] or offer['slug'] or 'Angebot'} steht auf {status}; {amount}."
            else:
                continue
            _upsert_agent_suggestion(
                con,
                agent_id=aid,
                person_id=person_id,
                kind="offer",
                title=title,
                body=body,
                source_kind="offer",
                source_ref=offer["token"] or offer["slug"] or str(offer["id"]),
                source_label=offer["slug"] or "Angebot",
                source_ts=int(offer["accepted_at"] or offer["sent_at"] or offer["created_at"] or now),
                confidence=0.9 if status in {"accepted", "paid"} else 0.72,
                now=now,
            )
        for event in upcoming_events[:2]:
            _upsert_agent_suggestion(
                con,
                agent_id=aid,
                person_id=person_id,
                kind="calendar",
                title="Termin in Projektplanung übernehmen",
                body=f"{(event['start_iso'] or '')[:16].replace('T', ' ')} · {event['title'] or 'Termin'}",
                source_kind="calendar",
                source_ref=str(event["id"]),
                source_label=event["title"] or "Kalender",
                source_ts=now,
                confidence=0.86,
                now=now,
            )
        for mention in mentions:
            if mention["source_kind"] not in {"email", "whatsapp"}:
                continue
            mention_ts = int(mention["ts"] or 0)
            if fresh_contact_floor and mention_ts < fresh_contact_floor:
                continue
            snippet = (mention["snippet"] or "").strip()
            if not snippet:
                continue
            source_pid = int(mention["entity_id"] or 0)
            person_name = source_names.get(source_pid) or "Kontakt"
            _upsert_agent_suggestion(
                con,
                agent_id=aid,
                person_id=person_id,
                kind="contact",
                title="Kontaktquelle einbeziehen",
                body=f"{person_name}: {snippet[:320]}",
                source_kind=mention["source_kind"],
                source_ref=mention["source_id"] or f"contact:{mention['ts']}",
                source_label=f"{mention['source_kind']} · {person_name} · {relative_ts_label(int(mention['ts'] or 0))}",
                source_ts=mention_ts,
                confidence=0.7,
                now=now,
            )
            break
        for mention in mentions:
            mention_ts = int(mention["ts"] or 0)
            if fresh_contact_floor and mention_ts < fresh_contact_floor:
                continue
            snippet = (mention["snippet"] or "").strip()
            lower = snippet.lower()
            if not snippet or not any(w in lower for w in signal_words):
                continue
            source_pid = int(mention["entity_id"] or 0)
            source_label = f"{mention['source_kind']} · {relative_ts_label(int(mention['ts'] or 0))}"
            if source_pid != person_id and source_names.get(source_pid):
                source_label = f"{mention['source_kind']} · {source_names[source_pid]} · {relative_ts_label(int(mention['ts'] or 0))}"
            _upsert_agent_suggestion(
                con,
                agent_id=aid,
                person_id=person_id,
                kind="conversation",
                title="Gesprächshinweis prüfen",
                body=snippet[:360],
                source_kind=mention["source_kind"],
                source_ref=mention["source_id"] or f"mention:{mention['ts']}",
                source_label=source_label,
                source_ts=mention_ts,
                confidence=0.64,
                now=now,
            )
            break


def relative_ts_label(ts: int) -> str:
    if not ts:
        return "ohne Datum"
    days = max(0, (int(time.time()) - ts) // 86400)
    if days == 0:
        return "heute"
    if days == 1:
        return "gestern"
    if days < 14:
        return f"vor {days} T"
    return f"vor {days // 7} W"

# Reihenfolge bestimmt Rang in Firmen-Karten (GF zuerst, Team zuletzt)
_ROLE_RANK = {"GF": 0, "Praxis-Inhaber": 0, "Ansprechpartner": 1, "Ansprechpartnerin Praxis": 1, "Team": 2}
# Welche Projekt-Slugs zur selben Firma clustern, plus Anzeigename
_AGENT_FIRM_LABELS = {}
_AGENT_FIRM_CLUSTER = {}


# ── Schema-Migrationen (idempotent) ──────────────────────────────────────

_PEOPLE_CUSTOMER_COLS: tuple[tuple[str, str], ...] = (
    ("categories", "TEXT"),
    ("rate_eur", "INTEGER"),
    ("value_eur", "INTEGER"),
    ("active_since", "TEXT"),
    ("last_invoice_ts", "INTEGER"),
    ("customer_notes", "TEXT"),
    ("next_step_text", "TEXT"),
    ("next_step_due", "TEXT"),
    ("pipeline_stream", "TEXT"),
    ("pipeline_stage", "TEXT"),
    ("stage_progress", "TEXT"),
    ("workshop_kind", "TEXT"),
    ("lead_source", "TEXT"),
    ("betreuung_done", "INTEGER DEFAULT 0"),
    ("source_campaign_id", "INTEGER"),
    ("customer_status", "TEXT"),
)

_PEOPLE_AGENT_COLS: tuple[tuple[str, str], ...] = (
    ("agent_enabled", "INTEGER NOT NULL DEFAULT 0"),
    ("agent_name", "TEXT"),
    ("agent_system", "TEXT"),
    ("agent_model", "TEXT"),
    ("agent_status", "TEXT"),
    ("agent_workspace", "TEXT"),
    ("agent_notes", "TEXT"),
)


def _ensure_agent_schema() -> None:
    """Idempotente Migration: Agent-Besitzstand direkt auf people plus
    normalisierte Liste für mehrere Agenten pro Person/Firma."""
    with _people_db() as con:
        existing = {r["name"] for r in con.execute("PRAGMA table_info(people)").fetchall()}
        for col, decl in _PEOPLE_AGENT_COLS:
            if col not in existing:
                con.execute(f"ALTER TABLE people ADD COLUMN {col} {decl}")
        con.execute("CREATE INDEX IF NOT EXISTS idx_people_agent_enabled ON people(agent_enabled)")
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS person_agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                person_id INTEGER,
                company_cluster TEXT,
                project_slug TEXT,
                name TEXT NOT NULL,
                system TEXT,
                model TEXT,
                status TEXT,
                workspace TEXT,
                notes TEXT,
                stage_progress TEXT,
                is_primary INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(person_id, company_cluster, project_slug, name)
            )
            """
        )
        agent_cols = {r["name"] for r in con.execute("PRAGMA table_info(person_agents)").fetchall()}
        for col, decl in (
            ("stage_progress", "TEXT"),
            ("next_step_text", "TEXT"),
            ("next_step_due", "TEXT"),
            ("scope_start_date", "TEXT"),
            ("scope_weeks", "INTEGER"),
            ("scope_done_date", "TEXT"),
        ):
            if col not in agent_cols:
                con.execute(f"ALTER TABLE person_agents ADD COLUMN {col} {decl}")
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS person_agent_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER,
                person_id INTEGER,
                source TEXT NOT NULL DEFAULT 'manual',
                event_type TEXT NOT NULL,
                stage_id TEXT,
                item_key TEXT,
                item_label TEXT,
                done INTEGER,
                summary TEXT,
                created_at INTEGER NOT NULL
            )
            """
        )
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS person_agent_suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER NOT NULL,
                person_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                source_ref TEXT NOT NULL,
                source_label TEXT,
                source_ts INTEGER,
                confidence REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'new',
                fingerprint TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        suggestion_cols = {r["name"] for r in con.execute("PRAGMA table_info(person_agent_suggestions)").fetchall()}
        if "source_ts" not in suggestion_cols:
            con.execute("ALTER TABLE person_agent_suggestions ADD COLUMN source_ts INTEGER")
        con.execute("CREATE INDEX IF NOT EXISTS idx_person_agent_events_agent ON person_agent_events(agent_id, created_at DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_person_agent_events_person ON person_agent_events(person_id, created_at DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_person_agent_suggestions_agent ON person_agent_suggestions(agent_id, status, updated_at DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_person_agent_suggestions_person ON person_agent_suggestions(person_id, status, updated_at DESC)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_person_agents_person ON person_agents(person_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_person_agents_cluster ON person_agents(company_cluster)")
        con.execute(
            """
            DELETE FROM person_agents
             WHERE id NOT IN (
                SELECT MIN(id)
                  FROM person_agents
                 GROUP BY COALESCE(person_id, 0),
                          COALESCE(company_cluster, ''),
                          COALESCE(project_slug, ''),
                          lower(name)
             )
            """
        )
        con.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_person_agents_unique_key
                ON person_agents(
                    COALESCE(person_id, 0),
                    COALESCE(company_cluster, ''),
                    COALESCE(project_slug, ''),
                    lower(name)
                )
            """
        )
        con.execute(
            """
            DELETE FROM person_agents
             WHERE person_id IS NOT NULL
               AND id NOT IN (
                SELECT MIN(id)
                  FROM person_agents
                 WHERE person_id IS NOT NULL
                 GROUP BY person_id, lower(name)
             )
            """
        )
        con.execute(
            """
            DELETE FROM person_agents
             WHERE person_id IS NULL
               AND id NOT IN (
                SELECT MIN(id)
                  FROM person_agents
                 WHERE person_id IS NULL
                 GROUP BY COALESCE(company_cluster, ''), lower(name)
             )
            """
        )
        con.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_person_agents_unique_person_name
                ON person_agents(person_id, lower(name))
             WHERE person_id IS NOT NULL
            """
        )
        con.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_person_agents_unique_cluster_name
                ON person_agents(COALESCE(company_cluster, ''), lower(name))
             WHERE person_id IS NULL
            """
        )
        now = int(time.time())
        for r in con.execute(
            "SELECT id, company_cluster, agent_name, agent_system, agent_model, agent_status, agent_workspace, agent_notes "
            "FROM people WHERE agent_name IS NOT NULL AND agent_name != ''"
        ).fetchall():
            con.execute(
                """INSERT OR IGNORE INTO person_agents
                   (person_id, company_cluster, name, system, model, status, workspace, notes, is_primary, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                (
                    r["id"], r["company_cluster"], r["agent_name"], r["agent_system"],
                    r["agent_model"], r["agent_status"], r["agent_workspace"],
                    r["agent_notes"], now, now,
                ),
            )
        con.execute(
            """
            UPDATE person_agents
               SET stage_progress = (
                    SELECT ppm.stage_progress
                      FROM person_pipeline_memberships ppm
                     WHERE ppm.person_id = person_agents.person_id
                       AND ppm.stream = 'agent'
                     LIMIT 1
               ),
                   updated_at = ?
             WHERE (stage_progress IS NULL OR stage_progress = '')
               AND person_id IS NOT NULL
               AND EXISTS (
                    SELECT 1
                      FROM person_pipeline_memberships ppm
                     WHERE ppm.person_id = person_agents.person_id
                       AND ppm.stream = 'agent'
                       AND ppm.stage_progress IS NOT NULL
                       AND ppm.stage_progress != ''
               )
            """,
            (now,),
        )
        agent_person_ids: set[int] = set()
        for r in con.execute(
            "SELECT id, person_id, status, stage_progress, next_step_text FROM person_agents"
        ).fetchall():
            if r["person_id"]:
                agent_person_ids.add(int(r["person_id"]))
            try:
                sp = json.loads(r["stage_progress"]) if r["stage_progress"] else {}
                if not isinstance(sp, dict):
                    sp = {}
            except Exception:
                sp = {}
            complete = _agent_progress_complete(sp)
            updates: dict[str, object] = {"updated_at": now}
            if complete:
                updates["status"] = "Abgeschlossen"
                updates["next_step_text"] = None
            else:
                current_next = (r["next_step_text"] or "").strip()
                if not current_next or "nächster Agent-Schritt prüfen" in current_next:
                    updates["next_step_text"] = _agent_next_step_text(sp)
                if (r["status"] or "").strip() in {"", "Abgeschlossen", "In Arbeit"}:
                    updates["status"] = "In Arbeit"
            if len(updates) > 1:
                assignments = ", ".join(f"{key}=?" for key in updates)
                con.execute(
                    f"UPDATE person_agents SET {assignments} WHERE id=?",
                    [*updates.values(), r["id"]],
                )
        pipeline_memberships_exists = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='person_pipeline_memberships'"
        ).fetchone()
        if pipeline_memberships_exists:
            for person_id in agent_person_ids:
                _sync_person_agent_pipeline(con, person_id, now)
        con.commit()


def _ensure_campaigns_schema() -> None:
    """Idempotente Migration: campaigns-Tabelle + people.source_campaign_id."""
    with _people_db() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                stage TEXT NOT NULL DEFAULT 'idee',
                channel TEXT,
                goal TEXT,
                notes TEXT,
                started_at INTEGER,
                ended_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        people_cols = {r["name"] for r in con.execute("PRAGMA table_info(people)").fetchall()}
        if "source_campaign_id" not in people_cols:
            con.execute("ALTER TABLE people ADD COLUMN source_campaign_id INTEGER")
        con.commit()


def _ensure_pipeline_memberships_schema() -> None:
    """Multi-Stream Mitgliedschaften: Eine Person kann gleichzeitig in mehreren
    Pipeline-Streams stehen (z. B. workshops/abgeschlossen + agent/angebot).
    Backfill aus people.pipeline_stream/stage."""
    with _people_db() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS person_pipeline_memberships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                person_id INTEGER NOT NULL,
                stream TEXT NOT NULL,
                stage TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(person_id, stream),
                FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
            )
            """
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_ppm_stream ON person_pipeline_memberships(stream)"
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_ppm_person ON person_pipeline_memberships(person_id)"
        )
        ppm_cols = {r["name"] for r in con.execute("PRAGMA table_info(person_pipeline_memberships)").fetchall()}
        for col, ddl in (
            ("stage_progress", "TEXT"),
            ("next_step_text", "TEXT"),
            ("next_step_due", "TEXT"),
            ("notes", "TEXT"),
            ("status", "TEXT"),
            ("lost_reason", "TEXT"),
            ("lost_at", "INTEGER"),
        ):
            if col not in ppm_cols:
                con.execute(f"ALTER TABLE person_pipeline_memberships ADD COLUMN {col} {ddl}")
        con.execute(
            "UPDATE person_pipeline_memberships SET stage='aufbau', updated_at=? "
            "WHERE stream='agent' AND stage IN ('einrichtung','integrationen','test')",
            (int(time.time()),),
        )
        con.execute(
            "UPDATE people SET pipeline_stage='aufbau', updated_at=? "
            "WHERE pipeline_stream='agent' AND pipeline_stage IN ('einrichtung','integrationen','test')",
            (int(time.time()),),
        )
        con.execute(
            """INSERT OR IGNORE INTO person_pipeline_memberships
               (person_id, stream, stage, next_step_text, next_step_due, notes, created_at, updated_at)
               SELECT person_id, 'leads',
                      CASE WHEN stage='erstgespraech' THEN 'bedarf' ELSE 'kontaktiert' END,
                      next_step_text, next_step_due, notes, COALESCE(created_at, ?), ?
                 FROM person_pipeline_memberships
                WHERE stream='agent' AND stage IN ('lead','erstgespraech')""",
            (int(time.time()), int(time.time())),
        )
        con.execute(
            """UPDATE person_pipeline_memberships
                  SET stage='angebot', updated_at=?
                WHERE stream='agent'
                  AND stage IN ('lead','erstgespraech')
                  AND EXISTS (
                    SELECT 1 FROM offers o
                     WHERE o.person_id=person_pipeline_memberships.person_id
                       AND o.status NOT IN ('declined','lost','archived')
                  )""",
            (int(time.time()),),
        )
        con.execute(
            """UPDATE person_pipeline_memberships
                  SET stage='onboarding', updated_at=?
                WHERE stream='agent'
                  AND stage IN ('lead','erstgespraech')
                  AND EXISTS (
                    SELECT 1 FROM person_agents pa
                     WHERE pa.person_id=person_pipeline_memberships.person_id
                  )""",
            (int(time.time()),),
        )
        con.execute(
            """DELETE FROM person_pipeline_memberships
                WHERE stream='agent'
                  AND stage IN ('lead','erstgespraech')""",
        )
        con.execute(
            """UPDATE people
                  SET pipeline_stream='leads',
                      pipeline_stage=CASE WHEN pipeline_stage='erstgespraech' THEN 'bedarf' ELSE 'kontaktiert' END,
                      updated_at=?
                WHERE pipeline_stream='agent'
                  AND pipeline_stage IN ('lead','erstgespraech')""",
            (int(time.time()),),
        )
        now = int(time.time())
        rows = con.execute(
            "SELECT id, pipeline_stream, pipeline_stage FROM people "
            "WHERE pipeline_stream IS NOT NULL AND pipeline_stream != ''"
        ).fetchall()
        for r in rows:
            stream = (r["pipeline_stream"] or "").strip()
            stage = (r["pipeline_stage"] or "").strip()
            if not stream or not stage:
                continue
            con.execute(
                """INSERT OR IGNORE INTO person_pipeline_memberships
                   (person_id, stream, stage, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (r["id"], stream, stage, now, now),
            )
        con.commit()


def _ensure_offers_schema() -> None:
    """Idempotente Migration: offers-Tabelle pro Angebot. Eine Person kann
    mehrere offers haben. Quelle der Wahrheit für View-Tracker + Accept."""
    with _people_db() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS offers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                person_id INTEGER,
                slug TEXT NOT NULL DEFAULT '',
                package TEXT NOT NULL DEFAULT '',
                amount_eur INTEGER,
                url TEXT NOT NULL DEFAULT '',
                sent_at INTEGER,
                sent_via TEXT NOT NULL DEFAULT '',
                opened_count INTEGER NOT NULL DEFAULT 0,
                last_opened_at INTEGER,
                accepted_at INTEGER,
                accepted_name TEXT,
                accepted_email TEXT,
                status TEXT NOT NULL DEFAULT 'draft',
                last_synced_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        con.execute("CREATE INDEX IF NOT EXISTS idx_offers_person ON offers(person_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_offers_sent ON offers(sent_at DESC)")
        con.commit()


def _ensure_customer_pipeline_columns():
    """Idempotente Migration: ergaenzt alle Customer-Felder direkt auf
    `people` und stellt sicher, dass `company_cluster` aus Projekt-Mitglied-
    schaften vorbefuellt ist. Bestandsdaten ohne pipeline_stream werden
    anhand der `categories` initial gemappt."""
    with _people_db() as con:
        existing = {r["name"] for r in con.execute("PRAGMA table_info(people)").fetchall()}
        added_pipeline_cols = False
        for col, decl in _PEOPLE_CUSTOMER_COLS:
            if col in existing:
                continue
            con.execute(f"ALTER TABLE people ADD COLUMN {col} {decl}")
            if col in ("pipeline_stream", "pipeline_stage", "workshop_kind",
                       "lead_source", "betreuung_done", "stage_progress"):
                added_pipeline_cols = True
        # Stage-Rename: kickoff → onboarding (Bestandsdaten umlabeln)
        con.execute(
            "UPDATE people SET pipeline_stage='onboarding' "
            "WHERE pipeline_stream='agent' AND pipeline_stage='kickoff'"
        )
        if "company_cluster" not in existing:
            con.execute("ALTER TABLE people ADD COLUMN company_cluster TEXT")
            for slug, cluster in _AGENT_FIRM_CLUSTER.items():
                con.execute(
                    """
                    UPDATE people SET company_cluster = ?
                    WHERE company_cluster IS NULL
                      AND id IN (
                        SELECT pm.person_id FROM person_projects pm
                        JOIN projects p ON p.id = pm.project_id
                        WHERE p.slug = ?
                      )
                    """,
                    (cluster, slug),
                )
        if added_pipeline_cols:
            rows = con.execute(
                "SELECT id, categories FROM people "
                "WHERE pipeline_stream IS NULL AND categories IS NOT NULL AND categories != ''"
            ).fetchall()
            for r in rows:
                try:
                    cats = json.loads(r["categories"] or "[]")
                except Exception:
                    cats = []
                stream = None
                stage = None
                if "leads" in cats:
                    stream, stage = "leads", "new"
                elif "agent" in cats:
                    stream, stage = "agent", "betreuung"
                elif "workshops" in cats:
                    stream, stage = "workshops", "abgeschlossen"
                if stream:
                    con.execute(
                        "UPDATE people SET pipeline_stream=?, pipeline_stage=? WHERE id=?",
                        (stream, stage, r["id"]),
                    )
        con.commit()


# ── Row-Konverter + PT-Index ─────────────────────────────────────────────

def _customer_row(person_row, projects=None) -> dict:
    """Baut die Customer-View aus einer people-Zeile. Alle Customer-Felder
    liegen jetzt direkt auf `people`; das Response-Shape bleibt identisch
    (Frontend erwartet `status`, `notes`, `id` etc.)."""
    cats: list = []
    try:
        cats = json.loads(person_row["categories"] or "[]")
        if not isinstance(cats, list):
            cats = []
    except Exception:
        cats = []
    try:
        if int(person_row["agent_enabled"] or 0) and "agent" not in cats:
            cats.append("agent")
    except Exception:
        pass
    person = _person_row_to_dict(person_row) if person_row else None
    def _opt(k):
        try:
            return person_row[k]
        except (KeyError, IndexError):
            return None
    try:
        sp_raw = _opt("stage_progress")
        stage_progress = json.loads(sp_raw) if sp_raw else {}
        if not isinstance(stage_progress, dict):
            stage_progress = {}
    except Exception:
        stage_progress = {}
    pid = int(person_row["id"]) if person_row else None
    return {
        # Es gibt keine eigene customer-ID mehr — id == person_id, damit das
        # Frontend einen stabilen Key hat.
        "id": pid,
        "person_id": pid,
        "categories": cats,
        "status": _opt("customer_status"),
        "rate_eur": _opt("rate_eur"),
        "value_eur": _opt("value_eur"),
        "active_since": _opt("active_since"),
        "last_invoice_ts": _opt("last_invoice_ts"),
        "last_interaction_ts": (person or {}).get("last_interaction_ts") if person else None,
        "notes": _opt("customer_notes"),
        "next_step_text": _opt("next_step_text"),
        "next_step_due": _opt("next_step_due"),
        "pipeline_stream": _opt("pipeline_stream"),
        "pipeline_stage": _opt("pipeline_stage"),
        "workshop_kind": _opt("workshop_kind"),
        "lead_source": _opt("lead_source"),
        "betreuung_done": int(_opt("betreuung_done") or 0),
        "agent": (person or {}).get("agent") if person else None,
        "stage_progress": stage_progress,
        "person": person,
        "projects": projects or [],
    }


def _person_has_customer_data(row) -> bool:
    """True, sobald die Person irgendwelche Customer-Felder gesetzt hat."""
    if row is None:
        return False
    try:
        cats_raw = row["categories"]
    except (KeyError, IndexError):
        cats_raw = None
    if cats_raw:
        try:
            cats = json.loads(cats_raw)
            if isinstance(cats, list) and cats:
                return True
        except Exception:
            pass
    for k in ("customer_status", "pipeline_stream", "pipeline_stage",
              "workshop_kind", "lead_source", "rate_eur", "active_since",
              "last_invoice_ts", "customer_notes", "next_step_text",
              "next_step_due", "stage_progress", "source_campaign_id",
              "agent_name", "agent_system", "agent_model", "agent_status",
              "agent_workspace", "agent_notes"):
        try:
            v = row[k]
        except (KeyError, IndexError):
            continue
        if v not in (None, "", 0):
            return True
    try:
        if int(row["agent_enabled"] or 0) > 0:
            return True
    except (KeyError, IndexError, TypeError):
        pass
    try:
        if int(row["betreuung_done"] or 0) > 0:
            return True
    except (KeyError, IndexError, TypeError):
        pass
    return False


def _load_pt_index() -> tuple[dict[int, dict], dict[int, list[dict]], str]:
    """Liest lokale PT-Daten aus people.db.

    Liefert (customer_by_person_id, future_appointments_by_person_id, fetchedAt).
    `people.ptdesk_id` bleibt nur als Legacy-Anker erhalten, ist hier aber keine
    fachliche Grundlage mehr."""
    by_person_id: dict[int, dict] = {}
    future_by_person_id: dict[int, list[dict]] = {}
    today = datetime.now().strftime("%Y-%m-%d")
    fetched_at = datetime.now().isoformat()
    with _people_db() as con:
        from modules.pt.core import _pt_card_remaining
        rows = con.execute(
            """
            SELECT DISTINCT p.id, p.name
            FROM people p
            JOIN pt_appointments a ON a.person_id = p.id
            ORDER BY p.name COLLATE NOCASE
            """
        ).fetchall()
        for r in rows:
            person_id = int(r["id"])
            cards = con.execute(
                "SELECT * FROM pt_cards WHERE person_id = ? ORDER BY id ASC",
                (person_id,),
            ).fetchall()
            total = sum(int(c["total_sessions"] or 0) for c in cards)
            remaining = _pt_card_remaining(con, person_id) if cards else 0
            editable = next((c for c in cards if c["status"] == "active"), None) or (cards[-1] if cards else None)
            by_person_id[person_id] = {
                "id": str(person_id),
                "name": r["name"],
                "remainingSessions": remaining,
                "totalCardsPurchased": total,
                "hourlyRate": None,
                "paymentStatus": (editable["payment_status"] if editable else "pending"),
                "billingModel": "card_based" if cards else "",
                "trainingType": "personal_training",
                "isActive": bool(cards),
                "customerSince": (editable["start_date"] if editable else None),
                "notes": "",
            }
        appts = con.execute(
            """
            SELECT a.person_id, a.date, a.start_time, a.duration_min, a.training_type, a.status
            FROM pt_appointments a
            WHERE a.date >= ? AND a.status = 'scheduled'
            ORDER BY a.date, a.start_time
            """,
            (today,),
        ).fetchall()
        for a in appts:
            person_id = int(a["person_id"])
            iso = f"{a['date']}T{a['start_time']}:00"
            future_by_person_id.setdefault(person_id, []).append({
                "startIso": iso,
                "durationMin": a["duration_min"],
                "type": a["training_type"],
                "status": a["status"],
            })
    return by_person_id, future_by_person_id, fetched_at


def _compute_next_action(
    *,
    open_focus: list[dict],
    upcoming_events: list[dict],
    last_touch: Optional[dict],
    manual_next_step_text: Optional[str],
    manual_next_step_due: Optional[str],
    today_iso: str,
    now_ts: int,
) -> Optional[dict]:
    """Verdichtet aus offenen FOCUS-Items, Terminen und letztem Touch eine
    konkrete Empfehlung. Reihenfolge: überfällig → heute → bevorstehender Termin
    → kalter Kontakt → nächstes offenes Item."""
    next_text = (manual_next_step_text or "").strip()
    next_due = (manual_next_step_due or "").strip()
    if next_text:
        if next_due:
            if next_due < today_iso:
                return {
                    "kind": "manual_next_step_overdue",
                    "reason": f"fällig seit {next_due}",
                    "title": next_text,
                    "date": next_due,
                }
            if next_due == today_iso:
                return {
                    "kind": "manual_next_step_today",
                    "reason": "heute fällig",
                    "title": next_text,
                    "date": next_due,
                }
            return {
                "kind": "manual_next_step",
                "reason": f"fällig am {next_due}",
                "title": next_text,
                "date": next_due,
            }
        return {
            "kind": "manual_next_step",
            "reason": "manuell gesetzt",
            "title": next_text,
        }

    overdue = [f for f in open_focus if (f.get("date") or "") and f["date"] < today_iso]
    today_items = [f for f in open_focus if (f.get("date") or "") == today_iso]
    soon_event = upcoming_events[0] if upcoming_events else None

    if overdue:
        it = overdue[0]
        return {
            "kind": "overdue_focus",
            "reason": f"überfällig seit {it['date']}",
            "title": it["title"],
            "item_key": it.get("item_key"),
            "date": it.get("date"),
        }
    if today_items:
        it = today_items[0]
        return {
            "kind": "today_focus",
            "reason": "heute geplant",
            "title": it["title"],
            "item_key": it.get("item_key"),
            "date": it.get("date"),
        }
    if soon_event:
        return {
            "kind": "upcoming_event",
            "reason": f"Termin am {soon_event['start_iso'][:10]}",
            "title": soon_event["title"],
            "event_id": soon_event["id"],
            "date": soon_event["start_iso"][:10],
        }
    if last_touch:
        days = max(0, (now_ts - int(last_touch["ts"] or 0)) // 86400)
        if days >= 30:
            return {
                "kind": "cold_contact",
                "reason": f"letzter Kontakt vor {days} Tagen",
                "title": "Kurz melden, Status nachfragen",
                "days_since": days,
            }
    if open_focus:
        it = open_focus[0]
        return {
            "kind": "open_focus",
            "reason": "nächstes offenes Item",
            "title": it["title"],
            "item_key": it.get("item_key"),
            "date": it.get("date"),
        }
    return None


def _campaign_row(row) -> dict:
    if not row:
        return {}
    return {
        "id": row["id"],
        "name": row["name"],
        "stage": row["stage"] or "idee",
        "channel": row["channel"],
        "goal": row["goal"],
        "notes": row["notes"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


BUSINESS_RELATIONS = ("lead", "kontakt", "kunde")


def _build_business_overview(rows: list[sqlite3.Row]) -> dict:
    now_ts = int(time.time())
    today_iso = datetime.now().date().isoformat()
    cold_cutoff = now_ts - 30 * 86400
    pipeline_cutoff = now_ts - 14 * 86400

    pipeline_count = 0
    pipeline_stale = 0
    open_loops_count = 0
    open_loops_overdue = 0
    open_loops_today = 0
    relationship_only_count = 0
    relationship_only_cold = 0
    attention: list[dict] = []

    for row in rows:
        next_text = (row["next_step_text"] or "").strip()
        next_due = (row["next_step_due"] or "").strip()
        stage = (row["pipeline_stage"] or "").strip()
        last_ts = int(row["last_interaction_ts"] or 0)
        name = row["name"] or "—"
        company = row["company"] or None
        base = {
            "person_id": int(row["id"]),
            "name": name,
            "company": company,
            "relation": row["relation"] or "",
            "pipeline_stream": row["pipeline_stream"] or None,
            "pipeline_stage": row["pipeline_stage"] or None,
            "next_step_text": next_text or None,
            "next_step_due": next_due or None,
            "last_interaction_ts": last_ts or None,
        }

        if stage:
            pipeline_count += 1
            if last_ts <= 0 or last_ts < pipeline_cutoff:
                pipeline_stale += 1
                days = max(0, (now_ts - last_ts) // 86400) if last_ts else None
                reason = (
                    f"Pipeline, letzter Kontakt vor {days} Tagen"
                    if days is not None
                    else "Pipeline ohne letzten Kontakt"
                )
                attention.append({
                    **base,
                    "bucket": "pipeline",
                    "reason": reason,
                    "_prio": 3,
                    "_sort_due": "",
                    "_sort_ts": last_ts,
                })
            continue

        if next_text:
            open_loops_count += 1
            if next_due and next_due < today_iso:
                open_loops_overdue += 1
                reason = f"Überfällig seit {next_due}"
                prio = 0
            elif next_due and next_due == today_iso:
                open_loops_today += 1
                reason = "Heute fällig"
                prio = 1
            elif next_due:
                reason = f"Fällig am {next_due}"
                prio = 2
            else:
                reason = "Offene Schleife ohne Datum"
                prio = 4
            attention.append({
                **base,
                "bucket": "open_loop",
                "reason": reason,
                "_prio": prio,
                "_sort_due": next_due or "9999-12-31",
                "_sort_ts": last_ts,
            })
            continue

        relationship_only_count += 1
        if last_ts <= 0 or last_ts < cold_cutoff:
            relationship_only_cold += 1
            days = max(0, (now_ts - last_ts) // 86400) if last_ts else None
            reason = (
                f"Ohne offene Schleife, letzter Kontakt vor {days} Tagen"
                if days is not None
                else "Ohne offene Schleife und ohne Kontakthistorie"
            )
            attention.append({
                **base,
                "bucket": "relationship_only",
                "reason": reason,
                "_prio": 5,
                "_sort_due": "",
                "_sort_ts": last_ts,
            })

    attention.sort(
        key=lambda item: (
            item["_prio"],
            item["_sort_due"] or "9999-12-31",
            item["_sort_ts"] if item["_sort_ts"] > 0 else 0,
        )
    )
    for item in attention:
        item.pop("_prio", None)
        item.pop("_sort_due", None)
        item.pop("_sort_ts", None)

    return {
        "total": len(rows),
        "pipeline": {
            "count": pipeline_count,
            "stale_14d": pipeline_stale,
        },
        "open_loops": {
            "count": open_loops_count,
            "overdue": open_loops_overdue,
            "due_today": open_loops_today,
        },
        "relationship_only": {
            "count": relationship_only_count,
            "cold_30d": relationship_only_cold,
        },
        "attention": attention[:8],
    }


# ── Router ───────────────────────────────────────────────────────────────

router = APIRouter()


# ── People-Routen ────────────────────────────────────────────────────────

@router.get("/api/people/list")
async def people_list(
    limit: int = 500,
    role: str = "",
    relation: str = "",
    status: str = "",
    q: str = "",
):
    where = []
    params: list = []
    if role:
        where.append("role = ?")
        params.append(role)
    if relation:
        if relation == "unklassifiziert":
            where.append("(relation IS NULL OR relation = '')")
        else:
            where.append("relation = ?")
            params.append(relation)
    if status:
        where.append("status = ?")
        params.append(status)
    if q:
        where.append("(name LIKE ? OR company LIKE ? OR phone LIKE ? OR agent_name LIKE ? OR agent_model LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like, like, like, like])
    sql = "SELECT * FROM people"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY COALESCE(last_interaction_ts, updated_at) DESC LIMIT ?"
    params.append(limit)
    with _people_db() as con:
        rows = con.execute(sql, params).fetchall()
        relations = [
            {"value": r["relation"] or "unklassifiziert", "count": r["n"]}
            for r in con.execute(
                "SELECT COALESCE(NULLIF(relation,''),'unklassifiziert') AS relation, "
                "COUNT(*) AS n FROM people GROUP BY 1 ORDER BY n DESC"
            ).fetchall()
        ]
    return {
        "people": [_person_row_to_dict(r) for r in rows],
        "count": len(rows),
        "relations": relations,
        "relation_options": list(PEOPLE_RELATIONS),
    }


@router.post("/api/people/{person_id}/relation")
async def people_set_relation(person_id: int, req: Request):
    """Beziehungstyp einer Person setzen oder löschen (relation=null)."""
    body = await req.json()
    rel = body.get("relation")
    if rel is not None and rel != "" and rel not in PEOPLE_RELATIONS:
        return JSONResponse(
            {"error": f"relation must be one of {PEOPLE_RELATIONS} or null"},
            status_code=400,
        )
    now_ts = int(time.time())
    with _people_db() as con:
        row = con.execute("SELECT id FROM people WHERE id=?", (person_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "person not found"}, status_code=404)
        con.execute(
            "UPDATE people SET relation=?, updated_at=? WHERE id=?",
            (rel or None, now_ts, person_id),
        )
        con.commit()
        row = con.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
    return {"person": _person_row_to_dict(row)}


@router.get("/api/people/get")
async def people_get(id: int = 0, whatsapp_chat_id: str = "", phone: str = ""):
    with _people_db() as con:
        if id:
            row = con.execute("SELECT * FROM people WHERE id = ?", (id,)).fetchone()
        elif whatsapp_chat_id:
            row = con.execute("SELECT * FROM people WHERE whatsapp_chat_id = ?", (whatsapp_chat_id,)).fetchone()
        elif phone:
            row = con.execute("SELECT * FROM people WHERE phone = ?", (phone,)).fetchone()
        else:
            return JSONResponse({"error": "id, whatsapp_chat_id or phone required"}, status_code=400)
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        person = _person_row_to_dict(row)
        person_id = int(row["id"])

        identities = [dict(r) for r in con.execute(
            "SELECT id, kind, value, label, is_primary, source, created_at "
            "FROM person_identities WHERE person_id=? "
            "ORDER BY is_primary DESC, kind, id",
            (person_id,),
        ).fetchall()]

        agents = [_agent_row_to_dict(r) for r in con.execute(
            """
            SELECT pa.*,
                   (
                       SELECT e.summary
                         FROM person_agent_events e
                        WHERE e.agent_id = pa.id
                        ORDER BY e.created_at DESC, e.id DESC
                        LIMIT 1
                   ) AS last_activity_summary,
                   (
                       SELECT e.source
                         FROM person_agent_events e
                        WHERE e.agent_id = pa.id
                        ORDER BY e.created_at DESC, e.id DESC
                        LIMIT 1
                   ) AS last_activity_source,
                   (
                       SELECT e.created_at
                         FROM person_agent_events e
                        WHERE e.agent_id = pa.id
                        ORDER BY e.created_at DESC, e.id DESC
                        LIMIT 1
                   ) AS last_activity_ts
            FROM person_agents pa
            WHERE pa.person_id=?
            ORDER BY pa.is_primary DESC, pa.name COLLATE NOCASE
            """,
            (person_id,),
        ).fetchall()]

        customer = None
        if _person_has_customer_data(row):
            customer = _customer_row(row)
            customer.pop("person", None)

        pt_cards = [dict(r) for r in con.execute(
            "SELECT id, start_date, total_sessions, used_sessions, price_eur, "
            "payment_method, payment_status, status, notes "
            "FROM pt_cards WHERE person_id=? ORDER BY created_at DESC LIMIT 5",
            (person_id,),
        ).fetchall()]

        today_str = datetime.now().strftime("%Y-%m-%d")
        pt_upcoming = [dict(r) for r in con.execute(
            "SELECT id, date, start_time, duration_min, training_type, status, notes "
            "FROM pt_appointments WHERE person_id=? AND date>=? AND status!='cancelled' "
            "ORDER BY date ASC, start_time ASC LIMIT 10",
            (person_id, today_str),
        ).fetchall()]
        pt_recent = [dict(r) for r in con.execute(
            "SELECT id, date, start_time, duration_min, training_type, status, notes "
            "FROM pt_appointments WHERE person_id=? AND date<? "
            "ORDER BY date DESC, start_time DESC LIMIT 10",
            (person_id, today_str),
        ).fetchall()]

        projects = [dict(r) for r in con.execute(
            "SELECT pp.id, pp.project_id, pp.role, pp.source, pp.confidence, pp.notes AS pp_notes, "
            "p.slug, p.name, p.status AS project_status "
            "FROM person_projects pp LEFT JOIN projects p ON p.id = pp.project_id "
            "WHERE pp.person_id=? ORDER BY pp.created_at DESC",
            (person_id,),
        ).fetchall()]

    wa_contact = None
    wa_jid = whatsapp_chat_id or person.get("whatsapp_chat_id")
    if wa_jid and WHATSAPP_DB.exists():
        try:
            wcon = sqlite3.connect(WHATSAPP_DB)
            wcon.row_factory = sqlite3.Row
            r = wcon.execute(
                "SELECT phone, is_business, business_name, business_description, business_website, business_email, business_category, enriched_at FROM contacts WHERE jid=?",
                (wa_jid,),
            ).fetchone()
            wcon.close()
            if r:
                wa_contact = dict(r)
        except Exception:
            wa_contact = None

    return {
        "person": person,
        "wa_contact": wa_contact,
        "identities": identities,
        "agents": agents,
        "customer": customer,
        "pt_cards": pt_cards,
        "pt_upcoming": pt_upcoming,
        "pt_recent": pt_recent,
        "projects": projects,
    }


@router.post("/api/people/{person_id}/agents/{agent_id}/scope")
async def people_agent_scope_update(person_id: int, agent_id: int, req: Request):
    body = await req.json() or {}
    start_date = ((body.get("scope_start_date") or "").strip() or None)
    weeks_raw = body.get("scope_weeks")

    if start_date:
        try:
            start = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            return JSONResponse({"error": "scope_start_date must be YYYY-MM-DD"}, status_code=400)
    else:
        start = None

    try:
        weeks = int(weeks_raw if weeks_raw not in (None, "") else 4)
    except (TypeError, ValueError):
        return JSONResponse({"error": "scope_weeks must be integer"}, status_code=400)
    if weeks < 1 or weeks > 52:
        return JSONResponse({"error": "scope_weeks must be between 1 and 52"}, status_code=400)

    done_date = (start + timedelta(days=weeks * 7)).strftime("%Y-%m-%d") if start else None
    now_ts = int(time.time())

    with _people_db() as con:
        row = con.execute(
            "SELECT id, name FROM person_agents WHERE id=? AND person_id=?",
            (agent_id, person_id),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "agent not found"}, status_code=404)
        con.execute(
            """
            UPDATE person_agents
               SET scope_start_date=?, scope_weeks=?, scope_done_date=?, updated_at=?
             WHERE id=? AND person_id=?
            """,
            (start_date, weeks, done_date, now_ts, agent_id, person_id),
        )
        con.execute(
            """INSERT INTO person_agent_events
               (agent_id, person_id, source, event_type, summary, created_at)
               VALUES (?, ?, 'manual', 'scope_update', ?, ?)""",
            (agent_id, person_id, f"Scope gesetzt: {start_date or 'ohne Start'} · {weeks} Wochen", now_ts),
        )
        con.commit()
    return {
        "ok": True,
        "agent_id": agent_id,
        "person_id": person_id,
        "scope_start_date": start_date,
        "scope_weeks": weeks,
        "scope_done_date": done_date,
    }


@router.get("/api/people/{person_id}/timeline")
async def people_timeline(person_id: int, limit: int = 100):
    """Alle Berührungspunkte einer Person: mentions (chat/wa/email/doc) + PT-Termine + Kalender."""
    if person_id <= 0:
        return JSONResponse({"error": "id required"}, status_code=400)
    from backend import entities as _ent
    with _people_db() as con:
        row = con.execute("SELECT id, name FROM people WHERE id = ?", (person_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "person not found"}, status_code=404)
        items: list[dict] = []
        mentions = con.execute(
            "SELECT source_kind, source_id, snippet, ts FROM mentions "
            "WHERE entity_type='person' AND entity_id=? ORDER BY ts DESC LIMIT ?",
            (person_id, max(limit, 50)),
        ).fetchall()
        for m in mentions:
            items.append({
                "kind": m["source_kind"],
                "source_id": m["source_id"],
                "snippet": m["snippet"] or "",
                "ts": m["ts"],
            })
        pt = con.execute(
            "SELECT id, date, start_time, training_type, status FROM pt_appointments "
            "WHERE person_id=? ORDER BY date DESC, start_time DESC LIMIT 30",
            (person_id,),
        ).fetchall()
        for a in pt:
            try:
                import datetime as _dt
                dt = _dt.datetime.fromisoformat(f"{a['date']}T{a['start_time']}:00")
                ts = int(dt.timestamp())
            except Exception:
                ts = 0
            items.append({
                "kind": "pt_appointment",
                "source_id": f"pt:{a['id']}",
                "snippet": f"PT {a['training_type']} ({a['status']})",
                "ts": ts,
            })
        identities = _ent.list_identities(person_id)
    items.sort(key=lambda x: x.get("ts") or 0, reverse=True)
    items = items[:limit]
    counts: dict[str, int] = {}
    for it in items:
        counts[it["kind"]] = counts.get(it["kind"], 0) + 1
    return {
        "person": {"id": row["id"], "name": row["name"]},
        "identities": identities,
        "items": items,
        "counts": counts,
        "total": len(items),
    }


@router.get("/api/people/{person_id}/crm-status")
async def people_crm_status(person_id: int):
    """Verdichtete CRM-Sicht: Live-Status, offene Fokus-Items, anstehende Termine,
    letzte Touchpoints. Eine einzige Anfrage für die Person-Karte."""
    if person_id <= 0:
        return JSONResponse({"error": "id required"}, status_code=400)
    import datetime as _dt
    now_ts = int(time.time())
    today_iso = _dt.date.today().isoformat()

    with _people_db() as con:
        row = con.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "person not found"}, status_code=404)
        person = _person_row_to_dict(row)
        next_step_text = (row["next_step_text"] or "").strip()
        next_step_due = (row["next_step_due"] or "").strip()

        last = con.execute(
            "SELECT source_kind, source_id, snippet, ts FROM mentions "
            "WHERE entity_type='person' AND entity_id=? AND source_kind IN "
            "('whatsapp','email','calendar') ORDER BY ts DESC LIMIT 1",
            (person_id,),
        ).fetchone()
        last_touch = dict(last) if last else None

        cutoff_30d = now_ts - 30 * 86400
        touches_30d = con.execute(
            "SELECT COUNT(*) FROM mentions WHERE entity_type='person' AND entity_id=? "
            "AND source_kind IN ('whatsapp','email','calendar') AND ts >= ?",
            (person_id, cutoff_30d),
        ).fetchone()[0] or 0
        channels_rows = con.execute(
            "SELECT DISTINCT source_kind FROM mentions WHERE entity_type='person' AND entity_id=? "
            "AND source_kind IN ('whatsapp','email','calendar') AND ts >= ?",
            (person_id, cutoff_30d),
        ).fetchall()
        channels = [r["source_kind"] for r in channels_rows]

        focus_rows = con.execute(
            "SELECT source_id, snippet, ts FROM mentions "
            "WHERE entity_type='person' AND entity_id=? AND source_kind='focus' "
            "ORDER BY ts DESC",
            (person_id,),
        ).fetchall()
        focus_keys = {r["source_id"]: r for r in focus_rows}

        cal_rows = con.execute(
            "SELECT source_id, snippet FROM mentions "
            "WHERE entity_type='person' AND entity_id=? AND source_kind='calendar'",
            (person_id,),
        ).fetchall()
        cal_ids = {r["source_id"] for r in cal_rows}

        timeline_rows = con.execute(
            "SELECT source_kind, source_id, snippet, ts FROM mentions "
            "WHERE entity_type='person' AND entity_id=? "
            "  AND source_kind IN ('whatsapp','email','calendar') "
            "ORDER BY ts DESC LIMIT 30",
            (person_id,),
        ).fetchall()
        recent_timeline = [dict(r) for r in timeline_rows]

    open_focus: list[dict] = []
    from modules.fokus.core import _focus_list_items
    if focus_keys:
        try:
            items = _focus_list_items(include_done=False, business_only=False)
            for it in items:
                key = it.get("item_key") or ""
                if key in focus_keys:
                    open_focus.append({
                        "title": it.get("title"),
                        "bucket": it.get("bucket"),
                        "date": it.get("date"),
                        "item_key": key,
                    })
            open_focus.sort(key=lambda x: (x.get("date") or "9999", x.get("title") or ""))
        except Exception:
            pass

    upcoming_events: list[dict] = []
    if cal_ids:
        try:
            from db import DB_PATH as _CHAT_DB
            with sqlite3.connect(_CHAT_DB) as _c:
                _c.row_factory = sqlite3.Row
                placeholders = ",".join("?" * len(cal_ids))
                rows = _c.execute(
                    f"SELECT id, start_iso, duration_min, title, category, gcal_event_id "
                    f"FROM calendar_events WHERE id IN ({placeholders}) OR gcal_event_id IN ({placeholders})",
                    (*cal_ids, *cal_ids),
                ).fetchall()
                for r in rows:
                    start_iso = r["start_iso"] or ""
                    if start_iso[:10] < today_iso:
                        continue
                    upcoming_events.append({
                        "id": r["id"],
                        "start_iso": start_iso,
                        "duration_min": r["duration_min"],
                        "title": r["title"],
                        "category": r["category"],
                    })
            upcoming_events.sort(key=lambda e: e.get("start_iso") or "")
            upcoming_events = upcoming_events[:5]
        except Exception:
            pass

    last_touch_out = None
    if last_touch:
        diff = now_ts - int(last_touch["ts"] or 0)
        if diff < 60:
            ago = "gerade eben"
        elif diff < 3600:
            ago = f"vor {diff // 60} Min."
        elif diff < 86400:
            ago = f"vor {diff // 3600} Std."
        elif diff < 86400 * 14:
            d = diff // 86400
            ago = "gestern" if d == 1 else f"vor {d} Tagen"
        elif diff < 86400 * 60:
            ago = f"vor {diff // (86400 * 7)} Wochen"
        else:
            ago = f"vor {diff // (86400 * 30)} Monaten"
        last_touch_out = {
            "kind": last_touch["source_kind"],
            "snippet": last_touch["snippet"] or "",
            "ts": last_touch["ts"],
            "ago_human": ago,
        }

    next_action = _compute_next_action(
        open_focus=open_focus,
        upcoming_events=upcoming_events,
        last_touch=last_touch,
        manual_next_step_text=next_step_text,
        manual_next_step_due=next_step_due,
        today_iso=today_iso,
        now_ts=now_ts,
    )

    return {
        "person": {
            "id": person["id"],
            "name": person["name"],
            "role": person.get("role"),
            "company": person.get("company"),
            "email": person.get("email"),
            "phone": person.get("phone"),
            "next_step_text": next_step_text or None,
            "next_step_due": next_step_due or None,
        },
        "last_touch": last_touch_out,
        "open_focus": open_focus,
        "upcoming_events": upcoming_events,
        "recent_timeline": recent_timeline,
        "manual_next_step": {
            "title": next_step_text,
            "due": next_step_due or None,
        } if next_step_text else None,
        "next_action": next_action,
        "stats": {
            "touches_30d": touches_30d,
            "channels": channels,
        },
    }


@router.get("/api/people/{person_id}/identities")
async def people_identities(person_id: int):
    from backend import entities as _ent
    return {"identities": _ent.list_identities(person_id)}


@router.post("/api/people/{person_id}/identities")
async def people_identities_add(person_id: int, req: Request):
    from backend import entities as _ent
    body = await req.json()
    kind = (body or {}).get("kind", "").strip().lower()
    value = (body or {}).get("value", "").strip()
    label = (body or {}).get("label") or None
    is_primary = bool((body or {}).get("is_primary"))
    if not kind or not value:
        return JSONResponse({"error": "kind+value required"}, status_code=400)
    new_id = _ent.add_identity(person_id, kind, value, label, is_primary, source="manual")
    if new_id is None:
        return JSONResponse({"error": "identity already exists or invalid value"}, status_code=409)
    return {"id": new_id, "identities": _ent.list_identities(person_id)}


@router.post("/api/people/upsert")
async def people_upsert(req: Request):
    body = await req.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "object required"}, status_code=400)
    pid = body.get("id")
    name = (body.get("name") or "").strip()
    now_ts = int(time.time())

    data = {}
    for f in PEOPLE_FIELDS:
        if f in body:
            v = body[f]
            if f == "tags" and isinstance(v, (list, tuple)):
                v = json.dumps(list(v), ensure_ascii=False)
            if f == "relation":
                if v not in (None, "") and v not in PEOPLE_RELATIONS:
                    return JSONResponse(
                        {"error": f"relation must be one of {PEOPLE_RELATIONS} or null"},
                        status_code=400,
                    )
                v = v or None
            if f == "agent_enabled":
                v = 1 if bool(v) else 0
            if f == "agent_system":
                if v not in (None, "") and v not in AGENT_SYSTEMS:
                    return JSONResponse(
                        {"error": f"agent_system must be one of {AGENT_SYSTEMS} or null"},
                        status_code=400,
                    )
                v = v or None
            data[f] = v

    with _people_db() as con:
        if pid:
            existing = con.execute("SELECT id FROM people WHERE id = ?", (pid,)).fetchone()
            if not existing:
                return JSONResponse({"error": "not found"}, status_code=404)
            if not data:
                return {"person": _person_row_to_dict(con.execute("SELECT * FROM people WHERE id = ?", (pid,)).fetchone())}
            sets = ", ".join([f"{k} = ?" for k in data.keys()] + ["updated_at = ?"])
            con.execute(f"UPDATE people SET {sets} WHERE id = ?",
                        (*data.values(), now_ts, pid))
            con.commit()
            row = con.execute("SELECT * FROM people WHERE id = ?", (pid,)).fetchone()
            return {"person": _person_row_to_dict(row), "created": False}

        if not name:
            return JSONResponse({"error": "name required on create"}, status_code=400)
        data["name"] = name
        cols = list(data.keys()) + ["created_at", "updated_at"]
        placeholders = ", ".join(["?"] * len(cols))
        values = list(data.values()) + [now_ts, now_ts]
        cur = con.execute(f"INSERT INTO people ({', '.join(cols)}) VALUES ({placeholders})", values)
        con.commit()
        row = con.execute("SELECT * FROM people WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"person": _person_row_to_dict(row), "created": True}


@router.post("/api/people/delete")
async def people_delete(req: Request):
    body = await req.json()
    pid = (body or {}).get("id")
    if not pid:
        return JSONResponse({"error": "id required"}, status_code=400)
    with _people_db() as con:
        con.execute("DELETE FROM people WHERE id = ?", (pid,))
        con.commit()
    return {"ok": True}


# ── Customer-Routen ──────────────────────────────────────────────────────

def _build_real_contact_index(person_ids: list[int]) -> dict[int, dict]:
    """Pro person_id: letzter echter Touch (WA/Mail) mit Richtung.

    Richtung-Heuristik:
    - WA: source_id beginnt mit `true_` → ausgehend, `false_` → eingehend
    - Mail: snippet beginnt mit `→` → ausgehend, sonst eingehend
    Zukünftige Timestamps (z.B. Kalender) sind hier eh schon ausgefiltert
    durch den source_kind-Filter.
    """
    if not person_ids:
        return {}
    placeholders = ",".join("?" for _ in person_ids)
    sources = list(REAL_CONTACT_SOURCES)
    src_placeholders = ",".join("?" for _ in sources)
    now_ts = int(time.time())
    out: dict[int, dict] = {}
    with _people_db() as con:
        rows = con.execute(
            f"SELECT entity_id, ts, source_kind, source_id, snippet "
            f"FROM mentions "
            f"WHERE entity_type='person' "
            f"  AND entity_id IN ({placeholders}) "
            f"  AND source_kind IN ({src_placeholders}) "
            f"  AND ts <= ? "
            f"ORDER BY ts DESC",
            (*person_ids, *sources, now_ts),
        ).fetchall()
    for r in rows:
        pid = int(r["entity_id"])
        if pid in out:
            continue
        sk = r["source_kind"]
        sid = r["source_id"] or ""
        snip = r["snippet"] or ""
        if sk == "whatsapp":
            direction = "out" if sid.startswith("true_") else "in"
        elif sk == "email":
            direction = "out" if snip.startswith("→") else "in"
        else:
            direction = "in"
        out[pid] = {
            "ts": int(r["ts"]),
            "dir": direction,
            "kind": sk,
        }
    return out


@router.get("/api/customers")
async def customers_list():
    """Alle Kunden gruppiert nach Kategorie. Im Agent-Ordner zusätzlich nach Firma.
    Personal-Training-Kunden werden aus der lokalen PT-DB angereichert."""
    with _people_db() as con:
        # Customer = jede Person mit gesetzten categories oder pipeline_stream.
        # Reine Stammkontakte ohne Customer-Daten landen im "Alle"-Ordner.
        rows = con.execute(
            """
            SELECT *
             FROM people
             WHERE (categories IS NOT NULL AND categories != '' AND categories != '[]')
                OR pipeline_stream IS NOT NULL
                OR agent_enabled = 1
                OR (agent_name IS NOT NULL AND agent_name != '')
                OR id IN (SELECT person_id FROM person_pipeline_memberships)
             ORDER BY name COLLATE NOCASE
            """
        ).fetchall()
        people_by_id: dict[int, object] = {r["id"]: r for r in rows}
        projects_by_pid: dict[int, list[dict]] = {}
        for r in rows:
            pid = r["id"]
            proj_rows = con.execute(
                """
                SELECT pj.slug, pj.name, pp.role
                FROM person_projects pp
                JOIN projects pj ON pj.id = pp.project_id
                WHERE pp.person_id = ?
                ORDER BY pj.slug
                """,
                (pid,),
            ).fetchall()
            projects_by_pid[pid] = [
                {"slug": pr["slug"], "name": pr["name"], "role": pr["role"]} for pr in proj_rows
            ]
        business_rows = con.execute(
            """
            SELECT *
              FROM people
             WHERE relation IN ('lead', 'kontakt', 'kunde')
             ORDER BY COALESCE(last_interaction_ts, updated_at) DESC
            """
        ).fetchall()

    customers = [
        _customer_row(r, projects_by_pid.get(r["id"]))
        for r in rows
    ]
    business_overview = _build_business_overview(business_rows)

    pt_by_person_id, future_by_person_id, pt_fetched_at = _load_pt_index()
    for c in customers:
        if "personal-training" not in c["categories"]:
            continue
        person_id = int(c["person_id"])
        snap = pt_by_person_id.get(person_id)
        if not snap:
            continue
        next_appts = future_by_person_id.get(person_id) or []
        next_iso = next_appts[0]["startIso"] if next_appts else None
        pt_info = {
            "id": str(person_id),
            "billingModel": snap.get("billingModel"),
            "trainingType": snap.get("trainingType"),
            "hourlyRate": snap.get("hourlyRate"),
            "remainingSessions": snap.get("remainingSessions"),
            "totalCardsPurchased": snap.get("totalCardsPurchased"),
            "paymentStatus": snap.get("paymentStatus"),
            "isActive": snap.get("isActive"),
            "customerSince": snap.get("customerSince"),
            "nextAppointment": next_iso,
            "futureCount": len(next_appts),
            "snapshotAt": pt_fetched_at,
        }
        c["pt"] = pt_info
        c["ptdesk"] = pt_info

    by_category = {cat: [] for cat in CUSTOMER_CATEGORIES}
    for c in customers:
        for cat in c["categories"]:
            if cat in by_category:
                by_category[cat].append(c)

    def _build_firms(agent_customers: list[dict]) -> list[dict]:
        firms: dict[str, dict] = {}
        for c in agent_customers:
            cluster = None
            label = None
            primary_slug = None
            for proj in c.get("projects") or []:
                slug = proj.get("slug")
                if slug in _AGENT_FIRM_CLUSTER:
                    cluster = _AGENT_FIRM_CLUSTER[slug]
                    label = _AGENT_FIRM_LABELS[slug]
                    primary_slug = slug
                    break
            if not cluster:
                cluster = "sonstige"
                label = "Einzelaufträge"
            firm = firms.get(cluster)
            if not firm:
                firm = {"id": cluster, "label": label, "primary_slug": primary_slug, "people": []}
                firms[cluster] = firm
            role = None
            for proj in c.get("projects") or []:
                if _AGENT_FIRM_CLUSTER.get(proj.get("slug") or "") == cluster:
                    role = proj.get("role")
                    break
            firm["people"].append({**c, "firm_role": role})

        for firm in firms.values():
            firm["people"].sort(
                key=lambda p: (
                    _ROLE_RANK.get(p.get("firm_role") or "", 9),
                    (p.get("person") or {}).get("name") or "",
                )
            )
            firm["count"] = len(firm["people"])
            firm["leads"] = [
                (p.get("person") or {}).get("name")
                for p in firm["people"]
                if (p.get("firm_role") or "") in ("GF", "Praxis-Inhaber")
            ]
        return sorted(
            firms.values(),
            key=lambda f: (1 if f["id"] == "sonstige" else 0, -f["count"], f["label"]),
        )

    folders = []
    for cat in CUSTOMER_CATEGORIES:
        folder = {
            "id": cat,
            "label": CATEGORY_LABELS[cat],
            "count": len(by_category[cat]),
            "customers": by_category[cat],
        }
        if cat == "agent":
            folder["firms"] = _build_firms(by_category[cat])
        folders.append(folder)

    # "Leads" — alle Personen mit relation='lead', unabhängig von categories.
    customer_by_pid = {c["person_id"]: c for c in customers}
    with _people_db() as _con_leads:
        _lead_rows = _con_leads.execute(
            "SELECT * FROM people WHERE relation = 'lead' "
            "ORDER BY COALESCE(last_interaction_ts, updated_at) DESC"
        ).fetchall()
    lead_entries: list[dict] = []
    for lr in _lead_rows:
        existing = customer_by_pid.get(lr["id"])
        if existing:
            lead_entries.append(existing)
            continue
        person = _person_row_to_dict(lr)
        lead_entries.append({
            "id": -lr["id"],
            "person_id": lr["id"],
            "categories": [],
            "status": "lead",
            "rate_eur": None,
            "active_since": None,
            "last_invoice_ts": None,
            "last_interaction_ts": person.get("last_interaction_ts"),
            "notes": None,
            "person": person,
            "projects": [],
        })
    folders.append({
        "id": "leads",
        "label": "Leads",
        "count": len(lead_entries),
        "customers": lead_entries,
    })

    # "Alle" — vollstaendige Sicht auf people.db. Personen ohne Customer-Daten
    # bekommen einen schlanken Wrapper, damit Frontend dieselbe Row rendern kann.
    customer_pids = {c["person_id"] for c in customers}
    with _people_db() as _con_all:
        _all_people_rows = _con_all.execute(
            "SELECT * FROM people ORDER BY COALESCE(last_interaction_ts, updated_at) DESC"
        ).fetchall()
    all_entries: list[dict] = list(customers)
    for pr in _all_people_rows:
        if pr["id"] in customer_pids:
            continue
        person = _person_row_to_dict(pr)
        all_entries.append({
            "id": -pr["id"],
            "person_id": pr["id"],
            "categories": [],
            "status": (person.get("relation") or "person"),
            "rate_eur": None,
            "active_since": None,
            "last_invoice_ts": None,
            "last_interaction_ts": person.get("last_interaction_ts"),
            "notes": None,
            "person": person,
            "projects": [],
        })
    all_entries.sort(key=lambda c: (c.get("last_interaction_ts") or 0), reverse=True)
    folders.append({
        "id": "alle",
        "label": "Alle",
        "count": len(all_entries),
        "customers": all_entries,
    })

    def _cluster_key(c: dict) -> tuple[str | None, str | None]:
        person = c.get("person") or {}
        cl = (person.get("company_cluster") or "").strip()
        if cl:
            label = _AGENT_FIRM_LABELS.get(cl) or person.get("company") or cl
            return cl, label
        for proj in c.get("projects") or []:
            slug = proj.get("slug")
            if slug in _AGENT_FIRM_CLUSTER:
                return _AGENT_FIRM_CLUSTER[slug], _AGENT_FIRM_LABELS[slug]
        return None, None

    def _build_cards(in_stage: list[dict], stream_id: str) -> list[dict]:
        cards: list[dict] = []
        firms: dict[str, dict] = {}
        loners: list[dict] = []
        for c in in_stage:
            cluster, label = _cluster_key(c)
            if not cluster:
                loners.append(c)
                continue
            firm = firms.get(cluster)
            if not firm:
                firm = {"cluster": cluster, "label": label, "members": []}
                firms[cluster] = firm
            role = None
            for proj in c.get("projects") or []:
                if _AGENT_FIRM_CLUSTER.get(proj.get("slug") or "") == cluster:
                    role = proj.get("role")
                    break
            firm["members"].append({**c, "firm_role": role})

        for firm in firms.values():
            firm["members"].sort(
                key=lambda p: (
                    _ROLE_RANK.get(p.get("firm_role") or "", 9),
                    (p.get("person") or {}).get("name") or "",
                )
            )
            primary = firm["members"][0]
            firm_last_ts = max(
                (m.get("last_interaction_ts") or 0) for m in firm["members"]
            ) or None
            firm_betreuung = max((int(m.get("betreuung_done") or 0) for m in firm["members"]), default=0)
            firm_progress: dict[str, bool] = {}
            for m in firm["members"]:
                for k, v in (m.get("stage_progress") or {}).items():
                    if v:
                        firm_progress[k] = True
            cards.append({
                "kind": "firm",
                "id": f"firm:{firm['cluster']}",
                "label": firm["label"],
                "subtitle": (primary.get("person") or {}).get("name") if primary else None,
                "person_ids": [m["person_id"] for m in firm["members"]],
                "members": firm["members"],
                "workshop_kind": None,
                "lead_source": None,
                "value_eur": sum(int(m.get("value_eur") or 0) for m in firm["members"]),
                "next_step_text": (primary.get("next_step_text") or "").strip() or None if primary else None,
                "betreuung_done": firm_betreuung,
                "stage_progress": firm_progress,
                "last_interaction_ts": firm_last_ts,
            })
        for c in loners:
            _p = c.get("person") or {}
            _p_name = _p.get("name") or "—"
            _p_company = (_p.get("company") or "").strip() or None
            cards.append({
                "kind": "person",
                "id": f"p:{c['person_id']}",
                # Einheitlich: Firma führt oben, Ansprechpartner klein drunter.
                # Nur echte Privatkunden ohne Firma behalten den Namen oben.
                "label": _p_company or _p_name,
                "subtitle": _p_name if _p_company else None,
                "person_ids": [c["person_id"]],
                "members": [c],
                "workshop_kind": c.get("workshop_kind"),
                "lead_source": c.get("lead_source"),
                "value_eur": int(c.get("value_eur") or 0),
                "next_step_text": (c.get("next_step_text") or "").strip() or None,
                "betreuung_done": int(c.get("betreuung_done") or 0),
                "stage_progress": c.get("stage_progress") or {},
                "last_interaction_ts": c.get("last_interaction_ts"),
            })
        cards.sort(key=lambda x: -(x.get("last_interaction_ts") or 0))
        return cards

    # Memberships laden: (stream, stage) -> person_ids, plus customer fallback
    # auf people.pipeline_stream falls noch keine Membership existiert.
    memberships_by_stream_stage: dict[tuple[str, str], set[int]] = {}
    membership_state: dict[tuple[str, int], dict] = {}
    # Abgelegte Karten (status='lost'): pro Stream pid -> {reason, lost_at}. Sie
    # erscheinen nicht in den aktiven Lanes, sondern als eigene "Abgelegt"-Spur.
    lost_by_stream: dict[str, dict[int, dict]] = {}
    try:
        with _people_db() as _mcon:
            for mrow in _mcon.execute(
                "SELECT person_id, stream, stage, stage_progress, next_step_text, next_step_due, notes, "
                "       status, lost_reason, lost_at "
                "FROM person_pipeline_memberships"
            ).fetchall():
                pid_int = int(mrow["person_id"])
                stream_id = mrow["stream"]
                mcols = mrow.keys()
                status = (mrow["status"] if "status" in mcols else None) or None
                if status == "lost":
                    lost_by_stream.setdefault(stream_id, {})[pid_int] = {
                        "reason": (mrow["lost_reason"] if "lost_reason" in mcols else None) or None,
                        "lost_at": (mrow["lost_at"] if "lost_at" in mcols else None) or None,
                    }
                    continue
                key = (stream_id, mrow["stage"])
                memberships_by_stream_stage.setdefault(key, set()).add(pid_int)
                try:
                    sp = json.loads(mrow["stage_progress"]) if mrow["stage_progress"] else {}
                    if not isinstance(sp, dict):
                        sp = {}
                except Exception:
                    sp = {}
                membership_state[(stream_id, pid_int)] = {
                    "stage_progress": sp,
                    "next_step_text": (mrow["next_step_text"] or "").strip() or None,
                    "next_step_due": (mrow["next_step_due"] or "").strip() or None,
                    "notes": (mrow["notes"] or "").strip() or None,
                }
    except Exception:
        memberships_by_stream_stage = {}
        membership_state = {}
        lost_by_stream = {}

    customer_by_pid_lookup = {c["person_id"]: c for c in customers}

    # Offers pro Person laden, neuester Eintrag gewinnt fuer Card-Badge
    offers_by_pid: dict[int, dict] = {}
    try:
        with _people_db() as _ocon:
            for orow in _ocon.execute(
                "SELECT * FROM offers WHERE person_id IS NOT NULL "
                "ORDER BY COALESCE(sent_at, created_at) DESC"
            ).fetchall():
                pid = int(orow["person_id"])
                if pid not in offers_by_pid:
	                    offers_by_pid[pid] = {
	                        "token": orow["token"],
	                        "slug": orow["slug"],
	                        "package": orow["package"],
	                        "status": orow["status"],
	                        "sent_at": orow["sent_at"],
	                        "opened_count": orow["opened_count"],
                        "last_opened_at": orow["last_opened_at"],
                        "accepted_at": orow["accepted_at"],
                        "amount_eur": orow["amount_eur"],
                        "url": orow["url"],
                    }
    except Exception:
        offers_by_pid = {}

    # Echter-Kontakt-Index pro person_id (WA/Mail mit Richtung). Wird auf
    # Karten gehoben, damit FE "Ball bei dir / bei ihm" rendern kann.
    all_member_pids = sorted({c["person_id"] for c in customers if c.get("person_id")})
    real_contact_by_pid = _build_real_contact_index(all_member_pids)

    now_ts_meta = int(time.time())
    fresh_cutoff = now_ts_meta - END_STAGE_FRESH_DAYS * 86400
    pipeline = []
    for stream_id in PIPELINE_STREAMS:
        stages = []
        end_set = END_STAGES.get(stream_id, set())
        attention_map = STAGE_ATTENTION_DAYS.get(stream_id, {})
        prob_map = STAGE_PROBABILITY.get(stream_id, {})
        for stage_id, stage_label in PIPELINE_STAGES[stream_id]:
            pids = set(memberships_by_stream_stage.get((stream_id, stage_id), set()))
            in_stage: list[dict] = []
            for pid in pids:
                c = customer_by_pid_lookup.get(pid)
                if not c:
                    continue
                ms = membership_state.get((stream_id, int(pid)))
                if ms:
                    c = dict(c)
                    if ms.get("stage_progress"):
                        c["stage_progress"] = ms["stage_progress"]
                    if ms.get("next_step_text") is not None:
                        c["next_step_text"] = ms["next_step_text"]
                    if ms.get("next_step_due") is not None:
                        c["next_step_due"] = ms["next_step_due"]
                    if ms.get("notes") is not None:
                        c["membership_notes"] = ms["notes"]
                    ns = c.get("next_step") or {}
                    if ms.get("next_step_text") or ms.get("next_step_due"):
                        c["next_step"] = {
                            "title": ms.get("next_step_text") or (ns.get("title") if isinstance(ns, dict) else None),
                            "due": ms.get("next_step_due") or (ns.get("due") if isinstance(ns, dict) else None),
                        }
                in_stage.append(c)
            cards = _build_cards(in_stage, stream_id)
            # Offer-Badge pro Card anhaengen (neuestes offer aller members)
            for card in cards:
                best: dict | None = None
                for pid in card.get("person_ids") or []:
                    o = offers_by_pid.get(int(pid))
                    if not o:
                        continue
                    if best is None or (o.get("sent_at") or 0) > (best.get("sent_at") or 0):
                        best = o
                if best:
                    card["offer"] = best
            terminal = stage_id in end_set
            attention_days_limit = attention_map.get(stage_id) if not terminal else None
            for card in cards:
                # Beste echte Berührung über alle Members wählen
                best_rc: dict | None = None
                for pid in card.get("person_ids") or []:
                    rc = real_contact_by_pid.get(int(pid))
                    if not rc:
                        continue
                    if best_rc is None or rc["ts"] > best_rc["ts"]:
                        best_rc = rc
                if best_rc:
                    card["last_real_contact_ts"] = best_rc["ts"]
                    card["last_real_contact_dir"] = best_rc["dir"]
                    card["last_real_contact_kind"] = best_rc["kind"]
                else:
                    card["last_real_contact_ts"] = None
                    card["last_real_contact_dir"] = None
                    card["last_real_contact_kind"] = None
                # Ball-bei-dir-Logik
                ball = "idle"
                days_since = None
                attention = False
                if not terminal:
                    if best_rc:
                        # Antwort vom Kunden = Ball bei dir
                        ball = "me" if best_rc["dir"] == "in" else "them"
                        days_since = max(0, (now_ts_meta - best_rc["ts"]) // 86400)
                    else:
                        # Karte ohne jeden echten Touch in aktiver Stage → du dran
                        ball = "me"
                    if (
                        ball == "me"
                        and attention_days_limit is not None
                        and days_since is not None
                        and days_since >= attention_days_limit
                    ):
                        attention = True
                    elif ball == "me" and best_rc is None and attention_days_limit is not None:
                        # Kein echter Kontakt überhaupt: nach Limit warnen
                        attention = True
                card["ball"] = ball
                card["days_since_real_contact"] = (
                    int(days_since) if days_since is not None else None
                )
                card["attention"] = attention
                card["attention_days_limit"] = attention_days_limit
                # Aktive Karte ohne nächsten Schritt verrottet still — sichtbar machen.
                card["missing_next_step"] = (
                    not terminal and not (card.get("next_step_text") or "").strip()
                )
            if terminal:
                fresh_count = 0
                for card in cards:
                    last_ts = card.get("last_interaction_ts") or 0
                    is_archived = last_ts > 0 and last_ts < fresh_cutoff
                    card["archived"] = is_archived
                    card["terminal"] = True
                    if not is_archived:
                        fresh_count += 1
            else:
                fresh_count = len(cards)
            stage_value = sum(int(card.get("value_eur") or 0) for card in cards)
            stage_prob = prob_map.get(stage_id, 0)
            stages.append({
                "id": stage_id,
                "label": stage_label,
                "count": len(cards),
                "fresh_count": fresh_count,
                "terminal": terminal,
                "value_eur": stage_value,
                "probability": stage_prob,
                "forecast_eur": round(stage_value * stage_prob / 100),
                "cards": cards,
            })
        # Abgelegt-Spur: verlorene Karten dieses Streams mit Grund, separat von
        # den aktiven Lanes. Nur befüllt, wenn es welche gibt (bleibt sonst still).
        dropped_cards: list[dict] = []
        lost_pids = lost_by_stream.get(stream_id, {})
        if lost_pids:
            in_dropped = [
                customer_by_pid_lookup[pid]
                for pid in lost_pids
                if pid in customer_by_pid_lookup
            ]
            for card in _build_cards(in_dropped, stream_id):
                pid0 = (card.get("person_ids") or [None])[0]
                info = lost_pids.get(pid0) or {}
                reason = info.get("reason")
                card["lost"] = True
                card["lost_reason"] = reason
                card["lost_reason_label"] = LOST_REASONS.get(reason, "Abgelegt")
                card["lost_at"] = info.get("lost_at")
                dropped_cards.append(card)
            dropped_cards.sort(key=lambda c: -(c.get("lost_at") or 0))
        # Forecast nur aus aktiven (nicht-terminalen) Stages: abgeschlossene
        # Karten sind kein offener Umsatz mehr.
        active_stages = [s for s in stages if not s["terminal"]]
        pipeline.append({
            "id": stream_id,
            "label": PIPELINE_STREAM_LABELS[stream_id],
            "stages": stages,
            "count": sum(s["count"] for s in stages),
            "value_eur": sum(s["value_eur"] for s in active_stages),
            "forecast_eur": sum(s["forecast_eur"] for s in active_stages),
            "dropped": dropped_cards,
        })

    return {
        "folders": folders,
        "all": customers,
        "total": len(customers),
        "pipeline": pipeline,
        "business_overview": business_overview,
        "pipeline_meta": {
            "streams": [{"id": s, "label": PIPELINE_STREAM_LABELS[s]} for s in PIPELINE_STREAMS],
            "stages": {s: [{"id": sid, "label": lbl, "terminal": sid in END_STAGES.get(s, set())} for sid, lbl in PIPELINE_STAGES[s]] for s in PIPELINE_STREAMS},
            "end_stages": {s: sorted(END_STAGES.get(s, set())) for s in PIPELINE_STREAMS},
            "end_stage_fresh_days": END_STAGE_FRESH_DAYS,
            "stage_attention_days": {
                s: dict(STAGE_ATTENTION_DAYS.get(s, {})) for s in PIPELINE_STREAMS
            },
            "stage_probability": {
                s: dict(STAGE_PROBABILITY.get(s, {})) for s in PIPELINE_STREAMS
            },
            "workshop_kinds": list(WORKSHOP_KINDS),
            "lead_sources": list(LEAD_SOURCES),
            "lead_source_labels": dict(LEAD_SOURCE_LABELS),
            "betreuung_total": 4,
            "stage_checklists": {
                stream: {
                    stage: [{"key": k, "label": lbl} for k, lbl in items]
                    for stage, items in stages.items()
                }
                for stream, stages in STAGE_CHECKLISTS.items()
            },
        },
    }


@router.get("/api/customers/uncategorized")
async def customers_uncategorized():
    """Personen mit relation='kunde', aber leere/fehlende categories. Befeuert
    den Sub-Tagger (PT/Workshop/Agent/Interessent)."""
    with _people_db() as con:
        rows = con.execute(
            """
            SELECT id, name, company, last_interaction_ts, categories
              FROM people
             WHERE relation = 'kunde'
             ORDER BY COALESCE(last_interaction_ts, updated_at) DESC
            """
        ).fetchall()
    out = []
    for r in rows:
        cats_raw = r["categories"]
        if cats_raw:
            try:
                cats = json.loads(cats_raw)
            except Exception:
                cats = []
        else:
            cats = []
        if cats:
            continue
        out.append({
            "id": r["id"],
            "name": r["name"],
            "company": r["company"],
            "last_interaction_ts": r["last_interaction_ts"],
        })
    return {"people": out, "total": len(out)}


@router.post("/api/customers/upsert")
async def customers_upsert(req: Request):
    body = await req.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "object required"}, status_code=400)
    pid = body.get("person_id")
    if not pid:
        return JSONResponse({"error": "person_id required"}, status_code=400)
    now_ts = int(time.time())

    # Mapping: API-Felder → people-Spaltennamen (status → customer_status,
    # notes → customer_notes, alles andere identisch).
    fields: dict = {}
    if "categories" in body:
        cats = body["categories"]
        if not isinstance(cats, list):
            return JSONResponse({"error": "categories must be list"}, status_code=400)
        cats = [c for c in cats if c in CUSTOMER_CATEGORIES]
        fields["categories"] = json.dumps(sorted(set(cats)), ensure_ascii=False)
    if "status" in body:
        fields["customer_status"] = body["status"]
    if "notes" in body:
        fields["customer_notes"] = body["notes"]
    membership_stream = (body.get("stream") or "").strip() or None
    if membership_stream and membership_stream not in PIPELINE_STREAMS:
        return JSONResponse({"error": f"unknown stream: {membership_stream}"}, status_code=400)
    membership_fields: dict = {}
    if "next_step_text" in body:
        val = ((body["next_step_text"] or "").strip() or None)
        if membership_stream:
            membership_fields["next_step_text"] = val
        else:
            fields["next_step_text"] = val
    if "next_step_due" in body:
        due = ((body["next_step_due"] or "").strip() or None)
        if due:
            try:
                datetime.strptime(due, "%Y-%m-%d")
            except ValueError:
                return JSONResponse({"error": "next_step_due must be YYYY-MM-DD"}, status_code=400)
        if membership_stream:
            membership_fields["next_step_due"] = due
        else:
            fields["next_step_due"] = due
    if membership_stream and "membership_notes" in body:
        membership_fields["notes"] = ((body["membership_notes"] or "").strip() or None)
    for f in ("rate_eur", "active_since"):
        if f in body:
            fields[f] = body[f]
    if "value_eur" in body:
        v = body["value_eur"]
        if v in (None, ""):
            fields["value_eur"] = None
        else:
            try:
                fields["value_eur"] = max(0, int(v))
            except (TypeError, ValueError):
                return JSONResponse({"error": "value_eur must be integer"}, status_code=400)
    if "pipeline_stream" in body:
        v = body["pipeline_stream"]
        if v not in (None, "") and v not in PIPELINE_STREAMS:
            return JSONResponse({"error": f"unknown pipeline_stream: {v}"}, status_code=400)
        fields["pipeline_stream"] = v or None
    if "pipeline_stage" in body:
        fields["pipeline_stage"] = body["pipeline_stage"] or None
    if "workshop_kind" in body:
        v = body["workshop_kind"]
        if v not in (None, "") and v not in WORKSHOP_KINDS:
            return JSONResponse({"error": f"unknown workshop_kind: {v}"}, status_code=400)
        fields["workshop_kind"] = v or None
    if "lead_source" in body:
        v = body["lead_source"]
        if v not in (None, "") and v not in LEAD_SOURCES:
            return JSONResponse({"error": f"unknown lead_source: {v}"}, status_code=400)
        fields["lead_source"] = v or None

    with _people_db() as con:
        existing = con.execute("SELECT id FROM people WHERE id=?", (pid,)).fetchone()
        if not existing:
            return JSONResponse({"error": "person not found"}, status_code=404)
        prow_before = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
        had_customer_data = _person_has_customer_data(prow_before)
        if fields:
            sets = ", ".join([f"{k} = ?" for k in fields.keys()] + ["updated_at = ?"])
            con.execute(
                f"UPDATE people SET {sets} WHERE id = ?",
                (*fields.values(), now_ts, pid),
            )
            new_stream = fields.get("pipeline_stream")
            new_stage = fields.get("pipeline_stage")
            if new_stream and new_stage:
                _upsert_pipeline_membership(con, pid, new_stream, new_stage)
        if membership_stream and membership_fields:
            sets = ", ".join([f"{k} = ?" for k in membership_fields.keys()] + ["updated_at = ?"])
            con.execute(
                f"UPDATE person_pipeline_memberships SET {sets} "
                f"WHERE stream = ? AND person_id = ?",
                (*membership_fields.values(), now_ts, membership_stream, pid),
            )
        if fields or (membership_stream and membership_fields):
            con.commit()
        prow = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
    return {"customer": _customer_row(prow), "created": not had_customer_data}


@router.post("/api/customers/stage")
async def customers_stage(req: Request):
    """Drag&Drop-Endpoint. Multi-Stream-Logik:
    - from_stream == stream oder fehlend: Membership im Ziel-Stream upserten,
      people.pipeline_stream/stage spiegeln falls Person diesen Stream als Primary hat.
    - from_stream != stream: Ziel-Membership upserten, Quelle UNANGETASTET lassen
      (Person erscheint dann parallel in beiden Streams)."""
    body = await req.json() or {}
    pid = body.get("person_id")
    stream = body.get("stream")
    stage = body.get("stage")
    from_stream = (body.get("from_stream") or "").strip() or None
    if not pid:
        return JSONResponse({"error": "person_id required"}, status_code=400)
    if stream not in PIPELINE_STREAMS:
        return JSONResponse({"error": f"unknown stream: {stream}"}, status_code=400)
    valid_stages = {sid for sid, _ in PIPELINE_STAGES[stream]}
    if stage not in valid_stages:
        return JSONResponse({"error": f"unknown stage for {stream}: {stage}"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        existing = con.execute("SELECT id, pipeline_stream FROM people WHERE id=?", (pid,)).fetchone()
        if not existing:
            return JSONResponse({"error": "person not found"}, status_code=404)
        _upsert_pipeline_membership(con, pid, stream, stage)
        # In eine echte Stage gezogen heißt: wieder aktiv. Eine evtl. Abgelegt-
        # Markierung dieses Streams wird dadurch aufgehoben.
        con.execute(
            "UPDATE person_pipeline_memberships SET status='active', lost_reason=NULL, lost_at=NULL "
            "WHERE person_id=? AND stream=?",
            (pid, stream),
        )
        same_stream = from_stream is None or from_stream == stream
        primary_stream = (existing["pipeline_stream"] or "").strip()
        if same_stream and (not primary_stream or primary_stream == stream):
            con.execute(
                "UPDATE people SET pipeline_stream=?, pipeline_stage=?, updated_at=? WHERE id=?",
                (stream, stage, now_ts, pid),
            )
        else:
            con.execute("UPDATE people SET updated_at=? WHERE id=?", (now_ts, pid))
        con.commit()
        prow = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
    return {"customer": _customer_row(prow), "ok": True}


@router.post("/api/customers/handoff")
async def customers_handoff(req: Request):
    """Bedarf-Weiche: übergibt einen qualifizierten Lead aus dem Trichter in
    den Zielstream. target='agent' -> agent/angebot, target='workshops' ->
    workshops/anmeldung. Die leads-Membership wird entfernt — die Karte
    verlässt den Trichter und lebt im Zielstream weiter."""
    body = await req.json() or {}
    pid = body.get("person_id")
    target = (body.get("target") or "").strip()
    target_stage = {"agent": "angebot", "workshops": "anmeldung"}.get(target)
    if not pid:
        return JSONResponse({"error": "person_id required"}, status_code=400)
    if not target_stage:
        return JSONResponse({"error": "target must be agent or workshops"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        existing = con.execute(
            "SELECT id, categories FROM people WHERE id=?", (pid,)
        ).fetchone()
        if not existing:
            return JSONResponse({"error": "person not found"}, status_code=404)
        _upsert_pipeline_membership(con, pid, target, target_stage)
        con.execute(
            "UPDATE person_pipeline_memberships SET status='active', lost_reason=NULL, lost_at=NULL "
            "WHERE person_id=? AND stream=?",
            (pid, target),
        )
        con.execute(
            "DELETE FROM person_pipeline_memberships WHERE person_id=? AND stream='leads'",
            (pid,),
        )
        try:
            cats = json.loads(existing["categories"] or "[]")
            if not isinstance(cats, list):
                cats = []
        except Exception:
            cats = []
        cats = [c for c in cats if c != "leads"]
        if target not in cats:
            cats.append(target)
        con.execute(
            "UPDATE people SET pipeline_stream=?, pipeline_stage=?, categories=?, updated_at=? WHERE id=?",
            (target, target_stage, json.dumps(sorted(set(cats)), ensure_ascii=False), now_ts, pid),
        )
        con.commit()
        prow = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
    return {"customer": _customer_row(prow), "ok": True, "target": target}


@router.get("/api/people/{person_id}/memberships")
async def people_memberships(person_id: int):
    """Alle Pipeline-Memberships dieser Person (für InfoPane-Historie)."""
    stage_labels = {(s, sid): lbl for s, lst in PIPELINE_STAGES.items() for sid, lbl in lst}
    with _people_db() as con:
        rows = con.execute(
            "SELECT stream, stage, next_step_text, next_step_due, "
            "       created_at, updated_at "
            "  FROM person_pipeline_memberships WHERE person_id=? "
            " ORDER BY updated_at DESC",
            (person_id,),
        ).fetchall()
    out = []
    for r in rows:
        stream = r["stream"]
        stage = r["stage"]
        terminal = stage in END_STAGES.get(stream, set())
        out.append({
            "stream": stream,
            "stream_label": PIPELINE_STREAM_LABELS.get(stream, stream),
            "stage": stage,
            "stage_label": stage_labels.get((stream, stage), stage),
            "terminal": terminal,
            "next_step_text": (r["next_step_text"] or "").strip() or None,
            "next_step_due": (r["next_step_due"] or "").strip() or None,
            "created_at": r["created_at"],
            "updated_at": r["updated_at"],
        })
    return {"memberships": out}


def _person_slug_for_pid(person_id: int) -> tuple[str, str] | None:
    """Liefert (slug, name) aus brain/people/_index.json wenn vorhanden."""
    if not _BRAIN_PEOPLE_INDEX.exists():
        return None
    try:
        idx = json.loads(_BRAIN_PEOPLE_INDEX.read_text(encoding="utf-8"))
    except Exception:
        return None
    entry = (idx.get("by_person_id") or {}).get(str(person_id))
    if not entry:
        for slug, e in (idx.get("by_slug") or {}).items():
            if str(e.get("person_id")) == str(person_id):
                return slug, e.get("name") or slug
        return None
    slug = entry.get("slug") or entry.get("file", "").split("/")[-1].removesuffix(".md")
    return slug, entry.get("name") or slug


@router.get("/api/people/{person_id}/journal")
async def people_journal(person_id: int, limit: int = 3):
    """Letzte Eintraege aus brain/people/<slug>.md (AUTO-JOURNAL-Section).
    Liefert Header (Datum + Titel), Body und optional Action-Items pro Eintrag.
    Leer wenn kein Journal existiert."""
    pair = _person_slug_for_pid(person_id)
    if not pair:
        return {"entries": [], "slug": None}
    slug, _name = pair
    md_path = _BRAIN_PEOPLE_DIR / f"{slug}.md"
    if not md_path.exists():
        return {"entries": [], "slug": slug}
    try:
        text = md_path.read_text(encoding="utf-8")
    except Exception:
        return {"entries": [], "slug": slug}

    begin = "<!-- AUTO-JOURNAL:BEGIN -->"
    end = "<!-- AUTO-JOURNAL:END -->"
    if begin not in text or end not in text:
        return {"entries": [], "slug": slug}
    block = text[text.index(begin) + len(begin) : text.index(end)].strip()
    if not block:
        return {"entries": [], "slug": slug}

    # Eintraege beginnen mit "### YYYY-MM-DD HH:MM · Titel"
    import re as _re
    parts = _re.split(r"\n(?=### )", block)
    entries: list[dict] = []
    for raw in parts:
        raw = raw.strip()
        if not raw.startswith("### "):
            continue
        first_nl = raw.find("\n")
        head = raw[4:first_nl].strip() if first_nl > 0 else raw[4:].strip()
        body_raw = raw[first_nl + 1 :].strip() if first_nl > 0 else ""
        # Trenne action-items (- [ ] ...) und Quelle vom Summary
        summary_lines: list[str] = []
        actions: list[str] = []
        for ln in body_raw.splitlines():
            s = ln.strip()
            if s.startswith("- [ ]") or s.startswith("- [x]"):
                done = s.startswith("- [x]")
                actions.append({"text": s[5:].strip(), "done": done})  # type: ignore
            elif s.startswith("_Quelle:"):
                continue
            else:
                summary_lines.append(ln)
        summary = "\n".join(summary_lines).strip()
        # Head zerlegen: "YYYY-MM-DD HH:MM · Titel"
        date_part = ""
        title_part = head
        if " · " in head:
            date_part, title_part = head.split(" · ", 1)
        entries.append({
            "date": date_part.strip(),
            "title": title_part.strip(),
            "summary": summary,
            "actions": actions,
        })
    # Neueste zuerst (sind sie schon, da prepend, aber sicherheitshalber sortieren)
    entries.sort(key=lambda e: e.get("date") or "", reverse=True)
    return {"entries": entries[:max(1, int(limit))], "slug": slug}


_PERSON_SYNTH_TTL = 6 * 3600  # 6 Stunden Cache, Person-Stand aendert sich nicht im Minutentakt


async def _person_synthesize(person: dict, last_touches: list, open_focus: list,
                              upcoming: list, notes: str) -> dict | None:
    """Verdichtet die letzten Touches zu zwei Saetzen Stand. Cached pro Hash."""
    from db import run_claude_cli as _r  # noqa: F401  -- nur fuer Sicherheit, Import-Check
    from db import get_db as _get_db
    import hashlib as _hashlib

    raw_parts = [person.get("name") or "", (notes or "")[:600]]
    for t in last_touches[:8]:
        raw_parts.append(f"[{t.get('kind','?')}] {(t.get('snippet') or '')[:300]}")
    for f in open_focus[:5]:
        raw_parts.append(f"[focus] {f.get('title','')}")
    for e in upcoming[:5]:
        raw_parts.append(f"[evt] {e.get('start_iso','')} {e.get('title','')}")
    raw = "\n".join(raw_parts).strip()
    if len(raw) < 60:
        return None
    cache_key = _hashlib.sha1(f"person:{person.get('id')}:{raw}".encode("utf-8")).hexdigest()
    try:
        with _get_db() as _db:
            row = _db.execute(
                "SELECT ts, data FROM focus_synth_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        if row and (time.time() - float(row[0])) < _PERSON_SYNTH_TTL:
            return json.loads(row[1])
    except Exception:
        pass

    touches_txt = "\n".join(
        f"[{t.get('kind','?')}] {(t.get('snippet') or '')[:400]}"
        for t in last_touches[:6]
    ) or "—"
    focus_txt = "\n".join(f"- {f.get('title','')}" for f in open_focus[:5]) or "—"
    upcoming_txt = "\n".join(
        f"- {e.get('start_iso','')[:16].replace('T',' ')} {e.get('title','')}"
        for e in upcoming[:5]
    ) or "—"
    today = datetime.now().strftime("%Y-%m-%d")

    prompt = f"""Heute ist {today}. Du bekommst des Nutzers letzte Kontakte und offenen Punkte zu einer Person. Verdichte das zu drei sehr kurzen Saetzen fuer eine Kunden-Detail-Ansicht.

Person: {person.get('name','')}{f" ({person.get('company')})" if person.get('company') else ''}

Eigene Notizen:
{(notes or '—')[:600]}

Letzte Touches (neueste zuerst):
{touches_txt}

Offene Punkte:
{focus_txt}

Anstehende Termine:
{upcoming_txt}

Schreibe drei Felder, jeweils ein Satz, in des Nutzers warmer Sprache (deutsch, volle Umlaute, KEINE Bindestriche im Fliesstext):
- "stand": Wo stehen wir mit dieser Person gerade
- "verblieben": Wie sind wir das letzte Mal verblieben (aus dem letzten WA/Mail/Chat)
- "next": Was waere der natuerliche naechste Schritt

Wenn ein Feld nicht aus dem Kontext belegbar ist, gib "" zurueck. Lieber leer als raten.

Antworte NUR mit JSON:
{{"stand":"...","verblieben":"...","next":"..."}}"""

    try:
        from local_llm import call_local, is_available
        if not is_available():
            return None
        stdout = await call_local(
            prompt=prompt, feature="person_synth",
            system="Du verdichtest Kunden-Kontext zu drei Saetzen als JSON.",
            max_tokens=350, temperature=0.2, timeout=25.0,
        )
    except Exception:
        return None
    if not stdout:
        return None
    try:
        import re as _re
        m = _re.search(r"\{[\s\S]*\}", stdout)
        if not m:
            return None
        parsed = json.loads(m.group(0))
        out = {
            "stand": (parsed.get("stand") or "").strip()[:280],
            "verblieben": (parsed.get("verblieben") or "").strip()[:280],
            "next": (parsed.get("next") or "").strip()[:280],
        }
        if not any(out.values()):
            return None
        try:
            with _get_db() as _db:
                _db.execute(
                    "INSERT OR REPLACE INTO focus_synth_cache(cache_key, ts, data) VALUES (?, ?, ?)",
                    (cache_key, time.time(), json.dumps(out, ensure_ascii=False)),
                )
        except Exception:
            pass
        return out
    except Exception:
        return None


@router.get("/api/people/{person_id}/synthesis")
async def people_synthesis(person_id: int):
    """LLM-Verdichtung: Stand, wie verblieben, naechster Schritt. Cached 6h."""
    if person_id <= 0:
        return JSONResponse({"error": "id required"}, status_code=400)
    with _people_db() as con:
        row = con.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "person not found"}, status_code=404)
        person = _person_row_to_dict(row)
        notes = (row["notes"] or "").strip()

    # Touches + Focus + Events aus chat.db / fokus ziehen
    last_touches: list[dict] = []
    open_focus: list[dict] = []
    upcoming: list[dict] = []
    try:
        with get_db() as _c:
            tr = _c.execute(
                "SELECT source_kind, snippet, ts FROM mentions "
                "WHERE entity_type='person' AND entity_id=? "
                "  AND source_kind IN ('whatsapp','email','chat') "
                "ORDER BY ts DESC LIMIT 8",
                (person_id,),
            ).fetchall()
            last_touches = [
                {"kind": r["source_kind"], "snippet": r["snippet"], "ts": r["ts"]}
                for r in tr
            ]
            focus_rows = _c.execute(
                "SELECT source_id, snippet FROM mentions "
                "WHERE entity_type='person' AND entity_id=? AND source_kind='focus' "
                "ORDER BY ts DESC",
                (person_id,),
            ).fetchall()
            focus_keys = {r["source_id"] for r in focus_rows}
    except Exception:
        focus_keys = set()

    if focus_keys:
        try:
            from modules.fokus.core import _focus_list_items
            for it in _focus_list_items(include_done=False, business_only=False):
                if (it.get("item_key") or "") in focus_keys:
                    open_focus.append({"title": it.get("title")})
        except Exception:
            pass

    try:
        from db import DB_PATH as _CHAT_DB
        today_iso = datetime.now().date().isoformat()
        with get_db() as _c:
            cal_rows = _c.execute(
                "SELECT source_id FROM mentions "
                "WHERE entity_type='person' AND entity_id=? AND source_kind='calendar'",
                (person_id,),
            ).fetchall()
            cal_ids = {r["source_id"] for r in cal_rows}
        if cal_ids:
            with sqlite3.connect(_CHAT_DB) as _c:
                _c.row_factory = sqlite3.Row
                ph = ",".join("?" * len(cal_ids))
                ev_rows = _c.execute(
                    f"SELECT id, start_iso, title FROM calendar_events "
                    f"WHERE id IN ({ph}) OR gcal_event_id IN ({ph})",
                    (*cal_ids, *cal_ids),
                ).fetchall()
                for r in ev_rows:
                    s = r["start_iso"] or ""
                    if s[:10] >= today_iso:
                        upcoming.append({"start_iso": s, "title": r["title"]})
            upcoming.sort(key=lambda e: e.get("start_iso") or "")
    except Exception:
        pass

    synth = await _person_synthesize(person, last_touches, open_focus, upcoming, notes)
    return {"synthesis": synth}


@router.get("/api/people/{person_id}/agent-suggestions")
async def people_agent_suggestions(person_id: int, agent_id: int = 0, include_done: int = 0):
    if person_id <= 0:
        return JSONResponse({"error": "id required"}, status_code=400)
    with _people_db() as con:
        row = con.execute("SELECT id FROM people WHERE id=?", (person_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "person not found"}, status_code=404)
        _refresh_agent_suggestions(con, person_id, agent_id or None)
        where = ["person_id=?"]
        params: list[object] = [person_id]
        if agent_id:
            where.append("agent_id=?")
            params.append(agent_id)
        if not include_done:
            where.append("status='new'")
        fresh_contact_floor = _agent_fresh_contact_floor(con, person_id, agent_id or None)
        if fresh_contact_floor:
            where.append("(source_kind NOT IN ('whatsapp','email','chat') OR (source_ts IS NOT NULL AND source_ts>=?))")
            params.append(fresh_contact_floor)
        rows = con.execute(
            f"""
            SELECT *
              FROM person_agent_suggestions
             WHERE {' AND '.join(where)}
             ORDER BY
                CASE kind
                  WHEN 'conversation' THEN 0
                  WHEN 'calendar' THEN 1
                  WHEN 'contact' THEN 2
                  WHEN 'offer' THEN 3
                  ELSE 4
                END,
                updated_at DESC,
                id DESC
             LIMIT 12
            """,
            params,
        ).fetchall()
        con.commit()
    return {"suggestions": [_agent_suggestion_dict(r) for r in rows]}


@router.post("/api/people/agent-suggestions/{suggestion_id}/status")
async def people_agent_suggestion_status(suggestion_id: int, req: Request):
    body = await req.json() or {}
    status = (body.get("status") or "").strip()
    if status not in {"new", "reviewed", "dismissed", "applied"}:
        return JSONResponse({"error": "status must be new, reviewed, dismissed or applied"}, status_code=400)
    now = int(time.time())
    with _people_db() as con:
        row = con.execute("SELECT id FROM person_agent_suggestions WHERE id=?", (suggestion_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        con.execute(
            "UPDATE person_agent_suggestions SET status=?, updated_at=? WHERE id=?",
            (status, now, suggestion_id),
        )
        con.commit()
    return {"ok": True, "id": suggestion_id, "status": status}


@router.post("/api/customers/membership/delete")
async def customers_membership_delete(req: Request):
    """Entfernt eine Person aus einem Stream (Karte vom Board nehmen).
    Wenn die Person diesen Stream als Primary hat und noch andere Memberships
    existieren, wandert die Primary auf den ältesten verbleibenden Stream."""
    body = await req.json() or {}
    pid = body.get("person_id")
    stream = body.get("stream")
    if not pid or not stream:
        return JSONResponse({"error": "person_id + stream required"}, status_code=400)
    with _people_db() as con:
        existing = con.execute("SELECT id, pipeline_stream FROM people WHERE id=?", (pid,)).fetchone()
        if not existing:
            return JSONResponse({"error": "person not found"}, status_code=404)
        con.execute(
            "DELETE FROM person_pipeline_memberships WHERE person_id=? AND stream=?",
            (pid, stream),
        )
        if (existing["pipeline_stream"] or "") == stream:
            next_row = con.execute(
                "SELECT stream, stage FROM person_pipeline_memberships "
                "WHERE person_id=? ORDER BY created_at ASC LIMIT 1",
                (pid,),
            ).fetchone()
            now_ts = int(time.time())
            if next_row:
                con.execute(
                    "UPDATE people SET pipeline_stream=?, pipeline_stage=?, updated_at=? WHERE id=?",
                    (next_row["stream"], next_row["stage"], now_ts, pid),
                )
            else:
                con.execute(
                    "UPDATE people SET pipeline_stream=NULL, pipeline_stage=NULL, updated_at=? WHERE id=?",
                    (now_ts, pid),
                )
        con.commit()
    return {"ok": True}


@router.post("/api/customers/membership/lost")
async def customers_membership_lost(req: Request):
    """Markiert eine Person in einem Stream als abgelegt/verloren (mit Grund),
    statt sie hart zu entfernen. Die Karte verlässt die aktiven Lanes und
    erscheint in der Abgelegt-Spur, bleibt aber traceable und reaktivierbar."""
    body = await req.json() or {}
    pid = body.get("person_id")
    stream = body.get("stream")
    reason = (body.get("reason") or "").strip()
    if not pid or not stream:
        return JSONResponse({"error": "person_id + stream required"}, status_code=400)
    if reason not in LOST_REASONS:
        return JSONResponse({"error": f"unknown reason: {reason}"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        row = con.execute(
            "SELECT id FROM person_pipeline_memberships WHERE person_id=? AND stream=?",
            (pid, stream),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "membership not found"}, status_code=404)
        con.execute(
            "UPDATE person_pipeline_memberships "
            "SET status='lost', lost_reason=?, lost_at=?, updated_at=? "
            "WHERE person_id=? AND stream=?",
            (reason, now_ts, now_ts, pid, stream),
        )
        # Primary wandert auf die älteste noch aktive Membership, sonst NULL.
        existing = con.execute("SELECT pipeline_stream FROM people WHERE id=?", (pid,)).fetchone()
        if existing and (existing["pipeline_stream"] or "") == stream:
            next_row = con.execute(
                "SELECT stream, stage FROM person_pipeline_memberships "
                "WHERE person_id=? AND (status IS NULL OR status!='lost') "
                "ORDER BY created_at ASC LIMIT 1",
                (pid,),
            ).fetchone()
            if next_row:
                con.execute(
                    "UPDATE people SET pipeline_stream=?, pipeline_stage=?, updated_at=? WHERE id=?",
                    (next_row["stream"], next_row["stage"], now_ts, pid),
                )
            else:
                con.execute(
                    "UPDATE people SET pipeline_stream=NULL, pipeline_stage=NULL, updated_at=? WHERE id=?",
                    (now_ts, pid),
                )
        con.commit()
    return {"ok": True}


@router.post("/api/customers/membership/reactivate")
async def customers_membership_reactivate(req: Request):
    """Holt eine abgelegte Karte zurück in die Pipeline (Status wieder aktiv),
    die Stage bleibt erhalten wo sie zuletzt stand."""
    body = await req.json() or {}
    pid = body.get("person_id")
    stream = body.get("stream")
    if not pid or not stream:
        return JSONResponse({"error": "person_id + stream required"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        row = con.execute(
            "SELECT stage FROM person_pipeline_memberships WHERE person_id=? AND stream=?",
            (pid, stream),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "membership not found"}, status_code=404)
        con.execute(
            "UPDATE person_pipeline_memberships "
            "SET status='active', lost_reason=NULL, lost_at=NULL, updated_at=? "
            "WHERE person_id=? AND stream=?",
            (now_ts, pid, stream),
        )
        existing = con.execute("SELECT pipeline_stream FROM people WHERE id=?", (pid,)).fetchone()
        if existing and not (existing["pipeline_stream"] or "").strip():
            con.execute(
                "UPDATE people SET pipeline_stream=?, pipeline_stage=?, updated_at=? WHERE id=?",
                (stream, row["stage"], now_ts, pid),
            )
        con.commit()
    return {"ok": True}


@router.post("/api/customers/betreuung-tick")
async def customers_betreuung_tick(req: Request):
    """Erhöht oder senkt betreuung_done für eine Karte. Bei Firmen-Karten werden
    alle Member-Customers synchron auf den neuen Wert gesetzt, damit eine Firma
    konsistent „2/4" zeigt statt sich pro Person zu verzweigen.

    Body: {person_ids: [int, ...], delta: -1|+1} oder {person_ids, value: int}
    """
    body = await req.json()
    pids = (body or {}).get("person_ids") or []
    if not isinstance(pids, list) or not pids:
        return JSONResponse({"error": "person_ids required"}, status_code=400)
    delta = body.get("delta")
    value = body.get("value")
    now_ts = int(time.time())
    with _people_db() as con:
        rows = con.execute(
            f"SELECT id AS person_id, betreuung_done FROM people WHERE id IN ({','.join(['?']*len(pids))})",
            pids,
        ).fetchall()
        if not rows:
            return JSONResponse({"error": "no customers found"}, status_code=404)
        current = max((int(r["betreuung_done"] or 0) for r in rows), default=0)
        if value is not None:
            new_val = max(0, min(4, int(value)))
        elif delta is not None:
            new_val = max(0, min(4, current + int(delta)))
        else:
            return JSONResponse({"error": "delta or value required"}, status_code=400)
        con.execute(
            f"UPDATE people SET betreuung_done=?, updated_at=? WHERE id IN ({','.join(['?']*len(pids))})",
            [new_val, now_ts, *pids],
        )
        con.commit()
    return {"ok": True, "betreuung_done": new_val, "total": 4}


@router.post("/api/customers/check-toggle")
async def customers_check_toggle(req: Request):
    """Setzt einen Checklisten-Eintrag pro Karte. Bei Firmen-Karten landet
    der Wert auf allen Member-Customers, damit die Karte konsistent bleibt.

    Body: {person_ids: [int,...], stage_id: str, item_key: str, done: bool}
    """
    body = await req.json()
    pids = (body or {}).get("person_ids") or []
    stage_id = (body or {}).get("stage_id") or ""
    item_key = (body or {}).get("item_key") or ""
    done = bool((body or {}).get("done"))
    stream_id = ((body or {}).get("stream") or "").strip() or None
    try:
        agent_id = int((body or {}).get("agent_id") or 0)
    except Exception:
        agent_id = 0
    if not isinstance(pids, list) or not pids:
        return JSONResponse({"error": "person_ids required"}, status_code=400)
    if not stage_id or not item_key:
        return JSONResponse({"error": "stage_id and item_key required"}, status_code=400)
    if stream_id and stream_id not in PIPELINE_STREAMS:
        return JSONResponse({"error": f"unknown stream: {stream_id}"}, status_code=400)
    full_key = f"{stage_id}:{item_key}"
    now_ts = int(time.time())
    with _people_db() as con:
        if agent_id:
            row = con.execute(
                "SELECT id, person_id, stage_progress, is_primary FROM person_agents WHERE id=?",
                (agent_id,),
            ).fetchone()
            if not row:
                return JSONResponse({"error": "agent not found"}, status_code=404)
            if int(row["person_id"] or 0) not in {int(pid) for pid in pids}:
                return JSONResponse({"error": "agent does not belong to person_ids"}, status_code=400)
            try:
                sp = json.loads(row["stage_progress"]) if row["stage_progress"] else {}
                if not isinstance(sp, dict):
                    sp = {}
            except Exception:
                sp = {}
            if done:
                sp[full_key] = True
            else:
                sp.pop(full_key, None)
            complete = _agent_progress_complete(sp)
            item_label = _checklist_label("agent", stage_id, item_key)
            summary = f"{item_label} {'abgehakt' if done else 'zurückgenommen'}"
            next_stage = "abgeschlossen" if complete else _agent_progress_stage(sp, stage_id)
            next_step_text = _agent_next_step_text(sp, stage_id)
            next_status = "Abgeschlossen" if complete else "In Arbeit"
            con.execute(
                "UPDATE person_agents SET stage_progress=?, status=?, next_step_text=?, updated_at=? WHERE id=?",
                (json.dumps(sp, ensure_ascii=False), next_status, next_step_text, now_ts, agent_id),
            )
            con.execute(
                """INSERT INTO person_agent_events
                   (agent_id, person_id, source, event_type, stage_id, item_key, item_label, done, summary, created_at)
                   VALUES (?, ?, 'manual', 'check_toggle', ?, ?, ?, ?, ?, ?)""",
                (agent_id, int(row["person_id"]), stage_id, item_key, item_label, 1 if done else 0, summary, now_ts),
            )
            if int(row["is_primary"] or 0):
                con.execute(
                    "UPDATE people SET agent_status=?, updated_at=? WHERE id=?",
                    (next_status, now_ts, int(row["person_id"])),
                )
            pipeline_sync = _sync_person_agent_pipeline(con, int(row["person_id"]), now_ts) or {}
            con.commit()
            return {
                "ok": True,
                "stage_id": stage_id,
                "item_key": item_key,
                "done": done,
                "stream": stream_id,
                "agent_id": agent_id,
                "status": next_status,
                "pipeline_stage": pipeline_sync.get("stage") or next_stage,
            }
        placeholders = ",".join(["?"] * len(pids))
        if stream_id:
            rows = con.execute(
                f"SELECT person_id, stage_progress FROM person_pipeline_memberships "
                f"WHERE stream=? AND person_id IN ({placeholders})",
                [stream_id, *pids],
            ).fetchall()
            if not rows:
                return JSONResponse({"error": "no memberships found"}, status_code=404)
            for r in rows:
                try:
                    sp = json.loads(r["stage_progress"]) if r["stage_progress"] else {}
                    if not isinstance(sp, dict):
                        sp = {}
                except Exception:
                    sp = {}
                if done:
                    sp[full_key] = True
                else:
                    sp.pop(full_key, None)
                con.execute(
                    "UPDATE person_pipeline_memberships SET stage_progress=?, updated_at=? "
                    "WHERE stream=? AND person_id=?",
                    (json.dumps(sp, ensure_ascii=False), now_ts, stream_id, r["person_id"]),
                )
        else:
            rows = con.execute(
                f"SELECT id AS person_id, stage_progress FROM people WHERE id IN ({placeholders})",
                pids,
            ).fetchall()
            if not rows:
                return JSONResponse({"error": "no customers found"}, status_code=404)
            for r in rows:
                try:
                    sp = json.loads(r["stage_progress"]) if r["stage_progress"] else {}
                    if not isinstance(sp, dict):
                        sp = {}
                except Exception:
                    sp = {}
                if done:
                    sp[full_key] = True
                else:
                    sp.pop(full_key, None)
                con.execute(
                    "UPDATE people SET stage_progress=?, updated_at=? WHERE id=?",
                    (json.dumps(sp, ensure_ascii=False), now_ts, r["person_id"]),
                )
        con.commit()
    return {"ok": True, "stage_id": stage_id, "item_key": item_key, "done": done, "stream": stream_id}


# ── People-Cluster + Suche + Create-Lead ─────────────────────────────────

@router.post("/api/people/cluster")
async def people_set_cluster(req: Request):
    """Setzt people.company_cluster — händische Firma-Verknüpfung."""
    body = await req.json()
    pid = (body or {}).get("person_id")
    cluster = (body or {}).get("company_cluster")
    if not pid:
        return JSONResponse({"error": "person_id required"}, status_code=400)
    val = (cluster or "").strip() or None
    with _people_db() as con:
        existing = con.execute("SELECT id FROM people WHERE id=?", (pid,)).fetchone()
        if not existing:
            return JSONResponse({"error": "person not found"}, status_code=404)
        con.execute("UPDATE people SET company_cluster=? WHERE id=?", (val, pid))
        con.commit()
    return {"ok": True, "person_id": pid, "company_cluster": val}


@router.get("/api/people/clusters")
async def people_list_clusters():
    """Liefert alle vorhandenen Cluster-Keys mit Anzeigename und Anzahl."""
    with _people_db() as con:
        rows = con.execute(
            """
            SELECT company_cluster AS cluster,
                   COUNT(*) AS n,
                   MIN(company) AS company
            FROM people
            WHERE company_cluster IS NOT NULL AND company_cluster != ''
            GROUP BY company_cluster
            """
        ).fetchall()
    out = []
    for r in rows:
        cl = r["cluster"]
        out.append({
            "cluster": cl,
            "label": _AGENT_FIRM_LABELS.get(cl) or r["company"] or cl,
            "count": r["n"],
        })
    out.sort(key=lambda x: x["label"].lower())
    return {"clusters": out}


@router.get("/api/people/search")
async def people_search(q: str = "", limit: int = 10):
    """Kombinierte Suche: people.db + WhatsApp-Chats (nur die, die noch keiner
    Person zugeordnet sind). Liefert eine flache, gemischte Trefferliste mit
    `source` ('person' | 'whatsapp')."""
    q = (q or "").strip()
    if len(q) < 2:
        return {"results": []}
    like = f"%{q}%"
    out: list[dict] = []
    with _people_db() as pcon:
        prows = pcon.execute(
            """
            SELECT id, name, company, email, phone, whatsapp_chat_id
              FROM people
             WHERE name LIKE ? OR company LIKE ? OR phone LIKE ? OR email LIKE ?
             ORDER BY COALESCE(last_interaction_ts, updated_at) DESC
             LIMIT ?
            """,
            (like, like, like, like, limit),
        ).fetchall()
        linked_jids = {
            r["whatsapp_chat_id"] for r in pcon.execute(
                "SELECT whatsapp_chat_id FROM people WHERE whatsapp_chat_id IS NOT NULL AND whatsapp_chat_id != ''"
            ).fetchall()
        }
    for r in prows:
        out.append({
            "source": "person",
            "person_id": r["id"],
            "name": r["name"],
            "company": r["company"],
            "email": r["email"],
            "phone": r["phone"],
        })

    if WHATSAPP_DB.exists():
        try:
            with _wa_db() as wcon:
                like_lc = f"%{q.lower()}%"
                wrows = wcon.execute(
                    """
                    SELECT c.id, c.name, c.is_group, c.last_message_ts
                      FROM chats c
                     WHERE LOWER(COALESCE(c.name,'')) LIKE ?
                     ORDER BY c.last_message_ts DESC
                     LIMIT ?
                    """,
                    (like_lc, limit),
                ).fetchall()
            for r in wrows:
                if r["id"] in linked_jids:
                    continue
                out.append({
                    "source": "whatsapp",
                    "chat_id": r["id"],
                    "name": _wa_chat_display_name(r),
                    "is_group": bool(r["is_group"]),
                    "last_ts": r["last_message_ts"],
                })
        except Exception:
            pass
    return {"results": out}


@router.post("/api/people/create-lead")
async def people_create_lead(req: Request):
    """Legt Person + Customer in einem Rutsch an und droppt sie in Pipeline.
    Alternativ kann eine bestehende Person via `person_id` verwendet werden
    — dann wird nur ein Customer-Eintrag angelegt (oder ein vorhandener in
    die Pipeline geschoben).

    Body: {person_id?, name?, company?, email?, phone?, stream, stage,
           lead_source?, workshop_kind?, notes?}
    """
    body = await req.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "object required"}, status_code=400)
    stream = body.get("stream")
    stage = body.get("stage")
    if stream not in PIPELINE_STREAMS:
        return JSONResponse({"error": f"unknown stream: {stream}"}, status_code=400)
    valid_stages = {sid for sid, _ in PIPELINE_STAGES[stream]}
    if stage not in valid_stages:
        return JSONResponse({"error": f"unknown stage for {stream}: {stage}"}, status_code=400)
    lead_source = body.get("lead_source") or None
    if lead_source and lead_source not in LEAD_SOURCES:
        return JSONResponse({"error": f"unknown lead_source: {lead_source}"}, status_code=400)
    # Herkunft ist Pflicht, sobald eine Karte im Lead-Trichter startet — sonst
    # weiss man spaeter nicht, welcher Kanal Umsatz bringt.
    if stream == "leads" and not lead_source:
        return JSONResponse({"error": "lead_source required"}, status_code=400)
    workshop_kind = body.get("workshop_kind") or None
    if workshop_kind and workshop_kind not in WORKSHOP_KINDS:
        return JSONResponse({"error": f"unknown workshop_kind: {workshop_kind}"}, status_code=400)
    notes = body.get("notes") or None
    next_step_text = ((body.get("next_step_text") or "").strip() or None)
    next_step_due = ((body.get("next_step_due") or "").strip() or None)
    if next_step_due:
        try:
            datetime.strptime(next_step_due, "%Y-%m-%d")
        except ValueError:
            return JSONResponse({"error": "next_step_due must be YYYY-MM-DD"}, status_code=400)
    now_ts = int(time.time())
    person_id = body.get("person_id")
    cats = json.dumps(
        ["leads"] if stream == "leads" else (["agent"] if stream == "agent" else ["workshops"]),
        ensure_ascii=False,
    )

    with _people_db() as con:
        if person_id:
            try:
                pid = int(person_id)
            except Exception:
                return JSONResponse({"error": "invalid person_id"}, status_code=400)
            prow_before = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
            if not prow_before:
                return JSONResponse({"error": "person not found"}, status_code=404)
            had_customer_data = _person_has_customer_data(prow_before)
            if had_customer_data:
                con.execute(
                    """UPDATE people
                       SET pipeline_stream=?, pipeline_stage=?,
                           lead_source=COALESCE(?, lead_source),
                           workshop_kind=COALESCE(?, workshop_kind),
                           next_step_text=COALESCE(?, next_step_text),
                           next_step_due=COALESCE(?, next_step_due),
                           customer_notes=COALESCE(?, customer_notes),
                           updated_at=?
                       WHERE id=?""",
                    (stream, stage, lead_source, workshop_kind, next_step_text, next_step_due, notes, now_ts, pid),
                )
                created = False
            else:
                con.execute(
                    """UPDATE people
                       SET categories=?, customer_status='active', customer_notes=?,
                           next_step_text=?, next_step_due=?,
                           pipeline_stream=?, pipeline_stage=?,
                           lead_source=?, workshop_kind=?, updated_at=?
                       WHERE id=?""",
                    (cats, notes, next_step_text, next_step_due, stream, stage, lead_source, workshop_kind, now_ts, pid),
                )
                created = True
            _upsert_pipeline_membership(con, pid, stream, stage, next_step_text=next_step_text)
            con.commit()
        else:
            name = (body.get("name") or "").strip()
            if not name:
                return JSONResponse({"error": "name or person_id required"}, status_code=400)
            company = (body.get("company") or "").strip() or None
            email = (body.get("email") or "").strip() or None
            phone = (body.get("phone") or "").strip() or None
            company_cluster = (body.get("company_cluster") or "").strip() or None
            whatsapp_chat_id = (body.get("whatsapp_chat_id") or "").strip() or None
            cur = con.execute(
                """
                INSERT INTO people (name, company, email, phone, company_cluster, whatsapp_chat_id,
                                    categories, customer_status, customer_notes, next_step_text, next_step_due,
                                    pipeline_stream, pipeline_stage, lead_source, workshop_kind,
                                    created_at, updated_at, last_interaction_ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (name, company, email, phone, company_cluster, whatsapp_chat_id,
                 cats, notes, next_step_text, next_step_due, stream, stage, lead_source, workshop_kind,
                 now_ts, now_ts, now_ts),
            )
            pid = cur.lastrowid
            created = True
            _upsert_pipeline_membership(con, pid, stream, stage, next_step_text=next_step_text)
            con.commit()
        prow = con.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
    return {"customer": _customer_row(prow), "created": created}


@router.post("/api/customers/delete")
async def customers_delete(req: Request):
    """Entfernt die Customer-Daten einer Person, lässt die Person selbst stehen.
    Setzt alle customer-spezifischen Spalten auf NULL/Default."""
    body = await req.json()
    pid = (body or {}).get("person_id")
    if not pid:
        return JSONResponse({"error": "person_id required"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        con.execute(
            """UPDATE people SET
                 categories=NULL,
                 customer_status=NULL,
                 customer_notes=NULL,
                 next_step_text=NULL,
                 next_step_due=NULL,
                 rate_eur=NULL,
                 active_since=NULL,
                 last_invoice_ts=NULL,
                 pipeline_stream=NULL,
                 pipeline_stage=NULL,
                 stage_progress=NULL,
                 workshop_kind=NULL,
                 lead_source=NULL,
                 betreuung_done=0,
                 source_campaign_id=NULL,
                 updated_at=?
               WHERE id = ?""",
            (now_ts, pid),
        )
        con.commit()
    return {"ok": True}


# ── Marketing-Kampagnen ──────────────────────────────────────────────────

@router.get("/api/marketing-campaigns")
async def marketing_campaigns_list():
    """Liefert Kanban-Struktur für Marketing-Kampagnen plus Lead-Counts pro Kampagne."""
    with _people_db() as con:
        rows = con.execute(
            "SELECT * FROM campaigns ORDER BY COALESCE(started_at, created_at) DESC"
        ).fetchall()
        counts_raw = con.execute(
            "SELECT source_campaign_id, COUNT(*) AS n FROM people "
            "WHERE source_campaign_id IS NOT NULL GROUP BY source_campaign_id"
        ).fetchall()
    counts = {r["source_campaign_id"]: r["n"] for r in counts_raw}
    campaigns = []
    for r in rows:
        c = _campaign_row(r)
        c["lead_count"] = int(counts.get(r["id"], 0))
        campaigns.append(c)
    stages = []
    for stage_id, stage_label in CAMPAIGN_STAGES:
        in_stage = [c for c in campaigns if (c.get("stage") or "idee") == stage_id]
        stages.append({
            "id": stage_id,
            "label": stage_label,
            "count": len(in_stage),
            "campaigns": in_stage,
        })
    return {
        "stages": stages,
        "all": campaigns,
        "total": len(campaigns),
        "meta": {
            "stages": [{"id": s, "label": l} for s, l in CAMPAIGN_STAGES],
            "channels": list(CAMPAIGN_CHANNELS),
        },
    }


@router.post("/api/marketing-campaigns")
async def marketing_campaigns_create(req: Request):
    body = await req.json()
    name = (body.get("name") or "").strip()
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    stage = (body.get("stage") or "idee").strip()
    valid_stages = {s for s, _ in CAMPAIGN_STAGES}
    if stage not in valid_stages:
        return JSONResponse({"error": f"stage must be one of {sorted(valid_stages)}"}, status_code=400)
    channel = (body.get("channel") or "").strip() or None
    if channel and channel not in CAMPAIGN_CHANNELS:
        return JSONResponse({"error": f"channel must be one of {list(CAMPAIGN_CHANNELS)}"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        cur = con.execute(
            "INSERT INTO campaigns (name, stage, channel, goal, notes, started_at, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                name,
                stage,
                channel,
                (body.get("goal") or None),
                (body.get("notes") or None),
                int(body["started_at"]) if body.get("started_at") else None,
                now_ts,
                now_ts,
            ),
        )
        cid = cur.lastrowid
        con.commit()
        row = con.execute("SELECT * FROM campaigns WHERE id=?", (cid,)).fetchone()
    return {"campaign": _campaign_row(row)}


@router.post("/api/marketing-campaigns/{campaign_id}/stage")
async def marketing_campaigns_set_stage(campaign_id: int, req: Request):
    body = await req.json()
    stage = (body.get("stage") or "").strip()
    valid_stages = {s for s, _ in CAMPAIGN_STAGES}
    if stage not in valid_stages:
        return JSONResponse({"error": f"stage must be one of {sorted(valid_stages)}"}, status_code=400)
    now_ts = int(time.time())
    with _people_db() as con:
        row = con.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        ended_at = row["ended_at"]
        started_at = row["started_at"]
        if stage == "live" and not started_at:
            started_at = now_ts
        if stage == "abgeschlossen" and not ended_at:
            ended_at = now_ts
        con.execute(
            "UPDATE campaigns SET stage=?, started_at=?, ended_at=?, updated_at=? WHERE id=?",
            (stage, started_at, ended_at, now_ts, campaign_id),
        )
        con.commit()
        row = con.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
    return {"campaign": _campaign_row(row)}


@router.post("/api/marketing-campaigns/{campaign_id}/update")
async def marketing_campaigns_update(campaign_id: int, req: Request):
    body = await req.json()
    fields: dict = {}
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "name cannot be empty"}, status_code=400)
        fields["name"] = name
    if "channel" in body:
        ch = (body.get("channel") or "").strip() or None
        if ch and ch not in CAMPAIGN_CHANNELS:
            return JSONResponse({"error": f"channel must be one of {list(CAMPAIGN_CHANNELS)}"}, status_code=400)
        fields["channel"] = ch
    if "goal" in body:
        fields["goal"] = (body.get("goal") or None)
    if "notes" in body:
        fields["notes"] = (body.get("notes") or None)
    if "started_at" in body:
        fields["started_at"] = int(body["started_at"]) if body["started_at"] else None
    if "ended_at" in body:
        fields["ended_at"] = int(body["ended_at"]) if body["ended_at"] else None
    if not fields:
        return JSONResponse({"error": "no fields"}, status_code=400)
    fields["updated_at"] = int(time.time())
    set_clause = ", ".join(f"{k}=?" for k in fields)
    params = list(fields.values()) + [campaign_id]
    with _people_db() as con:
        existing = con.execute("SELECT id FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not existing:
            return JSONResponse({"error": "not found"}, status_code=404)
        con.execute(f"UPDATE campaigns SET {set_clause} WHERE id=?", params)
        con.commit()
        row = con.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
    return {"campaign": _campaign_row(row)}


@router.delete("/api/marketing-campaigns/{campaign_id}")
async def marketing_campaigns_delete(campaign_id: int):
    with _people_db() as con:
        existing = con.execute("SELECT id FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
        if not existing:
            return JSONResponse({"error": "not found"}, status_code=404)
        con.execute("UPDATE people SET source_campaign_id=NULL WHERE source_campaign_id=?", (campaign_id,))
        con.execute("DELETE FROM campaigns WHERE id=?", (campaign_id,))
        con.commit()
    return {"ok": True}


# ── Customer Mentions (Chat + WA + IMAP) ─────────────────────────────────

@router.get("/api/customers/mentions")
async def customers_mentions(person_id: int, limit: int = 6):
    """Erwähnungen aus Chat und WhatsApp für eine Person. Mail bleibt on-demand
    (live IMAP, zu langsam für Akten-Auto-Load)."""
    with _people_db() as con:
        prow = con.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
    if not prow:
        return JSONResponse({"error": "person not found"}, status_code=404)
    person = _person_row_to_dict(prow)
    name = (person.get("name") or "").strip()
    wa_chat_id = (person.get("whatsapp_chat_id") or "").strip()

    def _phrase(s: str) -> str:
        return '"' + s.replace('"', '') + '"'

    chat_hits: list[dict] = []
    if name:
        try:
            with get_db() as db:
                rows = db.execute(
                    "SELECT m.author, m.content, m.ts, m.agent, m.conversation_id "
                    "FROM messages m JOIN chat_search cs ON m.id = cs.rowid "
                    "WHERE chat_search MATCH ? ORDER BY m.ts DESC LIMIT ?",
                    (_phrase(name), limit),
                ).fetchall()
            for r in rows:
                snip = (r[1] or "").strip().replace("\n", " ")
                if len(snip) > 200:
                    snip = snip[:200] + "…"
                chat_hits.append({
                    "author": r[0], "snippet": snip, "ts": r[2],
                    "agent": r[3] or "", "conversationId": r[4] or "",
                })
        except Exception:
            pass

    wa_hits: list[dict] = []
    try:
        with _wa_db() as con:
            if wa_chat_id:
                rows = con.execute(
                    "SELECT m.id, m.chat_id, m.ts, m.from_me, m.type, m.body, "
                    "       m.transcript, c.name AS chat_name "
                    "  FROM messages m LEFT JOIN chats c ON c.id = m.chat_id "
                    " WHERE m.chat_id = ? ORDER BY m.ts DESC LIMIT ?",
                    (wa_chat_id, limit),
                ).fetchall()
            elif name:
                rows = con.execute(
                    "SELECT m.id, m.chat_id, m.ts, m.from_me, m.type, m.body, "
                    "       m.transcript, c.name AS chat_name "
                    "  FROM messages_fts f JOIN messages m ON m.rowid = f.rowid "
                    "  LEFT JOIN chats c ON c.id = m.chat_id "
                    " WHERE messages_fts MATCH ? ORDER BY m.ts DESC LIMIT ?",
                    (_phrase(name), limit),
                ).fetchall()
            else:
                rows = []
        for r in rows:
            snip = (r["transcript"] or r["body"] or "").strip().replace("\n", " ")
            if len(snip) > 200:
                snip = snip[:200] + "…"
            wa_hits.append({
                "id": r["id"], "chat_id": r["chat_id"],
                "chat_name": r["chat_name"] or r["chat_id"],
                "ts": r["ts"], "from_me": bool(r["from_me"]),
                "type": r["type"], "snippet": snip,
            })
    except HTTPException:
        pass
    except Exception:
        pass

    return {"chat": chat_hits, "whatsapp": wa_hits}


@router.get("/api/customers/mentions/mail")
async def customers_mentions_mail(person_id: int, limit: int = 5):
    """Live-IMAP-Suche per Email-Adresse. Separat, weil langsam."""
    with _people_db() as con:
        prow = con.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
    if not prow:
        return JSONResponse({"error": "person not found"}, status_code=404)
    person = _person_row_to_dict(prow)
    email = (person.get("email") or "").strip()
    if not email:
        return {"threads": [], "reason": "no_email"}
    import mail as _mail
    accs = _mail.load_accounts()
    if not accs:
        return {"threads": [], "reason": "no_account"}
    try:
        threads = await asyncio.to_thread(_mail.search_inbox, accs[0]["key"], email, limit)
    except Exception as e:
        return JSONResponse({"error": str(e), "threads": []}, status_code=500)
    return {"threads": threads, "account": accs[0]["key"]}


# ── Offers ───────────────────────────────────────────────────────────────
# offers-Tabelle live in people.db, eine Person kann mehrere offers haben.
# View-Tracking via analytics.db (track.js auf der Angebotsseite). Accept
# kommt als Webhook vom example.com-Worker. Beim mark-sent setzen wir
# pipeline_stream='agent', stage='angebot-raus' fuer die Person; beim accept
# stage='angenommen' + next_step_text='Rechnung schreiben'.

_ANALYTICS_DB = Path.home() / "agent/data/analytics.db"


def _offer_row(r) -> dict:
    if not r:
        return {}
    d = dict(r)
    # Person-Name JOIN-frei: separater Lookup, weil offers + people im selben
    # File leben aber wir trotzdem entkoppelt sein wollen.
    return d


def _upsert_pipeline_membership(con, person_id: int, stream: str, stage: str, next_step_text: str | None = None) -> None:
    """Legt Membership an oder updated Stage. Eine Person pro Stream genau einmal.
    Wenn next_step_text gesetzt ist, wird auch das Membership-Feld aktualisiert."""
    if not person_id or not stream or not stage:
        return
    now = int(time.time())
    con.execute(
        """INSERT INTO person_pipeline_memberships
           (person_id, stream, stage, next_step_text, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(person_id, stream) DO UPDATE SET
             stage=excluded.stage,
             updated_at=excluded.updated_at""",
        (person_id, stream, stage, next_step_text, now, now),
    )
    if next_step_text is not None:
        con.execute(
            "UPDATE person_pipeline_memberships SET next_step_text=?, updated_at=? "
            "WHERE person_id=? AND stream=?",
            (next_step_text, now, person_id, stream),
        )


def _sync_person_agent_pipeline(con, person_id: int, now_ts: int | None = None) -> dict | None:
    if not person_id:
        return None
    now = now_ts or int(time.time())
    rows = con.execute(
        "SELECT id, is_primary, stage_progress FROM person_agents WHERE person_id=? ORDER BY is_primary DESC, id",
        (person_id,),
    ).fetchall()
    if not rows:
        return None

    first_open: tuple[str, str | None] | None = None
    all_complete = True
    for row in rows:
        try:
            sp = json.loads(row["stage_progress"]) if row["stage_progress"] else {}
            if not isinstance(sp, dict):
                sp = {}
        except Exception:
            sp = {}
        complete = _agent_progress_complete(sp)
        if not complete:
            all_complete = False
            if first_open is None:
                stage = _agent_progress_stage(sp)
                first_open = (stage, _agent_next_step_text(sp, stage))

    if all_complete:
        stage, next_step = "abgeschlossen", None
    else:
        stage, next_step = first_open or ("onboarding", "Offen: nächsten prüfbaren Agent-Schritt festlegen")

    _upsert_pipeline_membership(con, person_id, "agent", stage, next_step)
    if next_step is None:
        con.execute(
            "UPDATE person_pipeline_memberships SET next_step_text=NULL, next_step_due=NULL, updated_at=? WHERE person_id=? AND stream='agent'",
            (now, person_id),
        )
    con.execute(
        "UPDATE people SET pipeline_stream='agent', pipeline_stage=?, updated_at=? WHERE id=?",
        (stage, now, person_id),
    )
    return {"stage": stage, "next_step_text": next_step, "complete": all_complete}


def _offer_pipeline_apply(con, person_id: int, stage: str, next_step: str | None = None) -> None:
    if not person_id:
        return
    now = int(time.time())
    fields = ["pipeline_stream='agent'", "pipeline_stage=?", "updated_at=?"]
    params: list = [stage, now]
    if next_step is not None:
        fields.append("next_step_text=?")
        params.append(next_step)
    params.append(person_id)
    con.execute(f"UPDATE people SET {', '.join(fields)} WHERE id=?", params)
    _upsert_pipeline_membership(con, person_id, "agent", stage, next_step_text=next_step)


@router.get("/api/offers/list")
async def offers_list(status: str = "", limit: int = 100):
    with _people_db() as con:
        sql = "SELECT * FROM offers"
        params: list = []
        if status:
            sql += " WHERE status=?"
            params.append(status)
        sql += " ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?"
        params.append(limit)
        rows = con.execute(sql, params).fetchall()
        # Person-Namen anreichern
        person_ids = {r["person_id"] for r in rows if r["person_id"]}
        names: dict[int, str] = {}
        if person_ids:
            placeholders = ",".join("?" * len(person_ids))
            for pr in con.execute(
                f"SELECT id, name FROM people WHERE id IN ({placeholders})",
                list(person_ids),
            ).fetchall():
                names[pr["id"]] = pr["name"]
    items = []
    for r in rows:
        d = _offer_row(r)
        d["person_name"] = names.get(r["person_id"], "")
        items.append(d)
    return {"offers": items}


@router.post("/api/offers/mark-sent")
async def offers_mark_sent(req: Request):
    """Wird vom WA-Send-Hook und manuell aufgerufen.
    Body: {token, slug, package?, amount_eur?, url?, sent_via?, person_id?}
    Idempotent auf token: bestehende Eintraege werden aktualisiert."""
    data = await req.json()
    token = (data.get("token") or "").strip().lower()
    if not token:
        raise HTTPException(400, "token required")
    slug = (data.get("slug") or token).strip().lower()
    package = (data.get("package") or "").strip()
    amount_eur = data.get("amount_eur")
    if isinstance(amount_eur, str):
        amount_eur = int(amount_eur) if amount_eur.isdigit() else None
    url = (data.get("url") or "").strip()
    sent_via = (data.get("sent_via") or "manual").strip()
    person_id = data.get("person_id")
    now = int(time.time())
    with _people_db() as con:
        existing = con.execute("SELECT * FROM offers WHERE token=?", (token,)).fetchone()
        if existing:
            con.execute(
                """UPDATE offers
                   SET sent_at = COALESCE(sent_at, ?),
                       sent_via = CASE WHEN sent_via='' THEN ? ELSE sent_via END,
                       slug = CASE WHEN slug='' THEN ? ELSE slug END,
                       package = CASE WHEN package='' THEN ? ELSE package END,
                       amount_eur = COALESCE(amount_eur, ?),
                       url = CASE WHEN url='' THEN ? ELSE url END,
                       person_id = COALESCE(person_id, ?),
                       status = CASE WHEN status='draft' THEN 'sent' ELSE status END,
                       updated_at = ?
                   WHERE token=?""",
                (now, sent_via, slug, package, amount_eur, url, person_id, now, token),
            )
        else:
            con.execute(
                """INSERT INTO offers
                   (token, person_id, slug, package, amount_eur, url, sent_at, sent_via, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)""",
                (token, person_id, slug, package, amount_eur, url, now, sent_via, now, now),
            )
        # Pipeline-Stage setzen
        effective_pid = person_id or (existing["person_id"] if existing else None)
        if effective_pid:
            _offer_pipeline_apply(con, effective_pid, "angebot", "Auf Antwort warten")
        con.commit()
        row = con.execute("SELECT * FROM offers WHERE token=?", (token,)).fetchone()
    return {"ok": True, "offer": _offer_row(row)}


@router.post("/api/offers/status")
async def offers_status(req: Request):
    """Manueller Angebotsstatus aus der Pipeline.
    Body: {token? | id?, status}. Terminale Status entfernen die Karte aus
    der aktiven Angebotsspalte, sofern kein anderer aktiver Agent-Faden existiert.
    """
    data = await req.json()
    status = (data.get("status") or "").strip().lower()
    allowed = {"draft", "sent", "opened", "accepted", "declined", "lost", "archived", "paid", "duplicate"}
    if status not in allowed:
        return JSONResponse({"error": f"unknown offer status: {status}"}, status_code=400)
    token = (data.get("token") or "").strip().lower()
    offer_id = data.get("id")
    now = int(time.time())
    with _people_db() as con:
        if token:
            row = con.execute("SELECT * FROM offers WHERE token=?", (token,)).fetchone()
        elif offer_id:
            row = con.execute("SELECT * FROM offers WHERE id=?", (offer_id,)).fetchone()
        else:
            return JSONResponse({"error": "token or id required"}, status_code=400)
        if not row:
            return JSONResponse({"error": "offer not found"}, status_code=404)
        con.execute(
            "UPDATE offers SET status=?, updated_at=? WHERE id=?",
            (status, now, row["id"]),
        )
        pid = int(row["person_id"] or 0)
        if pid:
            if status in {"accepted", "paid"}:
                _offer_pipeline_apply(con, pid, "onboarding", "Rechnung schreiben")
            elif status in {"sent", "opened", "draft"}:
                _offer_pipeline_apply(con, pid, "angebot", "Auf Antwort warten")
            elif status in {"declined", "lost", "archived", "duplicate"}:
                other_active = con.execute(
                    """SELECT 1 FROM offers
                        WHERE person_id=?
                          AND id != ?
                          AND status NOT IN ('declined','lost','archived','duplicate')
                        LIMIT 1""",
                    (pid, row["id"]),
                ).fetchone()
                has_agent = con.execute(
                    "SELECT 1 FROM person_agents WHERE person_id=? LIMIT 1",
                    (pid,),
                ).fetchone()
                if not other_active and not has_agent:
                    _offer_pipeline_apply(con, pid, "abgeschlossen", "Angebot verloren/archiviert")
        con.commit()
        fresh = con.execute("SELECT * FROM offers WHERE id=?", (row["id"],)).fetchone()
    return {"ok": True, "offer": _offer_row(fresh)}


@router.post("/api/offers/sync")
async def offers_sync():
    """Liest events aus analytics.db, aggregiert pro slug-Pfad, schreibt
    opened_count + last_opened_at in offers. Idempotent."""
    if not _ANALYTICS_DB.exists():
        return {"ok": False, "reason": "analytics_db_missing"}
    # 1. Aggregat aus analytics.db
    agg: dict[str, dict] = {}
    with sqlite3.connect(_ANALYTICS_DB) as acon:
        acon.row_factory = sqlite3.Row
        for r in acon.execute(
            "SELECT path, COUNT(*) AS n, MAX(server_ts) AS last_ts "
            "FROM events WHERE path LIKE '/angebot/%' AND type='pageview' "
            "GROUP BY path"
        ).fetchall():
            p = r["path"].strip("/")
            parts = p.split("/")
            if len(parts) >= 2 and parts[0] == "angebot":
                slug = parts[1].lower()
                agg[slug] = {"count": r["n"], "last_ts": int(r["last_ts"] or 0)}
    # 2. In offers eintragen (matched per slug)
    now = int(time.time())
    updated = 0
    with _people_db() as con:
        for slug, info in agg.items():
            last_opened = info["last_ts"] // 1000 if info["last_ts"] else None
            cur = con.execute("SELECT id FROM offers WHERE slug=?", (slug,)).fetchone()
            if cur:
                con.execute(
                    """UPDATE offers
                       SET opened_count=?, last_opened_at=?, last_synced_at=?, updated_at=?,
                           status = CASE WHEN status='sent' AND ? > 0 THEN 'opened' ELSE status END
                       WHERE slug=?""",
                    (info["count"], last_opened, now, now, info["count"], slug),
                )
                updated += 1
        con.commit()
    return {"ok": True, "slugs": list(agg.keys()), "updated": updated}


@router.post("/api/offers/accept-webhook")
async def offers_accept_webhook(req: Request):
    """Wird vom example.com-Worker bei /_offer/accept aufgerufen (Auth via
    DENZER_ADMIN_TOKEN). Setzt accepted_at, status='accepted', schiebt
    Person-Pipeline auf 'angenommen' + Rechnung als next_step."""
    import os
    auth = req.headers.get("authorization", "")
    expected = os.environ.get("DENZER_ADMIN_TOKEN", "")
    if not expected or auth != f"Bearer {expected}":
        raise HTTPException(401, "unauthorized")
    data = await req.json()
    token = (data.get("token") or "").strip().lower()
    if not token:
        raise HTTPException(400, "token required")
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    amount_str = (data.get("amount") or "").strip()
    amount_eur = None
    try:
        amount_eur = int("".join(c for c in amount_str if c.isdigit())) if amount_str else None
    except Exception:
        amount_eur = None
    now = int(time.time())
    with _people_db() as con:
        row = con.execute("SELECT * FROM offers WHERE token=?", (token,)).fetchone()
        if not row:
            # Auto-create wenn unbekannt
            con.execute(
                """INSERT INTO offers (token, slug, accepted_at, accepted_name, accepted_email,
                   amount_eur, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)""",
                (token, token, now, name, email, amount_eur, now, now),
            )
        else:
            con.execute(
                """UPDATE offers SET accepted_at=?, accepted_name=?, accepted_email=?,
                   amount_eur = COALESCE(amount_eur, ?), status='accepted', updated_at=?
                   WHERE token=?""",
                (now, name, email, amount_eur, now, token),
            )
        offer = con.execute("SELECT * FROM offers WHERE token=?", (token,)).fetchone()
        pid = offer["person_id"]
        if pid:
            _offer_pipeline_apply(con, pid, "onboarding", "Rechnung schreiben")
        con.commit()
    return {"ok": True}
