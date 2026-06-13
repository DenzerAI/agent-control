"""Health router: Restart-Guard und Active-Streams-Inspektion.

Extrahiert aus server.py als Schnitt F der Modularisierung. KEIN Verhalten
geändert, nur verschoben. Routen-Pfade bleiben byte-identisch.

Routen:
- GET  /api/restart-check            — Busy-Check, ob aktive Subprocesses laufen
- POST /api/restart-policy/grant     — Composer-Freigabe für kontrollierten Restart
- POST /api/restart-safe             — Restart nur ausführen, wenn idle
- GET  /api/active-streams           — laufende Stream-Subprocesses auflisten
- GET  /api/active-streams/snapshots — laufende Streams inkl. Toolcalls/Titel

Streaming-State-Zugriff:
Die active-streams-Routen und der Restart-Guard greifen auf die Live-Dicts
``_active_procs``, ``_active_tasks`` und ``_active_started_at`` im Modul
``streaming`` zu und mutieren diese teils (``.pop``). Damit wirklich dasselbe
Live-Dict getroffen wird, geschieht der Zugriff bewusst über das Modulobjekt
(``import streaming`` + ``streaming._active_procs``) statt über einen
``from streaming import _active_procs``-Snapshot.

``_build_snapshot_event`` bleibt in streaming.py (wird dort auch intern in
streaming.py selbst genutzt) und wird hier nur importiert.

Mitgewandert, weil ausschließlich von diesen Routen genutzt (per grep über die
ganze server.py verifiziert):
- _restart_lock: asyncio.Lock, nur von /api/restart-safe.
- _get_restart_guard_status: nur von /api/restart-check und /api/restart-safe.
"""

import os
import asyncio

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

import streaming
from streaming import _build_snapshot_event
from db import get_db
from restart_policy import allow_restarts as restart_policy_allow

router = APIRouter()


_restart_lock = asyncio.Lock()


async def _get_restart_guard_status() -> dict:
    """Lightweight busy-check: aktive Codex/Claude-Subprocesses verhindern Restart."""
    sessions = []
    for conv_id, proc in list(streaming._active_procs.items()):
        if proc and proc.returncode is None:
            sessions.append({
                "key": conv_id,
                "title": conv_id,
                "busy": True,
                "status": "running",
            })
    status = {
        "ok": not sessions,
        "sessions": sessions,
        "tasks": [],
        "busyCount": len(sessions),
        "summary": f"{len(sessions)} aktive Sessions" if sessions else "idle",
    }
    return status


@router.get("/api/restart-check")
async def restart_check():
    return JSONResponse(await _get_restart_guard_status())


@router.post("/api/restart-policy/grant")
async def restart_policy_grant(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    minutes = int((body or {}).get("minutes") or 2)
    reason = str((body or {}).get("reason") or "Composer-Freigabe durch der Nutzer")
    policy = restart_policy_allow(minutes=minutes, reason=reason, actor="composer")
    return JSONResponse(policy)


@router.post("/api/restart-safe")
async def restart_safe():
    guard = await _get_restart_guard_status()
    if not guard.get("ok"):
        raise HTTPException(status_code=409, detail=guard)

    async with _restart_lock:
        guard = await _get_restart_guard_status()
        if not guard.get("ok"):
            raise HTTPException(status_code=409, detail=guard)

        async def _delayed_restart():
            await asyncio.sleep(0.25)
            os._exit(0)

        asyncio.create_task(_delayed_restart())
        return JSONResponse({"ok": True, "message": "restart scheduled"})


@router.get("/api/active-streams")
async def active_streams():
    """List currently streaming Claude subprocesses. Used by restart-server.sh
    to avoid cutting off other sessions mid-answer, und vom Mobile-UI um den
    echten Stream-Start (Wall-Clock-Epoch in ms) statt der Wahrnehmungszeit
    zu nutzen."""
    conv_ids = []
    for cid in list(set(streaming._active_procs.keys()) | set(streaming._active_tasks.keys())):
        proc = streaming._active_procs.get(cid)
        task = streaming._active_tasks.get(cid)
        proc_running = bool(proc and proc.returncode is None)
        task_running = bool(task and not task.done())
        if proc_running or task_running:
            conv_ids.append(cid)
            continue
        streaming._active_procs.pop(cid, None)
        streaming._active_tasks.pop(cid, None)
        streaming._active_started_at.pop(cid, None)
    streams = [
        {"convId": cid, "startedAt": int(streaming._active_started_at.get(cid, 0) * 1000)}
        for cid in conv_ids
    ]
    return JSONResponse({
        "count": len(conv_ids),
        "convIds": conv_ids,
        "streams": streams,
    })


@router.get("/api/active-streams/snapshots")
async def active_stream_snapshots():
    """Liefert laufende Stream-Snapshots inklusive Toolcalls und Chat-Titel
    für UI-Visualisierungen wie den AgentFlow im InfoPane."""
    conv_ids = list(streaming._active_procs.keys())
    titles: dict[str, str] = {}
    if conv_ids:
        with get_db() as db:
            placeholders = ",".join("?" for _ in conv_ids)
            rows = db.execute(
                f"SELECT id, title FROM conversations WHERE id IN ({placeholders})",
                conv_ids,
            ).fetchall()
            titles = {str(r[0]): str(r[1] or "") for r in rows}

    snapshots = []
    for cid in conv_ids:
        snap = _build_snapshot_event(cid)
        if not snap:
            continue
        snap["title"] = titles.get(cid, "")
        snap["startedAt"] = int(streaming._active_started_at.get(cid, 0) * 1000)
        snapshots.append(snap)

    snapshots.sort(key=lambda s: int(s.get("startedAt") or 0), reverse=True)
    return JSONResponse({
        "count": len(snapshots),
        "snapshots": snapshots,
    })


@router.post("/api/restart-broadcast")
async def restart_broadcast(request: Request):
    """Stupst nach einem Restart genau die parallelen Sessions an, deren Stream der
    Restart gekappt hat. Das ausloesende Frontend snapshottet vor dem Kickstart die
    aktiven convIds (ueber /api/active-streams), filtert die eigene raus und meldet
    den Rest hierher, sobald der Server wieder oben ist. Jede betroffene Pane nimmt
    ihre convId aus dem Broadcast und synchronisiert still den Verlauf; echte
    Fortsetzung laeuft ueber incomplete-Row-Auto-Resume."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    raw = body.get("convIds") or body.get("conversationIds") or []
    if not isinstance(raw, list):
        return JSONResponse({"ok": False, "error": "convIds must be a list"}, status_code=400)
    conv_ids = [str(c).strip() for c in raw if str(c or "").strip()]
    # Dedupe, Reihenfolge erhalten.
    seen: set = set()
    conv_ids = [c for c in conv_ids if not (c in seen or seen.add(c))]
    delivered = await streaming.broadcast_server_back(conv_ids)
    return JSONResponse({"ok": True, "delivered": delivered, "convIds": conv_ids})
