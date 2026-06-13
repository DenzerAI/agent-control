"""Workshops — Anmeldungen, Teilnehmer und Counter aus people.db.

people.db ist die Single Source: jeder Lead aus dem Cloudflare-KV-Formular
fliesst via `lead_pipeline_sync` als Customer (`pipeline_stream='workshops'`,
`workshop_kind='ai-sprint'`) rein. Status (aktiv/pausiert) reflektiert
Absagen aus Mail und WhatsApp. Diese View liest nur — sie schreibt nichts.

Mai-Teilnehmer werden mit Feedback-/Booking-/Network-Flags aus dem KV
angereichert, weil das Workshop-Output ist (Tokens, Slots), nicht
Pipeline-Daten.

Cross-Deps: `db.get_db` (events nur für KV-Token-Anreicherung), `people.db`
direkt via sqlite3, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` für
Mai-Anreicherung + seats-Counter.
"""
from __future__ import annotations

import asyncio
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse


router = APIRouter()


_ROOT = Path(__file__).resolve().parent.parent.parent
_PEOPLE_DB = _ROOT / "data" / "people.db"
_CHAT_DB = _ROOT / "data" / "chat.db"

_WORKSHOPS_CACHE: dict[str, tuple[float, dict]] = {}
_WORKSHOPS_TTL = 30  # Sekunden
_WORKSHOPS_KV_NS = "47a39aafb60345078a5dacdb45325815"  # denzer-leads

_SOURCE_RE = re.compile(r"Workshop-Quelle:\s*([a-z0-9\-]+)", re.IGNORECASE)


# --------------------------------------------------------------------------- KV

async def _kv_list_keys(client: httpx.AsyncClient, prefix: str) -> list[str]:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        return []
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{_WORKSHOPS_KV_NS}/keys"
    out: list[str] = []
    cursor = ""
    while True:
        params = {"prefix": prefix, "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        r = await client.get(base, params=params, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        r.raise_for_status()
        d = r.json()
        out.extend([k["name"] for k in d.get("result", [])])
        cursor = d.get("result_info", {}).get("cursor", "")
        if not cursor:
            break
    return out


async def _kv_get(client: httpx.AsyncClient, key: str) -> dict | None:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        return None
    from urllib.parse import quote
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{_WORKSHOPS_KV_NS}/values/{quote(key, safe='')}"
    r = await client.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except Exception:
        return {"_raw": r.text}


async def _kv_get_int(client: httpx.AsyncClient, key: str) -> int:
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        return 0
    from urllib.parse import quote
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{_WORKSHOPS_KV_NS}/values/{quote(key, safe='')}"
    r = await client.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
    if r.status_code != 200:
        return 0
    try:
        return int(r.text.strip())
    except Exception:
        return 0


async def _fetch_mai_kv_tokens() -> dict[str, dict]:
    """{email_lower: {token, has_feedback, has_booking, network_interest}}.
    Holt KV-Daten für Mai-Teilnehmer, damit wir Workshop-Outputs an die
    people.db-Customers hängen können.
    """
    out: dict[str, dict] = {}
    async with httpx.AsyncClient() as client:
        participant_keys, feedback_keys, booking_keys, network_keys = await asyncio.gather(
            _kv_list_keys(client, "workshop:participant:"),
            _kv_list_keys(client, "workshop:feedback:"),
            _kv_list_keys(client, "workshop:booking:"),
            _kv_list_keys(client, "workshop:network:"),
        )
        feedback_tokens = {k.split(":", 2)[2] for k in feedback_keys if k.count(":") >= 2}
        booking_tokens = {k.split(":", 3)[2] for k in booking_keys if k.count(":") >= 3}
        network_tokens = {k.split(":", 2)[2] for k in network_keys if k.count(":") >= 2}

        async def fetch(k: str) -> dict | None:
            v = await _kv_get(client, k)
            return v if isinstance(v, dict) else None

        async def fetch_network(t: str) -> tuple[str, dict | None]:
            v = await _kv_get(client, f"workshop:network:{t}")
            return t, (v if isinstance(v, dict) else None)

        participants, network_pairs = await asyncio.gather(
            asyncio.gather(*(fetch(k) for k in participant_keys)),
            asyncio.gather(*(fetch_network(t) for t in network_tokens)),
        )
        network_lookup = {t: v for t, v in network_pairs if v}

        for k, p in zip(participant_keys, participants):
            if not p:
                continue
            token = k.split(":", 2)[2] if k.count(":") >= 2 else ""
            em = (p.get("email") or "").strip().lower()
            net = network_lookup.get(token) or {}
            entry = {
                "token": token,
                "has_feedback": token in feedback_tokens,
                "has_booking": token in booking_tokens,
                "network_interest": net.get("interest") if isinstance(net, dict) else None,
            }
            if em:
                out[em] = entry
    return out


# --------------------------------------------------------------------------- DB

def _load_workshops_customers() -> list[dict]:
    """Alle Workshops-Customers aus people.db. Customer-Felder liegen
    direkt als Spalten auf `people` (customer_status, customer_notes, …)."""
    if not _PEOPLE_DB.exists():
        return []
    out: list[dict] = []
    with sqlite3.connect(_PEOPLE_DB) as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            """SELECT id AS person_id, pipeline_stage, customer_status,
                      workshop_kind, lead_source, customer_notes,
                      created_at, updated_at,
                      name, email, phone, company
               FROM people
               WHERE pipeline_stream='workshops'
                 AND workshop_kind IS NOT NULL"""
        ).fetchall()
    for r in rows:
        out.append({
            "cid": r["person_id"],  # Kompat: cid war früher die customer-Row-ID
            "person_id": r["person_id"],
            "stage": r["pipeline_stage"] or "",
            "status": r["customer_status"] or "",
            "kind": r["workshop_kind"] or "",
            "lead_source": r["lead_source"] or "",
            "notes": r["customer_notes"] or "",
            "created_at": r["created_at"] or 0,
            "updated_at": r["updated_at"] or 0,
            "name": (r["name"] or "").strip(),
            "email": (r["email"] or "").strip(),
            "phone": (r["phone"] or "").strip(),
            "company": (r["company"] or "").strip(),
        })
    return out


def _load_form_extras() -> tuple[dict[str, dict], dict[str, dict]]:
    """Returns (by_email_lower, by_name_lower) → form-Extras.
    Quelle: chat.db.denzer_leads (Spiegel des KV). Brauchen wir, um die
    Formular-Felder (die nicht in people.db landen) für die Detail-Anzeige
    weiterhin zu haben. Match per Email primär, per Name fallback
    (Stamm-Email in people.db ≠ Formular-Email kommt vor).
    """
    by_email: dict[str, dict] = {}
    by_name: dict[str, dict] = {}
    if not _CHAT_DB.exists():
        return by_email, by_name
    import json as _json
    with sqlite3.connect(_CHAT_DB) as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            """SELECT name, email, ts_iso, level, tools, message,
                      seat_number, waitlist, confirmation_sent
               FROM denzer_leads
               WHERE source LIKE 'ai-sprint-%'"""
        ).fetchall()
    for r in rows:
        try:
            tools = _json.loads(r["tools"] or "[]")
            if not isinstance(tools, list):
                tools = []
        except Exception:
            tools = []
        entry = {
            "ts": r["ts_iso"] or "",
            "level": r["level"] or "",
            "tools": tools,
            "message": r["message"] or "",
            "seat": r["seat_number"],
            "waitlist": bool(r["waitlist"]),
            "confirmation_sent": bool(r["confirmation_sent"]),
        }
        em = (r["email"] or "").strip().lower()
        nm = (r["name"] or "").strip().lower()
        if em:
            by_email[em] = entry
        if nm:
            by_name[nm] = entry
    return by_email, by_name


def _extract_round(notes: str) -> str:
    """Letzte `Workshop-Quelle:`-Zeile aus den Notes."""
    last = ""
    for m in _SOURCE_RE.finditer(notes or ""):
        last = m.group(1).strip().lower()
    return last


def _absage_from_notes(notes: str) -> tuple[str, str]:
    """(date_iso, source) der letzten Absage-Spur in den Notes; sonst ('','')."""
    m = re.search(r"Abgesagt\s+(\d{4}-\d{2}-\d{2})\s*\(([^)]*)\)", notes or "")
    if m:
        return m.group(1), m.group(2)
    return "", ""


# --------------------------------------------------------------------------- Build

async def _build_workshops() -> dict:
    customers = _load_workshops_customers()
    form_by_email, form_by_name = _load_form_extras()

    # KV-Anreicherung parallel
    async with httpx.AsyncClient() as client:
        seats_juni_task = _kv_get_int(client, "seats:ai-sprint-2026-06")
        mai_tokens_task = _fetch_mai_kv_tokens()
        seats_juni, mai_tokens = await asyncio.gather(
            seats_juni_task, mai_tokens_task,
        )

    juni_active: list[dict] = []
    juni_cancelled: list[dict] = []
    mai_participants: list[dict] = []

    for c in customers:
        round_id = _extract_round(c["notes"])
        # Fallback: durchgefuehrt + ai-sprint ohne Round = Mai-Pilot
        if not round_id and c["stage"] == "durchgefuehrt" and c["kind"] == "ai-sprint":
            round_id = "ai-sprint-2026-05-06"

        is_mai = round_id.startswith("ai-sprint-2026-05")
        is_juni = round_id.startswith("ai-sprint-2026-06")
        if not (is_mai or is_juni):
            continue

        em = c["email"].lower()
        nm = c["name"].lower()
        fx = form_by_email.get(em) or form_by_name.get(nm) or {}
        common = {
            "person_id": c["person_id"],
            "name": c["name"],
            "email": c["email"],
            "phone": c["phone"],
            "company": c["company"],
            "stage": c["stage"],
            "status": c["status"],
            "ts": fx.get("ts", ""),
            "tools": fx.get("tools", []),
            "level": fx.get("level", ""),
            "message": fx.get("message", ""),
            "seat": fx.get("seat"),
            "waitlist": fx.get("waitlist", False),
            "confirmation_sent": fx.get("confirmation_sent", c["stage"] in ("anmeldung", "gebucht", "durchgefuehrt")),
        }

        if is_juni:
            if c["status"] == "pausiert":
                d_iso, d_src = _absage_from_notes(c["notes"])
                juni_cancelled.append({**common, "cancelled_at": d_iso, "cancelled_source": d_src})
            else:
                juni_active.append(common)
        else:  # mai
            tok = mai_tokens.get(em) or {}
            mai_participants.append({
                **common,
                "token": tok.get("token", ""),
                "has_feedback": bool(tok.get("has_feedback")),
                "has_booking": bool(tok.get("has_booking")),
                "network_interest": tok.get("network_interest"),
            })

    juni_active.sort(key=lambda r: r["ts"])
    juni_cancelled.sort(key=lambda r: r["ts"])
    mai_participants.sort(key=lambda r: r["name"].lower())

    juni_taken = max(0, seats_juni - len(juni_cancelled))
    juni = {
        "id": "ai-sprint-2026-06",
        "label": "AI Sprint · 10. Juni 2026",
        "subtitle": "",
        "status": "open",
        "total_seats": 10,
        "taken": juni_taken,
        "remaining": max(0, 10 - juni_taken),
        "registrations": juni_active,
        "cancellations": juni_cancelled,
    }
    mai = {
        "id": "ai-sprint-2026-05",
        "label": "AI Sprint · 6. Mai 2026",
        "subtitle": "",
        "status": "done",
        "total_seats": 10,
        "taken": len([p for p in mai_participants if p["status"] != "pausiert"]),
        "remaining": 0,
        "participants": mai_participants,
    }

    return {"rounds": [juni, mai]}


@router.get("/api/workshops")
async def workshops_list(refresh: bool = False):
    now = time.time()
    cached = _WORKSHOPS_CACHE.get("data")
    if not refresh and cached and (now - cached[0]) < _WORKSHOPS_TTL:
        return JSONResponse(cached[1])
    try:
        data = await _build_workshops()
    except Exception as e:
        if cached:
            return JSONResponse({**cached[1], "_stale": True, "_error": str(e)[:200]})
        return JSONResponse({"error": str(e)[:300], "rounds": []}, status_code=502)
    _WORKSHOPS_CACHE["data"] = (now, data)
    return JSONResponse(data)
