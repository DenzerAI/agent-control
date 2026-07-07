"""Local CLI engine discovery.

The installer writes the detected absolute CLI paths into
``config/engine-runtime.json``. Runtime code still verifies those paths before
use and falls back to a fresh scan, so node/npm updates or moved binaries do not
leave a running installation permanently detached from its engines.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
RUNTIME_CONFIG_PATH = ROOT / "config" / "engine-runtime.json"

ENGINE_PRIORITY = ("claude", "codex", "hermes")
ENV_KEYS = {
    "claude": "AGENT_CONTROL_CLAUDE_CMD",
    "codex": "AGENT_CONTROL_CODEX_CMD",
    "hermes": "AGENT_CONTROL_HERMES_CMD",
}


def engine_search_path() -> str:
    home = Path.home()
    extra = [
        home / ".local" / "bin",
        home / ".claude" / "local",
        home / "bin",
        home / ".npm-global" / "bin",
        home / ".volta" / "bin",
        home / ".bun" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/opt/homebrew/sbin"),
        Path("/usr/local/bin"),
        Path("/usr/bin"),
        Path("/bin"),
    ]
    extra += sorted(home.glob(".nvm/versions/node/*/bin"), reverse=True)
    parts = [os.environ.get("PATH", "")] + [str(p) for p in extra]
    seen: set[str] = set()
    return os.pathsep.join(p for p in parts if p and not (p in seen or seen.add(p)))


def _load_runtime_config() -> dict[str, Any]:
    try:
        data = json.loads(RUNTIME_CONFIG_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _valid_executable(path: str) -> str:
    candidate = Path(path).expanduser()
    if candidate.exists() and os.access(candidate, os.X_OK):
        return str(candidate)
    return ""


def _configured_command(engine: str) -> str:
    env_key = ENV_KEYS.get(engine, "")
    if env_key:
        raw = os.environ.get(env_key, "").strip()
        if raw:
            return raw

    cfg = _load_runtime_config()
    engines = cfg.get("engines") if isinstance(cfg.get("engines"), dict) else {}
    raw = engines.get(engine) if isinstance(engines, dict) else None
    if isinstance(raw, dict):
        return str(raw.get("path") or "").strip()
    if isinstance(raw, str):
        return raw.strip()
    return ""


def scan_engines() -> dict[str, str]:
    found: dict[str, str] = {}
    search = engine_search_path()
    for engine in ENGINE_PRIORITY:
        path = shutil.which(engine, path=search)
        if path:
            found[engine] = path
    return found


def engine_command(engine: str) -> str:
    engine_id = str(engine or "").strip().lower()
    configured = _configured_command(engine_id)
    if configured:
        if os.sep in configured or configured.startswith("~"):
            valid = _valid_executable(configured)
            if valid:
                return valid
        else:
            resolved = shutil.which(configured, path=engine_search_path())
            if resolved:
                return resolved

    found = scan_engines()
    return found.get(engine_id) or engine_id


def runtime_manifest() -> dict[str, Any]:
    found = scan_engines()
    configured = _load_runtime_config()
    selected = str(configured.get("selected") or "").strip().lower()
    if selected not in found:
        selected = next((engine for engine in ENGINE_PRIORITY if engine in found), "")
    return {
        "schema_version": 1,
        "selected": selected,
        "engines": {
            engine: {"path": path, "available": True}
            for engine, path in found.items()
        },
    }


def write_runtime_manifest(path: Path = RUNTIME_CONFIG_PATH) -> dict[str, Any]:
    manifest = runtime_manifest()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest
