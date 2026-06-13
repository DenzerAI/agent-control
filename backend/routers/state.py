"""State router: geräteübergreifender UI- und Sync-Zustand.

Extrahiert aus server.py als weiterer Schnitt der Modularisierung (nach
voice.py, deck.py, chat.py, files.py, skills.py, voice_tools.py und
performance.py). KEIN Verhalten geändert, nur verschoben. Routen-Pfade bleiben
byte-identisch.

Drei zusammengehörige Bereiche, die alle den UI-Zustand zwischen Mobile und
Desktop synchron halten:
- Preferences: gerätegeteilte Einstellungen aus config/preferences.json.
- Slots: die ersten vier Chat-Slots (Quelle der Wahrheit für die ersten vier
  Panes bzw. die Mobile-Punkte).
- Link-Preview: Opengraph-Vorschau mit In-Memory-Cache.

Routen:
- GET  /api/prefs        — aktuelle Preferences ausgeben
- PUT  /api/prefs        — Preferences mischen, speichern, live broadcasten
- GET  /api/slots        — Slot-Zustand (slots + activeSlot) ausgeben
- PUT  /api/slots        — Slots speichern und live broadcasten
- GET  /api/link-preview — Opengraph-Vorschau für eine URL

Abhängigkeiten:
- _broadcast kommt per Late-Import aus dem streaming-Modul (gleicher Stil wie
  chat.py), damit Desktop ↔ Mobile synchron bleiben. NICHT dupliziert.
- PROJECT_ROOT wird lokal aus __file__ berechnet (gleiche Repo-Wurzel wie
  server.py:169), weil der Router von server.py vor dessen
  PROJECT_ROOT-Definition importiert wird und ein Top-Level-Import aus server
  damit zirkulär wäre.

Mitgewandert, weil ausschließlich von diesen Routen genutzt (per grep über das
ganze backend/ verifiziert): _PREFS_FILE, _PREFS_LOCK, _load_prefs, _save_prefs,
SLOTS_PATH, MAX_SLOTS, _default_slots, _normalize_slot, _pad_slots,
_load_slot_state, _load_slots, _save_slots, _link_preview_cache,
_LINK_PREVIEW_TTL, _extract_og. MAX_SLOTS existiert in deck.py als eigene lokale
Konstante (kein geteilter State), daher keine Aufrufer anzupassen.
"""

import re as _re
import json
import time
import asyncio
from pathlib import Path

import httpx
from fastapi import APIRouter, Request, Body, HTTPException
from fastapi.responses import JSONResponse

# Repo-Wurzel: routers/state.py → backend/ → Repo-Wurzel. Entspricht
# server.py:169 PROJECT_ROOT = Path(__file__).parent.parent (dort liegt server.py
# direkt in backend/, hier eine Ebene tiefer in backend/routers/).
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

router = APIRouter()


# ── User Preferences (device-synced) ──
# Shared across Mobile and Desktop via preferences.json.

_PREFS_FILE = PROJECT_ROOT / "config" / "preferences.json"
_PREFS_LOCK = asyncio.Lock()


def _load_prefs() -> dict:
    try:
        if _PREFS_FILE.exists():
            with open(_PREFS_FILE) as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def _save_prefs(p: dict) -> None:
    try:
        tmp = _PREFS_FILE.with_suffix(".tmp")
        with open(tmp, "w") as f:
            json.dump(p, f, indent=2, ensure_ascii=False)
        tmp.replace(_PREFS_FILE)
    except Exception as e:
        print(f"[prefs] save failed: {e}")


@router.get("/api/prefs")
async def get_prefs():
    return JSONResponse(_load_prefs())


@router.put("/api/prefs")
async def put_prefs(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(400, "payload must be an object")
    source = ""
    body = dict(payload)
    if isinstance(body.get("__source"), str):
        source = body.pop("__source")
    async with _PREFS_LOCK:
        p = _load_prefs()
        for k, v in body.items():
            if v is None:
                p.pop(k, None)
            else:
                p[k] = v
        _save_prefs(p)
    # Live an alle anderen Geräte senden, damit Mobile ↔ Desktop synchron bleiben.
    try:
        from streaming import _broadcast
        await _broadcast(json.dumps({
            "type": "prefs.update",
            "changes": body,
            "source": source,
        }))
    except Exception:
        pass
    return JSONResponse(p)


# ── Slot State (Desktop ↔ Mobile Chat-Sync) ───────────────────────────────
# Erste 4 "Slots" sind die Quelle der Wahrheit für die ersten 4 Chats.
# Mobile zeigt sie unten als Punkte, Desktop spiegelt sie in den ersten 4 Panes.
# Persistenz als JSON unter data/slots.json — keine DB-Migration nötig.
SLOTS_PATH = PROJECT_ROOT / "data" / "slots.json"
MAX_SLOTS = 4

def _default_slots() -> list[dict]:
    return [{"agent": "main", "convId": ""} for _ in range(MAX_SLOTS)]

def _normalize_slot(s, index: int) -> dict:
    if not isinstance(s, dict):
        return {"agent": "main", "convId": ""}
    agent = str(s.get("agent") or "main")
    conv_id = str(s.get("convId") or "")
    if conv_id.startswith("channel-"):
        conv_id = ""
    # Klaus-Channel darf nur in Slot 0 leben (Pane 1). Sonst rausfiltern.
    if conv_id == "klaus-channel" and index != 0:
        conv_id = ""
    return {"agent": agent, "convId": conv_id}

def _pad_slots(raw) -> list[dict]:
    out = []
    src = raw if isinstance(raw, list) else []
    for i in range(MAX_SLOTS):
        s = src[i] if i < len(src) else None
        out.append(_normalize_slot(s, i))
    return out

def _load_slot_state() -> tuple[list[dict], int]:
    try:
        if SLOTS_PATH.exists():
            data = json.loads(SLOTS_PATH.read_text())
            if isinstance(data, dict):
                slots = _pad_slots(data.get("slots"))
                active = int(data.get("activeSlot", 0))
                return slots, max(0, min(active, MAX_SLOTS - 1))
    except Exception:
        pass
    return _default_slots(), 0

def _load_slots() -> list[dict]:
    return _load_slot_state()[0]

def _save_slots(slots: list[dict], active_slot: int = 0) -> list[dict]:
    cleaned = _pad_slots(slots)
    active = max(0, min(active_slot, MAX_SLOTS - 1))
    SLOTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SLOTS_PATH.write_text(json.dumps({"slots": cleaned, "activeSlot": active}, indent=2))
    return cleaned


@router.get("/api/slots")
async def slots_get():
    slots, active = _load_slot_state()
    return JSONResponse({"slots": slots, "activeSlot": active})


@router.put("/api/slots")
async def slots_put(request: Request, payload: dict = Body(...)):
    incoming = payload.get("slots")
    if not isinstance(incoming, list):
        return JSONResponse({"error": "slots must be a list"}, status_code=400)
    active_slot = int(payload.get("activeSlot", 0) or 0)
    saved = _save_slots(incoming, active_slot)
    source = str(payload.get("source") or "")
    ua = request.headers.get("user-agent", "")[:80]
    print(f"[SLOTS PUT] source={source!r} ua={ua!r} activeSlot={active_slot} slots={[s.get('convId','') for s in saved]}", flush=True)
    # Andere Clients live informieren — Desktop ↔ Mobile bleiben synchron
    try:
        from streaming import _broadcast
        await _broadcast(json.dumps({
            "type": "slots.update",
            "slots": saved,
            "activeSlot": active_slot,
            "source": source,
        }))
    except Exception:
        pass
    return JSONResponse({"slots": saved, "activeSlot": active_slot})


# ── Link Preview (Opengraph) ──
_link_preview_cache: dict[str, tuple[float, dict]] = {}
_LINK_PREVIEW_TTL = 24 * 3600  # 24h


def _extract_og(html: str, base_url: str) -> dict:
    from urllib.parse import urljoin
    def find_meta(prop: str) -> str | None:
        pat = _re.compile(
            rf'<meta[^>]*(?:property|name)=["\']{_re.escape(prop)}["\'][^>]*content=["\']([^"\']+)["\']',
            _re.IGNORECASE)
        m = pat.search(html)
        if m: return m.group(1)
        pat2 = _re.compile(
            rf'<meta[^>]*content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']{_re.escape(prop)}["\']',
            _re.IGNORECASE)
        m = pat2.search(html)
        return m.group(1) if m else None

    title = find_meta("og:title") or find_meta("twitter:title")
    if not title:
        m = _re.search(r"<title[^>]*>([^<]+)</title>", html, _re.IGNORECASE)
        title = m.group(1).strip() if m else None
    desc = find_meta("og:description") or find_meta("twitter:description") or find_meta("description")
    image = find_meta("og:image") or find_meta("twitter:image")
    site = find_meta("og:site_name")
    if image and not image.startswith(("http://", "https://")):
        image = urljoin(base_url, image)
    return {
        "title": (title or "").strip()[:200] or None,
        "description": (desc or "").strip()[:400] or None,
        "image": image or None,
        "site": (site or "").strip()[:80] or None,
    }


@router.get("/api/link-preview")
async def link_preview(url: str):
    if not url.startswith(("http://", "https://")):
        return JSONResponse({"error": "invalid url"}, status_code=400)
    now = time.time()
    cached = _link_preview_cache.get(url)
    if cached and (now - cached[0]) < _LINK_PREVIEW_TTL:
        return JSONResponse(cached[1])
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=6.0,
                                     headers={"User-Agent": "Mozilla/5.0 AgentControl-LinkPreview/1.0"}) as client:
            r = await client.get(url)
            ct = r.headers.get("content-type", "")
            if "text/html" not in ct and "application/xhtml" not in ct:
                data = {"title": None, "description": None, "image": None, "site": None, "url": url, "contentType": ct}
            else:
                data = _extract_og(r.text[:200_000], str(r.url))
                data["url"] = str(r.url)
        _link_preview_cache[url] = (now, data)
        return JSONResponse(data)
    except Exception as e:
        err = {"error": str(e)[:120], "url": url}
        return JSONResponse(err, status_code=200)
