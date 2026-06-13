"""HTTP-Routen für den Opportunity-Scanner."""
from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from . import core

router = APIRouter()


@router.post("/api/opportunity/scan")
async def opportunity_scan(payload: dict = Body(default={})):
    trigger = str((payload or {}).get("trigger") or "manual")
    res = await core.run_scan(trigger=trigger)
    return JSONResponse(res)


@router.get("/api/opportunity/learning")
async def opportunity_learning():
    return JSONResponse(core._load_learning())


@router.post("/api/opportunity/dismiss")
async def opportunity_dismiss(payload: dict = Body(...)):
    slug = str((payload or {}).get("slug") or "").strip()
    if not slug:
        return JSONResponse({"ok": False, "error": "slug fehlt"}, status_code=400)
    return JSONResponse({"ok": True, "learning": core.dismiss(slug)})


@router.post("/api/opportunity/confirm")
async def opportunity_confirm(payload: dict = Body(...)):
    slug = str((payload or {}).get("slug") or "").strip()
    if not slug:
        return JSONResponse({"ok": False, "error": "slug fehlt"}, status_code=400)
    return JSONResponse({"ok": True, "learning": core.confirm(slug)})
