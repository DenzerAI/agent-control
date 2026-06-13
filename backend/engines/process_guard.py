"""Runtime process guard for engine subprocesses.

The guard is deliberately read-only. It classifies risky engine processes so
Christian can approve cleanup instead of letting an agent kill processes
silently.
"""
from __future__ import annotations

import os
import subprocess
from typing import Any


DANGEROUS_ENGINE_MARKERS = (
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-skip-permissions",
    "--permission-mode bypassPermissions",
)

ENGINE_MARKERS = (
    "codex exec",
    "claude -p",
)

KNOWN_SERVICE_MARKERS = (
    "uvicorn server:app",
    "_local/whatsapp-web/sync.js",
    "work/fch/ops-app/server/index.mjs",
)


def classify_process_command(command: str) -> dict[str, Any]:
    text = str(command or "")
    dangerous = [marker for marker in DANGEROUS_ENGINE_MARKERS if marker in text]
    engine = next((marker for marker in ENGINE_MARKERS if marker in text), "")
    service = next((marker for marker in KNOWN_SERVICE_MARKERS if marker in text), "")
    return {
        "engine": engine,
        "service": service,
        "dangerous_markers": dangerous,
        "unsafe": bool(engine and dangerous),
    }


def scan_engine_processes() -> dict[str, Any]:
    completed = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,stat=,etime=,command="],
        text=True,
        capture_output=True,
        timeout=8,
    )
    raw_items: list[dict[str, Any]] = []
    parent_by_pid: dict[int, int] = {}
    own_pid = os.getpid()
    for line in (completed.stdout or "").splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) < 5:
            continue
        pid_text, ppid_text, stat, etime, command = parts
        try:
            pid = int(pid_text)
            ppid = int(ppid_text)
        except ValueError:
            continue
        parent_by_pid[pid] = ppid
        raw_items.append(
            {
                "pid": pid,
                "ppid": ppid,
                "stat": stat,
                "etime": etime,
                "command": command[:500],
            }
        )
    active_chain: set[int] = set()
    cursor = own_pid
    while cursor and cursor not in active_chain:
        active_chain.add(cursor)
        cursor = parent_by_pid.get(cursor, 0)

    processes: list[dict[str, Any]] = []
    unsafe: list[dict[str, Any]] = []
    active_session_unsafe: list[dict[str, Any]] = []
    services: list[dict[str, Any]] = []
    for item in raw_items:
        pid = int(item["pid"])
        command = str(item["command"])
        classified = classify_process_command(command)
        if classified["engine"]:
            item |= classified
            processes.append(item)
            if classified["unsafe"] and pid in active_chain:
                active_session_unsafe.append(item)
            elif classified["unsafe"]:
                unsafe.append(item)
        elif classified["service"]:
            item |= classified
            services.append(item)
    return {
        "status": "warn" if unsafe else "ok",
        "unsafe_count": len(unsafe),
        "active_session_unsafe_count": len(active_session_unsafe),
        "engine_count": len(processes),
        "service_count": len(services),
        "unsafe": unsafe[:20],
        "active_session_unsafe": active_session_unsafe[:20],
        "services": services[:20],
        "policy": "detect_only_human_cleanup_required",
    }
