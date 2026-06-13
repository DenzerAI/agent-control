"""Shared engine adapter types.

This is the thin contract Agent Control owns. Individual providers can be CLI,
API, or local model hosts, but the rest of the app should only care about the
stable engine id, model normalization, and whether the engine is wired for live
chat execution yet.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

EngineKind = Literal["cli", "api", "local", "manual"]


@dataclass(frozen=True)
class EngineProfile:
    id: str
    label: str
    kind: EngineKind | str = "manual"
    provider: str = ""
    runtime: bool = False
    default_model: str = ""
    models: frozenset[str] = field(default_factory=frozenset)
    setup: dict[str, Any] = field(default_factory=dict)


class EngineAdapter(Protocol):
    id: str
    label: str
    runtime: bool
    default_model: str
    models: frozenset[str]

    def normalize_model(self, raw: str | None) -> str:
        ...
