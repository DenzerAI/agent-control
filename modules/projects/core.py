"""Projects — Conversation-Projekte aus chat.db (vorher /api/projects-v2).

Vorher: ~60 Zeilen in `backend/server.py` (893-948). Jetzt isoliert.

URLs umbenannt (Mini-Step 17 hat `/api/projects` freigemacht, Mini-Step 18 hat
Fokus-Projects unter `/api/fokus/projects` aufgehaengt; Conversation-Projekte
heissen jetzt schlicht `/api/projects`):
- `/api/projects-v2`             -> `/api/projects`
- `/api/projects-v2/{id}`        -> `/api/projects/{id}`
- `/api/projects-v2/{id}/plan`   -> `/api/projects/{id}/plan`

Cross-Deps: nur `db`-Helfer.
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import (
    get_projects,
    create_project,
    get_project,
    get_project_conversations,
    rename_project,
    update_project_plan,
    set_project_archived,
    delete_project,
)


router = APIRouter()


@router.get("/api/projects")
async def list_projects(archived: bool = False):
    return JSONResponse({"projects": get_projects(archived=archived)})


@router.post("/api/projects")
async def create_project_route(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    proj = create_project(name)
    return JSONResponse(proj)


@router.get("/api/projects/{project_id}")
async def get_project_route(project_id: str):
    proj = get_project(project_id)
    if not proj:
        return JSONResponse({"error": "not found"}, status_code=404)
    proj["conversations"] = get_project_conversations(project_id)
    return JSONResponse(proj)


@router.patch("/api/projects/{project_id}")
async def update_project_route(project_id: str, request: Request):
    body = await request.json()
    if "name" in body:
        rename_project(project_id, body["name"])
    if "plan" in body:
        update_project_plan(project_id, body["plan"])
    if "archived" in body:
        set_project_archived(project_id, bool(body["archived"]))
    return JSONResponse({"ok": True})


@router.delete("/api/projects/{project_id}")
async def delete_project_route(project_id: str):
    delete_project(project_id)
    return JSONResponse({"ok": True})


@router.get("/api/projects/{project_id}/plan")
async def get_plan(project_id: str):
    proj = get_project(project_id)
    if not proj:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"plan": proj["plan"]})


@router.put("/api/projects/{project_id}/plan")
async def update_plan(project_id: str, request: Request):
    body = await request.json()
    plan = body.get("plan", "")
    update_project_plan(project_id, plan)
    return JSONResponse({"ok": True})
