"""Static tool catalog for the first Broker cuts.

The catalog is intentionally broader than the currently implemented executors:
Christian wants Agent Control to reach Codex/Claude-Code class capability, but
dangerous actions must become visible before they become executable.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .executors import (
    admin_recipe_list,
    admin_recipe_run,
    agent_capability_matrix,
    agent_deployment_readiness,
    agent_identity,
    agent_install_readiness,
    agent_value_flywheel,
    artifact_list,
    artifact_write,
    browser_click,
    browser_open,
    browser_screenshot,
    browser_type,
    calendar_read,
    calendar_write,
    code_run,
    context_search,
    engine_list,
    engine_switch,
    file_delete,
    file_list,
    file_move,
    file_patch,
    file_read,
    file_search,
    file_write,
    git_add,
    git_branch,
    git_commit,
    git_diff,
    git_show,
    git_status,
    image_generate,
    job_list,
    job_run,
    knowledge_ingest,
    mail_draft,
    mail_send,
    mcp_call,
    mcp_list,
    memory_read,
    memory_search,
    memory_write,
    model_list,
    module_call,
    process_kill,
    secret_classify_path,
    secret_manifest,
    shell_run,
    skill_search,
    tailscale_status,
    voice_speak,
    web_fetch,
    web_search,
    werkbank_task_create,
    whatsapp_draft,
    whatsapp_send,
)
from .types import ToolDefinition, ToolRisk

Executor = Callable[[dict[str, Any]], Any]

IMPLEMENTED_TOOL_NAMES = {
    "admin.recipe.run",
    "admin.recipe.list",
    "agent.capability_matrix",
    "agent.deployment_readiness",
    "agent.identity",
    "agent.install_readiness",
    "agent.value_flywheel",
    "artifact.list",
    "artifact.write",
    "browser.click",
    "browser.open",
    "browser.screenshot",
    "browser.type",
    "calendar.read",
    "calendar.write",
    "code.run",
    "context.search",
    "engine.list",
    "engine.switch",
    "file.delete",
    "file.list",
    "file.move",
    "file.patch",
    "file.read",
    "file.search",
    "file.write",
    "git.add",
    "git.branch",
    "git.commit",
    "git.diff",
    "git.show",
    "git.status",
    "image.generate",
    "job.list",
    "job.run",
    "knowledge.ingest",
    "mail.draft",
    "mail.send",
    "mcp.call",
    "mcp.list",
    "memory.read",
    "memory.search",
    "memory.write",
    "model.list",
    "module.call",
    "process.kill",
    "secret.classify_path",
    "secret.manifest",
    "shell.run",
    "skill.search",
    "tailscale.status",
    "voice.speak",
    "web.fetch",
    "web.search",
    "werkbank.task.create",
    "whatsapp.draft",
    "whatsapp.send",
}


def _schema(properties: dict[str, Any] | None = None, required: tuple[str, ...] = ()) -> dict[str, Any]:
    data: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": properties or {},
    }
    if required:
        data["required"] = list(required)
    return data


def _tool(
    name: str,
    category: str,
    description: str,
    risk: ToolRisk,
    permissions: tuple[str, ...],
    schema: dict[str, Any] | None = None,
    *,
    sandbox: str | None = None,
    status: str = "planned",
) -> ToolDefinition:
    default_sandbox = {
        "read": "broker-readonly",
        "write": "workspace-write",
        "network": "network-limited",
        "external": "human-approved-external",
        "shell": "workspace-shell",
        "admin": "admin-approved",
    }.get(risk, "broker")
    effective_status = "implemented" if name in IMPLEMENTED_TOOL_NAMES else "planned"
    return ToolDefinition(
        name=name,
        category=category,
        description=description,
        risk=risk,
        schema=schema or _schema(),
        permissions=permissions,
        sandbox=sandbox or default_sandbox,
        status=effective_status,
    )


PATH_SCHEMA = _schema(
    {"path": {"type": "string", "minLength": 1}},
    ("path",),
)
PATH_LIMIT_SCHEMA = _schema(
    {
        "path": {"type": "string", "minLength": 1},
        "limit": {"type": "integer", "minimum": 1, "maximum": 500},
    },
    ("path",),
)

TOOLS = (
    _tool("agent.identity", "core", "Read the active agent identity summary.", "read", ("agent:read",), status="implemented"),
    _tool("agent.capability_matrix", "core", "Read the product capability matrix for the perfect customer agent.", "read", ("agent:read",), status="implemented"),
    _tool("agent.deployment_readiness", "core", "Check efficiency, stability, slimness and customer installability as one readiness verdict.", "read", ("agent:read",), status="implemented"),
    _tool("agent.install_readiness", "core", "Check whether the system is slim, stable and customer-installable.", "read", ("agent:read",), status="implemented"),
    _tool("agent.value_flywheel", "core", "Turn local Agent Control advantages into repeatable customer offers and harness loops.", "read", ("agent:read",), status="implemented"),
    _tool("context.search", "core", "Search indexed project and memory context.", "read", ("context:read",), _schema({"query": {"type": "string", "minLength": 1}, "limit": {"type": "integer", "minimum": 1, "maximum": 80}}, ("query",)), status="implemented"),
    _tool("engine.list", "engine", "List known engine profiles and runtime support.", "read", ("engine:read",), status="implemented"),
    _tool("model.list", "engine", "List model profiles exposed to the workspace.", "read", ("engine:read",), status="implemented"),
    _tool("engine.switch", "engine", "Switch a conversation to another runtime engine.", "admin", ("engine:write",), _schema({"engine": {"type": "string", "minLength": 1}}, ("engine",)), status="implemented"),

    _tool("skill.search", "core", "Search local skills (skills/*/SKILL.md) by name, description and triggers to find the documented way to do a task.", "read", ("file:read",), _schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 60}}), status="implemented"),
    _tool("file.list", "filesystem", "List files in a safe project directory.", "read", ("file:read",), PATH_LIMIT_SCHEMA, status="implemented"),
    _tool(
        "file.read",
        "filesystem",
        "Read a non-sensitive file inside the Agent Control project.",
        "read",
        ("file:read",),
        _schema(
            {
                "path": {"type": "string", "minLength": 1},
                "max_bytes": {"type": "integer", "minimum": 1, "maximum": 80000},
            },
            ("path",),
        ),
        status="implemented",
    ),
    _tool("file.search", "filesystem", "Search files with a bounded query.", "read", ("file:read",), _schema({"query": {"type": "string", "minLength": 1}, "path": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 80}}, ("query",)), status="implemented"),
    _tool(
        "file.write",
        "filesystem",
        "Write or replace a workspace file after approval.",
        "write",
        ("file:write",),
        _schema(
            {
                "path": {"type": "string", "minLength": 1},
                "content": {"type": "string"},
            },
            ("path", "content"),
        ),
        status="implemented",
    ),
    _tool(
        "file.patch",
        "filesystem",
        "Apply an approved unified diff to workspace files.",
        "write",
        ("file:write",),
        _schema({"patch": {"type": "string", "minLength": 1}}, ("patch",)),
        status="implemented",
    ),
    _tool("file.move", "filesystem", "Move or rename a workspace file.", "write", ("file:write",), _schema({"source": {"type": "string", "minLength": 1}, "target": {"type": "string", "minLength": 1}, "overwrite": {"type": "boolean"}}, ("source", "target")), status="implemented"),
    _tool("file.delete", "filesystem", "Delete a workspace file.", "write", ("file:delete",), PATH_SCHEMA, status="implemented"),

    _tool("git.status", "git", "Read git status for a workspace.", "read", ("git:read",), _schema({"porcelain": {"type": "boolean"}}), status="implemented"),
    _tool("git.diff", "git", "Read git diffs for review and audit.", "read", ("git:read",), _schema({"path": {"type": "string"}}), status="implemented"),
    _tool("git.show", "git", "Read commit details.", "read", ("git:read",), _schema({"ref": {"type": "string"}}), status="implemented"),
    _tool("git.add", "git", "Stage selected files.", "write", ("git:write",), _schema({"path": {"type": "string"}, "paths": {"type": "array", "items": {"type": "string"}}}), status="implemented"),
    _tool("git.commit", "git", "Create a commit from staged changes.", "write", ("git:write",), _schema({"message": {"type": "string", "minLength": 1}}, ("message",)), status="implemented"),
    _tool("git.branch", "git", "Create or switch branches.", "write", ("git:write",), _schema({"action": {"type": "string"}, "name": {"type": "string"}}), status="implemented"),

    _tool(
        "shell.run",
        "shell",
        "Run a user-free guarded local command without shell expansion, with secret, path, network, timeout and audit guards.",
        "shell",
        ("shell:run",),
        _schema(
            {
                "command": {"type": "string", "minLength": 1},
                "cmd": {"type": "string", "minLength": 1},
                "cwd": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 120},
            },
        ),
        status="implemented",
    ),
    _tool("process.kill", "shell", "Stop a quarantined unsafe engine process after approval.", "admin", ("process:admin",), _schema({"pid": {"type": "integer", "minimum": 2}, "dry_run": {"type": "boolean"}}, ("pid",)), status="implemented"),
    _tool(
        "code.run",
        "code",
        "Run isolated Python/code snippets only when an OS sandbox is available; otherwise return a clear blocker.",
        "shell",
        ("code:run",),
        _schema(
            {
                "language": {"type": "string"},
                "code": {"type": "string", "minLength": 1},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 120},
            },
            ("code",),
        ),
        sandbox="code-isolated",
        status="implemented",
    ),
    _tool("admin.recipe.list", "admin", "List named admin recipes.", "read", ("admin:read",), status="implemented"),
    _tool("admin.recipe.run", "admin", "Run a named admin recipe after explicit approval.", "admin", ("admin:run",), _schema({"name": {"type": "string", "minLength": 1}}, ("name",)), status="implemented"),

    _tool("web.search", "web", "Search the web through the Broker.", "network", ("web:search",), _schema({"query": {"type": "string", "minLength": 1}}, ("query",)), status="implemented"),
    _tool("web.fetch", "web", "Fetch a URL through allowlisted network rules.", "network", ("web:fetch",), _schema({"url": {"type": "string", "minLength": 1}, "max_bytes": {"type": "integer", "minimum": 1, "maximum": 120000}}, ("url",)), status="implemented"),
    _tool(
        "knowledge.ingest",
        "knowledge",
        "Fetch a URL and package it as local Workspace knowledge with source metadata.",
        "network",
        ("knowledge:write",),
        _schema(
            {
                "url": {"type": "string", "minLength": 1},
                "title": {"type": "string"},
                "notes": {"type": "string"},
                "max_bytes": {"type": "integer", "minimum": 1, "maximum": 120000},
            },
            ("url",),
        ),
        sandbox="network-limited-local-write",
        status="implemented",
    ),
    _tool("tailscale.status", "network", "Read local Tailscale status without secrets.", "read", ("network:read",), status="implemented"),
    _tool("browser.open", "browser", "Open a URL in a managed browser session.", "network", ("browser:use",), _schema({"url": {"type": "string", "minLength": 1}}, ("url",)), status="implemented"),
    _tool("browser.click", "browser", "Click in a managed browser session.", "network", ("browser:use",), _schema({"selector": {"type": "string"}}), status="implemented"),
    _tool("browser.type", "browser", "Type into a managed browser session.", "network", ("browser:use",), _schema({"selector": {"type": "string"}, "text": {"type": "string"}}), status="implemented"),
    _tool("browser.screenshot", "browser", "Capture a managed browser screenshot.", "read", ("browser:read",), status="implemented"),

    _tool("mcp.list", "mcp", "List configured MCP servers and tools.", "read", ("mcp:read",), status="implemented"),
    _tool("mcp.call", "mcp", "Call an MCP tool through Broker policy.", "network", ("mcp:call",), _schema({"server": {"type": "string", "minLength": 1}, "tool": {"type": "string", "minLength": 1}, "arguments": {"type": "object"}}, ("server", "tool")), status="implemented"),
    _tool("module.call", "modules", "Call an internal Agent Control module.", "admin", ("module:call",), _schema({"module": {"type": "string", "minLength": 1}, "action": {"type": "string", "minLength": 1}, "arguments": {"type": "object"}}, ("module", "action")), status="implemented"),
    _tool(
        "werkbank.task.create",
        "modules",
        "Bewusster Werkbank-Spawn: legt aus dem aktuellen Chat eine eigene Worker-Session an (kein Stichwort-Trigger, Klaus zieht bewusst).",
        "write",
        ("werkbank:write",),
        _schema(
            {
                "parent_conversation_id": {"type": "string", "minLength": 1},
                "conversation_id": {"type": "string", "minLength": 1},
                "title": {"type": "string"},
                "brief": {"type": "string", "minLength": 1},
                "acceptance": {"type": "string"},
                "notes": {"type": "string"},
                "agent": {"type": "string"},
                "project": {"type": "string"},
                "engine": {"type": "string"},
                "run_background": {"type": "boolean"},
            },
            ("parent_conversation_id", "brief"),
        ),
        status="implemented",
    ),
    _tool("job.list", "jobs", "List local jobs and schedules.", "read", ("job:read",), _schema({"limit": {"type": "integer", "minimum": 1, "maximum": 200}}), status="implemented"),
    _tool("job.run", "jobs", "Run a local job.", "admin", ("job:run",), _schema({"name": {"type": "string", "minLength": 1}}, ("name",)), status="implemented"),

    _tool("artifact.list", "artifacts", "List recent files from work/artifacts.", "read", ("artifact:read",), _schema({"limit": {"type": "integer", "minimum": 1, "maximum": 200}}), status="implemented"),
    _tool("artifact.write", "artifacts", "Write a new generated artifact.", "write", ("artifact:write",), _schema({"name": {"type": "string", "minLength": 1}, "content": {"type": "string"}}, ("name", "content")), status="implemented"),

    _tool("secret.manifest", "secrets", "Read the public Secret Broker manifest without secret values.", "read", ("secret:read",), status="implemented"),
    _tool(
        "secret.classify_path",
        "secrets",
        "Classify whether a path belongs to the protected secret zone.",
        "read",
        ("secret:read",),
        _schema({"path": {"type": "string", "minLength": 1}}, ("path",)),
        status="implemented",
    ),
    _tool("memory.search", "memory", "Search local memory.", "read", ("memory:read",), _schema({"query": {"type": "string", "minLength": 1}, "limit": {"type": "integer", "minimum": 1, "maximum": 80}}, ("query",)), status="implemented"),
    _tool("memory.read", "memory", "Read a local memory document.", "read", ("memory:read",), _schema({"path": {"type": "string", "minLength": 1}, "max_bytes": {"type": "integer", "minimum": 1, "maximum": 80000}}, ("path",)), status="implemented"),
    _tool("memory.write", "memory", "Write a local memory note.", "write", ("memory:write",), _schema({"path": {"type": "string", "minLength": 1}, "content": {"type": "string"}}, ("path", "content")), status="implemented"),

    _tool("mail.draft", "external", "Create a mail draft.", "write", ("mail:draft",), _schema({"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string", "minLength": 1}}, ("body",)), status="implemented"),
    _tool("mail.send", "external", "Send mail after explicit approval.", "external", ("mail:send",), _schema({"draft_id": {"type": "string"}}), status="implemented"),
    _tool("whatsapp.draft", "external", "Create a WhatsApp draft.", "write", ("whatsapp:draft",), _schema({"to": {"type": "string"}, "body": {"type": "string", "minLength": 1}}, ("body",)), status="implemented"),
    _tool("whatsapp.send", "external", "Send WhatsApp after explicit approval.", "external", ("whatsapp:send",), _schema({"draft_id": {"type": "string"}}), status="implemented"),
    _tool("calendar.read", "external", "Read calendar entries.", "read", ("calendar:read",), status="implemented"),
    _tool("calendar.write", "external", "Create or update calendar entries after approval.", "external", ("calendar:write",), _schema({"title": {"type": "string"}}), status="implemented"),
    _tool("voice.speak", "external", "Speak through a configured voice provider.", "external", ("voice:speak",), _schema({"text": {"type": "string"}}), status="implemented"),
    _tool("image.generate", "media", "Generate a raster image through an approved provider.", "network", ("image:generate",), _schema({"prompt": {"type": "string", "minLength": 1}}, ("prompt",)), status="implemented"),
)

TOOL_DEFINITIONS: dict[str, ToolDefinition] = {tool.name: tool for tool in TOOLS}

EXECUTORS: dict[str, Executor] = {
    "admin.recipe.list": admin_recipe_list,
    "admin.recipe.run": admin_recipe_run,
    "agent.capability_matrix": agent_capability_matrix,
    "agent.deployment_readiness": agent_deployment_readiness,
    "agent.identity": agent_identity,
    "agent.install_readiness": agent_install_readiness,
    "agent.value_flywheel": agent_value_flywheel,
    "artifact.list": artifact_list,
    "artifact.write": artifact_write,
    "browser.click": browser_click,
    "browser.open": browser_open,
    "browser.screenshot": browser_screenshot,
    "browser.type": browser_type,
    "calendar.read": calendar_read,
    "calendar.write": calendar_write,
    "code.run": code_run,
    "context.search": context_search,
    "engine.list": engine_list,
    "engine.switch": engine_switch,
    "file.delete": file_delete,
    "file.list": file_list,
    "file.move": file_move,
    "file.patch": file_patch,
    "file.read": file_read,
    "file.search": file_search,
    "file.write": file_write,
    "git.add": git_add,
    "git.branch": git_branch,
    "git.commit": git_commit,
    "git.diff": git_diff,
    "git.show": git_show,
    "git.status": git_status,
    "image.generate": image_generate,
    "job.list": job_list,
    "job.run": job_run,
    "knowledge.ingest": knowledge_ingest,
    "mail.draft": mail_draft,
    "mail.send": mail_send,
    "mcp.call": mcp_call,
    "mcp.list": mcp_list,
    "memory.read": memory_read,
    "memory.search": memory_search,
    "memory.write": memory_write,
    "model.list": model_list,
    "module.call": module_call,
    "process.kill": process_kill,
    "secret.classify_path": secret_classify_path,
    "secret.manifest": secret_manifest,
    "shell.run": shell_run,
    "skill.search": skill_search,
    "tailscale.status": tailscale_status,
    "voice.speak": voice_speak,
    "web.fetch": web_fetch,
    "web.search": web_search,
    "werkbank.task.create": werkbank_task_create,
    "whatsapp.draft": whatsapp_draft,
    "whatsapp.send": whatsapp_send,
}


def get_tool(name: str) -> ToolDefinition | None:
    return TOOL_DEFINITIONS.get(str(name or "").strip())


def list_tool_definitions() -> list[ToolDefinition]:
    return list(TOOL_DEFINITIONS.values())


def get_executor(name: str) -> Executor | None:
    return EXECUTORS.get(str(name or "").strip())
