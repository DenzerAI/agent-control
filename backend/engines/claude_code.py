"""Claude Code runtime adapter metadata."""
from __future__ import annotations

DEFAULT_CLAUDE_MODEL = "claude-opus-4-8"
CLAUDE_MODELS = frozenset({"claude-opus-4-8", "claude-fable-5", "claude-opus-4-7", "claude-sonnet-4-6"})


class ClaudeCodeAdapter:
    id = "claude"
    label = "Claude Code"
    runtime = True
    default_model = DEFAULT_CLAUDE_MODEL
    models = CLAUDE_MODELS

    def normalize_model(self, raw: str | None) -> str:
        model = (raw or "").strip()
        return model if model in self.models else self.default_model
