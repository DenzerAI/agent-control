"""Approval queue for risky Tool Broker requests."""
from __future__ import annotations

import json
import time
from typing import Any

from .storage import get_db
from .types import ToolDefinition, ToolRequest


APPROVAL_COLUMNS = [
    "id",
    "ts",
    "updated_ts",
    "status",
    "agent",
    "project",
    "conversation_id",
    "requested_by",
    "request_id",
    "tool_name",
    "risk",
    "sandbox",
    "reason",
    "arguments_json",
    "decided_by",
    "decision_note",
    "executed_ts",
    "execution_audit_id",
    "execution_ok",
    "execution_error",
    "execution_output_json",
]


def _ensure_column(db: Any, table: str, column: str, ddl: str) -> None:
    existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in existing:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def ensure_tool_approval_table() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS tool_broker_approvals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                updated_ts REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                agent TEXT NOT NULL DEFAULT '',
                project TEXT NOT NULL DEFAULT '',
                conversation_id TEXT NOT NULL DEFAULT '',
                requested_by TEXT NOT NULL DEFAULT '',
                request_id TEXT NOT NULL DEFAULT '',
                tool_name TEXT NOT NULL,
                risk TEXT NOT NULL DEFAULT '',
                sandbox TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                arguments_json TEXT NOT NULL DEFAULT '{}',
                decided_by TEXT NOT NULL DEFAULT '',
                decision_note TEXT NOT NULL DEFAULT ''
            )"""
        )
        _ensure_column(db, "tool_broker_approvals", "executed_ts", "executed_ts REAL NOT NULL DEFAULT 0")
        _ensure_column(db, "tool_broker_approvals", "execution_audit_id", "execution_audit_id INTEGER")
        _ensure_column(db, "tool_broker_approvals", "execution_ok", "execution_ok INTEGER NOT NULL DEFAULT 0")
        _ensure_column(db, "tool_broker_approvals", "execution_error", "execution_error TEXT NOT NULL DEFAULT ''")
        _ensure_column(db, "tool_broker_approvals", "execution_output_json", "execution_output_json TEXT NOT NULL DEFAULT '{}'")
        db.execute("CREATE INDEX IF NOT EXISTS tool_broker_approvals_status_ts ON tool_broker_approvals(status, ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS tool_broker_approvals_conv_ts ON tool_broker_approvals(conversation_id, ts DESC)")


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value or {}, ensure_ascii=False, sort_keys=True)
    except Exception:
        return "{}"


def _decode_json(value: str) -> Any:
    try:
        return json.loads(value or "{}")
    except Exception:
        return {}


def _row_to_dict(row: Any) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "ts": float(row["ts"]),
        "updated_ts": float(row["updated_ts"]),
        "status": row["status"],
        "agent": row["agent"],
        "project": row["project"],
        "conversation_id": row["conversation_id"],
        "requested_by": row["requested_by"],
        "request_id": row["request_id"],
        "tool_name": row["tool_name"],
        "risk": row["risk"],
        "sandbox": row["sandbox"],
        "reason": row["reason"],
        "arguments": _decode_json(row["arguments_json"]),
        "decided_by": row["decided_by"],
        "decision_note": row["decision_note"],
        "executed_ts": float(row.get("executed_ts") or 0),
        "execution_audit_id": row.get("execution_audit_id"),
        "execution_ok": bool(row.get("execution_ok") or 0),
        "execution_error": row.get("execution_error") or "",
        "execution_output": _decode_json(row.get("execution_output_json") or "{}"),
    }


def create_tool_approval(request: ToolRequest, definition: ToolDefinition, reason: str) -> int:
    ensure_tool_approval_table()
    now = time.time()
    with get_db() as db:
        cur = db.execute(
            """INSERT INTO tool_broker_approvals(
                ts, updated_ts, status, agent, project, conversation_id, requested_by,
                request_id, tool_name, risk, sandbox, reason, arguments_json
            ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                now,
                now,
                request.agent or "",
                request.project or "",
                request.conversation_id or "",
                request.requested_by or "",
                request.request_id or "",
                request.name,
                definition.risk,
                definition.sandbox,
                reason,
                _safe_json(request.arguments),
            ),
        )
        return int(cur.lastrowid)


def list_tool_approvals(status: str = "pending", limit: int = 50) -> list[dict[str, Any]]:
    ensure_tool_approval_table()
    status = str(status or "pending").strip().lower()
    limit = max(1, min(int(limit or 50), 200))
    with get_db() as db:
        db.row_factory = None
        if status == "all":
            rows = db.execute(
                "SELECT * FROM tool_broker_approvals ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM tool_broker_approvals WHERE status = ? ORDER BY ts DESC LIMIT ?",
                (status, limit),
            ).fetchall()
    return [_row_to_dict(dict(zip(APPROVAL_COLUMNS, row))) for row in rows]


def decide_tool_approval(approval_id: int, decision: str, decided_by: str = "", note: str = "") -> dict[str, Any] | None:
    ensure_tool_approval_table()
    normalized = str(decision or "").strip().lower()
    if normalized not in {"approved", "denied"}:
        raise ValueError("invalid_decision")
    with get_db() as db:
        current = db.execute(
            "SELECT status FROM tool_broker_approvals WHERE id = ?",
            (int(approval_id),),
        ).fetchone()
        if current is None:
            return None
        if current[0] != "pending":
            raise ValueError("approval_already_decided")
        db.execute(
            """UPDATE tool_broker_approvals
               SET status = ?, updated_ts = ?, decided_by = ?, decision_note = ?
               WHERE id = ?""",
            (normalized, time.time(), decided_by or "", note or "", int(approval_id)),
        )
        row = db.execute(
            "SELECT * FROM tool_broker_approvals WHERE id = ?",
            (int(approval_id),),
        ).fetchone()
    return _row_to_dict(dict(zip(APPROVAL_COLUMNS, row)))


def execute_tool_approval(approval_id: int, executed_by: str = "") -> dict[str, Any] | None:
    ensure_tool_approval_table()
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM tool_broker_approvals WHERE id = ?",
            (int(approval_id),),
        ).fetchone()
    if row is None:
        return None
    approval = _row_to_dict(dict(zip(APPROVAL_COLUMNS, row)))
    if approval["status"] != "approved":
        raise ValueError("approval_not_approved")

    from .broker import execute_tool

    request = ToolRequest(
        name=approval["tool_name"],
        arguments=approval["arguments"] if isinstance(approval["arguments"], dict) else {},
        agent=approval["agent"] or "main",
        project=approval["project"] or "",
        conversation_id=approval["conversation_id"] or "",
        requested_by=executed_by or approval["decided_by"] or "human",
        request_id=approval["request_id"] or "",
        approved=True,
        approval_id=int(approval_id),
    )
    result = execute_tool(request)
    status = "executed" if result.ok else "failed"
    with get_db() as db:
        db.execute(
            """UPDATE tool_broker_approvals
               SET status = ?, updated_ts = ?, executed_ts = ?, execution_audit_id = ?,
                   execution_ok = ?, execution_error = ?, execution_output_json = ?
               WHERE id = ?""",
            (
                status,
                time.time(),
                time.time(),
                result.audit_id,
                1 if result.ok else 0,
                result.error or "",
                _safe_json(result.output),
                int(approval_id),
            ),
        )
        row = db.execute(
            "SELECT * FROM tool_broker_approvals WHERE id = ?",
            (int(approval_id),),
        ).fetchone()
    return _row_to_dict(dict(zip(APPROVAL_COLUMNS, row)))
