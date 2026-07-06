"""Files router: Datei- und Memory-Zugriff für die Workspace-Schicht.

Extrahiert aus server.py als Schnitt 4a der Modularisierung (nach
deck.py und chat.py). KEIN Verhalten geändert, nur verschoben. Routen-Pfade
bleiben byte-identisch.

Routen:
- GET  /api/files            — Verzeichnis listen (gefiltert über HIDDEN)
- GET  /api/file             — einzelne Datei lesen (+ .meta.json Sidecar)
- PUT  /api/file             — .md-Datei schreiben und neu indexieren
- GET  /api/sources          — konfigurierte Quellen ausgeben
- GET  /api/rules            — aktive Identitäts-/Feedback-/Projekt-Regeln
- GET  /api/memory/shared    — zentrale Wissens-Dateien aus brain/
- GET  /api/memory/brains    — Brain-Thread-Vorschau
- GET  /api/memory/daily     — Daily-Logs mit Vorschau und Agenten
- GET  /api/memory/knowledge — Wissens-Dateien-Liste aus brain/
- GET  /api/recent-entries   — nutzersichtbare Artefakte (Jobs/Assets/Outputs)
- POST /api/scrape           — ScrapeGraphAI: URL + Prompt → strukturierte Daten
- POST /api/upload           — Datei-Upload nach uploads/
- GET  /api/serve            — lokale Datei als Download ausliefern

Bewusst in server.py VERBLIEBEN (von nicht-verschobenem Code genutzt, per
grep über die ganze server.py verifiziert; hier per Late-Import aus server
geholt, um Zirkularität zu vermeiden):
- _resolve_path, _is_allowed_path: Pfad-Auflösung und Sandbox-Gate, die auch
  von verbleibenden Routen und vom Index-Code (reindex_all) genutzt werden.
- SOURCES: globale Quellen-Liste, die auch reindex_all und verbleibende Routen
  lesen.
- HIDDEN: gemeinsame Filter-Konstante im Konstanten-Block von server.py.
- PROJECT_ROOT, PROJECTS_ROOTS, LOCAL_JOBS_DIR, UPLOADS_DIR, AGENTS: geteilte
  Pfad- und Agenten-Konstanten, die quer durch server.py gebraucht werden.

Mitgewandert, weil ausschließlich von einer dieser Routen genutzt (per grep
über die ganze server.py verifiziert):
- ScrapeRequest: nur vom /api/scrape-Handler.
- MAX_UPLOAD_SIZE: nur vom /api/upload-Handler.

index_file kommt direkt aus db (sauberer Modul-Import, keine Zirkularität);
SOURCES dazu wird per Late-Import aus server geholt, weil dort die eine Wahrheit
liegt. get_agent_profile kommt direkt aus identity.
"""

import json
import re as _re
import uuid
import mimetypes
from pathlib import Path
from datetime import datetime

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel

from db import index_file
from identity import get_agent_profile

router = APIRouter()


# ── File Access ──

@router.get("/api/files")
async def list_files(path: str):
    import server
    base = server._resolve_path(path)
    if not server._is_allowed_path(base):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if not base.exists() or not base.is_dir():
        return JSONResponse({"files": []})
    files = []
    for f in sorted(base.iterdir()):
        if f.name in server.HIDDEN or f.name.startswith('.'):
            continue
        if server._is_sensitive_path(f):
            continue
        try:
            st = f.stat()
            size = st.st_size if f.is_file() else None
            mtime = int(st.st_mtime)
        except OSError:
            size, mtime = None, None
        files.append({
            "name": f.name,
            "type": "folder" if f.is_dir() else "file",
            "path": str(f),
            "size": size,
            "mtime": mtime,
        })
    return JSONResponse({"files": files})


@router.get("/api/file")
async def read_file(path: str):
    import server
    p = server._resolve_path(path)
    if not server._is_allowed_path(p) or server._is_sensitive_path(p):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if not p.exists() or not p.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    if p.stat().st_size > 100_000:
        return JSONResponse({"error": "file too large"}, status_code=400)
    try:
        payload = {"name": p.name, "path": str(p), "content": p.read_text()}
    except UnicodeDecodeError:
        return JSONResponse({"error": "binary file"}, status_code=400)
    # Sidecar: jobs/<slug>/data/YYYY-MM-DD-<slug>.meta.json neben der .md.
    # Liefert Telemetrie aus run-job.sh (Modell, Dauer, Tokens, Cost, Session-ID).
    if p.suffix == ".md":
        sidecar = p.with_name(p.stem + ".meta.json")
        if sidecar.exists() and sidecar.is_file():
            try:
                payload["meta"] = json.loads(sidecar.read_text())
            except Exception:
                pass
    return JSONResponse(payload)


@router.put("/api/file")
async def write_file(request: Request):
    import server
    body = await request.json()
    path = body.get("path", "")
    content = body.get("content", "")

    p = server._resolve_path(path)
    if not server._is_allowed_path(p):
        return JSONResponse({"error": "access denied"}, status_code=403)
    if not p.exists() or not p.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    if p.suffix != ".md":
        return JSONResponse({"error": "only .md files"}, status_code=400)
    try:
        p.write_text(content)
        index_file(path, content, server.SOURCES)
        return JSONResponse({"ok": True})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Agent Control API: Sources, Rules, Memory ──

@router.get("/api/sources")
async def get_sources():
    import server
    return JSONResponse({"sources": server.SOURCES})


@router.get("/api/rules")
async def get_rules():
    import server
    rules = []
    profile = get_agent_profile("main")
    active_rules = [
        ("AGENTS.md", profile.get("rules_path"), "profile-rules"),
        ("SOUL.md", profile.get("soul_path"), "profile-soul"),
        ("BOOTSTRAP.md", Path.home() / "agent/soul/BOOTSTRAP.md", "compat"),
    ]
    for name, path, category in active_rules:
        if not path:
            continue
        path = Path(path)
        if path.exists():
            rules.append({"source": "identity", "label": profile.get("name", "Agent"), "color": profile.get("color", "#888"),
                          "name": name, "path": str(path), "category": category})
    for gp in [Path.home() / "CLAUDE.md", Path.home() / ".claude" / "CLAUDE.md"]:
        if gp.exists():
            rules.append({"source": "global", "label": "Global", "color": "#888",
                          "name": gp.name, "path": str(gp), "category": "claude"})
    for src in server.SOURCES:
        sid, label, color = src["id"], src["label"], src["color"]
        if src["type"] == "claude":
            cp = server._resolve_path(src["path"])
            if not cp.exists():
                continue
            for fp in sorted(cp.glob("feedback_*.md")):
                rules.append({"source": sid, "label": label, "color": color,
                              "name": fp.name, "path": str(fp), "category": "feedback"})
    for root in server.PROJECTS_ROOTS:
        if not root.exists():
            continue
        for d in sorted(root.iterdir()):
            cm = d / "CLAUDE.md"
            if d.is_dir() and cm.exists() and d.name not in server.HIDDEN:
                rules.append({"source": "project", "label": d.name, "color": "#999",
                              "name": f"{d.name}/CLAUDE.md", "path": str(cm), "category": "project"})
    return JSONResponse({"rules": rules})


@router.get("/api/memory/shared")
async def get_shared():
    """Brain: Zentrale Wissens-Dateien aus brain/."""
    _knowledge_files = {"PROJECTS.md", "LEARNINGS.md", "MEMORY.md", "threads.md"}
    items = []
    ws_dir = Path.home() / "agent/brain"
    if ws_dir.exists():
        for fp in sorted(ws_dir.glob("*.md")):
            if fp.name not in _knowledge_files:
                continue
            items.append({
                "name": fp.name, "path": str(fp),
                "size": fp.stat().st_size,
            })
    return JSONResponse({"shared": items})


@router.get("/api/memory/brains")
async def get_brains():
    brains = []
    brain_md = Path.home() / "agent/brain/threads.md"
    if brain_md.exists():
        try:
            brains.append({
                "source": "brain", "label": "Brain", "color": "#f5a623",
                "path": str(brain_md), "content": brain_md.read_text()[:5000],
            })
        except (UnicodeDecodeError, OSError):
            pass
    return JSONResponse({"brains": brains})


@router.get("/api/memory/daily")
async def get_daily(limit: int = 200):
    logs = []
    daily_dir = Path.home() / "agent/brain/daily-log"
    if daily_dir.exists():
        for fp in sorted(daily_dir.glob("2*.md"), reverse=True):
            try:
                content = fp.read_text()
                _known_agents = {'Klaus', 'der Nutzer', 'System'}
                headings = [h.strip() for h in _re.findall(r'^## (.+)$', content, _re.MULTILINE)]
                agents = [h for h in headings if h in _known_agents]
                logs.append({
                    "source": "brain", "label": "Brain", "color": "#f5a623",
                    "date": fp.stem, "path": str(fp),
                    "preview": content[:500],
                    "agents": agents,
                })
            except (UnicodeDecodeError, OSError):
                pass
    return JSONResponse({"logs": logs[:limit]})


@router.get("/api/memory/knowledge")
async def get_knowledge():
    _knowledge_files = {"PROJECTS.md", "LEARNINGS.md", "MEMORY.md", "threads.md"}
    items = []
    ws_dir = Path.home() / "agent/brain"
    if ws_dir.exists():
        for fp in sorted(ws_dir.glob("*.md")):
            if fp.name not in _knowledge_files:
                continue
            items.append({
                "source": "brain", "label": "Brain", "color": "#f5a623",
                "name": fp.name, "path": str(fp),
            })
    return JSONResponse({"knowledge": items})


@router.get("/api/recent-entries")
async def recent_entries(limit: int = 30):
    """User-facing artifacts: job results, explicit assets and shared outputs."""
    import server
    entries: list[dict] = []
    _today = datetime.now().date()
    _artifact_exts = {
        ".md", ".pdf", ".html", ".docx", ".pptx", ".xlsx", ".csv",
        ".zip", ".png", ".jpg", ".jpeg", ".webp",
    }

    def _pretty_label(path: Path, category: str) -> str:
        """Schöner Anzeige-Name. Job-Outputs heissen 'YYYY-MM-DD-<slug>.md'
        und werden zu 'Slug Pretty' verdichtet, weil das Datum eh als
        relativeTime danebensteht."""
        if category.startswith("job:"):
            slug = category[len("job:"):]
            return slug.replace("-", " ").title()
        return path.name

    def _relative_date(mtime: float) -> str:
        try:
            d = datetime.fromtimestamp(mtime).date()
        except (OSError, ValueError):
            return ""
        delta = (_today - d).days
        if delta == 0:
            return "heute"
        if delta == 1:
            return "gestern"
        if delta == 2:
            return "vorgestern"
        if 0 < delta < 7:
            return f"vor {delta} Tagen"
        return d.strftime("%d.%m.")

    def _add(path: Path, agent_id: str, category: str):
        try:
            mtime = path.stat().st_mtime
            entries.append({
                "agent": agent_id,
                "agentName": server.AGENTS.get(agent_id, {}).get("name", agent_id),
                "color": server.AGENTS.get(agent_id, {}).get("color", "#888"),
                "category": category,
                "name": path.name,
                "label": _pretty_label(path, category),
                "relativeDate": _relative_date(mtime),
                "path": str(path),
                "ts": mtime,
            })
        except (OSError, ValueError):
            pass

    # Job Outputs (Agent Control local jobs)
    if server.LOCAL_JOBS_DIR.is_dir():
        for job_dir in server.LOCAL_JOBS_DIR.iterdir():
            if not job_dir.is_dir() or job_dir.name.startswith(("_", ".")):
                continue
            data_dir = job_dir / "data"
            if not data_dir.is_dir():
                continue
            files = sorted(
                (
                    f for f in data_dir.rglob("*")
                    if f.is_file()
                    and not f.name.startswith(".")
                    and not f.name.endswith(".meta.json")
                    and f.suffix.lower() in _artifact_exts
                ),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )
            if files:
                _add(files[0], "main", f"job:{job_dir.name}")

    # Job-Assets (manuell abgelegte Dateien pro Job)
    if server.LOCAL_JOBS_DIR.is_dir():
        for job_dir in server.LOCAL_JOBS_DIR.iterdir():
            if not job_dir.is_dir() or job_dir.name.startswith(("_", ".")):
                continue
            assets_dir = job_dir / "assets"
            if not assets_dir.is_dir():
                continue
            for fp in assets_dir.rglob("*"):
                if fp.is_file() and not fp.name.startswith(".") and fp.suffix.lower() in _artifact_exts:
                    _add(fp, "main", f"asset:{job_dir.name}")

    # Outputs created directly for der Nutzer (Erklär-/Brainstorm-HTML, geteilte
    # Dateien). User-facing, keine Job-Internals, gehören ins Artefakte-Modul.
    artifacts_dir = server.PROJECT_ROOT / "work" / "artifacts"
    if artifacts_dir.is_dir():
        for fp in artifacts_dir.rglob("*"):
            if fp.is_file() and not fp.name.startswith(".") and fp.suffix.lower() in _artifact_exts:
                _add(fp, "main", "artifact")

    entries.sort(key=lambda e: e["ts"], reverse=True)
    return JSONResponse({"entries": entries[:limit]})


# ── Scrape ──
class ScrapeRequest(BaseModel):
    url: str
    prompt: str
    model: str = "openai/gpt-4o-mini"


def _scrape_url_guard(url: str) -> str | None:
    """SSRF-Schutz: nur http(s) nach aussen. Loopback, private, link-local und
    reservierte Ziele werden geblockt, inkl. DNS-Aufloesung des Hostnamens,
    damit auch Namen, die auf interne IPs zeigen, gefangen werden.
    Gibt None zurueck wenn ok, sonst den Fehlergrund."""
    import socket, ipaddress
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return "invalid_url"
    if parsed.scheme not in ("http", "https"):
        return "scheme_not_allowed"
    host = parsed.hostname
    if not host:
        return "no_host"
    try:
        infos = socket.getaddrinfo(host, parsed.port or 80, proto=socket.IPPROTO_TCP)
    except OSError:
        return "dns_failed"
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return "internal_target_blocked"
    return None


@router.post("/api/scrape")
async def scrape_url(req: ScrapeRequest):
    """ScrapeGraphAI: URL + natürlichsprachlicher Prompt → strukturierte Daten."""
    guard = _scrape_url_guard(req.url)
    if guard:
        return JSONResponse({"ok": False, "error": guard}, status_code=403)
    try:
        from scrapegraphai.graphs import SmartScraperGraph
        import os
        graph_config = {
            "llm": {
                "api_key": os.environ.get("OPENAI_API_KEY", ""),
                "model": req.model,
            },
            "verbose": False,
            "headless": True,
        }
        scraper = SmartScraperGraph(
            prompt=req.prompt,
            source=req.url,
            config=graph_config,
        )
        result = scraper.run()
        return {"ok": True, "data": result}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── Upload ──
MAX_UPLOAD_SIZE = 30 * 1024 * 1024


@router.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    import server
    data = await file.read()
    if len(data) > MAX_UPLOAD_SIZE:
        return JSONResponse({"error": "file too large (max 30MB)"}, status_code=400)
    ext = Path(file.filename or "file").suffix or ""
    filename = f"{uuid.uuid4().hex[:12]}{ext}"
    (server.UPLOADS_DIR / filename).write_bytes(data)
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    return JSONResponse({
        "ok": True, "name": file.filename,
        "url": f"/uploads/{filename}", "type": mime, "size": len(data),
    })


@router.get("/api/serve")
async def serve_local_file(path: str):
    """Serve a local file as download. Copies to uploads/ on first access."""
    import server
    p = server._resolve_path(path)
    if not p.exists() or not p.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    if not server._is_allowed_path(p) or server._is_sensitive_path(p):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if p.stat().st_size > 50 * 1024 * 1024:
        return JSONResponse({"error": "file too large"}, status_code=400)
    mime = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=mime, filename=p.name)


# ── Radar Room ──

# YouTube-Video-ID aus den gängigen URL-Formen: watch?v=, youtu.be/, embed/,
# shorts/, live/. ID ist genau 11 Zeichen aus [A-Za-z0-9_-].
_YT_ID = _re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^\"\s]*&)?v=|embed/|shorts/|live/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})"
)
# Markdown-Link [Titel](URL) — nur zum Zuordnen eines Titels zur Video-ID.
_MD_LINK = _re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def _radar_latest(slug: str) -> Path | None:
    """Jüngste Daten-MD eines Radar-Jobs: heute bevorzugt, sonst die neueste."""
    import server, datetime
    data_dir = server.PROJECT_ROOT / "jobs" / slug / "data"
    if not data_dir.exists():
        return None
    today = datetime.date.today().isoformat()
    pref = data_dir / f"{today}-{slug}.md"
    if pref.exists():
        return pref
    cands = sorted(data_dir.glob(f"*-{slug}.md"), reverse=True)
    return cands[0] if cands else None


def _radar_read(slug: str) -> dict:
    """Roh-MD plus Datum eines Radar-Jobs, leer wenn nichts da ist."""
    path = _radar_latest(slug)
    if not path:
        return {"markdown": "", "date": "", "path": ""}
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        text = ""
    import server
    # Datum aus dem Dateinamen ziehen (YYYY-MM-DD-<slug>.md).
    m = _re.match(r"(\d{4}-\d{2}-\d{2})", path.name)
    return {
        "markdown": text,
        "date": m.group(1) if m else "",
        "path": str(path.relative_to(server.PROJECT_ROOT)),
    }


def _extract_videos(*texts: str) -> list[dict]:
    """Sammelt abspielbare YouTube-Videos aus Radar-MD: pro Video-ID einmal,
    mit dem Markdown-Link-Titel falls vorhanden. Reihenfolge bleibt erhalten."""
    seen: dict[str, dict] = {}
    for text in texts:
        if not text:
            continue
        # Erst Links mit Titel, damit ein Video seinen sprechenden Titel bekommt.
        for label, url in _MD_LINK.findall(text):
            mid = _YT_ID.search(url)
            if not mid:
                continue
            vid = mid.group(1)
            if vid not in seen:
                seen[vid] = {"id": vid, "title": label.strip(), "url": url}
        # Dann nackte URLs ohne Markdown-Link.
        for vid in _YT_ID.findall(text):
            if vid not in seen:
                seen[vid] = {"id": vid, "title": "", "url": f"https://youtu.be/{vid}"}
    return list(seen.values())



_RADAR_ITEM = _re.compile(r"^[-*]\s+\*\*\[(?P<title>.+?)\]\((?P<url>[^)]+)\)\*\*\s*(?P<tail>.*)$")
_RADAR_SECTION = _re.compile(r"^#{2,3}\s+(?P<label>.+?)\s*$")
_RADAR_IMPL = _re.compile(r"^\s*\*\*(?:Implikation für der Nutzer|Warum wichtig)[:.]?\*\*\s*(?P<txt>.*)$")
_RADAR_SOURCES = _re.compile(r"\*\(Quellen?:\s*(?P<src>[^)]+)\)\*")
_RADAR_TOP = _re.compile(r"^\*\*Top-?\d.*\*\*\s*$")


def _radar_kind(url: str) -> str:
    u = url.lower()
    if "youtube.com" in u or "youtu.be" in u:
        return "video"
    if "x.com/" in u or "twitter.com/" in u:
        return "tweet"
    if "arxiv.org" in u or "/abs/" in u:
        return "paper"
    return "article"


def _radar_domain(url: str) -> str:
    m = _re.match(r"https?://(?:www\.)?([^/]+)", url or "")
    return m.group(1) if m else ""


def _parse_radar_report(md: str) -> dict:
    """Konsolidierte Radar-MD in strukturierte Beiträge zerlegen: Intro, Sektionen
    mit Beiträgen (Titel, Link, Typ, Fliesstext, Implikation, Quellen) und die
    Top-Liste am Ende. Robust gegen kleine Formatabweichungen; bei Bruch bleibt
    das rohe markdown als Fallback im Endpoint erhalten."""
    if not md:
        return {}
    lines = md.splitlines()
    intro = ""
    sections: list[dict] = []
    cur_section: dict | None = None
    cur_item: dict | None = None
    top: list[str] = []
    in_top = False

    def close_item():
        nonlocal cur_item
        if cur_item and cur_section is not None:
            cur_item["body"] = cur_item["body"].strip()
            cur_section["items"].append(cur_item)
        cur_item = None

    for raw in lines:
        line = raw.rstrip()
        if _RADAR_TOP.match(line.strip()):
            close_item()
            in_top = True
            continue
        if in_top:
            mnum = _re.match(r"^\d+\.\s+(.*)$", line.strip())
            if mnum:
                top.append(mnum.group(1).strip())
            continue
        msec = _RADAR_SECTION.match(line)
        if msec:
            close_item()
            label = msec.group("label").strip()
            # Den obersten Titel (## Morgenradar...) nicht als Sektion zaehlen.
            if label.lower().startswith("morgenradar") or "konsolidiert" in label.lower():
                continue
            cur_section = {"label": label, "items": []}
            sections.append(cur_section)
            continue
        mitem = _RADAR_ITEM.match(line.strip())
        if mitem:
            close_item()
            if cur_section is None:
                cur_section = {"label": "", "items": []}
                sections.append(cur_section)
            url = mitem.group("url").strip()
            cur_item = {
                "title": mitem.group("title").strip(),
                "url": url,
                "kind": _radar_kind(url),
                "domain": _radar_domain(url),
                "body": "",
                "implication": "",
                "sources": "",
            }
            tail = mitem.group("tail").strip()
            if tail:
                cur_item["body"] += tail + " "
            continue
        # Intro vor der ersten Sektion
        if cur_section is None and line.strip().startswith("**Landschaft"):
            intro = _re.sub(r"^\*\*Landschaft\.?\*\*\s*", "", line.strip())
            continue
        if cur_item is not None:
            mim = _RADAR_IMPL.match(line)
            if mim:
                cur_item["implication"] = mim.group("txt").strip()
                continue
            msrc = _RADAR_SOURCES.search(line)
            if msrc and not cur_item["sources"]:
                cur_item["sources"] = msrc.group("src").strip()
                cleaned = _RADAR_SOURCES.sub("", line).strip()
                if cleaned:
                    cur_item["body"] += cleaned + " "
                continue
            if line.strip():
                cur_item["body"] += line.strip() + " "
    close_item()
    return {"intro": intro, "sections": sections, "top": top}


def _radar_tweets(md: str) -> list[dict]:
    """Echte Tweets aus der X-Radar-MD: Permalink, Handle, Status-ID und der
    Kurztext, damit das Frontend ein echtes X-Embed setzen kann."""
    out: list[dict] = []
    seen: set[str] = set()
    for raw in (md or "").splitlines():
        m = _RADAR_ITEM.match(raw.strip())
        if not m:
            continue
        url = m.group("url").strip()
        mm = _re.match(r"https?://(?:www\.)?(?:x|twitter)\.com/([^/]+)/status/(\d+)", url)
        if not mm:
            continue
        sid = mm.group(2)
        if sid in seen:
            continue
        seen.add(sid)
        out.append({"url": url, "handle": mm.group(1), "status_id": sid, "title": m.group("title").strip()})
    return out



def _radar_prior_video_ids(current_date: str, days: int = 7) -> set[str]:
    """Video-IDs aus den Radar-MDs der Vortage. Damit zeigt der Radar-Room nur
    frische Videos: was gestern oder davor schon lief, fliegt heute raus."""
    import server, datetime
    ids: set[str] = set()
    if not current_date:
        return ids
    try:
        cur = datetime.date.fromisoformat(current_date)
    except ValueError:
        return ids
    for slug in ("radar-youtube", "radar-konsolidiert"):
        data_dir = server.PROJECT_ROOT / "jobs" / slug / "data"
        if not data_dir.exists():
            continue
        for off in range(1, days + 1):
            p = data_dir / f"{(cur - datetime.timedelta(days=off)).isoformat()}-{slug}.md"
            if not p.exists():
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except Exception:
                continue
            for v in _extract_videos(text):
                ids.add(v["id"])
    return ids


@router.get("/api/radar/today")
async def radar_today():
    """Tages-Radar für den Radar-Room: konsolidierte Zusammenfassung als MD plus
    die abspielbaren YouTube-Funde des Tages. Liest nur vorhandene Job-Dateien,
    erzeugt nichts neu."""
    konsolidiert = _radar_read("radar-konsolidiert")
    youtube = _radar_read("radar-youtube")
    x_radar = _radar_read("radar-x")
    videos = _extract_videos(youtube.get("markdown", ""), konsolidiert.get("markdown", ""))
    prior = _radar_prior_video_ids(youtube.get("date") or konsolidiert.get("date") or "")
    videos = [v for v in videos if v["id"] not in prior]
    report = _parse_radar_report(konsolidiert.get("markdown", ""))
    tweets = _radar_tweets(x_radar.get("markdown", ""))
    return JSONResponse({
        "konsolidiert": konsolidiert,
        "youtube": youtube,
        "videos": videos,
        "report": report,
        "tweets": tweets,
    })
