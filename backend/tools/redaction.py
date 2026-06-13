"""Small redaction helpers for broker audit surfaces.

Two stages run on every audited string:
  1. Secret redaction  — API keys, tokens, private keys, sensitive paths.
  2. PII redaction      — names, phones, IBANs, emails, addresses (Presidio).

Stage 2 is lazy-loaded and fails open: if Presidio is missing or errors,
the secret redaction still applies and the audit write never breaks.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any


REDACTED = "[REDACTED]"
REDACTED_PATH = "[REDACTED_PATH]"
MAX_STRING_LENGTH = 400
_TRUNC_MARKER = re.compile(r"\.\.\.\[truncated:\d+\]$")

SENSITIVE_KEY_MARKERS = (
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "client_secret",
    "cookie",
    "credential",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "token",
)

SENSITIVE_VALUE_PATTERNS = (
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|auth)\s*[:=]\s*\S"),
    re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/-]+=*"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
)

SENSITIVE_PATH_PARTS = (
    ".env",
    ".netrc",
    ".ssh",
    "id_ed25519",
    "id_rsa",
    "known_hosts",
)


def _key_is_sensitive(key: str) -> bool:
    lowered = key.lower()
    return any(marker in lowered for marker in SENSITIVE_KEY_MARKERS)


def _value_is_sensitive(value: str) -> bool:
    lowered = value.lower()
    if any(part in lowered for part in SENSITIVE_PATH_PARTS):
        return True
    return any(pattern.search(value) for pattern in SENSITIVE_VALUE_PATTERNS)


# ---------------------------------------------------------------------------
# PII redaction (Presidio) — second stage, runs after secret checks.
# Lazy-loaded singleton; never raises into the audit write path.
# ---------------------------------------------------------------------------
_logger = logging.getLogger("broker.redaction")

PII_ENABLED = os.environ.get("BROKER_PII_REDACTION", "1") != "0"
PII_MIN_SCORE = 0.35
PII_LANG = "de"
PII_ENTITIES = (
    "PERSON",
    "LOCATION",
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "IBAN_CODE",
    "CREDIT_CARD",
)
_PII_MARKER = {
    "PERSON": "[PERSON]",
    "LOCATION": "[LOCATION]",
    "PHONE_NUMBER": "[PHONE]",
    "EMAIL_ADDRESS": "[EMAIL]",
    "IBAN_CODE": "[IBAN]",
    "CREDIT_CARD": "[CARD]",
}

_analyzer = None
_analyzer_failed = False


def _get_analyzer():
    """Build the Presidio analyzer once. Returns None if unavailable."""
    global _analyzer, _analyzer_failed
    if _analyzer is not None or _analyzer_failed:
        return _analyzer
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider

        cfg = {
            "nlp_engine_name": "spacy",
            "models": [{"lang_code": PII_LANG, "model_name": "de_core_news_sm"}],
        }
        nlp = NlpEngineProvider(nlp_configuration=cfg).create_engine()
        _analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=[PII_LANG])
    except Exception as exc:  # pragma: no cover - defensive
        _analyzer_failed = True
        _logger.warning("PII redaction disabled, Presidio unavailable: %s", exc)
        return None
    return _analyzer


def redact_pii(text: str) -> str:
    """Mask personal data (names, phones, IBANs, emails, addresses)."""
    if not PII_ENABLED or len(text) < 4 or not any(c.isalnum() for c in text):
        return text
    analyzer = _get_analyzer()
    if analyzer is None:
        return text
    try:
        results = analyzer.analyze(text=text, language=PII_LANG, entities=list(PII_ENTITIES))
    except Exception as exc:  # pragma: no cover - defensive
        _logger.warning("PII analyze failed: %s", exc)
        return text
    # Resolve overlaps: first span wins, drop anything starting inside it.
    spans = sorted(
        (r for r in results if r.score >= PII_MIN_SCORE),
        key=lambda r: (r.start, -(r.end - r.start)),
    )
    kept = []
    last_end = -1
    for r in spans:
        if r.start < last_end:
            continue
        kept.append(r)
        last_end = r.end
    for r in reversed(kept):
        marker = _PII_MARKER.get(r.entity_type, "[PII]")
        text = text[: r.start] + marker + text[r.end :]
    return text


def redact_for_audit(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            text_key = str(key)
            if _key_is_sensitive(text_key):
                redacted[text_key] = REDACTED
            else:
                redacted[text_key] = redact_for_audit(item)
        return redacted
    if isinstance(value, list):
        return [redact_for_audit(item) for item in value[:100]]
    if isinstance(value, str):
        if _value_is_sensitive(value):
            return REDACTED_PATH if any(part in value.lower() for part in SENSITIVE_PATH_PARTS) else REDACTED
        value = redact_pii(value)
        if len(value) > MAX_STRING_LENGTH and not _TRUNC_MARKER.search(value):
            return f"{value[:MAX_STRING_LENGTH]}...[truncated:{len(value)}]"
        return value
    return value
