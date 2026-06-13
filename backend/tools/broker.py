"""Central Tool Broker entry point."""
from __future__ import annotations

from typing import Any

from .approvals import create_tool_approval
from .audit import log_tool_audit
from .catalog import get_executor, get_tool, list_tool_definitions
from .policy import decide
from .types import ToolDefinition, ToolRequest, ToolResult


def _validate_arguments(definition: ToolDefinition, arguments: dict[str, Any]) -> str:
    schema = definition.schema or {}
    if not isinstance(arguments, dict):
        return "arguments_must_be_object"
    required = schema.get("required") or []
    for key in required:
        if key not in arguments or arguments.get(key) in (None, ""):
            return f"missing_argument:{key}"
    allowed = set((schema.get("properties") or {}).keys())
    if schema.get("additionalProperties") is False:
        extra = sorted(set(arguments.keys()) - allowed)
        if extra:
            return f"unexpected_argument:{extra[0]}"
    return ""


class ToolBroker:
    def list_tools(self) -> list[dict[str, Any]]:
        return [definition.to_dict() for definition in list_tool_definitions()]

    def execute(self, request: ToolRequest) -> ToolResult:
        definition = get_tool(request.name)
        decision, reason = decide(definition, request)
        risk = definition.risk if definition else ""
        sandbox = definition.sandbox if definition else ""
        if decision != "allow":
            output = None
            if decision == "ask" and definition is not None:
                approval_id = create_tool_approval(request, definition, reason)
                output = {"approval_id": approval_id, "status": "pending"}
            audit_id = log_tool_audit(
                agent=request.agent,
                project=request.project,
                conversation_id=request.conversation_id,
                tool_name=request.name,
                decision=decision,
                risk=risk,
                sandbox=sandbox,
                ok=False,
                arguments=request.arguments,
                error=reason,
                output=output,
            )
            return ToolResult(False, request.name, decision, output=output, error=reason, audit_id=audit_id, sandbox=sandbox)

        assert definition is not None
        invalid = _validate_arguments(definition, request.arguments)
        if invalid:
            audit_id = log_tool_audit(
                agent=request.agent,
                project=request.project,
                conversation_id=request.conversation_id,
                tool_name=request.name,
                decision="deny",
                risk=definition.risk,
                sandbox=definition.sandbox,
                ok=False,
                arguments=request.arguments,
                error=invalid,
            )
            return ToolResult(False, request.name, "deny", error=invalid, audit_id=audit_id, sandbox=definition.sandbox)

        executor = get_executor(request.name)
        if not executor:
            audit_id = log_tool_audit(
                agent=request.agent,
                project=request.project,
                conversation_id=request.conversation_id,
                tool_name=request.name,
                decision="deny",
                risk=definition.risk,
                sandbox=definition.sandbox,
                ok=False,
                arguments=request.arguments,
                error="executor_missing",
            )
            return ToolResult(False, request.name, "deny", error="executor_missing", audit_id=audit_id, sandbox=definition.sandbox)

        try:
            output = executor(request.arguments)
            audit_id = log_tool_audit(
                agent=request.agent,
                project=request.project,
                conversation_id=request.conversation_id,
                tool_name=request.name,
                decision="allow",
                risk=definition.risk,
                sandbox=definition.sandbox,
                ok=True,
                arguments=request.arguments,
                output=output,
            )
            return ToolResult(True, request.name, "allow", output=output, audit_id=audit_id, sandbox=definition.sandbox)
        except PermissionError as exc:
            audit_id = log_tool_audit(
                agent=request.agent,
                project=request.project,
                conversation_id=request.conversation_id,
                tool_name=request.name,
                decision="deny",
                risk=definition.risk,
                sandbox=definition.sandbox,
                ok=False,
                arguments=request.arguments,
                error=str(exc),
            )
            return ToolResult(False, request.name, "deny", error=str(exc), audit_id=audit_id, sandbox=definition.sandbox)
        except Exception as exc:
            audit_id = log_tool_audit(
                agent=request.agent,
                project=request.project,
                conversation_id=request.conversation_id,
                tool_name=request.name,
                decision="error",
                risk=definition.risk,
                sandbox=definition.sandbox,
                ok=False,
                arguments=request.arguments,
                error=str(exc),
            )
            return ToolResult(False, request.name, "error", error=str(exc), audit_id=audit_id, sandbox=definition.sandbox)


broker = ToolBroker()


def list_tools() -> list[dict[str, Any]]:
    return broker.list_tools()


def execute_tool(request: ToolRequest) -> ToolResult:
    return broker.execute(request)
