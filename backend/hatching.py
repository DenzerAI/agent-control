"""First-start hatching state for a neutral Agent Control install."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
STATUS_PATH = ROOT / "data" / "hatching.json"
LOCAL_SYSTEM_ROOT = ROOT / "work" / "agent-control"
REQUESTED_SYSTEM_ROOT = Path(os.environ.get("AGENT_CONTROL_SYSTEM_ROOT", "/agent-control"))


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _agent_info() -> dict[str, str]:
    cfg = _read_json(ROOT / "config" / "agents.json", {})
    active = str(cfg.get("active") or "main")
    agents = cfg.get("agents") if isinstance(cfg.get("agents"), dict) else {}
    raw = agents.get(active) if isinstance(agents.get(active), dict) else {}
    owner = cfg.get("owner") if isinstance(cfg.get("owner"), dict) else {}
    return {
        "agent": str(raw.get("name") or "Agent"),
        "owner": str(owner.get("name") or "Owner"),
        "soul": str(raw.get("soul") or "soul/BOOTSTRAP.md"),
    }


def ensure_hatching_state() -> dict[str, Any]:
    """Idempotent: creates the neutral local system anchor and status file."""
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_json(STATUS_PATH, {})
    if existing.get("hatched") and existing.get("system_root"):
        return existing

    info = _agent_info()
    created_at = int(time.time())
    target = REQUESTED_SYSTEM_ROOT
    actual = target
    note = ""
    try:
        target.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        LOCAL_SYSTEM_ROOT.mkdir(parents=True, exist_ok=True)
        actual = LOCAL_SYSTEM_ROOT
        note = f"{target} was not writable without elevated permissions; using local mirror."

    (actual / "README.md").write_text(
        "# Agent Control\n\n"
        "Neutraler System-Anker dieser lokalen Agent-Control-Instanz.\n\n"
        f"- Agent: {info['agent']}\n"
        f"- Owner: {info['owner']}\n"
        f"- Soul: {info['soul']}\n"
        "- Keine Secrets in diesem Ordner.\n",
        encoding="utf-8",
    )
    status = {
        "hatched": True,
        "created_at": created_at,
        "agent": info["agent"],
        "owner": info["owner"],
        "requested_system_root": str(target),
        "system_root": str(actual),
        "note": note,
    }
    STATUS_PATH.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return status
