"""Codex CLI runtime adapter metadata."""
from __future__ import annotations

DEFAULT_CODEX_MODEL = "gpt-5.5"
CODEX_MODELS = frozenset({DEFAULT_CODEX_MODEL})


class CodexCliAdapter:
    id = "codex"
    label = "Codex CLI"
    runtime = True
    default_model = DEFAULT_CODEX_MODEL
    models = CODEX_MODELS

    def normalize_model(self, raw: str | None) -> str:
        model = (raw or "").strip()
        if not model:
            return self.default_model
        lowered = model.lower()
        if lowered.startswith("claude-") or lowered.startswith("opus") or lowered.startswith("sonnet"):
            return self.default_model
        if lowered in ("gpt-5.5",):
            return self.default_model
        return model if model.startswith("gpt-") else self.default_model
