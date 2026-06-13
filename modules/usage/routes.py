"""HTTP-Routen fuer den Usage-Monitor."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

# Service direkt vom File-Pfad laden -- der module_loader im Server
# instanziiert dieses File nicht als Teil eines vollwertigen
# `modules.usage`-Package, deshalb funktioniert `from .service` nicht.
_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("modules_usage_service", _HERE / "service.py")
_service = importlib.util.module_from_spec(_spec)
sys.modules["modules_usage_service"] = _service
_spec.loader.exec_module(_service)

check_claude_usage = _service.check_claude_usage
read_history = _service.read_history
LATEST = _service.LATEST
TZ = _service.TZ

# Codex-Service analog laden
_spec_codex = importlib.util.spec_from_file_location("modules_usage_codex_service", _HERE / "codex_service.py")
_codex_service = importlib.util.module_from_spec(_spec_codex)
sys.modules["modules_usage_codex_service"] = _codex_service
_spec_codex.loader.exec_module(_codex_service)

check_codex_usage = _codex_service.check_codex_usage
read_codex_history = _codex_service.read_history
CODEX_LATEST = _codex_service.LATEST

router = APIRouter()

STALE_SECONDS = 180  # 3 min: cached gilt als "frisch genug"

# Gemeinsamer Lock: nie zwei Browser-Profile (Claude + Codex) gleichzeitig
# auf, weil sonst zwei Chromium-Fenster parallel aufpoppen.
_scrape_lock = asyncio.Lock()


@router.get("/api/usage/claude")
async def get_claude_usage(fresh: bool = False):
    """Liefert den aktuellen Stand des Claude-Max-Wochenkontingents.

    `fresh=true`: erzwingt einen neuen Browser-Check.
    `fresh=false` (Default): liefert cached aus `latest.json`, frischt aber
    automatisch nach, wenn der Snapshot älter als STALE_SECONDS ist.
    """
    if not fresh and LATEST.exists():
        try:
            data = json.loads(LATEST.read_text(encoding="utf-8"))
            cap = data.get("captured_at")
            if cap:
                ts = datetime.fromisoformat(cap)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=TZ)
                age = (datetime.now(TZ) - ts).total_seconds()
                if age < STALE_SECONDS:
                    return JSONResponse(data)
        except Exception:
            pass

    # check_claude_usage ist synchron + nutzt asyncio.run intern -> in Thread auslagern
    async with _scrape_lock:
        result = await asyncio.to_thread(check_claude_usage)
    return JSONResponse(result)


@router.get("/api/usage/history")
async def get_usage_history(hours: int = 168):
    """Snapshots der letzten `hours` Stunden, alteste zuerst. Default = 7 Tage."""
    rows = await asyncio.to_thread(read_history, hours)
    return JSONResponse({"history": rows})


@router.get("/api/usage/codex")
async def get_codex_usage(fresh: bool = False):
    """Liefert den aktuellen Stand des ChatGPT/Codex-Kontingents (5h + Woche)."""
    if not fresh and CODEX_LATEST.exists():
        try:
            data = json.loads(CODEX_LATEST.read_text(encoding="utf-8"))
            cap = data.get("captured_at")
            if cap:
                ts = datetime.fromisoformat(cap)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=TZ)
                age = (datetime.now(TZ) - ts).total_seconds()
                if age < STALE_SECONDS:
                    return JSONResponse(data)
        except Exception:
            pass

    async with _scrape_lock:
        result = await asyncio.to_thread(check_codex_usage)
    return JSONResponse(result)


@router.get("/api/usage/codex/history")
async def get_codex_usage_history(hours: int = 168):
    rows = await asyncio.to_thread(read_codex_history, hours)
    return JSONResponse({"history": rows})


# ── Hintergrund-Tick ─────────────────────────────────────────────────
# Beide Engines alle 15 Min scrapen, versetzt um 7 Min:
#   Claude: :00, :15, :30, :45
#   Codex:  :07, :22, :37, :52
# Nachts 1–7 Uhr pausiert. Nutzt _scrape_lock, sodass nie zwei
# Chromium-Profile gleichzeitig offen sind.

_QUIET_FROM = 1   # 01:00 inclusive
_QUIET_TO = 7     # 07:00 exclusive


def _seconds_until_next(target_minute_mods: list[int]) -> float:
    now = datetime.now(TZ)
    candidates = []
    for m in target_minute_mods:
        # naechster Slot >= now, dessen Minute % 15 == m
        cur = now.replace(second=0, microsecond=0)
        # Stunde durchprobieren bis zur naechsten passenden Minute
        for delta_min in range(0, 60):
            t = cur + timedelta(minutes=delta_min)
            if t <= now:
                continue
            if t.minute % 15 == m:
                candidates.append(t)
                break
    nxt = min(candidates)
    return max(1.0, (nxt - now).total_seconds())


async def _tick_engine(name: str, target_mod: int, fn):
    """Loopt: warte bis zum nächsten Slot, scrape (außer Nachts), wiederhole."""
    while True:
        try:
            delay = _seconds_until_next([target_mod])
        except Exception:
            delay = 900
        await asyncio.sleep(delay)
        h = datetime.now(TZ).hour
        if _QUIET_FROM <= h < _QUIET_TO:
            continue
        try:
            async with _scrape_lock:
                await asyncio.to_thread(fn)
        except Exception as e:
            print(f"[usage-tick] {name}: {e}", file=sys.stderr)


def start_background_tasks() -> None:
    """Wird beim Server-Startup aufgerufen. Startet beide Tick-Loops."""
    # Claude an :00, Codex an :07 (intern beide 15-Min-Raster)
    asyncio.create_task(_tick_engine("claude", 0, check_claude_usage))
    asyncio.create_task(_tick_engine("codex", 7, check_codex_usage))
