"""Systemagent loop.

Schliesst den Kreis aus Logbuch, Werkstatt und Klaus-Channel:
auffaellige Workflow-Runs werden einmal ins Systemagent-Log geschrieben und
Christian nur dann gepingt, wenn wirklich etwas passiert ist.
"""
from __future__ import annotations

import hashlib
import json
import plistlib
import shutil
import sqlite3
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

from db import get_db
from workflows import add_step, finish_run, review_background_run, start_run

ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "data" / "systemagent" / "state.json"
DATA_DIR = ROOT / "jobs" / "systemagent" / "data"
JOBS_DIR = ROOT / "jobs"
LAUNCHD_DIR = Path.home() / "Library" / "LaunchAgents"
LAUNCHD_ARCHIVE_DIR = ROOT / "brain" / "archive" / "launchd"
SOURCE = "systemagent"
INBOX_SOURCE = "inbox-waiting"
INBOX_PING_COOLDOWN_SEC = 2 * 3600
INBOX_REPEAT_AFTER_SEC = 3 * 3600


def _loads(text: str | None, fallback: Any = None) -> Any:
    try:
        data = json.loads(text or "")
        return data
    except Exception:
        return {} if fallback is None else fallback


def _load_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _short(text: str, limit: int = 160) -> str:
    clean = " ".join(str(text or "").replace("\n", " ").split())
    lowered = clean.lower()
    for marker in ("api_key", "token", "password", "authorization", "secret"):
        pos = lowered.find(marker)
        if pos >= 0:
            clean = clean[:pos] + f"{marker}=[redacted]"
            break
    return clean if len(clean) <= limit else clean[: limit - 1].rstrip() + "…"


def _workflow_label(key: str) -> str:
    labels = {
        "agent.turn": "Agentenlauf",
        "context.router": "Context Router",
        "job.run": "Job",
        "pulse.run": "Pulse",
        "worker.tick": "Worker",
        "hook.tick": "Hook",
        "whatsapp.send": "WhatsApp",
    }
    return labels.get(key, key or "Workflow")


def _known_job_slugs() -> set[str]:
    if not JOBS_DIR.is_dir():
        return set()
    out: set[str] = set()
    for job_dir in JOBS_DIR.iterdir():
        if not job_dir.is_dir() or job_dir.name.startswith(("_", ".")):
            continue
        if (job_dir / "prompt.md").exists() or (job_dir / "PROMPT.md").exists():
            out.add(job_dir.name)
    return out


def _expired_one_shot(data: dict[str, Any], *, today: date) -> bool:
    interval = data.get("StartCalendarInterval")
    if not isinstance(interval, dict):
        return False
    try:
        year = int(interval.get("Year") or today.year)
        month = int(interval.get("Month"))
        day = int(interval.get("Day"))
    except Exception:
        return False
    try:
        return date(year, month, day) < today
    except Exception:
        return False


def _auto_resolve_job_drift(*, dry_run: bool = False) -> dict[str, Any]:
    """Archive expired loose one-shot launchd jobs/agents and report remaining drift."""
    known = _known_job_slugs()
    today = datetime.now().date()
    archived: list[dict[str, str]] = []
    remaining: list[dict[str, str]] = []
    if not LAUNCHD_DIR.is_dir():
        return {"archived": [], "remaining": [], "remainingCount": 0}

    candidates = (
        list(LAUNCHD_DIR.glob("com.klaus.job.*.plist"))
        + list(LAUNCHD_DIR.glob("com.klaus.agent.oneshot-*.plist"))
        + list(LAUNCHD_DIR.glob("com.klaus.publish-*.plist"))
    )
    for plist_path in sorted(candidates):
        label = plist_path.stem
        is_job = label.startswith("com.klaus.job.")
        slug = label.removeprefix("com.klaus.job.") if is_job else label.removeprefix("com.klaus.agent.")
        if is_job and slug in known:
            continue
        try:
            data = plistlib.loads(plist_path.read_bytes())
            label = str(data.get("Label") or label)
        except Exception:
            data = {}
        item = {"label": label, "slug": slug, "path": str(plist_path)}
        if _expired_one_shot(data, today=today):
            archive_dir = LAUNCHD_ARCHIVE_DIR / today.isoformat()
            target = archive_dir / plist_path.name
            if not dry_run:
                archive_dir.mkdir(parents=True, exist_ok=True)
                try:
                    import subprocess
                    subprocess.run(
                        ["launchctl", "bootout", f"gui/{__import__('os').getuid()}/{label}"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=5,
                    )
                except Exception:
                    pass
                if plist_path.exists():
                    shutil.move(str(plist_path), str(target))
            archived.append({**item, "archivePath": str(target)})
        else:
            remaining.append(item)

    if archived or remaining:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        report = DATA_DIR / "job-drift-latest.md"
        lines = [
            f"## Job-Drift {datetime.now().isoformat(timespec='seconds')}",
            "",
            f"Archiviert: {len(archived)}",
            f"Offen: {len(remaining)}",
        ]
        if archived:
            lines.extend(["", "### Automatisch archiviert"])
            for item in archived:
                lines.append(f"- `{item['label']}` -> `{item['archivePath']}`")
        if remaining:
            lines.extend(["", "### Braucht Werkstatt"])
            for item in remaining:
                lines.append(f"- `{item['label']}` -> `{item['path']}`")
        if not dry_run:
            report.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    return {
        "archived": archived,
        "remaining": remaining,
        "archivedCount": len(archived),
        "remainingCount": len(remaining),
    }


def _fetch_recent_runs(limit: int = 240) -> list[sqlite3.Row]:
    with get_db() as db:
        db.row_factory = sqlite3.Row
        return db.execute(
            """SELECT *
               FROM workflow_runs
               WHERE status != 'running'
               ORDER BY created_at DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()


def _green_pulses() -> set[str]:
    """Pulse-Namen, die aktuell NICHT rot sind (fail_streak < 3).

    Ein einzelner Pulse-Fehlrun (IMAP-/KV-Netzwackler) heilt sich beim
    naechsten Lauf selbst. Solche transienten Aussetzer sollen Christian
    nicht als Blocker pingen, exakt wie die UI-Ampel erst ab drei Fehllaeufen
    in Folge auf Rot kippt.
    """
    out: set[str] = set()
    try:
        with get_db() as db:
            db.row_factory = sqlite3.Row
            for r in db.execute("SELECT name, fail_streak FROM pulses").fetchall():
                if int(r["fail_streak"] or 0) < 3:
                    out.add(str(r["name"]))
    except Exception:
        pass
    return out


def _event_from_row(row: sqlite3.Row, *, green_pulses: set[str] | None = None) -> dict[str, Any] | None:
    review = _loads(row["review_json"], {})
    learning = review.get("learning") if isinstance(review.get("learning"), dict) else {}
    klass = str(learning.get("class") or "")
    status = str(row["status"] or "")
    review_status = str(row["review_status"] or "")
    key = str(row["workflow_key"] or "")

    # Eigene Läufe nie als Ereignis behandeln, sonst pingt der Agent sich selbst.
    if key == "agent.systemagent":
        return None

    # Transiente Pulse-Aussetzer nicht als Ereignis melden. Erst wenn ein Pulse
    # wirklich rot ist (fail_streak >= 3, siehe pulses-Ampel), wird er zum Blocker.
    if key == "pulse.run" and green_pulses is not None:
        if str(row["subject_ref"] or "") in green_pulses:
            return None

    if status != "error" and review_status not in {"error", "warning"} and klass not in {"blocker", "detour"}:
        return None
    # Normale Agent-Umwege sind Logbuch-Material. Christian bekommt dazu erst
    # einen Ping, wenn sie blockieren oder als wiederholtes Learning kuratiert werden.
    if key == "agent.turn" and klass == "detour" and review_status == "warning":
        return None

    severity = "blocker" if status == "error" or review_status == "error" or klass == "blocker" else "notice"
    title = str(row["title"] or row["subject_ref"] or key or "Workflow")
    message = str(row["review_message"] or "")
    note = str(review.get("suggested_refinement") or learning.get("highway_note") or message or "")
    return {
        "id": str(row["id"]),
        "workflowKey": key,
        "kind": _workflow_label(key),
        "title": _short(title, 120),
        "severity": severity,
        "createdAt": float(row["created_at"] or 0),
        "reviewStatus": review_status,
        "learningClass": klass,
        "message": _short(message, 220),
        "note": _short(note, 260),
    }


def _event_label(event: dict[str, Any]) -> str:
    if event["severity"] == "blocker":
        return "Blocker"
    if event.get("learningClass") == "detour":
        return "Umweg"
    return "Warnung"


def _write_log(events: list[dict[str, Any]], *, baseline: bool, posted: bool, post_reason: str) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d")
    path = DATA_DIR / f"{stamp}-systemagent.md"
    now = datetime.now().isoformat(timespec="seconds")
    if baseline:
        body = [
            f"## Systemagent {now}",
            "",
            "Baseline gesetzt. Bestehende alte Auffälligkeiten wurden nicht nachträglich gepingt.",
        ]
    elif not events:
        body = [
            f"## Systemagent {now}",
            "",
            "Keine neuen Ereignisse. Logbuch, Werkstatt und Entscheidungen bleiben ruhig.",
        ]
    else:
        body = [
            f"## Systemagent {now}",
            "",
            f"Neue Ereignisse: {len(events)}.",
            f"Klaus-Channel: {'gepingt' if posted else 'nicht gepingt'} ({post_reason}).",
            "",
            "### Ereignisse",
        ]
        for event in events:
            body.extend([
                f"- **{_event_label(event)}:** {event['kind']} · {event['title']}",
                f"  - Was: {event['message'] or event['note'] or 'Auffälligkeit im Lauf erkannt.'}",
                f"  - Folge: {event['note'] or 'Im Logbuch gespeichert und weiter beobachtet.'}",
                f"  - Run: `{event['id']}`",
            ])
    text = "\n".join(body).rstrip() + "\n"
    if path.exists():
        path.write_text(path.read_text(encoding="utf-8").rstrip() + "\n\n" + text, encoding="utf-8")
    else:
        path.write_text(text, encoding="utf-8")
    latest = DATA_DIR / "latest.md"
    latest.write_text(text, encoding="utf-8")
    return path


def _format_ping(events: list[dict[str, Any]], log_path: Path) -> str:
    shown = events[:4]
    lines = []
    for event in shown:
        lines.append(f"- {_event_label(event)}: {event['kind']} · {event['title']}")
    if len(events) > len(shown):
        lines.append(f"- plus {len(events) - len(shown)} weitere")
    rel = str(log_path.relative_to(ROOT)) if ROOT in log_path.resolve().parents else str(log_path)
    return (
        "**Systemagent-Hinweis**\n\n"
        "**Was:**\n"
        + "\n".join(lines)
        + "\n\n"
        "**Warum:** Ich melde nur, wenn ein Lauf auffällig war oder etwas nicht rund lief.\n\n"
        f"**Gemacht:** Im Logbuch gespeichert: `{rel}`.\n\n"
        "**Handlung:** Du musst nichts tun. Keine Entscheidung nötig; ich habe es gespeichert, beobachte weiter und melde mich erst wieder bei einem neuen Ereignis."
    )


def _mail_attention_account() -> tuple[str, Any | None]:
    try:
        from modules.mail import core as mail_core
        accounts = mail_core.load_accounts()
    except Exception:
        return "", None
    visible = [a for a in accounts if not a.get("hidden")]
    if not visible:
        return "", mail_core
    return ("all" if len(visible) > 1 else visible[0]["key"]), mail_core


def _mail_waiting_items(limit: int = 80) -> list[dict[str, Any]]:
    account, mail_core = _mail_attention_account()
    if not account or mail_core is None:
        return []
    try:
        data = mail_core.fetch_contact_inbox_state(account, limit)
    except Exception:
        return []

    out: list[dict[str, Any]] = []
    for item in list(data.get("items") or []):
        if item.get("replied"):
            continue
        ctx = item.get("inbox_context") if isinstance(item.get("inbox_context"), dict) else {}
        projects = ctx.get("projects") if isinstance(ctx.get("projects"), list) else []
        project = ""
        if projects:
            first = projects[0] if isinstance(projects[0], dict) else {}
            project = str(first.get("name") or first.get("slug") or "")
        detail = str(item.get("subject") or item.get("snippet") or "E-Mail")
        key = f"mail:{item.get('account') or account}:{item.get('uid') or item.get('message_id') or detail}"
        out.append({
            "source": "mail",
            "key": key,
            "name": _short(str(ctx.get("person_name") or item.get("from") or "Mail"), 54),
            "detail": _short(detail, 110),
            "project": _short(project, 54),
            "ts": int(item.get("ts") or 0),
            "unread": bool(item.get("unread")),
        })
    return out


def _whatsapp_waiting_items(limit: int = 200) -> list[dict[str, Any]]:
    try:
        from modules.whatsapp.core import _wa_chat_display_name, _wa_db, _wa_ensure_agent_meta, _wa_has_col
    except Exception:
        return []

    now_ts = int(time.time())
    try:
        with _wa_db() as con:
            _wa_ensure_agent_meta(con)
            has_archived = _wa_has_col(con, "chats", "is_archived")
            dismissed_map = {
                r["chat_id"]: int(r["triage_dismissed_ts"] or 0)
                for r in con.execute("SELECT chat_id, triage_dismissed_ts FROM agent_chat_meta").fetchall()
            }
            where = "WHERE c.last_message_ts IS NOT NULL AND c.id NOT LIKE '%@broadcast%' AND c.id NOT LIKE '%@newsletter%'"
            if has_archived:
                where += " AND COALESCE(c.is_archived,0)=0"
            rows = con.execute(f"""
                SELECT c.id, c.name, c.is_group, c.last_message_ts, c.unread_count,
                       (SELECT body FROM messages m
                          WHERE m.chat_id=c.id ORDER BY m.ts DESC LIMIT 1) AS last_body,
                       (SELECT transcript FROM messages m
                          WHERE m.chat_id=c.id ORDER BY m.ts DESC LIMIT 1) AS last_transcript,
                       (SELECT type FROM messages m
                          WHERE m.chat_id=c.id ORDER BY m.ts DESC LIMIT 1) AS last_type,
                       (SELECT from_me FROM messages m
                          WHERE m.chat_id=c.id ORDER BY m.ts DESC LIMIT 1) AS last_from_me
                  FROM chats c
                  {where}
                  ORDER BY c.unread_count > 0 DESC, last_from_me ASC, c.last_message_ts DESC
                  LIMIT ?
            """, (limit,)).fetchall()
    except Exception:
        return []

    out: list[dict[str, Any]] = []
    for row in rows:
        if bool(row["is_group"]):
            continue
        last_ts = int(row["last_message_ts"] or 0)
        if not last_ts:
            continue
        unread = int(row["unread_count"] or 0)
        last_from_me = bool(row["last_from_me"])
        age_h = (now_ts - last_ts) / 3600
        waiting = (unread > 0 and not last_from_me) or (not last_from_me and age_h <= 24)
        dismissed_ts = dismissed_map.get(row["id"]) or 0
        if not waiting or (dismissed_ts and dismissed_ts >= last_ts):
            continue
        preview = (row["last_transcript"] or row["last_body"] or "").strip().replace("\n", " ")
        if not preview and row["last_type"]:
            preview = f"[{row['last_type']}]"
        out.append({
            "source": "wa",
            "key": f"wa:{row['id']}",
            "name": _short(_wa_chat_display_name(row), 54),
            "detail": _short(preview or "WhatsApp", 110),
            "project": "",
            "ts": last_ts,
            "unread": unread > 0,
        })
    return out


def _collect_inbox_waiting() -> dict[str, Any]:
    items = _mail_waiting_items() + _whatsapp_waiting_items()
    items.sort(key=lambda x: (0 if x.get("unread") else 1, int(x.get("ts") or 0)))
    signature_src = "|".join(f"{i.get('source')}:{i.get('key')}:{i.get('ts')}" for i in items[:12])
    signature = hashlib.sha1(f"{len(items)}:{signature_src}".encode("utf-8")).hexdigest()[:14] if items else ""
    return {
        "items": items,
        "count": len(items),
        "mailCount": sum(1 for i in items if i.get("source") == "mail"),
        "waCount": sum(1 for i in items if i.get("source") == "wa"),
        "signature": signature,
    }


def _format_inbox_ping(inbox: dict[str, Any]) -> str:
    items = list(inbox.get("items") or [])
    count = int(inbox.get("count") or 0)
    mail_count = int(inbox.get("mailCount") or 0)
    wa_count = int(inbox.get("waCount") or 0)
    shown = items[:4]
    lines = []
    for item in shown:
        channel = "WhatsApp" if item.get("source") == "wa" else "Mail"
        project = f" · {item['project']}" if item.get("project") else ""
        detail = f" · {item['detail']}" if item.get("detail") else ""
        lines.append(f"- {item['name']} ({channel}){project}{detail}")
    if count > len(shown):
        lines.append(f"- plus {count - len(shown)} weitere")
    parts = []
    if wa_count:
        parts.append(f"{wa_count} WhatsApp")
    if mail_count:
        parts.append(f"{mail_count} Mail")
    kind = ", ".join(parts) if parts else "Nachrichten"
    plural = "en" if count != 1 else ""
    return (
        "**Inbox-Hinweis**\n\n"
        f"**Was:** {count} Nachricht{plural} warten ({kind}).\n\n"
        "**Wer:**\n"
        + "\n".join(lines)
        + "\n\n"
        "**Handlung:** Du kannst hier direkt sagen: „Inbox abarbeiten“. Dann hole ich Kontext und wir gehen sie nacheinander durch."
    )


def _maybe_post_inbox_ping(state: dict[str, Any], *, dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    inbox = _collect_inbox_waiting()
    count = int(inbox.get("count") or 0)
    last = state.get("lastInboxPing") if isinstance(state.get("lastInboxPing"), dict) else {}
    result: dict[str, Any] = {
        "posted": False,
        "reason": "no-waiting" if count <= 0 else "dry-run" if dry_run else "not-due",
        "count": count,
        "mailCount": inbox.get("mailCount") or 0,
        "waCount": inbox.get("waCount") or 0,
        "signature": inbox.get("signature") or "",
    }
    if count <= 0:
        state["lastInboxPing"] = {**last, **result, "lastSeenAt": time.time()}
        return result

    now = time.time()
    signature = str(inbox.get("signature") or "")
    last_signature = str(last.get("signature") or "")
    last_posted_at = float(last.get("postedAt") or 0)
    due = force or signature != last_signature or now - last_posted_at >= INBOX_REPEAT_AFTER_SEC
    if not due:
        return result
    if dry_run:
        return {**result, "reason": "dry-run-due"}

    from modules.klaus_channel.core import post
    post_result = post(
        text=_format_inbox_ping(inbox),
        source=INBOX_SOURCE,
        dedupe_key=f"inbox:{signature}",
        force=force,
        cooldown_sec=INBOX_PING_COOLDOWN_SEC,
    )
    posted = bool(post_result.get("posted"))
    result = {
        **result,
        "posted": posted,
        "reason": "posted" if posted else str(post_result.get("reason") or "not-posted"),
        "post": post_result,
    }
    state["lastInboxPing"] = {
        **result,
        "postedAt": now if posted else last_posted_at,
        "attemptedAt": now,
    }
    return result


def _step(run_id: str | None, key: str, label: str, status: str = "ok", summary: str = "", data: dict | None = None) -> None:
    if not run_id:
        return
    try:
        add_step(run_id, key, label, status, summary, data or {})
    except Exception:
        pass


def _run_core(*, dry_run: bool = False, force: bool = False, run_id: str | None = None) -> dict[str, Any]:
    now = time.time()
    state = _load_state()
    job_drift = _auto_resolve_job_drift(dry_run=dry_run)
    _step(
        run_id, "job_drift", "Job-Drift geprüft",
        "warning" if job_drift.get("remainingCount") else "ok",
        f"archiviert {job_drift.get('archivedCount', 0)}, offen {job_drift.get('remainingCount', 0)}",
        job_drift,
    )
    inbox_result = _maybe_post_inbox_ping(state, dry_run=dry_run, force=force)
    _step(
        run_id, "inbox", "Inbox geprüft", "ok",
        f"{inbox_result.get('count', 0)} wartend, {inbox_result.get('reason', '')}",
        inbox_result,
    )
    first_scan = not bool(state.get("createdAt"))
    if first_scan:
        state["createdAt"] = now
    logged_ids = set(str(x) for x in state.get("loggedRunIds") or [])
    notified_ids = set(str(x) for x in state.get("notifiedRunIds") or [])

    _green = _green_pulses()
    all_events = [event for row in _fetch_recent_runs() if (event := _event_from_row(row, green_pulses=_green))]
    _step(
        run_id, "scan", "Läufe gesichtet", "ok",
        f"{len(all_events)} auffällige Läufe gefunden",
        {"openCount": len(all_events)},
    )
    if first_scan and not force:
        for event in all_events:
            logged_ids.add(event["id"])
            notified_ids.add(event["id"])
        log_path = DATA_DIR / f"{datetime.now().strftime('%Y-%m-%d')}-systemagent.md"
        _step(run_id, "baseline", "Baseline gesetzt", "ok", f"{len(all_events)} Altlasten als bekannt markiert")
        if not dry_run:
            log_path = _write_log([], baseline=True, posted=False, post_reason="baseline")
        state.update({
            "lastRunAt": now,
            "lastLogPath": str(log_path),
            "loggedRunIds": sorted(logged_ids)[-500:],
            "notifiedRunIds": sorted(notified_ids)[-500:],
            "lastOpenCount": len(all_events),
            "lastJobDrift": job_drift,
            "lastInboxPing": state.get("lastInboxPing") or inbox_result,
        })
        if not dry_run:
            _save_state(state)
        return {
            "ok": True,
            "posted": False,
            "reason": "baseline-created",
            "eventCount": 0,
            "openHistoricalCount": len(all_events),
            "logPath": str(log_path),
            "jobDrift": job_drift,
            "inbox": inbox_result,
        }

    new_events = [event for event in all_events if event["id"] not in logged_ids]
    ping_events = [event for event in all_events if event["id"] not in notified_ids]
    if force and not ping_events:
        ping_events = all_events[:1]
    for event in new_events:
        logged_ids.add(event["id"])

    posted = False
    post_reason = "no-events" if not ping_events else "dry-run"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_path = DATA_DIR / f"{datetime.now().strftime('%Y-%m-%d')}-systemagent.md"
    post_result: dict[str, Any] = {"posted": False, "reason": post_reason}
    if ping_events and not dry_run:
        from modules.klaus_channel.core import post
        ids_src = ",".join(event["id"] for event in ping_events[:10])
        dedupe = "systemagent:" + hashlib.sha1(ids_src.encode("utf-8")).hexdigest()[:14]
        post_result = post(
            text=_format_ping(ping_events, log_path),
            source=SOURCE,
            dedupe_key=dedupe,
            force=force,
            cooldown_sec=45 * 60,
        )
        posted = bool(post_result.get("posted"))
        post_reason = "posted" if posted else str(post_result.get("reason") or "not-posted")
        if posted:
            for event in ping_events:
                notified_ids.add(event["id"])
    _step(
        run_id, "ping", "Klaus-Channel", "ok" if not ping_events else ("ok" if posted else "warning"),
        f"{len(ping_events)} Ereignisse, {post_reason}",
        {"pingCount": len(ping_events), "posted": posted, "reason": post_reason},
    )
    log_events = new_events or (ping_events if force else [])
    if log_events and not dry_run:
        log_path = _write_log(log_events, baseline=False, posted=posted, post_reason=post_reason)

    state.update({
        "lastRunAt": now,
        "lastLogPath": str(log_path),
        "loggedRunIds": sorted(logged_ids)[-500:],
        "notifiedRunIds": sorted(notified_ids)[-500:],
        "lastEventCount": len(new_events),
        "lastPingCount": len(ping_events),
        "lastPostResult": post_result,
        "lastJobDrift": job_drift,
        "lastInboxPing": state.get("lastInboxPing") or inbox_result,
    })
    if not dry_run:
        _save_state(state)
    return {
        "ok": True,
        "posted": posted or bool(inbox_result.get("posted")),
        "reason": post_reason,
        "eventCount": len(new_events),
        "pingCount": len(ping_events),
        "logPath": str(log_path),
        "events": new_events[:10],
        "post": post_result,
        "jobDrift": job_drift,
        "inbox": inbox_result,
    }


def run(*, dry_run: bool = False, force: bool = False) -> dict[str, Any]:
    """Systemagent-Lauf nach Agent-Standard: sichtbare Akte plus automatisches Urteil.

    Dry-Runs schreiben keine Akte (reines Testen). Echte Läufe werden über
    workflows.py protokolliert und erscheinen in der InfoPane, sobald wirklich
    etwas passiert ist (sonst bleiben die 30-Minuten-Takte stumm in der DB).
    """
    if dry_run:
        return _run_core(dry_run=True, force=force)

    run_id = start_run(
        "agent.systemagent",
        "Systemagent-Lauf",
        trigger="manual" if force else "cron",
    )
    try:
        result = _run_core(dry_run=False, force=force, run_id=run_id)
    except Exception as exc:
        finish_run(run_id, "error", error=str(exc))
        raise

    did_something = bool(
        result.get("eventCount")
        or result.get("pingCount")
        or result.get("posted")
        or (result.get("jobDrift") or {}).get("archivedCount")
        or (result.get("jobDrift") or {}).get("remainingCount")
    )
    finish_run(
        run_id,
        "done",
        result={
            "status": "ok",
            "message": f"{result.get('eventCount', 0)} neue Ereignisse, {result.get('pingCount', 0)} Pings",
            "payload": {"important": did_something},
            "eventCount": result.get("eventCount", 0),
            "pingCount": result.get("pingCount", 0),
            "posted": result.get("posted", False),
        },
    )
    try:
        review_background_run(run_id)
    except Exception:
        pass
    return {**result, "runId": run_id}
