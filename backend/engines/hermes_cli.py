"""Hermes Agent CLI runtime adapter metadata."""
from __future__ import annotations

DEFAULT_HERMES_PROVIDER = "openai"
DEFAULT_HERMES_MODEL = "gpt-5.5"

HERMES_MODELS = frozenset({
    DEFAULT_HERMES_MODEL,
    "gpt-5.5-pro",
    "gpt-5.4-mini",
    "gemini/gemini-2.5-flash",
    "gemini/gemini-2.5-pro",
    "xai/grok-4",
})


class HermesCliAdapter:
    id = "hermes"
    label = "Hermes Agent"
    runtime = True
    default_model = DEFAULT_HERMES_MODEL
    default_provider = DEFAULT_HERMES_PROVIDER
    models = HERMES_MODELS

    def normalize_model(self, raw: str | None) -> str:
        model = (raw or "").strip()
        return model or self.default_model
