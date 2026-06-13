"""MCP-compatible gateway layer in front of the Tool Broker.

The gateway does not execute tools itself. It creates a small task-specific
tool window, mints short-lived capability tokens for one exact tool call, and
then hands verified requests to the existing broker.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from typing import Any

from .broker import execute_tool
from .catalog import get_tool, list_tool_definitions
from .storage import get_db
from .types import ToolDefinition, ToolRequest, ToolResult

_KEY_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "work", "agent-control", "security", "gateway.key",
)


def _load_or_create_key() -> str:
    """Stabiler Gateway-Key ueber Restarts hinweg.

    env AGENT_GATEWAY_KEY hat Vorrang. Ohne env wird einmalig ein Key erzeugt
    und lokal persistiert, statt bei jedem Prozessstart neu zu wuerfeln. Sonst
    brechen ausgestellte Capabilities nach jedem Restart mit bad_signature.
    """
    try:
        with open(_KEY_FILE, "r", encoding="utf-8") as handle:
            existing = handle.read().strip()
            if existing:
                return existing
    except OSError:
        pass
    generated = secrets.token_urlsafe(32)
    try:
        os.makedirs(os.path.dirname(_KEY_FILE), exist_ok=True)
        with open(_KEY_FILE, "w", encoding="utf-8") as handle:
            handle.write(generated)
        os.chmod(_KEY_FILE, 0o600)
    except OSError:
        pass
    return generated


_FALLBACK_KEY = _load_or_create_key()
MAX_CAPABILITY_TTL_SECONDS = 900

PURPOSE_TOOL_WINDOWS: dict[str, tuple[str, ...]] = {
    "inspect": (
        "engine.list",
        "skill.search",
        "file.list",
        "file.read",
        "git.status",
        "git.diff",
        "git.show",
        "web.fetch",
        "tailscale.status",
        "artifact.list",
        "secret.manifest",
        "secret.classify_path",
    ),
    "build": (
        "engine.list",
        "skill.search",
        "file.list",
        "file.read",
        "file.write",
        "file.patch",
        "git.status",
        "git.diff",
        "git.show",
        "shell.run",
        "code.run",
        "web.fetch",
        "tailscale.status",
        "artifact.list",
        "secret.classify_path",
    ),
    "admin": (
        "engine.list",
        "git.status",
        "git.diff",
        "shell.run",
        "tailscale.status",
        "secret.manifest",
        "secret.classify_path",
        "admin.recipe.list",
        "admin.recipe.run",
    ),
    "external": (
        "engine.list",
        "skill.search",
        "file.read",
        "git.status",
        "mail.draft",
        "whatsapp.draft",
        "whatsapp.send",
        "calendar.read",
    ),
}

DEFAULT_PURPOSE = "build"
DEFAULT_WINDOW_SIZE = 12


def _secret_key() -> bytes:
    raw = os.environ.get("AGENT_GATEWAY_KEY") or _FALLBACK_KEY
    return raw.encode("utf-8")


def _json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _args_hash(arguments: dict[str, Any]) -> str:
    return hashlib.sha256(_json(arguments or {}).encode("utf-8")).hexdigest()


def _capability_hash(capability: str) -> str:
    return hashlib.sha256(str(capability or "").encode("utf-8")).hexdigest()


def _purpose(raw: str | None) -> str:
    candidate = str(raw or "").strip().lower()
    return candidate if candidate in PURPOSE_TOOL_WINDOWS else DEFAULT_PURPOSE


def ensure_gateway_tables() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS tool_gateway_consumed (
                nonce TEXT PRIMARY KEY,
                capability_hash TEXT NOT NULL,
                consumed_ts REAL NOT NULL,
                exp INTEGER NOT NULL,
                tool_name TEXT NOT NULL,
                conversation_id TEXT NOT NULL DEFAULT '',
                requested_by TEXT NOT NULL DEFAULT ''
            )"""
        )
        db.execute("CREATE INDEX IF NOT EXISTS tool_gateway_consumed_exp ON tool_gateway_consumed(exp)")


def _consume_capability(capability: str, payload: dict[str, Any]) -> None:
    ensure_gateway_tables()
    nonce = str(payload.get("nonce") or "")
    if not nonce:
        raise PermissionError("gateway_capability_nonce_missing")
    now = time.time()
    with get_db() as db:
        db.execute("DELETE FROM tool_gateway_consumed WHERE exp < ?", (int(now),))
        try:
            db.execute(
                """INSERT INTO tool_gateway_consumed(
                    nonce, capability_hash, consumed_ts, exp, tool_name,
                    conversation_id, requested_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    nonce,
                    _capability_hash(capability),
                    now,
                    int(payload.get("exp") or 0),
                    str(payload.get("tool") or ""),
                    str(payload.get("conversation_id") or ""),
                    str(payload.get("requested_by") or ""),
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise PermissionError("gateway_capability_replay") from exc
        except sqlite3.Error as exc:
            raise PermissionError("gateway_capability_store_failed") from exc


def direct_tool_run_allowed() -> bool:
    """Server-side escape hatch for local debugging only.

    The value must not come from a request payload. Direct API execution is off
    by default so untrusted callers have to use the gateway chain.
    """
    return (
        os.environ.get("AGENT_ALLOW_DIRECT_TOOL_API", "").strip() == "1"
        and os.environ.get("AGENT_ALLOW_DIRECT_TOOL_API_CONFIRM", "").strip() == "I_UNDERSTAND_GATEWAY_BYPASS"
    )


def gateway_required_response() -> dict[str, Any]:
    return {
        "ok": False,
        "decision": "deny",
        "error": "gateway_required",
        "next": ["/api/tools/window", "/api/tools/capability", "/api/tools/gateway-run"],
    }


def _implemented_names() -> set[str]:
    return {tool.name for tool in list_tool_definitions() if tool.status == "implemented" and tool.enabled}


def _safe_tool_dict(tool: ToolDefinition) -> dict[str, Any]:
    data = tool.to_dict()
    data.pop("schema", None)
    return data


def create_tool_window(
    *,
    purpose: str = DEFAULT_PURPOSE,
    requested_tools: list[str] | None = None,
    include_planned: bool = False,
    max_tools: int = DEFAULT_WINDOW_SIZE,
) -> dict[str, Any]:
    selected_purpose = _purpose(purpose)
    # der Nutzer-Vorgabe (2026-06-09): keine globale read-only-Sicherung mehr ueber
    # den Broker. Jeder purpose erhaelt vollen Zugriff auf alle implementierten
    # Tools; der purpose bleibt nur als Audit-Label erhalten und gated nichts mehr.
    allowed = set(_implemented_names()) | set(PURPOSE_TOOL_WINDOWS.get(selected_purpose, ()))
    if requested_tools:
        requested = {str(name).strip() for name in requested_tools if str(name).strip()}
        allowed &= requested
    implemented = _implemented_names()
    tools: list[dict[str, Any]] = []
    denied: list[str] = []
    for definition in list_tool_definitions():
        if definition.name not in allowed:
            continue
        if not include_planned and definition.name not in implemented:
            denied.append(definition.name)
            continue
        tools.append(_safe_tool_dict(definition))
        if len(tools) >= max(1, min(int(max_tools or DEFAULT_WINDOW_SIZE), 24)):
            break
    return {
        "purpose": selected_purpose,
        "tools": tools,
        "count": len(tools),
        "denied_or_planned": denied,
        "window_policy": "task-scoped-tools",
        "capability_required": True,
    }


def mint_capability(
    *,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    purpose: str = DEFAULT_PURPOSE,
    conversation_id: str = "",
    requested_by: str = "agent",
    ttl_seconds: int = 600,
) -> dict[str, Any]:
    definition = get_tool(tool_name)
    if definition is None or not definition.enabled:
        raise PermissionError("gateway_unknown_tool")
    window = create_tool_window(purpose=purpose, requested_tools=[tool_name], include_planned=False, max_tools=1)
    if not any(tool.get("name") == tool_name for tool in window["tools"]):
        raise PermissionError("gateway_tool_not_in_window")
    now = int(time.time())
    ttl = max(1, min(int(ttl_seconds or 600), MAX_CAPABILITY_TTL_SECONDS))
    payload = {
        "v": 1,
        "tool": tool_name,
        "args_hash": _args_hash(arguments or {}),
        "purpose": window["purpose"],
        "conversation_id": conversation_id,
        "requested_by": requested_by,
        "risk": definition.risk,
        "sandbox": definition.sandbox,
        "iat": now,
        "exp": now + ttl,
        "nonce": secrets.token_urlsafe(12),
    }
    body = _b64(_json(payload).encode("utf-8"))
    sig = _b64(hmac.new(_secret_key(), body.encode("ascii"), hashlib.sha256).digest())
    return {
        "capability": f"{body}.{sig}",
        "expires_at": payload["exp"],
        "tool": tool_name,
        "purpose": payload["purpose"],
        "risk": definition.risk,
        "sandbox": definition.sandbox,
    }


def verify_capability(
    *,
    capability: str,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    purpose: str = DEFAULT_PURPOSE,
    conversation_id: str = "",
) -> dict[str, Any]:
    try:
        body, sig = str(capability or "").split(".", 1)
    except ValueError as exc:
        raise PermissionError("gateway_capability_invalid") from exc
    expected = _b64(hmac.new(_secret_key(), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        raise PermissionError("gateway_capability_bad_signature")
    try:
        payload = json.loads(_unb64(body).decode("utf-8"))
    except (ValueError, json.JSONDecodeError) as exc:
        raise PermissionError("gateway_capability_payload_invalid") from exc
    now = int(time.time())
    if int(payload.get("exp") or 0) < now:
        raise PermissionError("gateway_capability_expired")
    if payload.get("tool") != tool_name:
        raise PermissionError("gateway_capability_tool_mismatch")
    if payload.get("args_hash") != _args_hash(arguments or {}):
        raise PermissionError("gateway_capability_args_mismatch")
    if payload.get("purpose") != _purpose(purpose):
        raise PermissionError("gateway_capability_purpose_mismatch")
    expected_conversation = str(payload.get("conversation_id") or "")
    if expected_conversation and expected_conversation != str(conversation_id or ""):
        raise PermissionError("gateway_capability_conversation_mismatch")
    return payload


def execute_with_capability(
    *,
    capability: str,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    purpose: str = DEFAULT_PURPOSE,
    agent: str = "main",
    project: str = "",
    conversation_id: str = "",
    requested_by: str = "agent",
    policy_mode: str = "user-free",
) -> ToolResult:
    payload = verify_capability(
        capability=capability,
        tool_name=tool_name,
        arguments=arguments or {},
        purpose=purpose,
        conversation_id=conversation_id,
    )
    _consume_capability(capability, payload)
    request = ToolRequest(
        name=tool_name,
        arguments=arguments or {},
        agent=agent,
        project=project,
        conversation_id=conversation_id,
        requested_by=str(payload.get("requested_by") or requested_by or "gateway"),
        request_id=f"cap:{payload.get('nonce', '')}",
        policy_mode=policy_mode,
    )
    return execute_tool(request)
