"""Analytics + Leads — example.com Website-Statistik (analytics.db) plus
KV-Anmeldungen aus dem Cloudflare-Worker (`denzer_leads` in chat.db).

Vorher: ~380 Zeilen in `backend/server.py` (6575–6957). Helper, Smoke-Filter,
Mailfix-Cutoff und die 9 Routen wandern hier zentral hin.

Cross-Deps:
- `from db import get_db` (chat.db, fuer denzer_leads)
- `data/analytics.db` (eigene SQLite, parallel zur chat.db)
- Sync-Skripte: `scripts/sync-denzer-leads.py`, `scripts/sync-denzer-analytics.py`
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import get_db


router = APIRouter()


# ── Leads ──────────────────────────────────────────────────────────────

# Mailfix-Deploy am 8.5.2026 ~10:43 UTC. Davor lief der Worker mit leerem
# RESEND_API_KEY, alle Leads tragen mail_sent=False. Diese alten Fails sind
# erledigt und sollen nicht mehr als Warnung angezeigt werden.
_DENZER_MAILFIX_CUTOFF_MS = 1778237000000

_DENZER_TEST_SOURCES = {
    "kv-test", "mail-test", "resend-test",
    "diag-mailfix-after-deploy", "diag-mailfix-12-42",
    "ai-sprint",  # nackte Test-Source vom Worker-Setup
    "lead-magnet-3-agents",  # interner Lead-Magnet-Test
    "watchdog-debug", "watchdog-track-debug",  # Smoketests vom Watchdog
}
_DENZER_TEST_EMAIL_EXACT = {
    "test@example.com",
    "waitlist-check@example.com",
    "test@x.de",
    "test@test.de",
}


def _is_denzer_test_lead(row) -> bool:
    src = (row["source"] or "").strip().lower()
    if src in _DENZER_TEST_SOURCES:
        return True
    email = (row["email"] or "").strip().lower()
    name = (row["name"] or "").strip().lower()
    if email in _DENZER_TEST_EMAIL_EXACT:
        return True
    if "owner-account" in email:
        return True
    if email.endswith("@example.com") or email.endswith("@trest.de") or email.endswith("@test.local"):
        return True
    for marker in ("+test", "+diag", "+nahtlos", "+kvfinal", "+subj-test"):
        if marker in email:
            return True
    # Bot/Spam: ungültige Mail (Leerzeichen drin) oder zufällige Konsonanten-Namen
    if " " in email or "\t" in email:
        return True
    if name and len(name) >= 6 and " " not in name and not any(v in name for v in "aeiouäöü"):
        return True
    return False


def _denzer_lead_row(r):
    try:
        tools = json.loads(r["tools"] or "[]")
    except Exception:
        tools = []
    ts_kv = r["ts_kv"] or 0
    mail_sent = bool(r["mail_sent"])
    mail_fail_visible = (not mail_sent) and ts_kv >= _DENZER_MAILFIX_CUTOFF_MS
    return {
        "key": r["kv_key"],
        "ts_kv": ts_kv,
        "ts_iso": r["ts_iso"],
        "name": r["name"],
        "email": r["email"],
        "phone": r["phone"],
        "company": r["company"],
        "message": r["message"],
        "source": r["source"],
        "level": r["level"],
        "tools": tools,
        "seat_number": r["seat_number"],
        "waitlist": bool(r["waitlist"]),
        "mail_sent": mail_sent,
        "mail_reason": r["mail_reason"],
        "mail_fail_visible": mail_fail_visible,
        "confirmation_sent": bool(r["confirmation_sent"]),
        "seen": bool(r["seen"]),
        "seen_at": r["seen_at"],
        "synced_at": r["synced_at"],
    }


@router.get("/api/denzer/leads")
async def denzer_leads_list(limit: int = 200, only_unseen: int = 0, source: str = "", include_test: int = 0):
    with get_db() as con:
        con.row_factory = sqlite3.Row
        sql = "SELECT * FROM denzer_leads WHERE 1=1"
        params: list = []
        if only_unseen:
            sql += " AND seen = 0"
        if source:
            sql += " AND source = ?"
            params.append(source)
        sql += " ORDER BY ts_kv DESC LIMIT ?"
        params.append(limit)
        rows = con.execute(sql, params).fetchall()
        if not include_test:
            rows = [r for r in rows if not _is_denzer_test_lead(r)]
        all_rows = con.execute("SELECT source, email, name, seen FROM denzer_leads").fetchall()
        real_rows = [r for r in all_rows if not _is_denzer_test_lead(r)]
        unseen = sum(1 for r in real_rows if not r["seen"])
        total = len(real_rows)
    return {
        "leads": [_denzer_lead_row(r) for r in rows],
        "unseen": unseen,
        "total": total,
    }


@router.get("/api/denzer/leads/stats")
async def denzer_leads_stats():
    with get_db() as con:
        con.row_factory = sqlite3.Row
        rows = con.execute("SELECT source, email, name, seen FROM denzer_leads").fetchall()
        real = [r for r in rows if not _is_denzer_test_lead(r)]
        unseen = sum(1 for r in real if not r["seen"])
        total = len(real)
        last = con.execute("SELECT MAX(synced_at) FROM denzer_leads").fetchone()[0]
    return {"unseen": unseen, "total": total, "last_sync": last}


@router.post("/api/denzer/leads/seen")
async def denzer_leads_seen(req: Request):
    body = await req.json()
    keys = body.get("keys") or []
    all_flag = bool(body.get("all"))
    now = time.time()
    with get_db() as con:
        if all_flag:
            con.execute("UPDATE denzer_leads SET seen = 1, seen_at = ? WHERE seen = 0", (now,))
        else:
            for k in keys:
                con.execute("UPDATE denzer_leads SET seen = 1, seen_at = ? WHERE kv_key = ?", (now, k))
    return {"ok": True}


@router.post("/api/denzer/leads/sync")
async def denzer_leads_sync():
    """Manueller Sync-Trigger. Ruft das Sync-Skript synchron auf."""
    script = Path(__file__).parent.parent.parent / "scripts" / "sync-denzer-leads.py"
    try:
        result = await asyncio.to_thread(
            subprocess.run, ["python3", str(script)],
            capture_output=True, text=True, timeout=60
        )
        return {
            "ok": result.returncode == 0,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Analytics ──────────────────────────────────────────────────────────

DENZER_ANALYTICS_DB = Path(__file__).parent.parent.parent / "data" / "analytics.db"


def _denzer_analytics_con():
    con = sqlite3.connect(str(DENZER_ANALYTICS_DB))
    con.row_factory = sqlite3.Row
    return con


def _denzer_analytics_window(days: int) -> int:
    days = max(1, min(180, days))
    return int((time.time() - days * 86400) * 1000)


# des Nutzers eigene Geraete werden ausgeblendet (visitor_id-Praefix), damit er
# nicht seine eigenen Besuche zaehlt. Neue visitor_id pro Geraet/geleertem
# localStorage; bei Bedarf eine weitere NOT-LIKE-Zeile unten ergaenzen.
# Filtert Smoke-Tests und des Nutzers eigene Geraete aus allen Auswertungen.
_DENZER_SMOKE_SQL = (
    " AND visitor_id != 'test-vid'"
    " AND visitor_id NOT LIKE '00000000-000%'"  # Betreiber-Desktop ausfiltern
    " AND COALESCE(ua,'') NOT LIKE 'curl/%'"
    " AND COALESCE(ua,'') NOT LIKE 'python%'"
    " AND COALESCE(ua,'') NOT LIKE 'Wget%'"
    " AND path NOT LIKE '/test%'"
    " AND path NOT LIKE '/smoke%'"
)


@router.get("/api/denzer/analytics/overview")
async def denzer_analytics_overview(days: int = 7):
    if not DENZER_ANALYTICS_DB.exists():
        return {"days": days, "pageviews": 0, "visitors": 0, "sessions": 0, "by_day": [], "top_paths": [], "top_referrers": [], "by_country": []}
    since_ms = _denzer_analytics_window(days)
    smoke = _DENZER_SMOKE_SQL
    with _denzer_analytics_con() as con:
        pv = con.execute(f"SELECT COUNT(*) FROM events WHERE type='pageview' AND server_ts>=?{smoke}", (since_ms,)).fetchone()[0]
        vis = con.execute(f"SELECT COUNT(DISTINCT visitor_id) FROM events WHERE server_ts>=?{smoke}", (since_ms,)).fetchone()[0]
        ses = con.execute(f"SELECT COUNT(DISTINCT session_id) FROM events WHERE server_ts>=?{smoke}", (since_ms,)).fetchone()[0]
        by_day = [dict(r) for r in con.execute(
            f"""
            SELECT strftime('%Y-%m-%d', server_ts/1000, 'unixepoch') AS day,
                   COUNT(*) FILTER (WHERE type='pageview') AS pageviews,
                   COUNT(DISTINCT visitor_id) AS visitors
            FROM events WHERE server_ts>=?{smoke}
            GROUP BY day ORDER BY day
            """, (since_ms,)
        ).fetchall()]
        top_paths = [dict(r) for r in con.execute(
            f"""
            SELECT path, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
            FROM events WHERE type='pageview' AND server_ts>=?{smoke}
            GROUP BY path ORDER BY pageviews DESC LIMIT 20
            """, (since_ms,)
        ).fetchall()]
        submits_by_path = {
            r["path"]: r["submits"] for r in con.execute(
                f"""
                SELECT path, COUNT(DISTINCT visitor_id) AS submits
                FROM events WHERE type='form_submit' AND server_ts>=?{smoke}
                GROUP BY path
                """, (since_ms,)
            ).fetchall()
        }
        for row in top_paths:
            row["submits"] = submits_by_path.get(row["path"], 0)
        top_referrers = [dict(r) for r in con.execute(
            f"""
            SELECT COALESCE(referrer,'(direct)') AS referrer, COUNT(*) AS hits
            FROM events WHERE type='pageview' AND server_ts>=?{smoke}
            GROUP BY referrer ORDER BY hits DESC LIMIT 15
            """, (since_ms,)
        ).fetchall()]
        by_country = [dict(r) for r in con.execute(
            f"""
            SELECT COALESCE(country,'??') AS country, COUNT(DISTINCT visitor_id) AS visitors
            FROM events WHERE server_ts>=?{smoke}
            GROUP BY country ORDER BY visitors DESC LIMIT 20
            """, (since_ms,)
        ).fetchall()]
    return {
        "days": days,
        "pageviews": pv,
        "visitors": vis,
        "sessions": ses,
        "by_day": by_day,
        "top_paths": top_paths,
        "top_referrers": top_referrers,
        "by_country": by_country,
    }


@router.get("/api/denzer/analytics/page")
async def denzer_analytics_page(path: str, days: int = 30):
    if not DENZER_ANALYTICS_DB.exists():
        return {"path": path, "pageviews": 0, "visitors": 0, "avg_duration_ms": 0, "scroll_distribution": {}, "clicks": [], "outbound": [], "form_submits": 0}
    since_ms = _denzer_analytics_window(days)
    smoke = _DENZER_SMOKE_SQL
    with _denzer_analytics_con() as con:
        pv = con.execute(f"SELECT COUNT(*) FROM events WHERE type='pageview' AND path=? AND server_ts>=?{smoke}", (path, since_ms)).fetchone()[0]
        vis = con.execute(f"SELECT COUNT(DISTINCT visitor_id) FROM events WHERE path=? AND server_ts>=?{smoke}", (path, since_ms)).fetchone()[0]
        durations = con.execute(
            f"""
            SELECT json_extract(props_json,'$.duration_ms') AS d,
                   json_extract(props_json,'$.max_scroll') AS s
            FROM events WHERE type='page_end' AND path=? AND server_ts>=?{smoke}
            """, (path, since_ms)
        ).fetchall()
        durs = [int(r['d']) for r in durations if r['d'] is not None]
        avg_dur = sum(durs) // len(durs) if durs else 0
        scrolls = [int(r['s']) for r in durations if r['s'] is not None]
        buckets = {"0-25": 0, "25-50": 0, "50-75": 0, "75-100": 0, "100": 0}
        for s in scrolls:
            if s >= 100: buckets["100"] += 1
            elif s >= 75: buckets["75-100"] += 1
            elif s >= 50: buckets["50-75"] += 1
            elif s >= 25: buckets["25-50"] += 1
            else: buckets["0-25"] += 1
        clicks = [dict(r) for r in con.execute(
            f"""
            SELECT COALESCE(json_extract(props_json,'$.label'), json_extract(props_json,'$.text'), '(unbenannt)') AS label,
                   COUNT(*) AS hits
            FROM events WHERE type='click' AND path=? AND server_ts>=?{smoke}
            GROUP BY label ORDER BY hits DESC LIMIT 30
            """, (path, since_ms)
        ).fetchall()]
        outbound = [dict(r) for r in con.execute(
            f"""
            SELECT json_extract(props_json,'$.href') AS href, COUNT(*) AS hits
            FROM events WHERE type='outbound' AND path=? AND server_ts>=?{smoke}
            GROUP BY href ORDER BY hits DESC LIMIT 20
            """, (path, since_ms)
        ).fetchall()]
        form_submits = con.execute(f"SELECT COUNT(DISTINCT visitor_id) FROM events WHERE type='form_submit' AND path=? AND server_ts>=?{smoke}", (path, since_ms)).fetchone()[0]
    return {
        "path": path,
        "days": days,
        "pageviews": pv,
        "visitors": vis,
        "avg_duration_ms": avg_dur,
        "scroll_distribution": buckets,
        "clicks": clicks,
        "outbound": outbound,
        "form_submits": form_submits,
    }


@router.post("/api/denzer/analytics/sync")
async def denzer_analytics_sync():
    script = Path(__file__).parent.parent.parent / "scripts" / "sync-denzer-analytics.py"
    try:
        result = await asyncio.to_thread(
            subprocess.run, ["python3", str(script)],
            capture_output=True, text=True, timeout=60
        )
        return {
            "ok": result.returncode == 0,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/denzer/analytics/recent")
async def denzer_analytics_recent(limit: int = 20):
    """Letzte Sessions chronologisch — pro Session: Start, Dauer, Pfade, Klicks, Land."""
    if not DENZER_ANALYTICS_DB.exists():
        return {"sessions": []}
    limit = max(5, min(50, int(limit)))
    with _denzer_analytics_con() as con:
        rows = con.execute(
            f"""
            SELECT
              session_id,
              MIN(server_ts) AS start_ts,
              MAX(server_ts) AS end_ts,
              COUNT(*) FILTER (WHERE type='pageview') AS pageviews,
              COUNT(*) FILTER (WHERE type='click' OR type='link' OR type='outbound') AS clicks,
              COUNT(*) FILTER (WHERE type='form_submit') AS submits,
              GROUP_CONCAT(DISTINCT path) AS paths,
              MAX(country) AS country,
              MAX(city) AS city,
              MAX(ua) AS ua,
              MAX(referrer) AS referrer
            FROM events
            WHERE 1=1{_DENZER_SMOKE_SQL}
            GROUP BY session_id
            ORDER BY start_ts DESC
            LIMIT ?
            """, (limit,)
        ).fetchall()
        sessions = []
        for r in rows:
            paths_raw = (r['paths'] or '').split(',')
            seen = []
            for p in paths_raw:
                p = p.strip()
                if p and p not in seen:
                    seen.append(p)
            ua = r['ua'] or ''
            device = 'mobile' if 'Mobi' in ua or 'iPhone' in ua or 'Android' in ua else 'desktop'
            sessions.append({
                "session_id": r['session_id'],
                "start_ts": r['start_ts'],
                "duration_ms": (r['end_ts'] or 0) - (r['start_ts'] or 0),
                "pageviews": r['pageviews'] or 0,
                "clicks": r['clicks'] or 0,
                "submits": r['submits'] or 0,
                "paths": seen[:5],
                "country": r['country'],
                "city": r['city'],
                "device": device,
                "referrer": r['referrer'],
            })
    return {"sessions": sessions}


@router.get("/api/denzer/analytics/compare")
async def denzer_analytics_compare():
    """Heute vs. Gestern — Pageviews, Besucher, Sessions."""
    if not DENZER_ANALYTICS_DB.exists():
        return {"today": {"pageviews": 0, "visitors": 0, "sessions": 0}, "yesterday": {"pageviews": 0, "visitors": 0, "sessions": 0}}
    import datetime as _dt
    now = _dt.datetime.now()
    today_start = int(_dt.datetime(now.year, now.month, now.day).timestamp() * 1000)
    yesterday_start = today_start - 86_400_000
    with _denzer_analytics_con() as con:
        def stats(start: int, end: int) -> dict:
            r = con.execute(
                f"""
                SELECT
                  COUNT(*) FILTER (WHERE type='pageview') AS pv,
                  COUNT(DISTINCT visitor_id) AS vis,
                  COUNT(DISTINCT session_id) AS ses
                FROM events WHERE server_ts>=? AND server_ts<?{_DENZER_SMOKE_SQL}
                """, (start, end)
            ).fetchone()
            return {"pageviews": r['pv'] or 0, "visitors": r['vis'] or 0, "sessions": r['ses'] or 0}
        return {
            "today": stats(today_start, today_start + 86_400_000),
            "yesterday": stats(yesterday_start, today_start),
        }
