"""Sichtbarkeits-Registry für Workers und Hooks.

Pulses haben eine eigene Registry (`pulses.py`) inklusive Runner. Workers
und Hooks laufen unabhängig — Workers als Dauerloops im Server, Hooks
event-getrieben im Worker. Damit der InfoPane-Tab zeigen kann, wann
zuletzt etwas passierte, schreiben sie hier ihre Ticks rein.

`mark_tick(kind, name, status, message, payload)` schreibt einen Eintrag,
`snapshot(kind)` liest den aktuellen Stand. Alles ist best-effort und
darf nie den Aufrufer killen.
"""
from __future__ import annotations

import json
import time
from typing import Literal

from db import get_db

Kind = Literal["worker", "hook"]

_META: dict[tuple[Kind, str], dict[str, str]] = {
    ("worker", "_reindex_loop"): {
        "label": "Datei-Index",
        "what": "Hält den Volltext-Index der lokalen Markdown-Dateien aktuell.",
        "how": "Loop im Server, scannt alle paar Minuten geänderte Dateien und schreibt in die FTS-Tabelle.",
        "who": "Python-Loop in backend/server.py",
    },
    ("worker", "_summary_worker"): {
        "label": "WhatsApp-Zusammenfassung",
        "what": "Schreibt für jeden aktiven WhatsApp-Chat eine kurze Zusammenfassung.",
        "how": "Loop im Server, pollt die WA-DB und ruft das LLM für ungelesene Chats.",
        "who": "Python-Loop in modules/whatsapp/core.py",
    },
    ("worker", "_classify_worker"): {
        "label": "WhatsApp-Klassifizierung",
        "what": "Tagt eingehende WhatsApp-Nachrichten (Thema, Dringlichkeit) und triggert die Hooks.",
        "how": "Loop im Server, schickt jede neue Nachricht durchs LLM und ruft danach Cancel- und Firmenfitness-Hook.",
        "who": "Python-Loop in modules/whatsapp/core.py",
    },
    ("worker", "problem_radar"): {
        "label": "Problem-Radar",
        "what": "Sucht einmal taeglich auf X/Twitter nach echten Schmerzpunkten rund um AI-Agents, Automatisierung und KMU-Frust und parkt nur belastbare Funde als Idee.",
        "how": "Faehrt kuratierte Themen-Queries (config/problem_radar-queries.json) ueber Brave/X, bewertet jeden Fund hart per LLM gegen unser Profil, legt Treffer ueber Schwelle in brain/ideas/ ab und pingt nur bei starkem Fund.",
        "who": "modules/problem_radar/",
    },
    ("hook", "cancel-detector"): {
        "label": "Absage-Erkennung",
        "what": "Erkennt Absagen in WhatsApp- und Mail-Eingang und kippt den betreffenden Termin.",
        "how": "Wird vom Klassifikator gerufen, wenn eine Nachricht nach Absage riecht. Regelbasiert plus LLM für Grenzfälle.",
        "who": "modules/cancel_detector/",
    },
    ("hook", "firmenfitness-invoice"): {
        "label": "Wiedemann-Rechnung",
        "what": "Erkennt Jane-Monatsmeldung 'Xx stattgefunden' und legt eine Lexware-Rechnung als Draft an.",
        "how": "Wird vom Klassifikator gerufen, parst Zahlen aus der Nachricht und postet eine Prüfkarte in den Klaus-Channel.",
        "who": "modules/firmenfitness_invoice/",
    },
    ("hook", "workflow-run-review"): {
        "label": "Learning-Prüfer",
        "what": "Prüft abgeschlossene Läufe auf Pflichtfelder, Fehler, Tempo und mögliche Skill-Verbesserungen.",
        "how": "Wird nach einem Run event-getrieben aufgerufen. Der Prüfer ändert nicht die Kernaufgabe, sondern schreibt Review und Vorschlag in die Lernakte.",
        "who": "backend/workflows.py",
    },
    ("hook", "codex-context-recovery"): {
        "label": "Codex-Kontext-Recovery",
        "what": "Fängt ein vollgelaufenes Codex-Kontextfenster ab, verwirft die tote Resume-Session und knüpft im selben Turn frisch an den bisherigen Verlauf an.",
        "how": "Wird im Streaming ausgelöst, wenn Codex 'ran out of room' meldet. Setzt die session_id zurück und fährt automatisch ein zweites Mal mit den letzten Nachrichten als Aufwärm-Kontext auf.",
        "who": "backend/streaming.py",
    },
    ("hook", "session-resume-watch"): {
        "label": "Session-/Resume-Wächter",
        "what": "Zählt harte Server-zurück-User-Turns, Resume-Recoveries und WebSocket-Hinweise, damit Session-Abbrüche nicht nur gefühlt, sondern messbar werden.",
        "how": "Läuft als Diagnose-Loop über scripts/session-resume-watch.py und schreibt seinen letzten Befund in Automation-Registry plus work/loops/session-resume-watch/latest.json.",
        "who": "scripts/session-resume-watch.py",
    },
}


def _ensure_table() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS automation_status (
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                last_run REAL DEFAULT NULL,
                last_ok_at REAL DEFAULT NULL,
                last_status TEXT NOT NULL DEFAULT 'unknown',
                last_message TEXT NOT NULL DEFAULT '',
                last_payload TEXT NOT NULL DEFAULT '{}',
                fail_streak INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (kind, name)
            )"""
        )


def mark_tick(
    kind: Kind,
    name: str,
    status: str = "ok",
    message: str = "",
    payload: dict | None = None,
) -> None:
    """Schreibt einen Tick. Best-effort, schluckt eigene Fehler."""
    try:
        _ensure_table()
        now = time.time()
        is_err = status not in ("ok", "found")
        with get_db() as db:
            row = db.execute(
                "SELECT fail_streak, last_ok_at FROM automation_status WHERE kind=? AND name=?",
                (kind, name),
            ).fetchone()
            prev_fail = int(row[0]) if row else 0
            prev_ok = row[1] if row else None
            new_fail = prev_fail + 1 if is_err else 0
            last_ok = prev_ok if is_err else now
            db.execute(
                """INSERT INTO automation_status (kind, name, last_run, last_ok_at, last_status,
                                                  last_message, last_payload, fail_streak, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(kind, name) DO UPDATE SET
                       last_run = excluded.last_run,
                       last_ok_at = excluded.last_ok_at,
                       last_status = excluded.last_status,
                       last_message = excluded.last_message,
                       last_payload = excluded.last_payload,
                       fail_streak = excluded.fail_streak,
                       updated_at = excluded.updated_at""",
                (
                    kind, name, now, last_ok, status,
                    (message or "")[:500],
                    json.dumps(payload or {}, ensure_ascii=False),
                    new_fail, now,
                ),
            )
        _record_learning_tick(kind, name, status, message, payload or {}, now)
    except Exception as e:
        print(f"[automation_registry] mark_tick({kind}, {name}) failed: {e}", flush=True)


def _record_learning_tick(kind: Kind, name: str, status: str, message: str, payload: dict, now: float) -> None:
    """Best-effort Learning Log fuer Worker und Hooks, streng gegen DB-Rauschen."""
    if name == "workflow-run-review":
        return
    if payload.get("learning_log") is False:
        return
    important = bool(payload.get("learning_log") is True or payload.get("important") or payload.get("changed"))
    is_error = status not in ("ok", "found")
    if not (is_error or important):
        return
    workflow_key = f"{kind}.tick"
    try:
        throttle_sec = 0 if is_error else 15 * 60
        if throttle_sec:
            with get_db() as db:
                row = db.execute(
                    "SELECT created_at FROM workflow_runs WHERE workflow_key=? AND subject_type=? AND subject_ref=? ORDER BY created_at DESC LIMIT 1",
                    (workflow_key, kind, name),
                ).fetchone()
                if row and now - float(row[0] or 0) < throttle_sec:
                    return

        import workflows
        meta = _META.get((kind, name), {})
        label = meta.get("label") or name
        run_id = workflows.start_run(
            workflow_key,
            f"{'Worker' if kind == 'worker' else 'Hook'}: {label}",
            trigger="automation_registry",
            subject_type=kind,
            subject_ref=name,
            input_data={
                "kind": kind,
                "name": name,
                "label": label,
            },
        )
        workflows.add_step(run_id, "tick", "Tick", status, message or "", {"payload": payload})
        finished_status = "done" if status in ("ok", "found") else "error"
        workflows.finish_run(
            run_id,
            finished_status,
            result={
                "status": status,
                "message": message or "",
                "duration_ms": 0,
                "payload": payload,
            },
            error="" if finished_status == "done" else (message or "")[:1000],
        )
        workflows.review_background_run(run_id)
    except Exception as e:
        print(f"[automation_registry] learning_tick({kind}, {name}) failed: {e}", flush=True)


def snapshot(kind: Kind) -> list[dict]:
    """Liefert den aktuellen Status aller bekannten Workers/Hooks.

    Reihenfolge folgt der _META-Registry, damit das UI eine stabile Liste bekommt.
    Einträge ohne Tick erscheinen mit color=gray.
    """
    _ensure_table()
    now = time.time()
    known = [(k, n) for (k, n) in _META.keys() if k == kind]
    with get_db() as db:
        db.row_factory = __import__("sqlite3").Row
        rows = {r["name"]: dict(r) for r in db.execute(
            "SELECT * FROM automation_status WHERE kind=?", (kind,)
        ).fetchall()}
    out: list[dict] = []
    for (_, name) in known:
        d = dict(rows.get(name) or {})
        meta = _META[(kind, name)]
        if not d:
            d = {
                "name": name,
                "kind": kind,
                "last_run": None,
                "last_ok_at": None,
                "last_status": "unknown",
                "last_message": "",
                "last_payload": "{}",
                "fail_streak": 0,
                "updated_at": 0,
            }
        try:
            d["last_payload"] = json.loads(d.get("last_payload") or "{}")
        except Exception:
            d["last_payload"] = {}
        last = d.get("last_run") or 0.0
        fail = int(d.get("fail_streak") or 0)
        status = d.get("last_status") or "unknown"
        if fail >= 3 or status in ("error", "timeout"):
            color = "red"
        elif not last:
            color = "green" if kind == "hook" else "gray"
        else:
            color = "green"
        d["color"] = color
        d["age_sec"] = int(now - last) if last else None
        d["label"] = meta.get("label") or name
        d["what"] = meta.get("what") or ""
        d["how"] = meta.get("how") or ""
        d["who"] = meta.get("who") or ""
        d["internal_name"] = name
        out.append(d)
    return out
