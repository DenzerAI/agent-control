"""KlausFlow Pane-PTT — Backend fuer den Swift Push-to-Talk Client.

Vorher: zwei Routen in `backend/server.py` (171-223). Jetzt isoliert.

Auth: eigener Bearer-Token aus ENV `KLAUSFLOW_PANE_TOKEN` (nicht AGENT_TOKEN).
Die beiden Pfade /api/pane-input und /api/voice/stop-audio sind in der
Auth-Middleware (server.py) bereits als Token-frei freigegeben.

Cross-Deps:
- `from streaming import broadcast_pane_input, broadcast_stop_audio`

Spec: frontend/klausflow-pane-ptt-spec.md
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND_DIR = _REPO_ROOT / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from streaming import broadcast_pane_focus, broadcast_pane_input, broadcast_stop_audio, should_drop_duplicate_pane_input  # noqa: E402


router = APIRouter()


@router.post("/api/pane-input")
async def pane_input(request: Request):
    """Empfaengt ein Transkript vom lokalen KlausFlow-Swift-Client und pusht es
    via WebSocket-Broadcast in den Composer des angegebenen Panes.

    Body: {"pane": 1..4, "text": "...", "source": "klaus-flow-ptt", "client_id": "..."}
    """
    expected = (os.getenv("KLAUSFLOW_PANE_TOKEN") or "").strip()
    if not expected:
        return JSONResponse({"ok": False, "error": "endpoint disabled (no token configured)"}, status_code=503)

    auth_header = request.headers.get("authorization", "")
    bearer = auth_header.removeprefix("Bearer ").strip() if auth_header.lower().startswith("bearer ") else ""
    if bearer != expected:
        return JSONResponse({"ok": False, "error": "bad or missing token"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)

    pane = body.get("pane")
    text = body.get("text", "")
    if not isinstance(pane, int) or pane < 1 or pane > 4:
        return JSONResponse({"ok": False, "error": "pane must be int in 1..4"}, status_code=400)
    if not isinstance(text, str) or not text.strip():
        return JSONResponse({"ok": False, "error": "text must be non-empty string"}, status_code=400)
    clean_text = text.strip()
    if len(clean_text) > 8000:
        return JSONResponse({"ok": False, "error": "text too long (max 8000 chars)"}, status_code=400)

    if should_drop_duplicate_pane_input(pane, clean_text):
        return JSONResponse({"ok": True, "duplicate": True, "delivered": False, "pane": pane})

    delivered = await broadcast_pane_input(pane, clean_text)
    return JSONResponse({"ok": True, "delivered": delivered, "pane": pane})


@router.post("/api/pane-focus")
async def pane_focus(request: Request):
    """Fire-and-forget: der KlausFlow-Swift-Client meldet beim ersten Tastendruck
    (Aufnahme-Start) das Ziel-Pane, damit der Desktop sofort dorthin springt —
    noch bevor beim zweiten Druck das Transkript via /api/pane-input kommt.

    Body: {"pane": 1..4}
    """
    expected = (os.getenv("KLAUSFLOW_PANE_TOKEN") or "").strip()
    if not expected:
        return JSONResponse({"ok": False, "error": "endpoint disabled (no token configured)"}, status_code=503)

    auth_header = request.headers.get("authorization", "")
    bearer = auth_header.removeprefix("Bearer ").strip() if auth_header.lower().startswith("bearer ") else ""
    if bearer != expected:
        return JSONResponse({"ok": False, "error": "bad or missing token"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)

    pane = body.get("pane")
    if not isinstance(pane, int) or pane < 1 or pane > 4:
        return JSONResponse({"ok": False, "error": "pane must be int in 1..4"}, status_code=400)

    delivered = await broadcast_pane_focus(pane)
    return JSONResponse({"ok": True, "delivered": delivered, "pane": pane})


@router.post("/api/voice/stop-audio")
async def voice_stop_audio(request: Request):
    """Fire-and-forget Endpoint: Klaus-Mic druckt eine Taste, alle Frontend-Tabs
    kappen sofort die TTS-Wiedergabe."""
    expected = (os.getenv("KLAUSFLOW_PANE_TOKEN") or "").strip()
    if not expected:
        return JSONResponse({"ok": False, "error": "endpoint disabled (no token configured)"}, status_code=503)
    auth_header = request.headers.get("authorization", "")
    bearer = auth_header.removeprefix("Bearer ").strip() if auth_header.lower().startswith("bearer ") else ""
    if bearer != expected:
        return JSONResponse({"ok": False, "error": "bad or missing token"}, status_code=401)

    delivered = await broadcast_stop_audio()
    return JSONResponse({"ok": True, "delivered": delivered})
