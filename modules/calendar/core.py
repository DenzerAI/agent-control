"""Calendar-Schublade: lokale manuelle Events + PT-Termine.

Vorher: 872 Zeilen Block in `backend/server.py` (7507-8378) plus
`backend/google_calendar.py` (193 Zeilen Provider). Jetzt isoliert.

Cross-Deps:
- `from db import calendar_*, get_db, DB_PATH` (schon vorher vorhanden)
- `from backend import entities as _entities` (Mention-Tagging)
- `_people_db()` definieren wir lokal (gleiche people.db wie server.py)
"""
from __future__ import annotations

import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from db import (
    calendar_list, calendar_create, calendar_update, calendar_delete,
    calendar_set_gcal_id, calendar_get_gcal_id, calendar_get_gcal_ref,
    get_db, DB_PATH,
)

# backend/ ins sys.path damit `from backend import entities` klappt
_REPO_ROOT = str(Path(__file__).parent.parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from backend import entities as _entities  # noqa: E402


router = APIRouter()


PEOPLE_DB = Path.home() / "agent/data/people.db"


def _people_db():
    con = sqlite3.connect(PEOPLE_DB)
    con.row_factory = sqlite3.Row
    return con


# ── Calendar: manuelle Events ──


def _expand_manual_events(rows: list[dict], from_iso: str, to_iso: str) -> list[dict]:
    """Expandiert Serientermine in Einzelinstanzen innerhalb [from, to). Ohne Filter: nur Originale."""
    from datetime import date as _date, datetime as _dt, timedelta as _td
    if not from_iso or not to_iso:
        return rows
    try:
        rng_from = _date.fromisoformat(from_iso)
        rng_to = _date.fromisoformat(to_iso)
    except Exception:
        return rows
    out: list[dict] = []
    for r in rows:
        rrule = (r.get("rrule") or "").strip().lower()
        start_iso = r.get("startIso") or ""
        if not start_iso:
            continue
        try:
            base_dt = _dt.fromisoformat(start_iso)
        except Exception:
            continue
        base_d = base_dt.date()
        time_part = start_iso[10:] if len(start_iso) > 10 else "T00:00:00"
        if rrule not in ("daily", "weekly", "monthly"):
            if rng_from <= base_d < rng_to:
                out.append(r)
            continue
        until_str = (r.get("rruleUntil") or "").strip()
        until_d = None
        if until_str:
            try:
                until_d = _date.fromisoformat(until_str)
            except Exception:
                until_d = None
        # Iteriere ab max(base_d, rng_from) bis min(rng_to, until+1)
        cur = base_d
        # springe schnell vorwärts statt Tag für Tag wenn weit zurück
        if rrule == "daily" and cur < rng_from:
            cur = rng_from
        elif rrule == "weekly" and cur < rng_from:
            delta_days = (rng_from - cur).days
            weeks = delta_days // 7
            cur = cur + _td(days=weeks * 7)
            while cur < rng_from:
                cur = cur + _td(days=7)
        elif rrule == "monthly" and cur < rng_from:
            # vorsichtig pro Monat
            while cur < rng_from:
                y = cur.year + (cur.month // 12)
                m = (cur.month % 12) + 1
                try:
                    cur = cur.replace(year=y, month=m)
                except ValueError:
                    # z.B. 31. → kürzerer Monat: nimm letzten Tag
                    import calendar as _cal
                    last = _cal.monthrange(y, m)[1]
                    cur = _date(y, m, min(cur.day, last))
        guard = 0
        while cur < rng_to and guard < 800:
            guard += 1
            if until_d and cur > until_d:
                break
            if cur >= max(base_d, rng_from):
                inst = dict(r)
                inst["id"] = f"{r['id']}@{cur.isoformat()}"
                inst["startIso"] = f"{cur.isoformat()}{time_part}"
                inst["recurringParentId"] = r["id"]
                out.append(inst)
            if rrule == "daily":
                cur = cur + _td(days=1)
            elif rrule == "weekly":
                cur = cur + _td(days=7)
            else:  # monthly
                y = cur.year + (cur.month // 12)
                m = (cur.month % 12) + 1
                try:
                    cur = cur.replace(year=y, month=m)
                except ValueError:
                    import calendar as _cal
                    last = _cal.monthrange(y, m)[1]
                    cur = _date(y, m, min(cur.day, last))
    return out


# `_pt_card_remaining` lebt seit der PT-Schublade in modules.pt.core
from modules.pt.core import _pt_active_card_snapshot, _pt_card_remaining  # noqa: E402


def _pt_load_events(from_iso: str, to_iso: str) -> list[dict]:
    """Liest pt_appointments aus unserer DB im Zeitraum [from, to)."""
    with _people_db() as con:
        sql = """
            SELECT a.id, a.person_id, a.date, a.start_time, a.duration_min,
                   a.training_type, a.status, a.cancelled_by, a.cancellation_reason,
                   a.notes, a.series_key, a.card_id, a.gcal_event_id,
                   p.name AS person_name
            FROM pt_appointments a
            JOIN people p ON p.id = a.person_id
            WHERE COALESCE(a.status, 'scheduled') NOT LIKE 'cancelled%'
        """
        params: list = []
        if from_iso:
            sql += " AND a.date >= ?"
            params.append(from_iso)
        if to_iso:
            sql += " AND a.date < ?"
            params.append(to_iso)
        rows = con.execute(sql + " ORDER BY a.date, a.start_time", params).fetchall()
        remaining_cache: dict[int, int | None] = {}
        active_card_cache: dict[int, dict | None] = {}
        events: list[dict] = []
        for r in rows:
            pid = r["person_id"]
            if pid not in remaining_cache:
                remaining_cache[pid] = _pt_card_remaining(con, pid)
                active_card_cache[pid] = _pt_active_card_snapshot(con, pid)
            start_iso = f"{r['date']}T{r['start_time']}:00"
            active_card = active_card_cache[pid]
            events.append({
                "id": f"pt-{r['id']}",
                "ptId": r["id"],
                "source": "ptdesk",
                "category": "ptdesk",
                "rrule": "weekly" if r["series_key"] else "",
                "startIso": start_iso,
                "durationMin": r["duration_min"] or 60,
                "title": r["person_name"],
                "personName": r["person_name"],
                "notes": r["notes"] or "",
                "location": "",
                "status": r["status"],
                "cancelledBy": r["cancelled_by"],
                "cancellationReason": r["cancellation_reason"],
                "type": r["training_type"],
                "customer": {"id": pid, "name": r["person_name"]},
                "personId": pid,
                "remainingSessions": remaining_cache[pid],
                "activeCardId": active_card["id"] if active_card else None,
                "activeCardTotalSessions": active_card["totalSessions"] if active_card else None,
                "activeCardUsedSessions": active_card["usedSessions"] if active_card else None,
                "seriesKey": r["series_key"],
                "cardId": r["card_id"],
                "inGcal": bool(r["gcal_event_id"]),
            })
        return events


# PT-Desk-Google-Sync abgeloest: PT-Termine leben jetzt nur noch in pt_appointments.
# Keine Spiegelung mehr nach Google.


def _gcal_event_to_dict(ev: dict, cal_name: str, cal_id: str, category: str) -> dict | None:
    """Mappt ein Google-Event auf unser Frontend-Event-Format. None wenn nicht zeitbasiert."""
    start = ev.get("start") or {}
    end = ev.get("end") or {}
    start_iso = start.get("dateTime") or ""
    end_iso = end.get("dateTime") or ""
    all_day = bool(start.get("date")) and not start_iso
    if all_day:
        # Tages-Events normalisieren auf 00:00 + Dauer
        start_iso = f"{start.get('date')}T00:00:00"
        try:
            from datetime import date as _date
            s = _date.fromisoformat(start.get("date"))
            e = _date.fromisoformat(end.get("date")) if end.get("date") else s
            duration = max(int((e - s).total_seconds() / 60), 1440)
        except Exception:
            duration = 1440
    else:
        if not start_iso or not end_iso:
            return None
        try:
            s = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
            e = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
            duration = max(int((e - s).total_seconds() / 60), 5)
            start_iso = s.replace(tzinfo=None).isoformat()
        except Exception:
            duration = 60
    return {
        "id": f"gcal-{cal_id.split('@')[0][:12]}-{ev.get('id', '')}",
        "gcalId": ev.get("id", ""),
        "gcalCalendarId": cal_id,
        "source": "google",
        "category": category,
        "calendarName": cal_name,
        "startIso": start_iso,
        "durationMin": duration,
        "allDay": all_day,
        "title": ev.get("summary", "(kein Titel)"),
        "notes": ev.get("description", "") or "",
        "location": ev.get("location", "") or "",
        "status": "scheduled",
        "label": "",
        "klausId": (ev.get("extendedProperties", {}).get("private", {}).get("klaus_id") or ""),
        "htmlLink": ev.get("htmlLink", ""),
    }


_CALNAME_TO_CATEGORY = {
    "Klaus": "klaus",
    "Privat": "privat",
    "Beispielkunde": "gecko",
    "FCH": "fch",
    "AI Workshop": "ai-workshop",
    "AI Agent": "ai-agent",
    "AI Beratung": "ai-beratung",
}


def _fetch_google_events(from_iso: str, to_iso: str) -> list[dict]:
    """Liest Events aus allen relevanten Sub-Kalendern. Schluckt Fehler, liefert leere Liste."""
    try:
        from modules.calendar.providers.google import GoogleCalendar, has_credentials
        if not has_credentials():
            return []
        gc = GoogleCalendar()
        cals = gc.list_read_calendars()
        # Zeitfenster auf RFC3339 mit Europe/Berlin Offset bringen
        from datetime import time as _time
        def _to_rfc3339(d: str, end: bool) -> str:
            t = _time(23, 59, 59) if end else _time(0, 0, 0)
            return f"{d}T{t.isoformat()}+02:00"
        tmin = _to_rfc3339(from_iso, False)
        tmax = _to_rfc3339(to_iso, True)
        out: list[dict] = []
        for c in cals:
            cid = c["id"]
            name = c["summary"]
            category = _CALNAME_TO_CATEGORY.get(name, "google")
            try:
                evs = gc.list_events(tmin, tmax, calendar_id=cid)
            except Exception as e:
                print(f"[gcal] list failed for {name}: {e}", file=sys.stderr)
                continue
            for ev in evs:
                mapped = _gcal_event_to_dict(ev, name, cid, category)
                if mapped:
                    out.append(mapped)
        return out
    except Exception as e:
        print(f"[gcal] fetch failed: {e}", file=sys.stderr)
        return []


def _compute_overdue_focus_events(from_iso: str, to_iso: str, existing_events: list[dict]) -> list[dict]:
    """Fokus-Aufgaben werden nicht als Kalendertermine eingeplant."""
    return []
    try:
        from datetime import date as _date, datetime as _dt, timedelta as _td
    except Exception:
        return []
    if not from_iso or not to_iso:
        return []
    try:
        today = _date.today()
        range_from = _date.fromisoformat(from_iso[:10])
        range_to = _date.fromisoformat(to_iso[:10])
    except Exception:
        return []
    # Wir platzieren nur ab heute (oder Range-Start, falls später) bis Range-Ende
    start_day = max(today, range_from)
    if start_day >= range_to:
        return []

    # Überfällige offene Fokus-Items aus dem Fokus-Store laden
    from modules.fokus.core import _focus_list_items
    try:
        items = _focus_list_items(include_done=False, business_only=True)
    except Exception:
        return []
    overdue: list[dict] = []
    for it in items:
        ds = (it.get("date") or "").strip()
        if not ds:
            continue
        try:
            d = _date.fromisoformat(ds[:10])
        except Exception:
            continue
        if d >= today:
            continue
        days = (today - d).days
        overdue.append({
            "title": (it.get("title") or "").strip(),
            "originalDate": ds,
            "daysOverdue": days,
            "triage": it.get("triage") or "later",
            "bucket": it.get("bucket") or "later",
            "itemKey": it.get("item_key") or "",
        })
    if not overdue:
        return []

    # Sortieren: am längsten überfällig zuerst, dann triage (now>soon>later)
    _triage_rank = {"now": 0, "soon": 1, "later": 2}
    overdue.sort(key=lambda o: (-int(o["daysOverdue"]), _triage_rank.get(o["triage"], 9), o["title"]))

    # Belegte Zeitslots pro Tag aus existing_events sammeln (nur getimte, nicht
    # cancelled). All-Day ignorieren — die blockieren keinen 30-Min-Slot.
    SLOT_DUR = 30  # Minuten
    DAY_START = 9 * 60   # 09:00
    DAY_END = 20 * 60    # 20:00
    occ_by_day: dict[str, list[tuple[int, int]]] = {}
    for ev in existing_events:
        if ev.get("allDay"):
            continue
        if (ev.get("status") or "") == "cancelled":
            continue
        s = (ev.get("startIso") or "")
        if len(s) < 16:
            continue
        try:
            dur = int(ev.get("durationMin") or 60)
            h = int(s[11:13]); mi = int(s[14:16])
        except Exception:
            continue
        day = s[:10]
        start_min = h * 60 + mi
        occ_by_day.setdefault(day, []).append((start_min, start_min + max(1, dur)))

    def find_slot(day_iso: str, occupied: list[tuple[int, int]]) -> int | None:
        # Erste freie SLOT_DUR-Lücke ab DAY_START bis DAY_END
        cursor = DAY_START
        for s, e in sorted(occupied):
            if e <= cursor:
                continue
            if cursor + SLOT_DUR <= s:
                return cursor
            cursor = max(cursor, e)
        if cursor + SLOT_DUR <= DAY_END:
            return cursor
        return None

    out: list[dict] = []
    cur_day = start_day
    cur_idx = 0
    occupied_today: list[tuple[int, int]] = list(occ_by_day.get(cur_day.isoformat(), []))
    while cur_idx < len(overdue) and cur_day < range_to:
        item = overdue[cur_idx]
        start_min = find_slot(cur_day.isoformat(), occupied_today)
        if start_min is None:
            # Tag voll → nächster Tag
            cur_day = cur_day + _td(days=1)
            occupied_today = list(occ_by_day.get(cur_day.isoformat(), []))
            continue
        # Slot belegen, Event ausgeben
        occupied_today.append((start_min, start_min + SLOT_DUR))
        hh = start_min // 60; mm = start_min % 60
        iso = f"{cur_day.isoformat()}T{hh:02d}:{mm:02d}:00"
        out.append({
            "id": f"fokus-{item['itemKey']}-{cur_day.isoformat()}",
            "source": "fokus-overdue",
            "title": item["title"],
            "startIso": iso,
            "durationMin": SLOT_DUR,
            "category": "klaus",
            "allDay": False,
            "status": "open",
            "overdue": True,
            "daysOverdue": item["daysOverdue"],
            "originalDate": item["originalDate"],
            "itemKey": item["itemKey"],
            "bucket": item["bucket"],
            "notes": "",
            "label": "",
        })
        cur_idx += 1
    return out


@router.get("/api/calendar")
async def calendar_get(from_: str = Query("", alias="from"), to: str = ""):
    """Liefert nur echte lokale Termine: PT aus people.db + Kalender aus chat.db.

    Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (to ist exklusiv)
    """
    from_iso = from_.strip()
    to_iso = to.strip()
    pt_events = _pt_load_events(from_iso, to_iso)
    manual_raw = calendar_list()
    manual = _expand_manual_events(manual_raw, from_iso, to_iso)
    # Abgesagte Termine bleiben in der jeweiligen Quelle geloggt, blockieren
    # aber den Kalender nicht mehr und werden dort nicht angezeigt.
    manual = [e for e in manual if (e.get("status") or "active").lower() != "cancelled"]
    events = pt_events + manual
    events.sort(key=lambda e: e.get("startIso") or "")
    return {
        "events": events,
        "ptCount": len(pt_events),
        "manualCount": len(manual),
        "googleCount": 0,
        "overdueCount": 0,
    }


def _gcal_end_iso(start_iso: str, duration_min: int) -> str:
    """Naive ISO + Minuten -> naive ISO Endzeit. Google bekommt timeZone separat."""
    try:
        s = datetime.fromisoformat(start_iso.replace("Z", "+00:00") if start_iso.endswith("Z") else start_iso)
        return (s + timedelta(minutes=duration_min)).isoformat()
    except Exception:
        return start_iso


def _gcal_rrule_string(rrule: str, rrule_until: str) -> list[str]:
    """Mapped unsere kurze rrule + Bis-Datum auf Google's RRULE-Format."""
    if not rrule:
        return []
    freq_map = {"daily": "DAILY", "weekly": "WEEKLY", "monthly": "MONTHLY"}
    freq = freq_map.get(rrule.lower())
    if not freq:
        return []
    s = f"RRULE:FREQ={freq}"
    if rrule_until:
        try:
            d = rrule_until[:10].replace("-", "")
            s += f";UNTIL={d}T235959Z"
        except Exception:
            pass
    return [s]


def _gcal_push_create(event_id: str, start: str, duration: int, title: str,
                      notes: str, location: str, rrule: str, rrule_until: str,
                      category: str = "klaus") -> None:
    """Push neuen Event nach Google in den Kalender der Kategorie. Schluckt Fehler (Log only)."""
    try:
        from modules.calendar.providers.google import GoogleCalendar, has_credentials
        if not has_credentials():
            return
        gc = GoogleCalendar()
        cid = gc.resolve_category(category) or gc.calendar_id()
        body = {
            "summary": title,
            "description": notes,
            "location": location,
            "start": {"dateTime": start, "timeZone": "Europe/Berlin"},
            "end": {"dateTime": _gcal_end_iso(start, duration), "timeZone": "Europe/Berlin"},
            "extendedProperties": {"private": {"klaus_source": "agent", "klaus_id": event_id}},
        }
        rec = _gcal_rrule_string(rrule, rrule_until)
        if rec:
            body["recurrence"] = rec
        created = gc.service.events().insert(calendarId=cid, body=body).execute()
        gid = created.get("id", "")
        if gid:
            calendar_set_gcal_id(event_id, gid, cid)
    except Exception as e:
        print(f"[gcal] create failed: {e}", file=sys.stderr)


def _gcal_push_update(event_id: str, fields: dict) -> None:
    try:
        from modules.calendar.providers.google import GoogleCalendar, has_credentials
        if not has_credentials():
            return
        gid, gcid = calendar_get_gcal_ref(event_id)
        if not gid:
            return
        gc = GoogleCalendar()
        # Category-Wechsel → Termin in anderen Kalender verschieben
        if "category" in fields:
            new_cat = _normalize_category(fields.get("category") or "klaus")
            if new_cat in VALID_CATEGORIES:
                target_cid = gc.resolve_category(new_cat)
                current_cid = gcid or gc.calendar_id()
                if target_cid and target_cid != current_cid:
                    try:
                        moved = gc.service.events().move(
                            calendarId=current_cid, eventId=gid, destination=target_cid,
                        ).execute()
                        gcid = target_cid
                        new_gid = moved.get("id", gid)
                        if new_gid != gid:
                            gid = new_gid
                        calendar_set_gcal_id(event_id, gid, target_cid)
                    except Exception as e:
                        print(f"[gcal] move failed: {e}", file=sys.stderr)
        patch: dict = {}
        if "title" in fields:
            patch["summary"] = fields["title"]
        if "notes" in fields:
            patch["description"] = fields["notes"]
        if "location" in fields:
            patch["location"] = fields["location"]
        if "startIso" in fields or "durationMin" in fields:
            with get_db() as db:
                row = db.execute(
                    "SELECT start_iso, duration_min FROM calendar_events WHERE id = ?",
                    (event_id,),
                ).fetchone()
            if row:
                start = fields.get("startIso", row[0])
                duration = int(fields.get("durationMin", row[1]))
                patch["start"] = {"dateTime": start, "timeZone": "Europe/Berlin"}
                patch["end"] = {"dateTime": _gcal_end_iso(start, duration), "timeZone": "Europe/Berlin"}
        if "rrule" in fields or "rruleUntil" in fields:
            with get_db() as db:
                row = db.execute(
                    "SELECT rrule, rrule_until FROM calendar_events WHERE id = ?",
                    (event_id,),
                ).fetchone()
            if row:
                rec = _gcal_rrule_string(fields.get("rrule", row[0]), fields.get("rruleUntil", row[1]))
                patch["recurrence"] = rec if rec else None
        if not patch:
            return
        target_cid = gcid or gc.calendar_id()
        gc.service.events().patch(calendarId=target_cid, eventId=gid, body=patch).execute()
    except Exception as e:
        print(f"[gcal] update failed: {e}", file=sys.stderr)


def _gcal_push_delete(event_id: str) -> None:
    try:
        from modules.calendar.providers.google import GoogleCalendar, has_credentials
        if not has_credentials():
            return
        gid, gcid = calendar_get_gcal_ref(event_id)
        if not gid:
            return
        gc = GoogleCalendar()
        target_cid = gcid or gc.calendar_id()
        gc.service.events().delete(calendarId=target_cid, eventId=gid).execute()
    except Exception as e:
        print(f"[gcal] delete failed: {e}", file=sys.stderr)


VALID_CATEGORIES = {"klaus", "privat", "fch", "ai-workshop", "ai-agent", "ai-beratung", "gecko", "ptdesk", "pt", "admin"}
# "pt" ist der neue User-facing-Name fuer PT-Termine. Intern bleibt "ptdesk"
# (legacy Tabellen-/People-Felder); _normalize_category mappt "pt" -> "ptdesk".

def _normalize_category(cat: str) -> str:
    cat = (cat or "").strip().lower()
    if cat == "pt":
        return "ptdesk"
    return cat


def _local_all_day_fields(start_date: str, end_date_inclusive: str) -> tuple[str, int]:
    from datetime import date as _date
    start = _date.fromisoformat(start_date)
    end = _date.fromisoformat(end_date_inclusive)
    days = max(1, (end - start).days + 1)
    return (f"{start.isoformat()}T00:00:00", days * 1440)


def _parse_gcal_frontend_id(event_id: str) -> tuple[str, str] | None:
    """Frontend-Event-IDs für Google-Events haben die Form 'gcal-<calid-prefix>-<google_event_id>'.
    Liefert (google_event_id, calendar_id) oder None falls keine Google-ID erkennbar."""
    if not event_id.startswith("gcal-"):
        return None
    rest = event_id[len("gcal-"):]
    parts = rest.split("-", 1)
    if len(parts) != 2:
        return None
    cid_prefix, gid = parts[0], parts[1]
    try:
        from modules.calendar.providers.google import GoogleCalendar, has_credentials
        if not has_credentials():
            return None
        gc = GoogleCalendar()
        for c in gc.list_calendars():
            if c["id"].split("@")[0][:12] == cid_prefix:
                return (gid, c["id"])
    except Exception:
        return None
    return None


def _gcal_direct_create_allday(title: str, start_date: str, end_date_inclusive: str,
                                category: str, notes: str = "", location: str = "") -> dict:
    """Legt ein All-Day-Event direkt in Google an (umgeht lokale DB, weil dort kein all_day-Flag).
    end_date ist im Body exklusiv → wir addieren 1 Tag auf das inklusive Enddatum."""
    from modules.calendar.providers.google import GoogleCalendar
    from datetime import date as _date, timedelta as _td
    gc = GoogleCalendar()
    cid = gc.resolve_category(category) or gc.calendar_id()
    end_exclusive = (_date.fromisoformat(end_date_inclusive) + _td(days=1)).isoformat()
    body = {
        "summary": title,
        "description": notes,
        "location": location,
        "start": {"date": start_date},
        "end": {"date": end_exclusive},
        "transparency": "transparent",
        "extendedProperties": {"private": {"klaus_source": "agent"}},
    }
    return gc.service.events().insert(calendarId=cid, body=body).execute()


def _find_event_conflicts(start_iso: str, duration_min: int, exclude_event_id: str = "") -> list[dict]:
    """Überlappende timed Events (lokale Kalender-Events + PT) zu [start, start+dur].
    Liefert {source, id, title, startIso, endIso}.
    """
    if not start_iso:
        return []
    try:
        s = datetime.fromisoformat(start_iso.replace("Z", ""))
        e = s + timedelta(minutes=int(duration_min or 60))
    except Exception:
        return []
    day_from = s.strftime("%Y-%m-%d")
    day_to = (e + timedelta(days=1)).strftime("%Y-%m-%d")
    out: list[dict] = []
    excl_real = exclude_event_id.split("@", 1)[0] if exclude_event_id else ""

    def _overlap(ev_start_iso: str, ev_dur: int) -> bool:
        try:
            es = datetime.fromisoformat((ev_start_iso or "").replace("Z", ""))
            ee = es + timedelta(minutes=int(ev_dur or 60))
        except Exception:
            return False
        return es < e and ee > s

    manual_list = _expand_manual_events(calendar_list(), day_from, day_to)
    for ev in manual_list:
        if ev.get("id") == excl_real:
            continue
        if ev.get("allDay"):
            continue
        if (ev.get("status") or "").lower() == "cancelled":
            continue
        if _overlap(ev.get("startIso", ""), ev.get("durationMin") or 60):
            out.append({"source": "manual", "id": ev.get("id"), "title": ev.get("title"), "startIso": ev.get("startIso")})
    for ev in _pt_load_events(day_from, day_to):
        if ev.get("id") == exclude_event_id:
            continue
        if ev.get("allDay"):
            continue
        if (ev.get("status") or "").lower() == "cancelled":
            continue
        if _overlap(ev.get("startIso", ""), ev.get("durationMin") or 60):
            out.append({"source": "pt", "id": ev.get("id"), "title": ev.get("title"), "startIso": ev.get("startIso")})
    return out


@router.post("/api/calendar")
async def calendar_post(req: Request):
    body = await req.json()
    title = ((body or {}).get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "title noetig"}, status_code=400)
    notes = (body or {}).get("notes", "")
    location = (body or {}).get("location", "")
    category = _normalize_category((body or {}).get("category") or "klaus")
    if category not in VALID_CATEGORIES:
        category = "klaus"
    if (body or {}).get("allDay"):
        start_date = ((body or {}).get("startDate") or "").strip()
        end_date = ((body or {}).get("endDate") or start_date).strip()
        if not start_date:
            return JSONResponse({"error": "startDate noetig fuer allDay"}, status_code=400)
        try:
            start_iso, duration = _local_all_day_fields(start_date, end_date)
        except Exception:
            return JSONResponse({"error": "ungueltiges allDay-Datum"}, status_code=400)
        ev = calendar_create(start_iso, duration, title, notes, location, category=category, all_day=True)
        try:
            _entities.tag_text(f"{title} {notes}".strip(), _entities.SOURCE_CALENDAR, ev["id"])
        except Exception:
            pass
        return ev
    start = ((body or {}).get("startIso") or "").strip()
    if not start:
        return JSONResponse({"error": "startIso noetig"}, status_code=400)
    duration = int((body or {}).get("durationMin") or 60)
    if not (body or {}).get("force"):
        conflicts = _find_event_conflicts(start, duration)
        if conflicts:
            return JSONResponse({"error": "conflict", "conflicts": conflicts}, status_code=409)
    label = ((body or {}).get("label") or "").strip()[:8]
    rrule = ((body or {}).get("rrule") or "").strip().lower()
    if rrule not in ("", "daily", "weekly", "monthly"):
        rrule = ""
    rrule_until = ((body or {}).get("rruleUntil") or "").strip()
    person_id = (body or {}).get("personId")
    ev = calendar_create(start, duration, title, notes, location, label, rrule, rrule_until, category, person_id=person_id)
    try:
        scan = _entities.tag_text(f"{title} {notes}".strip(), _entities.SOURCE_CALENDAR, ev["id"])
        people = scan.get("people") or []
        if len(people) == 1:
            with get_db() as db:
                db.execute("UPDATE calendar_events SET person_id = ? WHERE id = ?", (people[0], ev["id"]))
            ev["person_id"] = people[0]
    except Exception:
        pass
    return ev


@router.post("/api/calendar/{event_id}/convert-to-pt")
async def calendar_convert_to_pt(event_id: str, req: Request):
    """Wandelt einen lokalen Kalendereintrag in einen PT-Termin um."""
    body = await req.json()
    real_id = event_id.split("@", 1)[0]
    with get_db() as db:
        row = db.execute(
            """
            SELECT id, start_iso, duration_min, title, notes, person_id, all_day
            FROM calendar_events
            WHERE id = ?
            """,
            (real_id,),
        ).fetchone()
    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)
    all_day = row["all_day"] if hasattr(row, "keys") else row[6]
    start_iso_db = row["start_iso"] if hasattr(row, "keys") else row[1]
    duration_db = row["duration_min"] if hasattr(row, "keys") else row[2]
    title_db = row["title"] if hasattr(row, "keys") else row[3]
    notes_db = row["notes"] if hasattr(row, "keys") else row[4]
    person_id_db = row["person_id"] if hasattr(row, "keys") else row[5]
    if all_day:
        return JSONResponse({"error": "all_day_not_supported"}, status_code=400)
    try:
        person_id = int((body or {}).get("personId") or person_id_db or 0)
    except Exception:
        person_id = 0
    if person_id <= 0:
        return JSONResponse({"error": "personId noetig"}, status_code=400)
    start_iso = ((body or {}).get("startIso") or start_iso_db or "").strip()
    if not start_iso:
        return JSONResponse({"error": "startIso noetig"}, status_code=400)
    try:
        start_dt = datetime.fromisoformat(start_iso.replace("Z", ""))
    except Exception:
        return JSONResponse({"error": "ungueltiges startIso"}, status_code=400)
    title = (((body or {}).get("title") if body is not None else None) or title_db or "").strip()
    label = (((body or {}).get("label") if body is not None else None) or "").strip().lower()
    training_type = ((body or {}).get("trainingType") or "").strip().lower()
    if training_type not in ("personal_training", "ems"):
        training_type = "ems" if title.lower().startswith("ems") or label == "ems" else "personal_training"
    try:
        duration = max(5, int((body or {}).get("durationMin") or duration_db or 60))
    except Exception:
        duration = int(duration_db or 60)
    notes = (((body or {}).get("notes") if body is not None else None) or notes_db or "").strip()
    now = int(time.time())
    with _people_db() as con:
        cur = con.execute(
            """
            INSERT INTO pt_appointments
              (person_id, date, start_time, duration_min, training_type,
               series_key, status, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 'scheduled', ?, ?, ?)
            """,
            (
                person_id,
                start_dt.strftime("%Y-%m-%d"),
                start_dt.strftime("%H:%M"),
                duration,
                training_type,
                notes,
                now,
                now,
            ),
        )
        pt_id = cur.lastrowid
        con.commit()
    calendar_delete(real_id)
    try:
        _entities.clear_mentions(_entities.SOURCE_CALENDAR, real_id)
    except Exception:
        pass
    return {"ok": True, "appointmentId": pt_id}


def _upsert_gcal_shadow(gid: str, cid: str, body: dict) -> None:
    """Legt/aktualisiert eine lokale calendar_events-Zeile für einen Google-Event,
    damit personId/category/label/rrule lokal lebt. Beim GET wird der reine
    Google-Event via gcalId-Dedupe ausgeblendet und die Shadow-Row gezeigt.
    """
    from db import get_db, calendar_create, calendar_update, calendar_set_gcal_id
    shadow_id: str | None = None
    with get_db() as db:
        r = db.execute("SELECT id FROM calendar_events WHERE gcal_event_id = ?", (gid,)).fetchone()
        if r:
            shadow_id = r[0]
    if shadow_id:
        calendar_update(shadow_id, body)
        return
    # Anlegen — Felder aus body, fehlende aus Google ziehen
    title = (body.get("title") or "").strip()
    start_iso = body.get("startIso") or ""
    duration = int(body.get("durationMin") or 60)
    notes = body.get("notes") or ""
    location = body.get("location") or ""
    if not start_iso or not title:
        try:
            from modules.calendar.providers.google import GoogleCalendar
            gc = GoogleCalendar()
            ev = gc.service.events().get(calendarId=cid, eventId=gid).execute()
            title = title or ev.get("summary") or ""
            if not start_iso:
                st = (ev.get("start") or {}).get("dateTime") or ""
                if st:
                    start_iso = st[:19]
            notes = notes or ev.get("description") or ""
            location = location or ev.get("location") or ""
        except Exception:
            pass
    if not start_iso:
        return
    label = (body.get("label") or "").strip()[:8]
    rrule = (body.get("rrule") or "").strip().lower()
    if rrule not in ("", "daily", "weekly", "monthly"):
        rrule = ""
    rrule_until = (body.get("rruleUntil") or "").strip()
    category = _normalize_category(body.get("category") or "klaus")
    if category not in VALID_CATEGORIES:
        category = "klaus"
    ev = calendar_create(start_iso, duration, title, notes, location, label, rrule, rrule_until, category)
    calendar_set_gcal_id(ev["id"], gid, cid)
    if "personId" in body:
        calendar_update(ev["id"], {"personId": body.get("personId")})


def _gcal_apply_patch(gid: str, cid: str, body: dict) -> None:
    """Synchroner Google-PATCH (Title/Notes/Time/Move). Wird aus BackgroundTask gerufen."""
    try:
        from modules.calendar.providers.google import GoogleCalendar
        gc = GoogleCalendar()
        patch: dict = {}
        if "title" in body: patch["summary"] = body["title"]
        if "notes" in body: patch["description"] = body["notes"]
        if "location" in body: patch["location"] = body["location"]
        if "startIso" in body and not body.get("allDay"):
            start = body["startIso"]
            duration = int(body.get("durationMin") or 60)
            patch["start"] = {"dateTime": start, "timeZone": "Europe/Berlin"}
            patch["end"] = {"dateTime": _gcal_end_iso(start, duration), "timeZone": "Europe/Berlin"}
        if body.get("allDay") and body.get("startDate"):
            from datetime import date as _date, timedelta as _td
            sd = body["startDate"]
            ed_incl = body.get("endDate") or sd
            ed_excl = (_date.fromisoformat(ed_incl) + _td(days=1)).isoformat()
            patch["start"] = {"date": sd}
            patch["end"] = {"date": ed_excl}
        cur_cid = cid
        cur_gid = gid
        new_cat = _normalize_category(body.get("category") or "")
        if new_cat and new_cat in VALID_CATEGORIES:
            target_cid = gc.resolve_category(new_cat)
            if target_cid and target_cid != cur_cid:
                moved = gc.service.events().move(calendarId=cur_cid, eventId=cur_gid, destination=target_cid).execute()
                cur_cid = target_cid
                cur_gid = moved.get("id", cur_gid)
        if patch:
            gc.service.events().patch(calendarId=cur_cid, eventId=cur_gid, body=patch).execute()
    except Exception as e:
        print(f"[gcal] background patch failed: {e}", file=sys.stderr)


@router.patch("/api/calendar/{event_id}")
async def calendar_patch(event_id: str, req: Request):
    body = await req.json()
    real_id = event_id.split("@", 1)[0]
    if body.get("allDay") and body.get("startDate"):
        try:
            start_iso, duration = _local_all_day_fields(
                (body.get("startDate") or "").strip(),
                (body.get("endDate") or body.get("startDate") or "").strip(),
            )
        except Exception:
            return JSONResponse({"error": "ungueltiges allDay-Datum"}, status_code=400)
        body = {
            "title": body.get("title"),
            "notes": body.get("notes"),
            "category": body.get("category"),
            "startIso": start_iso,
            "durationMin": duration,
            "allDay": True,
        }
    if "startIso" in (body or {}) and not (body or {}).get("force"):
        conflicts = _find_event_conflicts(body["startIso"], int((body or {}).get("durationMin") or 60), real_id)
        if conflicts:
            return JSONResponse({"error": "conflict", "conflicts": conflicts}, status_code=409)
    ok = calendar_update(real_id, body or {})
    if not ok:
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        from db import DB_PATH as _CHAT_DB
        with sqlite3.connect(_CHAT_DB) as _c:
            r = _c.execute("SELECT title, notes FROM calendar_events WHERE id=?", (real_id,)).fetchone()
        if r:
            _entities.clear_mentions(_entities.SOURCE_CALENDAR, real_id)
            _entities.tag_text(f"{r[0]} {r[1]}".strip(), _entities.SOURCE_CALENDAR, real_id)
    except Exception:
        pass
    return {"ok": True}


@router.delete("/api/calendar/{event_id}")
async def calendar_del(event_id: str):
    real_id = event_id.split("@", 1)[0]
    ok = calendar_delete(real_id)
    if not ok:
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        _entities.clear_mentions(_entities.SOURCE_CALENDAR, real_id)
    except Exception:
        pass
    return {"ok": True}


@router.post("/api/calendar/{event_id}/reactivate")
async def calendar_reactivate(event_id: str):
    """Setzt einen vom Cancel-Detector markierten Termin zurueck auf 'active'."""
    real_id = event_id.split("@", 1)[0]
    try:
        from modules.cancel_detector.core import reactivate_event
        ok = reactivate_event(real_id)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    if not ok:
        return JSONResponse({"error": "not found or not cancelled"}, status_code=404)
    return {"ok": True}


@router.post("/api/calendar/{event_id}/cancel")
async def calendar_cancel(event_id: str):
    """Markiert einen Termin als abgesagt (manuell, ohne Detector-Pfad)."""
    real_id = event_id.split("@", 1)[0]
    try:
        from db import DB_PATH as _CHAT_DB
        with sqlite3.connect(_CHAT_DB) as _c:
            cur = _c.execute(
                "UPDATE calendar_events SET status='cancelled', updated_at=? "
                "WHERE id=? AND status='active'",
                (time.time(), real_id),
            )
            _c.commit()
        if cur.rowcount <= 0:
            return JSONResponse({"error": "not found or already cancelled"}, status_code=404)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"ok": True}


def _briefing_resolve_source_id(event_id: str) -> str:
    """Frontend-Event-ID → source_id der in mentions liegt.
    Lokale Events: id direkt. Google-Events: gid aus 'gcal-<prefix>-<gid>'."""
    if event_id.startswith("gcal-"):
        rest = event_id[len("gcal-"):]
        parts = rest.split("-", 1)
        if len(parts) == 2:
            return parts[1]
    return event_id.split("@", 1)[0]


def _briefing_relative_when(ts: int, now: Optional[int] = None) -> str:
    """Sehr kurze Zeitangabe: 'gerade', '2h', 'gestern', '3d', '2W'."""
    now = now or int(time.time())
    diff = max(0, now - int(ts))
    if diff < 90 * 60:
        m = diff // 60
        return "gerade" if m < 5 else f"{m}m"
    if diff < 36 * 3600:
        h = diff // 3600
        return f"{h}h" if h < 24 else "gestern"
    d = diff // 86400
    if d < 14:
        return f"{d}d"
    return f"{d // 7}W"


def _briefing_person_summary(person_id: int, now_ts: int) -> dict:
    """Person + ihre letzten Touchpoints (außer Calendar selbst). Knapp gehalten."""
    with _people_db() as con:
        p = con.execute(
            "SELECT id, name, company, offer_eur, status, last_interaction_ts "
            "FROM people WHERE id = ?",
            (person_id,),
        ).fetchone()
        if not p:
            return {}
        rows = con.execute(
            "SELECT source_kind, snippet, ts FROM mentions "
            "WHERE entity_type='person' AND entity_id=? "
            "AND source_kind IN ('whatsapp','email','focus','chat') "
            "ORDER BY ts DESC LIMIT 6",
            (person_id,),
        ).fetchall()
    touchpoints: list[dict] = []
    seen_kinds: set[str] = set()
    for r in rows:
        kind = r["source_kind"]
        if kind in seen_kinds and len(touchpoints) >= 3:
            continue
        seen_kinds.add(kind)
        snippet = (r["snippet"] or "").strip().replace("\n", " ")
        if len(snippet) > 140:
            snippet = snippet[:137] + "…"
        touchpoints.append({
            "kind": kind,
            "snippet": snippet,
            "when": _briefing_relative_when(r["ts"], now_ts),
            "ts": int(r["ts"]),
        })
        if len(touchpoints) >= 3:
            break
    return {
        "id": p["id"],
        "name": p["name"],
        "company": p["company"] or "",
        "offer_eur": p["offer_eur"] or 0,
        "status": p["status"] or "",
        "touchpoints": touchpoints,
    }


def _briefing_compose_text(people: list[dict], projects: list[dict]) -> str:
    """Aus strukturierten Personen-Dicts eine kurze Prosa-Zeile bauen."""
    if not people and not projects:
        return ""
    parts: list[str] = []
    for p in people:
        head = p["name"]
        if p.get("company"):
            head += f" ({p['company']})"
        bits = [head]
        if p.get("offer_eur"):
            bits.append(f"offen {p['offer_eur']:,} €".replace(",", "."))
        tp_strs: list[str] = []
        for t in p.get("touchpoints", []):
            label = {"whatsapp": "WA", "email": "Mail", "focus": "Fokus", "chat": "Chat"}.get(t["kind"], t["kind"])
            if t["snippet"]:
                tp_strs.append(f"{label} ({t['when']}): „{t['snippet']}\"")
            else:
                tp_strs.append(f"{label} ({t['when']})")
        if tp_strs:
            bits.append(" · ".join(tp_strs))
        parts.append(" — ".join(bits))
    if projects:
        proj_names = [p["name"] for p in projects if p.get("name")]
        if proj_names:
            parts.append("Projekte: " + ", ".join(proj_names))
    return " | ".join(parts)


@router.get("/api/calendar/briefing/{event_id}")
async def calendar_briefing(event_id: str):
    """Kontext-Briefing für einen Termin: verknüpfte Personen + letzte Touchpoints."""
    src_id = _briefing_resolve_source_id(event_id)
    now_ts = int(time.time())
    with _people_db() as con:
        rows = con.execute(
            "SELECT entity_type, entity_id FROM mentions "
            "WHERE source_kind='calendar' AND source_id=?",
            (src_id,),
        ).fetchall()
        person_ids = [r["entity_id"] for r in rows if r["entity_type"] == "person"]
        project_ids = [r["entity_id"] for r in rows if r["entity_type"] == "project"]
        projects: list[dict] = []
        if project_ids:
            placeholders = ",".join("?" * len(project_ids))
            prows = con.execute(
                f"SELECT id, slug, name, last_activity_ts FROM projects WHERE id IN ({placeholders})",
                project_ids,
            ).fetchall()
            projects = [dict(r) for r in prows]
    people = [_briefing_person_summary(pid, now_ts) for pid in person_ids]
    people = [p for p in people if p]
    text = _briefing_compose_text(people, projects)
    return {"eventId": event_id, "sourceId": src_id, "text": text, "people": people, "projects": projects}


@router.get("/api/google/status")
async def google_status():
    """Zeigt ob Google-OAuth eingerichtet ist und ob Calendar erreichbar."""
    try:
        from modules.calendar.providers.google import has_credentials, GoogleCalendar
    except Exception as e:
        return {"connected": False, "error": f"import: {e}"}
    if not has_credentials():
        return {
            "connected": False,
            "setupHint": "python3 scripts/google-oauth-setup.py",
        }
    try:
        gc = GoogleCalendar()
        cid = gc.calendar_id()
        cals = gc.list_calendars()
        return {"connected": True, "calendarId": cid, "calendars": cals}
    except Exception as e:
        return {"connected": False, "error": str(e)}
