"""Central secret-zone rules for Agent Control.

This module must never read secret file contents. It only classifies paths,
command tokens and public policy metadata.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
USER_ROOT = Path.home().resolve()
TMP_ROOT = Path("/tmp")
SHELL_POLICY_FILE = PROJECT_ROOT / "work" / "agent-control" / "security" / "shell-policy.json"

SECRET_ZONE_MARKERS = {
    ".aws",
    ".claude",
    ".config",
    ".docker",
    ".env",
    ".gnupg",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".ssh",
    "secrets",
    "id_ed25519",
    "id_rsa",
    "known_hosts",
}
SECRET_ZONE_FILENAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".npmrc",
    ".pypirc",
    "id_ed25519",
    "id_rsa",
    "known_hosts",
}
SECRET_ZONE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".p8"}
HIDDEN_PATH_ALLOWLIST = {".", "..", ".agents"}

SHELL_BLOCKED_ROOT_TOKENS = {"sudo", "su"}
SHELL_OPERATORS = {"|", "||", "&", "&&", ";", "<", ">", ">>", "2>", "2>>", "&>", ">&"}
SHELL_NETWORK_COMMANDS = {"curl", "wget", "scp", "rsync", "ssh"}
SHELL_NETWORK_EXFIL_FLAGS = {
    "-d",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "-F",
    "--form",
    "--form-string",
    "-T",
    "--upload-file",
    "--netrc",
    "--config",
}
SHELL_HIDDEN_DIR_DENIES = (
    ".aws",
    ".claude",
    ".config",
    ".docker",
    ".gnupg",
    ".ssh",
)
ALLOWED_SHELL_CWD_ROOTS = (USER_ROOT, TMP_ROOT)
DEFAULT_SHELL_DENIED_COMMAND_MARKERS = (
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "diskutil erase",
    "mkfs",
    "dd if=",
    "dd of=/dev/",
    ":(){ :|:& };:",
)


@dataclass(frozen=True)
class SecretZoneHit:
    code: str
    marker: str
    reason: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


def _classify_part(part: str) -> SecretZoneHit | None:
    lowered = part.lower()
    if lowered in SECRET_ZONE_MARKERS or part in SECRET_ZONE_FILENAMES:
        return SecretZoneHit("secret_marker", part, "Known secret or credential path marker.")
    if lowered.startswith(".") and lowered not in HIDDEN_PATH_ALLOWLIST:
        return SecretZoneHit("hidden_path", part, "Hidden paths are part of the protected zone.")
    suffix = Path(part).suffix.lower()
    if suffix in SECRET_ZONE_SUFFIXES:
        return SecretZoneHit("sensitive_suffix", suffix, "Sensitive key, database or certificate suffix.")
    return None


def path_secret_zone_hits(path: Path | str) -> list[SecretZoneHit]:
    candidate = Path(str(path)).expanduser()
    hits: list[SecretZoneHit] = []
    for part in candidate.parts:
        hit = _classify_part(part)
        if hit:
            hits.append(hit)
    return hits


def has_hidden_or_sensitive_path(path: Path | str) -> bool:
    return bool(path_secret_zone_hits(path))


def token_has_hidden_or_sensitive_path(token: str) -> bool:
    if not token or token in SHELL_OPERATORS or token.startswith("-"):
        return False
    candidates = [token]
    if "=" in token:
        candidates.append(token.split("=", 1)[1])
    for raw in candidates:
        if not raw or raw.startswith(("http://", "https://")):
            continue
        if raw.startswith("@"):
            raw = raw[1:]
        expanded = raw.replace("\\ ", " ")
        if expanded.startswith("~"):
            expanded = str(Path(expanded).expanduser())
        if has_hidden_or_sensitive_path(expanded):
            return True
    return False


def shell_policy() -> dict[str, Any]:
    data: dict[str, Any] = {
        "version": 1,
        "mode": "broad-user-scope",
        "allowed_cwd_roots": [str(path) for path in ALLOWED_SHELL_CWD_ROOTS],
        "allowed_first_commands": [],
        "denied_command_markers": list(DEFAULT_SHELL_DENIED_COMMAND_MARKERS),
    }
    if SHELL_POLICY_FILE.exists():
        try:
            loaded = json.loads(SHELL_POLICY_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            loaded = {}
        if isinstance(loaded, dict):
            data.update(loaded)
    return data


def secret_zone_manifest() -> dict[str, Any]:
    return {
        "version": 1,
        "project_root": str(PROJECT_ROOT),
        "user_root": str(USER_ROOT),
        "allowed_shell_cwd_roots": [str(path) for path in ALLOWED_SHELL_CWD_ROOTS],
        "shell_policy_file": str(SHELL_POLICY_FILE),
        "shell_policy": shell_policy(),
        "markers": sorted(SECRET_ZONE_MARKERS),
        "filenames": sorted(SECRET_ZONE_FILENAMES),
        "suffixes": sorted(SECRET_ZONE_SUFFIXES),
        "hidden_path_allowlist": sorted(HIDDEN_PATH_ALLOWLIST),
        "network_upload_commands": sorted(SHELL_NETWORK_COMMANDS),
        "network_upload_flags": sorted(SHELL_NETWORK_EXFIL_FLAGS),
        "blocked_root_tokens": sorted(SHELL_BLOCKED_ROOT_TOKENS),
    }
