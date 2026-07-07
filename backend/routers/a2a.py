"""Generic A2A client control for a freshly installed customer system."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/a2a", tags=["a2a"])

ROOT = Path(__file__).resolve().parents[2]
STATE_PATH = ROOT / "data" / "a2a" / "client.json"
LOG_PATH = ROOT / "data" / "a2a" / "client.log.jsonl"
MAX_LOG_LINES = 200


def _read_state() -> dict[str, Any]:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {
            "enabled": False,
            "endpoint": "",
            "label": "",
            "key": "",
            "created_at": 0,
            "updated_at": 0,
            "last_ok_at": 0,
            "last_error": "",
        }


def _write_state(state: dict[str, Any]) -> dict[str, Any]:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = int(time.time())
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return state


def _public(state: dict[str, Any]) -> dict[str, Any]:
    key = str(state.get("key") or "")
    return {
        "enabled": bool(state.get("enabled")),
        "configured": bool(state.get("endpoint") and key),
        "endpoint": state.get("endpoint") or "",
        "label": state.get("label") or "",
        "key_hint": f"{key[:6]}...{key[-4:]}" if len(key) >= 12 else "",
        "created_at": state.get("created_at") or 0,
        "updated_at": state.get("updated_at") or 0,
        "last_ok_at": state.get("last_ok_at") or 0,
        "last_error": state.get("last_error") or "",
        "log_path": str(LOG_PATH.relative_to(ROOT)),
    }


def _log(action: str, ok: bool, detail: str = "", payload: dict[str, Any] | None = None) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": int(time.time()),
        "action": action,
        "ok": bool(ok),
        "detail": detail[:500],
        "payload": payload or {},
    }
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _logs() -> list[dict[str, Any]]:
    if not LOG_PATH.exists():
        return []
    lines = LOG_PATH.read_text(encoding="utf-8", errors="ignore").splitlines()[-MAX_LOG_LINES:]
    out: list[dict[str, Any]] = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


def _rpc(endpoint: str, key: str, method: str, params: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    url = endpoint.rstrip("/")
    if not url.endswith("/a2a"):
        url += "/a2a"
    req = urllib.request.Request(
        url,
        data=json.dumps({"jsonrpc": "2.0", "id": int(time.time()), "method": method, "params": params}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "User-Agent": "agent-control-a2a-template/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


@router.get("/status")
async def status():
    return JSONResponse({"ok": True, "a2a": _public(_read_state())})


@router.get("/logs")
async def logs():
    return JSONResponse({"ok": True, "items": _logs()})


@router.post("/config")
async def configure(payload: dict = Body(default_factory=dict)):
    endpoint = str(payload.get("endpoint") or "").strip().rstrip("/")
    key = str(payload.get("key") or "").strip()
    label = str(payload.get("label") or "").strip()
    if endpoint and not endpoint.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        return JSONResponse({"ok": False, "error": "endpoint_must_be_https_or_localhost"}, status_code=400)
    state = _read_state()
    if endpoint:
        state["endpoint"] = endpoint
    if key:
        state["key"] = key
    if label:
        state["label"] = label
    if not state.get("created_at"):
        state["created_at"] = int(time.time())
    _write_state(state)
    _log("config", True, "A2A configuration updated", {"endpoint": state.get("endpoint"), "label": state.get("label")})
    return JSONResponse({"ok": True, "a2a": _public(state)})


@router.post("/enable")
async def enable():
    state = _read_state()
    if not state.get("endpoint") or not state.get("key"):
        return JSONResponse({"ok": False, "error": "a2a_not_configured"}, status_code=400)
    state["enabled"] = True
    state["last_error"] = ""
    _write_state(state)
    _log("enable", True)
    return JSONResponse({"ok": True, "a2a": _public(state)})


@router.post("/disable")
async def disable():
    state = _read_state()
    state["enabled"] = False
    _write_state(state)
    _log("disable", True)
    return JSONResponse({"ok": True, "a2a": _public(state)})


@router.post("/send")
async def send(payload: dict = Body(default_factory=dict)):
    state = _read_state()
    if not state.get("enabled"):
        return JSONResponse({"ok": False, "error": "a2a_disabled"}, status_code=400)
    text = str(payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "text_required"}, status_code=400)
    params = {
        "message": {
            "role": "user",
            "parts": [{"kind": "text", "text": text}],
        },
        "metadata": {
            "source": "agent-control-template",
            "label": state.get("label") or "",
        },
    }
    try:
        result = _rpc(str(state["endpoint"]), str(state["key"]), "message/send", params, timeout=45)
        state["last_ok_at"] = int(time.time())
        state["last_error"] = ""
        _write_state(state)
        _log("send", True, "message/send accepted", {"response_keys": sorted(result.keys())})
        return JSONResponse({"ok": True, "result": result, "a2a": _public(state)})
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        state["last_error"] = str(exc)[:500]
        _write_state(state)
        _log("send", False, state["last_error"])
        return JSONResponse({"ok": False, "error": "a2a_send_failed", "detail": state["last_error"]}, status_code=502)
