"""Fix-Queue für offene App-Stabilitätsfälle.

Der app-perf-check-Puls misst nur und postet. Er repariert nichts. Damit ein
offener Fall nicht im Chat versandet, sondern tatsächlich abgearbeitet wird,
legt der Puls ihn hier ab. Ein eigener Fix-Job (jobs/systemcheck-fix) zieht den
ältesten offenen Fall, untersucht die Ursache, behebt klare
Funktionserhalt-Themen und meldet Fix plus echte Gegenmessung. Erst dann fällt
der Fall raus.

Eine schlichte JSON-Datei, lokal, eine Wahrheit. Puls (Server-Prozess) und
Fix-Job (eigener Prozess) kommen beide ohne Ceremony dran.

Form:
    {
      "open": [
        {
          "signature": "abc123",     # stabile Signatur des Befund-Sets
          "findings": ["mobile: langsame Route ... Ø 828 ms"],
          "opened_at": 1733570000,
          "updated_at": 1733570000,
          "last_seen_at": 1733570000,
          "seen_count": 3,
          "status": "open"           # open | picked
        }
      ],
      "history": [ ... letzte geschlossene Fälle, gekappt ... ]
    }
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[2]
_QUEUE_PATH = _ROOT / "config" / "systemcheck-fix-queue.json"
_HISTORY_CAP = 30


def _empty() -> dict[str, Any]:
    return {"open": [], "history": []}


def _load() -> dict[str, Any]:
    try:
        data = json.loads(_QUEUE_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _empty()
        data.setdefault("open", [])
        data.setdefault("history", [])
        if not isinstance(data["open"], list):
            data["open"] = []
        if not isinstance(data["history"], list):
            data["history"] = []
        return data
    except FileNotFoundError:
        return _empty()
    except Exception:
        return _empty()


def _save(data: dict[str, Any]) -> None:
    _QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(_QUEUE_PATH.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, _QUEUE_PATH)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except Exception:
                pass


def list_open() -> list[dict[str, Any]]:
    """Offene Fälle, ältester zuerst."""
    return list(_load().get("open") or [])


def upsert(signature: str, findings: list[str]) -> dict[str, Any]:
    """Legt einen offenen Fall an oder frischt einen bestehenden auf.

    Idempotent über die Signatur: derselbe Befund öffnet keinen zweiten Fall,
    er erhöht nur seen_count und last_seen_at.
    """
    data = _load()
    now = int(time.time())
    for entry in data["open"]:
        if entry.get("signature") == signature:
            entry["findings"] = findings
            entry["updated_at"] = now
            entry["last_seen_at"] = now
            entry["seen_count"] = int(entry.get("seen_count") or 0) + 1
            _save(data)
            return entry
    entry = {
        "signature": signature,
        "findings": findings,
        "opened_at": now,
        "updated_at": now,
        "last_seen_at": now,
        "seen_count": 1,
        "status": "open",
    }
    data["open"].append(entry)
    _save(data)
    return entry


def resolve(signature: str, reason: str, *, resolved_by: str = "") -> bool:
    """Schließt einen offenen Fall und schiebt ihn in die History."""
    data = _load()
    remaining = []
    closed = None
    for entry in data["open"]:
        if entry.get("signature") == signature and closed is None:
            closed = dict(entry)
        else:
            remaining.append(entry)
    if closed is None:
        return False
    closed["status"] = "resolved"
    closed["resolved_at"] = int(time.time())
    closed["resolve_reason"] = reason
    closed["resolved_by"] = resolved_by
    data["open"] = remaining
    data["history"] = ([closed] + list(data.get("history") or []))[:_HISTORY_CAP]
    _save(data)
    return True
