"""Agent identity loader for every LLM engine."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "agents.json"


def _read(path: Path, max_chars: int = 5000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""
    if len(text) > max_chars:
        return text[: max_chars - 1].rstrip() + "…"
    return text


def _resolve(path_value: str | None) -> Path | None:
    if not path_value:
        return None
    raw = str(path_value).strip()
    if raw.startswith("~/") or raw == "~":
        return Path(raw).expanduser()
    p = Path(raw)
    return p if p.is_absolute() else ROOT / p


def _rel(path: Path | None) -> str:
    if not path:
        return ""
    try:
        return str(path.resolve().relative_to(ROOT))
    except Exception:
        return str(path)


def load_identity_config() -> dict[str, Any]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    agents = data.get("agents") if isinstance(data.get("agents"), dict) else {}
    active = str(data.get("active") or "main")
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
    return {"active": active, "agents": agents, "owner": owner}


import os


def get_owner() -> dict[str, str]:
    """Owner-Identitaet (Mensch hinter dem Agenten). Quelle: config/agents.json,
    ueberschreibbar per .env, generischer Fallback fuer namens-neutrale Skelette."""
    cfg = load_identity_config()
    owner = cfg.get("owner") if isinstance(cfg.get("owner"), dict) else {}
    name = os.environ.get("AGENT_OWNER_NAME") or owner.get("name") or "der Inhaber"
    first = os.environ.get("AGENT_OWNER_FIRST_NAME") or owner.get("first_name") or name.split(" ")[0]
    email = os.environ.get("AGENT_OWNER_EMAIL") or owner.get("email") or ""
    return {"name": str(name), "first_name": str(first), "email": str(email)}


def normalize_agent_id(agent_id: str | None) -> str:
    aid = str(agent_id or "").strip() or "main"
    if aid == "claude" or aid.startswith("claude-"):
        return "main"
    return aid


def get_agent_profile(agent_id: str | None = None) -> dict[str, Any]:
    cfg = load_identity_config()
    agents = cfg["agents"]
    aid = normalize_agent_id(agent_id or cfg["active"])
    if aid not in agents:
        aid = cfg["active"] if cfg["active"] in agents else "main"
    raw = dict(agents.get(aid, {}))
    profile = str(raw.get("profile") or aid)
    rules_path = _resolve(raw.get("rules") or f"agents/{profile}/AGENTS.md" if profile != "main" else "AGENTS.md")
    soul_path = _resolve(raw.get("soul") or f"agents/{profile}/SOUL.md" if profile != "main" else "soul/BOOTSTRAP.md")
    return {
        "id": aid,
        "profile": profile,
        "name": raw.get("name") or aid,
        "color": raw.get("color") or "#888",
        "voice": raw.get("voice") or "",
        "workspace": raw.get("workspace") or "",
        "model": raw.get("model") or "",
        "rules_path": rules_path,
        "soul_path": soul_path,
        "rules_rel": _rel(rules_path),
        "soul_rel": _rel(soul_path),
        "rules": _read(rules_path, 2200) if rules_path else "",
        "soul": _read(soul_path, 5200) if soul_path else "",
    }


def get_agent_display(agent_id: str | None = None) -> str:
    return str(get_agent_profile(agent_id).get("name") or normalize_agent_id(agent_id))


def build_identity_context(agent_id: str | None = None, engine: str = "") -> str:
    profile = get_agent_profile(agent_id)
    engine_label = str(engine or "LLM").strip()
    owner_first = get_owner()["first_name"]
    parts = [
        "Agent-Control-Identität:",
        f"Agent: {profile['name']} ({profile['id']})",
        f"Engine: {engine_label}. Die Engine ist Werkzeug, nicht Identität.",
        f"Antworte aus dem Agent-Profil, nicht als Engine. Nenne die Engine nur, wenn {owner_first} ausdrücklich nach Technik fragt.",
        "",
    ]
    if profile["rules"]:
        parts.append(f"[{profile['rules_rel']}]\n{profile['rules']}\n")
    if profile["soul"]:
        parts.append(f"[{profile['soul_rel']}]\n{profile['soul']}\n")
    return "\n".join(parts).strip() + "\n\n"


def public_identity_payload() -> dict[str, Any]:
    cfg = load_identity_config()
    items = []
    for aid in cfg["agents"]:
        profile = get_agent_profile(aid)
        items.append({
            "id": profile["id"],
            "profile": profile["profile"],
            "name": profile["name"],
            "color": profile["color"],
            "rulesPath": profile["rules_rel"],
            "soulPath": profile["soul_rel"],
            "rulesChars": len(profile["rules"]),
            "soulChars": len(profile["soul"]),
        })
    return {"active": normalize_agent_id(cfg["active"]), "agents": items}
