"""Engine registry for configured and runtime-supported engines."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .base import EngineProfile
from .claude_code import ClaudeCodeAdapter
from .codex_cli import CodexCliAdapter
from .hermes_cli import HermesCliAdapter

ROOT = Path(__file__).resolve().parents[2]
SETUP_PROFILES_PATH = ROOT / "config" / "setup-profiles.json"

_RUNTIME_ADAPTERS = {
    "codex": CodexCliAdapter(),
    "claude": ClaudeCodeAdapter(),
    "hermes": HermesCliAdapter(),
}


def _load_setup_profiles() -> dict[str, Any]:
    try:
        return json.loads(SETUP_PROFILES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


@lru_cache(maxsize=1)
def engine_profiles() -> dict[str, EngineProfile]:
    cfg = _load_setup_profiles()
    profiles: dict[str, EngineProfile] = {}
    for raw in cfg.get("engine_profiles") or []:
        engine_id = str(raw.get("id") or "").strip()
        if not engine_id:
            continue
        adapter = _RUNTIME_ADAPTERS.get(engine_id)
        profiles[engine_id] = EngineProfile(
            id=engine_id,
            label=str(raw.get("label") or getattr(adapter, "label", engine_id)),
            kind=str(raw.get("kind") or "manual"),
            provider=str(raw.get("provider") or ""),
            runtime=bool(adapter and adapter.runtime),
            default_model=str(getattr(adapter, "default_model", "")),
            models=frozenset(getattr(adapter, "models", frozenset())),
            setup=raw,
        )

    for engine_id, adapter in _RUNTIME_ADAPTERS.items():
        profiles.setdefault(
            engine_id,
            EngineProfile(
                id=engine_id,
                label=adapter.label,
                kind="cli",
                runtime=True,
                default_model=adapter.default_model,
                models=adapter.models,
            ),
        )
    return profiles


def is_known_engine(engine: str | None) -> bool:
    candidate = str(engine or "").strip().lower()
    return bool(candidate and candidate in engine_profiles())


def is_runtime_engine(engine: str | None) -> bool:
    if not engine:
        return False
    profile = engine_profiles().get(str(engine or "").strip().lower())
    return bool(profile and profile.runtime)


def runtime_engine_ids() -> tuple[str, ...]:
    return tuple(engine_id for engine_id, profile in engine_profiles().items() if profile.runtime)


def normalize_engine(engine: str | None, default: str = "codex", *, runtime_only: bool = True) -> str:
    candidate = _engine_alias(str(engine or "").strip().lower())
    if runtime_only:
        return candidate if is_runtime_engine(candidate) else default
    return candidate if is_known_engine(candidate) else default


def _engine_alias(candidate: str) -> str:
    if candidate in {"gpt", "openai", "codex-cli"} or candidate.startswith("gpt-"):
        return "codex"
    if candidate in {"claude-code"}:
        return "claude"
    if candidate in {"hermes-agent"}:
        return "hermes"
    return candidate


def engine_label(engine: str | None) -> str:
    profile = engine_profiles().get(str(engine or "").strip().lower())
    return profile.label if profile else str(engine or "")


def normalize_model_for_engine(engine: str | None, model: str | None) -> str:
    engine_id = normalize_engine(engine, runtime_only=True)
    adapter = _RUNTIME_ADAPTERS.get(engine_id)
    if adapter:
        return adapter.normalize_model(model)
    return (model or "").strip()


def runtime_models() -> frozenset[str]:
    models: set[str] = {""}
    for adapter in _RUNTIME_ADAPTERS.values():
        models.update(adapter.models)
    return frozenset(models)
