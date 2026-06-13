"""FS — Workspace-Tree-Operations.

Vorher: ~457 Zeilen in `backend/server.py` (2630-3086). Jetzt isoliert.

Cross-Deps:
- `from db import index_file` (Re-Index nach touch/upload bei .md)
- `_is_allowed_path` und `HIDDEN` werden lokal gespiegelt, weil sie klein sind
  und der Import aus `backend.server` einen Circular-Import erzeugen würde.
"""
from __future__ import annotations

import io
import json
import mimetypes
import os
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from db import index_file


PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Allowed base paths for file read/write/list (mirror von backend/server.py)
ALLOWED_PATHS = [
    Path.home() / "agent",
    Path.home() / ".claude",
    Path.home() / "Projects",
    Path.home() / "CLAUDE.md",
]


def _is_allowed_path(p: Path) -> bool:
    """Check if path is under an allowed base directory."""
    resolved = p.resolve()
    return any(resolved == base.resolve() or str(resolved).startswith(str(base.resolve()) + "/")
               for base in ALLOWED_PATHS)


def _resolve_path(p: str) -> Path:
    raw = str(p or "").strip()
    if raw.startswith("~/") or raw == "~":
        raw = str(Path.home() / raw[2:]) if raw.startswith("~/") else str(Path.home())
    # Remote/browser paths may lose the leading slash ("Users/klaus/agent/...").
    # Only accept the rooted variant if it remains inside allowed bases.
    if raw and not raw.startswith(("/", "~")):
        rooted = (Path("/") / raw).resolve()
        if _is_allowed_path(rooted):
            return rooted
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    return (PROJECT_ROOT / path).resolve()


HIDDEN = {'.git', '.venv', 'node_modules', '__pycache__', '.DS_Store', 'dist', '.next'}

# Sources Config — wird beim Modul-Load aus config/sources.json gelesen.
SOURCES_PATH = PROJECT_ROOT / "config" / "sources.json"


def _load_sources() -> list:
    if SOURCES_PATH.exists():
        return json.loads(SOURCES_PATH.read_text()).get("sources", [])
    return []


SOURCES = _load_sources()


router = APIRouter()


# ── Filesystem operations (workspace tree) ──

TRASH_DIR = PROJECT_ROOT / "data" / "trash"


def _safe_name(name: str) -> bool:
    """Reject empty, separators, traversal, hidden-meta names."""
    if not name or name in (".", ".."):
        return False
    if "/" in name or "\\" in name or "\x00" in name:
        return False
    return True


@router.post("/api/fs/mkdir")
async def fs_mkdir(request: Request):
    body = await request.json()
    parent = Path(body.get("parent", ""))
    name = body.get("name", "").strip()
    if not _safe_name(name):
        return JSONResponse({"error": "invalid name"}, status_code=400)
    if not _is_allowed_path(parent) or not parent.is_dir():
        return JSONResponse({"error": "invalid parent"}, status_code=400)
    target = parent / name
    if not _is_allowed_path(target):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if target.exists():
        return JSONResponse({"error": "already exists"}, status_code=409)
    try:
        target.mkdir(parents=False, exist_ok=False)
        return JSONResponse({"ok": True, "path": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/fs/touch")
async def fs_touch(request: Request):
    body = await request.json()
    parent = Path(body.get("parent", ""))
    name = body.get("name", "").strip()
    if not _safe_name(name):
        return JSONResponse({"error": "invalid name"}, status_code=400)
    if not _is_allowed_path(parent) or not parent.is_dir():
        return JSONResponse({"error": "invalid parent"}, status_code=400)
    target = parent / name
    if not _is_allowed_path(target):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if target.exists():
        return JSONResponse({"error": "already exists"}, status_code=409)
    try:
        target.write_text("")
        if target.suffix == ".md":
            index_file(str(target), "", SOURCES)
        return JSONResponse({"ok": True, "path": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/fs/rename")
async def fs_rename(request: Request):
    body = await request.json()
    src = Path(body.get("path", ""))
    new_name = body.get("name", "").strip()
    if not _safe_name(new_name):
        return JSONResponse({"error": "invalid name"}, status_code=400)
    if not _is_allowed_path(src) or not src.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    target = src.parent / new_name
    if not _is_allowed_path(target):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if target.exists():
        return JSONResponse({"error": "already exists"}, status_code=409)
    try:
        src.rename(target)
        return JSONResponse({"ok": True, "path": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/fs/move")
async def fs_move(request: Request):
    body = await request.json()
    src = Path(body.get("path", ""))
    dest_dir = Path(body.get("dest", ""))
    if not _is_allowed_path(src) or not src.exists():
        return JSONResponse({"error": "source not found"}, status_code=404)
    if not _is_allowed_path(dest_dir) or not dest_dir.is_dir():
        return JSONResponse({"error": "invalid destination"}, status_code=400)
    # Prevent moving folder into itself / its child
    try:
        src_resolved = src.resolve()
        dest_resolved = dest_dir.resolve()
        if dest_resolved == src_resolved or str(dest_resolved).startswith(str(src_resolved) + "/"):
            return JSONResponse({"error": "cannot move into itself"}, status_code=400)
    except Exception:
        pass
    target = dest_dir / src.name
    if not _is_allowed_path(target):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if target.exists():
        return JSONResponse({"error": "already exists at destination"}, status_code=409)
    try:
        src.rename(target)
        return JSONResponse({"ok": True, "path": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


TRASH_INDEX = TRASH_DIR / ".index.json"


def _trash_index_load() -> list[dict]:
    if not TRASH_INDEX.exists():
        return []
    try:
        return json.loads(TRASH_INDEX.read_text())
    except Exception:
        return []


def _trash_index_save(entries: list[dict]) -> None:
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    TRASH_INDEX.write_text(json.dumps(entries, ensure_ascii=False, indent=2))


def _trash_add(trash_path: Path, original_path: Path) -> None:
    entries = _trash_index_load()
    entries.append({
        "trash_path": str(trash_path),
        "original_path": str(original_path),
        "name": original_path.name,
        "deleted_at": datetime.now().isoformat(timespec="seconds"),
    })
    _trash_index_save(entries)


@router.post("/api/fs/delete")
async def fs_delete(request: Request):
    """Soft delete: move into data/trash/<timestamp>_<name> and track in index."""
    body = await request.json()
    src = Path(body.get("path", ""))
    if not _is_allowed_path(src) or not src.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    if src.resolve() == (Path.home() / "agent").resolve():
        return JSONResponse({"error": "cannot delete workspace root"}, status_code=400)
    try:
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        target = TRASH_DIR / f"{ts}_{src.name}"
        i = 1
        while target.exists():
            target = TRASH_DIR / f"{ts}_{i}_{src.name}"
            i += 1
        original = src.resolve()
        src.rename(target)
        _trash_add(target, original)
        return JSONResponse({"ok": True, "trash": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/fs/duplicate")
async def fs_duplicate(request: Request):
    """Copy file or folder next to original with ' Kopie' suffix."""
    body = await request.json()
    src = Path(body.get("path", ""))
    if not _is_allowed_path(src) or not src.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    stem = src.stem if src.is_file() else src.name
    suffix = src.suffix if src.is_file() else ""
    base = f"{stem} Kopie"
    target = src.parent / f"{base}{suffix}"
    i = 2
    while target.exists():
        target = src.parent / f"{base} {i}{suffix}"
        i += 1
    if not _is_allowed_path(target):
        return JSONResponse({"error": "access denied"}, status_code=403)
    try:
        if src.is_dir():
            shutil.copytree(src, target)
        else:
            shutil.copy2(src, target)
        return JSONResponse({"ok": True, "path": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/fs/download")
async def fs_download(path: str, inline: int = 0):
    """Serve a single file. inline=1 zeigt im Browser statt Download. Für Folder /api/fs/download-zip."""
    p = _resolve_path(path)
    if not _is_allowed_path(p) or not p.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    if not p.is_file():
        return JSONResponse({"error": "use download-zip for folders"}, status_code=400)
    mime, _ = mimetypes.guess_type(p.name)
    # no-cache zwingt den Browser, per ETag/Last-Modified zu revalidieren statt blind aus
    # dem Cache zu zeigen. Sonst sieht man bei gleichnamig aktualisierten Artefakten (z. B.
    # ein erneut gebautes HTML im Workspace-Viewer) trotz Hard-Refresh die alte Version.
    no_cache = {"Cache-Control": "no-cache, must-revalidate"}
    if inline:
        return FileResponse(p, media_type=mime or "application/octet-stream", headers={"Content-Disposition": f'inline; filename="{p.name}"', **no_cache})
    return FileResponse(p, media_type=mime or "application/octet-stream", filename=p.name, headers=no_cache)


@router.get("/api/fs/download-zip")
async def fs_download_zip(path: str):
    """Stream a zip of a folder."""
    p = _resolve_path(path)
    if not _is_allowed_path(p) or not p.exists() or not p.is_dir():
        return JSONResponse({"error": "not found"}, status_code=404)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in p.rglob("*"):
            if f.is_file():
                zf.write(f, arcname=f.relative_to(p.parent))
    buf.seek(0)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{p.name}.zip"'},
    )


@router.post("/api/fs/upload")
async def fs_upload(parent: str = Form(...), file: UploadFile = File(...)):
    """Upload one file into a parent folder."""
    parent_p = Path(parent)
    if not _is_allowed_path(parent_p) or not parent_p.is_dir():
        return JSONResponse({"error": "invalid parent"}, status_code=400)
    name = (file.filename or "").strip()
    if not _safe_name(name):
        return JSONResponse({"error": "invalid filename"}, status_code=400)
    target = parent_p / name
    if not _is_allowed_path(target):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if target.exists():
        return JSONResponse({"error": "already exists"}, status_code=409)
    try:
        data = await file.read()
        target.write_bytes(data)
        if target.suffix == ".md":
            try:
                index_file(str(target), data.decode("utf-8", errors="replace"), SOURCES)
            except Exception:
                pass
        return JSONResponse({"ok": True, "path": str(target), "size": len(data)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/fs/bulk-delete")
async def fs_bulk_delete(request: Request):
    body = await request.json()
    paths = body.get("paths", [])
    if not isinstance(paths, list) or not paths:
        return JSONResponse({"error": "paths required"}, status_code=400)
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    errors, moved = [], []
    for raw in paths:
        src = Path(raw)
        if not _is_allowed_path(src) or not src.exists():
            errors.append({"path": raw, "error": "not found"})
            continue
        if src.resolve() == (Path.home() / "agent").resolve():
            errors.append({"path": raw, "error": "cannot delete workspace root"})
            continue
        try:
            ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
            target = TRASH_DIR / f"{ts}_{src.name}"
            i = 1
            while target.exists():
                target = TRASH_DIR / f"{ts}_{i}_{src.name}"
                i += 1
            original = src.resolve()
            src.rename(target)
            _trash_add(target, original)
            moved.append(str(target))
        except Exception as e:
            errors.append({"path": raw, "error": str(e)})
    return JSONResponse({"ok": True, "moved": moved, "errors": errors})


@router.post("/api/fs/bulk-move")
async def fs_bulk_move(request: Request):
    body = await request.json()
    paths = body.get("paths", [])
    dest = Path(body.get("dest", ""))
    if not _is_allowed_path(dest) or not dest.is_dir():
        return JSONResponse({"error": "invalid destination"}, status_code=400)
    moved, errors = [], []
    for raw in paths:
        src = Path(raw)
        if not _is_allowed_path(src) or not src.exists():
            errors.append({"path": raw, "error": "not found"})
            continue
        try:
            src_resolved = src.resolve()
            dest_resolved = dest.resolve()
            if dest_resolved == src_resolved or str(dest_resolved).startswith(str(src_resolved) + "/"):
                errors.append({"path": raw, "error": "cannot move into itself"})
                continue
        except Exception:
            pass
        target = dest / src.name
        if target.exists():
            errors.append({"path": raw, "error": "already exists at destination"})
            continue
        try:
            src.rename(target)
            moved.append(str(target))
        except Exception as e:
            errors.append({"path": raw, "error": str(e)})
    return JSONResponse({"ok": True, "moved": moved, "errors": errors})


@router.get("/api/fs/trash")
async def fs_trash_list():
    """List trash entries with their original path and deletion time."""
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    entries = _trash_index_load()
    by_path = {e["trash_path"]: e for e in entries}
    result = []
    for f in sorted(TRASH_DIR.iterdir(), reverse=True):
        if f.name.startswith('.'):
            continue
        meta = by_path.get(str(f), {})
        try:
            st = f.stat()
            size = st.st_size if f.is_file() else sum(p.stat().st_size for p in f.rglob('*') if p.is_file())
            mtime = int(st.st_mtime)
        except OSError:
            size, mtime = None, None
        result.append({
            "trash_path": str(f),
            "name": meta.get("name") or f.name,
            "original_path": meta.get("original_path"),
            "deleted_at": meta.get("deleted_at"),
            "type": "folder" if f.is_dir() else "file",
            "size": size,
            "mtime": mtime,
        })
    return JSONResponse({"items": result})


@router.post("/api/fs/trash/restore")
async def fs_trash_restore(request: Request):
    """Move a trash entry back to its original location (or workspace root if unknown)."""
    body = await request.json()
    trash_path = Path(body.get("trash_path", ""))
    if not trash_path.exists() or trash_path.parent != TRASH_DIR:
        return JSONResponse({"error": "not found in trash"}, status_code=404)
    entries = _trash_index_load()
    meta = next((e for e in entries if e["trash_path"] == str(trash_path)), None)
    original = Path(meta["original_path"]) if meta and meta.get("original_path") else (Path.home() / "agent" / trash_path.name)
    target = original
    if not _is_allowed_path(target):
        target = Path.home() / "agent" / trash_path.name
    if target.exists():
        i = 2
        stem, suffix = (target.stem, target.suffix) if target.is_file() or "." in target.name else (target.name, "")
        while target.exists():
            target = target.parent / f"{stem} ({i}){suffix}"
            i += 1
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        trash_path.rename(target)
        if meta:
            entries = [e for e in entries if e["trash_path"] != str(trash_path)]
            _trash_index_save(entries)
        return JSONResponse({"ok": True, "path": str(target)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/fs/trash/delete")
async def fs_trash_delete(request: Request):
    """Hard-delete one entry from the trash."""
    body = await request.json()
    trash_path = Path(body.get("trash_path", ""))
    if not trash_path.exists() or trash_path.parent != TRASH_DIR:
        return JSONResponse({"error": "not found in trash"}, status_code=404)
    try:
        if trash_path.is_dir():
            shutil.rmtree(trash_path)
        else:
            trash_path.unlink()
        entries = [e for e in _trash_index_load() if e["trash_path"] != str(trash_path)]
        _trash_index_save(entries)
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/fs/find")
async def fs_find(q: str, root: str = "", limit: int = 200):
    """Recursive name-based filename search under root (default: ~/agent)."""
    base = Path(root) if root else Path.home() / "agent"
    if not _is_allowed_path(base) or not base.is_dir():
        return JSONResponse({"items": []})
    needle = q.strip().lower()
    if not needle:
        return JSONResponse({"items": []})
    skip = HIDDEN | {"trash"}
    results = []
    try:
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith('.')]
            for name in dirnames + filenames:
                if name.startswith('.'):
                    continue
                if needle in name.lower():
                    p = Path(dirpath) / name
                    try:
                        st = p.stat()
                        results.append({
                            "name": name,
                            "path": str(p),
                            "type": "folder" if p.is_dir() else "file",
                            "size": st.st_size if p.is_file() else None,
                            "mtime": int(st.st_mtime),
                        })
                    except OSError:
                        pass
                    if len(results) >= limit:
                        return JSONResponse({"items": results, "truncated": True})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({"items": results})


@router.post("/api/fs/trash/empty")
async def fs_trash_empty():
    """Hard-delete everything in the trash."""
    if not TRASH_DIR.exists():
        return JSONResponse({"ok": True, "removed": 0})
    removed = 0
    for f in TRASH_DIR.iterdir():
        if f.name.startswith('.'):
            continue
        try:
            if f.is_dir():
                shutil.rmtree(f)
            else:
                f.unlink()
            removed += 1
        except Exception:
            pass
    _trash_index_save([])
    return JSONResponse({"ok": True, "removed": removed})
