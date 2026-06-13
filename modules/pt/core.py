"""Personal Training — Helper + HTTP-Routen.

Vorher: ~310 Zeilen in `backend/server.py` (Helper bei 4910, Hauptblock bei
4954–5223, plus zwei verstreute Routen bei 5464–5538). `_pt_card_remaining`
lebte zwischenzeitlich in `modules/calendar/core.py` und ist jetzt hier zentral.

Cross-Deps:
- `from modules.people.core import _people_db` (PT-Daten leben in people.db)
- `from db import get_db, create_conversation` (Chat-Conversations pro Kunde)
"""
from __future__ import annotations

from collections import defaultdict
import time
from datetime import datetime

from fastapi import APIRouter, Request, Body
from fastapi.responses import JSONResponse

from db import get_db, create_conversation, calendar_create
from modules.people.core import _people_db


router = APIRouter()


# ── Helper ───────────────────────────────────────────────────────────────

def _pt_appt_to_dict(r) -> dict:
    start_iso = f"{r['date']}T{r['start_time']}:00"
    return {
        "id": r["id"],
        "personId": r["person_id"],
        "personName": r["person_name"] if "person_name" in r.keys() else None,
        "startIso": start_iso,
        "date": r["date"],
        "startTime": r["start_time"],
        "durationMin": r["duration_min"],
        "trainingType": r["training_type"],
        "status": r["status"],
        "cancelledBy": r["cancelled_by"],
        "cancellationReason": r["cancellation_reason"],
        "cancelledAt": r["cancelled_at"],
        "seriesKey": r["series_key"],
        "cardId": r["card_id"],
        "rescheduledFromId": r["rescheduled_from_id"],
        "notes": r["notes"] or "",
    }


def _pt_load_appt(con, appt_id: int) -> dict | None:
    row = con.execute(
        """
        SELECT a.*, p.name AS person_name FROM pt_appointments a
        JOIN people p ON p.id = a.person_id WHERE a.id = ?
        """,
        (appt_id,),
    ).fetchone()
    return _pt_appt_to_dict(row) if row else None


def _pt_active_card(con, person_id: int):
    return con.execute(
        """
        SELECT id, total_sessions, used_sessions FROM pt_cards
        WHERE person_id = ? AND status = 'active'
        ORDER BY id ASC LIMIT 1
        """,
        (person_id,),
    ).fetchone()


def _pt_editable_card(con, person_id: int):
    card = _pt_active_card(con, person_id)
    if card:
        return card
    return con.execute(
        """
        SELECT id, total_sessions, used_sessions FROM pt_cards
        WHERE person_id = ? AND status = 'completed'
        ORDER BY id DESC LIMIT 1
        """,
        (person_id,),
    ).fetchone()


def _pt_reserved_sessions(con, person_id: int) -> int:
    today = datetime.now().strftime("%Y-%m-%d")
    row = con.execute(
        """
        SELECT COUNT(*) AS reserved
        FROM pt_appointments
        WHERE person_id = ? AND status = 'scheduled' AND date >= ?
        """,
        (person_id, today),
    ).fetchone()
    if not row:
        return 0
    return max(0, int(row["reserved"] or 0))


def _pt_card_remaining(con, person_id: int) -> int | None:
    card = _pt_editable_card(con, person_id)
    if not card:
        return None
    total = int(card["total_sessions"] or 0)
    used = int(card["used_sessions"] or 0)
    reserved = _pt_reserved_sessions(con, person_id)
    return max(0, total - used - reserved)


def _pt_active_card_snapshot(con, person_id: int) -> dict | None:
    card = _pt_editable_card(con, person_id)
    if not card:
        return None
    total = int(card["total_sessions"] or 0)
    used = int(card["used_sessions"] or 0)
    reserved = _pt_reserved_sessions(con, person_id)
    remaining = max(0, total - used - reserved)
    return {
        "id": int(card["id"]),
        "totalSessions": total,
        "usedSessions": used,
        "reservedSessions": reserved,
        "remainingSessions": remaining,
    }


def _pt_restore_sessions_for_rows(con, rows, now: int) -> int:
    restore_by_card: dict[int, int] = defaultdict(int)
    for r in rows:
        if (r["status"] or "") == "done" and r["card_id"]:
            restore_by_card[int(r["card_id"])] += 1
    for card_id, restore_count in restore_by_card.items():
        card = con.execute(
            "SELECT id, total_sessions, used_sessions FROM pt_cards WHERE id = ?",
            (card_id,),
        ).fetchone()
        if not card:
            continue
        total = int(card["total_sessions"] or 0)
        used = max(0, int(card["used_sessions"] or 0) - restore_count)
        status = "completed" if total > 0 and used >= total else "active"
        con.execute(
            "UPDATE pt_cards SET used_sessions = ?, status = ?, updated_at = ? WHERE id = ?",
            (used, status, now, card_id),
        )
    return sum(restore_by_card.values())


# ── Routen ───────────────────────────────────────────────────────────────

@router.get("/api/pt/profile/{person_id}")
async def pt_profile_get(person_id: int):
    """Komplettes PT-Profil eines Kunden: Karten, naechste Termine, Historie."""
    with _people_db() as con:
        person = con.execute(
            "SELECT id, name, phone, email FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        if not person:
            return JSONResponse({"error": "person not found"}, status_code=404)
        cards = [dict(r) for r in con.execute(
            "SELECT * FROM pt_cards WHERE person_id = ? ORDER BY status ASC, id DESC",
            (person_id,),
        ).fetchall()]
        today = datetime.now().strftime("%Y-%m-%d")
        upcoming = [dict(r) for r in con.execute(
            """
            SELECT * FROM pt_appointments
            WHERE person_id = ? AND date >= ? AND status IN ('scheduled')
            ORDER BY date, start_time LIMIT 50
            """,
            (person_id, today),
        ).fetchall()]
        history = [dict(r) for r in con.execute(
            """
            SELECT * FROM pt_appointments
            WHERE person_id = ? AND (date < ? OR status != 'scheduled')
            ORDER BY date DESC, start_time DESC LIMIT 30
            """,
            (person_id, today),
        ).fetchall()]
        remaining = _pt_card_remaining(con, person_id)
    return {
        "person": dict(person),
        "remaining": remaining,
        "cards": cards,
        "upcoming": upcoming,
        "history": history,
    }


@router.post("/api/pt/appointment")
async def pt_appt_create(req: Request):
    """Neuen PT-Termin anlegen. Body: { personId, date, startTime, durationMin?,
    trainingType?, notes?, repeatWeekly?: int (Anzahl Folge-Wochen) }"""
    body = await req.json() or {}
    person_id = int(body.get("personId") or 0)
    date = (body.get("date") or "").strip()
    start_time = (body.get("startTime") or "").strip()
    if not (person_id and date and start_time):
        return JSONResponse({"error": "personId, date, startTime noetig"}, status_code=400)
    duration = int(body.get("durationMin") or 60)
    training = (body.get("trainingType") or "personal_training").strip()
    notes = (body.get("notes") or "").strip()
    repeat = max(0, min(int(body.get("repeatWeekly") or 0), 26))
    now = int(time.time())
    series_key = None
    if repeat > 0:
        series_key = f"local-{now}-{person_id}"
    created_ids: list[int] = []
    with _people_db() as con:
        from datetime import date as _d, timedelta as _td
        try:
            base = _d.fromisoformat(date)
        except Exception:
            return JSONResponse({"error": "date Format YYYY-MM-DD"}, status_code=400)
        for i in range(repeat + 1):
            d = (base + _td(days=7 * i)).isoformat()
            cur = con.execute(
                """
                INSERT INTO pt_appointments
                  (person_id, date, start_time, duration_min, training_type,
                   series_key, status, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
                """,
                (person_id, d, start_time, duration, training, series_key, notes, now, now),
            )
            created_ids.append(cur.lastrowid)
        con.commit()
    return {"ok": True, "ids": created_ids, "seriesKey": series_key}


@router.patch("/api/pt/appointment/{appt_id}")
async def pt_appt_patch(appt_id: int, req: Request):
    """PT-Termin updaten. Body: { date?, startTime?, durationMin?, notes?, personId? }"""
    body = await req.json() or {}
    fields: dict = {}
    if "date" in body and body["date"]:
        fields["date"] = body["date"].strip()
    if "startTime" in body and body["startTime"]:
        fields["start_time"] = body["startTime"].strip()
    if "durationMin" in body and body["durationMin"]:
        fields["duration_min"] = int(body["durationMin"])
    if "notes" in body:
        fields["notes"] = (body.get("notes") or "").strip()
    if "personId" in body:
        try:
            person_id = int(body.get("personId") or 0)
        except Exception:
            return JSONResponse({"error": "personId ungueltig"}, status_code=400)
        if person_id <= 0:
            return JSONResponse({"error": "personId noetig"}, status_code=400)
        fields["person_id"] = person_id
    if "trainingType" in body and body.get("trainingType"):
        training = (body.get("trainingType") or "").strip().lower()
        if training not in ("personal_training", "ems"):
            return JSONResponse({"error": "trainingType ungueltig"}, status_code=400)
        fields["training_type"] = training
    if not fields:
        return JSONResponse({"error": "keine Aenderung"}, status_code=400)
    fields["updated_at"] = int(time.time())
    sets = ", ".join(f"{k} = ?" for k in fields)
    with _people_db() as con:
        res = con.execute(
            f"UPDATE pt_appointments SET {sets} WHERE id = ?",
            (*fields.values(), appt_id),
        )
        con.commit()
        if res.rowcount == 0:
            return JSONResponse({"error": "not found"}, status_code=404)
        appt = _pt_load_appt(con, appt_id)
    return {"ok": True, "appointment": appt}


@router.post("/api/pt/appointment/{appt_id}/convert-to-calendar")
async def pt_appt_convert_to_calendar(appt_id: int, req: Request):
    """Wandelt einen PT-Termin in einen normalen lokalen Kalendereintrag um."""
    body = await req.json() or {}
    now = int(time.time())
    with _people_db() as con:
        row = con.execute(
            """
            SELECT a.*, p.name AS person_name
            FROM pt_appointments a
            JOIN people p ON p.id = a.person_id
            WHERE a.id = ?
            """,
            (appt_id,),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        start_iso = (body.get("startIso") or f"{row['date']}T{row['start_time']}:00").strip()
        title = (body.get("title") or row["person_name"] or "Termin").strip()
        notes = (body.get("notes") if "notes" in body else row["notes"] or "").strip()
        location = (body.get("location") or "").strip()
        label = (body.get("label") or "").strip()[:8]
        rrule = (body.get("rrule") or "").strip().lower()
        if rrule not in ("", "daily", "weekly", "monthly"):
            rrule = ""
        rrule_until = (body.get("rruleUntil") or "").strip()
        category = (body.get("category") or "klaus").strip().lower()
        if category == "ptdesk" or category not in {"klaus", "privat", "fch", "ai-workshop", "ai-agent", "ai-beratung"}:
            category = "klaus"
        try:
            duration = max(5, int(body.get("durationMin") or row["duration_min"] or 60))
        except Exception:
            duration = int(row["duration_min"] or 60)
        try:
            person_id = int(body.get("personId") or row["person_id"] or 0) or None
        except Exception:
            person_id = int(row["person_id"] or 0) or None
        restored = _pt_restore_sessions_for_rows(con, [row], now)
        con.execute("DELETE FROM pt_appointments WHERE id = ?", (appt_id,))
        con.commit()
    event = calendar_create(
        start_iso,
        duration,
        title,
        notes,
        location,
        label,
        rrule,
        rrule_until,
        category,
        all_day=False,
        person_id=person_id,
    )
    return {"ok": True, "event": event, "restoredSessions": restored}


@router.post("/api/pt/appointment/{appt_id}/cancel")
async def pt_appt_cancel(appt_id: int, req: Request):
    """Termin absagen. Body: { by: 'customer'|'trainer', reason? }"""
    body = await req.json() or {}
    by = (body.get("by") or "trainer").strip()
    if by not in ("customer", "trainer"):
        return JSONResponse({"error": "by muss customer|trainer sein"}, status_code=400)
    reason = (body.get("reason") or "").strip()
    now = int(time.time())
    status = "cancelled_by_customer" if by == "customer" else "cancelled_by_trainer"
    with _people_db() as con:
        row = con.execute("SELECT id, status FROM pt_appointments WHERE id = ?", (appt_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        con.execute(
            """
            UPDATE pt_appointments SET status = ?, cancelled_by = ?,
              cancellation_reason = ?, cancelled_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, by, reason, now, now, appt_id),
        )
        con.commit()
        appt = _pt_load_appt(con, appt_id)
    return {"ok": True, "appointment": appt}


@router.post("/api/pt/appointment/{appt_id}/uncancel")
async def pt_appt_uncancel(appt_id: int):
    """Absage rueckgaengig — Termin zurueck auf scheduled."""
    now = int(time.time())
    with _people_db() as con:
        res = con.execute(
            """
            UPDATE pt_appointments SET status = 'scheduled', cancelled_by = NULL,
              cancellation_reason = NULL, cancelled_at = NULL, updated_at = ?
            WHERE id = ?
            """,
            (now, appt_id),
        )
        con.commit()
        if res.rowcount == 0:
            return JSONResponse({"error": "not found"}, status_code=404)
        appt = _pt_load_appt(con, appt_id)
    return {"ok": True, "appointment": appt}


@router.post("/api/pt/appointment/{appt_id}/complete")
async def pt_appt_complete(appt_id: int):
    """Termin als gelaufen markieren, zieht 1 Einheit von aktiver Karte falls vorhanden."""
    now = int(time.time())
    with _people_db() as con:
        row = con.execute(
            "SELECT id, person_id, status, card_id FROM pt_appointments WHERE id = ?",
            (appt_id,),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        card_id = row["card_id"]
        if not card_id:
            card = _pt_active_card(con, row["person_id"])
            if card:
                card_id = card["id"]
                used_new = (card["used_sessions"] or 0) + 1
                new_status = "completed" if used_new >= (card["total_sessions"] or 0) else "active"
                con.execute(
                    "UPDATE pt_cards SET used_sessions = ?, status = ?, updated_at = ? WHERE id = ?",
                    (used_new, new_status, now, card_id),
                )
        con.execute(
            "UPDATE pt_appointments SET status = 'done', card_id = ?, updated_at = ? WHERE id = ?",
            (card_id, now, appt_id),
        )
        con.commit()
        appt = _pt_load_appt(con, appt_id)
        remaining = _pt_card_remaining(con, row["person_id"])
    return {"ok": True, "appointment": appt, "remaining": remaining}


@router.post("/api/pt/appointment/{appt_id}/uncomplete")
async def pt_appt_uncomplete(appt_id: int):
    """'Gelaufen' rueckgaengig — gibt Einheit zurueck auf Karte."""
    now = int(time.time())
    with _people_db() as con:
        row = con.execute(
            "SELECT id, person_id, status, card_id FROM pt_appointments WHERE id = ?",
            (appt_id,),
        ).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        if row["card_id"]:
            con.execute(
                """
                UPDATE pt_cards SET used_sessions = MAX(0, used_sessions - 1),
                  status = 'active', updated_at = ? WHERE id = ?
                """,
                (now, row["card_id"]),
            )
        con.execute(
            "UPDATE pt_appointments SET status = 'scheduled', card_id = NULL, updated_at = ? WHERE id = ?",
            (now, appt_id),
        )
        con.commit()
        appt = _pt_load_appt(con, appt_id)
        remaining = _pt_card_remaining(con, row["person_id"])
    return {"ok": True, "appointment": appt, "remaining": remaining}


@router.post("/api/pt/customer/{person_id}/remaining")
async def pt_customer_set_remaining(person_id: int, req: Request):
    """Frei verfuegbare Restkarten der aktiven Karte direkt setzen.
    Existiert keine Karte oder hat sie kein Volumen, wird sie passend
    aufgestockt: total = reserved + remaining, used = 0."""
    body = await req.json() or {}
    raw_remaining = body.get("remaining")
    if raw_remaining is None:
        raw_remaining = body.get("remainingSessions")
    if raw_remaining is None:
        return JSONResponse({"error": "remaining erforderlich"}, status_code=400)
    try:
        remaining = max(0, int(raw_remaining))
    except Exception:
        return JSONResponse({"error": "remaining muss Zahl sein"}, status_code=400)
    now = int(time.time())
    with _people_db() as con:
        card = _pt_editable_card(con, person_id)
        reserved = _pt_reserved_sessions(con, person_id)
        need_total = reserved + remaining
        if not card:
            today = datetime.now().strftime("%Y-%m-%d")
            con.execute(
                """
                INSERT INTO pt_cards
                  (person_id, start_date, total_sessions, used_sessions, payment_status, status, created_at, updated_at)
                VALUES (?, ?, ?, 0, 'pending', 'active', ?, ?)
                """,
                (person_id, today, need_total, now, now),
            )
        else:
            total = int(card["total_sessions"] or 0)
            if total < need_total:
                total = need_total
            used = max(0, total - reserved - remaining)
            status = "completed" if total > 0 and used >= total else "active"
            con.execute(
                "UPDATE pt_cards SET total_sessions = ?, used_sessions = ?, status = ?, updated_at = ? WHERE id = ?",
                (total, used, status, now, card["id"]),
            )
        con.commit()
        snap = _pt_active_card_snapshot(con, person_id)
    return {"ok": True, "remaining": snap["remainingSessions"] if snap else None, "card": snap}


@router.post("/api/pt/customer/{person_id}/card")
async def pt_customer_update_card(person_id: int, req: Request):
    """Bearbeitet die aktuell sichtbare PT-Karte direkt oder legt sie bei Bedarf an."""
    body = await req.json() or {}
    now = int(time.time())
    with _people_db() as con:
        card = _pt_editable_card(con, person_id)
        if not card:
            raw_total = body.get("totalSessions")
            if raw_total in (None, ""):
                total = 10
            else:
                try:
                    total = max(0, int(raw_total))
                except Exception:
                    return JSONResponse({"error": "totalSessions ungueltig"}, status_code=400)
            raw_price = body.get("priceEur")
            if raw_price in (None, ""):
                price = None
            else:
                try:
                    price = max(0, int(raw_price))
                except Exception:
                    return JSONResponse({"error": "priceEur ungueltig"}, status_code=400)
            method = ((body.get("paymentMethod") or "").strip() or None)
            pay_status = ((body.get("paymentStatus") or "pending").strip() or "pending")
            notes = (body.get("notes") or "").strip()
            today = datetime.now().strftime("%Y-%m-%d")
            con.execute(
                """
                INSERT INTO pt_cards
                  (person_id, start_date, total_sessions, used_sessions, price_eur,
                   payment_method, payment_status, status, notes, created_at, updated_at)
                VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?, ?, ?)
                """,
                (person_id, today, total, price, method, pay_status, notes, now, now),
            )
            con.commit()
            return await pt_customer_get(str(person_id))
        full = con.execute("SELECT * FROM pt_cards WHERE id = ?", (card["id"],)).fetchone()
        if not full:
            return JSONResponse({"error": "keine Karte"}, status_code=404)
        total = int(full["total_sessions"] or 0)
        used = int(full["used_sessions"] or 0)
        price = full["price_eur"]
        method = full["payment_method"]
        pay_status = (full["payment_status"] or "pending").strip() or "pending"
        notes = (full["notes"] or "").strip()

        if "totalSessions" in body:
            try:
                total = max(0, int(body.get("totalSessions") or 0))
            except Exception:
                return JSONResponse({"error": "totalSessions ungueltig"}, status_code=400)
            used = min(used, total)
        if "priceEur" in body:
            raw = body.get("priceEur")
            if raw in (None, ""):
                price = None
            else:
                try:
                    price = max(0, int(raw))
                except Exception:
                    return JSONResponse({"error": "priceEur ungueltig"}, status_code=400)
        if "paymentMethod" in body:
            method = ((body.get("paymentMethod") or "").strip() or None)
        if "paymentStatus" in body:
            pay_status = ((body.get("paymentStatus") or "").strip() or "pending")
        if "notes" in body:
            notes = (body.get("notes") or "").strip()

        status = "completed" if total > 0 and used >= total else "active"
        con.execute(
            """
            UPDATE pt_cards
               SET total_sessions = ?, used_sessions = ?, price_eur = ?,
                   payment_method = ?, payment_status = ?, notes = ?,
                   status = ?, updated_at = ?
             WHERE id = ?
            """,
            (total, used, price, method, pay_status, notes, status, now, full["id"]),
        )
        con.commit()
    return await pt_customer_get(str(person_id))


@router.delete("/api/pt/appointment/{appt_id}")
async def pt_appt_delete(appt_id: int, scope: str = "single"):
    """Termin loeschen. scope=single (Default) oder scope=series (alle zukuenftigen der Serie ab diesem Datum)."""
    with _people_db() as con:
        row = con.execute(
            "SELECT id, series_key, date FROM pt_appointments WHERE id = ?", (appt_id,)
        ).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        delete_rows = []
        if scope == "series" and row["series_key"]:
            delete_rows = con.execute(
                "SELECT id, status, card_id FROM pt_appointments WHERE series_key = ? AND date >= ?",
                (row["series_key"], row["date"]),
            ).fetchall()
            con.execute("DELETE FROM pt_appointments WHERE series_key = ? AND date >= ?", (row["series_key"], row["date"]))
        else:
            delete_rows = con.execute(
                "SELECT id, status, card_id FROM pt_appointments WHERE id = ?",
                (appt_id,),
            ).fetchall()
            con.execute("DELETE FROM pt_appointments WHERE id = ?", (appt_id,))
        now = int(time.time())
        restored = _pt_restore_sessions_for_rows(con, delete_rows, now)
        con.commit()
    return {"ok": True, "restoredSessions": restored}


@router.post("/api/pt/card")
async def pt_card_create(req: Request):
    """Neue Karte fuer Kunden anlegen. Body: { personId, totalSessions?, priceEur?,
    paymentMethod?, paymentStatus? }"""
    body = await req.json() or {}
    person_id = int(body.get("personId") or 0)
    if not person_id:
        return JSONResponse({"error": "personId noetig"}, status_code=400)
    total = int(body.get("totalSessions") or 10)
    price = body.get("priceEur")
    method = (body.get("paymentMethod") or "").strip() or None
    pay_status = (body.get("paymentStatus") or "pending").strip()
    notes = (body.get("notes") or "").strip()
    now = int(time.time())
    today = datetime.now().strftime("%Y-%m-%d")
    with _people_db() as con:
        cur = con.execute(
            """
            INSERT INTO pt_cards
              (person_id, start_date, total_sessions, used_sessions, price_eur,
               payment_method, payment_status, status, notes, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?, ?, ?)
            """,
            (person_id, today, total, price, method, pay_status, notes, now, now),
        )
        con.commit()
        card_id = cur.lastrowid
    return {"ok": True, "cardId": card_id}


@router.post("/api/pt/customer-conversation")
async def pt_customer_conversation(payload: dict = Body(...)):
    """Findet oder erstellt eine persistente Chat-Conversation pro PT-Kunde.
    Body: {customer_id, customer_name?}. Antwort: {conv_id, created}."""
    cid = (payload.get("customer_id") or "").strip()
    name = (payload.get("customer_name") or "").strip()
    if not cid:
        return JSONResponse({"error": "customer_id erforderlich"}, status_code=400)
    with get_db() as db:
        row = db.execute("SELECT conv_id FROM pt_customer_conv WHERE customer_id = ?", (cid,)).fetchone()
        if row:
            conv_id = row[0]
            conv_row = db.execute("SELECT id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            if conv_row:
                return {"conv_id": conv_id, "created": False}
            db.execute("DELETE FROM pt_customer_conv WHERE customer_id = ?", (cid,))
    title = f"PT · {name[:60]}" if name else f"PT · {cid[:12]}"
    conv_id = create_conversation("main", "", title, "claude")
    ts = time.time()
    with get_db() as db:
        db.execute(
            "INSERT INTO pt_customer_conv (customer_id, customer_name, conv_id, created_at) VALUES (?, ?, ?, ?)",
            (cid, name, conv_id, ts),
        )
    return {"conv_id": conv_id, "created": True}


@router.get("/api/pt/customer")
async def pt_customer_get(customer_id: str = ""):
    """Liefert Kunden-Stammdaten aus der lokalen DB.
    customer_id kann numerische person_id oder (Legacy) PT-Desk-ID sein."""
    cid = (customer_id or "").strip()
    if not cid:
        return JSONResponse({"error": "customer_id erforderlich"}, status_code=400)
    with _people_db() as con:
        if cid.isdigit():
            person = con.execute(
                "SELECT id, name, email, phone, whatsapp_chat_id, birthday, notes FROM people WHERE id = ?",
                (int(cid),),
            ).fetchone()
        else:
            person = con.execute(
                "SELECT id, name, email, phone, whatsapp_chat_id, birthday, notes FROM people WHERE ptdesk_id = ?",
                (cid,),
            ).fetchone()
        if not person:
            return JSONResponse({"error": "not found"}, status_code=404)
        pid = person["id"]
        cards = [dict(r) for r in con.execute(
            "SELECT * FROM pt_cards WHERE person_id = ? ORDER BY status, id DESC", (pid,),
        ).fetchall()]
        active = next((c for c in cards if c["status"] == "active"), None)
        editable = active or next((c for c in cards if c["status"] == "completed"), None)
        remaining = _pt_card_remaining(con, pid)
        total_purchased = sum(int(c.get("total_sessions") or 0) for c in cards)
        payment_status = (editable or {}).get("payment_status") or "—"
    return {
        "customer": {
            "id": pid,
            "name": person["name"],
            "email": person["email"] or "",
            "phone": person["phone"] or "",
            "whatsapp_chat_id": person["whatsapp_chat_id"] or "",
            "notes": person["notes"] or "",
            "remaining_sessions": remaining,
            "active_card_id": editable["id"] if editable else None,
            "active_card_total_sessions": int(editable["total_sessions"] or 0) if editable else None,
            "active_card_used_sessions": int(editable["used_sessions"] or 0) if editable else None,
            "total_cards_purchased": total_purchased,
            "price_eur": editable.get("price_eur") if editable else None,
            "payment_method": editable.get("payment_method") if editable else "",
            "payment_status": payment_status,
            "billing_model": "card_based" if cards else "",
            "customer_since": (cards[-1]["start_date"] if cards else None),
            "cards": cards,
        }
    }
