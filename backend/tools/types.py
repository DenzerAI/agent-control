"""Shared types for the Agent Control Tool Broker."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ToolRisk = Literal["read", "write", "network", "external", "shell", "admin"]
PolicyDecision = Literal["allow", "ask", "deny"]


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    category: str
    description: str
    risk: ToolRisk
    schema: dict[str, Any]
    permissions: tuple[str, ...] = ()
    sandbox: str = "broker-readonly"
    status: str = "planned"
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["permissions"] = list(self.permissions)
        return data


@dataclass(frozen=True)
class ToolRequest:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    agent: str = "main"
    project: str = ""
    conversation_id: str = ""
    requested_by: str = "agent"
    request_id: str = ""
    policy_mode: str = "user-free"
    approved: bool = False
    approval_id: int | None = None


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    name: str
    decision: PolicyDecision
    output: Any = None
    error: str = ""
    audit_id: int | None = None
    sandbox: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
