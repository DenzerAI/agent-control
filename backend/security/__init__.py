"""Agent Control security primitives."""

from .secret_zones import (
    ALLOWED_SHELL_CWD_ROOTS,
    SECRET_ZONE_FILENAMES,
    SECRET_ZONE_MARKERS,
    SECRET_ZONE_SUFFIXES,
    SHELL_BLOCKED_ROOT_TOKENS,
    SHELL_HIDDEN_DIR_DENIES,
    SHELL_NETWORK_COMMANDS,
    SHELL_NETWORK_EXFIL_FLAGS,
    SHELL_OPERATORS,
    SecretZoneHit,
    has_hidden_or_sensitive_path,
    secret_zone_manifest,
    token_has_hidden_or_sensitive_path,
)

__all__ = [
    "ALLOWED_SHELL_CWD_ROOTS",
    "SECRET_ZONE_FILENAMES",
    "SECRET_ZONE_MARKERS",
    "SECRET_ZONE_SUFFIXES",
    "SHELL_BLOCKED_ROOT_TOKENS",
    "SHELL_HIDDEN_DIR_DENIES",
    "SHELL_NETWORK_COMMANDS",
    "SHELL_NETWORK_EXFIL_FLAGS",
    "SHELL_OPERATORS",
    "SecretZoneHit",
    "has_hidden_or_sensitive_path",
    "secret_zone_manifest",
    "token_has_hidden_or_sensitive_path",
]
