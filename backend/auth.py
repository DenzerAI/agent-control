"""Netzwerk- und Token-Filter für Agent Control HTTP + WebSocket."""
import ipaddress
import json
import os
import secrets
import time
from pathlib import Path

_TRUSTED_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
]


def client_ip_trusted(ip_str: str) -> bool:
    if not ip_str:
        return False
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return any(ip in net for net in _TRUSTED_NETS)


def current_token() -> str:
    return os.environ.get("AGENT_TOKEN", "").strip()


def token_matches(provided: str) -> bool:
    expected = current_token()
    if not expected:
        return True
    return secrets.compare_digest(provided or "", expected)


# ── Deck-Monitor-Tokens ──
# Kurzlebige Vollzugriff-Tokens für gepairte Monitore (Klaus Deck /tv). Ein
# fremder Bildschirm bekommt nach QR-Scan vom authentifizierten Handy ein
# eigenes Token statt des Haupt-Tokens, damit es ablaufen und einzeln
# widerrufen werden kann. Persistiert nach data/monitor_tokens.json, damit ein
# Server-Neustart die gepairten TVs nicht abhängt — das Deck holt von allein auf.
_MONITOR_TTL = 60 * 60 * 12  # 12h
_MONITOR_FILE = Path(__file__).resolve().parent.parent / "data" / "monitor_tokens.json"


def _load_monitor_tokens() -> dict[str, dict]:
    try:
        raw = json.loads(_MONITOR_FILE.read_text())
        now = time.time()
        return {t: e for t, e in raw.items() if isinstance(e, dict) and float(e.get("exp", 0)) > now}
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_monitor_tokens() -> None:
    try:
        _MONITOR_FILE.parent.mkdir(parents=True, exist_ok=True)
        _MONITOR_FILE.write_text(json.dumps(_monitor_tokens))
        os.chmod(_MONITOR_FILE, 0o600)
    except OSError:
        pass


# token -> {exp, name, created, id}. id ist die öffentliche Kennung fürs gezielte
# Trennen (das Token selbst gibt der Server nie ans Frontend, es ist Vollzugriff).
_monitor_tokens: dict[str, dict] = _load_monitor_tokens()


def mint_monitor_token(name: str = "") -> str:
    _prune_monitor_tokens()
    tok = "mon_" + secrets.token_urlsafe(24)
    now = time.time()
    _monitor_tokens[tok] = {
        "exp": now + _MONITOR_TTL,
        "name": (name or "Bildschirm").strip()[:24] or "Bildschirm",
        "created": now,
        "id": secrets.token_hex(4),
        "mode": "chat",
    }
    _save_monitor_tokens()
    return tok


def monitor_token_valid(provided: str) -> bool:
    if not provided or not provided.startswith("mon_"):
        return False
    entry = _monitor_tokens.get(provided)
    if not entry:
        return False
    if time.time() > entry.get("exp", 0):
        _monitor_tokens.pop(provided, None)
        return False
    return True


def list_monitor_tokens() -> list[dict]:
    _prune_monitor_tokens()
    out = [{"id": e["id"], "name": e["name"], "created": e["created"], "mode": e.get("mode", "chat")} for e in _monitor_tokens.values()]
    return sorted(out, key=lambda x: x["created"])


def monitor_mode_for(provided: str) -> str:
    """Modus (chat|fokus) des Monitors zu seinem eigenen Token. Der TV fragt damit
    ab, was er anzeigen soll. Unbekanntes/Haupt-Token bleibt auf 'chat'."""
    entry = _monitor_tokens.get(provided or "")
    return entry.get("mode", "chat") if entry else "chat"


def set_monitor_mode(mid: str, mode: str) -> bool:
    """Modus eines Monitors per öffentlicher id setzen (vom Hauptgerät)."""
    mode = mode if mode in ("chat", "fokus") else "chat"
    for e in _monitor_tokens.values():
        if e.get("id") == mid:
            e["mode"] = mode
            _save_monitor_tokens()
            return True
    return False


def revoke_monitor_token(mid: str) -> bool:
    for tok, e in list(_monitor_tokens.items()):
        if e.get("id") == mid:
            _monitor_tokens.pop(tok, None)
            _save_monitor_tokens()
            return True
    return False


def revoke_monitor_tokens() -> int:
    n = len(_monitor_tokens)
    _monitor_tokens.clear()
    _save_monitor_tokens()
    return n


def _prune_monitor_tokens() -> None:
    now = time.time()
    for t, e in list(_monitor_tokens.items()):
        if now > e.get("exp", 0):
            _monitor_tokens.pop(t, None)
