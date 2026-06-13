"""Fokus — operative Aufgaben aus /fokus mit lokaler DB als Wahrheit.

Vorher: ~1520 Zeilen in `backend/server.py` (4694-6213). Jetzt isoliert.

Cross-Deps:
- `from db import get_db, run_claude_cli, create_conversation, DB_PATH`
- `from modules.people.core import _people_db, PEOPLE_DB`
- `from backend import entities as _entities` (Mention-Tagging)
"""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, StreamingResponse

from db import get_db, run_claude_cli, create_conversation, DB_PATH
from modules.people.core import _people_db, PEOPLE_DB

# backend/ ins sys.path damit `from backend import entities` klappt
_REPO_ROOT = str(Path(__file__).parent.parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
from backend import entities as _entities  # noqa: E402


router = APIRouter()




# ── Fokus — operative Aufgaben aus /fokus, Legacy-Import aus alter Markdown-Quelle nur beim ersten Start ──

_FOKUS_TRIAGE = {"!": "now", ">": "soon", "~": "later"}
_FOKUS_BUCKETS = {"jetzt": "now", "bald": "soon", "später": "later"}
_FOKUS_ITEM_RE = re.compile(
    r"^-\s+`(?P<triage>[!>~])`\s+(?P<date>\d{4}-\d{2}-\d{2}(?:\.\.\d{4}-\d{2}-\d{2})?|-)\s+—\s+(?P<rest>.+)$"
)
_FOKUS_PERSON_RE = re.compile(r"\[(?P<name>.+?)\]\(PEOPLE\.md#(?P<anchor>[^\)]+)\)")
_FOKUS_PROJECT_RE = re.compile(r"\[(?P<name>.+?)\]\(PROJECTS\.md#(?P<anchor>[^\)]+)\)")
_FOKUS_TAG_RE = re.compile(r"^#(?P<tag>\S+)$")
# Neues Tag-Format: `@slug` (z. B. `@example-person`, `@example-firm`). Wird via
# modules.people.resolver gegen people.db/projects aufgeloest.
_FOKUS_SLUG_RE = re.compile(r"^@(?P<slug>[a-z0-9][a-z0-9\-]+)$")

# Fokus ist Business-only: Aufträge, Angebote, Nachfass, Gespräche, Termine,
# Pricing, Akquise. Bau-/Tech-Items werden hier nicht angezeigt.
_FOKUS_BUILD_TAGS = {"tech", "build", "code", "ui", "dev", "infra"}


def _parse_fokus(md: str, business_only: bool = True) -> list:
    items: list = []
    bucket = None
    current = None
    for raw in md.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            head = line[3:].strip().lower()
            bucket = _FOKUS_BUCKETS.get(head)
            current = None
            continue
        if bucket is None:
            continue
        if current is not None and (raw.startswith("  ") or raw.startswith("\t")):
            text = line.strip()
            if text:
                if text.startswith("- "):
                    text = text[2:].strip()
                current["body"] = (current.get("body") + "\n" + text) if current.get("body") else text
            continue
        m = _FOKUS_ITEM_RE.match(line)
        if not m:
            current = None
            continue
        rest = m.group("rest")
        parts = [p.strip() for p in rest.split(" · ")]
        title = parts[0]
        people: list = []
        projects: list = []
        tags: list = []
        for meta in parts[1:]:
            pm = _FOKUS_PERSON_RE.match(meta)
            if pm:
                people.append({"name": pm.group("name"), "anchor": pm.group("anchor")})
                continue
            prm = _FOKUS_PROJECT_RE.match(meta)
            if prm:
                projects.append({"name": prm.group("name"), "anchor": prm.group("anchor")})
                continue
            sm = _FOKUS_SLUG_RE.match(meta)
            if sm:
                slug = sm.group("slug")
                try:
                    from modules.people.resolver import resolve_tag
                    hit = resolve_tag(slug)
                except Exception:
                    hit = None
                if hit and hit.get("kind") == "person":
                    people.append({"name": hit["name"], "anchor": hit["slug"]})
                elif hit and hit.get("kind") == "project":
                    projects.append({"name": hit["name"], "anchor": hit["slug"]})
                else:
                    tags.append(slug)
                continue
            tm = _FOKUS_TAG_RE.match(meta)
            if tm:
                tags.append(tm.group("tag"))
        if business_only and any(t.lower() in _FOKUS_BUILD_TAGS for t in tags):
            current = None
            continue
        raw_date = m.group("date")
        date_start: str | None = None
        date_end: str | None = None
        if raw_date and raw_date != "-":
            if ".." in raw_date:
                a, b = raw_date.split("..", 1)
                date_start = a.strip()
                date_end = b.strip()
            else:
                date_start = raw_date
        items.append({
            "bucket": bucket,
            "triage": _FOKUS_TRIAGE.get(m.group("triage"), "later"),
            "date": date_start,
            "date_end": date_end,
            "title": title,
            "body": "",
            "people": people,
            "projects": projects,
            "tags": tags,
        })
        current = items[-1]
    return items


_FOKUS_BUCKET_LABELS = {"now": "Jetzt", "soon": "Bald", "later": "Später"}
_FOKUS_TRIAGE_MARKERS = {"now": "!", "soon": ">", "later": "~"}


def _fokus_path() -> Path:
    return Path.home() / "agent/brain/FOCUS.md"


def _focus_json_loads(raw: str, fallback):
    try:
        return json.loads(raw or "")
    except Exception:
        return fallback


def _focus_now_ts() -> float:
    return time.time()


def _focus_row_to_item(row) -> dict:
    item = {
        "item_key": row[1],
        "title": row[2] or "",
        "bucket": row[3] or "later",
        "triage": row[4] or (row[3] or "later"),
        "date": (row[5] or "").strip() or None,
        "date_end": (row[6] or "").strip() or None,
        "body": row[7] or "",
        "people": _focus_json_loads(row[8], []),
        "projects": _focus_json_loads(row[9], []),
        "tags": _focus_json_loads(row[10], []),
        "status": row[11] or "open",
        "created_at": row[12],
        "updated_at": row[13],
    }
    return item


def _focus_import_legacy_items(db) -> int:
    path = _fokus_path()
    if not path.exists():
        return 0
    try:
        items = _parse_fokus(path.read_text(encoding="utf-8"), business_only=False)
    except Exception:
        return 0
    now_ts = _focus_now_ts()
    imported = 0
    for it in items:
        title = (it.get("title") or "").strip()
        if not title:
            continue
        key = _fokus_item_key(title)
        db.execute(
            """
            INSERT OR IGNORE INTO focus_items (
                item_key, title, bucket, triage, date, date_end, body,
                people_json, projects_json, tags_json, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
            """,
            (
                key,
                title,
                (it.get("bucket") or "later"),
                (it.get("triage") or it.get("bucket") or "later"),
                (it.get("date") or ""),
                (it.get("date_end") or ""),
                (it.get("body") or ""),
                json.dumps(it.get("people") or [], ensure_ascii=False),
                json.dumps(it.get("projects") or [], ensure_ascii=False),
                json.dumps(it.get("tags") or [], ensure_ascii=False),
                now_ts,
                now_ts,
            ),
        )
        imported += 1
    return imported


def _focus_ensure_store() -> None:
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS focus_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_key TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                bucket TEXT NOT NULL DEFAULT 'later',
                triage TEXT NOT NULL DEFAULT 'later',
                date TEXT NOT NULL DEFAULT '',
                date_end TEXT NOT NULL DEFAULT '',
                body TEXT NOT NULL DEFAULT '',
                people_json TEXT NOT NULL DEFAULT '[]',
                projects_json TEXT NOT NULL DEFAULT '[]',
                tags_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'open',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        count_row = db.execute("SELECT COUNT(*) FROM focus_items").fetchone()
        if int((count_row[0] if count_row else 0) or 0) == 0:
            _focus_import_legacy_items(db)


def _focus_list_items(include_done: bool = False, business_only: bool = True) -> list[dict]:
    _focus_ensure_store()
    items: list[dict] = []
    with get_db() as db:
        if include_done:
            rows = db.execute(
                """
                SELECT id, item_key, title, bucket, triage, date, date_end, body,
                       people_json, projects_json, tags_json, status, created_at, updated_at
                FROM focus_items
                ORDER BY
                    CASE bucket WHEN 'now' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END,
                    CASE WHEN date = '' THEN 1 ELSE 0 END,
                    date,
                    updated_at DESC,
                    title COLLATE NOCASE
                """
            ).fetchall()
        else:
            rows = db.execute(
                """
                SELECT id, item_key, title, bucket, triage, date, date_end, body,
                       people_json, projects_json, tags_json, status, created_at, updated_at
                FROM focus_items
                WHERE status = 'open'
                ORDER BY
                    CASE bucket WHEN 'now' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END,
                    CASE WHEN date = '' THEN 1 ELSE 0 END,
                    date,
                    updated_at DESC,
                    title COLLATE NOCASE
                """
            ).fetchall()
    for row in rows:
        item = _focus_row_to_item(row)
        if business_only and any(str(t).lower() in _FOKUS_BUILD_TAGS for t in (item.get("tags") or [])):
            continue
        items.append(item)
    return items


def _focus_resolve_identity(title: str = "", item_key: str = "") -> dict | None:
    _focus_ensure_store()
    title = (title or "").strip()
    item_key = (item_key or "").strip()
    with get_db() as db:
        row = None
        if item_key:
            row = db.execute(
                """
                SELECT id, item_key, title, bucket, triage, date, date_end, body,
                       people_json, projects_json, tags_json, status, created_at, updated_at
                FROM focus_items
                WHERE item_key = ?
                LIMIT 1
                """,
                (item_key,),
            ).fetchone()
        if row is None and title:
            row = db.execute(
                """
                SELECT id, item_key, title, bucket, triage, date, date_end, body,
                       people_json, projects_json, tags_json, status, created_at, updated_at
                FROM focus_items
                WHERE lower(title) = lower(?)
                ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC
                LIMIT 1
                """,
                (title,),
            ).fetchone()
        if row is None and title:
            row = db.execute(
                """
                SELECT id, item_key, title, bucket, triage, date, date_end, body,
                       people_json, projects_json, tags_json, status, created_at, updated_at
                FROM focus_items
                WHERE lower(title) LIKE lower(?)
                ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC
                LIMIT 1
                """,
                (f"%{title}%",),
            ).fetchone()
    return _focus_row_to_item(row) if row else None


def _focus_store_update(old_item: dict, new_item: dict) -> dict:
    _focus_ensure_store()
    old_key = old_item.get("item_key") or _fokus_item_key(old_item.get("title") or "")
    new_title = (new_item.get("title") or old_item.get("title") or "").strip()
    new_key = _fokus_item_key(new_title)
    now_ts = _focus_now_ts()
    record = {
        "item_key": new_key,
        "title": new_title,
        "bucket": (new_item.get("bucket") or old_item.get("bucket") or "later"),
        "triage": (new_item.get("triage") or new_item.get("bucket") or old_item.get("triage") or "later"),
        "date": (new_item.get("date") or "") or "",
        "date_end": (new_item.get("date_end") or "") or "",
        "body": new_item.get("body") if new_item.get("body") is not None else (old_item.get("body") or ""),
        "people": new_item.get("people") if new_item.get("people") is not None else (old_item.get("people") or []),
        "projects": new_item.get("projects") if new_item.get("projects") is not None else (old_item.get("projects") or []),
        "tags": new_item.get("tags") if new_item.get("tags") is not None else (old_item.get("tags") or []),
        "status": new_item.get("status") or old_item.get("status") or "open",
        "created_at": old_item.get("created_at") or now_ts,
        "updated_at": now_ts,
    }
    with get_db() as db:
        db.execute(
            """
            UPDATE focus_items
            SET item_key = ?, title = ?, bucket = ?, triage = ?, date = ?, date_end = ?, body = ?,
                people_json = ?, projects_json = ?, tags_json = ?, status = ?, updated_at = ?
            WHERE item_key = ?
            """,
            (
                record["item_key"],
                record["title"],
                record["bucket"],
                record["triage"],
                record["date"],
                record["date_end"],
                record["body"],
                json.dumps(record["people"], ensure_ascii=False),
                json.dumps(record["projects"], ensure_ascii=False),
                json.dumps(record["tags"], ensure_ascii=False),
                record["status"],
                record["updated_at"],
                old_key,
            ),
        )
        if old_key != new_key:
            db.execute("UPDATE focus_updates SET item_key = ?, item_title = ? WHERE item_key = ?", (new_key, new_title, old_key))
            db.execute("UPDATE focus_slots SET item_key = ?, item_title = ? WHERE item_key = ?", (new_key, new_title, old_key))
            db.execute(
                "INSERT OR REPLACE INTO focus_item_conv (item_key, conv_id, created_at) "
                "SELECT ?, conv_id, created_at FROM focus_item_conv WHERE item_key = ?",
                (new_key, old_key),
            )
            db.execute("DELETE FROM focus_item_conv WHERE item_key = ?", (old_key,))
            db.execute("DELETE FROM focus_titles WHERE item_key = ?", (old_key,))
    return record


def _focus_watch_token() -> dict:
    _focus_ensure_store()
    with get_db() as db:
        row = db.execute(
            """
            SELECT
                (SELECT MAX(updated_at) FROM focus_items),
                (SELECT COUNT(*) FROM focus_items WHERE status = 'open'),
                (SELECT MAX(updated_at) FROM focus_slots),
                (SELECT MAX(updated_at) FROM focus_titles),
                (SELECT MAX(ts) FROM focus_updates)
            """
        ).fetchone()
    payload = {
        "items_updated_at": row[0] if row else None,
        "open_count": row[1] if row else 0,
        "slots_updated_at": row[2] if row else None,
        "titles_updated_at": row[3] if row else None,
        "updates_updated_at": row[4] if row else None,
    }
    payload["token"] = "|".join("" if v is None else str(v) for v in payload.values())
    return payload


def _focus_base_date(day_iso: str | None = None):
    if day_iso:
        try:
            return datetime.fromisoformat(day_iso).date()
        except ValueError:
            pass
    return datetime.now(ZoneInfo("Europe/Berlin")).date()


def _focus_clock(min_: int) -> str:
    minutes = max(0, int(min_ or 0))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _focus_trim(text: str, limit: int = 120) -> str:
    raw = re.sub(r"\s+", " ", (text or "").strip())
    if len(raw) <= limit:
        return raw
    return raw[: limit - 1].rstrip() + "…"


def _focus_format_calendar(title: str, start_iso: str, duration_min: int, all_day: int, location: str, category: str) -> str:
    label = _focus_trim(title or "ohne Titel", 90)
    if all_day:
        out = f"ganztägig {label}"
    else:
        try:
            dt = datetime.fromisoformat(start_iso)
            end = dt + timedelta(minutes=max(5, int(duration_min or 60)))
            out = f"{dt.hour:02d}:{dt.minute:02d}–{end.hour:02d}:{end.minute:02d} {label}"
        except ValueError:
            out = f"{(start_iso or '')[11:16] or '??:??'} {label}"
    if location:
        out += f" · {_focus_trim(location, 40)}"
    cat = (category or "").strip().lower()
    if cat and cat != "klaus":
        out += f" · {cat}"
    return out


def collect_focus_briefing_payload(day_iso: str | None = None) -> dict:
    base_day = _focus_base_date(day_iso)
    today_iso = base_day.isoformat()
    tomorrow_iso = (base_day + timedelta(days=1)).isoformat()
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    now_min = now.hour * 60 + now.minute
    payload = {
        "today": today_iso,
        "tomorrow": tomorrow_iso,
        "generated_at": now.strftime("%Y-%m-%d %H:%M"),
        "calendar_today": [],
        "calendar_tomorrow": [],
        "pt_today": [],
        "pt_tomorrow": [],
        "slots_today": [],
        "slots_tomorrow": [],
        "waiting_on_you": [],
        "lead_pipeline": [],
        "overdue_slots": [],
        "counts": {
            "calendar_today": 0,
            "calendar_tomorrow": 0,
            "pt_today": 0,
            "pt_tomorrow": 0,
            "slots_today": 0,
            "slots_tomorrow": 0,
            "waiting_on_you": 0,
            "lead_pipeline": 0,
            "overdue_slots": 0,
        },
    }

    try:
        with get_db() as db:
            cal_rows = db.execute(
                """
                SELECT start_iso, duration_min, title, location, category, all_day
                FROM calendar_events
                WHERE substr(start_iso, 1, 10) IN (?, ?)
                ORDER BY substr(start_iso, 1, 10), all_day ASC, start_iso ASC
                """,
                (today_iso, tomorrow_iso),
            ).fetchall()
            for start_iso, duration_min, title, location, category, all_day in cal_rows:
                key = "calendar_today" if str(start_iso or "")[:10] == today_iso else "calendar_tomorrow"
                payload[key].append(
                    _focus_format_calendar(title or "", start_iso or "", int(duration_min or 60), int(all_day or 0), location or "", category or "")
                )

            waiting_rows = db.execute(
                """
                SELECT person_name, subject, excerpt, klassifikation
                FROM events
                WHERE seen = 0 AND klassifikation IN ('kunden-antwort', 'termin-anfrage')
                ORDER BY ts ASC
                LIMIT 6
                """
            ).fetchall()
            for person_name, subject, excerpt, klassifikation in waiting_rows:
                who = _focus_trim(person_name or "Unbekannt", 40)
                kind = "Termin" if (klassifikation or "") == "termin-anfrage" else "Antwort"
                snippet = _focus_trim(subject or excerpt or "ohne Kontext", 90)
                payload["waiting_on_you"].append(f"{who} · {kind} · {snippet}")

            lead_rows = db.execute(
                """
                SELECT name, company, level, source, message
                FROM denzer_leads
                WHERE seen = 0
                ORDER BY ts_kv DESC
                LIMIT 6
                """
            ).fetchall()
            for name, company, level, source, message in lead_rows:
                parts = [_focus_trim(name or company or "Lead", 40)]
                meta = " · ".join(
                    x for x in (
                        _focus_trim(company or "", 30),
                        _focus_trim(level or "", 20),
                        _focus_trim(source or "", 20),
                    ) if x
                )
                if meta:
                    parts.append(meta)
                body = _focus_trim(message or "", 90)
                if body:
                    parts.append(body)
                payload["lead_pipeline"].append(" · ".join(parts))
    except Exception:
        pass

    try:
        with _people_db() as pcon:
            pt_rows = pcon.execute(
                """
                SELECT a.date, a.start_time, a.duration_min, a.training_type, p.name
                FROM pt_appointments a
                LEFT JOIN people p ON p.id = a.person_id
                WHERE a.date IN (?, ?) AND a.status = 'scheduled'
                ORDER BY a.date, a.start_time
                """,
                (today_iso, tomorrow_iso),
            ).fetchall()
        for row in pt_rows:
            key = "pt_today" if row["date"] == today_iso else "pt_tomorrow"
            label = f"{(row['start_time'] or '00:00')[:5]} {_focus_trim(row['name'] or 'PT', 40)}"
            training_type = (row["training_type"] or "").strip()
            if training_type:
                label += f" · {training_type}"
            dur = int(row["duration_min"] or 0)
            if dur:
                label += f" · {dur} min"
            payload[key].append(label)
    except Exception:
        pass

    for key in ("calendar_today", "calendar_tomorrow", "pt_today", "pt_tomorrow", "slots_today", "slots_tomorrow", "waiting_on_you", "lead_pipeline", "overdue_slots"):
        payload["counts"][key] = len(payload[key])
    return payload


def render_focus_briefing_markdown(day_iso: str | None = None) -> str:
    payload = collect_focus_briefing_payload(day_iso)
    lines = [
        f"# Fokusbriefing — {payload['today']}",
        "",
        "Quelle: `/fokus`, Kalender, Leads und lokale Datenbanken.",
        f"Aktualisiert: {payload['generated_at']}",
        "",
        f"Kurzstand: {payload['counts']['calendar_today']} Termine heute, {payload['counts']['waiting_on_you']} Antworten oder Terminsignale offen, {payload['counts']['lead_pipeline']} ungesehene Leads.",
        "",
    ]

    def add_section(title: str, entries: list[str], empty: str) -> None:
        lines.append(f"## {title}")
        if entries:
            for entry in entries:
                lines.append(f"- {entry}")
        else:
            lines.append(f"- {empty}")
        lines.append("")

    add_section("Heute im Kalender", payload["calendar_today"], "nichts terminiert")
    add_section("Heute in /fokus", payload["slots_today"], "keine geblockten Fokus-Slots")
    add_section("PT heute", payload["pt_today"], "keine PT-Termine")
    add_section("Wartet auf dich", payload["waiting_on_you"], "nichts offen")
    add_section("Pipeline", payload["lead_pipeline"], "keine ungesehenen Leads")
    if payload["overdue_slots"]:
        overdue_lines = []
        for item in payload["overdue_slots"]:
            status = "heute schon vorbei" if int(item["age_days"] or 0) == 0 else f"seit {int(item['age_days'] or 0)} Tagen überfällig"
            overdue_lines.append(f"{_focus_trim(item['title'], 90)} · {status}")
        add_section("Überfällige Blöcke", overdue_lines, "nichts überfällig")
    add_section("Morgen", payload["calendar_tomorrow"] + payload["pt_tomorrow"] + payload["slots_tomorrow"], "morgen noch leer")
    return "\n".join(lines).rstrip() + "\n"


def render_focus_system_snapshot(day_iso: str | None = None) -> str:
    payload = collect_focus_briefing_payload(day_iso)
    if not any(payload["counts"].values()):
        return ""
    parts = ["Fokus-Snapshot (vom System, aus /fokus und lokalen Datenquellen):"]
    if payload["slots_today"]:
        parts.append("- heute in /fokus: " + " · ".join(payload["slots_today"][:4]))
    if payload["calendar_today"]:
        parts.append("- heute im Kalender: " + " · ".join(payload["calendar_today"][:4]))
    if payload["waiting_on_you"]:
        parts.append("- wartet auf dich: " + " · ".join(payload["waiting_on_you"][:3]))
    if payload["lead_pipeline"]:
        parts.append("- Pipeline: " + " · ".join(payload["lead_pipeline"][:3]))
    if payload["overdue_slots"]:
        parts.append("- überfällig: " + " · ".join(_focus_trim(item["title"], 60) for item in payload["overdue_slots"][:3]))
    tomorrow = payload["calendar_tomorrow"][:2] + payload["pt_tomorrow"][:2] + payload["slots_tomorrow"][:2]
    if tomorrow:
        parts.append("- morgen: " + " · ".join(tomorrow[:4]))
    return "\n".join(parts) + "\n\n"


def _build_fokus_line(bucket: str, title: str, date: str, people: list, projects: list, tags: list) -> str:
    triage_marker = _FOKUS_TRIAGE_MARKERS.get(bucket, "~")
    date_str = date if date else "-"
    parts = [f"`{triage_marker}` {date_str} — {title}"]
    for p in people or []:
        if isinstance(p, dict) and p.get("name") and p.get("anchor"):
            parts.append(f"[{p['name']}](PEOPLE.md#{p['anchor']})")
    for p in projects or []:
        if isinstance(p, dict) and p.get("name") and p.get("anchor"):
            parts.append(f"[{p['name']}](PROJECTS.md#{p['anchor']})")
    for t in tags or []:
        if isinstance(t, str) and t.strip():
            parts.append(f"#{t.strip().lstrip('#')}")
    return "- " + " · ".join(parts)


def _fokus_item_key(title: str) -> str:
    import hashlib
    norm = (title or "").strip().lower()
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]


def _focus_parse_line(candidate: str) -> dict | None:
    line = (candidate or "").strip()
    m = _FOKUS_ITEM_RE.match(line)
    if not m:
        return None
    rest = m.group("rest")
    parts = [p.strip() for p in rest.split(" · ")]
    title = parts[0] if parts else ""
    people: list = []
    projects: list = []
    tags: list = []
    for meta in parts[1:]:
        pm = _FOKUS_PERSON_RE.match(meta)
        if pm:
            people.append({"name": pm.group("name"), "anchor": pm.group("anchor")})
            continue
        prm = _FOKUS_PROJECT_RE.match(meta)
        if prm:
            projects.append({"name": prm.group("name"), "anchor": prm.group("anchor")})
            continue
        tm = _FOKUS_TAG_RE.match(meta)
        if tm:
            tags.append(tm.group("tag"))
    raw_date = m.group("date")
    date_start = ""
    date_end = ""
    if raw_date and raw_date != "-":
        if ".." in raw_date:
            date_start, date_end = [x.strip() for x in raw_date.split("..", 1)]
        else:
            date_start = raw_date.strip()
    triage = _FOKUS_TRIAGE.get(m.group("triage"), "later")
    return {
        "title": title,
        "bucket": triage,
        "triage": triage,
        "date": date_start,
        "date_end": date_end,
        "people": people,
        "projects": projects,
        "tags": tags,
    }


@router.get("/api/fokus/updates")
async def fokus_updates_get(item_key: str = "", title: str = ""):
    """Updates (Notizen/Voice-Transkripte) zu einem Fokus-Item."""
    key = item_key or (_fokus_item_key(title) if title else "")
    if not key:
        return {"updates": []}
    from db import get_db
    with get_db() as db:
        rows = db.execute(
            "SELECT id, item_title, text, source, ts FROM focus_updates WHERE item_key = ? ORDER BY ts ASC",
            (key,)
        ).fetchall()
    return {"updates": [
        {"id": r[0], "item_title": r[1], "text": r[2], "source": r[3], "ts": r[4]}
        for r in rows
    ]}


@router.post("/api/fokus/updates")
async def fokus_updates_add(payload: dict = Body(...)):
    title = (payload.get("title") or "").strip()
    text = (payload.get("text") or "").strip()
    source = payload.get("source") or "text"
    if not title or not text:
        return JSONResponse({"error": "title und text erforderlich"}, status_code=400)
    resolved = _focus_resolve_identity(title=title)
    key = (resolved or {}).get("item_key") or _fokus_item_key(title)
    item_title = (resolved or {}).get("title") or title
    ts = time.time()
    with get_db() as db:
        cur = db.execute(
            "INSERT INTO focus_updates (item_key, item_title, text, source, ts) VALUES (?, ?, ?, ?, ?)",
            (key, item_title, text, source, ts)
        )
        new_id = cur.lastrowid
    return {"id": new_id, "item_key": key, "ts": ts}


@router.delete("/api/fokus/updates/{update_id}")
async def fokus_updates_delete(update_id: int):
    from db import get_db
    with get_db() as db:
        db.execute("DELETE FROM focus_updates WHERE id = ?", (update_id,))
    return {"ok": True}


@router.post("/api/fokus/item-conversation")
async def fokus_item_conversation(payload: dict = Body(...)):
    """Findet oder erstellt eine persistente Chat-Conversation pro Fokus-Item.

    Robust gegen Titel-Drift: wenn kein exakter Hash-Match, suche per Title-
    Ähnlichkeit (SequenceMatcher.ratio >= 0.62) unter den existierenden
    Item-Convs. Wenn was findet, übernimm die alte Conv und remappe item_key
    (in focus_item_conv UND focus_slots), damit künftig der neue Hash trifft.

    Body: {item_title}. Antwort: {conv_id, created, remapped_from?}."""
    from db import get_db, create_conversation
    import difflib as _difflib
    title = (payload.get("item_title") or "").strip()
    if not title:
        return JSONResponse({"error": "item_title erforderlich"}, status_code=400)
    resolved = _focus_resolve_identity(title=title)
    key = (resolved or {}).get("item_key") or _fokus_item_key(title)
    title = (resolved or {}).get("title") or title
    norm_title = title.strip().lower()
    with get_db() as db:
        # 1) Exact hash hit
        row = db.execute("SELECT conv_id FROM focus_item_conv WHERE item_key = ?", (key,)).fetchone()
        if row:
            conv_id = row[0]
            conv_row = db.execute("SELECT id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            if conv_row:
                return {"conv_id": conv_id, "created": False}
            db.execute("DELETE FROM focus_item_conv WHERE item_key = ?", (key,))

        # 2) Fuzzy on existing Fokus-Item-Convs: join mit conversations.title
        rows = db.execute(
            "SELECT fic.item_key, fic.conv_id, c.title "
            "FROM focus_item_conv fic JOIN conversations c ON c.id = fic.conv_id"
        ).fetchall()
        best = None  # (ratio, old_key, conv_id, conv_title)
        for old_key, conv_id, conv_title in rows:
            # Title in conversations ist "Fokus · <title>". Vergleich auf den nackten Teil.
            bare = (conv_title or "").lower()
            if bare.startswith("fokus · "):
                bare = bare[len("fokus · "):]
            ratio = _difflib.SequenceMatcher(None, norm_title, bare).ratio()
            if best is None or ratio > best[0]:
                best = (ratio, old_key, conv_id, conv_title)
        if best and best[0] >= 0.62:
            _, old_key, conv_id, _ = best
            # N:1: neuen Mapping-Eintrag dazu, der alte bleibt. So zeigen beide Items
            # auf dieselbe Conv und sammeln gemeinsam Kontext. Conv-Title bleibt am
            # alten Item hängen, weil das in der Regel der bekanntere Anker ist.
            db.execute(
                "INSERT OR REPLACE INTO focus_item_conv (item_key, conv_id, created_at) VALUES (?, ?, ?)",
                (key, conv_id, time.time())
            )
            return {"conv_id": conv_id, "created": False, "matched_from": old_key, "ratio": best[0]}

    # 3) Wirklich neu
    conv_id = create_conversation("main", "", f"Fokus · {title[:60]}", "claude")
    ts = time.time()
    with get_db() as db:
        db.execute(
            "INSERT INTO focus_item_conv (item_key, conv_id, created_at) VALUES (?, ?, ?)",
            (key, conv_id, ts)
        )
    return {"conv_id": conv_id, "created": True}


@router.post("/api/fokus/quick-add-conversation")
async def fokus_quick_add_conversation(_payload: dict = Body(default={})):
    """Spawnt eine frische Quick-Add-Conversation für die Plus-Voice-Anlage.
    Antwort: {conv_id}. Pro Plus-Klick eine neue Session, kein Wiederverwenden."""
    from db import get_db, create_conversation
    conv_id = create_conversation("main", "", "Fokus · Quick-Add", "claude")
    ts = time.time()
    with get_db() as db:
        db.execute(
            "INSERT INTO focus_quick_add_conv (conv_id, created_at) VALUES (?, ?)",
            (conv_id, ts),
        )
    return {"conv_id": conv_id}


@router.post("/api/fokus/refine")
async def fokus_refine(payload: dict = Body(...)):
    """der Nutzer tippt Freitext zu einem Fokus-Item, Claude überarbeitet dessen
    Fokus-Metadaten. Body: {item_title, user_text}."""
    title = (payload.get("item_title") or "").strip()
    user_text = (payload.get("user_text") or "").strip()
    if not title or not user_text:
        return JSONResponse({"error": "item_title und user_text erforderlich"}, status_code=400)
    item = _focus_resolve_identity(title=title)
    if not item or item.get("status") != "open":
        return JSONResponse({"error": "item not found"}, status_code=404)

    old_line = _build_fokus_line(
        item.get("bucket") or "later",
        item.get("title") or "",
        item.get("date") or "",
        item.get("people") or [],
        item.get("projects") or [],
        item.get("tags") or [],
    )
    today_iso = time.strftime("%Y-%m-%d")
    prompt = (
        "Du bekommst die aktuelle Fokus-Zeile eines offenen Items und einen Update-Text von der Nutzer. "
        "Aktualisiere nur Triage, Datum, Titel und Metadaten gemäß seinem Update.\n\n"
        "Zeilenformat: `- \\`<T>\\` <DATE> — <TITEL> [· @[Name](#anchor)] [· *[Projekt](#anchor)*] [· #tag ...]`\n"
        "Triage-Marker T: `!` = jetzt, `>` = bald, `~` = später\n"
        f"DATE: YYYY-MM-DD oder `-` wenn ohne Datum. Heute = {today_iso}.\n\n"
        "Regeln:\n"
        "- Nur die Zeile zurückgeben, kein Markdown-Block, keine Erklärung, kein Fließtext drumherum.\n"
        "- Wenn das Item erledigt ist: gib `DONE` zurück.\n"
        "- Wenn das Item gelöscht werden soll: gib `DELETE` zurück.\n"
        "- Wenn keine Änderung sinnvoll: gib `NOOP` zurück.\n"
        "- Behalte existierende Person-/Projekt-/Tag-Links, wenn sie noch passen.\n\n"
        f"Aktuelle Zeile:\n{old_line}\n\n"
        f"des Nutzers Update:\n{user_text}\n\n"
        "Neue Zeile (oder DONE/DELETE/NOOP):"
    )
    from local_llm import call_with_haiku_fallback
    try:
        stdout, _model = await call_with_haiku_fallback(
            prompt, feature="fokus_item_update",
            system="Du aktualisierst Fokus-Items strikt im verlangten Zeilenformat.",
            max_tokens=200, temperature=0.2, qwen_timeout=15.0, haiku_timeout=30.0,
        )
    except Exception as e:
        return JSONResponse({"error": f"llm failed: {e}"}, status_code=500)
    if not stdout.strip():
        return JSONResponse({"error": "llm empty"}, status_code=500)
    new_text = stdout.strip()
    new_text = new_text.removeprefix("```").removeprefix("md").removeprefix("markdown").strip()
    new_text = new_text.removesuffix("```").strip()
    # Erste nicht-leere Zeile nehmen
    candidate = ""
    for ln in new_text.splitlines():
        ln = ln.strip()
        if ln:
            candidate = ln
            break
    if not candidate:
        return {"ok": False, "action": "noop", "old_line": old_line, "new_line": old_line}
    action = "updated"
    if candidate.upper() == "NOOP":
        return {"ok": True, "action": "noop", "old_line": old_line, "new_line": old_line}
    if candidate.upper() == "DELETE":
        _focus_store_update(item, {"status": "archived"})
        with get_db() as db:
            db.execute("DELETE FROM focus_slots WHERE item_key = ?", (item["item_key"],))
        return {"ok": True, "action": "deleted", "old_line": old_line, "new_line": ""}
    if candidate.upper() == "DONE":
        _focus_store_update(item, {"status": "done"})
        with get_db() as db:
            db.execute("DELETE FROM focus_slots WHERE item_key = ?", (item["item_key"],))
        return {"ok": True, "action": "done", "old_line": old_line, "new_line": ""}
    if not _FOKUS_ITEM_RE.match(candidate):
        return JSONResponse({"error": "claude output not in line format", "raw": candidate[:300]}, status_code=502)
    fresh = _focus_parse_line(candidate)
    if not fresh:
        return JSONResponse({"error": "claude output not parseable", "raw": candidate[:300]}, status_code=502)
    updated = _focus_store_update(
        item,
        {
            "title": fresh.get("title") or item.get("title"),
            "bucket": fresh.get("bucket") or item.get("bucket"),
            "triage": fresh.get("triage") or item.get("triage"),
            "date": fresh.get("date") or "",
            "date_end": fresh.get("date_end") or "",
            "people": fresh.get("people") or [],
            "projects": fresh.get("projects") or [],
            "tags": fresh.get("tags") or [],
            "status": "open",
        },
    )
    try:
        _entities.tag_text(updated.get("title") or "", _entities.SOURCE_FOCUS, updated.get("item_key") or "")
    except Exception:
        pass
    return {"ok": True, "action": action, "old_line": old_line, "new_line": candidate}


@router.get("/api/fokus/slots")
async def fokus_slots_get(start: str = "", end: str = ""):
    """Slots im Bereich [start, end] inklusive. start/end sind YYYY-MM-DD."""
    return {"slots": []}
    from db import get_db
    if not start or not end:
        return {"slots": []}
    with get_db() as db:
        rows = db.execute(
            """SELECT s.id, s.item_key, s.item_title, s.day_iso, s.start_min, s.dur_min
                 FROM focus_slots s
                 JOIN focus_items i ON i.item_key = s.item_key
                WHERE s.day_iso >= ? AND s.day_iso <= ?
                ORDER BY s.day_iso, s.start_min""",
            (start, end),
        ).fetchall()
    return {"slots": [
        {"id": r[0], "item_key": r[1], "item_title": r[2], "day_iso": r[3], "start_min": r[4], "dur_min": r[5]}
        for r in rows
    ]}


@router.post("/api/fokus/slots")
async def fokus_slots_set(payload: dict = Body(...)):
    """Slot setzen oder aktualisieren. Eindeutig per (item_key, day_iso).
    Body: {title, day_iso, start_min, dur_min}. Wenn start_min < 0: Slot loeschen."""
    return {"ok": True, "disabled": True}
    title = (payload.get("title") or "").strip()
    day_iso = (payload.get("day_iso") or "").strip()
    if not title or not day_iso:
        return {"ok": False, "error": "title und day_iso erforderlich"}
    resolved = _focus_resolve_identity(title=title)
    if not resolved:
        return {"ok": False, "error": "item nicht gefunden"}
    key = resolved["item_key"]
    title = resolved["title"]
    start_min = int(payload.get("start_min", 0))
    dur_min = max(30, int(payload.get("dur_min", 30)))
    ts = time.time()
    with get_db() as db:
        if start_min < 0:
            db.execute("DELETE FROM focus_slots WHERE item_key = ? AND day_iso = ?", (key, day_iso))
            return {"ok": True, "deleted": True}
        existing = db.execute(
            "SELECT id FROM focus_slots WHERE item_key = ? AND day_iso = ? LIMIT 1",
            (key, day_iso),
        ).fetchone()
        if existing:
            db.execute(
                "UPDATE focus_slots SET start_min = ?, dur_min = ?, updated_at = ? WHERE id = ?",
                (start_min, dur_min, ts, existing[0]),
            )
            return {"ok": True, "id": existing[0], "item_key": key}
        cur = db.execute(
            "INSERT INTO focus_slots (item_key, item_title, day_iso, start_min, dur_min, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (key, title, day_iso, start_min, dur_min, ts),
        )
        return {"ok": True, "id": cur.lastrowid, "item_key": key}


@router.delete("/api/fokus/slots")
async def fokus_slots_delete(title: str = "", day_iso: str = ""):
    if not title or not day_iso:
        return {"ok": False, "error": "title und day_iso erforderlich"}
    resolved = _focus_resolve_identity(title=title)
    if not resolved:
        return {"ok": False, "error": "item nicht gefunden"}
    key = resolved["item_key"]
    with get_db() as db:
        db.execute("DELETE FROM focus_slots WHERE item_key = ? AND day_iso = ?", (key, day_iso))
    return {"ok": True}


@router.get("/api/fokus")
async def fokus_get():
    """Liefert strukturierte Fokus-Items aus dem lokalen Fokus-Store."""
    try:
        items = _focus_list_items(include_done=False, business_only=True)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    # Kurztitel anhängen wo gecached; fehlende werden im Background von Haiku gekürzt.
    _fokus_attach_short_titles(items)
    token = _focus_watch_token()
    return {"items": items, "updated_at": token.get("items_updated_at")}


@router.get("/api/fokus/briefing")
async def fokus_briefing(date_iso: str = ""):
    payload = collect_focus_briefing_payload(date_iso or None)
    return {"payload": payload, "markdown": render_focus_briefing_markdown(date_iso or None)}


def _fokus_ensure_default_slots(items: list) -> None:
    return
    """Sorgt dafür, dass jedes Item mit Datum einen Slot hat. Default 30 Min in
    der ersten freien Lücke ab 09:00, hinter bereits gebuchten Slots und
    PT-Terminen. So entsteht eine realistische Anruf-/Erinnerungs-Reihe statt
    eines breiten Ganztages-Banners."""
    from db import get_db
    targets: list[tuple[str, str, str]] = []
    for it in items:
        date = (it.get("date") or "").strip()
        title = (it.get("title") or "").strip()
        key = it.get("item_key") or ""
        if date and title and key:
            targets.append((key, title, date))
    if not targets:
        return
    by_date: dict[str, list[tuple[str, str]]] = {}
    for key, title, date in targets:
        by_date.setdefault(date, []).append((key, title))

    pt_by_date: dict[str, list[tuple[int, int]]] = {}
    if by_date:
        dates_sorted = sorted(by_date.keys())
        try:
            with _people_db() as pcon:
                rows = pcon.execute(
                    """
                    SELECT date, start_time, duration_min FROM pt_appointments
                    WHERE date >= ? AND date <= ? AND status = 'scheduled'
                    """,
                    (dates_sorted[0], dates_sorted[-1]),
                ).fetchall()
            for r in rows:
                d = r["date"]
                st = (r["start_time"] or "00:00")
                try:
                    h, m = int(st[0:2]), int(st[3:5])
                    start = h * 60 + m
                    dur = int(r["duration_min"] or 60)
                except Exception:
                    continue
                pt_by_date.setdefault(d, []).append((start, start + dur))
        except Exception as e:
            print(f"[fokus] pt-slots load failed: {e}", file=sys.stderr)

    def next_free(occupied: list[tuple[int, int]], from_min: int, dur: int, max_end: int) -> int | None:
        cursor = from_min
        for s, e in sorted(occupied):
            if e <= cursor:
                continue
            if cursor + dur <= s:
                return cursor
            cursor = max(cursor, e)
        if cursor + dur <= max_end:
            return cursor
        return None

    try:
        with get_db() as db:
            all_keys = {key for key, _, _ in targets}
            placeholders = ",".join("?" * len(all_keys))
            scheduled_anywhere = {
                r[0] for r in db.execute(
                    f"SELECT DISTINCT item_key FROM focus_slots WHERE item_key IN ({placeholders})",
                    list(all_keys),
                ).fetchall()
            }
            for date, batch in by_date.items():
                rows = db.execute(
                    "SELECT item_key, start_min, dur_min FROM focus_slots WHERE day_iso = ?",
                    (date,),
                ).fetchall()
                existing_keys = {r[0] for r in rows}
                occupied: list[tuple[int, int]] = [(r[1], r[1] + r[2]) for r in rows]
                occupied += pt_by_date.get(date, [])
                for key, title in batch:
                    if key in existing_keys or key in scheduled_anywhere:
                        continue
                    start = next_free(occupied, 540, 30, 22 * 60)
                    if start is None:
                        continue
                    db.execute(
                        "INSERT INTO focus_slots (item_key, item_title, day_iso, start_min, dur_min, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (key, title, date, start, 30, time.time()),
                    )
                    existing_keys.add(key)
                    scheduled_anywhere.add(key)
                    occupied.append((start, start + 30))
    except Exception:
        pass


def _next_free_slot(occupied: list[tuple[int, int]], from_min: int, dur: int, max_end: int) -> int | None:
    """Erste freie Lücke ab `from_min` für `dur` Minuten, vor `max_end`."""
    cursor = from_min
    for s, e in sorted(occupied):
        if e <= cursor:
            continue
        if cursor + dur <= s:
            return cursor
        cursor = max(cursor, e)
    if cursor + dur <= max_end:
        return cursor
    return None


def _fokus_reschedule_overdue_slots(items: list) -> int:
    return 0
    """Schiebt Slots offener Items, deren Endzeit in der Vergangenheit liegt,
    auf die nächste freie Lücke ab jetzt+15min (sonst nächster Werktag ab 09:00).
    Items, die nicht mehr in der aktuellen Liste sind (erledigt/verschoben), werden
    nicht angefasst — die alten Slots bleiben für Historie/Anzeige stehen.

    Rückgabe: Anzahl der tatsächlich verschobenen Slots.
    """
    from db import get_db
    from datetime import datetime, timedelta

    open_keys = {it.get("item_key") for it in items if it.get("item_key")}
    if not open_keys:
        return 0

    now = datetime.now()
    today_iso = now.strftime("%Y-%m-%d")
    now_min = now.hour * 60 + now.minute
    cutoff_today = min(now_min + 15, 22 * 60)

    try:
        with get_db() as db:
            placeholders = ",".join("?" * len(open_keys))
            rows = db.execute(
                f"SELECT id, item_key, item_title, day_iso, start_min, dur_min FROM focus_slots WHERE item_key IN ({placeholders})",
                list(open_keys),
            ).fetchall()
            overdue: list[dict] = []
            for r in rows:
                day = r[3]
                end_min = (r[4] or 0) + (r[5] or 30)
                if day < today_iso:
                    overdue.append({"id": r[0], "key": r[1], "title": r[2], "dur": r[5] or 30})
                elif day == today_iso and end_min <= now_min:
                    overdue.append({"id": r[0], "key": r[1], "title": r[2], "dur": r[5] or 30})
            if not overdue:
                return 0
            moved = 0

            # Belegte Slots heute (focus_slots heute) holen, um Lücken zu finden
            today_rows = db.execute(
                "SELECT start_min, dur_min FROM focus_slots WHERE day_iso = ?",
                (today_iso,),
            ).fetchall()
            occupied_today: list[tuple[int, int]] = [(r[0], r[0] + r[1]) for r in today_rows]

            # PT-Termine heute mit reinrechnen
            try:
                with _people_db() as pcon:
                    pt_rows = pcon.execute(
                        "SELECT start_time, duration_min FROM pt_appointments WHERE date = ? AND status = 'scheduled'",
                        (today_iso,),
                    ).fetchall()
                for r in pt_rows:
                    st = r["start_time"] or "00:00"
                    try:
                        h, m = int(st[0:2]), int(st[3:5])
                        s = h * 60 + m
                        d = int(r["duration_min"] or 60)
                        occupied_today.append((s, s + d))
                    except Exception:
                        continue
            except Exception:
                pass

            # Pro Folgetag eine Belegungs-Liste cachen, falls heute keine Lücke mehr ist
            occupied_by_day: dict[str, list[tuple[int, int]]] = {today_iso: occupied_today}

            def get_occupied(day_iso: str) -> list[tuple[int, int]]:
                if day_iso in occupied_by_day:
                    return occupied_by_day[day_iso]
                slot_rows = db.execute(
                    "SELECT start_min, dur_min FROM focus_slots WHERE day_iso = ?",
                    (day_iso,),
                ).fetchall()
                occ: list[tuple[int, int]] = [(r[0], r[0] + r[1]) for r in slot_rows]
                try:
                    with _people_db() as pcon:
                        pt_rows = pcon.execute(
                            "SELECT start_time, duration_min FROM pt_appointments WHERE date = ? AND status = 'scheduled'",
                            (day_iso,),
                        ).fetchall()
                    for r in pt_rows:
                        st = r["start_time"] or "00:00"
                        try:
                            h, m = int(st[0:2]), int(st[3:5])
                            s = h * 60 + m
                            d = int(r["duration_min"] or 60)
                            occ.append((s, s + d))
                        except Exception:
                            continue
                except Exception:
                    pass
                occupied_by_day[day_iso] = occ
                return occ

            for ov in overdue:
                dur = ov["dur"]
                # Versuch 1: heute ab jetzt+15min
                start = _next_free_slot(occupied_today, cutoff_today, dur, 22 * 60)
                target_day = today_iso
                if start is None:
                    # Folgetage durchprobieren (max 7 Tage)
                    for offset in range(1, 8):
                        cand_day = (now + timedelta(days=offset)).strftime("%Y-%m-%d")
                        cand_occ = get_occupied(cand_day)
                        cand_start = _next_free_slot(cand_occ, 9 * 60, dur, 22 * 60)
                        if cand_start is not None:
                            start = cand_start
                            target_day = cand_day
                            break
                    if start is None:
                        continue
                db.execute(
                    "UPDATE focus_slots SET day_iso = ?, start_min = ?, updated_at = ? WHERE id = ?",
                    (target_day, start, time.time(), ov["id"]),
                )
                get_occupied(target_day).append((start, start + dur))
                moved += 1
        return moved
    except Exception as e:
        print(f"[fokus] reschedule failed: {e}", file=sys.stderr)
        return 0


def fokus_heartbeat_tick() -> int:
    try:
        items = _focus_list_items(include_done=False, business_only=True)
    except Exception:
        return 0
    return _fokus_reschedule_overdue_slots(items) or 0


# Schwelle ab der Titel gekürzt werden. Darunter ist der Originaltitel kompakt genug.
_FOKUS_SHORT_THRESHOLD = 32


def _fokus_attach_short_titles(items: list) -> None:
    """Hängt short_title an Items wo gecached, kickt Background-Haiku für fehlende.
    Idempotent: bei Treffer mit gleichem full_title wird das Cache-Ergebnis genutzt.
    Bei Miss oder veraltetem full_title spawnt einen async-Task der Haiku ruft."""
    from db import get_db
    long_items: list[tuple[str, str]] = []
    for it in items:
        title = (it.get("title") or "").strip()
        key = it.get("item_key") or ""
        if not title or not key:
            continue
        if len(title) > _FOKUS_SHORT_THRESHOLD:
            long_items.append((key, title))
    if not long_items:
        return
    cache: dict[str, tuple[str, str]] = {}
    try:
        with get_db() as db:
            placeholders = ",".join("?" * len(long_items))
            rows = db.execute(
                f"SELECT item_key, full_title, short_title FROM focus_titles WHERE item_key IN ({placeholders})",
                [k for k, _ in long_items],
            ).fetchall()
            for r in rows:
                cache[r[0]] = (r[1], r[2])
    except Exception:
        cache = {}

    pending: list[tuple[str, str]] = []
    for key, title in long_items:
        cached = cache.get(key)
        if cached and cached[0] == title:
            for it in items:
                if it.get("item_key") == key:
                    it["short_title"] = cached[1]
                    break
        else:
            pending.append((key, title))

    if pending:
        try:
            asyncio.create_task(_fokus_shorten_background(pending))
        except RuntimeError:
            # kein laufender Loop, dann diesmal ohne Kurztitel — nächster Call holt's nach
            pass


async def _fokus_shorten_background(pending: list[tuple[str, str]]) -> None:
    """Ruft Haiku für jeden ausstehenden Titel und schreibt die Kürzel in die DB."""
    for key, title in pending:
        prompt = (
            f"Kürze diesen Aufgaben-Titel auf maximal {_FOKUS_SHORT_THRESHOLD} Zeichen. "
            "Behalte die Kernaussage, lass Erläuterungen und Zusätze weg. "
            "Keine Anführungszeichen, keine Erklärung, nur der gekürzte Titel auf einer Zeile.\n\n"
            f"Titel: {title}"
        )
        try:
            from local_llm import call_with_haiku_fallback
            stdout, _model = await call_with_haiku_fallback(
                prompt, feature="fokus_short_title",
                system="Du kürzt Aufgaben-Titel knapp und treffsicher. Antworte mit einer Zeile.",
                max_tokens=60, temperature=0.2, qwen_timeout=10.0, haiku_timeout=18.0,
            )
        except Exception:
            continue
        if not stdout.strip():
            continue
        short = stdout.strip().strip('"').strip("'").splitlines()[0].strip()
        if not short or len(short) < 4 or len(short) > _FOKUS_SHORT_THRESHOLD + 8:
            continue
        try:
            with get_db() as db:
                db.execute(
                    "INSERT INTO focus_titles (item_key, full_title, short_title, updated_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(item_key) DO UPDATE SET full_title=excluded.full_title, short_title=excluded.short_title, updated_at=excluded.updated_at",
                    (key, title, short, time.time()),
                )
        except Exception:
            continue


@router.get("/api/fokus/watch")
async def fokus_watch(request: Request):
    """Server-Sent Events: pingt sobald sich der Fokus-Store ändert."""
    import asyncio
    import json as _json

    async def gen():
        state = _focus_watch_token()
        last_token = state.get("token")
        # initialer hello, damit Client weiß dass die Verbindung steht
        yield f"data: {_json.dumps({'type': 'hello', 'mtime': state.get('items_updated_at'), 'token': last_token})}\n\n"
        while True:
            if await request.is_disconnected():
                break
            cur = _focus_watch_token()
            if cur.get("token") != last_token:
                last_token = cur.get("token")
                yield f"data: {_json.dumps({'type': 'change', 'mtime': cur.get('items_updated_at'), 'token': last_token})}\n\n"
            else:
                # keepalive alle ~15s als Kommentar (von SSE-Clients ignoriert)
                yield ": keepalive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


_FOKUS_DEDUP_STOPWORDS = {
    "und", "oder", "der", "die", "das", "mit", "ohne", "fur", "für", "bei",
    "von", "zu", "im", "in", "an", "am", "auf", "ein", "eine", "einen",
    "den", "dem", "des", "ist", "war", "sind", "wird", "werden", "noch",
    "auch", "schon", "neu", "neuen", "neue", "alle", "alles", "etwas",
    "the", "and", "for", "with", "of", "to", "in", "on", "at",
}


def _fokus_tokens(title: str) -> set:
    raw = re.sub(r"[^\wäöüÄÖÜß]+", " ", (title or "").lower())
    return {t for t in raw.split() if len(t) >= 3 and t not in _FOKUS_DEDUP_STOPWORDS}


def _fokus_find_similar(new_title: str, items: list, threshold: float = 0.55):
    """Findet semantisch ähnliches existierendes Item (Token-Jaccard).
    Erledigte Items werden ignoriert (nur 'Jetzt'/'Bald'/'Später')."""
    new_tokens = _fokus_tokens(new_title)
    if len(new_tokens) < 2:
        return None
    best = None
    best_score = 0.0
    for it in items:
        if it.get("bucket") not in {"now", "soon", "later"}:
            continue
        ex_tokens = _fokus_tokens(it.get("title", ""))
        if not ex_tokens:
            continue
        union = new_tokens | ex_tokens
        inter = new_tokens & ex_tokens
        if not union:
            continue
        score = len(inter) / len(union)
        # Substring-Bonus: kompletter Titel im anderen enthalten
        nl = new_title.strip().lower()
        el = (it.get("title") or "").strip().lower()
        if nl and el and (nl in el or el in nl):
            score = max(score, 0.7)
        if score > best_score:
            best_score = score
            best = it
    if best and best_score >= threshold:
        return best
    return None


@router.post("/api/fokus")
async def fokus_add(payload: dict = Body(...)):
    """Fügt ein offenes Item in den Fokus-Store ein."""
    bucket = ((payload or {}).get("bucket") or "now").lower()
    if bucket not in _FOKUS_BUCKET_LABELS:
        return JSONResponse({"error": "invalid bucket"}, status_code=400)
    title = ((payload or {}).get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "title required"}, status_code=400)
    date = ((payload or {}).get("date") or "").strip()
    if date and not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return JSONResponse({"error": "invalid date"}, status_code=400)
    force = bool((payload or {}).get("force", False))
    existing_any = _focus_resolve_identity(title=title)

    # Dedup-Check
    if not force:
        existing = _focus_list_items(include_done=False, business_only=False)
        similar = _fokus_find_similar(title, existing)
        if similar:
            return JSONResponse(
                {"error": "duplicate", "existing": similar},
                status_code=409,
            )

    if existing_any:
        updated = _focus_store_update(
            existing_any,
            {
                "title": title,
                "bucket": bucket,
                "triage": bucket,
                "date": date,
                "body": (payload or {}).get("body") or existing_any.get("body") or "",
                "people": (payload or {}).get("people") or existing_any.get("people") or [],
                "projects": (payload or {}).get("projects") or existing_any.get("projects") or [],
                "tags": (payload or {}).get("tags") or existing_any.get("tags") or [],
                "status": "open",
            },
        )
        key = updated["item_key"]
    else:
        key = _fokus_item_key(title)
        now_ts = _focus_now_ts()
        with get_db() as db:
            db.execute(
                """
                INSERT INTO focus_items (
                    item_key, title, bucket, triage, date, date_end, body,
                    people_json, projects_json, tags_json, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'open', ?, ?)
                """,
                (
                    key,
                    title,
                    bucket,
                    bucket,
                    date,
                    (payload or {}).get("body") or "",
                    json.dumps((payload or {}).get("people") or [], ensure_ascii=False),
                    json.dumps((payload or {}).get("projects") or [], ensure_ascii=False),
                    json.dumps((payload or {}).get("tags") or [], ensure_ascii=False),
                    now_ts,
                    now_ts,
                ),
            )
    try:
        _entities.tag_text(title, _entities.SOURCE_FOCUS, key)
    except Exception:
        pass
    return {"ok": True, "item_key": key}


@router.post("/api/fokus/done")
async def fokus_done(payload: dict = Body(...)):
    """Markiert ein Fokus-Item als erledigt und nimmt es aus der offenen Ansicht."""
    title = ((payload or {}).get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "title required"}, status_code=400)
    item = _focus_resolve_identity(title=title)
    if not item or item.get("status") != "open":
        return JSONResponse({"error": "item not found"}, status_code=404)
    _focus_store_update(item, {"status": "done"})
    with get_db() as db:
        db.execute("DELETE FROM focus_slots WHERE item_key = ?", (item["item_key"],))
    return {"ok": True}


# ── Fokus — Heute-Karte (agentische Top-3) ──

_FOKUS_HEUTE_CACHE: dict = {"token": None, "today": None, "data": None}


def _fokus_extract_section_by_anchor(md_text: str, anchor: str) -> str | None:
    lines = md_text.splitlines()
    anchor_lower = anchor.lower()
    in_section = False
    out: list = []
    for line in lines:
        if line.startswith("## "):
            head = line[3:].strip().lower()
            slug = re.sub(r"[^a-z0-9]+", "-", head).strip("-")
            if in_section:
                break
            if slug == anchor_lower or anchor_lower in slug or slug in anchor_lower:
                in_section = True
                continue
        if in_section:
            out.append(line)
    if not out:
        return None
    return "\n".join(out).strip()[:1500]


@router.get("/api/fokus/heute")
async def fokus_heute():
    """Liefert die maximal 3 wichtigsten Items für heute, agentisch priorisiert."""
    try:
        items = _focus_list_items(include_done=False, business_only=True)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    token = _focus_watch_token().get("token")

    if (
        _FOKUS_HEUTE_CACHE.get("token") == token
        and _FOKUS_HEUTE_CACHE.get("today") == today
        and _FOKUS_HEUTE_CACHE.get("data") is not None
    ):
        return _FOKUS_HEUTE_CACHE["data"]

    if not items:
        result = {"items": [], "rationale": "Nichts offen.", "today": today}
        _FOKUS_HEUTE_CACHE.update({"token": token, "today": today, "data": result})
        return result

    # Items für Claude formatieren
    item_lines = []
    for i, it in enumerate(items, 1):
        people_str = ", ".join(p["name"] for p in it["people"]) or "—"
        proj_str = ", ".join(p["name"] for p in it["projects"]) or "—"
        date_str = it["date"] or "kein Datum"
        item_lines.append(
            f"{i}. [{it['triage'].upper()}] {date_str} — {it['title']} (Person: {people_str}, Projekt: {proj_str})"
        )
    items_text = "\n".join(item_lines)

    prompt = f"""Heute ist {today}. Wähle aus dieser Liste die maximal 3 wichtigsten Aufgaben für heute. Priorisiere nach: überfällig vor heute fällig vor Person wartet vor Versprechen vor Geld vor Workshop-Vorbereitung. Wähle weniger als 3, wenn nicht mehr als das wirklich heute zählt.

Items:
{items_text}

Antworte strikt im Format, keine Einleitung:
PICKS: <Komma-getrennte Item-Nummern, max 3, z.B. 1, 5, 8>
WARUM: <Ein knapper Satz Prosa, warum diese zählen — kein Listing, kein "Item 1...".>
"""

    picks: list = []
    rationale = ""
    try:
        from local_llm import call_with_haiku_fallback
        stdout, _model = await call_with_haiku_fallback(
            prompt, feature="fokus_today_picks",
            system="Du wählst Tages-Prioritäten aus einer Liste. Antworte strikt im verlangten PICKS/WARUM-Format.",
            max_tokens=200, temperature=0.2, qwen_timeout=12.0, haiku_timeout=20.0,
        )
    except Exception:
        stdout = ""

    if stdout.strip():
        for line in stdout.strip().splitlines():
            s = line.strip()
            if s.upper().startswith("PICKS:"):
                nums = s[len("PICKS:"):].strip()
                for n in nums.replace(",", " ").split():
                    try:
                        picks.append(int(n))
                    except ValueError:
                        pass
            elif s.upper().startswith("WARUM:"):
                rationale = s[len("WARUM:"):].strip()

    if not picks:
        # Fallback: deterministisch — überfällig + heute zuerst, dann nächstgelegene now-Items
        scored: list = []
        for i, it in enumerate(items, 1):
            score = 0
            if it["bucket"] == "now":
                score += 100
            if it["date"]:
                if it["date"] < today:
                    score += 200
                elif it["date"] == today:
                    score += 150
                else:
                    score += max(0, 50 - (int(it["date"][:4]) * 365 - int(today[:4]) * 365))
            scored.append((score, i))
        scored.sort(key=lambda x: -x[0])
        picks = [i for _, i in scored[:3]]
        if not rationale:
            rationale = "Top 3 nach Frist und Triage."

    picked_items = []
    seen = set()
    for n in picks:
        if 1 <= n <= len(items) and n not in seen:
            picked_items.append(items[n - 1])
            seen.add(n)
        if len(picked_items) >= 3:
            break

    result = {"items": picked_items, "rationale": rationale, "today": today}
    _FOKUS_HEUTE_CACHE.update({"token": token, "today": today, "data": result})
    return result


def _person_db_row_to_block(row) -> dict:
    """Rendert eine people.db-Row als Markdown-Block fürs Detail-Panel."""
    name = (row["name"] or "").strip()
    role = (row["role"] or "").strip()
    company = (row["company"] or "").strip()
    status = (row["status"] or "").strip()
    city = (row["city"] or "").strip()
    notes = (row["notes"] or "").strip()
    tags_raw = (row["tags"] or "").strip()

    head_parts: list = []
    if role:
        head_parts.append(role)
    if company:
        head_parts.append(company)
    if city:
        head_parts.append(city)
    if status:
        head_parts.append(f"Status: {status}")

    text_parts: list = []
    if head_parts:
        text_parts.append(" · ".join(head_parts))
    if tags_raw:
        try:
            tags = json.loads(tags_raw) if tags_raw.startswith("[") else []
        except Exception:
            tags = []
        if tags:
            text_parts.append("Tags: " + ", ".join(f"#{t}" for t in tags))
    if notes:
        text_parts.append(notes[:600])

    return {
        "name": name,
        "anchor": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
        "text": "\n\n".join(text_parts) or "—",
    }


# Persistenter SQLite-Cache (Tabelle focus_synth_cache). Key = sha1 über Titel + Rohblöcke,
# invalidiert sich automatisch sobald sich Kontext ändert. Überlebt Server-Restarts. TTL 30 Tage,
# weil der Hash sowieso bei jedem Content-Change kippt.
_FOKUS_SYNTH_TTL = 30 * 24 * 3600


async def _fokus_synthesize(item: dict, people_blocks: list, project_blocks: list, mentions: list, chat_traces: list) -> dict | None:
    """Verdichtet die Rohblöcke zu vier kurzen Zeilen. Nur für die Frontend-Anzeige.
    Originale werden nicht angefasst. Cached persistent pro Inhalt-Hash."""
    from db import run_claude_cli, get_db
    import hashlib as _hashlib

    parts = [item.get("title") or ""]
    for blk in people_blocks:
        parts.append((blk.get("text") or "")[:1500])
    for blk in project_blocks:
        parts.append((blk.get("text") or "")[:1500])
    for m in mentions:
        parts.append((m.get("snippet") or "")[:600])
    for c in chat_traces:
        parts.append((c.get("snippet") or "")[:400])
    raw = "\n---\n".join(parts)
    if len(raw) < 80:
        return None  # zu wenig Substanz, lohnt sich nicht
    cache_key = _hashlib.sha1(raw.encode("utf-8")).hexdigest()
    try:
        with get_db() as _db:
            row = _db.execute(
                "SELECT ts, data FROM focus_synth_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        if row and (time.time() - float(row[0])) < _FOKUS_SYNTH_TTL:
            return json.loads(row[1])
    except Exception:
        pass

    people_txt = "\n".join(f"### {b.get('name','?')}\n{(b.get('text') or '')[:1200]}" for b in people_blocks[:3])
    projects_txt = "\n".join(f"### {b.get('name','?')}\n{(b.get('text') or '')[:1500]}" for b in project_blocks[:3])
    mentions_txt = "\n".join(f"[{m.get('date','?')}] {(m.get('snippet') or '')[:500]}" for m in mentions[:5])
    chat_txt = "\n".join(f"[{c.get('author','?')}] {(c.get('snippet') or '')[:300]}" for c in chat_traces[:5])

    today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    prompt = f"""Heute ist {today}. Du bekommst eine Aufgabe und Kontextfetzen aus des Nutzers Wissensbasis (Personen-CRM, Projekt-Notizen, Daily-Logs, Chat-Spuren). Verdichte das zu einem klaren Status für die Fokus-Karten-Ansicht.

Aufgabe:
{item.get('title','')}

Personen-Kontext:
{people_txt or '—'}

Projekt-Kontext:
{projects_txt or '—'}

Daily-Log-Erwähnungen (älteste zuletzt):
{mentions_txt or '—'}

Chat-Spuren:
{chat_txt or '—'}

Schreibe vier sehr kurze Felder, jeweils ein Satz, in des Nutzers warmer Sprache (deutsch, keine Bindestriche im Fließtext, volle Umlaute):
- "worum": worum geht es im Kern, in einem Satz, ohne den Aufgaben-Titel zu wiederholen
- "stand": was ist der letzte bekannte Stand laut Daily-Logs/Chat
- "haengt": woran hängt es gerade, was ist offen
- "next": ein konkreter, aktiver nächster Schritt

Wenn ein Feld nicht aus dem Kontext belegbar ist, gib einen leeren String "" zurück. Lieber leer als raten.

Antworte NUR mit JSON, nichts davor, nichts danach:
{{"worum":"...","stand":"...","haengt":"...","next":"..."}}"""

    from local_llm import call_local, is_available
    if not is_available():
        return None
    try:
        stdout = await call_local(
            prompt=prompt, feature="fokus_synth",
            system="Du verdichtest Item-Kontext zu vier Stichpunkten als JSON.",
            max_tokens=400, temperature=0.2, timeout=25.0,
        )
    except Exception:
        return None
    if not stdout:
        return None
    try:
        m = re.search(r"\{[\s\S]*\}", stdout)
        if not m:
            return None
        parsed = json.loads(m.group(0))
        out = {
            "worum": (parsed.get("worum") or "").strip()[:280],
            "stand": (parsed.get("stand") or "").strip()[:280],
            "haengt": (parsed.get("haengt") or "").strip()[:280],
            "next": (parsed.get("next") or "").strip()[:280],
        }
        if not any(out.values()):
            return None
        try:
            with get_db() as _db:
                _db.execute(
                    "INSERT OR REPLACE INTO focus_synth_cache(cache_key, ts, data) VALUES (?, ?, ?)",
                    (cache_key, time.time(), json.dumps(out, ensure_ascii=False)),
                )
        except Exception:
            pass
        return out
    except Exception:
        return None


@router.get("/api/fokus/detail")
async def fokus_detail(title: str = "", synthesize: int = 0):
    """Liefert Kontext zu einem Offen-Item: Person-Block (people.db), Projekt-Block, Daily-Logs, Chat-Spuren.
    Mit synthesize=1 zusätzlich eine Claude-Verdichtung in vier Sätzen — nur für die Anzeige, ändert nichts."""
    if not title:
        return JSONResponse({"error": "title required"}, status_code=400)

    items = _focus_list_items(include_done=False, business_only=False)

    needle = title.strip().lower()
    item = None
    for it in items:
        if it["title"].lower().startswith(needle) or needle in it["title"].lower():
            item = it
            break
    if item is None:
        return JSONResponse({"error": "item not found"}, status_code=404)

    brain_dir = Path.home() / "agent" / "brain"
    # ── Personen aus people.db: explizite @Tags + Auto-Match aus Titel ──
    people_blocks: list = []
    seen_people: set = set()
    try:
        with sqlite3.connect(PEOPLE_DB) as pcon:
            pcon.row_factory = sqlite3.Row
            for p in item["people"]:
                pname = (p.get("name") or "").strip()
                if not pname or pname.lower() in seen_people:
                    continue
                row = pcon.execute(
                    "SELECT * FROM people WHERE lower(name)=? LIMIT 1",
                    (pname.lower(),),
                ).fetchone()
                if row:
                    people_blocks.append(_person_db_row_to_block(row))
                    seen_people.add(pname.lower())
            # Auto-Match: alle Personennamen, die als Wort im Titel vorkommen.
            all_rows = pcon.execute(
                "SELECT * FROM people WHERE name != '' ORDER BY length(name) DESC"
            ).fetchall()
            for row in all_rows:
                pname = (row["name"] or "").strip()
                if not pname or len(pname) < 3 or pname.lower() in seen_people:
                    continue
                if re.search(r"\b" + re.escape(pname) + r"\b", item["title"], re.IGNORECASE):
                    people_blocks.append(_person_db_row_to_block(row))
                    seen_people.add(pname.lower())
    except sqlite3.OperationalError:
        pass

    # ── Projekte aus PROJECTS.md: explizit + Auto-Match aus Titel ──
    project_blocks: list = []
    seen_projects: set = set()
    projects_md = brain_dir / "PROJECTS.md"
    if projects_md.exists():
        try:
            prtext = projects_md.read_text(encoding="utf-8")
            for p in item["projects"]:
                anchor = (p.get("anchor") or "").lower()
                if not anchor or anchor in seen_projects:
                    continue
                sec = _fokus_extract_section_by_anchor(prtext, anchor)
                if sec:
                    project_blocks.append({"name": p["name"], "anchor": anchor, "text": sec})
                    seen_projects.add(anchor)
            for ph_match in re.finditer(r"^##\s+(.+)$", prtext, re.MULTILINE):
                pname = ph_match.group(1).strip()
                if not pname or len(pname) < 3:
                    continue
                anchor = re.sub(r"[^a-z0-9]+", "-", pname.lower()).strip("-")
                if anchor in seen_projects:
                    continue
                if re.search(r"\b" + re.escape(pname) + r"\b", item["title"], re.IGNORECASE):
                    sec = _fokus_extract_section_by_anchor(prtext, anchor)
                    if sec:
                        project_blocks.append({"name": pname, "anchor": anchor, "text": sec})
                        seen_projects.add(anchor)
        except Exception:
            pass

    # ── Daily-Log-Spuren ──
    mentions: list = []
    log_dir = brain_dir / "daily-log"
    if log_dir.exists():
        try:
            logs = sorted([p for p in log_dir.glob("*.md") if re.match(r"\d{4}-\d{2}-\d{2}", p.stem)], reverse=True)[:14]
        except Exception:
            logs = []
        terms = []
        title_short = item["title"][:40].lower()
        if title_short:
            terms.append(title_short)
        for blk in people_blocks:
            n = (blk.get("name") or "").lower()
            if n:
                terms.append(n)
        for blk in project_blocks:
            n = (blk.get("name") or "").lower()
            if n:
                terms.append(n)
        for tag in item.get("tags") or []:
            t = (tag or "").lower()
            if t:
                terms.append(f"#{t}")
        for log in logs:
            try:
                text = log.read_text(encoding="utf-8")
            except Exception:
                continue
            text_lower = text.lower()
            for term in terms:
                if term and term in text_lower:
                    idx = text_lower.find(term)
                    start = max(0, idx - 180)
                    end = min(len(text), idx + 320)
                    snippet = text[start:end].strip()
                    mentions.append({"date": log.stem, "snippet": snippet, "term": term})
                    break
            if len(mentions) >= 5:
                break

    # ── Chat-Spuren aus chat_search FTS5 ──
    chat_traces: list = []
    try:
        chat_terms: list = []
        # FTS5-Phrase für Titel (ohne zu kurze Wörter).
        title_words = [w for w in re.findall(r"\w{4,}", item["title"], re.UNICODE) if w.lower() not in {"oder", "auch", "nicht", "noch", "eine", "einen", "einer", "ohne", "über", "unter"}]
        if title_words:
            chat_terms.append(" OR ".join(f'"{w}"' for w in title_words[:6]))
        for blk in people_blocks[:2]:
            n = (blk.get("name") or "").strip()
            if n and len(n) >= 3:
                chat_terms.append(f'"{n}"')
        for blk in project_blocks[:2]:
            n = (blk.get("name") or "").strip()
            if n and len(n) >= 3:
                chat_terms.append(f'"{n}"')
        if chat_terms:
            from db import DB_PATH as CHAT_DB_PATH
            with sqlite3.connect(CHAT_DB_PATH) as ccon:
                ccon.row_factory = sqlite3.Row
                seen_convs: set = set()
                for q in chat_terms:
                    try:
                        rows = ccon.execute(
                            """
                            SELECT m.id, m.author, m.content, m.ts, m.conversation_id, c.title
                            FROM chat_search s
                            JOIN messages m ON m.rowid = s.rowid
                            LEFT JOIN conversations c ON c.id = m.conversation_id
                            WHERE chat_search MATCH ?
                            ORDER BY m.ts DESC
                            LIMIT 8
                            """,
                            (q,),
                        ).fetchall()
                    except sqlite3.OperationalError:
                        rows = []
                    for r in rows:
                        cid = r["conversation_id"] or ""
                        if cid in seen_convs:
                            continue
                        seen_convs.add(cid)
                        snippet = (r["content"] or "").strip()
                        if len(snippet) > 280:
                            snippet = snippet[:280].rstrip() + "…"
                        chat_traces.append({
                            "ts": r["ts"],
                            "author": r["author"],
                            "snippet": snippet,
                            "conversation_id": cid,
                            "conversation_title": r["title"] or "",
                        })
                        if len(chat_traces) >= 5:
                            break
                    if len(chat_traces) >= 5:
                        break
    except Exception:
        pass

    synth = None
    if synthesize:
        try:
            synth = await _fokus_synthesize(item, people_blocks, project_blocks, mentions, chat_traces)
        except Exception:
            synth = None

    return {
        "item": item,
        "people": people_blocks,
        "projects": project_blocks,
        "mentions": mentions,
        "chat_traces": chat_traces,
        "synthesis": synth,
    }


# ── Fokus — Live-Scan: was wurde im Chat erledigt, was kommt neu rein ──

_FOKUS_SCAN_CACHE: dict = {}  # conv_id -> {"last_msg_id": int, "data": dict}


@router.get("/api/fokus/scan")
async def fokus_scan(conv_id: str = "", limit: int = 30, hours: int = 24):
    """Scannt die letzten N Stunden über alle Chats hinweg und schlägt vor,
    welche FOCUS-Items erledigt wurden und welche neu hinzugefügt werden sollten.
    Wenn conv_id gesetzt ist, fokussiert er nur auf diesen Chat (Legacy-Pfad)."""
    items = _focus_list_items(include_done=False, business_only=True)
    open_items = [it for it in items if it.get("bucket") in {"now", "soon", "later"}]
    if not open_items:
        return {"done": [], "add": [], "cached": False}

    cache_key = f"conv:{conv_id}" if conv_id else f"all:{hours}h"

    if conv_id:
        with get_db() as db:
            rows = db.execute(
                "SELECT id, author, content, ts, conversation_id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
                (conv_id, max(5, min(limit, 50))),
            ).fetchall()
    else:
        cutoff = time.time() - max(1, hours) * 3600
        with get_db() as db:
            rows = db.execute(
                "SELECT id, author, content, ts, conversation_id FROM messages WHERE ts >= ? ORDER BY id DESC LIMIT ?",
                (cutoff, max(20, min(limit * 8, 400))),
            ).fetchall()

    if not rows:
        return {"done": [], "add": [], "cached": False}

    last_msg_id = rows[0][0]
    cached = _FOKUS_SCAN_CACHE.get(cache_key)
    if cached and cached.get("last_msg_id") == last_msg_id:
        d = dict(cached["data"])
        d["cached"] = True
        return d

    msgs = list(reversed(rows))  # älteste zuerst für Lesbarkeit
    transcript_lines: list = []
    last_conv = None
    for _id, author, content, _ts, conv in msgs:
        text = (content or "").strip()
        if not text:
            continue
        text = text[:500]
        who = "der Nutzer" if (author or "").lower() in {"du", "user", "christian"} else "Klaus"
        if not conv_id and conv != last_conv:
            transcript_lines.append(f"--- Chat {(conv or '')[:8]} ---")
            last_conv = conv
        transcript_lines.append(f"{who}: {text}")
    transcript = "\n".join(transcript_lines)[:8000]

    items_text = "\n".join(
        f"- [{it.get('bucket','later')}] {it['title']}" for it in open_items
    )[:3000]

    today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    prompt = f"""Heute ist {today}. Du bekommst die letzten Nachrichten eines Chats und eine Liste offener Aufgaben.

WICHTIG — Was zählt als Aufgabe:
NUR Business: Aufträge, Angebote, Nachfass, Gespräche, Termine, Pricing, Akquise, Mails an Kunden, Workshops, Geld.
NICHT: Bau-/Tech-/UI-/Code-/App-Themen (Frontend, Backend, Voice-Bug, Server, Integration). Solche Punkte ignorierst du komplett — sie gehören nicht in diese Liste.

Aufgabenliste (Format `- [bucket] Titel`):
{items_text}

Chat-Verlauf (älteste zuerst):
{transcript}

Aufgabe:
1. Prüfe welche der offenen Aufgaben im Chat als erledigt erscheinen ("hab ich gemacht", "ist raus", "abgeschickt", "fertig", "erledigt"). Sei konservativ — nur wenn klar erledigt, nicht bei "ich werde X tun".
2. Prüfe ob im Chat neue konkrete Business-Aufgaben besprochen werden, die NICHT in der Liste sind. Sei sehr konservativ — nur klare Aufgaben mit Adressat oder Deadline. Tech-/Bau-Punkte schlägst du NIEMALS vor.

Antworte NUR mit JSON (keine Erklärung davor/danach):
{{"done":[{{"title":"exakter Titel aus Liste","reason":"kurze Begründung max 80 Zeichen"}}],"add":[{{"title":"klar formulierte neue Aufgabe","bucket":"now|soon|later","reason":"kurze Begründung max 80 Zeichen"}}]}}

Wenn nichts passt: {{"done":[],"add":[]}}"""

    try:
        from local_llm import call_with_haiku_fallback
        stdout, _model = await call_with_haiku_fallback(
            prompt, feature="fokus_chat_scan",
            system="Du scannst Chat-Verläufe nach erledigten und neuen Business-Aufgaben. Antworte strikt als JSON.",
            max_tokens=600, temperature=0.2, qwen_timeout=15.0, haiku_timeout=20.0,
        )
    except Exception:
        data = {"done": [], "add": [], "auto_done": [], "cached": False}
        _FOKUS_SCAN_CACHE[cache_key] = {"last_msg_id": last_msg_id, "data": data}
        return data

    done_items: list = []
    add_items: list = []
    auto_done: list = []
    if stdout:
        try:
            m = re.search(r"\{[\s\S]*\}", stdout)
            if m:
                parsed = json.loads(m.group(0))
                title_set = {it["title"] for it in open_items}
                for d in (parsed.get("done") or [])[:5]:
                    t = (d.get("title") or "").strip()
                    # finde best matching existierendes Item (case-insensitive prefix/contains)
                    match = None
                    for it_title in title_set:
                        if it_title.lower() == t.lower() or it_title.lower().startswith(t.lower()) or t.lower() in it_title.lower():
                            match = it_title
                            break
                    if match:
                        bucket_match = next((x.get("bucket") for x in open_items if x["title"] == match), "now")
                        done_items.append({
                            "title": match,
                            "bucket": bucket_match,
                            "reason": (d.get("reason") or "")[:120],
                        })
                for a in (parsed.get("add") or [])[:5]:
                    t = (a.get("title") or "").strip()
                    if not t or len(t) < 6:
                        continue
                    # Dedup gegen bestehende
                    if _fokus_find_similar(t, items):
                        continue
                    bucket = (a.get("bucket") or "later").lower()
                    if bucket not in {"now", "soon", "later"}:
                        bucket = "later"
                    add_items.append({
                        "title": t[:200],
                        "bucket": bucket,
                        "reason": (a.get("reason") or "")[:120],
                    })
        except Exception:
            pass

    # Auto-Done: was Klaus als erledigt erkannt hat, wird direkt entfernt.
    # der Nutzer will nicht selbst klicken. Falsch-Positive macht er manuell rückgängig.
    for d in done_items:
        try:
            await fokus_done({"bucket": d["bucket"], "title": d["title"]})
            auto_done.append(d)
        except Exception:
            pass

    data = {"done": [], "add": add_items, "auto_done": auto_done, "cached": False}
    _FOKUS_SCAN_CACHE[cache_key] = {"last_msg_id": last_msg_id, "data": data}
    return data


# ── Projekte: brain/projects/<slug>.md ──

_PROJECT_PHASES = ["lead", "angebot", "bezahlt", "umsetzung", "done", "dauerhaft"]


def _projects_dir() -> Path:
    return Path.home() / "agent/brain/projects"


def _parse_project_md(text: str) -> tuple[dict, str]:
    """Splittet Frontmatter (YAML-ähnlich, Key: Value) und Body."""
    meta: dict = {}
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            head = text[4:end]
            body = text[end + 4 :].lstrip("\n")
            for raw in head.splitlines():
                line = raw.rstrip()
                if not line.strip() or ":" not in line:
                    continue
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
    return meta, body


def _serialize_project_md(meta: dict, body: str) -> str:
    keys = ["name", "title", "phase", "ziel", "naechster_schritt", "wartet_auf", "quelle", "created"]
    lines = ["---"]
    for k in keys:
        if k in meta:
            lines.append(f"{k}: {meta.get(k, '')}")
    extra_keys = [k for k in meta.keys() if k not in keys]
    for k in extra_keys:
        lines.append(f"{k}: {meta.get(k, '')}")
    lines.append("---")
    head = "\n".join(lines)
    if not body.startswith("\n"):
        head += "\n"
    return head + body


@router.get("/api/fokus/projects")
async def projects_get():
    d = _projects_dir()
    items: list[dict] = []
    if d.exists():
        for f in sorted(d.glob("*.md")):
            if f.name.lower() == "readme.md":
                continue
            try:
                txt = f.read_text(encoding="utf-8")
            except Exception:
                continue
            meta, body = _parse_project_md(txt)
            slug = meta.get("name") or f.stem
            try:
                mtime = f.stat().st_mtime
                updated_iso = datetime.fromtimestamp(mtime, ZoneInfo("Europe/Berlin")).isoformat(timespec="seconds")
            except Exception:
                updated_iso = ""
            items.append({
                "slug": slug,
                "title": meta.get("title") or slug,
                "phase": (meta.get("phase") or "lead").lower(),
                "ziel": meta.get("ziel") or "",
                "naechster_schritt": meta.get("naechster_schritt") or "",
                "wartet_auf": meta.get("wartet_auf") or "",
                "quelle": meta.get("quelle") or "",
                "created": meta.get("created") or "",
                "updated": updated_iso,
                "body": body,
                "path": str(f),
            })
    order = {p: i for i, p in enumerate(_PROJECT_PHASES)}
    items.sort(key=lambda x: (order.get(x["phase"], 99), x["title"].lower()))
    return {"items": items, "phases": _PROJECT_PHASES}


@router.patch("/api/fokus/projects/{slug}")
async def projects_patch(slug: str, payload: dict = Body(...)):
    safe_slug = re.sub(r"[^a-z0-9_\-]+", "", slug.lower())
    if not safe_slug:
        return JSONResponse({"error": "invalid slug"}, status_code=400)
    f = _projects_dir() / f"{safe_slug}.md"
    if not f.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        txt = f.read_text(encoding="utf-8")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    meta, body = _parse_project_md(txt)
    allowed = {"title", "phase", "ziel", "naechster_schritt", "wartet_auf", "quelle"}
    for k, v in (payload or {}).items():
        if k in allowed and isinstance(v, str):
            if k == "phase" and v.lower() not in _PROJECT_PHASES:
                return JSONResponse({"error": f"invalid phase: {v}"}, status_code=400)
            meta[k] = v.strip()
    new_text = _serialize_project_md(meta, body)
    try:
        f.write_text(new_text, encoding="utf-8")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"ok": True, "slug": safe_slug, "meta": meta}
