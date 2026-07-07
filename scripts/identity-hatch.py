#!/usr/bin/env python3
"""Set the local Agent Control identity once, idempotently."""
from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "agents.json"
SOUL_PATH = ROOT / "soul" / "BOOTSTRAP.md"


def _load_config() -> dict[str, Any]:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"active": "main", "owner": {"name": "Owner"}, "agents": {"main": {"name": "Agent", "soul": "soul/BOOTSTRAP.md"}}}


def _write_config(cfg: dict[str, Any], agent_name: str, owner_name: str, hatched_at: str) -> None:
    active = str(cfg.get("active") or "main")
    agents = cfg.setdefault("agents", {})
    raw = agents.setdefault(active, {})
    raw["name"] = agent_name
    raw["soul"] = "soul/BOOTSTRAP.md"
    raw["hatched"] = True
    raw["hatched_at"] = hatched_at
    cfg.setdefault("owner", {})["name"] = owner_name
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_soul(agent_name: str, owner_name: str, role: str, tone: str, hatched_at: str) -> None:
    SOUL_PATH.parent.mkdir(parents=True, exist_ok=True)
    SOUL_PATH.write_text(
        f"# {agent_name} Bootstrap\n\n"
        f"Du bist {agent_name}, lokaler Agent für {owner_name}. Die Engine ist nur Werkzeug.\n\n"
        "<!-- HATCHING:START -->\n"
        "## Hatching\n\n"
        f"- **Agent:** {agent_name}\n"
        f"- **Owner:** {owner_name}\n"
        f"- **Rolle:** {role}\n"
        f"- **Ton:** {tone}\n"
        f"- **Gehatcht:** {hatched_at}\n"
        "<!-- HATCHING:END -->\n\n"
        "Deutsch ist Default. Technische Begriffe und Code bleiben englisch.\n\n"
        "Grenzen: Keine externen Sends ohne ausdrückliche Freigabe. Keine Secrets ausgeben.\n\n"
        "Arbeitsweise: Problem verstehen, kurz planen, Ursache lösen, aktiv prüfen, knapp melden.\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--agent-name", default="")
    parser.add_argument("--owner-name", default="")
    parser.add_argument("--role", default="Lokaler Arbeitsagent für Chat, Aufgaben, Suche und Workspace.")
    parser.add_argument("--tone", default="ruhig, direkt, deutsch, ohne Floskeln")
    args = parser.parse_args()

    cfg = _load_config()
    active = str(cfg.get("active") or "main")
    agents = cfg.get("agents") if isinstance(cfg.get("agents"), dict) else {}
    raw = agents.get(active) if isinstance(agents.get(active), dict) else {}
    if args.status:
        print(json.dumps({"hatched": bool(raw.get("hatched")), "agent": raw.get("name", "Agent"), "owner": (cfg.get("owner") or {}).get("name", "Owner")}, ensure_ascii=False))
        return 0
    if raw.get("hatched") and not args.force:
        print("Bereits gehatcht. Nutze --force zum Überschreiben.")
        return 0
    agent_name = args.agent_name or raw.get("name") or "Agent"
    owner_name = args.owner_name or (cfg.get("owner") or {}).get("name") or "Owner"
    hatched_at = date.today().isoformat()
    _write_soul(agent_name, owner_name, args.role, args.tone, hatched_at)
    _write_config(cfg, agent_name, owner_name, hatched_at)
    print(f"Gehatcht: {agent_name} für {owner_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
