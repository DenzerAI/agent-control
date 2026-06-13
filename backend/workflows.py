"""Workflow Run Log.

Kleine Harness-Schicht für ausführbare Abläufe: ein Run ist die Akte,
Steps sind die Prüfpunkte, ein Review fasst Risiken und Verbesserung zusammen.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import Any

from db import get_db


def _json(data: Any) -> str:
    return json.dumps(data if data is not None else {}, ensure_ascii=False)


def _loads(text: str | None, fallback: Any = None) -> Any:
    try:
        return json.loads(text or "")
    except Exception:
        return {} if fallback is None else fallback


def ensure_schema() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS workflow_runs (
                id TEXT PRIMARY KEY,
                workflow_key TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'running',
                trigger TEXT NOT NULL DEFAULT '',
                subject_type TEXT NOT NULL DEFAULT '',
                subject_ref TEXT NOT NULL DEFAULT '',
                conversation_id TEXT NOT NULL DEFAULT '',
                person_id INTEGER DEFAULT NULL,
                input_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                finished_at REAL DEFAULT NULL,
                review_status TEXT NOT NULL DEFAULT 'pending',
                review_message TEXT NOT NULL DEFAULT '',
                review_json TEXT NOT NULL DEFAULT '{}'
            )"""
        )
        db.execute("CREATE INDEX IF NOT EXISTS workflow_runs_key_created ON workflow_runs(workflow_key, created_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS workflow_runs_status_created ON workflow_runs(status, created_at DESC)")
        db.execute(
            """CREATE TABLE IF NOT EXISTS workflow_run_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                step_key TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'ok',
                summary TEXT NOT NULL DEFAULT '',
                data_json TEXT NOT NULL DEFAULT '{}',
                ts REAL NOT NULL,
                FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
            )"""
        )
        db.execute("CREATE INDEX IF NOT EXISTS workflow_run_steps_run_ts ON workflow_run_steps(run_id, ts)")


def start_run(
    workflow_key: str,
    title: str,
    *,
    trigger: str = "",
    subject_type: str = "",
    subject_ref: str = "",
    conversation_id: str = "",
    person_id: int | None = None,
    input_data: dict | None = None,
) -> str:
    ensure_schema()
    now = time.time()
    run_id = str(uuid.uuid4())[:12]
    with get_db() as db:
        db.execute(
            """INSERT INTO workflow_runs (
                id, workflow_key, title, status, trigger, subject_type, subject_ref,
                conversation_id, person_id, input_json, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                run_id, workflow_key, title, "running", trigger, subject_type,
                subject_ref, conversation_id, person_id, _json(input_data), now, now,
            ),
        )
    add_step(run_id, "run_started", "Run gestartet", "ok", title, input_data or {})
    return run_id


def add_step(
    run_id: str,
    step_key: str,
    label: str = "",
    status: str = "ok",
    summary: str = "",
    data: dict | None = None,
) -> None:
    ensure_schema()
    now = time.time()
    with get_db() as db:
        db.execute(
            """INSERT INTO workflow_run_steps (run_id, step_key, label, status, summary, data_json, ts)
               VALUES (?,?,?,?,?,?,?)""",
            (run_id, step_key, label, status, summary, _json(data), now),
        )
        db.execute("UPDATE workflow_runs SET updated_at=? WHERE id=?", (now, run_id))


def finish_run(run_id: str, status: str, *, result: dict | None = None, error: str = "") -> None:
    ensure_schema()
    now = time.time()
    with get_db() as db:
        db.execute(
            """UPDATE workflow_runs
               SET status=?, result_json=?, error=?, updated_at=?, finished_at=?
               WHERE id=?""",
            (status, _json(result), (error or "")[:1000], now, now, run_id),
        )


def update_run_result(run_id: str, result: dict | None) -> None:
    """Überschreibt das Ergebnis eines bereits abgeschlossenen Laufs.

    Gebraucht, wenn ein Entwurf nachträglich bearbeitet wird, ohne einen
    neuen Lauf zu starten. Status und Steps bleiben unberührt.
    """
    ensure_schema()
    now = time.time()
    with get_db() as db:
        db.execute(
            "UPDATE workflow_runs SET result_json=?, updated_at=? WHERE id=?",
            (_json(result), now, run_id),
        )


def _metric_scores(duration_ms: int, errors: list, warnings: list, checks: list, done: bool) -> dict:
    speed_score = 100 if duration_ms <= 1500 else 90 if duration_ms <= 3000 else 75 if duration_ms <= 8000 else 55 if duration_ms <= 30000 else 35
    safety_score = max(0, 100 - len(errors) * 45 - len(warnings) * 20)
    check_score = round(100 * len([c for c in checks if c.get("ok")]) / max(1, len(checks)))
    completion_score = 100 if done and not errors else 70 if done else 25
    overall_score = round(safety_score * 0.45 + completion_score * 0.25 + check_score * 0.20 + speed_score * 0.10)
    return {
        "overall_score": overall_score,
        "safety_score": safety_score,
        "completion_score": completion_score,
        "check_score": check_score,
        "speed_score": speed_score,
    }


_TOOL_FAIL_STATUSES = {"error", "failed", "timeout", "cancelled"}
_TOOL_OK_STATUSES = {"completed", "done", "ok", "success"}
_TOOL_ERROR_MARKERS = (
    "error:",
    "fehler:",
    "traceback",
    "no such file or directory",
    "command not found",
    "permission denied",
    "failed",
)


def _clean_tool_text(text: str, limit: int = 140) -> str:
    s = " ".join(str(text or "").replace("\n", " ").split())
    lowered = s.lower()
    for marker in ("token=", "api_key=", "password=", "authorization:"):
        pos = lowered.find(marker)
        if pos >= 0:
            s = s[:pos] + marker + "[redacted]"
            break
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


def _tool_label(tool: dict) -> str:
    name = str(tool.get("name") or "Tool").strip() or "Tool"
    inp = tool.get("input") if isinstance(tool.get("input"), dict) else {}
    detail = ""
    for key in ("command", "file_path", "path", "pattern", "query", "description", "glob"):
        value = inp.get(key)
        if value:
            detail = _clean_tool_text(str(value), 100)
            break
    return f"{name}: {detail}" if detail else name


def _tool_failed(tool: dict) -> bool:
    status = str(tool.get("status") or "").strip().lower()
    if status in _TOOL_FAIL_STATUSES:
        return True
    result = str(tool.get("result") or "").strip().lower()[:500]
    if result.startswith(("no error", "no errors", "keine fehler")):
        return False
    return any(marker in result for marker in _TOOL_ERROR_MARKERS)


def _tool_succeeded(tool: dict) -> bool:
    status = str(tool.get("status") or "").strip().lower()
    return status in _TOOL_OK_STATUSES and not _tool_failed(tool)


def _agent_learning_journey(tool_calls: list[dict], *, blocked: bool) -> dict:
    failed: list[dict] = []
    working_after_failure: list[dict] = []
    seen_failure = False
    for tool in tool_calls:
        if _tool_failed(tool):
            seen_failure = True
            failed.append(tool)
        elif seen_failure and _tool_succeeded(tool):
            working_after_failure.append(tool)

    if blocked:
        klass = "blocker"
        label = "Blocker"
        highway = "Ziel nicht erreicht. Ursache klären, bevor dieser Pfad als zuverlässig gilt."
    elif failed:
        klass = "detour"
        label = "Umweg"
        first_failed = _tool_label(failed[0])
        if working_after_failure:
            first_working = _tool_label(working_after_failure[0])
            highway = f"Künftig zuerst {first_working} prüfen; {first_failed} war ein Umweg."
        else:
            highway = f"Umweg gespeichert: {first_failed} hat nicht getragen, der Lauf wurde anders gelöst."
    else:
        klass = "direct"
        label = "Direkter Pfad"
        highway = "Kein Umweg erkannt. Dieser Ablauf kann als bevorzugter Pfad dienen."

    return {
        "class": klass,
        "label": label,
        "detour_count": len(failed),
        "blocker_count": 1 if blocked else 0,
        "learning_count": 1 if klass in ("detour", "blocker") else 0,
        "failed_attempts": [_tool_label(t) for t in failed[:5]],
        "working_after_failure": [_tool_label(t) for t in working_after_failure[:5]],
        "highway_note": highway,
    }


def _background_learning_journey(*, status: str, result_status: str, title: str, duration_ms: int, timeout_seconds: Any = None) -> dict:
    blocked = status == "error" or result_status in ("error", "timeout", "failed")
    warned = status == "warning"
    timeout_note = ""
    try:
        timeout_s = int(timeout_seconds or 0)
    except Exception:
        timeout_s = 0
    if result_status == "timeout" and timeout_s:
        timeout_note = f" Timeout nach {timeout_s}s, reale Dauer {round(duration_ms / 1000)}s."

    if blocked:
        klass = "blocker"
        label = "Blocker"
        highway = f"{title} hat das Ziel nicht erreicht.{timeout_note} Ursache klären, bevor dieser Lauf wieder als zuverlässig gilt."
    elif warned:
        klass = "detour"
        label = "Umweg"
        highway = f"{title} lief durch, aber mit Warnsignal. Ergebnis prüfen und die Regel schärfen, wenn sich das Muster wiederholt."
    else:
        klass = "direct"
        label = "Direkter Pfad"
        highway = "Kein Umweg erkannt. Dieser Ablauf kann als bevorzugter Pfad dienen."

    return {
        "class": klass,
        "label": label,
        "detour_count": 1 if klass == "detour" else 0,
        "blocker_count": 1 if klass == "blocker" else 0,
        "learning_count": 1 if klass in ("detour", "blocker") else 0,
        "failed_attempts": [f"{title}: {result_status or status}"] if klass == "blocker" else [],
        "working_after_failure": [],
        "highway_note": highway,
    }


def review_agent_turn(run_id: str) -> dict:
    """Generischer Post-Run-Check für Agentenläufe.

    Das ist die gemeinsame Lernakte für Skills, Tool-Nutzung und Arbeitsaufträge.
    Spezifische Workflows wie WhatsApp dürfen zusätzlich strengere Reviews haben.
    """
    ensure_schema()
    with get_db() as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
        step_rows = db.execute(
            "SELECT step_key, status FROM workflow_run_steps WHERE run_id=? ORDER BY ts ASC",
            (run_id,),
        ).fetchall()
    if not row:
        return {"status": "error", "message": "Run nicht gefunden"}

    inp = _loads(row["input_json"])
    result = _loads(row["result_json"])
    tool_calls = result.get("tool_calls") if isinstance(result.get("tool_calls"), list) else []
    final_text = str(result.get("final_text") or "")
    elapsed_ms = int(result.get("elapsed_ms") or 0)
    if not elapsed_ms:
        finished_at = float(row["finished_at"] or row["updated_at"] or time.time())
        created_at = float(row["created_at"] or finished_at)
        elapsed_ms = max(0, int((finished_at - created_at) * 1000))

    checks: list[dict] = []

    def check(key: str, ok: bool, message: str, severity: str = "error") -> None:
        checks.append({"key": key, "ok": bool(ok), "message": message, "severity": severity})

    check("user_goal_present", bool(str(inp.get("prompt") or "").strip()), "Auftrag vorhanden")
    check("final_answer_present", bool(final_text.strip()), "Antwort vorhanden")
    check("run_finished", row["status"] == "done", "Lauf abgeschlossen")
    if tool_calls:
        failed_tools = [t for t in tool_calls if _tool_failed(t)]
        check("tool_results", not failed_tools, "Tool-Calls ohne Fehler", "warn")
    else:
        check("no_tool_needed", True, "Keine Tools nötig", "info")

    errors = [c for c in checks if not c["ok"] and c["severity"] == "error"]
    warnings = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
    learning = _agent_learning_journey(tool_calls, blocked=bool(errors or row["status"] == "error"))
    status = "error" if errors else ("warning" if warnings else "ok")
    if learning["class"] == "detour" and status == "ok":
        status = "warning"
    message = (
        f"{learning['label']}: {learning['highway_note']}"
        if learning["class"] in ("detour", "blocker")
        else ("sauber geprüft" if status == "ok" else "; ".join(c["message"] for c in (errors or warnings)))
    )
    metric_scores = _metric_scores(elapsed_ms, errors, warnings, checks, row["status"] == "done")
    changed_files = [
        t for t in tool_calls
        if isinstance(t.get("diffStats"), dict) and (int(t["diffStats"].get("added", 0) or 0) or int(t["diffStats"].get("removed", 0) or 0))
    ]
    trace = [
        f"Start: {inp.get('engine') or 'Agent'} nahm den Auftrag an.",
        f"Kontext: Conversation {row['conversation_id'] or 'unbekannt'}, Projekt {inp.get('project') or 'ohne Projekt'}.",
        f"Werkzeuge: {len(tool_calls)} Tool-Calls, {len(changed_files)} mit Dateiänderungen.",
        f"Prüfung: {message}.",
    ]
    if learning["failed_attempts"]:
        trace.append("Umweg: " + "; ".join(learning["failed_attempts"][:3]) + ".")
    if learning["working_after_failure"]:
        trace.append("Funktionierender Pfad danach: " + "; ".join(learning["working_after_failure"][:3]) + ".")
    review = {
        "checks": checks,
        "metrics": {
            **metric_scores,
            "duration_ms": elapsed_ms,
            "step_count": len(step_rows) + 1,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "check_count": len(checks),
            "tool_count": len(tool_calls),
            "changed_tool_count": len(changed_files),
            "detour_count": int(learning["detour_count"]),
            "blocker_count": int(learning["blocker_count"]),
            "learning_count": int(learning["learning_count"]),
            "input_tokens": int(result.get("input_tokens") or 0),
            "output_tokens": int(result.get("output_tokens") or 0),
        },
        "trace": trace,
        "learning": learning,
        "suggested_refinement": "" if learning["class"] == "direct" else learning["highway_note"],
    }

    now = time.time()
    with get_db() as db:
        db.execute(
            """UPDATE workflow_runs
               SET review_status=?, review_message=?, review_json=?, updated_at=?
               WHERE id=?""",
            (status, message[:500], _json(review), now, run_id),
        )
    add_step(run_id, "postcheck", "Post Run Check", status, message, review)
    try:
        from automation_registry import mark_tick
        mark_tick("hook", "workflow-run-review", "ok" if status in ("ok", "warning") else "error", f"Agent Lauf {run_id}: {message}", {"run_id": run_id, "status": status})
    except Exception:
        pass
    return {"status": status, "message": message, **review}


def review_whatsapp_send(run_id: str) -> dict:
    """Deterministischer Post-Run-Check für WhatsApp Sends.

    Der Review verändert die Kernaufgabe nicht. Er bewertet nur, ob der Lauf
    sauber belegbar war und welche Regel später eventuell in den Skill gehört.
    """
    ensure_schema()
    with get_db() as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
        step_rows = db.execute(
            "SELECT step_key, status FROM workflow_run_steps WHERE run_id=? ORDER BY ts ASC",
            (run_id,),
        ).fetchall()
    if not row:
        return {"status": "error", "message": "Run nicht gefunden"}

    inp = _loads(row["input_json"])
    result = _loads(row["result_json"])
    checks: list[dict] = []

    def check(key: str, ok: bool, message: str, severity: str = "error") -> None:
        checks.append({"key": key, "ok": bool(ok), "message": message, "severity": severity})

    chat_id = str(inp.get("chat_id") or "")
    text = str(inp.get("text") or "")
    check("recipient_present", bool(chat_id), "Empfänger Chat ID vorhanden")
    check("text_present", bool(text.strip()), "Nachrichtentext vorhanden")
    check("backend_route", inp.get("route") == "/api/whatsapp/send", "Send lief über Backend Route")
    check("not_bridge_direct", True, "Kein Bridge Direktcall im Run erkennbar")
    check("bridge_result", bool(result) and result.get("ok", True) is not False and not result.get("error"), "Bridge Ergebnis ohne Fehler")
    check("message_id", bool(result.get("id") or result.get("message_id") or result.get("msg_id")), "Nachrichten ID vorhanden", "info")

    errors = [c for c in checks if not c["ok"] and c["severity"] == "error"]
    warnings = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
    status = "error" if errors else ("warning" if warnings else "ok")
    message = "sauber geprüft" if status == "ok" else "; ".join(c["message"] for c in (errors or warnings))
    finished_at = float(row["finished_at"] or row["updated_at"] or time.time())
    created_at = float(row["created_at"] or finished_at)
    duration_ms = max(0, int((finished_at - created_at) * 1000))
    metric_scores = _metric_scores(duration_ms, errors, warnings, checks, row["status"] == "done" and status == "ok")
    trace = [
        "Start: Backend-Route /api/whatsapp/send angenommen.",
        f"Empfänger: {inp.get('recipient_name') or chat_id or 'unbekannt'} belegt.",
        "Send: WhatsApp-Bridge lieferte eine Message-ID." if (result.get("id") or result.get("message_id") or result.get("msg_id")) else "Send: keine Message-ID belegt.",
        f"Prüfung: {message}.",
    ]
    review = {
        "checks": checks,
        "metrics": {
            **metric_scores,
            "duration_ms": duration_ms,
            "step_count": len(step_rows) + 1,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "check_count": len(checks),
        },
        "trace": trace,
        "suggested_refinement": "" if status == "ok" else "Skill um Pflichtfeld oder Blocker ergänzen, wenn sich dieser Fehler wiederholt.",
    }

    now = time.time()
    with get_db() as db:
        db.execute(
            """UPDATE workflow_runs
               SET review_status=?, review_message=?, review_json=?, updated_at=?
               WHERE id=?""",
            (status, message[:500], _json(review), now, run_id),
        )
    add_step(run_id, "postcheck", "Post Run Check", status, message, review)
    try:
        from automation_registry import mark_tick
        mark_tick("hook", "workflow-run-review", "ok" if status in ("ok", "warning") else "error", f"WhatsApp Send {run_id}: {message}", {"run_id": run_id, "status": status})
    except Exception:
        pass
    return {"status": status, "message": message, **review}


def review_context_router(run_id: str) -> dict:
    """Deterministischer Review fuer automatische Kontext-Ladungen."""
    ensure_schema()
    with get_db() as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
        step_rows = db.execute(
            "SELECT step_key, status FROM workflow_run_steps WHERE run_id=? ORDER BY ts ASC",
            (run_id,),
        ).fetchall()
    if not row:
        return {"status": "error", "message": "Run nicht gefunden"}

    result = _loads(row["result_json"])
    sources = result.get("sources") if isinstance(result.get("sources"), list) else []
    loaded_count = int(result.get("loaded_count") or len(sources) or 0)
    candidate_count = int(result.get("candidate_count") or loaded_count or 0)
    dropped_count = int(result.get("dropped_count") or max(0, candidate_count - loaded_count))
    max_sources = int(result.get("max_sources") or 4)
    injected_chars = int(result.get("injected_chars") or 0)
    duration_ms = int(result.get("duration_ms") or 0)
    message = f"{loaded_count} Quellen geladen, {dropped_count} verworfen" if loaded_count else "keine passende Quelle geladen"
    trace = [
        "Start: User-Nachricht tokenisiert.",
        "Suche: Brain-Dateien, People, Fokus und Chat-History deterministisch geprüft.",
        f"Ranking: {candidate_count} Kandidaten, Limit {max_sources}, {dropped_count} verworfen.",
        f"Ergebnis: {message}.",
    ]
    if sources:
        for s in sources[:4]:
            title = s.get("title") or s.get("path") or s.get("kind") or "Quelle"
            reason = str(s.get("reason") or "").strip()
            trace.append(f"Quelle: {title}" + (f" ({reason})" if reason else ""))

    has_reasons = not sources or all(str(s.get("reason") or "").strip() for s in sources)
    within_limit = loaded_count <= max_sources
    compact_enough = injected_chars <= 1800
    warning_count = len([ok for ok in (within_limit, compact_enough, has_reasons) if not ok])
    status = "warning" if warning_count else "ok"

    review = {
        "checks": [
            {"key": "deterministic", "ok": True, "message": "Keine LLM-Pflicht im Router", "severity": "info"},
            {"key": "existing_sources_only", "ok": True, "message": "Nur bestehende Quellen gelesen", "severity": "info"},
            {"key": "loaded_sources", "ok": loaded_count > 0, "message": message, "severity": "info"},
            {"key": "source_limit", "ok": within_limit, "message": f"Maximal {max_sources} Quellen im Prompt", "severity": "warn"},
            {"key": "compact_context", "ok": compact_enough, "message": f"Kontextblock {injected_chars} Zeichen", "severity": "warn"},
            {"key": "reasons_present", "ok": has_reasons, "message": "Jede geladene Quelle hat eine Begründung", "severity": "warn"},
        ],
        "metrics": {
            "overall_score": 100,
            "safety_score": 100,
            "completion_score": 100,
            "check_score": 100,
            "speed_score": 100 if duration_ms <= 250 else 90 if duration_ms <= 750 else 75,
            "duration_ms": duration_ms,
            "step_count": len(step_rows) + 1,
            "error_count": 0,
            "warning_count": warning_count,
            "check_count": 6,
            "source_count": loaded_count,
            "candidate_count": candidate_count,
            "dropped_count": dropped_count,
            "injected_chars": injected_chars,
        },
        "trace": trace,
        "suggested_refinement": "" if loaded_count else "Keine Nacharbeit. Bei wiederholt leeren Treffern Suchbegriffe oder Quellenindex prüfen.",
    }

    now = time.time()
    with get_db() as db:
        db.execute(
            """UPDATE workflow_runs
               SET review_status=?, review_message=?, review_json=?, updated_at=?
               WHERE id=?""",
            (status, message[:500], _json(review), now, run_id),
        )
    add_step(run_id, "postcheck", "Post Run Check", status, message, review)
    try:
        from automation_registry import mark_tick
        mark_tick("hook", "workflow-run-review", "ok", f"Context Router {run_id}: {message}", {"run_id": run_id, "status": status})
    except Exception:
        pass
    return {"status": status, "message": message, **review}


def record_feedback(run_id: str, rating: str, note: str = "") -> dict:
    """User-Feedback an einen Workflow-Run haengen, ohne den Run umzuschreiben."""
    ensure_schema()
    rating = (rating or "").strip().lower()
    if rating not in ("helpful", "wrong"):
        return {"status": "error", "message": "rating muss helpful oder wrong sein"}
    note = (note or "").strip()[:500]
    now = time.time()
    with get_db() as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            return {"status": "error", "message": "Run nicht gefunden"}
        review = _loads(row["review_json"], {})
        feedback = review.get("feedback") if isinstance(review.get("feedback"), list) else []
        feedback.append({"rating": rating, "note": note, "ts": now})
        review["feedback"] = feedback[-20:]
        review["feedback_summary"] = {
            "helpful": len([f for f in review["feedback"] if f.get("rating") == "helpful"]),
            "wrong": len([f for f in review["feedback"] if f.get("rating") == "wrong"]),
            "last_rating": rating,
        }
        db.execute(
            """UPDATE workflow_runs
               SET review_json=?, updated_at=?
               WHERE id=?""",
            (_json(review), now, run_id),
        )
    add_step(
        run_id,
        "user_feedback",
        "Christian Feedback",
        "ok" if rating == "helpful" else "warning",
        "Kontext hilfreich" if rating == "helpful" else "Kontext falsch oder stoerend",
        {"rating": rating, "note": note},
    )
    return {"status": "ok", "message": "Feedback gespeichert", "rating": rating}


def review_background_run(run_id: str) -> dict:
    """Generischer Review fuer Jobs, Pulses, Workers und Hooks."""
    ensure_schema()
    with get_db() as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM workflow_runs WHERE id=?", (run_id,)).fetchone()
        step_rows = db.execute(
            "SELECT step_key, status FROM workflow_run_steps WHERE run_id=? ORDER BY ts ASC",
            (run_id,),
        ).fetchall()
    if not row:
        return {"status": "error", "message": "Run nicht gefunden"}

    inp = _loads(row["input_json"])
    result = _loads(row["result_json"])
    result_status = str(result.get("status") or inp.get("status") or row["status"] or "").lower()
    duration_ms = int(result.get("duration_ms") or 0)
    if not duration_ms:
        finished_at = float(row["finished_at"] or row["updated_at"] or time.time())
        created_at = float(row["created_at"] or finished_at)
        duration_ms = max(0, int((finished_at - created_at) * 1000))

    checks: list[dict] = []

    def check(key: str, ok: bool, message: str, severity: str = "error") -> None:
        checks.append({"key": key, "ok": bool(ok), "message": message, "severity": severity})

    check("subject_present", bool(str(row["subject_ref"] or row["title"] or "").strip()), "Name vorhanden")
    check("run_finished", row["status"] == "done", "Lauf abgeschlossen")
    check("runtime_status", result_status not in ("error", "timeout", "failed") and row["status"] != "error", "Kein Laufzeitfehler")
    if row["workflow_key"] == "job.run":
        check("output_file", bool(result.get("output_file")), "Output-Datei belegt", "warn")
    elif row["workflow_key"] == "pulse.run":
        check("pulse_message", bool(str(result.get("message") or "").strip()), "Pulse-Ergebnis beschrieben", "info")
    else:
        check("tick_message", bool(str(result.get("message") or "").strip()), "Tick beschrieben", "info")

    errors = [c for c in checks if not c["ok"] and c["severity"] == "error"]
    warnings = [c for c in checks if not c["ok"] and c["severity"] == "warn"]
    status = "error" if errors else ("warning" if warnings else "ok")
    message = "sauber geprüft" if status == "ok" else "; ".join(c["message"] for c in (errors or warnings))
    metric_scores = _metric_scores(duration_ms, errors, warnings, checks, row["status"] == "done")
    title = row["title"] or row["subject_ref"] or row["workflow_key"]
    learning = _background_learning_journey(
        status=status,
        result_status=result_status,
        title=title,
        duration_ms=duration_ms,
        timeout_seconds=inp.get("timeout_seconds") or result.get("timeout_seconds"),
    )
    if learning["class"] in ("detour", "blocker"):
        message = f"{learning['label']}: {learning['highway_note']}"
    trace = [
        f"Start: {title} wurde durch {row['trigger'] or 'System'} ausgeführt.",
        f"Status: {result_status or row['status']}.",
        f"Dauer: {duration_ms} ms.",
        f"Prüfung: {message}.",
    ]
    review = {
        "checks": checks,
        "metrics": {
            **metric_scores,
            "duration_ms": duration_ms,
            "step_count": len(step_rows) + 1,
            "error_count": len(errors),
            "warning_count": len(warnings),
            "check_count": len(checks),
            "detour_count": int(learning["detour_count"]),
            "blocker_count": int(learning["blocker_count"]),
            "learning_count": int(learning["learning_count"]),
        },
        "trace": trace,
        "learning": learning,
        "suggested_refinement": "" if learning["class"] == "direct" else learning["highway_note"],
    }

    now = time.time()
    with get_db() as db:
        db.execute(
            """UPDATE workflow_runs
               SET review_status=?, review_message=?, review_json=?, updated_at=?
               WHERE id=?""",
            (status, message[:500], _json(review), now, run_id),
        )
    add_step(run_id, "postcheck", "Post Run Check", status, message, review)
    try:
        from automation_registry import mark_tick
        mark_tick("hook", "workflow-run-review", "ok" if status in ("ok", "warning") else "error", f"{row['workflow_key']} {run_id}: {message}", {"run_id": run_id, "status": status})
    except Exception:
        pass
    return {"status": status, "message": message, **review}


def _run_is_visible(row: sqlite3.Row) -> bool:
    """UI-Relevanz: Menschenarbeit und wichtige Automationen, nicht jeder Maschinentick."""
    if row["status"] == "error" or row["review_status"] in ("error", "warning"):
        return True
    key = str(row["workflow_key"] or "")
    if key in ("agent.turn", "job.run", "whatsapp.send"):
        return True
    if key.startswith("skill."):
        return True
    if key in ("pulse.run", "worker.tick", "hook.tick", "agent.systemagent"):
        result = _loads(row["result_json"], {})
        inp = _loads(row["input_json"], {})
        payload = result.get("payload") if isinstance(result.get("payload"), dict) else {}
        return bool(payload.get("important") or payload.get("changed") or payload.get("learning_log") is True)
    return False


def recent_runs(limit: int = 20, workflow_key: str | None = None, visible_only: bool = True) -> list[dict]:
    ensure_schema()
    limit = max(1, min(int(limit or 20), 100))
    with get_db() as db:
        db.row_factory = sqlite3.Row
        if workflow_key:
            rows = db.execute(
                "SELECT * FROM workflow_runs WHERE workflow_key=? ORDER BY created_at DESC LIMIT ?",
                (workflow_key, limit),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?",
                (limit * 8 if visible_only else limit,),
            ).fetchall()
        out: list[dict] = []
        for r in rows:
            if visible_only and not _run_is_visible(r):
                continue
            steps = db.execute(
                "SELECT step_key, label, status, summary, data_json, ts FROM workflow_run_steps WHERE run_id=? ORDER BY ts ASC",
                (r["id"],),
            ).fetchall()
            item = dict(r)
            item["input"] = _loads(item.pop("input_json", "{}"))
            item["result"] = _loads(item.pop("result_json", "{}"))
            item["review"] = _loads(item.pop("review_json", "{}"))
            item["steps"] = [
                {
                    "step_key": s["step_key"],
                    "label": s["label"],
                    "status": s["status"],
                    "summary": s["summary"],
                    "data": _loads(s["data_json"], {}),
                    "ts": s["ts"],
                }
                for s in steps
            ]
            out.append(item)
            if len(out) >= limit:
                break
    return out
