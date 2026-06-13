"""Content-Modul: Reels, Karussells, Beiträge.

Instagram-Content-Pipeline:
- Reels (Video) → REELS_OUT_DIR
- Karussells (Slides) → KARUSSELLS_DIR / KARUSSELLS_SOCIAL_DIR
- Beiträge (Einzelbild) → BEITRAEGE_DIR

Vier Zustände pro Item: pending → queued → published / failed.
"""

from __future__ import annotations

import asyncio
import json
import re as _re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse


PROJECT_ROOT = Path(__file__).resolve().parents[2]

REELS_OUT_DIR = PROJECT_ROOT / "video" / "out"
KARUSSELLS_DIR = PROJECT_ROOT / "work" / "denzer-ai" / "marketing" / "ads"
KARUSSELLS_SOCIAL_DIR = PROJECT_ROOT / "work" / "denzer-ai" / "marketing" / "social"
BEITRAEGE_DIR = PROJECT_ROOT / "work" / "denzer-ai" / "marketing" / "beitraege"
BEITRAEGE_DIR.mkdir(parents=True, exist_ok=True)

_JOB_RUNNER = PROJECT_ROOT / "jobs" / "_bin" / "run-job.sh"
_POST_CAROUSEL = PROJECT_ROOT / "skills" / "instagram-post" / "scripts" / "post-carousel.py"
_POST_IMAGE = PROJECT_ROOT / "skills" / "instagram-post" / "scripts" / "post-image.py"

_PUBLISH_STATE: dict[str, str] = {}  # "karussell:<slug>" | "beitrag:<slug>" → state

router = APIRouter()


# ── Helpers: Reels ───────────────────────────────────────────────────────────

def _ffprobe_duration(mp4_path: Path) -> float | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(mp4_path)],
            capture_output=True, text=True, timeout=5,
        )
        return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None
    except (subprocess.SubprocessError, ValueError):
        return None


def _parse_publish_log(log_path: Path) -> dict[str, dict]:
    """Returns {mp4_basename: {ig_media_id, published_at, catbox_url}} from publish-reel.log."""
    if not log_path.exists():
        return {}
    out: dict[str, dict] = {}
    current_file: str | None = None
    current: dict = {}
    try:
        text = log_path.read_text()
    except OSError:
        return {}
    for line in text.splitlines():
        m = _re.match(r"\[([^\]]+)\] === publish-reel (\S+) ===", line)
        if m:
            current_file = m.group(2)
            current = {"started_at_str": m.group(1)}
            continue
        if current_file is None:
            continue
        m = _re.search(r"upload ok:\s+(\S+)", line)
        if m:
            current["catbox_url"] = m.group(1)
            continue
        m = _re.match(r"\[([^\]]+)\] PUBLISHED id=(\d+)", line)
        if m:
            current["ig_media_id"] = m.group(2)
            try:
                dt = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
                current["published_at"] = dt.timestamp()
            except ValueError:
                pass
            out[current_file] = current
            current_file = None
            current = {}
    return out


def _scan_scheduled_jobs() -> dict[str, dict]:
    """Returns {mp4_basename: {label, scheduled_at, plist_path}} from LaunchAgents."""
    agents_dir = Path.home() / "Library" / "LaunchAgents"
    if not agents_dir.is_dir():
        return {}
    out: dict[str, dict] = {}
    for plist in agents_dir.glob("com.klaus.publish-*.plist"):
        try:
            text = plist.read_text()
        except OSError:
            continue
        args = _re.findall(r"<string>([^<]+)</string>", text)
        mp4 = next((a for a in args if a.endswith(".mp4")), None)
        if not mp4:
            continue
        mp4_base = Path(mp4).name
        year = _re.search(r"<key>Year</key>\s*<integer>(\d+)</integer>", text)
        month = _re.search(r"<key>Month</key>\s*<integer>(\d+)</integer>", text)
        day = _re.search(r"<key>Day</key>\s*<integer>(\d+)</integer>", text)
        hour = _re.search(r"<key>Hour</key>\s*<integer>(\d+)</integer>", text)
        minute = _re.search(r"<key>Minute</key>\s*<integer>(\d+)</integer>", text)
        scheduled_at = None
        if all([year, month, day, hour, minute]):
            try:
                dt = datetime(int(year.group(1)), int(month.group(1)), int(day.group(1)),
                              int(hour.group(1)), int(minute.group(1)),
                              tzinfo=ZoneInfo("Europe/Berlin"))
                scheduled_at = dt.timestamp()
            except ValueError:
                pass
        label = _re.search(r"<key>Label</key>\s*<string>([^<]+)</string>", text)
        out[mp4_base] = {
            "label": label.group(1) if label else plist.stem,
            "scheduled_at": scheduled_at,
            "plist_path": str(plist),
        }
    return out


def _read_reel_meta(stem: str) -> dict:
    """Sidecar-Meta neben SplitReel-clipNN-vN.mp4: same dir, .meta.json."""
    p = REELS_OUT_DIR / f"{stem}.meta.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _write_reel_meta(stem: str, meta: dict) -> None:
    p = REELS_OUT_DIR / f"{stem}.meta.json"
    p.write_text(json.dumps(meta, indent=2, ensure_ascii=False))


# ── Helpers: Karussells + Beiträge ───────────────────────────────────────────

def _read_caption(folder: Path) -> str | None:
    """caption.md bevorzugt, sonst caption.txt."""
    for name in ("caption.md", "caption.txt"):
        p = folder / name
        if p.exists():
            try:
                return p.read_text()
            except OSError:
                continue
    return None


def _read_meta(folder: Path) -> dict:
    p = folder / "meta.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _compute_state(meta: dict) -> str:
    """Vier Zustände:
    - "published" → grün, schon auf Instagram
    - "failed"    → rot, letzter Postversuch hat Fehler geliefert
    - "queued"    → weiß, approved und wartet auf Slot
    - "pending"   → orange, frisch generiert, wartet auf Approve
    """
    pub = meta.get("published")
    if isinstance(pub, dict) and pub.get("ig_media_id"):
        return "published"
    status = (meta.get("status") or "").upper()
    if status == "POSTED":
        return "published"
    if meta.get("last_error") and not pub:
        return "failed"
    if bool(meta.get("approved")) or status == "APPROVED":
        return "queued"
    return "pending"


def _scan_carousel_folder(folder: Path, media_prefix: str, id_prefix: str = "") -> dict | None:
    """Liefert ein Karussell-Item für einen Ordner mit slide-*.png, oder None."""
    slides = sorted(folder.glob("slide-*.png"), key=lambda p: p.name)
    if not slides:
        return None
    slug = folder.name
    meta = _read_meta(folder)
    if meta.get("archived"):
        return None
    caption = _read_caption(folder)
    title = (
        meta.get("title")
        or meta.get("thesis")
        or slug.replace("exports-", "").replace("-", " ").strip()
    )
    state = _compute_state(meta)
    return {
        "id": (id_prefix + slug) if id_prefix else slug,
        "title": title,
        "slides": [
            {"n": i + 1, "url": f"{media_prefix}/{s.name}"}
            for i, s in enumerate(slides)
        ],
        "slide_count": len(slides),
        "rendered_at": folder.stat().st_mtime,
        "caption": caption,
        "state": state,
        "approved": state in ("queued", "published"),
        "scheduled_for": meta.get("scheduled_for"),
        "published": meta.get("published") or state == "published",
        "last_error": meta.get("last_error"),
    }


async def _upload_to_catbox(path: Path) -> str:
    """Lädt eine Datei zu litterbox/catbox hoch und liefert die öffentliche URL."""
    targets = [
        ("https://litterbox.catbox.moe/resources/internals/api.php", {"reqtype": "fileupload", "time": "72h"}),
        ("https://catbox.moe/user/api.php", {"reqtype": "fileupload"}),
    ]
    last_err = None
    for endpoint, data in targets:
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                with path.open("rb") as f:
                    resp = await client.post(
                        endpoint,
                        data=data,
                        files={"fileToUpload": (path.name, f, "image/png")},
                    )
            resp.raise_for_status()
            url = resp.text.strip()
            if url.startswith("http"):
                return url
            last_err = f"bad response: {url[:120]}"
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(f"upload failed: {last_err}")


def _trigger_job_bg(job_name: str) -> None:
    """Startet jobs/_bin/run-job.sh <job_name> im Hintergrund."""
    if not _JOB_RUNNER.exists():
        raise RuntimeError(f"run-job.sh fehlt: {_JOB_RUNNER}")
    subprocess.Popen(
        ["bash", str(_JOB_RUNNER), job_name],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


async def _publish_carousel(slug: str) -> dict:
    folder = KARUSSELLS_DIR / slug
    if not folder.is_dir():
        return {"ok": False, "error": "Karussell nicht gefunden"}
    slides = sorted(folder.glob("slide-*.png"), key=lambda p: p.name)
    if not slides:
        return {"ok": False, "error": "Keine Slides"}
    cap_path = folder / "caption.txt"
    if not cap_path.exists():
        return {"ok": False, "error": "caption.txt fehlt"}

    urls: list[str] = []
    for s in slides:
        urls.append(await _upload_to_catbox(s))

    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(_POST_CAROUSEL),
        "--images", *urls,
        "--caption-file", str(cap_path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "error": "post-carousel.py timeout"}

    out = stdout.decode("utf-8", errors="ignore")
    err = stderr.decode("utf-8", errors="ignore")
    if proc.returncode != 0:
        return {"ok": False, "error": f"post-carousel rc={proc.returncode}: {err[:300] or out[:300]}"}
    m = _re.search(r"media_id=(\S+)", out)
    if not m:
        return {"ok": False, "error": f"keine media_id im Output: {out[-300:]}"}
    return {"ok": True, "ig_media_id": m.group(1), "catbox_urls": urls}


async def _publish_beitrag(slug: str) -> dict:
    img = BEITRAEGE_DIR / f"{slug}.png"
    cap_path = BEITRAEGE_DIR / f"{slug}.caption.txt"
    if not img.exists():
        return {"ok": False, "error": "Bild fehlt"}
    if not cap_path.exists():
        return {"ok": False, "error": "caption.txt fehlt"}

    url = await _upload_to_catbox(img)
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(_POST_IMAGE),
        "--image", url,
        "--caption-file", str(cap_path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "error": "post-image.py timeout"}

    out = stdout.decode("utf-8", errors="ignore")
    err = stderr.decode("utf-8", errors="ignore")
    if proc.returncode != 0:
        return {"ok": False, "error": f"post-image rc={proc.returncode}: {err[:300] or out[:300]}"}
    m = _re.search(r"media_id=(\S+)", out)
    if not m:
        return {"ok": False, "error": f"keine media_id im Output: {out[-300:]}"}
    return {"ok": True, "ig_media_id": m.group(1), "catbox_url": url}


def _safe_slug(s: str) -> str:
    """Erlaubt Slash für genistete Pfade (series/slug), strippt sonst alles ausser [A-Za-z0-9_-]."""
    return _re.sub(r"[^a-zA-Z0-9_\-/]", "", s)[:200]


def _resolve_carousel_folder(slug: str) -> Path | None:
    """Findet einen Karussell-Ordner per Slug. Legacy-flach oder series/slug."""
    slug = slug.strip("/")
    if "/" in slug:
        series, name = slug.split("/", 1)
        cand = KARUSSELLS_SOCIAL_DIR / series / name
        return cand if cand.is_dir() else None
    cand = KARUSSELLS_DIR / slug
    if cand.is_dir():
        return cand
    if KARUSSELLS_SOCIAL_DIR.is_dir():
        for series in KARUSSELLS_SOCIAL_DIR.iterdir():
            cand = series / slug
            if cand.is_dir():
                return cand
    return None


# ── Routes: Reels ────────────────────────────────────────────────────────────

@router.get("/api/reels")
async def reels_list():
    """Lists rendered reels mit state. Raw-Clips sind raus."""
    published = _parse_publish_log(REELS_OUT_DIR / "publish-reel.log") if REELS_OUT_DIR.is_dir() else {}

    reels = []
    if REELS_OUT_DIR.is_dir():
        for mp4 in sorted(REELS_OUT_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True):
            name = mp4.name
            caption_path = REELS_OUT_DIR / f"{mp4.stem}.caption.txt"
            caption = None
            if caption_path.exists():
                try:
                    caption = caption_path.read_text()
                except OSError:
                    pass
            stat = mp4.stat()
            meta = _read_reel_meta(mp4.stem)
            if meta.get("archived"):
                continue
            pub_log = published.get(name)
            if pub_log and not meta.get("published"):
                meta["published"] = pub_log
            state = _compute_state(meta)
            reels.append({
                "id": mp4.stem,
                "file": name,
                "title": meta.get("draft_title") or mp4.stem.replace("SplitReel-", "").replace("-", " "),
                "url": f"/reels-media/{name}",
                "size_mb": round(stat.st_size / (1024 * 1024), 1),
                "duration_sec": _ffprobe_duration(mp4),
                "rendered_at": stat.st_mtime,
                "caption": caption,
                "caption_path": str(caption_path) if caption_path.exists() else None,
                "state": state,
                "approved": state in ("queued", "published"),
                "published": meta.get("published") or pub_log,
                "last_error": meta.get("last_error"),
                "scheduled_for": meta.get("scheduled_for"),
                "scheduled_time": meta.get("scheduled_time"),
                "draft_title": meta.get("draft_title"),
            })

    return JSONResponse({"reels": reels[:50]})


@router.post("/api/reels/{stem}/approve")
async def reel_approve(stem: str):
    stem = _safe_slug(stem).replace("/", "")
    mp4 = REELS_OUT_DIR / f"{stem}.mp4"
    if not mp4.exists():
        return JSONResponse({"error": "Reel nicht gefunden"}, status_code=404)
    meta = _read_reel_meta(stem)
    if meta.get("published"):
        return JSONResponse({"error": "schon gepostet"}, status_code=409)
    meta["approved"] = True
    meta["queued_at"] = time.time()
    meta.pop("last_error", None)
    _write_reel_meta(stem, meta)
    return JSONResponse({"ok": True, "state": "queued"})


@router.delete("/api/reels/{stem}")
async def reel_delete(stem: str):
    """Verwerfen: setzt archived=true."""
    stem = _safe_slug(stem).replace("/", "")
    mp4 = REELS_OUT_DIR / f"{stem}.mp4"
    if not mp4.exists():
        return JSONResponse({"error": "Reel nicht gefunden"}, status_code=404)
    meta = _read_reel_meta(stem)
    if meta.get("published"):
        return JSONResponse({"error": "schon gepostet, nicht verwerfbar"}, status_code=409)
    meta["archived"] = True
    meta["archived_at"] = time.time()
    meta["approved"] = False
    _write_reel_meta(stem, meta)
    return JSONResponse({"ok": True})


# ── Routes: Karussells ───────────────────────────────────────────────────────

@router.get("/api/karussells")
async def karussells_list():
    """Lists carousel posts from two sources:
    1. work/denzer-ai/marketing/ads/<slug>/  (legacy, flat)
    2. work/denzer-ai/marketing/social/<series>/<slug>/  (current, nested)
    """
    items = []

    if KARUSSELLS_DIR.is_dir():
        for folder in KARUSSELLS_DIR.iterdir():
            if not folder.is_dir():
                continue
            item = _scan_carousel_folder(folder, f"/karussells-media/{folder.name}")
            if item:
                items.append(item)

    if KARUSSELLS_SOCIAL_DIR.is_dir():
        for series in KARUSSELLS_SOCIAL_DIR.iterdir():
            if not series.is_dir():
                continue
            for folder in series.iterdir():
                if not folder.is_dir():
                    continue
                item = _scan_carousel_folder(
                    folder,
                    f"/karussells-social/{series.name}/{folder.name}",
                    id_prefix=f"{series.name}/",
                )
                if item:
                    items.append(item)

    items.sort(key=lambda x: x["rendered_at"], reverse=True)
    return JSONResponse({"karussells": items[:50]})


@router.post("/api/karussells/{slug:path}/approve")
async def karussell_approve(slug: str):
    slug = _safe_slug(slug)
    folder = _resolve_carousel_folder(slug)
    if folder is None:
        return JSONResponse({"error": "Karussell nicht gefunden"}, status_code=404)
    meta_path = folder / "meta.json"
    meta = {}
    if meta_path.exists():
        try: meta = json.loads(meta_path.read_text())
        except Exception: meta = {}
    if meta.get("published"):
        return JSONResponse({"error": "schon gepostet"}, status_code=409)
    meta["approved"] = True
    meta["queued_at"] = time.time()
    meta.pop("last_error", None)
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return JSONResponse({"ok": True, "state": "queued"})


@router.delete("/api/karussells/{slug:path}")
async def karussell_delete(slug: str):
    """Verwerfen: setzt archived=true (bleibt auf Platte, raus aus der Pane)."""
    slug = _safe_slug(slug)
    folder = _resolve_carousel_folder(slug)
    if folder is None:
        return JSONResponse({"error": "Karussell nicht gefunden"}, status_code=404)
    meta_path = folder / "meta.json"
    meta = {}
    if meta_path.exists():
        try: meta = json.loads(meta_path.read_text())
        except Exception: meta = {}
    if meta.get("published"):
        return JSONResponse({"error": "schon gepostet, nicht verwerfbar"}, status_code=409)
    meta["archived"] = True
    meta["archived_at"] = time.time()
    meta["approved"] = False
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return JSONResponse({"ok": True})


@router.post("/api/karussells/generate")
async def karussells_generate():
    try:
        _trigger_job_bg("instagram-karussell")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({"ok": True, "status": "läuft im Hintergrund"})


@router.get("/api/karussells/{slug}/status")
async def karussell_status(slug: str):
    slug = _safe_slug(slug)
    return JSONResponse({"state": _PUBLISH_STATE.get(f"karussell:{slug}")})


# ── Routes: Beiträge ─────────────────────────────────────────────────────────

@router.get("/api/beitraege")
async def beitraege_list():
    """Lists single-image posts: each .png/.jpg in work/denzer-ai/marketing/beitraege/."""
    items = []
    for img in sorted(BEITRAEGE_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True):
        if img.name.startswith("_"):
            continue
        stem = img.stem
        cap_path = BEITRAEGE_DIR / f"{stem}.caption.txt"
        caption = cap_path.read_text() if cap_path.exists() else None
        meta_path = BEITRAEGE_DIR / f"{stem}.meta.json"
        meta = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
            except (OSError, json.JSONDecodeError):
                pass
        if meta.get("archived"):
            continue
        state = _compute_state(meta)
        items.append({
            "id": stem,
            "title": meta.get("title") or stem.replace("-", " "),
            "url": f"/beitraege-media/{img.name}",
            "rendered_at": img.stat().st_mtime,
            "caption": caption,
            "state": state,
            "approved": state in ("queued", "published"),
            "scheduled_for": meta.get("scheduled_for"),
            "published": meta.get("published") or state == "published",
            "last_error": meta.get("last_error"),
        })
    return JSONResponse({"beitraege": items[:50]})


@router.post("/api/beitraege/{slug}/approve")
async def beitrag_approve(slug: str):
    slug = _safe_slug(slug)
    img = BEITRAEGE_DIR / f"{slug}.png"
    if not img.exists():
        return JSONResponse({"error": "Beitrag nicht gefunden"}, status_code=404)
    meta_path = BEITRAEGE_DIR / f"{slug}.meta.json"
    meta = {}
    if meta_path.exists():
        try: meta = json.loads(meta_path.read_text())
        except Exception: meta = {}
    if meta.get("published"):
        return JSONResponse({"error": "schon gepostet"}, status_code=409)
    meta["approved"] = True
    meta["queued_at"] = time.time()
    meta.pop("last_error", None)
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return JSONResponse({"ok": True, "state": "queued"})


@router.delete("/api/beitraege/{slug}")
async def beitrag_delete(slug: str):
    """Verwerfen: setzt archived=true."""
    slug = _safe_slug(slug)
    img = BEITRAEGE_DIR / f"{slug}.png"
    if not img.exists():
        return JSONResponse({"error": "Beitrag nicht gefunden"}, status_code=404)
    meta_path = BEITRAEGE_DIR / f"{slug}.meta.json"
    meta = {}
    if meta_path.exists():
        try: meta = json.loads(meta_path.read_text())
        except Exception: meta = {}
    if meta.get("published"):
        return JSONResponse({"error": "schon gepostet, nicht verwerfbar"}, status_code=409)
    meta["archived"] = True
    meta["archived_at"] = time.time()
    meta["approved"] = False
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    return JSONResponse({"ok": True})


@router.post("/api/beitraege/generate")
async def beitraege_generate():
    try:
        _trigger_job_bg("instagram-beitrag")
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({"ok": True, "status": "läuft im Hintergrund"})


@router.get("/api/beitraege/{slug}/status")
async def beitrag_status(slug: str):
    slug = _safe_slug(slug)
    return JSONResponse({"state": _PUBLISH_STATE.get(f"beitrag:{slug}")})
