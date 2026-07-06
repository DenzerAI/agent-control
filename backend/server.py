"""Agent Control — Multi-Agent Dashboard. FastAPI Backend."""
import json
import asyncio
import time
import uuid
import mimetypes
import os
import plistlib
import re as _re
import secrets
import sqlite3
import subprocess
import sys
import urllib.request
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

_BACKEND_ROOT = Path(__file__).resolve().parent
_PROJECT_ROOT = _BACKEND_ROOT.parent
for _path in (str(_PROJECT_ROOT), str(_BACKEND_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
from fastapi import FastAPI, Request, UploadFile, File, HTTPException, Form, Body, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, Response, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx
import yaml

from db import (get_db, init_db, save_msg, get_msgs, create_conversation, reindex_all, index_file,
                get_channel_id, get_conversation, auto_title,
                calendar_list, calendar_create, calendar_update, calendar_delete,
                calendar_set_gcal_id, calendar_get_gcal_id, calendar_get_gcal_ref)
from auth import client_ip_trusted, current_token, token_matches, monitor_token_valid, mint_monitor_token, revoke_monitor_tokens, list_monitor_tokens, revoke_monitor_token, monitor_mode_for, set_monitor_mode
from restart_policy import status_payload as restart_policy_status, allow_restarts as restart_policy_allow
import entities as _entities
from security_scan import scan_path, scan_text
from identity import get_agent_profile, public_identity_payload

app = FastAPI()
app.add_middleware(GZipMiddleware, minimum_size=1024)

from routers.deck import router as deck_router
app.include_router(deck_router)
from routers.chat import router as chat_router
app.include_router(chat_router)
from routers.files import router as files_router
app.include_router(files_router)
from routers.skills import router as skills_router
app.include_router(skills_router)
from routers.performance import router as performance_router
app.include_router(performance_router)
from routers.state import router as state_router
app.include_router(state_router)
from routers.jobs import router as jobs_router
app.include_router(jobs_router)
from routers.tools import router as tools_router
app.include_router(tools_router)
from routers.misc import router as misc_router
app.include_router(misc_router)
from routers.connectors import router as connectors_router
app.include_router(connectors_router)
from routers.youtube import router as youtube_router
app.include_router(youtube_router)

DEFAULT_CODEX_MODEL_ID = "gpt-5.5"
DEFAULT_CLAUDE_MODEL_NAME = "Opus 4.8"
CODEX_MODELS = {DEFAULT_CODEX_MODEL_ID}
CLAUDE_MODELS = {"claude-opus-4-8", "claude-fable-5", "claude-opus-4-7", "claude-sonnet-4-6"}
ALL_CHAT_MODELS = CODEX_MODELS | CLAUDE_MODELS | {""}


def _model_for_engine(engine: str, model: str) -> str:
    from engines import normalize_model_for_engine
    return normalize_model_for_engine(engine, model)

_SERVER_STARTED_AT = time.time()


def _git_version_info() -> dict:
    try:
        out = subprocess.run(
            ["git", "-C", str(_PROJECT_ROOT), "log", "-1", "--format=%H%n%h%n%cI%n%s"],
            capture_output=True, text=True, timeout=2,
        )
        if out.returncode == 0:
            lines = out.stdout.strip().split("\n")
            if len(lines) >= 4:
                return {"hash": lines[0], "short": lines[1], "date": lines[2], "subject": lines[3]}
    except Exception:
        pass
    return {"hash": "", "short": "", "date": "", "subject": ""}


_VERSION_INFO = _git_version_info()
_VERSION_INFO_TS = time.time()


def _get_version_info() -> dict:
    """Liefert frischen git-Stand, gecached für 10s, damit neue Commits ohne Restart erscheinen."""
    global _VERSION_INFO, _VERSION_INFO_TS
    if time.time() - _VERSION_INFO_TS > 10:
        _VERSION_INFO = _git_version_info()
        _VERSION_INFO_TS = time.time()
    return _VERSION_INFO


@app.middleware("http")
async def _net_and_token_gate(request: Request, call_next):
    ip = request.client.host if request.client else ""
    host = request.headers.get("host", "").split(":")[0]
    # deck.* kommt über den Cloudflare-Tunnel — ein fremder Monitor ist nicht im
    # Tailnet, darum hier am IP-Gitter vorbei. Alles Sensible bleibt durch das
    # Token-Gate unten geschützt (confirm braucht das Haupt-Token, /deck ein
    # kurzlebiges mon_-Token); token-frei offen sind nur QR-Seite + Pairing-Start.
    if not host.startswith("deck.") and not client_ip_trusted(ip):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    path = request.url.path
    # Auf der Deck-Domain ist die Startseite der token-freie Monitor-Koppel-Screen.
    deck_root = path == "/" and host.startswith("deck.")
    # Statische Vite-Bundles (/assets/*) sind gehashte, nicht-sensible Build-Artefakte
    # (kein Secret im Code, Token kommt erst zur Laufzeit aus Cookie/localStorage).
    # Sie MÜSSEN token-frei sein: über die deck-Domain (am IP-Gate vorbei) läuft jeder
    # ES-Modul-Import sonst ins Token-Gate, das Cookie kommt bei Sub-Chunks nicht
    # zuverlässig mit, ein einziger 401 bricht die Modul-Kette und der Monitor bleibt
    # schwarz. Schutz bleibt vollständig auf /api/* und /ws.
    if deck_root or path.startswith("/assets/") or path.startswith("/sounds/") or path.startswith("/present/") or path in ("/philipp-datenschutz", "/philipp-datenschutz/", "/login", "/manifest.json", "/manifest-mobile.json", "/manifest-focus.json", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/fokus-icon.png", "/robots.txt", "/api/health-export", "/api/pane-input", "/api/pane-focus", "/api/system-status", "/api/build-id", "/tv", "/api/deck/pair/new", "/api/deck/pair/poll", "/api/deck/pair/qr"):
        # /api/pane-input hat einen eigenen Bearer-Token (PANE_TOKEN)
        # /api/system-status ist Health-Check fuer Waechter und Frontend-Topbar,
        # gibt nur Cron-Counts zurueck und ist durch IP-Gate geschuetzt.
        # /tv + pair/new|poll|qr: Monitor-Pairing-Screen hat noch kein Token, der
        # Schutz kommt rein über die Bestätigung vom authentifizierten Handy (confirm).
        return await call_next(request)
    token = current_token()
    if token:
        auth_header = request.headers.get("authorization", "")
        bearer = auth_header.removeprefix("Bearer ").strip() if auth_header.lower().startswith("bearer ") else ""
        cookie_tok = request.cookies.get("agent_auth", "")
        qtok = request.query_params.get("token", "")
        # Jeden mitgelieferten Token EINZELN prüfen, nicht nur den ersten nicht-leeren.
        # Sonst verdeckt ein veraltetes Cookie (z. B. ein mon_-Token von vor dem
        # letzten Server-Neustart) einen frischen, gültigen ?token= aus dem Pairing,
        # und der eben gekoppelte Monitor landet fälschlich auf /login.
        candidates = [c for c in (bearer, qtok, cookie_tok) if c]
        ok = any(token_matches(c) or monitor_token_valid(c) for c in candidates)
        if not ok:
            accept = request.headers.get("accept", "")
            if request.method == "GET" and "text/html" in accept:
                return RedirectResponse(url="/login", status_code=302)
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    response = await call_next(request)
    qtok = request.query_params.get("token", "")
    if token and qtok and qtok != request.cookies.get("agent_auth", "") and (token_matches(qtok) or monitor_token_valid(qtok)):
        # Cookie immer auf den frisch validierten Query-Token setzen, auch wenn
        # schon ein (evtl. abgelaufenes) Cookie existiert — sonst bleibt der
        # Monitor nach einem Neustart am toten Token hängen. Haupt-Token 1 Jahr,
        # Monitor-Token nur bis zum eigenen Ablauf.
        response.set_cookie(
            "agent_auth", qtok,
            httponly=True, samesite="lax",
            max_age=60 * 60 * 12 if qtok.startswith("mon_") else 60 * 60 * 24 * 365,
            path="/",
        )
    return response
PROJECT_ROOT = Path(__file__).parent.parent
DIST_DIR = PROJECT_ROOT / "frontend" / "dist"
UPLOADS_DIR = PROJECT_ROOT / "data" / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Project roots
PROJECTS_ROOTS = [Path.home() / "Projects"]
HIDDEN = {'.git', '.venv', 'node_modules', '__pycache__', '.DS_Store', 'dist', '.next'}

# Allowed base paths for file read/write/list (prevents path traversal)
ALLOWED_PATHS = [
    PROJECT_ROOT,
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

# Dateien/Ordner, die nie ueber die File-APIs ausgeliefert werden, auch wenn sie
# innerhalb eines ALLOWED_PATH liegen. Greift fuer read/serve/list gleichermassen,
# damit kein Endpoint (frueher nur /api/serve) aus der Reihe tanzt.
_SENSITIVE_PARTS = {".env", ".secrets", "secrets", ".credentials.json", ".netrc", ".ssh", ".git"}
_SENSITIVE_SUFFIXES = {".key", ".pem", ".p8", ".keystore", ".pfx"}

def _is_sensitive_path(p: Path) -> bool:
    """True, wenn der Pfad (oder sein Symlink-Ziel) ein Secret-Artefakt ist."""
    try:
        resolved = p.resolve()
    except (OSError, RuntimeError):
        return True  # im Zweifel sperren
    parts = set(resolved.parts)
    if parts & _SENSITIVE_PARTS:
        return True
    if resolved.name.startswith(".env") or resolved.name.startswith("id_rsa"):
        return True
    if resolved.suffix.lower() in _SENSITIVE_SUFFIXES:
        return True
    return False

def _resolve_path(p: str) -> Path:
    raw = str(p or "").strip()
    if raw == "/workspace":
        return PROJECT_ROOT.resolve()
    if raw.startswith("/workspace/"):
        return (PROJECT_ROOT / raw.removeprefix("/workspace/")).resolve()
    if raw.startswith("~/") or raw == "~":
        raw = str(Path.home() / raw[2:]) if raw.startswith("~/") else str(Path.home())
    # Some remote/browser paths can arrive as "Users/klaus/agent/..."
    # instead of "/Users/klaus/agent/...". Accept that only if the rooted
    # candidate is still inside an allowed base.
    if raw and not raw.startswith(("/", "~")):
        rooted = (Path("/") / raw).resolve()
        if _is_allowed_path(rooted):
            return rooted
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    return (PROJECT_ROOT / path).resolve()

# Agent-Tabelle: Identität, Farbe, Stimme, Workspace pro Agent. Aus
# config/agents.json geladen, damit der Kern namens-neutral bleibt.
AGENTS_PATH = PROJECT_ROOT / "config" / "agents.json"

def _load_agents() -> dict:
    raw = json.loads(AGENTS_PATH.read_text()).get("agents", {})
    out: dict = {}
    for aid, cfg in raw.items():
        ws = cfg.get("workspace")
        out[aid] = {
            **cfg,
            "workspace": _resolve_path(ws) if ws else None,
        }
    return out

AGENTS = _load_agents()
_AGENT_NAME_TO_ID = {a["name"]: aid for aid, a in AGENTS.items()}

# ── Sources Config ──
SOURCES_PATH = PROJECT_ROOT / "config" / "sources.json"

def load_sources():
    if SOURCES_PATH.exists():
        return json.loads(SOURCES_PATH.read_text()).get("sources", [])
    return []

SOURCES = load_sources()


# ── Init ──
init_db()

# Klaus-Channel (proaktiver Faden) — stabile Conv anlegen, falls nicht vorhanden.
try:
    from modules.klaus_channel import ensure_klaus_channel
    ensure_klaus_channel()
except Exception as _e:
    print(f"[init] ensure_klaus_channel failed: {_e}", flush=True)


# ── Health Router: Restart-Guard + Active-Streams ──
#    (Routen /api/restart-check, /api/restart-policy/grant, /api/restart-safe,
#     /api/active-streams, /api/active-streams/snapshots in backend/routers/health.py)
from routers.health import router as health_router
app.include_router(health_router)
from routers.privacy import router as privacy_router
app.include_router(privacy_router)



# ── UI-Command Push ──   (Route /api/ui-command in backend/routers/misc.py)


# ── Streaming Router ──
from streaming import setup_streaming, router as streaming_router, start_queue_worker
setup_streaming({
    "agents": AGENTS,
    "projects_roots": PROJECTS_ROOTS,
})
app.include_router(streaming_router)


# ── Module-Loader (Schubladen) ──
# Liest modules/modules.json, haengt aktivierte Modul-Routen an.
# Bei leerer/fehlender Konfiguration: No-op. Fehler in einem Modul
# stoppen NIE den Server (defensive: stderr-Log und weiter).
try:
    from module_loader import load_modules
    _loaded_modules = load_modules(app)
    print(f"[modules] aktiviert: {_loaded_modules or '(keine)'}")
except Exception as _mod_err:
    print(f"[modules] Loader-Fehler, fahre ohne Module fort: {_mod_err}")


# ── Startup ──
@app.on_event("startup")
async def startup():
    reindex_all(SOURCES, _resolve_path)
    # Subprocess-Sessions aus vorherigem Server-Leben sind potenziell korrupt:
    # Wenn der CLI-Subprocess beim Shutdown mitten im Tool-Call gekillt wurde,
    # bleibt die session-Datei halbfertig liegen. Resume darauf liefert dann
    # stumme Antworten oder wiederholt den abgebrochenen Schritt.
    # Reset: Jede Conversation startet nach Restart frisch, Kontext kommt aus DB.
    try:
        with get_db() as db:
            n_claude = db.execute("UPDATE conversations SET claude_session_id = '' WHERE claude_session_id != ''").rowcount
            n_codex = db.execute("UPDATE conversations SET codex_session_id = '' WHERE codex_session_id != ''").rowcount
            db.commit()
        if n_claude or n_codex:
            print(f"[STARTUP] Sessions invalidiert (claude={n_claude}, codex={n_codex})")
    except Exception as e:
        print(f"[STARTUP] Session-Reset fehlgeschlagen: {e}")
    try:
        _ensure_agent_schema()
    except Exception as e:
        print(f"[STARTUP] people-agent-Migration: {e}")
    try:
        _ensure_customer_pipeline_columns()
    except Exception as e:
        print(f"[STARTUP] customers-pipeline-Migration: {e}")
    try:
        _ensure_campaigns_schema()
    except Exception as e:
        print(f"[STARTUP] campaigns-Migration: {e}")
    try:
        _ensure_offers_schema()
    except Exception as e:
        print(f"[STARTUP] offers-Migration: {e}")
    try:
        _ensure_pipeline_memberships_schema()
    except Exception as e:
        print(f"[STARTUP] pipeline-memberships-Migration: {e}")
    asyncio.create_task(_reindex_loop())
    start_queue_worker()
    # TEMP DEAKTIVIERT: Embed-Loops locken DB nach Wipe + Reindex (busy_timeout=0).
    # Reindex spaeter manuell oder nach db.py-Fix wieder anschalten.
    # asyncio.create_task(_embed_index_loop())
    # asyncio.create_task(_embed_files_loop())

    # Hintergrund-Ticks aus geladenen Modulen (z.B. usage scrapt alle 15 Min)
    for _modname in (_loaded_modules or []):
        try:
            _routes_mod = sys.modules.get(f"modules.{_modname}.routes")
            _starter = getattr(_routes_mod, "start_background_tasks", None) if _routes_mod else None
            if callable(_starter):
                _starter()
                print(f"[modules] {_modname}: background tasks gestartet")
        except Exception as _bg_err:
            print(f"[modules] {_modname}: background-task start failed: {_bg_err}")

async def _reindex_loop():
    """Rebuild file search index every 5 minutes."""
    try:
        from automation_registry import mark_tick as _amt
    except Exception:
        _amt = lambda *a, **k: None  # noqa: E731
    while True:
        await asyncio.sleep(300)
        try:
            stats = reindex_all(SOURCES, _resolve_path)
            msg = f"reindexed (stats={stats})" if stats else "reindexed"
            _amt("worker", "_reindex_loop", status="ok", message=msg[:200])
        except Exception as e:
            print(f"[AC] Reindex error: {e}")
            _amt("worker", "_reindex_loop", status="error", message=str(e)[:200])


async def _embed_index_loop():
    """Embed neue Messages alle 90s. Synchroner Ollama-Call läuft im Threadpool,
    damit der Event-Loop frei bleibt. Bei Ollama-Down still no-op."""
    import embeddings as emb
    while True:
        await asyncio.sleep(90)
        try:
            def _run():
                with get_db() as db:
                    return emb.index_pending(db, max_messages=200)
            n = await asyncio.to_thread(_run)
            if n:
                print(f"[EMBED] {n} neue Messages indiziert")
        except Exception as e:
            print(f"[EMBED] Loop-Fehler: {e}")


async def _embed_files_loop():
    """Indexiert Brain-MD-Files alle 5 Minuten. Re-embed nur bei mtime-Änderung,
    also günstig im Steady State. Initial einmal nach 30s anschubsen."""
    import embeddings as emb
    base = Path.home() / "agent/brain"
    await asyncio.sleep(30)
    while True:
        try:
            def _run():
                with get_db() as db:
                    return emb.index_files(db, base)
            res = await asyncio.to_thread(_run)
            if res.get("indexed_files") or res.get("removed"):
                print(f"[EMBED-FILES] {res}")
        except Exception as e:
            print(f"[EMBED-FILES] Loop-Fehler: {e}")
        await asyncio.sleep(300)


# ── Login ──
_LOGIN_HTML = """<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Control</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #141312;
    color: #e8e4df;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
  }
  form {
    width: min(360px, 90vw);
    display: flex; flex-direction: column; gap: 14px;
  }
  h1 { font-size: 15px; font-weight: 500; letter-spacing: 0.04em;
       text-transform: uppercase; color: #8a8580; margin: 0 0 6px; }
  input[type=password] {
    background: #1c1a18; border: 1px solid #2a2723; color: #e8e4df;
    padding: 12px 14px; border-radius: 6px; font-size: 15px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  input[type=password]:focus { outline: none; border-color: #e85d5d; }
  button {
    background: #e85d5d; color: #141312; border: 0; padding: 12px;
    border-radius: 6px; font-size: 14px; font-weight: 600;
    letter-spacing: 0.02em; cursor: pointer;
  }
  button:hover { background: #f27070; }
  .err { color: #e85d5d; font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
<form method="post" action="/login" autocomplete="off">
  <h1>Agent Control</h1>
  <input type="password" name="token" placeholder="Token" autofocus required>
  <button type="submit">Einloggen</button>
  <div class="err">__ERROR__</div>
</form>
</body>
</html>"""


@app.get("/login", response_class=HTMLResponse)
async def login_get():
    return _LOGIN_HTML.replace("__ERROR__", "")


@app.post("/login")
async def login_post(token: str = Form("")):
    if not token_matches(token):
        return HTMLResponse(
            _LOGIN_HTML.replace("__ERROR__", "Falscher Token."),
            status_code=401,
        )
    resp = RedirectResponse(url="/", status_code=303)
    resp.set_cookie(
        "agent_auth", current_token(),
        httponly=True, samesite="lax",
        max_age=60 * 60 * 24 * 365, path="/",
    )
    return resp


# ── Static Files ──
# index.html nie cachen — die enthaltenen Asset-Pfade sind hash-versioniert,
# also dürfen die Assets selbst dauerhaft im Browser-Cache bleiben, aber das
# Index muss bei jedem Reload frisch sein, sonst zeigt er auf alte Hashes.
INDEX_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # Auf der Deck-Domain ist die Startseite direkt der Monitor-Koppel-Screen,
    # damit am fremden Bildschirm nur "deck.example.com" getippt werden muss.
    host = request.headers.get("host", "").split(":")[0]
    if host.startswith("deck."):
        # _TV_HTML lebt jetzt im Deck-Router; Late-Import gegen Zirkularitaet
        # (deck.py importiert nichts aus server.py beim Modul-Load).
        from routers.deck import _TV_HTML
        return HTMLResponse(_TV_HTML, headers=INDEX_NO_CACHE)
    return HTMLResponse((DIST_DIR / "index.html").read_text(), headers=INDEX_NO_CACHE)

@app.get("/mobile", response_class=HTMLResponse)
async def mobile():
    return HTMLResponse((DIST_DIR / "index.html").read_text(), headers=INDEX_NO_CACHE)

@app.get("/fokus", response_class=HTMLResponse)
async def fokus():
    return HTMLResponse((DIST_DIR / "index.html").read_text(), headers=INDEX_NO_CACHE)


@app.get("/remote", response_class=HTMLResponse)
async def remote():
    return HTMLResponse((DIST_DIR / "index.html").read_text(), headers=INDEX_NO_CACHE)


@app.get("/api/build-id")
async def build_id():
    # Hash des ausgelieferten index.html. Aendert sich bei jedem echten Build
    # (die Asset-Pfade darin sind hash-versioniert). Der Frontend-Build-Guard
    # vergleicht ihn gegen seinen Ladestand und erzwingt bei Abweichung einen
    # Hard-Reload, damit kein toter PWA-Kontext mit altem Code haengenbleibt.
    import hashlib
    try:
        raw = (DIST_DIR / "index.html").read_bytes()
        bid = hashlib.sha256(raw).hexdigest()[:12]
    except Exception:
        bid = "dev"
    return JSONResponse({"buildId": bid}, headers=INDEX_NO_CACHE)

@app.get("/infopane-prototype.html", response_class=HTMLResponse)
async def infopane_prototype():
    return (PROJECT_ROOT / "docs" / "infopane-prototype.html").read_text()

if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")
    # UI-Sounds (message-in, level-up …) — nicht-sensible .ogg, token-frei wie /assets,
    # damit das Deck sie über die deck-Domain abspielen kann.
    if (DIST_DIR / "sounds").exists():
        app.mount("/sounds", StaticFiles(directory=DIST_DIR / "sounds"), name="sounds")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

from modules.content import (
    router as content_router,
    REELS_OUT_DIR,
    KARUSSELLS_DIR,
    KARUSSELLS_SOCIAL_DIR,
    BEITRAEGE_DIR,
)

if REELS_OUT_DIR.exists():
    app.mount("/reels-media", StaticFiles(directory=REELS_OUT_DIR), name="reels-media")

REELS_RAW_DIR = PROJECT_ROOT / "video" / "public"
if REELS_RAW_DIR.exists():
    app.mount("/reels-raw", StaticFiles(directory=REELS_RAW_DIR), name="reels-raw")

if KARUSSELLS_DIR.exists():
    app.mount("/karussells-media", StaticFiles(directory=KARUSSELLS_DIR), name="karussells-media")

if KARUSSELLS_SOCIAL_DIR.exists():
    app.mount("/karussells-social", StaticFiles(directory=KARUSSELLS_SOCIAL_DIR), name="karussells-social")

app.mount("/beitraege-media", StaticFiles(directory=BEITRAEGE_DIR), name="beitraege-media")

app.include_router(content_router)


# ── Agents API ──

# ── Agents / Identity / Models ──   (Routen /api/agents, /api/identity, /api/models in backend/routers/misc.py)
# ── User Preferences (device-synced) → routers/state.py ──


# ── System Status ──
# /api/system-status + der Job/Cron/launchd-Cluster sind nach routers/jobs.py
# ausgelagert. Geteilte Helfer werden unten per Re-Import aus routers.jobs
# zurückgeholt, damit verbleibender Code und externe Aufrufer sie weiter finden.


# ── Workflows-Feedback / Systemagent / Dreaming / Engines-Stats / Limits ──
# Routen /api/workflows/{run_id}/feedback, /api/systemagent/run, /api/dreaming,
# /api/dreaming/nap, /api/dreaming/candidates/{candidate_id}/decision,
# /api/engines/stats, /api/limits in backend/routers/misc.py


# /api/active-streams und /api/active-streams/snapshots in backend/routers/health.py


# ── Slot State (Desktop ↔ Mobile Chat-Sync) → routers/state.py ──


# ── Chat History Routes ──

# ── History / Message-Queue ──   (Routen /api/history, /api/message-queue/counts in backend/routers/misc.py)


# ── Projects: Schublade in modules/projects/ ──   (Logik in modules/projects/core.py)
from modules.projects import router as _projects_router
app.include_router(_projects_router)

# ── Workshops in modules/workshops/ ausgelagert ──


# ── Link Preview (Opengraph) → routers/state.py ──


# ── Unread Tracking ──   (Route /api/mark-read in backend/routers/misc.py)


# ── STT (Groq Whisper) ──
# Route /api/emoji-polish + Helfer _get_groq_key sind nach backend/routers/misc.py
# gewandert. Re-Import hält `server._get_groq_key` am Leben (stream_helpers.py
# zieht `from server import _get_groq_key`), ohne Zirkularität: misc.py ist beim
# include_router(misc_router) oben bereits vollständig geladen.
from routers.misc import _get_groq_key  # noqa: E402,F401


# ── Agent Detail + Job/Cron-Cluster (ausgelagert) ──
# Profil-/MD-Helfer und der gesamte Job/Cron/launchd-Cluster wohnen jetzt in
# routers/jobs.py. Hier zurückgeholt, damit verbleibende Skill-Helfer
# (_parse_frontmatter, _as_list, _manifest_status, _manifest_has) und externe
# Aufrufer (server._foo, from server import LOCAL_JOBS_DIR) weiter funktionieren.
from routers.jobs import (  # noqa: E402
    _read_md_file,
    _extract_identity_short,
    _get_agent_model,
    _next_cron_run,
    _parse_frontmatter,
    _parse_job_frontmatter,
    _as_list,
    _manifest_has,
    _manifest_status,
    _boolish,
    _job_has_declared_autonomous_writes,
    _build_job_manifest,
    _build_job_governance,
    _split_prompt_file,
    _resolve_local_job_path,
    _local_job_prompt_file,
    _local_job_has_launchd_schedule,
    _classify_klaus_launchd_entry,
    _klaus_launchd_inventory,
    _last_run_for_local_job,
    _get_local_jobs,
    LOCAL_JOBS_DIR,
    LOCAL_LAUNCHD_DIR,
    LOCAL_JOB_UI_KEEP,
)


# ── Skills / Manifest-Registry / Bibliothekar ──   (Routen + Helfer in backend/routers/skills.py)
# Die gesamte Skill-Index-Helfer-Kette (_get_skills samt _skill_*-Helfern und
# _SKILL_DISPLAY_NAMES) ist nach routers/skills.py gewandert. Re-Import hier hält
# `server._get_skills` für eventuelle externe Aufrufer am Leben, ohne Zirkularität:
# skills.py ist beim include_router oben bereits vollständig geladen.
from routers.skills import _get_skills

# ── Workdirs: Schublade in modules/workdirs/ ──   (Logik in modules/workdirs/core.py)
from modules.workdirs import router as _workdirs_router
app.include_router(_workdirs_router)


# ── File Access ──   (Routen in backend/routers/files.py)


# ── FS: Schublade in modules/fs/ ──   (Logik in modules/fs/core.py)
from modules.fs import router as _fs_router
app.include_router(_fs_router)

# ── Search: Schublade in modules/search/ ──   (Logik in modules/search/core.py)
# Wird vom Module-Loader ueber modules/search/routes.py automatisch eingebunden
# (kind=router, enabled=true in modules/modules.json). Kein manuelles include hier.


# ── Agent Control API: Sources, Rules, Memory ──   (Routen in backend/routers/files.py)
# ── Scrape / Upload / Serve ──   (Routen in backend/routers/files.py)


# ── People CRM: Schublade in modules/people/ ──   (Logik in modules/people/core.py)
from modules.people.core import (
    router as _people_router,
    _people_db,
    _person_row_to_dict,
    _ensure_agent_schema,
    _ensure_campaigns_schema,
    _ensure_customer_pipeline_columns,
    _ensure_offers_schema,
    _ensure_pipeline_memberships_schema,
    PEOPLE_DB,
)
app.include_router(_people_router)


# ── Lexware/Finance: Schublade in modules/lexware/ ──   (Logik in modules/lexware/core.py)
from modules.lexware.core import router as _lexware_router
app.include_router(_lexware_router)

# ── Rechnungs-Agent: Schublade in modules/invoice/ ──   (Logik in modules/invoice/intake.py)
from modules.invoice.routes import router as _invoice_router
app.include_router(_invoice_router)


# ── Redaktion: Pioniere-Post-Agent in modules/pioniere/ ──   (Logik in modules/pioniere/intake.py)
from modules.pioniere.routes import router as _pioniere_router
app.include_router(_pioniere_router)


# ── PT: Schublade in modules/pt/ ──   (Helper + Routen in modules/pt/core.py)
from modules.pt.core import router as _pt_router
app.include_router(_pt_router)


# ── Calendar: Schublade in modules/calendar/ ──   (Logik in modules/calendar/core.py)
from modules.calendar.core import router as _calendar_router
app.include_router(_calendar_router)


# ── Fokus: Schublade in modules/fokus/ ──   (Logik in modules/fokus/core.py)
from modules.fokus import router as _fokus_router
app.include_router(_fokus_router)


# ── Health-Pane: Schublade in modules/health/ ──   (Logik in modules/health/core.py)
from modules.health.core import router as _health_router
app.include_router(_health_router)

# ── Chatagent: Schublade für Chat-Gesundheit, Stabilität und Leichtgewicht ──
from modules.chatagent.core import router as _chatagent_router
app.include_router(_chatagent_router)


# ── Analytics + Leads: Schublade in modules/analytics/ ──   (example.com Website-Stats + KV-Anmeldungen)
from modules.analytics.core import router as _analytics_router
app.include_router(_analytics_router)

from modules.eingang.core import router as _eingang_router
app.include_router(_eingang_router)

from modules.workshops.core import router as _workshops_router
app.include_router(_workshops_router)


@app.get("/philipp-datenschutz", response_class=HTMLResponse)
@app.get("/philipp-datenschutz/", response_class=HTMLResponse)
async def philipp_datenschutz_presenter():
    return HTMLResponse((DIST_DIR / "present" / "philipp-datenschutz.html").read_text(), headers=INDEX_NO_CACHE)


# ── Catch-all: static files from dist root, then SPA fallback ──
@app.get("/{filename:path}")
async def static_fallback(filename: str):
    fpath = DIST_DIR / filename
    if fpath.is_file() and DIST_DIR in fpath.resolve().parents:
        media_type, _ = mimetypes.guess_type(str(fpath))
        return StreamingResponse(open(fpath, "rb"), media_type=media_type or "application/octet-stream")
    return HTMLResponse((DIST_DIR / "index.html").read_text())
