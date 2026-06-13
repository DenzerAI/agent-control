"""Redaktion HTTP-Routen.

Logik in modules/pioniere/intake.py. Der Agent legt einen Pioniere-Post als
Vorschau an und veröffentlicht erst auf ausdrückliche Freigabe (/approve).
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from modules.pioniere import intake

router = APIRouter()
_log = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parents[2]
_JOB_RUNNER = _ROOT / "jobs" / "_bin" / "run-job.sh"
_JOB_SLUG = "pioniere-impuls"


@router.get("/api/pioniere/runs")
async def pioniere_runs(limit: int = 10):
    return {"runs": intake.list_runs(limit=limit)}


@router.get("/api/pioniere/queue")
async def pioniere_queue(pending: int = 30):
    """Versand-Queue (freigegeben, wartet auf Auto-Post) plus offener Entwurfs-Stapel."""
    from modules.pioniere import queue as pqueue
    return {
        "ok": True,
        **pqueue.snapshot(),
        "pending": intake.list_pending_drafts(limit=pending),
    }


@router.post("/api/pioniere/queue/remove")
async def pioniere_queue_remove(req: Request):
    from modules.pioniere import queue as pqueue
    body = await req.json()
    entry_id = (body.get("id") or "").strip()
    if not entry_id:
        return {"ok": False, "error": "id fehlt"}
    return {"ok": pqueue.remove(entry_id)}


@router.post("/api/pioniere/queue/reorder")
async def pioniere_queue_reorder(req: Request):
    from modules.pioniere import queue as pqueue
    body = await req.json()
    order = body.get("order") or []
    if not isinstance(order, list):
        return {"ok": False, "error": "order muss eine Liste sein"}
    return {"ok": True, "queue": pqueue.reorder([str(x) for x in order])}


@router.post("/api/pioniere/dispatch")
async def pioniere_dispatch(req: Request):
    """Getakteter Versand. Vom Versand-Job gerufen, force=true für manuell."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    force = bool((body or {}).get("force"))
    return await intake.dispatch_due(force=force)


@router.post("/api/pioniere/publish-now")
async def pioniere_publish_now(req: Request):
    """Sofortversand eines Entwurfs, umgeht den Zwei-Tage-Takt."""
    body = await req.json()
    run_id = body.get("run_id") or ""
    idx = int(body.get("idx", 0))
    if not run_id:
        return {"ok": False, "error": "run_id fehlt"}
    return await intake.publish_now(run_id, idx)


@router.post("/api/pioniere/run")
async def pioniere_run():
    """Stößt den Pioniereplaner manuell an (run-job.sh im Hintergrund).

    Der Job recherchiert im Radar und legt bei Erfolg eine Vorschau über
    stage_post an. Es geht NICHTS live, Freigabe bleibt manuell.
    """
    if not _JOB_RUNNER.exists():
        return JSONResponse({"ok": False, "error": "run-job.sh fehlt"}, status_code=500)
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", str(_JOB_RUNNER), _JOB_SLUG,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )

        async def _reap():
            try:
                await asyncio.wait_for(proc.wait(), timeout=600)
            except asyncio.TimeoutError:
                proc.kill()

        asyncio.create_task(_reap())
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    return {"ok": True, "status": "gestartet", "hinweis": "läuft im Hintergrund, in ein bis zwei Minuten neu laden"}


@router.post("/api/pioniere/stage")
async def pioniere_stage(req: Request):
    body = await req.json()
    post_body = (body.get("body") or "").strip()
    if not post_body:
        return {"ok": False, "error": "body fehlt"}
    res = await intake.stage_post(
        post_body,
        (body.get("ping") or "").strip(),
        kind=(body.get("kind") or "hint").strip() or "hint",
        source_note=(body.get("source_note") or "").strip(),
        trigger=(body.get("trigger") or "job").strip() or "job",
    )
    return {"ok": True, **res}


@router.post("/api/pioniere/edit")
async def pioniere_edit(req: Request):
    body = await req.json()
    run_id = body.get("run_id") or ""
    idx = int(body.get("idx", 0))
    new_body = (body.get("body") or "").strip()
    title = (body.get("title") or "").strip()
    if not run_id:
        return {"ok": False, "error": "run_id fehlt"}
    if not new_body:
        return {"ok": False, "error": "body fehlt"}
    return await intake.edit_post(run_id, idx, new_body, title=title)


@router.post("/api/pioniere/approve")
async def pioniere_approve(req: Request):
    body = await req.json()
    run_id = body.get("run_id") or ""
    idx = int(body.get("idx", 0))
    if not run_id:
        return {"ok": False, "error": "run_id fehlt"}
    return await intake.approve_post(run_id, idx)


@router.post("/api/pioniere/discard")
async def pioniere_discard(req: Request):
    body = await req.json()
    run_id = body.get("run_id") or ""
    idx = int(body.get("idx", 0))
    if not run_id:
        return {"ok": False, "error": "run_id fehlt"}
    return await intake.discard_post(run_id, idx)
