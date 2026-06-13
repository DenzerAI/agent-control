"""Policy layer for the first Tool Broker cut.

Read-only tools may run. Shell runs in a user-free guarded lane: the broker
allows execution, while the executor enforces secret, hidden-path, root and
network-exfil guards. Writes, external sends and admin actions stay behind
approval or deny until they have their own hardened lane.
"""
from __future__ import annotations

from .types import PolicyDecision, ToolDefinition, ToolRequest

ASK_RISKS = {"write", "network", "external", "shell", "admin"}
APPROVABLE_EXECUTION_RISKS = {"write", "network", "external", "shell", "admin"}
SHELL_AUTO_MODES = {"user-free", "guarded", "auto", "yolo"}
NETWORK_AUTO_MODES = {"user-free", "guarded", "auto", "yolo"}
# Full-autonomy lanes: write/external/admin run without approval, audit only.
# Secrets, hidden paths, root and exfil stay blocked by the executor guards.
WRITE_AUTO_MODES = {"user-free", "auto", "yolo"}
# Nur reine Schreib-Tools duerfen ohne Approval auto-laufen. external (mail/whatsapp
# send) und admin bleiben IMMER approval-pflichtig: kein autonomes Outbound.
AUTO_EXECUTION_RISKS = {"write"}
# Hart destruktive Tools bleiben trotz risk=write immer approval-pflichtig. Ein
# verlorenes File ist nicht aus dem Audit-Log rekonstruierbar. memory.write/file.write
# laufen weiter autonom (gewollter Self-Memory-Flow), nur Loeschen braucht Freigabe.
DESTRUCTIVE_TOOLS = {"file.delete"}


def decide(definition: ToolDefinition | None, request: ToolRequest) -> tuple[PolicyDecision, str]:
    if definition is None:
        return "deny", "unknown_tool"
    if not definition.enabled:
        return "deny", "tool_disabled"
    if request.approved:
        if definition.status != "implemented":
            return "deny", "tool_not_implemented"
        if definition.risk in APPROVABLE_EXECUTION_RISKS:
            return "allow", "approved_execution_allowed"
        return "deny", f"{definition.risk}_approved_execution_not_supported"
    if definition.status != "implemented" and definition.risk == "read":
        return "deny", "tool_not_implemented"
    if definition.risk == "read":
        return "allow", "readonly_allowed"
    if definition.risk == "shell" and definition.status == "implemented":
        if str(request.policy_mode or "user-free").strip().lower() in SHELL_AUTO_MODES:
            return "allow", "shell_user_free_guarded"
        return "ask", "shell_requires_approval"
    if definition.name in {"web.fetch", "knowledge.ingest"} and definition.status == "implemented":
        if str(request.policy_mode or "user-free").strip().lower() in NETWORK_AUTO_MODES:
            return "allow", "network_guarded"
        return "ask", "network_requires_approval"
    if definition.risk in ASK_RISKS:
        if (
            definition.status == "implemented"
            and definition.risk in AUTO_EXECUTION_RISKS
            and definition.name not in DESTRUCTIVE_TOOLS
            and str(request.policy_mode or "user-free").strip().lower() in WRITE_AUTO_MODES
        ):
            return "allow", "execution_auto_audit_only"
        if definition.name in DESTRUCTIVE_TOOLS:
            return "ask", "destructive_requires_approval"
        return "ask", f"{definition.risk}_requires_approval"
    return "deny", "unsupported_risk"
