"""Versand-Queue für freigegebene Pioniere-Posts.

Christians Regel: Freigabe und Versand sind getrennt. Wenn Christian einen
Entwurf freigibt, geht er NICHT sofort live, sondern landet hier in einer
Warteschlange. Ein eigener Versand-Job (scripts/pioniere-dispatch.py) nimmt
daraus getaktet (alle zwei Tage) den ältesten Eintrag und veröffentlicht ihn.

Die Queue ist eine schlichte JSON-Datei, lokal, eine Wahrheit. Kein DB-Zwang,
damit der Versand-Job und das Backend beide ohne Ceremony drankommen.

Form:
    {
      "queue": [
        {
          "id": "...",            # stabiler Eintrags-Key (run_id:idx)
          "run_id": "...",        # Ursprungs-Workflow-Run
          "idx": 0,               # Entwurf-Index im Run
          "title": "...",
          "ref": "A3F9",
          "body": "...",
          "ping": "...",
          "kind": "hint",
          "source_note": "...",
          "queued_at": 1733570000 # Unix-Sekunden der Freigabe
        }
      ],
      "last_dispatch": "2026-06-07" # Datum des letzten Auto-Versands
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
_QUEUE_PATH = _ROOT / "config" / "pioniere-queue.json"

# Takt: frühestens so viele Tage nach dem letzten Auto-Versand wieder posten.
DISPATCH_INTERVAL_DAYS = 2


def _empty() -> dict[str, Any]:
    return {"queue": [], "last_dispatch": ""}


def _load() -> dict[str, Any]:
    try:
        data = json.loads(_QUEUE_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _empty()
        data.setdefault("queue", [])
        data.setdefault("last_dispatch", "")
        if not isinstance(data["queue"], list):
            data["queue"] = []
        return data
    except FileNotFoundError:
        return _empty()
    except Exception:
        return _empty()


def _save(data: dict[str, Any]) -> None:
    _QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Atomar schreiben, damit ein parallel laufender Versand-Job nie eine
    # halbe Datei sieht.
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


def make_id(run_id: str, idx: int) -> str:
    return f"{run_id}:{int(idx)}"


def list_queue() -> list[dict[str, Any]]:
    """Wartende Einträge in Versandreihenfolge (ältester zuerst)."""
    return list(_load().get("queue") or [])


def has(entry_id: str) -> bool:
    return any(e.get("id") == entry_id for e in _load().get("queue") or [])


def enqueue(entry: dict[str, Any]) -> dict[str, Any]:
    """Hängt einen freigegebenen Entwurf hinten an. Doppelte id wird ignoriert."""
    data = _load()
    q = data.get("queue") or []
    eid = entry.get("id") or make_id(entry.get("run_id", ""), int(entry.get("idx", 0)))
    entry["id"] = eid
    entry.setdefault("queued_at", int(time.time()))
    if not any(e.get("id") == eid for e in q):
        q.append(entry)
    data["queue"] = q
    _save(data)
    return entry


def remove(entry_id: str) -> bool:
    data = _load()
    q = data.get("queue") or []
    new_q = [e for e in q if e.get("id") != entry_id]
    changed = len(new_q) != len(q)
    data["queue"] = new_q
    _save(data)
    return changed


def reorder(order_ids: list[str]) -> list[dict[str, Any]]:
    """Setzt die Versandreihenfolge neu. Nicht genannte Einträge wandern ans Ende."""
    data = _load()
    q = data.get("queue") or []
    by_id = {e.get("id"): e for e in q}
    new_q: list[dict[str, Any]] = []
    for eid in order_ids:
        if eid in by_id and by_id[eid] not in new_q:
            new_q.append(by_id[eid])
    for e in q:
        if e not in new_q:
            new_q.append(e)
    data["queue"] = new_q
    _save(data)
    return new_q


def peek_next() -> dict[str, Any] | None:
    q = _load().get("queue") or []
    return q[0] if q else None


def _today() -> str:
    return time.strftime("%Y-%m-%d")


def days_since_last_dispatch() -> int | None:
    """Tage seit letztem Auto-Versand. None, wenn noch nie versandt."""
    last = (_load().get("last_dispatch") or "").strip()
    if not last:
        return None
    try:
        last_epoch = time.mktime(time.strptime(last, "%Y-%m-%d"))
        today_epoch = time.mktime(time.strptime(_today(), "%Y-%m-%d"))
        return int(round((today_epoch - last_epoch) / 86400))
    except Exception:
        return None


def dispatch_due() -> bool:
    """Ist gerade ein getakteter Versand fällig? (Takt erreicht + Queue gefüllt)"""
    q = _load().get("queue") or []
    if not q:
        return False
    elapsed = days_since_last_dispatch()
    if elapsed is None:
        return True  # noch nie versandt, jetzt darf der erste raus
    return elapsed >= DISPATCH_INTERVAL_DAYS


def next_slot_label() -> str:
    """Menschliche Beschreibung, wann der nächste Auto-Versand frühestens läuft."""
    q = _load().get("queue") or []
    if not q:
        return "Queue leer"
    elapsed = days_since_last_dispatch()
    if elapsed is None or elapsed >= DISPATCH_INTERVAL_DAYS:
        return "heute Abend"
    wait = DISPATCH_INTERVAL_DAYS - elapsed
    return "morgen Abend" if wait == 1 else f"in {wait} Tagen"


def mark_dispatched(entry_id: str) -> None:
    """Entfernt den Eintrag und setzt das Versanddatum auf heute."""
    data = _load()
    data["queue"] = [e for e in (data.get("queue") or []) if e.get("id") != entry_id]
    data["last_dispatch"] = _today()
    _save(data)


def snapshot() -> dict[str, Any]:
    """Kompakter Stand für die UI."""
    data = _load()
    q = data.get("queue") or []
    return {
        "queue": q,
        "count": len(q),
        "last_dispatch": data.get("last_dispatch") or "",
        "interval_days": DISPATCH_INTERVAL_DAYS,
        "due": dispatch_due(),
        "next_slot": next_slot_label(),
    }
