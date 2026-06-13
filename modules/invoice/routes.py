"""Rechnungs-Agent HTTP-Routen.

Logik in modules/invoice/intake.py. Der Agent legt erst auf ausdrückliche
Freigabe (/approve) die echte Lexware-Rechnung an.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from modules.invoice import intake

router = APIRouter()
_log = logging.getLogger(__name__)


@router.get("/api/invoice/runs")
async def invoice_runs(limit: int = 10):
    return {"runs": intake.list_runs(limit=limit)}


@router.post("/api/invoice/run")
async def invoice_run(req: Request):
    body = await req.json()
    customer = (body.get("customer") or "").strip()
    positions = body.get("positions") or []
    if not customer:
        return {"ok": False, "error": "customer fehlt"}
    res = await intake.run_invoice(
        customer,
        positions,
        contact_id=(body.get("contact_id") or "").strip(),
        title=(body.get("title") or "Rechnung").strip() or "Rechnung",
        intro=(body.get("intro") or "").strip(),
        channel_pref=(body.get("channel") or "").strip(),
        trigger=(body.get("trigger") or "manual").strip() or "manual",
    )
    return {"ok": True, **res}


@router.post("/api/invoice/approve")
async def invoice_approve(req: Request):
    body = await req.json()
    run_id = body.get("run_id") or ""
    idx = int(body.get("idx", 0))
    if not run_id:
        return {"ok": False, "error": "run_id fehlt"}
    return await intake.approve_invoice(run_id, idx)


@router.post("/api/invoice/discard")
async def invoice_discard(req: Request):
    body = await req.json()
    run_id = body.get("run_id") or ""
    idx = int(body.get("idx", 0))
    if not run_id:
        return {"ok": False, "error": "run_id fehlt"}
    return await intake.discard_invoice(run_id, idx)
