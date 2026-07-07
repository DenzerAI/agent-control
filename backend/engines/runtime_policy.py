"""Engine-agnostic runtime policy for Agent Control harnesses."""
from __future__ import annotations

import os
import json
from pathlib import Path
from typing import Any

from .discovery import engine_command

ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = ROOT / "work" / "agent-control" / "security" / "runtime-policy.json"
DEFAULT_BROKER_CLIENT = "python3 scripts/agent-control-tool.py"
DEFAULT_SAFE_CLAUDE_TOOLS = "Bash"
DEFAULT_SAFE_CLAUDE_ALLOWED_TOOLS = (
    "Bash(python3 scripts/agent-control-tool.py *)"
)
DEFAULT_NATIVE_CLAUDE_PERMISSION_MODE = "bypassPermissions"
DEFAULT_NATIVE_CODEX_SANDBOX = "danger-full-access"
ALLOWED_CODEX_SANDBOXES = {"read-only", "workspace-write", "danger-full-access"}


def _policy() -> dict[str, Any]:
    try:
        data = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def engine_safety_mode() -> str:
    mode = os.environ.get("AGENT_ENGINE_SAFETY_MODE", "native").strip().lower()
    if mode == "direct":
        if os.environ.get("AGENT_ENGINE_ALLOW_DIRECT", "").strip() == "1":
            return "direct"
        return "broker"
    if mode == "broker":
        return "broker"
    return "native"


def codex_sandbox() -> str:
    codex_policy = (_policy().get("codex") or {})
    key = "broker_sandbox" if engine_safety_mode() == "broker" else "native_sandbox"
    fallback = "workspace-write" if engine_safety_mode() == "broker" else DEFAULT_NATIVE_CODEX_SANDBOX
    configured = (codex_policy.get(key) or fallback)
    candidate = os.environ.get("AGENT_CODEX_SANDBOX", str(configured)).strip() or fallback
    return candidate if candidate in ALLOWED_CODEX_SANDBOXES else fallback


def _env_bool(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def codex_network_access_default() -> bool:
    configured = _env_bool("AGENT_CODEX_NETWORK_ACCESS")
    if configured is not None:
        return configured
    if codex_sandbox() == "danger-full-access":
        return True
    codex_policy = (_policy().get("codex") or {})
    return bool(codex_policy.get("native_network_access", False))


def broker_client() -> str:
    return DEFAULT_BROKER_CLIENT


def claude_broker_tools() -> str:
    return DEFAULT_SAFE_CLAUDE_TOOLS


def claude_allowed_tools() -> str:
    return DEFAULT_SAFE_CLAUDE_ALLOWED_TOOLS


def claude_native_permission_mode() -> str:
    configured = ((_policy().get("claude") or {}).get("native_permission_mode") or DEFAULT_NATIVE_CLAUDE_PERMISSION_MODE)
    candidate = os.environ.get("AGENT_CLAUDE_PERMISSION_MODE", str(configured)).strip() or DEFAULT_NATIVE_CLAUDE_PERMISSION_MODE
    return candidate if candidate in {"acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"} else DEFAULT_NATIVE_CLAUDE_PERMISSION_MODE


def broker_tool_context(conv_id: str, project: str) -> str:
    conversation = conv_id or "chat"
    project_id = project or "agent-control"
    client = broker_client()
    try:
        from identity import get_owner
    except ImportError:
        from backend.identity import get_owner
    owner_first = get_owner()["first_name"]
    if engine_safety_mode() == "native":
        return (
            "\n\nAgent-Control-Werkzeugregel:\n"
            "- Diese Regel betrifft die Ausfuehrung innerhalb eines sichtbaren Werkbank-Laufs, nicht die Uebergabe-Entscheidung im Hauptchat.\n"
            "- Im Hauptchat bleibt Klaus in der Planphase: werkbankfaehige Arbeit wird als Werkbank-Prompt formuliert und sichtbar uebergeben.\n"
            "- Im Werkbank-Lauf nutzt die Engine ihre nativen CLI-Werkzeuge frei fuer normale Projektarbeit; keine Broker-Whitelist fuer Lesen, Schreiben, Build, Test oder Deploy.\n"
            "- Der Stream protokolliert sichtbare Tool-Calls, Laufzeit, Tokens und Datei-Diffs fuer die Werkbank/Audit-Spur.\n"
            "- Nutze den Broker nur fuer brokerpflichtige Tools, externe Sends, Admin-Aktionen oder wenn der Nutzer es ausdruecklich verlangt.\n"
            f"- Broker-Fallback: `{client} run --purpose inspect --tool git.status --args '{{}}' "
            f"--conversation-id {conversation} --project {project_id}`.\n"
            "- Wenn der Broker kurz nicht verfuegbar ist, blockiere nicht minutenlang: nutze lokale Read/Build-Tools weiter und melde den Broker-Ausfall knapp.\n"
            "- Keine Secrets ausgeben; sensible Dateien, externe Sends und Admin-Aktionen bleiben kontrollpflichtig.\n"
        )
    return (
        "\n\nAgent-Control-Werkzeugregel:\n"
        "- Nutze für lokale Werkzeuge zuerst die Broker-Kette, nicht direkte Schreib-/Shell-Rechte.\n"
        f"- Der CLI-Client dafür ist `{client}`.\n"
        f"- Sichtbare Werkzeuge: `{client} window --purpose inspect`.\n"
        f"- Ein Lauf: `{client} run --purpose inspect --tool git.status --args '{{}}' "
        f"--conversation-id {conversation} --project {project_id}`.\n"
        f"- Schreibende Aktionen dürfen als Broker-Approval enden; dann erkläre {owner_first} kurz, was freigegeben werden muss.\n"
        "- Direkte Engine-Tools sind nur zum Lesen, Prüfen und für diesen Broker-Client gedacht.\n"
    )


def build_codex_exec_cmd(*, model: str, cwd: str, effort: str = "", session_id: str = "", network_access: bool = False) -> list[str]:
    mode = engine_safety_mode()
    cmd = [engine_command("codex"), "exec", "--json", "--model", model, "--skip-git-repo-check", "-C", cwd]
    if mode == "direct":
        cmd.append("--dangerously-bypass-approvals-and-sandbox")
    else:
        # Native/Broker-Pfad: Freigabe-Politik explizit auf "never". Ohne das fragt Codex
        # bei einer von der Sandbox geblockten Aktion im Hintergrund-Modus nach einer
        # Freigabe, die es per stdin nie bekommt, und haengt dann still bis zum Timeout
        # (35-Min-Toede). "never" gibt den Fehler sofort ans Modell zurueck, statt zu warten.
        sandbox = codex_sandbox()
        cmd.extend(["--sandbox", sandbox, "-c", "approval_policy=never"])
        if sandbox == "workspace-write" and (network_access or codex_network_access_default()):
            cmd.extend(["-c", "sandbox_workspace_write.network_access=true"])
    if effort:
        cmd.extend(["-c", f"model_reasoning_effort={effort}"])
    if session_id:
        cmd.extend(["resume", session_id, "-"])
    else:
        cmd.append("-")
    return cmd


def build_claude_print_cmd(*, model: str, effort: str = "", session_id: str = "", new_session_id: str = "") -> list[str]:
    cmd = [
        engine_command("claude"), "-p", "--model", model, "--verbose",
        "--output-format", "stream-json", "--include-partial-messages",
    ]
    if engine_safety_mode() == "direct":
        cmd.extend(["--tools", "default", "--dangerously-skip-permissions"])
    elif engine_safety_mode() == "native":
        cmd.extend(["--tools", "default", "--permission-mode", claude_native_permission_mode()])
    else:
        cmd.extend(["--tools", claude_broker_tools(), "--allowedTools", claude_allowed_tools()])
    if session_id:
        cmd.extend(["--resume", session_id])
    elif new_session_id:
        cmd.extend(["--session-id", new_session_id])
    if effort:
        cmd.extend(["--effort", effort])
    return cmd


def build_hermes_exec_cmd(*, prompt: str, model: str = "", provider: str = "", cwd: str = "") -> list[str]:
    """Headless Hermes oneshot command.

    ``model`` may be plain or ``provider/model``. ``cwd`` is accepted for the
    shared call shape; the caller applies it as subprocess working directory.
    """
    from .hermes_cli import DEFAULT_HERMES_MODEL, DEFAULT_HERMES_PROVIDER

    model = (model or "").strip() or DEFAULT_HERMES_MODEL
    provider = (provider or "").strip()
    if not provider and "/" in model:
        provider, model = model.split("/", 1)
    provider = provider or DEFAULT_HERMES_PROVIDER
    return [engine_command("hermes"), "-z", prompt, "-m", model, "--provider", provider, "--yolo"]


def runtime_policy_manifest() -> dict[str, Any]:
    mode = engine_safety_mode()
    return {
        "mode": mode,
        "policy_path": str(POLICY_PATH.relative_to(ROOT)),
        "policy_file_is_documentation": True,
        "sandbox_strategy": "native_cli_full_tools_broker_only_for_special_cases",
        "sandbox_exec_required": False,
        "broker_client": broker_client(),
        "native_mode_env": "AGENT_ENGINE_SAFETY_MODE=native (default)",
        "broker_mode_env": "AGENT_ENGINE_SAFETY_MODE=broker",
        "direct_mode_env": "AGENT_ENGINE_SAFETY_MODE=direct + AGENT_ENGINE_ALLOW_DIRECT=1",
        "codex": {
            "sandbox": "danger-full-access" if mode == "direct" else codex_sandbox(),
            "network_access_default": codex_network_access_default(),
            "direct_skip_permissions": mode == "direct",
            "native_tools": mode == "native",
        },
        "claude": {
            "tools": "default" if mode in {"direct", "native"} else claude_broker_tools(),
            "allowed_tools": "" if mode in {"direct", "native"} else claude_allowed_tools(),
            "permission_mode": claude_native_permission_mode() if mode == "native" else "",
            "direct_skip_permissions": mode == "direct",
        },
        "hermes": {
            "cmd": engine_command("hermes"),
            "runtime": True,
        },
    }
