"""Install readiness checks for customer deployments."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]

REQUIRED_FILES = (
    "AGENTS.md",
    "soul/BOOTSTRAP.md",
    "soul/IDENTITY.md",
    "backend/server.py",
    "backend/tools/catalog.py",
    "backend/tools/gateway.py",
    "backend/tools/executors.py",
    "backend/engines/runtime_policy.py",
    "backend/engines/process_guard.py",
    "backend/engines/install_readiness.py",
    "backend/engines/deployment_readiness.py",
    "scripts/agent-control-tool.py",
    "scripts/agent-control-capability-benchmark.py",
    "work/agent-control/security/gateway-policy.json",
    "work/agent-control/security/runtime-policy.json",
    "work/agent-control/security/network-policy.json",
    "work/agent-control/security/shell-policy.json",
)

REQUIRED_DIRS = (
    "agents",
    "backend",
    "config",
    "data",
    "jobs",
    "scripts",
    "work/agent-control/security",
    "work/agent-control/knowledge",
    "work/artifacts",
)

REQUIRED_COMMANDS = ("python3", "git", "rg")


def _json_file(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def install_readiness_manifest() -> dict[str, Any]:
    missing_files = [item for item in REQUIRED_FILES if not (ROOT / item).is_file()]
    missing_dirs = [item for item in REQUIRED_DIRS if not (ROOT / item).is_dir()]
    missing_commands = [cmd for cmd in REQUIRED_COMMANDS if not shutil.which(cmd)]
    gateway_policy = _json_file(ROOT / "work" / "agent-control" / "security" / "gateway-policy.json")
    runtime_policy = _json_file(ROOT / "work" / "agent-control" / "security" / "runtime-policy.json")
    network_policy = _json_file(ROOT / "work" / "agent-control" / "security" / "network-policy.json")
    shell_policy = _json_file(ROOT / "work" / "agent-control" / "security" / "shell-policy.json")

    checks = [
        {
            "id": "files",
            "ok": not missing_files and not missing_dirs,
            "label": "Kern-Dateien und Ordner vorhanden",
            "detail": {"missing_files": missing_files, "missing_dirs": missing_dirs},
        },
        {
            "id": "commands",
            "ok": not missing_commands,
            "label": "Lokale Basis-Kommandos vorhanden",
            "detail": {"missing_commands": missing_commands},
        },
        {
            "id": "gateway",
            "ok": gateway_policy.get("current_state", {}).get("direct_tool_api_policy") == "blocked_by_default_server_side",
            "label": "Direkte Tool-API ist standardmäßig geschlossen",
            "detail": {"policy": gateway_policy.get("current_state", {}).get("direct_tool_api_policy", "")},
        },
        {
            "id": "runtime",
            "ok": runtime_policy.get("default_mode") == "native"
            and runtime_policy.get("sandbox_exec_required") is False,
            "label": "Engines starten nativ mit lokalen Guard-Regeln",
            "detail": {
                "default_mode": runtime_policy.get("default_mode", ""),
                "sandbox_exec_required": runtime_policy.get("sandbox_exec_required"),
            },
        },
        {
            "id": "network",
            "ok": network_policy.get("allow_private_networks") is False and network_policy.get("allow_tailnet") is False,
            "label": "Netzwerk ist kundenseitig eng voreingestellt",
            "detail": {
                "allow_private_networks": network_policy.get("allow_private_networks"),
                "allow_tailnet": network_policy.get("allow_tailnet"),
            },
        },
        {
            "id": "shell",
            "ok": bool(shell_policy.get("allowed_first_commands")),
            "label": "Shell hat Allowlist statt Vollzugriff",
            "detail": {"allowed_first_commands": len(shell_policy.get("allowed_first_commands") or [])},
        },
        {
            "id": "secrets",
            "ok": (ROOT / ".env.example").is_file() and not (ROOT / ".env").is_symlink(),
            "label": "Secrets bleiben lokal und werden nicht als Link verteilt",
            "detail": {"env_example": (ROOT / ".env.example").is_file(), "env_is_symlink": (ROOT / ".env").is_symlink()},
        },
    ]
    failed = [check for check in checks if not check["ok"]]
    return {
        "status": "ready" if not failed else "needs_attention",
        "score": {"passed": len(checks) - len(failed), "total": len(checks), "failed": len(failed)},
        "checks": checks,
        "customer_installable": not failed,
        "next_missing": [check["id"] for check in failed],
        "install_command": "scripts/install-agent-control.sh",
        "verify_command": "python3 scripts/agent-control-capability-benchmark.py",
    }
