"""Operational readiness for customer-grade Agent Control deployments."""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

from engines.install_readiness import install_readiness_manifest
from engines.process_guard import scan_engine_processes


ROOT = Path(__file__).resolve().parents[2]
BENCHMARK_FILE = ROOT / "work" / "agent-control" / "benchmarks" / "toolbroker-capability-latest.json"
GATEWAY_POLICY_FILE = ROOT / "work" / "agent-control" / "security" / "gateway-policy.json"
NETWORK_POLICY_FILE = ROOT / "work" / "agent-control" / "security" / "network-policy.json"
SHELL_POLICY_FILE = ROOT / "work" / "agent-control" / "security" / "shell-policy.json"


def _json_file(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _git_dirty_count() -> dict[str, Any]:
    completed = subprocess.run(
        ["git", "status", "--short"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
    )
    lines = [line for line in (completed.stdout or "").splitlines() if line.strip()]
    return {
        "return_code": completed.returncode,
        "dirty_count": len(lines),
        "sample": lines[:20],
    }


def deployment_readiness_manifest() -> dict[str, Any]:
    benchmark = _json_file(BENCHMARK_FILE)
    benchmark_summary = benchmark.get("summary") if isinstance(benchmark.get("summary"), dict) else {}
    benchmark_age_seconds = int(time.time()) - int(benchmark.get("ts") or 0) if benchmark.get("ts") else None
    install = install_readiness_manifest()
    process_guard = scan_engine_processes()
    gateway_policy = _json_file(GATEWAY_POLICY_FILE).get("current_state", {})
    network_policy = _json_file(NETWORK_POLICY_FILE)
    shell_policy = _json_file(SHELL_POLICY_FILE)
    git_state = _git_dirty_count()

    dimensions = [
        {
            "id": "efficiency",
            "ok": int(benchmark_summary.get("tools_total") or 0) <= 65
            and int(benchmark_summary.get("tools_total") or 0) == int(benchmark_summary.get("tools_implemented") or -1),
            "label": "Tool-Fläche bleibt klein genug",
            "detail": {
                "tools_total": benchmark_summary.get("tools_total"),
                "tools_implemented": benchmark_summary.get("tools_implemented"),
                "limit": 65,
            },
        },
        {
            "id": "stability",
            "ok": benchmark.get("status") == "pass"
            and benchmark_summary.get("failed") == 0
            and benchmark_summary.get("pending_approvals_after_cleanup") == 0,
            "label": "Benchmark ist grün und räumt Approvals auf",
            "detail": {
                "checks": benchmark_summary.get("checks"),
                "passed": benchmark_summary.get("passed"),
                "failed": benchmark_summary.get("failed"),
                "pending_approvals_after_cleanup": benchmark_summary.get("pending_approvals_after_cleanup"),
                "age_seconds": benchmark_age_seconds,
            },
        },
        {
            "id": "slimness",
            "ok": bool(shell_policy.get("allowed_first_commands"))
            and gateway_policy.get("direct_tool_api_policy") == "blocked_by_default_server_side",
            "label": "Direktwege sind geschlossen, Shell ist allowlisted",
            "detail": {
                "direct_tool_api_policy": gateway_policy.get("direct_tool_api_policy"),
                "allowed_first_commands": len(shell_policy.get("allowed_first_commands") or []),
            },
        },
        {
            "id": "installability",
            "ok": bool(install.get("customer_installable")),
            "label": "Kundeninstallation ist grundsätzlich bereit",
            "detail": {
                "install_status": install.get("status"),
                "failed": install.get("score", {}).get("failed"),
                "install_command": install.get("install_command"),
            },
        },
        {
            "id": "safety",
            "ok": process_guard.get("unsafe_count") == 0
            and network_policy.get("allow_private_networks") is False
            and network_policy.get("allow_tailnet") is False,
            "label": "Keine unsicheren Engine-Prozesse, Netzwerk eng",
            "detail": {
                "unsafe_processes": process_guard.get("unsafe_count"),
                "allow_private_networks": network_policy.get("allow_private_networks"),
                "allow_tailnet": network_policy.get("allow_tailnet"),
            },
        },
        {
            "id": "release_hygiene",
            "ok": git_state.get("return_code") == 0,
            "label": "Git-Stand ist lesbar; Dirty-State ist Entwicklungsnotiz, kein Runtime-Blocker",
            "detail": git_state,
        },
    ]
    failed = [item for item in dimensions if not item["ok"]]
    return {
        "status": "ready" if not failed else "needs_attention",
        "customer_installable": bool(install.get("customer_installable")) and not any(item["id"] in {"stability", "safety"} for item in failed),
        "score": {"passed": len(dimensions) - len(failed), "total": len(dimensions), "failed": len(failed)},
        "dimensions": dimensions,
        "next_missing": [item["id"] for item in failed],
        "next_build_order": [
            "customer_memory_namespace",
            "browser_autocapture_proposals",
            "release_package_manifest",
        ],
        "verify_command": "python3 scripts/agent-control-capability-benchmark.py",
    }
