"""Audit persistence for Tool Broker decisions and executions."""
from __future__ import annotations

import json
import time
from typing import Any

from .redaction import redact_for_audit
from .storage import get_db


def ensure_tool_audit_table() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS tool_broker_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                agent TEXT NOT NULL DEFAULT '',
                project TEXT NOT NULL DEFAULT '',
                conversation_id TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL,
                decision TEXT NOT NULL,
                risk TEXT NOT NULL DEFAULT '',
                sandbox TEXT NOT NULL DEFAULT '',
                ok INTEGER NOT NULL DEFAULT 0,
                error TEXT NOT NULL DEFAULT '',
                arguments_json TEXT NOT NULL DEFAULT '{}',
                output_summary TEXT NOT NULL DEFAULT ''
            )"""
        )
        db.execute("CREATE INDEX IF NOT EXISTS tool_broker_audit_ts ON tool_broker_audit(ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS tool_broker_audit_tool_ts ON tool_broker_audit(tool_name, ts DESC)")


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(redact_for_audit(value), ensure_ascii=False, sort_keys=True)
    except Exception:
        return "{}"


def _summarize_output(value: Any, limit: int = 600) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = str(redact_for_audit(value))
    else:
        text = _safe_json(value)
    text = " ".join(text.replace("\x00", "").split())
    return text[:limit]


def log_tool_audit(
    *,
    agent: str,
    project: str,
    conversation_id: str,
    tool_name: str,
    decision: str,
    risk: str,
    sandbox: str,
    ok: bool,
    arguments: dict[str, Any],
    output: Any = None,
    error: str = "",
) -> int:
    ensure_tool_audit_table()
    with get_db() as db:
        cur = db.execute(
            """INSERT INTO tool_broker_audit(
                ts, agent, project, conversation_id, tool_name, decision, risk,
                sandbox, ok, error, arguments_json, output_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                time.time(),
                agent or "",
                project or "",
                conversation_id or "",
                tool_name,
                decision,
                risk,
                sandbox,
                1 if ok else 0,
                str(redact_for_audit(error or "")),
                _safe_json(arguments or {}),
                _summarize_output(output),
            ),
        )
        return int(cur.lastrowid)
