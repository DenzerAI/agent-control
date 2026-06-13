"""Chatagent: health checks for the Agent Control chat surface."""
from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from fastapi import APIRouter, Body
    from fastapi.responses import JSONResponse
except ModuleNotFoundError:
    APIRouter = None
    def Body(default=None):
        return default

    def JSONResponse(content):
        return content

    class _DummyRouter:
        def get(self, *_args, **_kwargs):
            def deco(fn):
                return fn
            return deco

        def post(self, *_args, **_kwargs):
            def deco(fn):
                return fn
            return deco

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

router = APIRouter() if APIRouter else _DummyRouter()
TZ = ZoneInfo("Europe/Berlin")
CLIENT_METRICS_PATH = PROJECT_ROOT / "data" / "chatagent" / "client-metrics.json"
CHATAGENT_STATE_PATH = PROJECT_ROOT / "data" / "chatagent" / "state.json"


@dataclass
class Check:
    id: str
    label: str
    status: str
    detail: str
    value: str = ""
    impact: str = ""
    action: str = ""
    attention: bool = False

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "detail": self.detail,
            "value": self.value,
            "impact": self.impact,
            "action": self.action,
            "attention": self.attention,
        }


def _read(path: Path, limit: int | None = None) -> str:
    try:
        if limit and path.exists() and path.stat().st_size > limit:
            with path.open("rb") as f:
                f.seek(-limit, 2)
                return f.read().decode("utf-8", errors="replace")
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _size_mb(path: Path) -> float:
    try:
        return path.stat().st_size / 1024 / 1024
    except Exception:
        return 0.0


def _dir_size_mb(path: Path) -> float:
    if not path.exists():
        return 0.0
    total = 0
    for fp in path.rglob("*"):
        try:
            if fp.is_file():
                total += fp.stat().st_size
        except Exception:
            pass
    return total / 1024 / 1024


def _status_from_count(value: int, warn: int, critical: int) -> str:
    if value >= critical:
        return "critical"
    if value >= warn:
        return "warn"
    return "ok"


def _interval_count(source: str) -> int:
    return len(re.findall(r"\b(?:window\.)?setInterval\s*\(", source))


def _since_last_server_start(text: str) -> str:
    marker = "Started server process"
    idx = text.rfind(marker)
    if idx < 0:
        return text
    return text[idx:]


def _recent_log_noise_metrics() -> dict:
    err_tail = _since_last_server_start(_read(PROJECT_ROOT / "logs" / "server.err.log", limit=800_000))
    log_tail = _since_last_server_start(_read(PROJECT_ROOT / "logs" / "server.log", limit=800_000))
    text = err_tail + "\n" + log_tail
    ws_keepalive = len(re.findall(r"websockets\.exceptions\.ConnectionClosedError: .*keepalive ping timeout", text, re.I))
    ws_disconnects = len(re.findall(r"\bWebSocketDisconnect\b", text, re.I))
    duplicate_sends = len(re.findall(r"\bduplicate\b", text, re.I))
    tracebacks = len(re.findall(r"Traceback \(most recent call last\):", text))
    raw_hits = len(re.findall(r"(keepalive ping timeout|WebSocketDisconnect|duplicate|Exception|Traceback)", text, re.I))
    other_tracebacks = max(0, tracebacks - ws_keepalive)
    incidents = ws_keepalive + ws_disconnects + duplicate_sends + other_tracebacks
    return {
        "incidents": incidents,
        "rawHits": raw_hits,
        "wsKeepalive": ws_keepalive,
        "wsDisconnects": ws_disconnects,
        "duplicateSends": duplicate_sends,
        "otherTracebacks": other_tracebacks,
    }


def _load_chatagent_state() -> dict:
    try:
        data = json.loads(CHATAGENT_STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_chatagent_state(state: dict) -> None:
    CHATAGENT_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CHATAGENT_STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _noise_dedupe_key(metrics: dict, status: str) -> str:
    def bucket(value: int, size: int) -> int:
        return (int(value) // size) * size

    return (
        f"{status}:"
        f"wsk{bucket(metrics.get('wsKeepalive', 0), 10)}:"
        f"wsd{bucket(metrics.get('wsDisconnects', 0), 10)}:"
        f"dup{bucket(metrics.get('duplicateSends', 0), 10)}:"
        f"tr{bucket(metrics.get('otherTracebacks', 0), 5)}"
    )


def _format_recent_noise_ping(metrics: dict, status: str) -> str:
    incidents = int(metrics.get("incidents") or 0)
    raw_hits = int(metrics.get("rawHits") or 0)
    needs_christian = "Nein"
    if int(metrics.get("otherTracebacks") or 0) > 0 or int(metrics.get("duplicateSends") or 0) > 0:
        needs_christian = "Vielleicht, wenn die Reparaturspur nicht eindeutig bleibt"
    return (
        "**Chatagent-Hinweis: WebSocket-Rauschen gebündelt**\n\n"
        f"**Was:** {incidents} echte Vorfälle seit Serverstart "
        f"({metrics.get('wsKeepalive', 0)} Keepalive-Abbrüche, "
        f"{metrics.get('wsDisconnects', 0)} Disconnects, "
        f"{metrics.get('duplicateSends', 0)} Duplikate, "
        f"{metrics.get('otherTracebacks', 0)} andere Tracebacks). "
        f"Vorher wären daraus {raw_hits} Worttreffer geworden.\n\n"
        f"**Status:** {status}. **Muss Christian eingreifen?** {needs_christian}.\n\n"
        "**Gemacht:** Als ein Werkstatt-Signal gebündelt; gleiche Lage wird nicht erneut gepingt.\n\n"
        "**Nächste Spur:** Reconnect-Quelle prüfen und bei Wiederholung Socket sauberer schließen oder drosseln."
    )


def _maybe_post_recent_log_noise(metrics: dict, status: str) -> dict:
    incidents = int(metrics.get("incidents") or 0)
    if status != "critical" or incidents <= 0:
        return {"posted": False, "reason": "below-klaus-channel-threshold"}

    key = _noise_dedupe_key(metrics, status)
    state = _load_chatagent_state()
    noise_state = state.get("recentLogNoise") if isinstance(state.get("recentLogNoise"), dict) else {}
    if noise_state.get("lastKey") == key:
        return {"posted": False, "reason": "state-dedup-hit", "key": key}

    try:
        from modules.klaus_channel.core import post

        result = post(
            text=_format_recent_noise_ping(metrics, status),
            source="chatagent",
            dedupe_key=f"recent-log-noise:{key}",
            cooldown_sec=6 * 3600,
        )
    except Exception as e:
        return {"posted": False, "reason": f"klaus-channel-error:{type(e).__name__}"}

    if result.get("posted"):
        state["recentLogNoise"] = {
            "lastKey": key,
            "lastPostedAt": time.time(),
            "lastIncidents": incidents,
            "lastRawHits": int(metrics.get("rawHits") or 0),
        }
        _save_chatagent_state(state)
    return result


def _runtime_metrics() -> dict:
    try:
        import streaming

        sessions = getattr(streaming, "_stream_sessions", {})
        return {
            "connectedClients": len(getattr(streaming, "_connected_clients", [])),
            "activeProcesses": len(getattr(streaming, "_active_procs", {})),
            "activeTasks": len(getattr(streaming, "_active_tasks", {})),
            "streamSessions": len(sessions),
            "streamSubscribers": sum(len(sess.get("subscribers", [])) for sess in sessions.values()),
        }
    except Exception:
        return {
            "connectedClients": 0,
            "activeProcesses": 0,
            "activeTasks": 0,
            "streamSessions": 0,
            "streamSubscribers": 0,
        }


def _client_metrics_payload() -> dict:
    try:
        return json.loads(CLIENT_METRICS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _iso_ts(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * pct)))
    return ordered[idx]


def _responsiveness_metrics() -> dict:
    payload = _client_metrics_payload()
    events = payload.get("events") if isinstance(payload, dict) else []
    if not isinstance(events, list):
        events = []
    clean = [e for e in events if isinstance(e, dict) and isinstance(e.get("stage"), str)]
    latest_ts = max((_iso_ts(str(e.get("at") or "")) for e in clean), default=0.0)
    age_sec = int(max(0, time.time() - latest_ts)) if latest_ts else None
    fresh = age_sec is not None and age_sec <= 10 * 60

    switch_stages = {"chat.switch.external", "chat.switch.event", "chat.load.conversation"}
    visible_stage = "messages.visible"
    switch_to_visible: list[float] = []
    empty_before_db = 0
    stream_done = 0
    visual_done = 0

    for idx, event in enumerate(clean):
        stage = event.get("stage")
        if stage == "chat.show.empty-before-db":
            empty_before_db += 1
        elif stage == "ws.agent.done":
            stream_done += 1
        elif stage == "visual.done.finalize":
            visual_done += 1
        if stage not in switch_stages:
            continue
        page_id = event.get("pageId")
        conv_id = event.get("conversationId")
        start_t = event.get("t")
        if not isinstance(start_t, (int, float)):
            continue
        for later in clean[idx + 1:]:
            if later.get("stage") != visible_stage:
                continue
            if page_id and later.get("pageId") != page_id:
                continue
            if conv_id and later.get("conversationId") != conv_id:
                continue
            end_t = later.get("t")
            if isinstance(end_t, (int, float)) and end_t >= start_t:
                switch_to_visible.append(float(end_t - start_t))
            break

    samples = len(switch_to_visible)
    p95 = _percentile(switch_to_visible, 0.95)
    median = _percentile(switch_to_visible, 0.50)
    if not clean:
        status = "warn"
        label = "Noch nicht gemessen"
        detail = "Es liegt noch keine Frontend-Timeline vor."
        value = "keine Daten"
    elif not fresh:
        status = "warn"
        label = "Messung alt"
        detail = "Die letzte Responsiveness-Messung ist nicht frisch."
        value = f"vor {age_sec // 60}min" if age_sec is not None else "alt"
    elif samples == 0:
        status = "warn"
        label = "Noch kein Chatwechsel"
        detail = "Frontend misst, aber seitdem wurde kein auswertbarer Chatwechsel gesehen."
        value = "0 Samples"
    elif p95 >= 900:
        status = "critical"
        label = "Spürbar träge"
        detail = "Chatwechsel brauchen bis zum sichtbaren Text zu lange."
        value = f"{int(p95)} ms"
    elif p95 >= 450 or empty_before_db >= max(2, samples):
        status = "warn"
        label = "Etwas träge"
        detail = "Die Oberfläche ist nicht kaputt, aber der Wechsel fühlt sich messbar zäh an."
        value = f"{int(p95)} ms"
    else:
        status = "ok"
        label = "Reagiert sauber"
        detail = "Chatwechsel bis sichtbarer Text sind im grünen Bereich."
        value = f"{int(p95)} ms"

    return {
        "status": status,
        "label": label,
        "detail": detail,
        "value": value,
        "ageSec": age_sec,
        "samples": samples,
        "switchToVisibleMedianMs": int(median) if samples else None,
        "switchToVisibleP95Ms": int(p95) if samples else None,
        "emptyBeforeDb": empty_before_db,
        "streamDone": stream_done,
        "visualDone": visual_done,
        "fresh": fresh,
    }


def build_chatagent_report() -> dict:
    frontend = PROJECT_ROOT / "frontend" / "src"
    chat_pane = _read(frontend / "components" / "ChatPane.tsx")
    chat = _read(frontend / "components" / "Chat.tsx")
    app = _read(frontend / "App.tsx")
    mobile = _read(frontend / "MobileApp.tsx")
    info_pane = _read(frontend / "components" / "InfoPane.tsx")
    ws_hub = _read(frontend / "lib" / "wsHub.ts")
    package_json = _read(PROJECT_ROOT / "frontend" / "package.json")

    checks: list[Check] = []

    ws_ok = "acquireWsHub" in chat_pane and "new WebSocket" not in chat_pane and bool(ws_hub)
    checks.append(Check(
        "single_ws_hub",
        "Ein WebSocket pro Tab",
        "ok" if ws_ok else "critical",
        "ChatPane nutzt den geteilten wsHub." if ws_ok else "ChatPane öffnet wahrscheinlich wieder eigene WebSockets.",
        impact="Verhindert doppelte Streams und doppelte Nachrichten.",
        action="Klaus muss den Socket-Pfad reparieren." if not ws_ok else "Keine Aktion nötig.",
        attention=not ws_ok,
    ))

    stable_handler = "handleWsMessageRef.current" in chat_pane and "onMessage: (m) => handleWsMessageRef.current(m)" in chat_pane
    checks.append(Check(
        "stable_ws_handler",
        "Stabiler WS-Handler",
        "ok" if stable_handler else "critical",
        "Handler bleibt über Streams hinweg stabil." if stable_handler else "Handler könnte bei jedem Token neu gebunden werden.",
        impact="Verhindert Stream-Abbrüche und verpasste Tokens.",
        action="Klaus muss die Handler-Bindung reparieren." if not stable_handler else "Keine Aktion nötig.",
        attention=not stable_handler,
    ))

    markdown_memo = "function AgentTextBlock" in chat and "useMemo" in chat[chat.find("function AgentTextBlock"): chat.find("function AgentTextBlock") + 2600]
    checks.append(Check(
        "markdown_memo",
        "Markdown nicht pro Frame neu rechnen",
        "ok" if markdown_memo else "critical",
        "AgentTextBlock memoisert die Markdown-Pipeline." if markdown_memo else "Streaming kann Marked/DOMPurify wieder pro Frame rechnen.",
        impact="Schützt lange Antworten vor Ruckeln.",
        action="Klaus muss die Markdown-Berechnung aus dem Token-Takt nehmen." if not markdown_memo else "Keine Aktion nötig.",
        attention=not markdown_memo,
    ))

    query_scans = chat.count("querySelectorAll")
    checks.append(Check(
        "dom_scans",
        "DOM-Scans im Chat",
        _status_from_count(query_scans, 5, 10),
        "Einige Nachbearbeitungen suchen noch im sichtbaren Chat, laufen aber nach Render-Änderungen und sind kein akuter Fehler." if query_scans >= 3 else "DOM-Walks sind niedrig.",
        str(query_scans),
        impact="Kann bei sehr langen Chats etwas Last erzeugen.",
        action="Später gezielt entschärfen; Christian muss nichts tun.",
        attention=False,
    ))

    message_index_key = bool(re.search(r"messages\.map\(\(m,\s*i\).*?key=\{i\}", chat, re.S))
    checks.append(Check(
        "message_keys",
        "Stabile Message-Keys",
        "warn" if message_index_key else "ok",
        "Message-Liste nutzt noch Index-Keys; das bleibt ein Render-Risiko." if message_index_key else "Message-Liste nutzt keine offensichtlichen Index-Keys.",
        impact="Instabile Keys können alte Bubbles neu aufbauen.",
        action="Klaus sollte das reparieren, bevor weiter am Rendering gearbeitet wird." if message_index_key else "Keine Aktion nötig.",
        attention=message_index_key,
    ))

    chat_intervals = _interval_count(chat_pane)
    total_intervals = (
        _interval_count(app)
        + _interval_count(mobile)
        + _interval_count(info_pane)
        + chat_intervals
    )
    polling_status = "critical" if chat_intervals >= 8 or total_intervals >= 32 else "warn" if chat_intervals >= 4 or total_intervals >= 22 else "ok"
    checks.append(Check(
        "polling_pressure",
        "Polling-Druck",
        polling_status,
        (
            f"{chat_intervals} Timer im ChatPane, {total_intervals} Timer insgesamt; "
            "das ist derzeit Wartungslast, kein akuter Chat-Fehler."
        ) if polling_status != "ok" else "Polling wirkt begrenzt.",
        f"{chat_intervals}/{total_intervals}",
        impact="Zu viel Polling kann Akku und Mobilgefühl belasten.",
        action="Klaus dünnt das bei Gelegenheit aus; Christian muss nichts tun.",
        attention=polling_status == "critical",
    ))

    runtime = _runtime_metrics()
    active_processes = int(runtime["activeProcesses"])
    active_tasks = int(runtime["activeTasks"])
    stream_sessions = int(runtime["streamSessions"])
    active_entries = active_processes + active_tasks
    expected_entries = max(4, stream_sessions * 2)
    overloaded_runtime = active_entries > expected_entries
    extra_sessions = stream_sessions > 4
    runtime_status = "critical" if overloaded_runtime else "warn" if extra_sessions else "ok"
    checks.append(Check(
        "runtime_streams",
        "Aktive Streams",
        runtime_status,
        (
            f"{active_entries} Prozess/Task-Einträge bei {stream_sessions} Stream-Sessions; "
            "das passt zum Multi-Chat-Betrieb."
        ) if not overloaded_runtime else (
            f"{active_entries} Prozess/Task-Einträge bei {stream_sessions} Stream-Sessions; "
            "das ist mehr als der Chat erklären kann."
        ),
        f"{active_entries}/{stream_sessions}",
        impact="Viele aktive Streams können Antworten blockieren.",
        action="Klaus muss hängen gebliebene Streams prüfen." if overloaded_runtime else "Keine Aktion nötig.",
        attention=overloaded_runtime,
    ))

    server_log_mb = _size_mb(PROJECT_ROOT / "logs" / "server.log")
    recent_noise = _recent_log_noise_metrics()
    recent_incidents = int(recent_noise["incidents"])
    log_noise_status = _status_from_count(recent_incidents, 8, 24)
    log_noise_detail = (
        f"{recent_noise['wsKeepalive']} WebSocket-Keepalive-Abbrüche, "
        f"{recent_noise['wsDisconnects']} Disconnects, "
        f"{recent_noise['duplicateSends']} Duplikate, "
        f"{recent_noise['otherTracebacks']} andere Tracebacks. "
        f"Rohrauschen: {recent_noise['rawHits']} Treffer."
    )
    checks.append(Check(
        "recent_log_noise",
        "Recent Log Noise",
        log_noise_status,
        log_noise_detail if recent_incidents else "Seit dem letzten Serverstart keine laute Häufung.",
        str(recent_incidents),
        impact="Zählt echte Vorfälle statt jedes Wort im Stacktrace.",
        action="Reconnect-Quelle prüfen und bei Wiederholung drosseln oder sauber schließen." if log_noise_status == "critical" else "Beobachten; kein neuer Problemberg.",
        attention=log_noise_status == "critical",
    ))

    checks.append(Check(
        "log_size",
        "Log-Größe",
        "warn" if server_log_mb > 100 else "ok",
        "server.log ist groß; Rotation hält Debugging schneller." if server_log_mb > 100 else "server.log ist unauffällig.",
        f"{server_log_mb:.0f} MB",
        impact="Große Logs machen Diagnose langsamer.",
        action="Klaus kann Rotation aufräumen; kein Chat-Alarm.",
        attention=False,
    ))

    backup_mb = _dir_size_mb(PROJECT_ROOT / "data" / "backups")
    checks.append(Check(
        "backup_size",
        "Backup-Ballast",
        "warn" if backup_mb > 300 else "ok",
        "Alte Backups belasten die Arbeitsfläche, sind aber kein Chat-Blocker." if backup_mb > 300 else "Backup-Ordner ist unauffällig.",
        f"{backup_mb:.0f} MB",
        impact="Nur Speicher- und Wartungslast.",
        action="Später aufräumen; kein Chat-Alarm.",
        attention=False,
    ))

    shader_dep = "@paper-design/shaders-react" in package_json
    shader_imports = 0
    if shader_dep:
        for fp in frontend.rglob("*"):
            if fp.suffix in {".ts", ".tsx", ".js", ".jsx"}:
                if "@paper-design/shaders-react" in _read(fp):
                    shader_imports += 1
    checks.append(Check(
        "unused_shader_dep",
        "Tote Frontend-Abhängigkeit",
        "warn" if shader_dep and shader_imports == 0 else "ok",
        "@paper-design/shaders-react steht in package.json, wird aber nicht importiert." if shader_dep and shader_imports == 0 else "Keine offensichtliche tote Shader-Abhängigkeit.",
        str(shader_imports),
        impact="Kann Bundle und Installationen unnötig schwer machen.",
        action="Bei Bundle-Pflege entfernen; kein Chat-Alarm.",
        attention=False,
    ))

    responsiveness = _responsiveness_metrics()
    checks.append(Check(
        "responsiveness",
        "Gefühlte Trägheit",
        responsiveness["status"],
        responsiveness["detail"],
        responsiveness["value"],
        impact="Misst Chatwechsel bis sichtbarer Text statt nur Systemgesundheit.",
        action="Einmal Chat wechseln oder Mobile neu öffnen, dann erneut prüfen." if responsiveness["status"] != "ok" else "Keine Aktion nötig.",
        attention=responsiveness["status"] == "critical",
    ))

    critical = sum(1 for c in checks if c.status == "critical")
    warnings = sum(1 for c in checks if c.status == "warn")
    attention_checks = [c for c in checks if c.attention]
    maintenance = sum(1 for c in checks if c.status == "warn" and not c.attention)
    score = max(0, 100 - critical * 24 - warnings * 3 - maintenance * 2)
    status = "critical" if any(c.status == "critical" and c.attention for c in checks) else "warn" if attention_checks else "ok"

    if status == "critical":
        attention = {
            "level": "christian" if any(c.id in {"runtime_streams"} for c in attention_checks) else "klaus",
            "label": "Handlung nötig",
            "detail": "Ein echter Chat-Blocker ist sichtbar. Klaus sollte das direkt prüfen.",
        }
    elif attention_checks:
        attention = {
            "level": "klaus",
            "label": "Klaus prüft",
            "detail": "Es gibt einen technischen Hinweis, aber Christian muss nichts entscheiden.",
        }
    else:
        attention = {
            "level": "none",
            "label": "Keine Aktion nötig",
            "detail": "Der Chat wirkt stabil. Offene Punkte sind Wartung, kein Alarm.",
        }

    next_actions = []
    if responsiveness["status"] != "ok":
        next_actions.append("Responsiveness messen: einmal Chat wechseln oder Mobile neu öffnen und Chatagent erneut prüfen.")
    if any(c.id == "message_keys" and c.status != "ok" for c in checks):
        next_actions.append("Message-Keys stabilisieren, damit alte Bubbles beim Stream nicht neu gemountet werden.")
    if any(c.id == "dom_scans" and c.status != "ok" for c in checks):
        next_actions.append("DOM-Scans aus dem Token-Pfad nehmen oder auf fertige Antworten begrenzen.")
    if any(c.id == "polling_pressure" and c.status != "ok" for c in checks):
        next_actions.append("Push als Wahrheit behalten, Polling weiter als seltenes Fallback ausdünnen.")
    if any(c.id in {"log_size", "backup_size"} and c.status != "ok" for c in checks):
        next_actions.append("Log- und Backup-Rotation aktivieren, damit Wartung nicht träge wird.")
    if any(c.id == "unused_shader_dep" and c.status != "ok" for c in checks):
        next_actions.append("Nicht genutzte Shader-Abhängigkeit entfernen und Bundle prüfen.")

    if not next_actions:
        next_actions.append("Keine Sofortmaßnahme nötig; weiter beobachten.")

    return {
        "generatedAt": datetime.now(TZ).isoformat(),
        "score": score,
        "status": status,
        "actionRequired": attention["level"] != "none",
        "attention": attention,
        "summary": {
            "critical": critical,
            "warnings": warnings,
            "maintenance": maintenance,
            "ok": sum(1 for c in checks if c.status == "ok"),
            "verdict": "Chat läuft. Wartung offen, kein Alarm." if status == "ok" and warnings else "Chat braucht Aufmerksamkeit." if status == "critical" else "Chat wirkt gesund.",
        },
        "runtime": runtime,
        "responsiveness": responsiveness,
        "checks": [c.as_dict() for c in checks],
        "nextActions": next_actions[:5],
    }


@router.get("/api/chatagent/status")
async def chatagent_status():
    return JSONResponse(build_chatagent_report())


@router.post("/api/chatagent/run")
async def chatagent_run():
    path = PROJECT_ROOT / "data" / "chatagent" / "latest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    report = build_chatagent_report()
    recent_noise = _recent_log_noise_metrics()
    recent_status = _status_from_count(int(recent_noise["incidents"]), 8, 24)
    report["automation"] = {
        "recentLogNoise": _maybe_post_recent_log_noise(recent_noise, recent_status),
    }
    report["savedAt"] = time.time()
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONResponse(report)


@router.post("/api/chatagent/client-metrics")
async def chatagent_client_metrics(payload: dict = Body(...)):
    events = payload.get("events") if isinstance(payload, dict) else []
    if not isinstance(events, list):
        events = []
    slim_events = []
    allowed_keys = {
        "at", "t", "stage", "pageId", "conversationId", "paneIndex", "mobile",
        "busy", "count", "lastBot", "lastLen", "lastIncomplete",
        "sourceConversationId", "mergeLive", "scroll", "messages", "ageMs",
        "force", "attach", "clearIfIdle", "running", "textLen", "tools", "status",
    }
    for event in events[-200:]:
        if not isinstance(event, dict):
            continue
        slim_events.append({k: v for k, v in event.items() if k in allowed_keys})
    out = {
        "receivedAt": datetime.now(TZ).isoformat(),
        "url": str(payload.get("url") or "")[:300],
        "viewport": payload.get("viewport") if isinstance(payload.get("viewport"), dict) else {},
        "events": slim_events,
    }
    CLIENT_METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLIENT_METRICS_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONResponse({"ok": True, "events": len(slim_events)})
