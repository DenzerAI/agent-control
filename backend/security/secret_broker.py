"""Secret Broker facade.

The broker exposes only public classification and redaction helpers. It does
not return secret values. Future connectors should ask this broker to perform
actions with handles instead of reading tokens into the agent context.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .secret_zones import path_secret_zone_hits, secret_zone_manifest

_TOKEN_SHAPES = [
    re.compile(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)(api[_-]?key\s*[=:]\s*)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)(token\s*[=:]\s*)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)(password\s*[=:]\s*)[^\\s]{4,}"),
]


class SecretBroker:
    """Read-free secret policy surface."""

    def manifest(self) -> dict[str, Any]:
        return secret_zone_manifest()

    def classify_path(self, path: str | Path) -> dict[str, Any]:
        hits = path_secret_zone_hits(path)
        return {
            "path": str(path),
            "protected": bool(hits),
            "hits": [hit.to_dict() for hit in hits],
        }

    def redact_text(self, text: str) -> str:
        redacted = str(text or "")
        for pattern in _TOKEN_SHAPES:
            redacted = pattern.sub(lambda match: f"{match.group(1)}[REDACTED]", redacted)
        return redacted


secret_broker = SecretBroker()
