"""Workdirs — Liste/Archive/Context/Create fuer Projektordner unter ~/Projects.

Vorher: ~140 Zeilen in `backend/server.py` (2246-2422). Jetzt isoliert.

URLs umbenannt: `/api/projects` -> `/api/workdirs`,
`/api/projects/archive` -> `/api/workdirs/archive`,
`/api/project-context` -> `/api/workdirs/context`.
`POST /api/workdirs` legt einen neuen Projektordner an.

Cross-Deps:
- `from db import index_file`
- `PROJECTS_ROOTS`, `HIDDEN`, `SOURCES`, `_resolve_path` werden lokal gespiegelt
  (gleicher Stil wie `modules/search/core.py` und `modules/fs/core.py`).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import index_file


PROJECT_ROOT = Path(__file__).resolve().parents[2]

PROJECTS_ROOTS = [Path.home() / "Projects"]
HIDDEN = {'.git', '.venv', 'node_modules', '__pycache__', '.DS_Store', 'dist', '.next'}

SOURCES_PATH = PROJECT_ROOT / "config" / "sources.json"


def _load_sources() -> list:
    if SOURCES_PATH.exists():
        return json.loads(SOURCES_PATH.read_text()).get("sources", [])
    return []


SOURCES = _load_sources()


def _resolve_path(p: str) -> Path:
    return Path(p.replace("~", str(Path.home())))


def _read_frontmatter_status(fp: Path) -> bool:
    try:
        text = fp.read_text(errors='replace')
        if not text.startswith('---'):
            return False
        end = text.find('---', 3)
        if end == -1:
            return False
        fm = text[3:end]
        for line in fm.splitlines():
            if line.strip().startswith('status:') and 'archived' in line:
                return True
    except Exception:
        pass
    return False


def _set_frontmatter_status(fp: Path, archived: bool):
    text = fp.read_text(errors='replace')
    status_line = 'status: archived'
    if text.startswith('---'):
        end = text.find('---', 3)
        if end != -1:
            fm = text[3:end]
            body = text[end+3:]
            lines = [l for l in fm.splitlines() if not l.strip().startswith('status:')]
            if archived:
                lines.append(status_line)
            new_fm = '\n'.join(lines)
            fp.write_text(f'---{new_fm}\n---{body}')
            return
    if archived:
        fp.write_text(f'---\n{status_line}\n---\n\n{text}')


router = APIRouter()


@router.get("/api/workdirs")
async def list_workdirs():
    projects = []
    seen = set()
    for root in PROJECTS_ROOTS:
        if not root.exists():
            continue
        for d in sorted(root.iterdir()):
            if d.is_dir() and d.name not in HIDDEN and not d.name.startswith('.'):
                has_claude = (d / "CLAUDE.md").exists()
                archived = _read_frontmatter_status(d / "CLAUDE.md") if has_claude else False
                projects.append({"name": d.name, "path": str(d), "claude": has_claude,
                                 "source": "filesystem", "archived": archived})
                seen.add(d.name.lower())
    for src in SOURCES:
        if src["type"] != "claude":
            continue
        cp = _resolve_path(src["path"])
        if not cp.exists():
            continue
        for fp in sorted(cp.glob("project_*.md")):
            slug = fp.stem.replace("project_", "")
            parts = slug.lower().split("_")
            if any(p in seen for p in parts) or slug.lower() in seen:
                continue
            archived = _read_frontmatter_status(fp)
            projects.append({"name": slug.replace("_", " ").title(), "path": str(fp),
                             "claude": False, "source": "claude", "archived": archived})
            seen.add(slug.lower())
    return JSONResponse({"projects": projects})


@router.post("/api/workdirs/archive")
async def archive_workdir(request: Request):
    body = await request.json()
    path = body.get("path", "")
    archived = body.get("archived", True)
    p = Path(path)
    if not p.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    if p.is_file() and p.suffix == '.md':
        _set_frontmatter_status(p, archived)
        return JSONResponse({"ok": True, "archived": archived})
    if p.is_dir():
        target = p / "CLAUDE.md"
        if not target.exists():
            target = p / "README.md"
        if not target.exists():
            target = p / "CLAUDE.md"
            target.write_text(f'---\nstatus: archived\n---\n\n# {p.name}\n')
            return JSONResponse({"ok": True, "archived": archived})
        _set_frontmatter_status(target, archived)
        return JSONResponse({"ok": True, "archived": archived})
    return JSONResponse({"error": "unsupported"}, status_code=400)


@router.get("/api/workdirs/context")
async def workdir_context(path: str):
    p = Path(path)
    context = ""
    for name in ["CLAUDE.md", ".workspace-summary.md"]:
        f = p / name
        if f.exists() and f.is_file():
            try:
                context += f.read_text() + "\n\n"
            except Exception:
                pass
    return JSONResponse({"context": context.strip()})


@router.post("/api/workdirs")
async def create_workdir(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    path = PROJECTS_ROOTS[0] / name
    if path.exists():
        return JSONResponse({"error": "exists"}, status_code=400)
    path.mkdir(parents=True)
    template = f"""# {name}

## Was
(Eine Zeile: Was ist das?)

## Ziel
(Was soll am Ende rauskommen?)

## Status
aktiv

## Stack
(Welche Technologien?)

## Pfad
{path}

## Regeln
- (Was sollen die Agents beachten?)

## Letzter Stand
{time.strftime('%Y-%m-%d')} — Projekt angelegt
"""
    claude_path = path / "CLAUDE.md"
    claude_path.write_text(template)
    index_file(str(claude_path), template, SOURCES)

    # Create PLAN.md with structured project planning template
    plan_template = f"""# {name} — Plan

## Ziel
(Was soll am Ende rauskommen?)

## Phasen

### Phase 1: Setup
- [ ] Grundstruktur anlegen
- [ ] Anforderungen klären

### Phase 2: Umsetzung
- [ ] (Aufgaben hier eintragen)

### Phase 3: Fertigstellung
- [ ] Testen
- [ ] Dokumentation

## Status
🟡 In Planung

## Nächste Schritte
- Ziel und Phasen mit Christian besprechen

## Änderungsprotokoll
- {time.strftime('%Y-%m-%d')} — Projekt angelegt
"""
    plan_path = path / "PLAN.md"
    plan_path.write_text(plan_template)
    index_file(str(plan_path), plan_template, SOURCES)

    return JSONResponse({"ok": True, "path": str(path), "name": name})
