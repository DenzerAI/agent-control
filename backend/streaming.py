"""WebSocket streaming handlers for Agent Control — codex/claude/command routing."""
import json
import asyncio
import hashlib
import os
import re
import signal
import subprocess
import tempfile
import time as _time
import uuid as _uuid
from pathlib import Path
from typing import Dict, Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from db import (get_db, save_msg, insert_partial, update_partial, get_msg_content,
                get_claude_session_id, set_claude_session_id,
                get_codex_session_id, set_codex_session_id,
                get_conversation_engine, auto_title, auto_project,
                create_conversation, get_conversation, get_msgs)
from stream_helpers import transcribe_audio, build_attachment_context, linkify_file_paths, update_letzter_stand, build_time_context, build_whatsapp_project_context, build_focus_snapshot, build_context_router_context, build_focus_item_context, build_focus_quick_add_context, build_session_context, build_person_context, UPLOADS_DIR
from auth import client_ip_trusted, current_token, token_matches, monitor_token_valid
from llm_log import log_call as _log_call
from identity import build_identity_context, get_agent_display, normalize_agent_id, get_owner



_CLAUDE_MODEL_LABELS = {
    "claude-opus-4-8": "Opus 4.8",
    "claude-fable-5": "Fable 5",
    "claude-opus-4-7": "Opus 4.7",
    "claude-sonnet-4-6": "Sonnet 4.6",
}


def _claude_model_label(model: str) -> str:
    return _CLAUDE_MODEL_LABELS.get(model, model)


def _of_stream() -> str:
    try:
        return get_owner()["first_name"]
    except Exception:
        return "der Nutzer"
from engines import engine_label, normalize_model_for_engine
from engines.runtime_policy import broker_tool_context, build_claude_print_cmd, build_codex_exec_cmd

router = APIRouter()

_registered_queue_worker = None
_werkbank_disabled_conversations: set[str] = set()
_work_session_disabled_conversations: set[str] = set()
_WORK_SESSION_TOOL_BUDGET = 40
_WORK_SESSION_ORIENTATION_BUDGET = 3
_WORK_SESSION_TOKEN_BUDGET = 250_000
_EXTERNAL_NETWORK_HINTS = (
    "api.cloudflare.com",
    "cloudflare",
    "wrangler",
    "deploy",
    "deployment",
    "example.com",
    "live deploy",
    "live-deploy",
    "live-check",
    "live check",
    "live prüfen",
    "live pruefen",
    "dns",
    "externen netzwerk",
    "externe verbind",
    "internetverbindung",
    "netzwerkzugang",
    "upload nach",
    "veröffentlichen",
    "veroeffentlichen",
)


def _normalize_codex_model(raw: object) -> str:
    """Codex CLI in des Nutzers ChatGPT-Account kann keine Claude-Modelle ausführen."""
    return normalize_model_for_engine("codex", str(raw or ""))


def _work_session_needs_external_network(*parts: object) -> bool:
    text = "\n".join(str(p or "") for p in parts).lower()
    return any(hint in text for hint in _EXTERNAL_NETWORK_HINTS)


def start_queue_worker():
    """Startet den Background-Queue-Worker. Muss im FastAPI-Startup-Kontext aufgerufen werden."""
    if _registered_queue_worker:
        asyncio.create_task(_registered_queue_worker())

_CODE_PATH_RE = re.compile(r"(?:^|[\s(])(?:backend|frontend|scripts|modules|work|jobs|config|data|logs|soul|brain)/\S+")
_CODE_FILE_RE = re.compile(r"\b[\w./-]+\.(?:py|ts|tsx|js|jsx|json|css|html|sql|sh|yml|yaml|md)\b")
_DUAL_SKIP_HINTS = (
    "whatsapp",
    "mail",
    "e-mail",
    "email",
    "caption",
    "instagram",
    "linkedin",
    "formulier",
    "umformulieren",
    "schreib mir",
    "antworte",
    "zusammenfassen",
    "zusammenfassung",
    "übersetzen",
    "benenn diesen chat um",
    "benenn um",
    "umbenennen",
    "umbenenne",
    "rename",
    "merge",
    "mergen",
    "merg die",
    "lösch",
    "loesche",
    "delete",
    "entferne",
    "trag ein",
    "trage ein",
    "trag in",
    "termin",
    "kalender",
    "schick ",
    "send ",
    "send mal",
    "verschick",
    "abschick",
    "starte neu",
    "start neu",
    "restart",
    "kickstart",
    "öffne ",
    "oeffne ",
    "open ",
    "zeig mir",
    "zeig das",
    "show me",
    "lade hoch",
    "lade runter",
    "download",
    "upload",
    "guten morgen",
    "gute nacht",
    "feierabend",
    "danke",
    "passt",
    " ok ",
    "okay",
    "stopp",
    "stop",
    "halt an",
    "halt mal",
    "commit",
    "push",
    "pull rebase",
    "gh pr",
    "danke dir",
    "perfekt",
    "passt so",
    "merk dir",
    "speicher das",
    "vergiss",
)
# Planungs-/Architektur-Hints: ein Treffer hier zählt klar mehr,
# weil Two-Pass nur bei echtem Reasoning Wert bringt.
_DUAL_PLAN_HINTS = (
    "architektur",
    "konzept",
    "wie würdest du",
    "wie wuerdest du",
    "wie sollten wir",
    "wie machen wir",
    "wie machst du",
    "wie würde",
    "wie wuerde",
    "was meinst du",
    "welcher weg",
    "welche variante",
    "welcher ansatz",
    "soll ich",
    "sollen wir",
    "vorschlag",
    "design",
    "design-",
    "ansatz",
    "trade-off",
    "tradeoff",
    "abwägung",
    "abwaegung",
    "refactor",
    "refaktor",
    "umbau",
    "plan ",
    "planung",
    "strategie",
    "alternative",
    "alternativen",
    "vergleich",
    "pro und contra",
    "risiko",
    "risiken",
    "edge case",
    "edgecase",
    "fallback",
    "wie löse",
    "wie loese",
    "warum nicht",
    "warum so",
    "review",
    "audit",
)
_DUAL_TECH_HINTS = (
    "code",
    "codex",
    "claude code",
    "frontend",
    "backend",
    "api",
    "endpoint",
    "component",
    "komponente",
    "hook",
    "typescript",
    "javascript",
    "python",
    "react",
    "vite",
    "tailwind",
    "websocket",
    "stream",
    "streaming",
    "reconnect",
    "hard refresh",
    "reload",
    "server",
    "build",
    "compile",
    "kompil",
    "test",
    "tests",
    "bug",
    "fehler",
    "crash",
    "exception",
    "traceback",
    "stacktrace",
    "ui",
    "svg",
    "animation",
    "funktion",
    "feature",
    "migration",
    "datenbank",
    "sqlite",
    "chatpane",
    "composer",
)
_DUAL_ACTION_HINTS = (
    "fix",
    "baue",
    "bauen",
    "implement",
    "umsetzen",
    "patch",
    "refactor",
    "refaktor",
    "debug",
    "prüf",
    "pruef",
    "such",
    "ändere",
    "aendere",
    "erweitere",
    "optimiere",
    "teste",
)


# Module-level client set + broadcast for cross-module use
_connected_clients: set = set()

# Dedupe: gleiche clientMessageId innerhalb von TTL nur einmal verarbeiten.
# Frontend retried u.a. nach Reconnect — ohne Dedupe landet die Nachricht doppelt.
_sent_dedup: dict[str, float] = {}
_SENT_DEDUP_TTL = 120.0  # Sekunden

def _is_duplicate_send(client_msg_id: str) -> bool:
    if not client_msg_id:
        return False
    now = _time.time()
    # opportunistisches Aufräumen
    if len(_sent_dedup) > 500:
        for k, exp in list(_sent_dedup.items()):
            if exp < now:
                _sent_dedup.pop(k, None)
    exp = _sent_dedup.get(client_msg_id)
    if exp and exp > now:
        return True
    _sent_dedup[client_msg_id] = now + _SENT_DEDUP_TTL
    return False

# Active subprocess per conversation — allows stop from outside
_active_procs: dict[str, asyncio.subprocess.Process] = {}
# Active stream task per conversation — wichtig fuer echtes Stoppen auch dann,
# wenn gerade kein direkt getrackter Hauptprozess lesbar blockiert.
_active_tasks: dict[str, asyncio.Task] = {}
# Conversations mit explizitem Stop-Request. Verhindert, dass ein abgewuergter
# Lauf am Ende noch als "ok" gespeichert oder gebroadcastet wird.
_stop_requests: set[str] = set()
# Wall-clock start time (epoch seconds) per conversation. Parallel zu _active_procs,
# damit Mobile/Desktop denselben echten Start kennen, nicht erst ihre Wahrnehmungszeit.
_active_started_at: dict[str, float] = {}

# Harter Wall-Clock-Deckel pro Lauf, zusaetzlich zum Idle-Timeout. Faengt Engine-Laeufe,
# die endlos Output produzieren ohne je fertig zu werden (Codex-Dauerlauf-Bug).
_MAX_WALL_SECONDS = float(os.environ.get("ENGINE_MAX_WALL_SECONDS", "1500"))  # 25 min

# Stream sessions per conversation. Hält den Live-Snapshot eines laufenden
# Streams plus die Liste der WS-Subscribers, sodass ein Hard-Refresh-Client per
# `attach`-Action wieder reinkommt und die laufenden Tool-Calls + Text mitliest.
_stream_sessions: dict[str, dict] = {}

# Dedupe identischer User-Eingaben pro conv_id innerhalb eines kurzen Fensters.
# Bug: Frontend feuert manchmal denselben Send zweimal in Folge — Engine läuft
# dann doppelt. Hier wird der zweite Aufruf verworfen.
_USER_INPUT_DEDUPE_WINDOW = 10.0
_recent_user_inputs: dict[str, tuple[str, float]] = {}


def _should_drop_duplicate_user_input(conv_id: str, message: str) -> bool:
    if not conv_id or not message:
        return False
    now = _time.time()
    prev = _recent_user_inputs.get(conv_id)
    if prev and prev[0] == message and (now - prev[1]) < _USER_INPUT_DEDUPE_WINDOW:
        return True
    _recent_user_inputs[conv_id] = (message, now)
    return False


# Dedupe fuer den vorgelagerten Pane-Input (/api/pane-input und /api/deck/pane-input).
# Shortcuts/Cloudflows senden gelegentlich denselben HTTP-Request mehrfach; hier
# stoppen wir das, bevor mehrere Browserfenster daraus Chat-Sends machen.
_PANE_INPUT_DEDUPE_WINDOW = 45.0
_recent_pane_inputs: dict[str, float] = {}


def should_drop_duplicate_pane_input(pane: int, text: str) -> bool:
    clean = re.sub(r"\s+", " ", (text or "").strip())
    if not pane or not clean:
        return False
    now = _time.time()
    if len(_recent_pane_inputs) > 200:
        for k, exp in list(_recent_pane_inputs.items()):
            if exp < now:
                _recent_pane_inputs.pop(k, None)
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()
    key = f"{pane}:{digest}"
    exp = _recent_pane_inputs.get(key)
    if exp and exp > now:
        return True
    _recent_pane_inputs[key] = now + _PANE_INPUT_DEDUPE_WINDOW
    return False


def _start_stream_session(conv_id: str, agent_id: str, agent_display: str, origin: WebSocket | None) -> dict:
    """Reset oder lege Bus für conv_id an. Beim Restart wird ein evtl. veralteter
    Bus überschrieben — der vorherige Stream sollte ohnehin fertig sein."""
    if not conv_id:
        return {}
    started_at = _time.time()
    _active_started_at[conv_id] = started_at
    sess = {
        "agent_id": agent_id,
        "agent_display": agent_display,
        "started_at": started_at,
        "subscribers": set(),
        "snapshot": {
            "full_text": "",
            "text_segments": [],
            "tool_order": [],
            "tool_calls": {},  # tool_id -> {id,name,input,result,status,output,diff_stats}
            "context_tokens": 0,
            "context_window": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "raw_input_tokens": 0,
            "cached_input_tokens": 0,
            "model": "",
            "thinking_text": "",
        },
        "done": False,
    }
    if origin is not None:
        sess["subscribers"].add(origin)
    _stream_sessions[conv_id] = sess
    return sess


def _end_stream_session(conv_id: str):
    """Stream ist fertig — Bus kann weg, Subscribers haben agent.done bereits bekommen."""
    if conv_id:
        _stream_sessions.pop(conv_id, None)


import unicodedata as _unicodedata

_RESUME_END_CHARS = {".", "!", "?", "…", '"', "»", "“", "”", "’", ")", ":"}


def _looks_complete(text: str) -> bool:
    """Heuristik: Sieht die angezeigte Antwort abgeschlossen aus?

    Resume soll nur einen echt mitten im Satz abgerissenen Text fortsetzen.
    Eine substanzielle Antwort, die auf einem Satzschlusszeichen oder Emoji
    endet, gilt als fertig und darf nicht fortgesetzt werden, sonst dupliziert
    der Fortsetz-Lauf den Schlusssatz.
    """
    t = (text or "").rstrip()
    if len(t) < 12:
        return False
    last = t[-1]
    if last in _RESUME_END_CHARS:
        return True
    try:
        if _unicodedata.category(last) in ("So", "Sk"):
            return True
    except Exception:
        pass
    return False


async def _spawn_process(*cmd, **kwargs) -> asyncio.subprocess.Process:
    """Starte Subprocess in eigener Session, damit Stop die ganze Prozessgruppe trifft."""
    if os.name != "nt":
        kwargs.setdefault("start_new_session", True)
    return await asyncio.create_subprocess_exec(*cmd, **kwargs)


async def _terminate_process(proc: asyncio.subprocess.Process | None, *, grace_seconds: float = 1.0):
    """Beende den kompletten Process-Tree robust.

    Codex spawnte unter macOS Kindprozesse weiter, wenn nur der Elternprozess
    gekillt wurde. Eigene Session + killpg behebt genau diesen Composer-Stop-Bug.
    """
    if not proc or proc.returncode is not None:
        return

    def _signal_group(sig: int) -> bool:
        if os.name == "nt":
            return False
        try:
            os.killpg(proc.pid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    try:
        sent = _signal_group(signal.SIGTERM)
        if not sent:
            proc.terminate()
    except ProcessLookupError:
        return
    except Exception:
        try:
            proc.kill()
        except Exception:
            return

    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_seconds)
        return
    except asyncio.TimeoutError:
        pass
    except ProcessLookupError:
        return

    try:
        sent = _signal_group(signal.SIGKILL)
        if not sent:
            proc.kill()
    except ProcessLookupError:
        return
    except Exception:
        return

    try:
        await asyncio.wait_for(proc.wait(), timeout=grace_seconds)
    except Exception:
        pass


async def request_stop(conv_id: str) -> bool:
    """Stoppe den laufenden Agenten einer Conversation. Genutzt vom WS-'stop'-Command
    und vom REST-Endpoint /api/deck/stop (Remote-Stop vom Handy). Gibt True zurück,
    wenn tatsächlich ein Prozess oder Task gestoppt wurde."""
    if not conv_id:
        return False
    _stop_requests.add(conv_id)
    proc = _active_procs.get(conv_id)
    task = _active_tasks.get(conv_id)
    stopped = False
    if proc and proc.returncode is None:
        stopped = True
        try:
            await _terminate_process(proc)
        except Exception:
            pass
    if task and not task.done():
        stopped = True
        try:
            task.cancel()
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
    if not stopped:
        _active_procs.pop(conv_id, None)
        _active_tasks.pop(conv_id, None)
        _active_started_at.pop(conv_id, None)
        _stop_requests.discard(conv_id)
    return stopped


def _update_snapshot(sess: dict, event: dict):
    """Update snapshot in place based on event type."""
    snap = sess["snapshot"]
    et = event.get("type", "")
    if et == "agent.text":
        full = event.get("full")
        if full is not None:
            snap["full_text"] = full
        if isinstance(event.get("segments"), list):
            snap["text_segments"] = event.get("segments", [])
    elif et == "agent.tool":
        tid = event.get("toolId", "")
        if tid:
            if tid not in snap["tool_calls"]:
                snap["tool_order"].append(tid)
                snap["tool_calls"][tid] = {
                    "id": tid,
                    "name": event.get("tool", ""),
                    "input": event.get("input") or {},
                    "result": event.get("result", ""),
                    "status": event.get("status", "running"),
                }
            else:
                # Update vorhandenen Eintrag (z. B. parsed_input nach content_block_stop)
                tc = snap["tool_calls"][tid]
                if event.get("input"):
                    tc["input"] = event["input"]
                if event.get("result"):
                    tc["result"] = event["result"]
                tc["status"] = event.get("status", tc.get("status", "running"))
                tc["name"] = event.get("tool", tc.get("name", ""))
    elif et == "agent.toolDone":
        tid = event.get("toolId", "")
        if tid and tid in snap["tool_calls"]:
            tc = snap["tool_calls"][tid]
            tc["status"] = event.get("status", "completed")
            tc["output"] = event.get("output", "")
            if event.get("diffStats") is not None:
                tc["diff_stats"] = event.get("diffStats")
    elif et == "agent.usage":
        if event.get("contextTokens") is not None:
            snap["context_tokens"] = event.get("contextTokens", 0)
        if event.get("contextWindow") is not None:
            snap["context_window"] = event.get("contextWindow", 0)
        if event.get("inputTokens") is not None:
            snap["input_tokens"] = event.get("inputTokens", 0)
        if event.get("outputTokens") is not None:
            snap["output_tokens"] = event.get("outputTokens", 0)
        if event.get("rawInputTokens") is not None:
            snap["raw_input_tokens"] = event.get("rawInputTokens", 0)
        if event.get("cachedInputTokens") is not None:
            snap["cached_input_tokens"] = event.get("cachedInputTokens", 0)
    elif et == "agent.thinking":
        delta = event.get("delta") or ""
        if delta:
            snap["thinking_text"] += delta
    elif et == "agent.done":
        sess["done"] = True
        if event.get("model"):
            snap["model"] = event.get("model")


async def _emit_event(conv_id: str, event: dict):
    """Push Event in den Bus + Broadcast an alle Subscribers."""
    if not conv_id:
        return
    sess = _stream_sessions.get(conv_id)
    if sess is None:
        return
    event["conversationId"] = conv_id
    # Sobald der finale Event rausgeht, darf /api/active-streams diesen Stream
    # nicht mehr als laufend melden. Die Stream-Session bleibt bis nach dem
    # Broadcast bestehen, damit agent.done/error noch zuverlässig ankommt.
    if event.get("type") in ("agent.done", "agent.error"):
        _active_procs.pop(conv_id, None)
        _active_tasks.pop(conv_id, None)
        _active_started_at.pop(conv_id, None)
    _update_snapshot(sess, event)
    payload = json.dumps(event)
    dead = []
    for ws in list(sess["subscribers"]):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        sess["subscribers"].discard(ws)
    # Stream-Lifecycle parallel an alle Clients, damit Slot-Pillen auch in
    # Panes ohne aktiven Subscriber sofort den Live-Zustand zeigen.
    et = event.get("type")
    if et in ("agent.start", "agent.done", "agent.error"):
        state_event = {
            "type": "stream.state",
            "conversationId": conv_id,
            "phase": "start" if et == "agent.start" else "end",
        }
        started = event.get("startedAt")
        if started:
            state_event["startedAt"] = started
        await _broadcast(json.dumps(state_event))


def _build_snapshot_event(conv_id: str) -> dict | None:
    """Bauen eines stream.snapshot-Events für einen reconnectenden Client."""
    sess = _stream_sessions.get(conv_id)
    if not sess:
        return None
    snap = sess["snapshot"]
    tools = []
    for tid in snap["tool_order"]:
        tc = snap["tool_calls"].get(tid)
        if tc:
            tools.append(tc)
    return {
        "type": "stream.snapshot",
        "conversationId": conv_id,
        "agent": sess["agent_display"],
        "agentId": sess["agent_id"],
        "fullText": snap["full_text"],
        "segments": snap.get("text_segments", []),
        "toolCalls": tools,
        "contextTokens": snap.get("context_tokens", 0),
        "contextWindow": snap.get("context_window", 0),
        "inputTokens": snap.get("input_tokens", 0),
        "outputTokens": snap.get("output_tokens", 0),
        "rawInputTokens": snap.get("raw_input_tokens", 0),
        "cachedInputTokens": snap.get("cached_input_tokens", 0),
        "thinkingText": snap.get("thinking_text", ""),
        "model": snap.get("model", ""),
        "startedAt": int(sess["started_at"] * 1000),
        "elapsedMs": int((_time.time() - sess["started_at"]) * 1000),
        "running": not sess.get("done", False),
    }


_READ_ONLY_BASH_HEADS = (
    "ls", "cat", "head", "tail", "grep", "rg", "find", "pwd", "which",
    "echo", "printf", "stat", "file", "wc", "awk", "sed -n",
    "git status", "git log", "git diff", "git show", "git blame", "git branch --show",
)

def _is_read_only_bash(cmd: str) -> bool:
    """True, wenn ein Bash-Kommando rein lesend ist (keine Quest-Würdigkeit)."""
    s = (cmd or "").strip().lstrip("(")
    if not s:
        return True
    for h in _READ_ONLY_BASH_HEADS:
        if s.startswith(h + " ") or s == h:
            return True
    return False


def _did_substantial_work(tool_calls: dict) -> bool:
    """Level-Up nur bei substanziellen Changes:
    - Bash mit nicht-lesendem Kommando → immer (commit, push, build, restart etc. haben Außenwirkung)
    - Write/Edit/NotebookEdit → Summe added+removed ≥ 10 Zeilen (filtert Mikro-Edits raus)
    """
    total_lines = 0
    for tc in tool_calls.values():
        name = (tc.get("name") or "").lower()
        if name == "bash":
            cmd = str((tc.get("parsed_input") or {}).get("command", ""))
            if not _is_read_only_bash(cmd):
                return True
        elif name in ("write", "edit", "multiedit", "notebookedit", "apply_patch", "functions.apply_patch"):
            ds = tc.get("diff_stats") or {}
            total_lines += int(ds.get("added", 0)) + int(ds.get("removed", 0))
    return total_lines >= 10


def _diff_totals(tool_calls: dict) -> dict[str, int]:
    added = 0
    removed = 0
    for tc in (tool_calls or {}).values():
        ds = tc.get("diff_stats") or {}
        try:
            added += int(ds.get("added", 0) or 0)
            removed += int(ds.get("removed", 0) or 0)
        except Exception:
            continue
    return {"added": added, "removed": removed}


def _git_diff_numstat(cwd: str) -> dict[str, tuple[int, int]]:
    try:
        proc = subprocess.run(
            ["git", "-C", cwd or ".", "diff", "--numstat"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return {}
    if proc.returncode != 0:
        return {}
    out: dict[str, tuple[int, int]] = {}
    for line in (proc.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 3 or parts[0] == "-" or parts[1] == "-":
            continue
        try:
            out[parts[2]] = (int(parts[0]), int(parts[1]))
        except Exception:
            continue
    return out


def _attach_git_diff_baseline(conv_id: str, cwd: str) -> None:
    if not conv_id:
        return
    sess = _stream_sessions.get(conv_id)
    if sess is None or "git_diff_baseline" in sess:
        return
    sess["git_diff_baseline"] = _git_diff_numstat(cwd)
    sess["git_diff_cwd"] = cwd


def _git_diff_delta(sess: dict | None, cwd: str) -> dict[str, int]:
    if not sess:
        return {"added": 0, "removed": 0}
    before = sess.get("git_diff_baseline")
    if not isinstance(before, dict):
        return {"added": 0, "removed": 0}
    after = _git_diff_numstat(cwd or str(sess.get("git_diff_cwd") or ""))
    added = 0
    removed = 0
    for path in set(before) | set(after):
        b_add, b_rem = before.get(path, (0, 0))
        a_add, a_rem = after.get(path, (0, 0))
        added += max(0, int(a_add or 0) - int(b_add or 0))
        removed += max(0, int(a_rem or 0) - int(b_rem or 0))
    return {"added": added, "removed": removed}


def _diff_totals_with_git(tool_calls: dict, sess: dict | None, cwd: str) -> dict[str, int]:
    totals = _diff_totals(tool_calls)
    git_totals = _git_diff_delta(sess, cwd)
    if (git_totals.get("added", 0) + git_totals.get("removed", 0)) > (totals.get("added", 0) + totals.get("removed", 0)):
        return git_totals
    return totals


_WERKBANK_ACTION_HINTS = (
    "bau", "baue", "bauen", "gebaut", "umsetzen", "implement", "fix", "reparier",
    "ändere", "aendere", "erweitere", "patch", "schreib", "erstelle", "erzeug",
    "generier", "mach daraus", "mach das", "überarbeite", "ueberarbeite",
    "einbau", "integrier", "migrier", "verschieb", "umbau", "refactor", "verdrahte",
)
_WERKBANK_OBJECT_HINTS = (
    "code", "frontend", "backend", "api", "endpoint", "komponente", "component",
    "html", "css", "datei", "file", "script", "modul", "workspace", "werkbank",
    "werkstatt", "layout", "ui", "responsive", "test", "build",
    "pipeline", "projekt", "nav", "navigation", "reiter", "menü", "menu",
    "kategorie", "sektion", "section", "fokus", "panel", "pane", "tab",
)
_WERKBANK_BACKGROUND_ACTION_HINTS = (
    "reinholen", "rausholen", "hole", "hol ", "holen", "zieh", "ziehe", "ziehen",
    "finde", "finden", "suche", "such ", "lies", "lese", "prüf", "pruef",
    "check", "analysier", "sammel", "bereite", "vorbereite", "klär", "klaer",
)
_WERKBANK_BACKGROUND_OBJECT_HINTS = (
    "whatsapp", "chatverlauf", "chat", "peopledb", "people-db", "daten",
    "datenquelle", "datenquellen", "lead", "termin", "kontakt", "kontakte",
    "kunde", "kunden", "person", "personen", "kontext", "crm",
)
_WERKBANK_READ_ONLY_HINTS = (
    "erklär", "erklaer", "was ist", "wie funktioniert", "zeige mir", "zeig mir",
    "suche", "recherchiere", "lies", "analysiere nur", "nur lesen",
)
_WERKBANK_DISABLE_HINTS = (
    "stopp werkbank", "stop werkbank", "keine werkbank", "kein werkbank",
    "kein werkbankauftrag", "kein neuer werkbankauftrag", "keinen werkbankauftrag",
    "kein handoff", "kein hand-off", "keine handoffs", "keine hand-offs",
    "nichts an die werkbank", "nicht an die werkbank", "nichts übergeben",
    "nichts uebergeben", "nicht übergeben", "nicht uebergeben",
    "explizit nicht in der werkbank", "explizit nicht in die werkbank",
    "nicht in der werkbank", "nicht in die werkbank", "hier bearbeiten",
)
_WERKBANK_META_HINTS = (
    "warum hast du", "das war falsch", "das war für dich", "das war fuer dich",
    "schärf deine regeln", "schaerf deine regeln", "deine regeln",
    "kümmer dich darum", "kuemmer dich darum", "dein verhalten",
    "entscheidungslogik", "bootstrap", "agents.md", "soul.md", "learning",
    "audit", "werte mal aus", "überprüfe das hier", "ueberpruefe das hier",
)
_WORK_SESSION_EXPLICIT_HINTS = (
    "arbeite im hintergrund", "im hintergrund ab", "hintergrundauftrag",
    "neue session", "eigene session", "separate session", "session spawnen",
    "spawn eine session", "starte eine session", "mach daraus einen arbeitslauf",
    "starte einen arbeitslauf", "starte eine arbeitssession",
    "starte eine arbeits-session", "starte eine worker-session",
    "worker-session", "spawn eine worker-session", "spawn eine arbeits-session",
    "starte einen arbeitscall", "starte einen arbeits-call",
    "mach daraus einen arbeitscall", "mach daraus einen arbeits-call",
    "an die werkbank", "ab an die werkbank", "geh damit an die werkbank",
    "damit an die werkbank", "geh an die werkbank", "in die werkbank damit",
    "ab in die werkbank", "schick das in die werkbank", "leg das in die werkbank",
)
_WORK_SESSION_DISCUSSION_HINTS = (
    "lass uns", "wir müssen grundsätzlich", "wir muessen grundsaetzlich",
    "darüber sprechen", "darueber sprechen", "über die werkbank sprechen",
    "ueber die werkbank sprechen", "konzept", "macht sinn", "macht noch keinen sinn",
    "glaube", "korrigiere mich", "vielleicht", "sollten wir", "wie wir",
    "weiterarbeiten", "umändern", "umaendern", "planvorarbeit", "pingpong",
)


def _werkbank_disable_requested(prompt: str) -> bool:
    lower = " " + str(prompt or "").lower() + " "
    return any(hint in lower for hint in _WERKBANK_DISABLE_HINTS)


def _werkbank_meta_or_audit(prompt: str) -> bool:
    lower = " " + str(prompt or "").lower() + " "
    return any(hint in lower for hint in _WERKBANK_META_HINTS)


_WORK_SESSION_HANDOFF_VERBS = (
    "übergib", "uebergib", "übergeb", "uebergeb", "überführ", "ueberfuehr",
    "schieb", "schick", "leg ", "legst", "pack", "gib ", "rüber", "rueber",
    "ab damit", "ab dafür", "ab dafuer", "auslagern", "auslager",
)


def _work_session_requested(prompt: str) -> bool:
    lower = " " + str(prompt or "").lower() + " "
    if any(hint in lower for hint in _WORK_SESSION_DISCUSSION_HINTS):
        return False
    if any(hint in lower for hint in _WORK_SESSION_EXPLICIT_HINTS):
        return True
    # Natuerliche Uebergabe: "werkbank" zusammen mit einem Uebergabe-Verb,
    # damit nicht nur starre Roboter-Phrasen greifen.
    if "werkbank" in lower and any(v in lower for v in _WORK_SESSION_HANDOFF_VERBS):
        return True
    return False


_WORK_SESSION_RESUME_HINTS = (
    "in derselben session", "in der selben session", "selbe session", "dieselbe session",
    "der gleichen session", "gleiche session", "in der laufenden session",
    "an die laufende session", "an die bestehende session", "bestehende session",
    "in der session weiter", "session weiterbauen", "weiterbauen in der session",
    "bau da weiter", "baut da weiter", "mach da weiter", "macht da weiter",
    "dort weiter", "da weitermachen", "an den laufenden arbeitslauf",
    "selbe werkbank", "gleiche werkbank", "session fortsetzen", "session wieder aufnehmen",
)


def _work_session_resume_requested(prompt: str) -> bool:
    lower = " " + str(prompt or "").lower() + " "
    return any(hint in lower for hint in _WORK_SESSION_RESUME_HINTS)



def _werkbank_handoff_reason(prompt: str, attachments: list | None = None, context: str = "") -> str:
    text = str(prompt or "").strip()
    if not text:
        return ""
    if _werkbank_disable_requested(text) or _werkbank_meta_or_audit(text):
        return ""
    lower = " " + text.lower() + " "
    context_lower = " " + str(context or "").lower() + " "
    has_path = bool(_CODE_PATH_RE.search(text) or _CODE_FILE_RE.search(text))
    has_inline_code = "```" in text or bool(re.search(r"`[^`]+`", text))
    action_hits = [kw for kw in _WERKBANK_ACTION_HINTS if kw in lower]
    object_hits = [kw for kw in _WERKBANK_OBJECT_HINTS if kw in lower]
    background_action_hits = [kw for kw in _WERKBANK_BACKGROUND_ACTION_HINTS if kw in lower]
    background_object_hits = [kw for kw in _WERKBANK_BACKGROUND_OBJECT_HINTS if kw in lower]
    read_only_hits = [kw for kw in _WERKBANK_READ_ONLY_HINTS if kw in lower]
    context_action_hits = [kw for kw in _WERKBANK_ACTION_HINTS if kw in context_lower]
    context_object_hits = [kw for kw in _WERKBANK_OBJECT_HINTS if kw in context_lower]
    context_background_action_hits = [kw for kw in _WERKBANK_BACKGROUND_ACTION_HINTS if kw in context_lower]
    context_background_object_hits = [kw for kw in _WERKBANK_BACKGROUND_OBJECT_HINTS if kw in context_lower]

    if background_action_hits and (background_object_hits or has_path or attachments) and len(text) >= 40:
        parts = [background_action_hits[0].strip()]
        if background_object_hits:
            parts.append(background_object_hits[0].strip())
        if has_path:
            parts.append("Pfad/Datei")
        return "Hintergrundarbeit: " + ", ".join(dict.fromkeys(parts))[:100]
    if read_only_hits and not action_hits and not has_path and not has_inline_code:
        return ""
    if lower.strip() in {"das möchte ich", "das moechte ich", "ja", "genau", "mach das", "setz das um", "baue das"}:
        if context_action_hits and context_object_hits:
            return f"Kontextauftrag: {context_action_hits[0].strip()}, {context_object_hits[0].strip()}"[:120]
        if context_background_action_hits and context_background_object_hits:
            return f"Kontext-Hintergrundarbeit: {context_background_action_hits[0].strip()}, {context_background_object_hits[0].strip()}"[:120]
    if action_hits and (object_hits or has_path or has_inline_code or len(text) >= 180):
        parts = [action_hits[0].strip()]
        if object_hits:
            parts.append(object_hits[0].strip())
        if has_path:
            parts.append("Pfad/Datei")
        if has_inline_code:
            parts.append("Code im Text")
        return ", ".join(dict.fromkeys(parts))[:120]
    if has_path and action_hits:
        return "Datei/Pfad plus Arbeitsauftrag"
    if attachments and action_hits and object_hits:
        return "Anhang plus Arbeitsauftrag"
    return ""


def _extract_werkbank_task_id(prompt: str) -> str:
    match = re.search(r"Werkbank-Task-ID:\s*([a-zA-Z0-9_-]+)", str(prompt or ""))
    return match.group(1) if match else ""


def _fallback_werkbank_title(text: str, context: str = "") -> str:
    source = re.sub(r"\s+", " ", str(text or context or "")).strip()
    lower = source.lower()
    if any(k in lower for k in ("chat-titel", "chattitel", "titel")) and any(k in lower for k in ("werkbank", "chat-pane", "chatpaint", "pane", "zugewiesen", "herkunft")):
        return "Werkbank Herkunft zeigen"
    if "werkbank" in lower and any(k in lower for k in ("detail", "nacharbeit", "manuell", "zu viel", "kacke")):
        return "Werkbank Details kürzen"
    if "werkbank" in lower and any(k in lower for k in ("footer", "tool anzeige", "unten", "zeit", "status")):
        return "Werkbank Footer beruhigen"
    source = re.sub(r"^(bitte|kannst du|mach mal|mach das|setz das)\s+", "", source, flags=re.I)
    words = [w.strip(".,;:!?()[]{}\"'`") for w in source.split()]
    stop = {
        "ich", "du", "wir", "das", "dass", "der", "die", "den", "dem", "ein", "eine", "einen",
        "und", "oder", "aber", "auch", "halt", "mal", "bitte", "jetzt", "gerade", "quasi",
        "weiß", "weisst", "meine", "mein", "was", "wie", "hier", "noch", "total",
        "dann", "frage", "mich", "habe", "hat", "haben", "mit", "aus", "ist", "sind",
        "nicht", "wirklich", "warum", "immer", "noch", "alles", "einer", "läuft",
    }
    picked = [w for w in words if len(w) > 2 and w.lower() not in stop][:5]
    if not picked:
        return "Werkbank-Auftrag"
    return " ".join(picked)[:80]


def _clean_werkbank_title(raw: str, fallback: str) -> str:
    title = re.sub(r"[\n\r\t]+", " ", str(raw or "")).strip().strip('"“”`*# ')
    title = re.sub(r"^(titel|title|arbeitsauftrag)\s*:\s*", "", title, flags=re.I)
    title = re.sub(r"\s+", " ", title)
    if not title:
        title = fallback
    title = re.sub(r"\.{2,}$", "", title).strip()
    if len(title) > 54:
        title = title[:54].rsplit(" ", 1)[0].strip() or title[:54].strip()
    return title or "Werkbank-Auftrag"


async def _werkbank_dispatch_packet(prompt: str, context: str) -> dict:
    """Verdichtet den Übergabe-Moment lokal. Fallback bleibt deterministisch."""
    fallback_title = _fallback_werkbank_title(prompt, context)
    fallback = {
        "title": fallback_title,
        "brief": re.sub(r"\s+", " ", str(prompt or "")).strip()[:1800],
        "acceptance": "Ergebnis, geänderte Dateien, Tests oder klarer Blocker werden knapp zurückgemeldet.",
        "source": "fallback",
    }
    try:
        from local_llm import call_local, is_available
        if not is_available(timeout=0.6):
            return fallback
        system = (
            "Du verdichtest Werkbank-Dispatches. Antworte nur als JSON mit title, brief, acceptance. "
            "title: 2-6 deutsche Wörter, kein Satz. brief: konkreter Arbeitsauftrag in maximal 70 Wörtern. "
            "acceptance: ein kurzer Abnahmesatz. Keine Erklärung."
        )
        user = (
            f"Rohauftrag:\n{prompt[:2200]}\n\n"
            f"Letzter Chatkontext:\n{context[:1800]}"
        )
        raw = await call_local(user, system=system, max_tokens=180, temperature=0.15, timeout=8.0, feature="werkbank_dispatch")
        match = re.search(r"\{.*\}", raw or "", re.S)
        data = json.loads(match.group(0) if match else raw)
        title = _clean_werkbank_title(str(data.get("title") or ""), fallback_title)
        brief = re.sub(r"\s+", " ", str(data.get("brief") or "")).strip()[:1800] or fallback["brief"]
        acceptance = re.sub(r"\s+", " ", str(data.get("acceptance") or "")).strip()[:500] or fallback["acceptance"]
        return {"title": title, "brief": brief, "acceptance": acceptance, "source": "local"}
    except Exception as e:
        print(f"[werkbank] dispatch local title failed: {e}", flush=True)
        return fallback


def _fallback_work_session_plan(prompt: str, context: str = "") -> dict:
    title = _clean_werkbank_title("", _fallback_werkbank_title(prompt, context)).replace("Werkbank", "Arbeitslauf")
    brief = re.sub(r"\s+", " ", str(prompt or "")).strip()[:1800]
    return {
        "title": title or "Arbeitslauf",
        "brief": brief,
        "acceptance": "Ergebnis, geänderte Dateien, Tests oder klarer Blocker werden knapp zurückgemeldet.",
        "plan": [
            "Kontext aus dem Ursprungschat lesen und Auftrag eingrenzen.",
            "Nötige Dateien oder Daten prüfen.",
            "Kleinsten tragfähigen Fix umsetzen.",
            "Ergebnis verifizieren und knapp zurückmelden.",
        ],
        "checks": ["Keine Werkbank-Aufgabe anlegen.", "Nur am verdichteten Auftrag arbeiten."],
        "source": "fallback",
    }


async def _work_session_plan_packet(prompt: str, context: str) -> dict:
    fallback = _fallback_work_session_plan(prompt, context)
    try:
        from local_llm import call_local, is_available
        if not is_available(timeout=0.6):
            return fallback
        system = (
            "Du planst eine separate Arbeits-Session. Antworte nur als JSON mit "
            "title, brief, acceptance, plan, checks. "
            "title: 2-6 deutsche Wörter. brief: konkreter Arbeitsauftrag bis 90 Wörter. "
            "plan: 3-5 klare Schritte. checks: 2-4 Prüfpunkte. Keine Werkbank erwähnen."
        )
        user = (
            f"Rohauftrag:\n{prompt[:2200]}\n\n"
            f"Letzter Chatkontext:\n{context[:2600]}"
        )
        raw = await call_local(user, system=system, max_tokens=340, temperature=0.12, timeout=8.0, feature="work_session_plan")
        match = re.search(r"\{.*\}", raw or "", re.S)
        data = json.loads(match.group(0) if match else raw)
        plan = [re.sub(r"\s+", " ", str(x)).strip()[:240] for x in (data.get("plan") or []) if str(x).strip()]
        checks = [re.sub(r"\s+", " ", str(x)).strip()[:240] for x in (data.get("checks") or []) if str(x).strip()]
        return {
            "title": _clean_werkbank_title(str(data.get("title") or ""), fallback["title"]),
            "brief": re.sub(r"\s+", " ", str(data.get("brief") or "")).strip()[:1800] or fallback["brief"],
            "acceptance": re.sub(r"\s+", " ", str(data.get("acceptance") or "")).strip()[:500] or fallback["acceptance"],
            "plan": plan[:5] or fallback["plan"],
            "checks": checks[:4] or fallback["checks"],
            "source": "local",
        }
    except Exception as e:
        print(f"[work-session] plan failed: {e}", flush=True)
        return fallback


def _start_werkbank_chat_handoff(
    *,
    conv_id: str,
    prompt: str,
    engine: str,
    project: str,
    attachments: list | None = None,
) -> str | None:
    reason = _werkbank_handoff_reason(prompt, attachments)
    if not reason or not conv_id:
        return None
    try:
        from modules.loops.routes import create_werkbank_chat_task
        title = _fallback_werkbank_title(prompt)
        task = create_werkbank_chat_task(
            parent_conversation_id=conv_id,
            title=title,
            brief=prompt,
            engine=engine,
            project=project or "",
            reason=reason,
        )
        return str((task or {}).get("id") or "") or None
    except Exception as e:
        print(f"[werkbank] auto handoff failed: {e}", flush=True)
        return None


def _mark_werkbank_task_running(task_id: str | None) -> None:
    if not task_id:
        return
    try:
        from modules.loops.routes import mark_werkbank_chat_task_running
        mark_werkbank_chat_task_running(task_id)
    except Exception as e:
        print(f"[werkbank] mark running failed: {e}", flush=True)


def _finish_werkbank_chat_handoff(
    task_id: str | None,
    *,
    status: str,
    final_text: str,
    tool_calls: dict,
    elapsed_ms: int | None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    changed_lines: dict[str, int] | None = None,
) -> str | None:
    if not task_id:
        return None
    try:
        from modules.loops.routes import finish_werkbank_chat_task
        return finish_werkbank_chat_task(
            task_id,
            status=status,
            summary=_short_query(final_text, 1400),
            did_work=_did_substantial_work(tool_calls),
            tool_count=len(tool_calls or {}),
            elapsed_ms=elapsed_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            changed_lines=changed_lines or _diff_totals(tool_calls),
        )
    except Exception as e:
        print(f"[werkbank] auto finish failed: {e}", flush=True)
    return None


def _origin_context_for_werkbank(agent_id: str, project: str, conv_id: str, limit: int = 6) -> str:
    try:
        rows = get_msgs(agent_id, project or "", limit=limit, conversation_id=conv_id)
    except Exception:
        rows = []
    lines = []
    for row in rows[-limit:]:
        author = str(row.get("author") or "").strip() or "?"
        content = re.sub(r"\s+", " ", str(row.get("content") or "")).strip()
        if content:
            lines.append(f"- {author}: {content[:450]}")
    return "\n".join(lines)


def _extract_work_session_paths(*texts: str, limit: int = 12) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    path_re = re.compile(
        r"(?:~/[^\s`'\"),]+|/Users/[^\s`'\"),]+|(?:backend|frontend|scripts|modules|work|jobs|config|data|logs|soul|brain)/[^\s`'\"),]+|[\w.-]+\.(?:py|ts|tsx|js|jsx|json|css|html|sql|sh|yml|yaml|md|plist|env|err|out|log))"
    )
    for text in texts:
        for raw in path_re.findall(str(text or "")):
            item = raw.strip().strip("`'\".,;:)")
            if not item or item.startswith(("http://", "https://")):
                continue
            if item not in seen:
                seen.add(item)
                out.append(item)
            if len(out) >= limit:
                return out
    return out


_LEARNINGS_FILE = Path(__file__).resolve().parents[1] / "brain" / "LEARNINGS.md"
_LEARNINGS_PROPOSED_MARKER = "## Vorgeschlagene Learnings"
_LEARNINGS_STOPWORDS = frozenset((
    "aber", "alle", "allen", "auch", "beim", "bitte", "christian", "damit", "danach",
    "dann", "dass", "diese", "dieser", "dieses", "direkt", "eine", "einem", "einen",
    "einer", "haben", "immer", "kein", "keine", "klaus", "machen", "mehr", "nach",
    "nicht", "noch", "oder", "ohne", "schon", "sein", "selbst", "sind", "soll",
    "sollen", "statt", "ueber", "unter", "werden", "wieder", "wird", "wurde", "zuerst",
))


def _active_learnings_for_prompt(*texts: str, limit: int = 3, max_chars: int = 380) -> str:
    """Waehlt aktive Learnings deterministisch nach Wort-Ueberlappung zum Auftrag.

    Nur der aktive Teil von brain/LEARNINGS.md zaehlt (Vorschlaege bleiben
    draussen), und ein Learning braucht mindestens drei gemeinsame Begriffe,
    damit kein Allerwelts-Rauschen in den Werkbank-Prompt kommt.
    """
    try:
        raw = _LEARNINGS_FILE.read_text(encoding="utf-8")
    except OSError:
        return ""
    raw = raw.split(_LEARNINGS_PROPOSED_MARKER, 1)[0]
    query = " ".join(str(t or "") for t in texts).lower()
    tokens = {
        tok for tok in re.findall(r"[a-zäöüß][a-zäöüß0-9_./-]{3,}", query)
        if tok not in _LEARNINGS_STOPWORDS
    }
    if not tokens:
        return ""
    scored: list[tuple[int, str, str]] = []
    for sec in re.split(r"\n(?=## )", raw):
        sec = sec.strip()
        if not sec.startswith("## "):
            continue
        lines = sec.splitlines()
        title = lines[0].lstrip("# ").strip()
        body = " ".join(line.strip() for line in lines[1:] if line.strip())
        haystack = sec.lower()
        overlap = sum(1 for tok in tokens if tok in haystack)
        if overlap >= 3:
            scored.append((overlap, title, body))
    scored.sort(key=lambda item: item[0], reverse=True)
    return "\n".join(f"- {title}: {body[:max_chars]}" for _, title, body in scored[:limit])


def _build_werkbank_background_prompt(
    *,
    task_id: str,
    origin_conv_id: str,
    origin_title: str,
    title: str,
    brief: str,
    acceptance: str,
    raw_prompt: str,
    context: str,
) -> str:
    learnings = _active_learnings_for_prompt(brief, acceptance, raw_prompt)
    learnings_block = f"Aktive Learnings, für diesen Auftrag verbindlich:\n{learnings}\n\n" if learnings else ""
    return (
        f"Werkbank-Task-ID: {task_id}\n"
        f"Ursprungschat: {origin_conv_id} ({origin_title or 'ohne Titel'})\n\n"
        "Arbeite diesen Auftrag im Hintergrund ab. Der Ursprungschat soll frei bleiben. "
        "Wenn du fertig bist, melde dein Ergebnis knapp; die Werkbank spiegelt es in den Ursprungschat zurück.\n\n"
        "Beende deine allerletzte Nachricht mit genau diesem dreizeiligen Abschluss, jede Zeile beginnt mit ihrem Label in Grossbuchstaben:\nFERTIG: was jetzt konkret fertig oder anders ist, ein bis zwei Saetze.\nGEAENDERT: die wichtigsten geaenderten Dateien oder Bereiche, knapp.\nDU KANNST: was der Nutzer jetzt pruefen, testen oder als Naechstes tun kann.\n\n"
        f"Titel:\n{title.strip()}\n\n"
        f"Verdichteter Auftrag:\n{brief.strip()}\n\n"
        f"Abnahme:\n{acceptance.strip()}\n\n"
        f"{learnings_block}"
        f"Originalauftrag, gekürzt:\n{raw_prompt.strip()[:1200]}\n\n"
        f"Kontext aus dem Ursprungschat, gekürzt:\n{(context or '- kein Kontext geladen')[:2200]}"
    )


def _build_work_session_prompt(
    *,
    task_id: str = "",
    origin_conv_id: str,
    origin_title: str,
    title: str,
    brief: str,
    acceptance: str,
    raw_prompt: str,
    context: str,
    plan: list[str],
    checks: list[str],
    network_access: bool = False,
) -> str:
    plan_lines = "\n".join(f"{idx + 1}. {item}" for idx, item in enumerate(plan or []))
    check_lines = "\n".join(f"- {item}" for item in (checks or []))
    task_line = f"Werkbank-Task-ID: {task_id}\n" if task_id else ""
    known_paths = _extract_work_session_paths(brief, acceptance, raw_prompt, context)
    path_lines = "\n".join(f"- {item}" for item in known_paths) or "- Keine konkreten Pfade erkannt; suche eng nach Begriffen aus dem Auftrag."
    token_budget_label = f"{_WORK_SESSION_TOKEN_BUDGET:,}".replace(",", ".")
    learnings = _active_learnings_for_prompt(brief, acceptance, raw_prompt)
    learnings_block = f"Aktive Learnings, für diesen Auftrag verbindlich:\n{learnings}\n\n" if learnings else ""
    network_block = (
        "Runtime:\n"
        "- Dieser Auftrag braucht externe Netzwerkverbindungen. Der Werkbank-Runner startet dafür mit Netzwerkzugang.\n"
        "- Bei Deploys gilt: kein Erfolg ohne echten Live-Check gegen das Zielsystem.\n\n"
        if network_access else ""
    )
    return (
        f"{task_line}"
        f"Ursprungschat: {origin_conv_id} ({origin_title or 'ohne Titel'})\n\n"
        "Arbeite in dieser separaten Session nur den folgenden Auftrag ab. "
        "Nutze den Kontext als Hintergrund, aber folge dem verdichteten Auftrag. "
        "Wenn du fertig bist, melde dein Ergebnis knapp zurück.\n\n"
        "Beende deine allerletzte Nachricht mit genau diesem dreizeiligen Abschluss, jede Zeile beginnt mit ihrem Label in Grossbuchstaben:\nFERTIG: was jetzt konkret fertig oder anders ist, ein bis zwei Saetze.\nGEAENDERT: die wichtigsten geaenderten Dateien oder Bereiche, knapp.\nDU KANNST: was der Nutzer jetzt pruefen, testen oder als Naechstes tun kann.\n\n"
        f"Titel:\n{title.strip()}\n\n"
        f"Verdichteter Auftrag:\n{brief.strip()}\n\n"
        "Arbeitsbudget:\n"
        f"- Ziel: höchstens {_WORK_SESSION_TOOL_BUDGET} Werkzeug-Calls, davon höchstens {_WORK_SESSION_ORIENTATION_BUDGET} Orientierungs-Calls vor der ersten Änderung.\n"
        f"- Token-Warnschwelle: {token_budget_label} Tokens; vermeide breite Suchläufe und lange Ausgaben.\n"
        "- Nutze zuerst die bekannten Pfade; kein `file.list .`, kein repo-weites `rg .`, kein doppeltes Inspect/Edit-Window, außer ein Pfad fehlt wirklich.\n"
        "- Begrenze Outputs hart: gezielte `sed -n`, `tail -40`, `rg -n` mit Pfad/Pattern; keine vollständigen Logs, Dumps oder Statusblöcke.\n"
        "- Wenn das Budget nicht reicht, stoppe nicht blind: melde kurz, warum mehr Kontext nötig ist.\n\n"
        f"{network_block}"
        f"Bekannte Pfade:\n{path_lines}\n\n"
        f"Plan:\n{plan_lines or '1. Auftrag prüfen und kleinsten tragfähigen Weg umsetzen.'}\n\n"
        f"Kontrolle:\n{check_lines or '- Ergebnis verifizieren.'}\n\n"
        f"Abnahme:\n{acceptance.strip()}\n\n"
        f"{learnings_block}"
        f"Originalauftrag, gekürzt:\n{raw_prompt.strip()[:1200]}\n\n"
        f"Kontext aus dem Ursprungschat, gekürzt:\n{(context or '- kein Kontext geladen')[:2600]}"
    )


async def _enqueue_werkbank_background(client: WebSocket, msg: dict, engine: str) -> bool:
    return False


async def _resume_work_session(client: WebSocket, msg: dict, engine: str, agent_id: str, project: str) -> bool:
    """Haengt einen Folgeauftrag an die juengste offene Werkbank-Session dieses
    Ursprungschats an, statt eine neue Session zu eroeffnen. Gibt False zurueck,
    wenn keine laufende Session existiert."""
    conv_id = str(msg.get("conversationId") or "")
    prompt = str(msg.get("message") or "").strip()
    attachments = msg.get("attachments", [])
    if not conv_id or not prompt:
        return False
    try:
        from modules.loops.routes import _list_bauhof_tasks
        tasks = _list_bauhof_tasks(limit=120)
    except Exception as e:
        print(f"[work-session] resume list failed: {e}", flush=True)
        return False
    worker_conv = ""
    task_title = ""
    for task in tasks:
        origin = task.get("origin") or {}
        if str(origin.get("conversation_id") or "") != conv_id:
            continue
        if str(task.get("status") or "") not in {"queued", "running"}:
            continue
        wc = str((task.get("request") or {}).get("worker_conversation_id") or "")
        if not wc:
            continue
        worker_conv = wc
        task_title = str(task.get("title") or "")
        break
    if not worker_conv:
        return False
    follow = "Folgeauftrag aus dem Ursprungschat, gleiche Session weiterbauen:\n\n" + prompt
    item_id = f"work-resume-{int(_time.time())}-{_uuid.uuid4().hex[:6]}"
    try:
        save_msg(agent_id, project, "Du", prompt, conv_id, attachments=json.dumps(attachments))
        with get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (item_id, worker_conv, follow, json.dumps(attachments if isinstance(attachments, list) else []), agent_id, _time.time()),
            )
        ack = f"Hängt an die laufende Session an: {task_title or 'Arbeitslauf'}. Sie baut dort weiter, ich melde das Ergebnis hier."
        save_msg(agent_id, project, get_agent_display(agent_id), ack, conv_id)
        await broadcast_sync(agent_id, conv_id, source=msg.get("clientKind"))
        try:
            await client.send_json({
                "type": "agent.done",
                "agent": get_agent_display(agent_id),
                "status": "queued",
                "conversationId": conv_id,
                "didWork": False,
            })
        except Exception:
            pass
        return True
    except Exception as e:
        print(f"[work-session] resume enqueue failed: {e}", flush=True)
        return False


async def _enqueue_work_session_background(client: WebSocket, msg: dict, engine: str) -> bool:
    if msg.get("clientKind") == "background" or msg.get("resumeRowId") or msg.get("werkbankTaskId"):
        return False
    conv_id = str(msg.get("conversationId") or "")
    prompt = str(msg.get("message") or "").strip()
    attachments = msg.get("attachments", [])
    if not conv_id or not prompt:
        return False

    # 2026-06-10: Kein Stichwort-Vorfilter mehr. Die Uebergabe an die Werkbank
    # entscheidet Klaus bewusst im Gespraech (siehe AGENTS.md), nicht ein
    # Keyword-Match auf einer einzelnen Nachricht. Ein zufaellig getroffenes Wort
    # (z.B. "rueber" in "rueber geben") darf nie einen Worker spawnen. Der
    # Apparat darunter bleibt fuer einen kuenftigen expliziten Button-Pfad
    # erhalten, wird aber nicht mehr automatisch erreicht.
    return False

    if _werkbank_disable_requested(prompt):
        _werkbank_disabled_conversations.add(conv_id)
        _work_session_disabled_conversations.add(conv_id)
        return False
    explicit_work_session = _work_session_requested(prompt)
    resume_requested = _work_session_resume_requested(prompt)
    disabled = conv_id in _werkbank_disabled_conversations or conv_id in _work_session_disabled_conversations
    if not explicit_work_session and not resume_requested:
        return False
    if disabled and not explicit_work_session and not resume_requested:
        return False

    agent_id = normalize_agent_id(msg.get("agentId", "main"))
    project = str(msg.get("project") or "")
    origin = get_conversation(conv_id) or {}
    if not project:
        project = str(origin.get("project") or "")

    # Punkt 4: Laeuft zum Thema schon eine Werkbank-Session und der Nutzer will dort
    # weiterbauen, haengen wir den Folgeauftrag an, statt eine neue Session zu oeffnen.
    if resume_requested:
        resumed = await _resume_work_session(client, msg, engine, agent_id, project)
        if resumed:
            return True
        # Keine offene Session gefunden: nur weiter zu neuem Spawn, wenn auch ein
        # expliziter Uebergabe-Wille da ist, sonst still im Chat bleiben.
        if not explicit_work_session:
            return False

    # Punkt 1 + 5: Ein klarer Uebergabe-Befehl IST die Freigabe. Direkt spawnen,
    # ohne generische Rueckfrage, ohne Schablone, ohne zweites Nachhaken.
    context = _origin_context_for_werkbank(agent_id, project, conv_id)
    try:
        dispatch = await _work_session_plan_packet(prompt, context)
        dispatch_title = _clean_werkbank_title(str(dispatch.get("title") or ""), _fallback_werkbank_title(prompt, context))
        dispatch_brief = str(dispatch.get("brief") or prompt).strip()
        dispatch_acceptance = str(dispatch.get("acceptance") or "Ergebnis liegt klar zurück.").strip()
        packet = {
            "agent_id": agent_id,
            "project": project,
            "prompt": prompt,
            "attachments": attachments if isinstance(attachments, list) else [],
            "context": context,
            "title": dispatch_title,
            "brief": dispatch_brief,
            "acceptance": dispatch_acceptance,
            "plan": [str(x) for x in (dispatch.get("plan") or [])],
            "checks": [str(x) for x in (dispatch.get("checks") or [])],
            "engine": engine or get_conversation_engine(conv_id),
        }
        return await _spawn_work_session(client, msg, engine, packet)
    except Exception as e:
        print(f"[work-session] dispatch failed: {e}", flush=True)
        return False


def _inherit_conversation_model(origin_conv_id: str, work_conv_id: str) -> None:
    """Werkbank-Worker erbt das per-Chat-Modell des Ursprungschats (z.B. Fable 5);
    ohne Kopie fiele er still auf den Engine-Default zurueck."""
    if not origin_conv_id or not work_conv_id:
        return
    try:
        with get_db() as db:
            row = db.execute("SELECT model FROM conversations WHERE id = ?", (origin_conv_id,)).fetchone()
            if row and row[0]:
                db.execute("UPDATE conversations SET model = ? WHERE id = ?", (row[0], work_conv_id))
    except Exception:
        pass


async def _spawn_work_session(client: WebSocket, msg: dict, engine: str, packet: dict) -> bool:
    conv_id = str(msg.get("conversationId") or "")
    prompt = str(msg.get("message") or "").strip()
    attachments = msg.get("attachments", [])
    agent_id = packet.get("agent_id") or normalize_agent_id(msg.get("agentId", "main"))
    project = packet.get("project") or str(msg.get("project") or "")
    origin = get_conversation(conv_id) or {}
    if not project:
        project = str(origin.get("project") or "")
    dispatch_title = str(packet.get("title") or "Arbeitslauf").strip()
    dispatch_brief = str(packet.get("brief") or packet.get("prompt") or prompt).strip()
    dispatch_acceptance = str(packet.get("acceptance") or "Ergebnis liegt klar zurück.").strip()
    raw_prompt = str(packet.get("prompt") or prompt)
    context = str(packet.get("context") or "")
    eng = packet.get("engine") or engine or get_conversation_engine(conv_id)
    network_access = bool(packet.get("network_access")) or _work_session_needs_external_network(dispatch_title, dispatch_brief, dispatch_acceptance, raw_prompt)
    try:
        save_msg(agent_id, project, "Du", prompt, conv_id, attachments=json.dumps(attachments))
        work_conv_id = create_conversation(
            agent_id,
            project,
            title=f"Arbeitslauf · {dispatch_title}",
            engine=eng,
            kind="work_session",
        )
        _inherit_conversation_model(conv_id, work_conv_id)
        task_id = ""
        try:
            from modules.loops.routes import create_werkbank_chat_task
            task = create_werkbank_chat_task(
                parent_conversation_id=conv_id,
                title=dispatch_title,
                brief=dispatch_brief,
                engine=eng,
                project=project or "",
                reason="bestätigter Arbeitslauf",
                acceptance=dispatch_acceptance,
                worker_conversation_id=work_conv_id,
                initial_status="queued",
            )
            task_id = str((task or {}).get("id") or "")
        except Exception as e:
            print(f"[work-session] task create failed: {e}", flush=True)
        item_id = f"werkbank-{task_id}" if task_id else f"work-session-{int(_time.time())}-{_uuid.uuid4().hex[:6]}"
        work_prompt = _build_work_session_prompt(
            task_id=task_id,
            origin_conv_id=conv_id,
            origin_title=str(origin.get("title") or ""),
            title=dispatch_title,
            brief=dispatch_brief,
            acceptance=dispatch_acceptance,
            raw_prompt=raw_prompt,
            context=context,
            plan=[str(x) for x in (packet.get("plan") or [])],
            checks=[str(x) for x in (packet.get("checks") or [])],
            network_access=network_access,
        )
        with get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (item_id, work_conv_id, work_prompt, json.dumps(attachments if isinstance(attachments, list) else []), agent_id, _time.time()),
            )
        ack = f"Läuft, ich habe die Session gestartet: {dispatch_title}. Du kannst hier weiterschreiben."
        save_msg(agent_id, project, get_agent_display(agent_id), ack, conv_id)
        auto_title(conv_id, raw_prompt)
        auto_project(conv_id)
        await broadcast_sync(agent_id, conv_id, source=msg.get("clientKind"))
        try:
            await client.send_json({
                "type": "agent.done",
                "agent": get_agent_display(agent_id),
                "status": "queued",
                "conversationId": conv_id,
                "didWork": False,
            })
        except Exception:
            pass
        return True
    except Exception as e:
        print(f"[work-session] spawn failed: {e}", flush=True)
        return False


async def create_work_session_record(
    *,
    conv_id: str,
    agent_id: str,
    project: str,
    packet: dict,
    save_origin_user_msg: bool = False,
    origin_user_text: str = "",
    origin_attachments: list | None = None,
) -> dict | None:
    """Client-freier Kern fuer den bewussten Werkbank-Spawn.

    Beide Haende gehen hier durch: Klaus loest bewusst per Endpoint aus, der Nutzer
    per Button. Kein Stichwort-Vorfilter, kein WebSocket noetig. Legt Worker-Chat,
    Werkbank-Task und Queue-Item an und gibt die IDs zurueck.
    """
    conv_id = str(conv_id or "")
    agent_id = normalize_agent_id(agent_id or "main")
    if not conv_id:
        return None
    origin = get_conversation(conv_id) or {}
    if not project:
        project = str(origin.get("project") or "")
    dispatch_title = str(packet.get("title") or "Arbeitslauf").strip()
    dispatch_brief = str(packet.get("brief") or packet.get("prompt") or "").strip()
    dispatch_acceptance = str(packet.get("acceptance") or "Ergebnis liegt klar zurueck.").strip()
    raw_prompt = str(packet.get("prompt") or dispatch_brief)
    context = str(packet.get("context") or "")
    eng = packet.get("engine") or get_conversation_engine(conv_id)
    attachments = origin_attachments if isinstance(origin_attachments, list) else []
    network_access = bool(packet.get("network_access")) or _work_session_needs_external_network(dispatch_title, dispatch_brief, dispatch_acceptance, raw_prompt)
    if not dispatch_brief:
        return None
    try:
        if save_origin_user_msg and origin_user_text:
            save_msg(agent_id, project, "Du", origin_user_text, conv_id, attachments=json.dumps(attachments))
        work_conv_id = create_conversation(
            agent_id,
            project,
            title=f"Arbeitslauf - {dispatch_title}",
            engine=eng,
            kind="work_session",
        )
        _inherit_conversation_model(conv_id, work_conv_id)
        task_id = ""
        try:
            from modules.loops.routes import create_werkbank_chat_task
            task = create_werkbank_chat_task(
                parent_conversation_id=conv_id,
                title=dispatch_title,
                brief=dispatch_brief,
                engine=eng,
                project=project or "",
                reason="bewusst ausgeloester Arbeitslauf",
                acceptance=dispatch_acceptance,
                worker_conversation_id=work_conv_id,
                initial_status="queued",
            )
            task_id = str((task or {}).get("id") or "")
        except Exception as e:
            print(f"[work-session] task create failed: {e}", flush=True)
        item_id = f"werkbank-{task_id}" if task_id else f"work-session-{int(_time.time())}-{_uuid.uuid4().hex[:6]}"
        work_prompt = _build_work_session_prompt(
            task_id=task_id,
            origin_conv_id=conv_id,
            origin_title=str(origin.get("title") or ""),
            title=dispatch_title,
            brief=dispatch_brief,
            acceptance=dispatch_acceptance,
            raw_prompt=raw_prompt,
            context=context,
            plan=[str(x) for x in (packet.get("plan") or [])],
            checks=[str(x) for x in (packet.get("checks") or [])],
            network_access=network_access,
        )
        with get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (item_id, work_conv_id, work_prompt, json.dumps(attachments), agent_id, _time.time()),
            )
        auto_title(conv_id, raw_prompt)
        auto_project(conv_id)
        return {"task_id": task_id, "work_conv_id": work_conv_id, "title": dispatch_title}
    except Exception as e:
        print(f"[work-session] core spawn failed: {e}", flush=True)
        return None


async def spawn_work_session_from_request(
    *,
    conv_id: str,
    brief: str,
    title: str = "",
    acceptance: str = "",
    agent_id: str = "main",
    project: str = "",
    engine: str = "",
    plan: list | None = None,
    checks: list | None = None,
    network_access: bool = False,
) -> dict | None:
    """Baut aus einem bewussten Auftrag das Dispatch-Packet und legt die Session an.

    Wenn kein Titel/Plan mitgegeben wird, verdichtet das lokale Modell den Brief zu
    Titel, Plan und Checks (wie der alte Auto-Pfad, nur ohne Stichwort-Trigger).
    """
    conv_id = str(conv_id or "")
    brief = str(brief or "").strip()
    agent_id = normalize_agent_id(agent_id or "main")
    if not conv_id or not brief:
        return None
    origin = get_conversation(conv_id) or {}
    if not project:
        project = str(origin.get("project") or "")
    context = _origin_context_for_werkbank(agent_id, project, conv_id)
    eng = engine or get_conversation_engine(conv_id)
    if title.strip():
        dispatch_title = _clean_werkbank_title(title, _fallback_werkbank_title(brief, context))
        dispatch_plan = [str(x) for x in (plan or [])]
        dispatch_checks = [str(x) for x in (checks or [])]
        dispatch_acceptance = acceptance.strip() or "Ergebnis liegt klar zurueck."
    else:
        try:
            dispatch = await _work_session_plan_packet(brief, context)
        except Exception as e:
            print(f"[work-session] plan packet failed: {e}", flush=True)
            dispatch = _fallback_work_session_plan(brief, context)
        dispatch_title = _clean_werkbank_title(str(dispatch.get("title") or ""), _fallback_werkbank_title(brief, context))
        dispatch_plan = [str(x) for x in (dispatch.get("plan") or [])]
        dispatch_checks = [str(x) for x in (dispatch.get("checks") or [])]
        dispatch_acceptance = acceptance.strip() or str(dispatch.get("acceptance") or "Ergebnis liegt klar zurueck.").strip()
    needs_network = bool(network_access) or _work_session_needs_external_network(brief, dispatch_title, dispatch_acceptance, "\n".join(dispatch_checks), context)
    if needs_network and not any("live" in item.lower() for item in dispatch_checks):
        dispatch_checks.append("Bei Deploys echten Live-Check gegen das Zielsystem machen; lokale Änderung allein zählt nicht als fertig.")
    packet = {
        "agent_id": agent_id,
        "project": project,
        "prompt": brief,
        "title": dispatch_title,
        "brief": brief,
        "acceptance": dispatch_acceptance,
        "plan": dispatch_plan,
        "checks": dispatch_checks,
        "context": context,
        "engine": eng,
        "network_access": needs_network,
    }
    return await create_work_session_record(
        conv_id=conv_id,
        agent_id=agent_id,
        project=project,
        packet=packet,
    )


def _slim_learning_tool_calls(tool_calls: dict) -> list[dict]:
    out: list[dict] = []
    for tc in tool_calls.values():
        if not isinstance(tc, dict):
            continue
        inp = tc.get("input") or tc.get("parsed_input") or {}
        slim = {}
        for k in ("file_path", "path", "command", "pattern", "query", "description", "glob"):
            if k in inp:
                slim[k] = str(inp[k])[:500]
        out.append({
            "name": tc.get("name", ""),
            "status": tc.get("status") or ("completed" if tc.get("done") else ""),
            "input": slim,
            "result": str(tc.get("result") or "")[:500],
            "diffStats": tc.get("diff_stats"),
        })
    return out


def _start_learning_run(engine: str, agent_display: str, prompt: str, project: str, conv_id: str, model: str) -> str | None:
    if not prompt.strip():
        return None
    try:
        import workflows as _workflows
        return _workflows.start_run(
            "agent.turn",
            _short_query(prompt, 90) or f"{agent_display} Lauf",
            trigger="chat",
            subject_type="conversation",
            subject_ref=conv_id or "",
            conversation_id=conv_id or "",
            input_data={
                "engine": engine,
                "agent": agent_display,
                "prompt": prompt[:2000],
                "project": project or "",
                "model": model or "",
            },
        )
    except Exception as e:
        print(f"[workflow] agent turn start failed: {e}", flush=True)
        return None


def _finish_learning_run(
    run_id: str | None,
    *,
    status: str,
    final_text: str = "",
    error: str = "",
    elapsed_ms: int | None = None,
    tool_calls: dict | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
) -> None:
    if not run_id:
        return
    try:
        import workflows as _workflows
        tools = _slim_learning_tool_calls(tool_calls or {})
        _workflows.add_step(run_id, "tools", "Werkzeuge", "ok" if not error else "error", f"{len(tools)} Tool-Calls", {"tool_count": len(tools)})
        _workflows.add_step(run_id, "answer", "Antwort", "ok" if final_text.strip() else "warning", _short_query(final_text, 180), {"chars": len(final_text or "")})
        _workflows.finish_run(
            run_id,
            "done" if status == "ok" else status,
            result={
                "final_text": final_text[:2000],
                "elapsed_ms": elapsed_ms or 0,
                "tool_calls": tools,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
            error=error,
        )
        _workflows.review_agent_turn(run_id)
    except Exception as e:
        print(f"[workflow] agent turn review failed: {e}", flush=True)


def _engine_label(engine: str) -> str:
    label = engine_label(engine)
    return label.replace(" CLI", "").replace(" Code", "") or engine


def _short_query(text: str, limit: int = 140) -> str:
    s = re.sub(r"\s+", " ", (text or "")).strip()
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


def _dual_sidecar_reason(prompt: str, project: str = "", force: bool = False) -> str:
    """Smart-Trigger für den Two-Pass-Sidecar.

    Soll feuern bei Architektur/Refactor/Planungs-Anfragen, NICHT bei stumpfen
    Aufträgen (benenn um, merge, schick, trag ein, restart, danke).
    `force` ist nur noch ein leichter Bias-Boost (ein Klick "Codex jetzt!"),
    keine Garantie — Skip-Veto bleibt immer hart.
    """
    text = str(prompt or "").strip()
    if not text:
        return ""
    lower = " " + text.lower() + " "  # padded für Wortgrenzen-freundliche `in`-Checks

    plan_hits = [kw for kw in _DUAL_PLAN_HINTS if kw in lower]
    skip_hits = [kw for kw in _DUAL_SKIP_HINTS if kw in lower]

    # Hartes Veto: wenn der User klar ein stumpfes Kommando gibt, niemals reviewen.
    # Auch wenn force gesetzt ist — stumpfe Aktionen brauchen kein zweites Auge.
    if skip_hits and not plan_hits:
        return ""

    score = 0
    reasons: list[str] = []

    has_path = bool(_CODE_PATH_RE.search(text) or _CODE_FILE_RE.search(text))
    has_inline_code = "```" in text or bool(re.search(r"`[^`]+`", text))
    tech_hits = [kw for kw in _DUAL_TECH_HINTS if kw in lower]
    action_hits = [kw for kw in _DUAL_ACTION_HINTS if kw in lower]

    if plan_hits:
        score += 4
        reasons.append(plan_hits[0].strip())
    if has_path:
        score += 2
        reasons.append("Pfad oder Datei")
    if has_inline_code:
        score += 1
        reasons.append("Code im Text")
    if tech_hits:
        score += 1
        reasons.append(tech_hits[0])
    if action_hits:
        score += 1
        reasons.append(action_hits[0])
    if project and Path(project).is_dir():
        score += 1
        reasons.append("Projektkontext")

    # Längere Anfragen tragen mehr Reasoning — kurze "fix das" sollen nicht feuern.
    if len(text) >= 220:
        score += 1
        reasons.append("ausführliche Anfrage")

    threshold = 4 if force else 5
    if score < threshold:
        return ""
    return ", ".join(dict.fromkeys(reasons))[:120] or ("manuell" if force else "smart")


def _read_context_file(path: Path, max_chars: int = 3000) -> str:
    try:
        if not path.exists():
            return ""
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if len(text) > max_chars:
            text = text[: max_chars - 1].rstrip() + "…"
        return text
    except Exception:
        return ""


def _build_consult_identity_context(conv_id: str, time_ctx: str) -> str:
    root = Path(__file__).parent.parent
    identity_ctx = build_identity_context("main", "Zweitblick")
    files = [
        ("brain/threads.md", root / "brain" / "threads.md", 2200),
    ]
    blocks = []
    for label, path, limit in files:
        text = _read_context_file(path, max_chars=limit)
        if text:
            blocks.append(f"[{label}]\n{text}")
    session_ctx = build_session_context(conv_id)
    return (
        identity_ctx
        + (
        "Das hier ist ein sichtbarer Zweitblick innerhalb von Agent Control. "
        "Du antwortest auf Deutsch mit vollen Umlauten, bist minimalistisch, direkt und prüfst nur auf "
        "Missverständnisse, Scope-Drift, unnötige Komplexität, Risiken und die einfachere Lösung.\n\n"
        )
        + time_ctx
        + session_ctx
        + ("Klaus-Kontext aus lokalen Regeldateien:\n\n" + "\n\n".join(blocks) + "\n\n" if blocks else "")
    )


def _build_recent_chat_context(conv_id: str, limit: int = 12) -> str:
    if not conv_id:
        return ""
    try:
        with get_db() as db:
            rows = db.execute(
                "SELECT author, content FROM messages WHERE conversation_id = ? AND content != '' ORDER BY id DESC LIMIT ?",
                (conv_id, limit),
            ).fetchall()
    except Exception:
        return ""
    if not rows:
        return ""
    parts = []
    for author, content in reversed(rows):
        short = str(content or "").strip()
        if not short:
            continue
        if len(short) > 900:
            short = short[:899].rstrip() + "…"
        parts.append(f"{author}: {short}")
    if not parts:
        return ""
    return "Kontext aus diesem Chat:\n" + "\n---\n".join(parts) + "\n\n"


def _build_dual_plan_prompt() -> str:
    return (
        "Du bereitest deine eigene Linie vor, bevor der Zweitblick dazukommt. "
        "Recherchiere zuerst: lies relevante Dateien, Logs, Status, grep durch den Code — "
        "alles, was nötig ist, um die Anfrage konkret zu verstehen. Lesen ist erlaubt und "
        "erwünscht. Ändere noch nichts, schreibe keine Dateien, schicke keine Messages "
        "und führe keine destruktiven Aktionen aus.\n\n"
        "Antworte am Ende mit einem knappen Arbeitsplan in vier Punkten:\n"
        "1. Was ist das Ziel?\n"
        "2. Was hast du gefunden (Diagnose, konkrete Fakten aus deiner Recherche)?\n"
        "3. Was ist dein geplanter Weg und wo sind Risiken?\n"
        "4. Wie prüfst du am Ende, ob es passt?\n\n"
        "Bleib konkret, kurz und praktisch."
    )


def _build_dual_review_subject(user_prompt: str, draft_plan: str) -> str:
    return (
        "Nutzeranfrage:\n"
        + user_prompt.strip()
        + "\n\nVorläufiger Plan des Hauptmodells:\n"
        + draft_plan.strip()
        + "\n\nPrüfe diesen Plan streng. Höfliches Nicken ist verboten — du musst aktiv "
          "nach Denkfehlern, Scope-Drift, unnötiger Komplexität, fehlenden Prüfungen und einer "
          "einfacheren Lösung suchen.\n\n"
          "**Optik/UI-Regel:** Stil, Layout, Typografie, Farben, Spacing und visuelle Hierarchie "
          f"fasst du NICHT an. {_of_stream()} will Claudes Design-Sprache als Konstante. Du reviewst "
          "nur Logik (Architektur, Fehlerfälle, Komplexität, Tests).\n\n"
          "Schreibe auf Deutsch, menschlich und in einfacher Sprache. Kein Techniksprech, wenn er "
          "nicht wirklich nötig ist. Keine Wörter wie `Verdikt`, `Blocker`, `revise` oder Prüfbericht-Ton.\n\n"
          "Antworte in genau drei kurzen Blöcken:\n"
          "1. `Kurz gesagt:` Was ist dein Gesamturteil in einem einfachen Satz?\n"
          "2. `Worauf ich achten würde:` Was ist der wichtigste Haken oder die wichtigste Lücke? Wenn nichts kritisch ist, sag das klar.\n"
          "3. `Einfacher ginge auch:` Gibt es einen einfacheren Weg? Wenn nein, sag `Ich würde es so lassen.`\n\n"
          f"Halte die Antwort knapp und verständlich, so dass {_of_stream()} sie ohne Vorwissen sofort versteht."
    )


def _build_dual_execution_context(target_label: str, draft_plan: str, review: str) -> str:
    return (
        "\n\nEigener Vorab-Plan:\n"
        + draft_plan.strip()
        + "\n\nZweitblick von "
        + target_label
        + ":\n"
        + review.strip()
        + "\n\nArbeite jetzt den Auftrag aus. Prüfe den Zweitblick nüchtern und übernimm nur, "
          "was die Lösung klarer, robuster oder einfacher macht. Wenn etwas nicht passt, ignoriere es.\n"
    )


def _dual_tool_input(tc: dict) -> dict:
    return (tc.get("input") or tc.get("parsed_input") or {}) if isinstance(tc, dict) else {}


def _summarize_dual_tool_calls(tool_calls: dict, limit: int = 10) -> str:
    lines: list[str] = []
    for tc in tool_calls.values():
        if not isinstance(tc, dict):
            continue
        name = str(tc.get("name") or "").strip()
        if not name or name.lower() == "agent":
            continue
        inp = _dual_tool_input(tc)
        detail = ""
        for key in ("file_path", "path", "command", "pattern", "query", "description"):
            value = str(inp.get(key) or "").strip()
            if value:
                value = re.sub(r"\s+", " ", value)
                detail = f"{key}={value[:180]}"
                break
        diff = tc.get("diff_stats") or {}
        diff_text = ""
        if diff:
            added = int(diff.get("added", 0) or 0)
            removed = int(diff.get("removed", 0) or 0)
            if added or removed:
                diff_text = f" diff=+{added}/-{removed}"
        line = f"- {name}"
        if detail:
            line += f": {detail}"
        if diff_text:
            line += diff_text
        lines.append(line)
        if len(lines) >= limit:
            break
    return "\n".join(lines)


def _build_dual_result_review_subject(user_prompt: str, final_answer: str, tool_summary: str) -> str:
    work_block = tool_summary.strip() or "- Kein nennenswerter Tool- oder Dateipfad sichtbar."
    return (
        "Nutzeranfrage:\n"
        + user_prompt.strip()
        + "\n\nErgebnis des Hauptmodells:\n"
        + final_answer.strip()
        + "\n\nArbeitsweg / sichtbare Spuren:\n"
        + work_block
        + "\n\nPrüfe dieses Ergebnis streng. Es geht jetzt nicht mehr um einen Vorab-Plan, "
          "sondern darum, ob die Antwort und die Umsetzung den Auftrag wirklich treffen, ob "
          "unnötige Komplexität entstanden ist und ob jetzt noch eine Änderung nötig wäre.\n\n"
          "**Optik/UI-Regel:** Stil, Layout, Typografie, Farben, Spacing und visuelle Hierarchie "
          f"fasst du NICHT an. {_of_stream()} will Claudes Design-Sprache als Konstante. Du reviewst "
          "nur Logik (Architektur, Fehlerfälle, Komplexität, Tests).\n\n"
          "Schreibe auf Deutsch, menschlich und in einfacher Sprache. Kein Techniksprech, wenn er "
          "nicht wirklich nötig ist. Keine Wörter wie `Verdikt`, `Blocker`, `revise` oder Prüfbericht-Ton.\n\n"
          "Antworte in genau drei kurzen Blöcken:\n"
          "1. `Kurz gesagt:` Passt das Ergebnis so oder nicht?\n"
          "2. `Worauf ich achten würde:` Was ist das eine Wichtigste, das noch schief sein könnte? Wenn nichts kritisch ist, sag das klar.\n"
          "3. `Einfacher ginge auch:` Gibt es eine unnötig komplizierte Stelle oder ist es so okay?\n\n"
          f"Halte die Antwort knapp und verständlich, so dass {_of_stream()} sie ohne Vorwissen sofort versteht."
    )


async def _broadcast(payload: str):
    """Send a JSON payload to all connected WebSocket clients."""
    for ws in list(_connected_clients):
        try:
            await ws.send_text(payload)
        except Exception:
            _connected_clients.discard(ws)


async def broadcast_sync(agent_id: str, conv_id: str, source: str | None = None):
    """Notify all clients that new messages are available.

    `source` ist optional und propagiert den ursprünglichen Sender-Client (z. B.
    'mobile' oder 'desktop'), damit andere Tabs Sound-Effekte unterdrücken können
    wenn der Auslöser vom selben Nutzer auf einem anderen Gerät stammt.
    """
    payload = {"type": "sync", "agentId": agent_id, "conversationId": conv_id}
    if source:
        payload["source"] = source
    await _broadcast(json.dumps(payload))


async def broadcast_title_update(conv_id: str, title: str):
    """Notify all clients that a conversation title has changed."""
    await _broadcast(json.dumps({"type": "conv.titleUpdate", "conversationId": conv_id, "title": title}))


async def broadcast_project_update(conv_id: str, project_id: str):
    """Notify clients dass ein Chat einem Projekt zugewiesen wurde (oder das Projekt gewechselt hat)."""
    await _broadcast(json.dumps({"type": "conv.projectUpdate", "conversationId": conv_id, "projectId": project_id}))


async def broadcast_project_suggest(conv_id: str, project_id: str, project_name: str):
    """Frage der Nutzer inline ob der Chat zu Projekt X gehört."""
    await _broadcast(json.dumps({
        "type": "conv.projectSuggest",
        "conversationId": conv_id,
        "projectId": project_id,
        "projectName": project_name,
    }))


async def broadcast_pane_input(pane: int, text: str, event_id: str | None = None) -> bool:
    """Push a transcript into the composer of pane N (1..4) on every connected
    frontend. Returns True iff at least one WS client was connected to receive it."""
    had_clients = bool(_connected_clients)
    await _broadcast(json.dumps({
        "type": "pane.input",
        "pane": pane,
        "text": text,
        "eventId": event_id or f"pane-{_uuid.uuid4().hex}",
    }))
    return had_clients


async def broadcast_pane_focus(pane: int) -> bool:
    """Tell every connected frontend to jump to pane N (1..4) — used by the
    KlausFlow PTT client at record-start, so the target pane is visible while
    dictating, before any text arrives. No composer change, pure view-jump."""
    had_clients = bool(_connected_clients)
    await _broadcast(json.dumps({"type": "pane.focus", "pane": pane}))
    return had_clients


async def broadcast_ui_command(command: str, payload: dict | None = None) -> bool:
    """Push ein UI-Layout-Kommando an alle Frontends. command ∈
    {info, pane, info-section}, payload je nach Command. Wird vom Frontend
    auf das passende window-Event gemappt (deck:info, deck:pane, deck:info-section).
    Mehrfach-Empfänger pro Tab werden durch Frontend-Filter (nur paneIndex 0)
    auf einen Dispatch reduziert."""
    had_clients = bool(_connected_clients)
    await _broadcast(json.dumps({
        "type": "ui.command",
        "command": command,
        "payload": payload or {},
    }))
    return had_clients


async def broadcast_server_back(conv_ids: list[str]) -> bool:
    """Tell every connected frontend that the server is back after a restart, and
    which conversations had a live stream cut off by it. Each affected pane picks
    its own convId out of the list and resumes the thread with a "Server ist wieder
    da."-Turn — so parallele Sessions nicht mehr haendisch angestupst werden muessen.
    Returns True iff mindestens ein WS-Client verbunden war."""
    had_clients = bool(_connected_clients)
    await _broadcast(json.dumps({
        "type": "server.back",
        "conversationIds": [str(c) for c in conv_ids if c],
        "eventId": f"sb-{_uuid.uuid4().hex}",
    }))
    return had_clients


def _build_verbosity_marker(verbosity: str) -> str:
    """Steuert, wie viel Arbeitsweg/Reasoning Klaus sichtbar mitschreibt.

    Orthogonal zum Antwortmodus (der regelt die Länge der Endantwort, nicht das
    laufende Mitdenken zwischen den Tool-Schritten)."""
    v = (verbosity or "").lower().strip()
    if v == "full":
        return (
            "[Arbeitsweg: Voll] Du darfst deinen Arbeitsweg sichtbar mitschreiben, "
            "inklusive kurzer Zwischengedanken zwischen den Schritten."
        )
    if v == "result":
        return (
            "[Arbeitsweg: Aus] Schreibe deinen Denk- und Arbeitsweg NICHT mit. "
            "Keine Zwischenkommentare zwischen den Schritten, kein 'lass mich...', "
            "kein 'jetzt schaue ich...', keine Ankündigungen. Arbeite still und gib "
            "am Ende nur das fertige Ergebnis aus."
        )
    # Default: knapp — still arbeiten, am Ende ein Satz zum Vorgehen.
    return (
        "[Arbeitsweg: Knapp] Schreibe dein laufendes Mitdenken zwischen den "
        "Schritten nicht aus, kein 'lass mich...' oder 'jetzt schaue ich...'. "
        "Arbeite still und fasse erst am Ende in höchstens einem kurzen Satz "
        "zusammen, was du getan hast, dann das Ergebnis."
    )


def _build_mode_marker(deep_mode: bool, verbosity: str = "") -> str:
    """Expliziter Antwortmodus pro Nachricht. Klaus liest das als harte Anweisung."""
    if deep_mode:
        mode = (
            "[Modus: Tief] Volle Struktur einsetzen nach soul/STYLE.md: "
            "Überschriften als Labels, Trenner zwischen Blöcken, Bold-Lead für "
            "parallele Punkte, Listen und Tabellen wo sie tragen, Fazit am Ende. "
            "So tief und ausführlich wie das Thema verlangt. "
            "Volle Umlaute (ä, ö, ü, ß) im gesamten Output, nie ae/oe/ue/ss."
        )
    else:
        mode = (
            "[Modus: Kurz] So wenig Worte wie möglich, maximal drei kurze Sätze Prosa, "
            "warm und wie im Gespräch gesprochen. Laiensprache, Fachbegriffe nur wenn "
            "sie wirklich nötig sind und dann kurz einordnen. Ergebnis zuerst, dann "
            "knappe Einordnung, fertig. Formatierung sparsam erlaubt wenn sie die "
            "Antwort leichter macht: gelegentlich ein fettes Schlüsselwort, eine kurze "
            "Drei-Punkte-Liste oder eine Trennlinie, aber nie zur Deko und nie Pflicht. "
            "Code, Pfade, Zahlenblöcke und Shell-Kommandos gehören in einen Code-Block, "
            "der Rest bleibt Prosa. Im Zweifel kürzer statt länger. Wenn das Thema mehr "
            "trägt, biete am Ende in einem Satz an, tiefer zu gehen, statt ungefragt zu "
            "entfalten. Volle Umlaute (ä, ö, ü, ß) im gesamten Output, nie ae/oe/ue/ss."
        )
    return mode + "\n\n" + _build_verbosity_marker(verbosity)


def setup_streaming(app_config: dict):
    """Initialize streaming module with app config. Returns the router."""

    agents = app_config["agents"]
    projects_roots = app_config["projects_roots"]

    async def _run_agent_check(target_engine: str, prompt: str, cwd: str, consult_prompt: str) -> str:
        check_prompt = (
            consult_prompt
            + "Zu prüfender Inhalt:\n"
            + prompt
        )

        if target_engine == "claude":
            subprocess_env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
            proc = None
            try:
                proc = await _spawn_process(
                    "claude", "-p", "--model", "claude-opus-4-8",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                    env=subprocess_env,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(input=check_prompt.encode()), timeout=180)
                if proc.returncode != 0:
                    raise RuntimeError(stderr.decode(errors="replace").strip() or f"claude rc={proc.returncode}")
                return stdout.decode(errors="replace").strip()
            except asyncio.CancelledError:
                await _terminate_process(proc)
                raise
            finally:
                if proc and proc.returncode is None:
                    await _terminate_process(proc)

        with tempfile.NamedTemporaryFile(prefix="codex-agent-check-", suffix=".txt", delete=False) as tmp:
            out_path = tmp.name
        proc = None
        try:
            proc = await _spawn_process(
                "codex", "exec",
                "--skip-git-repo-check",
                "--sandbox", "read-only",
                "-C", cwd,
                "-o", out_path,
                "-",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(input=check_prompt.encode()), timeout=180)
            if proc.returncode != 0:
                err = stderr.decode(errors="replace").strip() or stdout.decode(errors="replace").strip()
                raise RuntimeError(err or f"codex rc={proc.returncode}")
            try:
                return Path(out_path).read_text(errors="replace").strip()
            except Exception:
                return stdout.decode(errors="replace").strip()
        except asyncio.CancelledError:
            await _terminate_process(proc)
            raise
        finally:
            if proc and proc.returncode is None:
                await _terminate_process(proc)
            try:
                os.remove(out_path)
            except Exception:
                pass

    async def _run_dual_sidecar(
        *,
        current_engine: str,
        conv_id: str,
        prompt: str,
        cwd: str,
        time_ctx: str,
        draft_answer: str,
        tool_calls: dict[str, dict],
    ) -> tuple[str, str]:
        """Hole synchronen Zweitblick auf den Draft des Hauptmodells.

        Returnt (review_text, target_label). Bei Fehler oder leerer Antwort
        wird ("", target_label) zurückgegeben, damit der Caller den Zweitpass
        sauber überspringen kann.
        """
        if not draft_answer.strip():
            return ("", "")
        target_engine = "claude" if current_engine == "codex" else "codex"
        target_label = _engine_label(target_engine)
        tool_summary = _summarize_dual_tool_calls(tool_calls)
        consult_prompt = (
            _build_consult_identity_context(conv_id, time_ctx)
            + _build_recent_chat_context(conv_id)
            + "Du bist Klaus' Zweitblick — das Hauptmodell hat seinen Draft fertig und holt jetzt "
              f"deinen Reality-Check ein, BEVOR {_of_stream()} die Antwort sieht. Höflichkeit ist hier "
              "ein Anti-Pattern. Bei UI/Optik nicht einmischen, Claudes Stil ist gesetzt; reviewe "
              f"nur Logik. Schreib menschlich, knapp und so, dass {_of_stream()} es ohne Techniksprech "
              "sofort versteht. Halte dich an das geforderte Format.\n\n"
        )
        try:
            review_subject = _build_dual_result_review_subject(prompt, draft_answer, tool_summary)
            answer = (await _run_agent_check(target_engine, review_subject, cwd, consult_prompt)).strip()
            return (answer, target_label)
        except Exception:
            return ("", target_label)

    @router.websocket("/ws")
    async def ws_endpoint(client: WebSocket):
        # deck.* kommt über den Cloudflare-Tunnel (fremde IP, nicht im Tailnet) —
        # wie die HTTP-Middleware am IP-Gitter vorbei, der Schutz liegt rein auf dem
        # Monitor-Token im Cookie (Pflicht unten, weil AGENT_TOKEN gesetzt ist).
        host = client.headers.get("host", "").split(":")[0]
        client_ip = client.client.host if client.client else ""
        if not host.startswith("deck.") and not client_ip_trusted(client_ip):
            await client.close(code=1008)
            return
        token = current_token()
        if token:
            provided = client.cookies.get("agent_auth", "") or client.query_params.get("token", "")
            if not token_matches(provided) and not monitor_token_valid(provided):
                await client.close(code=1008)
                return
        await client.accept()
        _connected_clients.add(client)
        try:
            while True:
                raw = await client.receive_text()
                msg = json.loads(raw)
                action = msg.get("action")

                if action == "send":
                    if _is_duplicate_send(msg.get("clientMessageId", "")):
                        continue
                    # Neue einheitliche Aktion: Engine wird pro Conversation aus der DB gelesen.
                    conv_id = msg.get("conversationId", "")
                    engine = get_conversation_engine(conv_id) if conv_id else "codex"
                    if await _enqueue_work_session_background(client, msg, engine):
                        continue
                    if engine == "claude":
                        asyncio.create_task(_handle_claude(client, msg))
                    else:
                        asyncio.create_task(_handle_codex(client, msg))
                elif action == "codex":
                    if _is_duplicate_send(msg.get("clientMessageId", "")):
                        continue
                    asyncio.create_task(_handle_codex(client, msg))
                elif action == "claude":
                    if _is_duplicate_send(msg.get("clientMessageId", "")):
                        continue
                    asyncio.create_task(_handle_claude(client, msg))
                elif action == "command":
                    asyncio.create_task(_handle_command(client, msg))
                elif action == "ping":
                    # App-Level-Heartbeat (siehe wsHub.ts). Haelt die Leitung durch
                    # den Tailscale-Tunnel warm und beweist Lebendigkeit; wir pongen
                    # mit einem Data-Frame zurueck, das der Client als lastRx zaehlt.
                    try:
                        await client.send_json({"type": "pong"})
                    except Exception:
                        pass
                elif action == "attach":
                    # Hard-Refresh-Reattach: Client holt sich Snapshot des laufenden Streams
                    # und meldet sich als Subscriber für Live-Events an.
                    conv_id_attach = msg.get("conversationId", "")
                    sess = _stream_sessions.get(conv_id_attach) if conv_id_attach else None
                    if sess and not sess.get("done"):
                        sess["subscribers"].add(client)
                        snap_evt = _build_snapshot_event(conv_id_attach)
                        if snap_evt:
                            try:
                                await client.send_json(snap_evt)
                            except Exception:
                                sess["subscribers"].discard(client)

        except WebSocketDisconnect:
            _connected_clients.discard(client)
            # Auch aus allen Stream-Subscribers entfernen, damit der Bus nicht
            # tote Sockets sammelt.
            for sess in _stream_sessions.values():
                sess["subscribers"].discard(client)

    async def _handle_codex(client: WebSocket, msg: dict):
        """Route message to Codex CLI (codex exec --json) with structured event parsing."""
        agent_id = normalize_agent_id(msg.get("agentId", "main"))
        message = str(msg.get("message") or "").strip()
        project = msg.get("project", "")
        conv_id = msg.get("conversationId", "")
        original_prompt = message
        deep_mode = msg.get("deepMode", False)
        verbosity = str(msg.get("verbosity", "") or "").lower().strip()
        attachments = msg.get("attachments", [])
        client_kind = (msg.get("clientKind") or "").strip().lower() or None
        agent_display = get_agent_display(agent_id)
        codex_model = _normalize_codex_model(msg.get("model"))
        if not message and not attachments:
            print(f"[streaming] codex: leerer User-Turn verworfen ({conv_id or 'no-conv'})")
            return
        if _should_drop_duplicate_user_input(conv_id, message):
            print(f"[dedupe] codex: identische User-Eingabe in {conv_id} verworfen")
            return
        if conv_id:
            _stop_requests.discard(conv_id)
            task = asyncio.current_task()
            if task is not None:
                _active_tasks[conv_id] = task
                _active_started_at.setdefault(conv_id, _time.time())
        # Codex CLI kennt nur low/medium/high. UI-Werte xhigh/max werden auf high gemappt.
        effort_raw = str(msg.get("effort", "") or "").lower().strip()
        if effort_raw in ("xhigh", "max"):
            codex_effort = "high"
        elif effort_raw in ("low", "medium", "high"):
            codex_effort = effort_raw
        else:
            codex_effort = ""

        # Stream-Bus initialisieren — origin ist Subscriber #1, Hard-Refresh-Clients
        # können später per `attach` dazustoßen.
        _start_stream_session(conv_id, agent_id, agent_display, client)

        async def _safe_send(data):
            data["conversationId"] = conv_id
            if conv_id:
                await _emit_event(conv_id, data)
            else:
                try:
                    await client.send_json(data)
                except Exception:
                    pass

        prev_user_ts: float | None = None
        if conv_id:
            with get_db() as db:
                row = db.execute(
                    "SELECT ts FROM messages WHERE conversation_id = ? AND author = 'Du' ORDER BY id DESC LIMIT 1",
                    (conv_id,)
                ).fetchone()
            if row:
                prev_user_ts = row[0]

        save_msg(agent_id, project, "Du", message, conv_id, attachments=json.dumps(attachments))
        learning_run_id = _start_learning_run("codex", agent_display, original_prompt, project, conv_id, codex_model)
        werkbank_task_id = _extract_werkbank_task_id(original_prompt)
        _mark_werkbank_task_running(werkbank_task_id)
        if conv_id:
            auto_title(conv_id, message)
            auto_project(conv_id)
        message += await build_attachment_context(attachments)
        message += "\n\n" + _build_mode_marker(deep_mode, verbosity)
        await broadcast_sync(agent_id, conv_id, source=client_kind)

        time_ctx = build_time_context(prev_user_ts)

        cwd = str(Path(project)) if project and Path(project).is_dir() else str(Path(__file__).parent.parent)
        _attach_git_diff_baseline(conv_id, cwd)
        dual_mode = False
        if conv_id:
            try:
                with get_db() as db:
                    row = db.execute("SELECT dual_mode FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                dual_mode = bool(row[0]) if row else False
            except Exception:
                dual_mode = False

        codex_session_id = get_codex_session_id(conv_id) if conv_id else ""
        codex_network_access = _work_session_needs_external_network(original_prompt)

        # Frontend behält letzten echten Wert, bis turn.completed echte Tokens liefert.
        recent_context = ""
        context_tokens = 0

        _sess_for_start = _stream_sessions.get(conv_id) if conv_id else None
        await _safe_send({
            "type": "agent.start",
            "agent": agent_display,
            "agentId": agent_id,
            "startedAt": int((_sess_for_start["started_at"] if _sess_for_start else _time.time()) * 1000),
        })

        def _build_codex_cmd(session_id: str = "") -> list:
            return build_codex_exec_cmd(
                model=codex_model,
                cwd=cwd,
                effort=codex_effort,
                session_id=session_id,
                network_access=codex_network_access,
            )

        cmd = _build_codex_cmd(session_id=codex_session_id)
        tool_calls: dict[str, dict] = {}

        identity_ctx = build_identity_context(agent_id, "Codex CLI")

        if not codex_session_id and conv_id:
            # Fresh session: hand the last messages in via stdin so Codex has the thread context.
            with get_db() as db:
                ctx_rows = db.execute(
                    "SELECT author, content FROM messages WHERE conversation_id = ? AND content != '' ORDER BY id DESC LIMIT 20",
                    (conv_id,)
                ).fetchall()
            if ctx_rows:
                ctx_parts = [f"{r[0]}: {r[1][:1000]}" for r in reversed(ctx_rows)]
                recent_context = "Kontext aus vorherigen Nachrichten:\n" + "\n---\n".join(ctx_parts) + "\n---\n\n"
        dual_reason = ""
        if dual_mode:
            dual_reason = _dual_sidecar_reason(message, project, force=True)
        # Two-Pass aktiv heißt: Text des ersten Passes wird gepuffert (NICHT ans UI),
        # danach Sidecar-Review, danach finaler Synthese-Pass dessen Text der Nutzer sieht.
        two_pass_active = bool(dual_reason)

        proc = None
        full_text = ""
        text_segments: list[str] = []
        usage_in = 0
        usage_out = 0
        codex_raw_in = 0
        codex_raw_cached = 0
        done_sent = False
        _partial_row_id = 0
        if conv_id:
            _partial_row_id = insert_partial(agent_id, project, agent_display, "", conv_id)
        thread_id = ""
        _file_snapshots: Dict[str, Dict[str, str]] = {}

        def _read_file_for_diff(path: str, max_bytes: int = 524288) -> str:
            try:
                from pathlib import Path
                p = Path(path)
                if not p.is_file():
                    return ""
                if p.stat().st_size > max_bytes:
                    return ""
                return p.read_text(encoding="utf-8", errors="replace")
            except Exception:
                return ""

        def _codex_file_change_diff(item: dict, snap: Dict[str, str]) -> Optional[Dict[str, int]]:
            import difflib
            added = 0
            removed = 0
            for ch in (item.get("changes") or []):
                path = ch.get("path") or ch.get("file_path") or ""
                kind = (ch.get("kind") or "").lower()
                if not path:
                    continue
                if kind == "add":
                    new_text = _read_file_for_diff(path)
                    added += len(new_text.splitlines()) if new_text else 0
                elif kind == "delete":
                    old = snap.get(path, "")
                    removed += len(old.splitlines()) if old else 0
                else:
                    old = snap.get(path, "")
                    new_text = _read_file_for_diff(path)
                    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old.splitlines(), new_text.splitlines()).get_opcodes():
                        if tag == "insert":
                            added += j2 - j1
                        elif tag == "delete":
                            removed += i2 - i1
                        elif tag == "replace":
                            added += j2 - j1
                            removed += i2 - i1
            if not added and not removed:
                return None
            return {"added": added, "removed": removed}

        def _tool_display(item: dict) -> tuple[str, dict, str]:
            """Map a codex item to (tool_name, input_dict, short_description)."""
            item_type = item.get("type", "")
            if item_type == "command_execution":
                cmd_str = str(item.get("command", ""))
                return ("Bash", {"command": cmd_str}, cmd_str[:200])
            if item_type == "file_change":
                path = item.get("path") or item.get("file_path", "")
                return ("Edit", {"file_path": path}, str(path))
            name = item_type or "tool"
            short = ""
            for k in ("path", "file_path", "query", "pattern"):
                if item.get(k):
                    short = str(item[k])[:200]
                    break
            return (name, {k: v for k, v in item.items() if k in ("path", "file_path", "query", "pattern", "command")}, short)

        def _is_context_overflow(m: str) -> bool:
            # Codex hält sein Kontextfenster selbst; läuft es voll, meldet es das als turn.failed.
            ml = (m or "").lower()
            return "ran out of room" in ml or "context window" in ml or "context length" in ml

        def _is_stale_session(m: str) -> bool:
            # Resume zielt auf eine Codex-Session, die es nicht mehr gibt (Session
            # gepruned, CLI neu gestartet). Dann scheitert jeder Folge-Turn, bis die
            # gespeicherte Session-ID verworfen wird. Symptome variieren je Codex-Version.
            ml = (m or "").lower()
            return (
                ("session" in ml and ("not found" in ml or "no longer" in ml or "expired" in ml or "missing" in ml))
                or "no conversation" in ml
                or "could not resume" in ml
                or "failed to resume" in ml
                or ("resume" in ml and "not found" in ml)
            )

        # Kontext-Bausteine einmal bauen; _compose_stdin/_consume_codex lesen sie spät (Closure).
        wa_ctx = build_whatsapp_project_context(project)
        focus_ctx = build_focus_snapshot()
        item_ctx = build_focus_item_context(conv_id)
        quick_ctx = build_focus_quick_add_context(conv_id)
        session_ctx = build_session_context(conv_id)
        person_ctx = build_person_context(message, conv_id)
        router_ctx = build_context_router_context(message, conv_id)
        broker_ctx = broker_tool_context(conv_id, project)

        def _compose_stdin(rc: str) -> str:
            return identity_ctx + time_ctx + session_ctx + (rc or "") + focus_ctx + router_ctx + broker_ctx + item_ctx + quick_ctx + wa_ctx + person_ctx + message

        async def _consume_codex(proc) -> str:
            """Liest einen Codex-Lauf bis zum Ende. Gibt 'overflow' zurück, wenn das
            Kontextfenster vollgelaufen ist, sonst 'ok'. Mutiert die Lauf-Variablen."""
            nonlocal full_text, usage_in, usage_out, codex_raw_in, codex_raw_cached, thread_id, _partial_row_id
            buf = b""
            _CODEX_READ_TIMEOUT = 1800  # 30 min ohne Output → kill
            _wall_start = _time.time()
            while True:
                _remaining = _MAX_WALL_SECONDS - (_time.time() - _wall_start)
                if _remaining <= 0:
                    await _terminate_process(proc)
                    _msg = "Codex-Lauf nach Zeitlimit abgebrochen (Wall-Clock)."
                    full_text = (full_text + "\n\n" + _msg) if full_text else _msg
                    break
                try:
                    chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=min(_CODEX_READ_TIMEOUT, _remaining))
                except asyncio.TimeoutError:
                    await _terminate_process(proc)
                    _idle = (_time.time() - _wall_start) < _MAX_WALL_SECONDS
                    _msg = "Codex-Prozess nach 30 Min Inaktivität abgebrochen." if _idle else "Codex-Lauf nach Zeitlimit abgebrochen (Wall-Clock)."
                    full_text = (full_text + "\n\n" + _msg) if full_text else _msg
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line_bytes, buf = buf.split(b"\n", 1)
                    line = line_bytes.decode("utf-8", errors="replace").strip()
                    if not line or not line.startswith("{"):
                        continue
                    try:
                        evt = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    evt_type = evt.get("type", "")

                    if evt_type == "thread.started":
                        thread_id = evt.get("thread_id", "") or thread_id
                        if thread_id and conv_id:
                            set_codex_session_id(conv_id, thread_id)

                    elif evt_type == "item.started":
                        item = evt.get("item", {})
                        item_id = item.get("id", "")
                        item_type = item.get("type", "")
                        if item_type == "agent_message":
                            continue
                        tool_name, tool_input, short = _tool_display(item)
                        tool_calls[item_id] = {"name": tool_name, "input": tool_input, "result": "", "status": "running"}
                        # Snapshot der betroffenen Dateien vor file_change, um nachher Diff zu rechnen
                        if item_type == "file_change":
                            snap: Dict[str, str] = {}
                            for ch in (item.get("changes") or []):
                                p = ch.get("path") or ch.get("file_path") or ""
                                if not p:
                                    continue
                                snap[p] = _read_file_for_diff(p)
                            _file_snapshots[item_id] = snap
                        await _safe_send({
                            "type": "agent.tool",
                            "agent": agent_display,
                            "tool": tool_name,
                            "input": tool_input,
                            "result": short,
                            "status": "running",
                            "toolId": item_id,
                        })

                    elif evt_type == "item.completed":
                        item = evt.get("item", {})
                        item_id = item.get("id", "")
                        item_type = item.get("type", "")
                        if item_type == "agent_message":
                            text = item.get("text", "")
                            if text:
                                # Codex liefert komplette Message-Segmente:
                                # Zwischenmeldungen, Arbeitsupdates, finale Antwort.
                                # Wir speichern sie separat, damit das Frontend im
                                # Modus "Nur Ergebnis" nur das letzte Segment zeigen kann.
                                text_segments.append(text)
                                full_text = "\n\n".join(text_segments)
                                if not two_pass_active:
                                    await _safe_send({
                                        "type": "agent.text",
                                        "agent": agent_display,
                                        "delta": text,
                                        "full": full_text,
                                        "segments": text_segments,
                                    })
                                    segments_json = json.dumps(text_segments)
                                    if not _partial_row_id:
                                        _partial_row_id = insert_partial(agent_id, project, agent_display, full_text, conv_id, segments=segments_json)
                                    else:
                                        update_partial(_partial_row_id, full_text, segments=segments_json)
                        else:
                            # Tool-Abschluss: Output aus aggregated_output oder vergleichbarem Feld
                            output = str(item.get("aggregated_output") or item.get("output") or item.get("result") or "")[:2000]
                            exit_code = item.get("exit_code")
                            status = item.get("status") or ("completed" if exit_code in (0, None) else "error")
                            diff_stats = None
                            if item_type == "file_change":
                                diff_stats = _codex_file_change_diff(item, _file_snapshots.pop(item_id, {}))
                            if item_id in tool_calls:
                                tool_calls[item_id]["result"] = output
                                tool_calls[item_id]["status"] = status
                                if diff_stats:
                                    tool_calls[item_id]["diff_stats"] = diff_stats
                            else:
                                tool_name, tool_input, short = _tool_display(item)
                                tool_calls[item_id] = {"name": tool_name, "input": tool_input, "result": output, "status": status}
                                if diff_stats:
                                    tool_calls[item_id]["diff_stats"] = diff_stats
                            await _safe_send({
                                "type": "agent.toolDone",
                                "toolId": item_id,
                                "status": status,
                                "output": output,
                                "diffStats": diff_stats,
                            })

                    elif evt_type == "turn.completed":
                        usage = evt.get("usage", {}) or {}
                        inp = int(usage.get("input_tokens", 0) or 0)
                        cached = int(usage.get("cached_input_tokens", 0) or 0)
                        out = int(usage.get("output_tokens", 0) or 0)
                        # Sichtbare Chat-Tokens: uncached input + output.
                        # Cached input ist fuer Cost/Debug relevant, wirkt im Footer
                        # aber wie ein falscher Millionen-Verbrauch pro Antwort.
                        usage_in = max(0, inp - cached)
                        usage_out = out
                        codex_raw_in = inp
                        codex_raw_cached = cached
                        await _safe_send({
                            "type": "agent.usage",
                            "contextTokens": usage_in + usage_out,
                            "contextWindow": 272_000,
                            "inputTokens": usage_in,
                            "outputTokens": usage_out,
                            "rawInputTokens": codex_raw_in,
                            "cachedInputTokens": codex_raw_cached,
                        })

                    elif evt_type == "turn.failed":
                        err = evt.get("error", {}) or {}
                        err_msg = err.get("message") or json.dumps(err)
                        if _is_context_overflow(err_msg):
                            return "overflow"
                        if codex_session_id and _is_stale_session(err_msg):
                            return "stale_session"
                        full_text += f"\n\nCodex-Fehler: {err_msg}" if full_text else f"Codex-Fehler: {err_msg}"

            return "ok"

        try:
            proc = await _spawn_process(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
            )
            if conv_id:
                _active_procs[conv_id] = proc
                _active_started_at.setdefault(conv_id, _time.time())
            proc.stdin.write(_compose_stdin(recent_context).encode())
            proc.stdin.close()

            outcome = await _consume_codex(proc)
            await proc.wait()

            # Stiller Resume-Tod: Codex bricht ohne turn.failed-JSON ab (kein Text,
            # Exit != 0) wenn die Resume-Session weg ist. Auch das frisch anknüpfen.
            if outcome == "ok" and codex_session_id and not full_text.strip() and proc.returncode not in (0, None):
                outcome = "stale_session"

            if outcome in ("overflow", "stale_session"):
                # Auto-Recovery: tote Resume-Session verwerfen und im selben Turn
                # frisch mit den letzten Nachrichten als Aufwärm-Kontext neu auffahren.
                _recover_reason = (
                    "Codex-Kontextfenster war voll"
                    if outcome == "overflow"
                    else "Codex-Resume-Session war tot"
                )
                _recover_label = (
                    "Kontext war voll, ich knüpfe frisch an"
                    if outcome == "overflow"
                    else "Session war abgelaufen, ich knüpfe frisch an"
                )
                if conv_id:
                    set_codex_session_id(conv_id, "")
                try:
                    from automation_registry import mark_tick
                    mark_tick(
                        "hook", "codex-context-recovery", "ok",
                        f"{_recover_reason}, Session zurückgesetzt und mit dem bisherigen Verlauf frisch angeknüpft.",
                        {"conversation_id": conv_id or "", "model": codex_model, "outcome": outcome},
                    )
                except Exception:
                    pass
                await _safe_send({
                    "type": "agent.phase",
                    "phase": "recover",
                    "label": _recover_label,
                })
                # Lauf-Zustand für den sauberen zweiten Durchlauf zurücksetzen.
                full_text = ""
                text_segments.clear()
                tool_calls.clear()
                _file_snapshots.clear()
                thread_id = ""
                usage_in = usage_out = codex_raw_in = codex_raw_cached = 0
                recovery_ctx = ""
                try:
                    with get_db() as db:
                        ctx_rows = db.execute(
                            "SELECT author, content FROM messages WHERE conversation_id = ? AND content != '' ORDER BY id DESC LIMIT 20",
                            (conv_id,),
                        ).fetchall()
                    if ctx_rows:
                        ctx_parts = [f"{r[0]}: {r[1][:1000]}" for r in reversed(ctx_rows)]
                        recovery_ctx = "Kontext aus vorherigen Nachrichten:\n" + "\n---\n".join(ctx_parts) + "\n---\n\n"
                except Exception:
                    pass
                cmd = _build_codex_cmd(session_id="")
                proc = await _spawn_process(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=cwd,
                )
                if conv_id:
                    _active_procs[conv_id] = proc
                proc.stdin.write(_compose_stdin(recovery_ctx).encode())
                proc.stdin.close()
                await _consume_codex(proc)
                await proc.wait()
                # Zweiter stiller Tod: auch der frische Lauf brachte nichts. Statt
                # leerer "toter" Session ein sichtbares Signal an der Nutzer geben.
                if not full_text.strip():
                    full_text = "Codex konnte nach dem Neuanknüpfen nicht antworten. Schick die Nachricht bitte noch einmal."

            full_text = linkify_file_paths(full_text)

            # Two-Pass: Draft ist fertig (Tools sichtbar, Text gepuffert). Jetzt
            # Sidecar holen, dann Final-Synthese, dann erst die Antwort an der Nutzer.
            if two_pass_active and full_text.strip() and conv_id not in _stop_requests:
                draft_text = full_text
                await _safe_send({
                    "type": "agent.phase",
                    "phase": "review",
                    "label": "Zweitblick einholen",
                })
                review_text, target_label = await _run_dual_sidecar(
                    current_engine="codex",
                    conv_id=conv_id,
                    prompt=message,
                    cwd=cwd,
                    time_ctx=time_ctx,
                    draft_answer=draft_text,
                    tool_calls=dict(tool_calls),
                )
                final_text = ""
                if review_text.strip():
                    await _safe_send({
                        "type": "agent.phase",
                        "phase": "finalize",
                        "label": "Antwort finalisieren",
                    })
                    final_prompt = (
                        f"Du hast intern bereits einen Antwort-Draft formuliert. {_of_stream()} hat ihn "
                        "NICHT gesehen — er liest erst diese finale Version. Eben kam noch ein "
                        "knapper Reality-Check von " + target_label + " dazu, den du nüchtern prüfst.\n\n"
                        "Dein interner Draft:\n" + draft_text.strip() + "\n\n"
                        + target_label + "s Reality-Check:\n" + review_text.strip() + "\n\n"
                        f"Schreib jetzt die finale Antwort an {_of_stream()}. Übernimm aus dem "
                        "Reality-Check NUR, was die Antwort klarer, robuster oder einfacher macht — "
                        "wenn ein Punkt nicht passt, ignorier ihn. EINE integrierte Antwort: kein "
                        "Review-Block, kein Block-Header, kein Hinweis dass es einen Zweitblick gab. "
                        "Wenn der Draft im Wesentlichen passt, übernimm ihn fast wörtlich. Antworte "
                        f"direkt — {_of_stream()} liest nur das hier.\n"
                    )
                    final_consult = (
                        _build_consult_identity_context(conv_id, time_ctx)
                        + _build_recent_chat_context(conv_id)
                    )
                    try:
                        final_text = (await _run_agent_check("codex", final_prompt, cwd, final_consult)).strip()
                    except Exception:
                        final_text = ""
                # Fallback: kein Review oder leere Final-Synthese → Draft so verwenden.
                if not final_text:
                    final_text = draft_text
                full_text = linkify_file_paths(final_text)
                text_segments = [full_text]
                # Jetzt erst sieht der Nutzer den Text.
                await _safe_send({
                    "type": "agent.text",
                    "agent": agent_display,
                    "delta": full_text,
                    "full": full_text,
                    "segments": text_segments,
                })

            def _slim_input(tc: dict) -> dict:
                pi = tc.get("input", {}) or {}
                slim = {}
                for k in ("file_path", "path", "command", "pattern", "query"):
                    if k in pi:
                        slim[k] = str(pi[k])[:500]
                return slim

            tools_json = json.dumps([{
                "name": tc.get("name", ""),
                "result": (tc.get("result") or "")[:500],
                "input": _slim_input(tc),
                "diffStats": tc.get("diff_stats"),
            } for tc in tool_calls.values()])
            segments_json = json.dumps(text_segments)

            _sess = _stream_sessions.get(conv_id) if conv_id else None
            elapsed_ms = int((_time.time() - _sess["started_at"]) * 1000) if _sess else None

            if _partial_row_id:
                if full_text.strip():
                    update_partial(_partial_row_id, full_text, tools=tools_json, elapsed_ms=elapsed_ms, segments=segments_json, complete=True, input_tokens=usage_in, output_tokens=usage_out)
                else:
                    from db import delete_msg
                    delete_msg(_partial_row_id)
            elif full_text.strip():
                save_msg(agent_id, project, agent_display, full_text, conv_id, tools=tools_json, elapsed_ms=elapsed_ms, segments=segments_json, input_tokens=usage_in, output_tokens=usage_out)
            await broadcast_sync(agent_id, conv_id, source=client_kind)
            update_letzter_stand(project, agent_display, full_text, projects_roots)

            final_tokens = (usage_in + usage_out) or (context_tokens + len(full_text) // 4)
            did_work = _did_substantial_work(tool_calls)
            _finish_learning_run(
                learning_run_id,
                status="stopped" if conv_id in _stop_requests else "ok",
                final_text=full_text,
                elapsed_ms=elapsed_ms,
                tool_calls=tool_calls,
                input_tokens=usage_in,
                output_tokens=usage_out,
            )
            werkbank_report_parent = await asyncio.to_thread(
                _finish_werkbank_chat_handoff,
                werkbank_task_id,
                status="stopped" if conv_id in _stop_requests else "ok",
                final_text=full_text,
                tool_calls=tool_calls,
                elapsed_ms=elapsed_ms,
                input_tokens=usage_in,
                output_tokens=usage_out,
                changed_lines=_diff_totals_with_git(tool_calls, _sess, cwd),
            )
            if werkbank_report_parent and werkbank_report_parent != conv_id:
                await broadcast_sync(agent_id, werkbank_report_parent, source="werkbank")
            try:
                _log_call(
                    feature="chat_codex",
                    provider="openai",
                    model=codex_model,
                    latency_ms=elapsed_ms or 0,
                    ok=True,
                    input_tokens=codex_raw_in,
                    output_tokens=usage_out,
                    cache_read_tokens=codex_raw_cached,
                    cache_creation_tokens=0,
                    conversation_id=conv_id or "",
                )
            except Exception:
                pass
            if conv_id in _stop_requests:
                await _safe_send({
                    "type": "agent.done",
                    "agent": agent_display,
                    "status": "stopped",
                    "model": codex_model.upper() if codex_model.startswith("gpt-") else codex_model,
                    "contextTokens": final_tokens,
                    "contextWindow": 272_000,
                    "inputTokens": usage_in,
                    "outputTokens": usage_out,
                    "elapsedMs": elapsed_ms,
                })
                done_sent = True
            else:
                await _safe_send({
                    "type": "agent.done",
                    "agent": agent_display,
                    "status": "ok",
                    "model": codex_model.upper() if codex_model.startswith("gpt-") else codex_model,
                    "contextTokens": final_tokens,
                    "contextWindow": 272_000,
                    "inputTokens": usage_in,
                    "outputTokens": usage_out,
                    "elapsedMs": elapsed_ms,
                })
                done_sent = True

        except asyncio.CancelledError:
            raise
        except Exception as e:
            _sess = _stream_sessions.get(conv_id) if conv_id else None
            elapsed_ms = int((_time.time() - _sess["started_at"]) * 1000) if _sess else None
            _finish_learning_run(
                learning_run_id if 'learning_run_id' in locals() else None,
                status="error",
                final_text=full_text,
                error=str(e),
                elapsed_ms=elapsed_ms,
                tool_calls=tool_calls if 'tool_calls' in locals() else {},
                input_tokens=usage_in if 'usage_in' in locals() else 0,
                output_tokens=usage_out if 'usage_out' in locals() else 0,
            )
            await _safe_send({
                "type": "agent.done",
                "agent": agent_display,
                "status": "error",
                "error": str(e),
            })
            done_sent = True
        finally:
            # Abgebrochene/fehlgeschlagene Streams erreichen den finalen
            # complete-Call nicht; ihre Row bleibt incomplete und steht nicht im
            # FTS-Index. Einmal nachziehen, sonst sind Teilantworten nicht
            # durchsuchbar. Idempotent, no-op wenn schon final indiziert.
            _prid = locals().get("_partial_row_id")
            if _prid:
                try:
                    from db import reindex_chat_msg_if_incomplete
                    reindex_chat_msg_if_incomplete(_prid)
                except Exception:
                    pass
                # Flacker-Schutz: Reisst die Client-Verbindung nach dem letzten
                # Delta, aber vor dem finalen complete-Update ab, bliebe die
                # fertig gestreamte Antwort incomplete und das Frontend würde sie
                # automatisch fortsetzen. Wenn substanzieller Text da ist, gilt
                # sie als fertig — kein falscher Auto-Resume mehr.
                _ft = locals().get("full_text") or ""
                if _ft.strip():
                    try:
                        from db import mark_msg_complete
                        mark_msg_complete(_prid)
                    except Exception:
                        pass
            if conv_id and conv_id in _stop_requests and not done_sent:
                _sess = _stream_sessions.get(conv_id)
                elapsed_ms = int((_time.time() - _sess["started_at"]) * 1000) if _sess else None
                try:
                    await _safe_send({
                        "type": "agent.done",
                        "agent": agent_display,
                        "status": "stopped",
                        "model": codex_model.upper() if codex_model.startswith("gpt-") else codex_model,
                        "contextTokens": (usage_in + usage_out) or (context_tokens + len(full_text) // 4),
                        "contextWindow": 272_000,
                        "inputTokens": usage_in,
                        "outputTokens": usage_out,
                        "elapsedMs": elapsed_ms,
                    })
                except Exception:
                    pass
            if conv_id:
                _active_procs.pop(conv_id, None)
                _active_tasks.pop(conv_id, None)
                _active_started_at.pop(conv_id, None)
                _end_stream_session(conv_id)
                _stop_requests.discard(conv_id)
            if proc and proc.returncode is None:
                try:
                    await _terminate_process(proc)
                except Exception:
                    pass

    async def _handle_claude(client: WebSocket, msg: dict):
        """Route message to Claude Code CLI with structured stream-json output."""
        message = str(msg.get("message") or "").strip()
        original_prompt = message
        project = msg.get("project", "")
        conv_id = msg.get("conversationId", "")
        effort_raw = str(msg.get("effort", "") or "").lower().strip()
        effort = effort_raw if effort_raw in ("low", "medium", "high", "xhigh", "max") else ""
        # Fallback: altes fastMode-Flag noch lesen, bis alle Clients migriert sind.
        if not effort and msg.get("fastMode"):
            effort = "low"
        deep_mode = msg.get("deepMode", False)
        verbosity = str(msg.get("verbosity", "") or "").lower().strip()
        attachments = msg.get("attachments", [])
        client_kind = (msg.get("clientKind") or "").strip().lower() or None
        agent_id = "main"
        agent_display = get_agent_display(agent_id)
        # Resume: abgerissene Antwort fortsetzen statt neuen User-Turn starten.
        resume_row_id = int(msg.get("resumeRowId", 0) or 0)
        resume_seed = ""
        if resume_row_id:
            resume_seed = get_msg_content(resume_row_id) or ""
            message = ""          # kein neuer User-Turn
            msg["silent"] = True  # keine User-Bubble speichern
        if not message and not attachments and not resume_row_id:
            print(f"[streaming] claude: leerer User-Turn verworfen ({conv_id or 'no-conv'})")
            return
        if _should_drop_duplicate_user_input(conv_id, message):
            print(f"[dedupe] claude: identische User-Eingabe in {conv_id} verworfen")
            return
        if conv_id:
            _stop_requests.discard(conv_id)
            task = asyncio.current_task()
            if task is not None:
                _active_tasks[conv_id] = task
                _active_started_at.setdefault(conv_id, _time.time())

        # Stream-Bus initialisieren — origin ist Subscriber #1, Hard-Refresh-Clients
        # können später per `attach` dazustoßen.
        _start_stream_session(conv_id, agent_id, agent_display, client)

        async def _safe_send(data):
            data["conversationId"] = conv_id
            if conv_id:
                await _emit_event(conv_id, data)
            else:
                try:
                    await client.send_json(data)
                except Exception:
                    pass

        prev_user_ts: float | None = None
        if conv_id:
            with get_db() as db:
                row = db.execute(
                    "SELECT ts FROM messages WHERE conversation_id = ? AND author = 'Du' ORDER BY id DESC LIMIT 1",
                    (conv_id,)
                ).fetchone()
            if row:
                prev_user_ts = row[0]

        learning_run_id = None
        werkbank_task_id = None
        if (message or attachments) and not msg.get("silent"):
            save_msg(agent_id, project, "Du", message, conv_id, attachments=json.dumps(attachments))
            learning_run_id = _start_learning_run("claude", agent_display, original_prompt, project, conv_id, "claude-opus-4-8")
            werkbank_task_id = _extract_werkbank_task_id(original_prompt)
            _mark_werkbank_task_running(werkbank_task_id)
            if conv_id and message:
                auto_title(conv_id, message)
                auto_project(conv_id)
            message += await build_attachment_context(attachments)
            message += "\n\n" + _build_mode_marker(deep_mode, verbosity)
        if resume_row_id:
            # Resume-Guard: Sieht die angezeigte Antwort schon abgeschlossen aus,
            # gibt es nichts fortzusetzen. Dann nur als fertig markieren statt
            # einen Lauf zu starten, der den Schlusssatz dupliziert.
            if _looks_complete(resume_seed):
                try:
                    from db import mark_msg_complete
                    mark_msg_complete(resume_row_id)
                except Exception:
                    pass
                await _safe_send({"type": "agent.done", "agent": agent_display, "status": "ok"})
                if conv_id:
                    _active_procs.pop(conv_id, None)
                    _active_tasks.pop(conv_id, None)
                    _active_started_at.pop(conv_id, None)
                    _end_stream_session(conv_id)
                    _stop_requests.discard(conv_id)
                return
            # Prompt für die Fortsetzung — der angezeigte Teil als Referenz, nicht wiederholen.
            tail = resume_seed[-1500:]
            message = (
                "Die Verbindung war kurz unterbrochen und deine vorherige Antwort wurde dadurch abgeschnitten. "
                "Setze sie nahtlos fort: schreibe direkt an der Abbruchstelle weiter, ohne Begrüßung, "
                "ohne das bereits Geschriebene zu wiederholen, ohne Meta-Kommentar. "
                "Hier ist der bereits angezeigte Teil als Referenz, nicht wiederholen:\n\n" + tail
            )
        await broadcast_sync(agent_id, conv_id, source=client_kind)

        time_ctx = build_time_context(prev_user_ts)

        cwd = str(Path(project)) if project and Path(project).is_dir() else str(Path(__file__).parent.parent)
        _attach_git_diff_baseline(conv_id, cwd)
        dual_mode = False
        if conv_id:
            try:
                with get_db() as db:
                    row = db.execute("SELECT dual_mode FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                dual_mode = bool(row[0]) if row else False
            except Exception:
                dual_mode = False

        # Session management: reuse existing or create deterministic UUID
        claude_session_id = get_claude_session_id(conv_id) if conv_id else ""

        # Modell pro Conversation (Default Opus 4.8, Klaus-Channel idR Sonnet 4.6).
        claude_model = "claude-opus-4-8"
        if conv_id:
            try:
                with get_db() as db:
                    row = db.execute("SELECT model FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                if row and row[0]:
                    claude_model = row[0]
            except Exception:
                pass

        # Vor dem Senden keine Schätzung mehr — Frontend behält den letzten echten Wert,
        # bis der erste message_delta mit echtem Usage reinkommt.
        identity_ctx = build_identity_context(agent_id, "Claude Code")
        recent_context = ""
        context_tokens = 0
        tool_calls = {}  # toolId -> {name, input_json, ...}

        _sess_for_start = _stream_sessions.get(conv_id) if conv_id else None
        await _safe_send({
            "type": "agent.start",
            "agent": agent_display,
            "agentId": agent_id,
            "startedAt": int((_sess_for_start["started_at"] if _sess_for_start else _time.time()) * 1000),
        })

        def _build_claude_cmd(session_id: str = "", new_session_id: str = "") -> list:
            return build_claude_print_cmd(model=claude_model, effort=effort, session_id=session_id, new_session_id=new_session_id)

        cmd = _build_claude_cmd(session_id=claude_session_id)
        if not claude_session_id and conv_id:
            # Fresh session nach Restart oder erster Message: Kontext aus DB
            # mitgeben, damit Claude den Thread kennt. UUID zufällig (uuid4),
            # weil eine deterministische UUID5 mit einer alten Session-Datei in
            # ~/.claude/projects/ kollidiert und claude dann stumm bleibt.
            with get_db() as db:
                ctx_rows = db.execute(
                    "SELECT author, content FROM messages WHERE conversation_id = ? AND content != '' ORDER BY id DESC LIMIT 20",
                    (conv_id,)
                ).fetchall()
            if ctx_rows:
                ctx_parts = [f"{r[0]}: {r[1][:1000]}" for r in reversed(ctx_rows)]
                recent_context = "Kontext aus vorherigen Nachrichten:\n" + "\n---\n".join(ctx_parts) + "\n---\n\n"
            session_uuid = str(_uuid.uuid4())
            cmd = _build_claude_cmd(new_session_id=session_uuid)
            set_claude_session_id(conv_id, session_uuid)
        dual_reason = ""
        if dual_mode:
            dual_reason = _dual_sidecar_reason(message, project, force=True)
        two_pass_active = bool(dual_reason)

        # Claude CLI unterdrückt granulares Streaming (stream_event/text_delta),
        # sobald ANTHROPIC_API_KEY im Env liegt — dann liefert sie nur aggregierte
        # "message"/"text"-Events, die unser Parser nicht liest. Credentials aus
        # ~/.claude/.credentials.json reichen aus, also Env für Subprocess stripen.
        subprocess_env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

        proc = None
        full_text = ""
        if resume_row_id:
            # Akkumulator mit dem bereits gezeigten Text seeden, damit agent.text-Events
            # full = bisher + neu tragen und die finale Bubble komplett ist.
            full_text = resume_seed
        total_input_tokens = 0
        total_output_tokens = 0
        last_output_usage_seen = 0
        # Letztes Roh-Usage für Cost-Berechnung (Cache-Read/Creation getrennt halten)
        last_usage_raw = {"input_tokens": 0, "cache_read": 0, "cache_creation": 0, "output_tokens": 0}
        done_sent = False
        _logged = False
        engine_error = ""
        try:
            proc = await _spawn_process(
                *cmd,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=subprocess_env,
            )
            if conv_id:
                _active_procs[conv_id] = proc
                _active_started_at.setdefault(conv_id, _time.time())
            wa_ctx = build_whatsapp_project_context(project)
            focus_ctx = build_focus_snapshot()
            item_ctx = build_focus_item_context(conv_id)
            quick_ctx = build_focus_quick_add_context(conv_id)
            session_ctx = build_session_context(conv_id)
            person_ctx = build_person_context(message, conv_id)
            router_ctx = build_context_router_context(message, conv_id)
            broker_ctx = broker_tool_context(conv_id, project)
            stdin_text = identity_ctx + time_ctx + session_ctx + (recent_context if recent_context else "") + focus_ctx + router_ctx + broker_ctx + item_ctx + quick_ctx + wa_ctx + person_ctx + message
            proc.stdin.write(stdin_text.encode())
            proc.stdin.close()

            # Quick check: if resume fails, stderr will have "No conversation found"
            # Read first chunk to detect this early
            if claude_session_id:
                try:
                    first_chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=10)
                except asyncio.TimeoutError:
                    first_chunk = b""
                if not first_chunk or b"No conversation found" in first_chunk or b'"is_error":true' in first_chunk:
                    # Session expired — kill and retry without --resume
                    print(f"[Claude] Session {claude_session_id[:8]}... expired — retrying fresh")
                    try:
                        await _terminate_process(proc)
                    except Exception:
                        pass
                    set_claude_session_id(conv_id, "")
                    session_uuid = str(_uuid.uuid4())
                    cmd = _build_claude_cmd(new_session_id=session_uuid)
                    set_claude_session_id(conv_id, session_uuid)
                    # Build context from recent messages
                    if conv_id:
                        with get_db() as db:
                            ctx_rows = db.execute(
                                "SELECT author, content FROM messages WHERE conversation_id = ? AND content != '' ORDER BY id DESC LIMIT 20",
                                (conv_id,)
                            ).fetchall()
                        if ctx_rows:
                            ctx_parts = [f"{r[0]}: {r[1][:1000]}" for r in reversed(ctx_rows)]
                            recent_context = "Kontext aus vorherigen Nachrichten:\n" + "\n---\n".join(ctx_parts) + "\n---\n\n"
                    proc = await _spawn_process(
                        *cmd,
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                        cwd=cwd,
                        env=subprocess_env,
                    )
                    wa_ctx = build_whatsapp_project_context(project)
                    focus_ctx = build_focus_snapshot()
                    item_ctx = build_focus_item_context(conv_id)
                    quick_ctx = build_focus_quick_add_context(conv_id)
                    session_ctx = build_session_context(conv_id)
                    person_ctx = build_person_context(message, conv_id)
                    router_ctx = build_context_router_context(message, conv_id)
                    broker_ctx = broker_tool_context(conv_id, project)
                    stdin_text = identity_ctx + time_ctx + session_ctx + (recent_context if recent_context else "") + focus_ctx + router_ctx + broker_ctx + item_ctx + quick_ctx + wa_ctx + person_ctx + message
                    proc.stdin.write(stdin_text.encode())
                    proc.stdin.close()
                    await _safe_send({
                        "type": "system",
                        "text": "Session wiederhergestellt — Kontext aus den letzten Nachrichten geladen.",
                    })
                    first_chunk = None  # reset — let normal loop handle it
                else:
                    # Resume worked — put first chunk back into buffer
                    pass  # first_chunk will be prepended below
            else:
                first_chunk = None

            current_tool_id = None  # tracks which tool block is currently streaming
            buf = first_chunk if first_chunk else b""
            # Resume: bestehende Bubble wiederverwenden. Neue Läufe bekommen
            # sofort eine DB-Zeile, damit Reload vor dem ersten Text andocken kann.
            _partial_row_id = resume_row_id
            if not _partial_row_id and conv_id:
                _partial_row_id = insert_partial(agent_id, project, agent_display, "", conv_id)

            _CLAUDE_READ_TIMEOUT = 1800  # 30 min without output → kill
            _wall_start = _time.time()

            while True:
                _remaining = _MAX_WALL_SECONDS - (_time.time() - _wall_start)
                if _remaining <= 0:
                    await _terminate_process(proc)
                    _msg = "Engine-Lauf nach Zeitlimit abgebrochen (Wall-Clock)."
                    full_text = (full_text + "\n\n" + _msg) if full_text else _msg
                    break
                try:
                    chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=min(_CLAUDE_READ_TIMEOUT, _remaining))
                except asyncio.TimeoutError:
                    await _terminate_process(proc)
                    _idle = (_time.time() - _wall_start) < _MAX_WALL_SECONDS
                    _msg = "Engine-Prozess nach 30 Min Inaktivität abgebrochen." if _idle else "Engine-Lauf nach Zeitlimit abgebrochen (Wall-Clock)."
                    full_text = (full_text + "\n\n" + _msg) if full_text else _msg
                    break
                if not chunk:
                    break
                buf += chunk
                # Process complete lines
                while b"\n" in buf:
                    line_bytes, buf = buf.split(b"\n", 1)
                    line = line_bytes.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    evt_type = evt.get("type", "")

                    # --- stream_event: granular content deltas ---
                    if evt_type == "stream_event":
                        inner = evt.get("event", {})
                        inner_type = inner.get("type", "")

                        if inner_type == "content_block_start":
                            cb = inner.get("content_block", {})
                            if cb.get("type") == "tool_use":
                                tool_id = cb.get("id", "")
                                tool_name = cb.get("name", "")
                                current_tool_id = tool_id
                                tool_calls[tool_id] = {"name": tool_name, "input_json": "", "status": "running"}
                                await _safe_send({
                                    "type": "agent.tool",
                                    "agent": agent_display,
                                    "tool": tool_name,
                                    "input": {},
                                    "result": "",
                                    "status": "running",
                                    "toolId": tool_id,
                                })
                            else:
                                current_tool_id = None

                        elif inner_type == "content_block_delta":
                            delta = inner.get("delta", {})
                            delta_type = delta.get("type", "")
                            if delta_type == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    full_text += text
                                    if not two_pass_active:
                                        await _safe_send({
                                            "type": "agent.text",
                                            "agent": agent_display,
                                            "delta": text,
                                            "full": full_text,
                                        })
                                        # Partial save on every delta so disconnects do not truncate
                                        if not _partial_row_id:
                                            _partial_row_id = insert_partial(agent_id, project, agent_display, full_text, conv_id)
                                        else:
                                            update_partial(_partial_row_id, full_text)
                            elif delta_type == "input_json_delta":
                                partial = delta.get("partial_json", "")
                                if current_tool_id and current_tool_id in tool_calls:
                                    tool_calls[current_tool_id]["input_json"] += partial

                        elif inner_type == "content_block_stop":
                            if current_tool_id and current_tool_id in tool_calls:
                                tc = tool_calls[current_tool_id]
                                if tc.get("input_json") and not tc.get("input_sent"):
                                    tc["input_sent"] = True
                                    try:
                                        parsed_input = json.loads(tc["input_json"])
                                    except json.JSONDecodeError:
                                        parsed_input = {}
                                    tc["parsed_input"] = parsed_input
                                    desc = ""
                                    if parsed_input.get("command"):
                                        desc = str(parsed_input["command"])[:200]
                                    elif parsed_input.get("file_path"):
                                        desc = str(parsed_input["file_path"])
                                    elif parsed_input.get("pattern"):
                                        desc = str(parsed_input["pattern"])
                                    await _safe_send({
                                        "type": "agent.tool",
                                        "agent": agent_display,
                                        "tool": tc["name"],
                                        "input": parsed_input,
                                        "result": desc,
                                        "status": "running",
                                        "toolId": current_tool_id,
                                    })
                                current_tool_id = None

                        elif inner_type == "message_delta":
                            # Extract usage stats
                            usage = inner.get("usage", {})
                            if usage:
                                # Use latest input_tokens (reflects current context size), don't accumulate
                                raw_in = int(usage.get("input_tokens", 0) or 0)
                                raw_cr = int(usage.get("cache_read_input_tokens", 0) or 0)
                                raw_cc = int(usage.get("cache_creation_input_tokens", 0) or 0)
                                # Sichtbare Chat-Tokens: uncached input + output.
                                # Cache-Read/Creation bleibt unten aus dem Tacho raus,
                                # sonst zeigen lange Tool-Loops Millionenwerte.
                                inp = raw_in
                                if inp > 0:
                                    total_input_tokens = inp
                                    last_usage_raw["input_tokens"] = raw_in
                                    last_usage_raw["cache_read"] = raw_cr
                                    last_usage_raw["cache_creation"] = raw_cc
                                out = int(usage.get("output_tokens", 0) or 0)
                                if out > 0:
                                    if out >= last_output_usage_seen:
                                        total_output_tokens += out - last_output_usage_seen
                                    else:
                                        # Neues internes Assistant-Event: Anthropic zaehlt
                                        # wieder ab 0, also den frischen Wert addieren.
                                        total_output_tokens += out
                                    last_output_usage_seen = out
                                last_usage_raw["output_tokens"] = total_output_tokens
                                # Live-Update: echte Tokens während Stream/Tool-Use rauspushen
                                await _safe_send({
                                    "type": "agent.usage",
                                    "contextTokens": total_input_tokens + total_output_tokens,
                                    "contextWindow": 1_000_000,
                                    "inputTokens": total_input_tokens,
                                    "outputTokens": total_output_tokens,
                                })

                    # --- assistant: complete turn with tool_use or text ---
                    elif evt_type == "assistant":
                        msg_data = evt.get("message", {})
                        assistant_text = ""
                        for content in msg_data.get("content", []):
                            if content.get("type") == "text":
                                assistant_text += content.get("text", "")
                            if content.get("type") == "tool_use":
                                tool_id = content.get("id", "")
                                tool_input = content.get("input", {})
                                if tool_id in tool_calls:
                                    # Update with full parsed input from assistant event
                                    tool_calls[tool_id]["parsed_input"] = tool_input
                                else:
                                    tool_calls[tool_id] = {"name": content.get("name", ""), "input_json": "", "parsed_input": tool_input, "status": "running"}
                                    await _safe_send({
                                        "type": "agent.tool",
                                        "agent": agent_display,
                                        "tool": content.get("name", ""),
                                        "input": tool_input,
                                        "result": "",
                                        "status": "running",
                                        "toolId": tool_id,
                                    })
                        # Newer/synthetic Claude CLI responses (notably rate-limit
                        # messages) can arrive only on the assistant event, without
                        # stream_event text_delta. Preserve them instead of finishing
                        # as an empty successful turn.
                        if assistant_text and not full_text.strip():
                            full_text = assistant_text
                            if not two_pass_active:
                                await _safe_send({
                                    "type": "agent.text",
                                    "agent": agent_display,
                                    "delta": assistant_text,
                                    "full": full_text,
                                })

                    # --- user: tool results coming back ---
                    elif evt_type == "user":
                        # Extract tool results from user message content
                        tool_results = {}
                        for content in evt.get("message", {}).get("content", []):
                            if content.get("type") == "tool_result":
                                tr_id = content.get("tool_use_id", "")
                                tr_content = content.get("content", "")
                                if isinstance(tr_content, list):
                                    tr_content = "\n".join(
                                        c.get("text", "") for c in tr_content if isinstance(c, dict) and c.get("type") == "text"
                                    )
                                if tr_id:
                                    tool_results[tr_id] = str(tr_content)[:2000]
                        # Mark all pending tools as done, include output
                        for tid in list(tool_calls.keys()):
                            tc = tool_calls[tid]
                            if not tc.get("done"):
                                tc["done"] = True
                                tc["status"] = "completed"
                                # Compute diff stats for Edit tools
                                diff_stats = None
                                tc_input = tc.get("parsed_input", {})
                                if tc.get("name") in ("Edit", "edit") and tc_input:
                                    old = str(tc_input.get("old_string", ""))
                                    new = str(tc_input.get("new_string", ""))
                                    old_lines = old.count("\n") + (1 if old.strip() else 0)
                                    new_lines = new.count("\n") + (1 if new.strip() else 0)
                                    diff_stats = {"added": new_lines, "removed": old_lines}
                                elif tc.get("name") in ("Write", "write") and tc_input:
                                    content_str = str(tc_input.get("content", ""))
                                    diff_stats = {"added": content_str.count("\n") + 1, "removed": 0}
                                tc["diff_stats"] = diff_stats
                                tc["result"] = tool_results.get(tid, "")
                                await _safe_send({
                                    "type": "agent.toolDone",
                                    "toolId": tid,
                                    "status": "completed",
                                    "output": tool_results.get(tid, ""),
                                    "diffStats": diff_stats,
                                })

                    # --- result: final event ---
                    elif evt_type == "result":
                        result_data = evt.get("result", {})
                        if evt.get("is_error"):
                            engine_error = str(result_data or evt.get("error") or "Claude-Lauf fehlgeschlagen.").strip()
                            if engine_error and not full_text.strip():
                                full_text = engine_error
                                if not two_pass_active:
                                    await _safe_send({
                                        "type": "agent.text",
                                        "agent": agent_display,
                                        "delta": full_text,
                                        "full": full_text,
                                    })
                        # Extract session_id for persistence
                        session_id = evt.get("session_id", "")
                        if session_id and conv_id:
                            set_claude_session_id(conv_id, session_id)
                        # Get final text from result if we missed it
                        if not full_text and isinstance(result_data, dict):
                            for c in result_data.get("content", []):
                                if isinstance(c, dict) and c.get("type") == "text":
                                    full_text += c.get("text", "")

            await proc.wait()
            if proc.returncode not in (0, None) and not engine_error:
                try:
                    stderr_tail = (await proc.stderr.read()).decode(errors="replace").strip()
                except Exception:
                    stderr_tail = ""
                engine_error = stderr_tail or f"Claude-Prozess beendet mit Code {proc.returncode}."
            full_text = linkify_file_paths(full_text)

            # Two-Pass: Draft des ersten Claude-Passes ist fertig. Sidecar holen,
            # dann Final-Synthese, dann erst die Antwort an der Nutzer streamen.
            if two_pass_active and full_text.strip() and conv_id not in _stop_requests:
                draft_text = full_text
                await _safe_send({
                    "type": "agent.phase",
                    "phase": "review",
                    "label": "Zweitblick einholen",
                })
                review_text, target_label = await _run_dual_sidecar(
                    current_engine="claude",
                    conv_id=conv_id,
                    prompt=message,
                    cwd=cwd,
                    time_ctx=time_ctx,
                    draft_answer=draft_text,
                    tool_calls=dict(tool_calls),
                )
                final_text = ""
                if review_text.strip():
                    await _safe_send({
                        "type": "agent.phase",
                        "phase": "finalize",
                        "label": "Antwort finalisieren",
                    })
                    final_prompt = (
                        f"Du hast intern bereits einen Antwort-Draft formuliert. {_of_stream()} hat ihn "
                        "NICHT gesehen — er liest erst diese finale Version. Eben kam noch ein "
                        "knapper Reality-Check von " + target_label + " dazu, den du nüchtern prüfst.\n\n"
                        "Dein interner Draft:\n" + draft_text.strip() + "\n\n"
                        + target_label + "s Reality-Check:\n" + review_text.strip() + "\n\n"
                        f"Schreib jetzt die finale Antwort an {_of_stream()}. Übernimm aus dem "
                        "Reality-Check NUR, was die Antwort klarer, robuster oder einfacher macht — "
                        "wenn ein Punkt nicht passt, ignorier ihn. EINE integrierte Antwort: kein "
                        "Review-Block, kein Block-Header, kein Hinweis dass es einen Zweitblick gab. "
                        "Wenn der Draft im Wesentlichen passt, übernimm ihn fast wörtlich. Antworte "
                        f"direkt — {_of_stream()} liest nur das hier.\n"
                    )
                    final_consult = (
                        _build_consult_identity_context(conv_id, time_ctx)
                        + _build_recent_chat_context(conv_id)
                    )
                    try:
                        final_text = (await _run_agent_check("claude", final_prompt, cwd, final_consult)).strip()
                    except Exception:
                        final_text = ""
                if not final_text:
                    final_text = draft_text
                full_text = linkify_file_paths(final_text)
                await _safe_send({
                    "type": "agent.text",
                    "agent": agent_display,
                    "delta": full_text,
                    "full": full_text,
                })

            def _slim_input(tc: dict) -> dict:
                """Keep only display-relevant fields from tool input (no huge strings)."""
                pi = tc.get("parsed_input", {})
                slim = {}
                for k in ("file_path", "path", "command", "pattern", "query", "description", "glob"):
                    if k in pi:
                        slim[k] = str(pi[k])[:500]
                return slim

            tools_json = json.dumps([{
                "name": tc.get("name", ""),
                "result": tc.get("result", "")[:500] if tc.get("result") else "",
                "input": _slim_input(tc),
                "diffStats": tc.get("diff_stats"),
            } for tc in tool_calls.values()])
            _sess = _stream_sessions.get(conv_id) if conv_id else None
            elapsed_ms = int((_time.time() - _sess["started_at"]) * 1000) if _sess else None
            if _partial_row_id:
                if full_text.strip():
                    update_partial(_partial_row_id, full_text, tools=tools_json, elapsed_ms=elapsed_ms, complete=True, input_tokens=total_input_tokens, output_tokens=total_output_tokens)
                else:
                    # Empty response — delete the partial row instead of leaving a ghost message
                    from db import delete_msg
                    delete_msg(_partial_row_id)
            elif full_text.strip():
                save_msg(agent_id, project, agent_display, full_text, conv_id, tools=tools_json, elapsed_ms=elapsed_ms, input_tokens=total_input_tokens, output_tokens=total_output_tokens)
            await broadcast_sync(agent_id, conv_id, source=client_kind)
            update_letzter_stand(project, agent_display, full_text, projects_roots)

            final_tokens = total_input_tokens + total_output_tokens or (context_tokens + len(full_text) // 4)
            did_work = _did_substantial_work(tool_calls)
            final_status = "stopped" if conv_id in _stop_requests else ("error" if engine_error else "ok")
            _finish_learning_run(
                learning_run_id,
                status=final_status,
                final_text=full_text,
                error=engine_error,
                elapsed_ms=elapsed_ms,
                tool_calls=tool_calls,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
            )
            werkbank_report_parent = await asyncio.to_thread(
                _finish_werkbank_chat_handoff,
                werkbank_task_id,
                status=final_status,
                final_text=full_text,
                tool_calls=tool_calls,
                elapsed_ms=elapsed_ms,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                changed_lines=_diff_totals_with_git(tool_calls, _sess, cwd),
            )
            if werkbank_report_parent and werkbank_report_parent != conv_id:
                await broadcast_sync(agent_id, werkbank_report_parent, source="werkbank")
            try:
                _log_call(
                    feature="chat_claude",
                    provider="anthropic",
                    model=claude_model,
                    latency_ms=elapsed_ms or 0,
                    ok=not bool(engine_error),
                    input_tokens=last_usage_raw["input_tokens"],
                    output_tokens=last_usage_raw["output_tokens"],
                    cache_read_tokens=last_usage_raw["cache_read"],
                    cache_creation_tokens=last_usage_raw["cache_creation"],
                    conversation_id=conv_id or "",
                )
                _logged = True
            except Exception:
                pass
            if conv_id in _stop_requests:
                await _safe_send({
                    "type": "agent.done",
                    "agent": agent_display,
                    "status": "stopped",
                    "model": _claude_model_label(claude_model),
                    "contextTokens": final_tokens,
                    "contextWindow": 1_000_000,
                    "inputTokens": total_input_tokens,
                    "outputTokens": total_output_tokens,
                    "didWork": did_work,
                    "elapsedMs": elapsed_ms,
                })
                done_sent = True
            else:
                await _safe_send({
                    "type": "agent.done",
                    "agent": agent_display,
                    "status": final_status,
                    "error": engine_error,
                    "model": _claude_model_label(claude_model),
                    "contextTokens": final_tokens,
                    "contextWindow": 1_000_000,
                    "inputTokens": total_input_tokens,
                    "outputTokens": total_output_tokens,
                    "didWork": did_work,
                    "elapsedMs": elapsed_ms,
                })
                done_sent = True

        except asyncio.CancelledError:
            raise
        except Exception as e:
            _sess = _stream_sessions.get(conv_id) if conv_id else None
            elapsed_ms = int((_time.time() - _sess["started_at"]) * 1000) if _sess else None
            _finish_learning_run(
                learning_run_id if 'learning_run_id' in locals() else None,
                status="error",
                final_text=full_text if 'full_text' in locals() else "",
                error=str(e),
                elapsed_ms=elapsed_ms,
                tool_calls=tool_calls if 'tool_calls' in locals() else {},
                input_tokens=total_input_tokens if 'total_input_tokens' in locals() else 0,
                output_tokens=total_output_tokens if 'total_output_tokens' in locals() else 0,
            )
            await _safe_send({
                "type": "agent.done",
                "agent": agent_display,
                "status": "error",
                "error": str(e),
            })
            done_sent = True
        finally:
            # Abgebrochene/fehlgeschlagene Streams erreichen den finalen
            # complete-Call nicht; ihre Row bleibt incomplete und steht nicht im
            # FTS-Index. Einmal nachziehen, sonst sind Teilantworten nicht
            # durchsuchbar. Idempotent, no-op wenn schon final indiziert.
            _prid = locals().get("_partial_row_id")
            if _prid:
                try:
                    from db import reindex_chat_msg_if_incomplete
                    reindex_chat_msg_if_incomplete(_prid)
                except Exception:
                    pass
                # Flacker-Schutz: Reisst die Client-Verbindung nach dem letzten
                # Delta, aber vor dem finalen complete-Update ab, bliebe die
                # fertig gestreamte Antwort incomplete und das Frontend würde sie
                # automatisch fortsetzen. Wenn substanzieller Text da ist, gilt
                # sie als fertig — kein falscher Auto-Resume mehr.
                _ft = locals().get("full_text") or ""
                if _ft.strip():
                    try:
                        from db import mark_msg_complete
                        mark_msg_complete(_prid)
                    except Exception:
                        pass
            if conv_id and conv_id in _stop_requests and not done_sent:
                _sess = _stream_sessions.get(conv_id)
                elapsed_ms = int((_time.time() - _sess["started_at"]) * 1000) if _sess else None
                try:
                    await _safe_send({
                        "type": "agent.done",
                        "agent": agent_display,
                        "status": "stopped",
                        "model": _claude_model_label(claude_model),
                        "contextTokens": total_input_tokens + total_output_tokens or (context_tokens + len(full_text) // 4),
                        "contextWindow": 1_000_000,
                        "inputTokens": total_input_tokens,
                        "outputTokens": total_output_tokens,
                        "elapsedMs": elapsed_ms,
                    })
                except Exception:
                    pass
            if conv_id:
                _active_procs.pop(conv_id, None)
                _active_tasks.pop(conv_id, None)
                _active_started_at.pop(conv_id, None)
                _end_stream_session(conv_id)
                _stop_requests.discard(conv_id)
            # Always kill the subprocess to prevent zombies
            if proc and proc.returncode is None:
                try:
                    await _terminate_process(proc)
                except Exception:
                    pass

    async def _handle_command(client: WebSocket, msg: dict):
        """Handle slash commands from frontend."""
        command = msg.get("command", "")
        agent_id = msg.get("agentId", "main")
        args = msg.get("args", "")

        async def _send_cmd_event(event: dict):
            conv_id_evt = msg.get("conversationId", "")
            event["conversationId"] = conv_id_evt
            try:
                await client.send_json(event)
            except Exception:
                pass

        async def _handle_consult():
            conv_id = msg.get("conversationId", "")
            project = msg.get("project", "")
            current_engine = str(msg.get("engine") or get_conversation_engine(conv_id) or "codex").strip().lower()
            raw = str(args or "").strip()
            if not conv_id:
                await client.send_json({"type": "system", "content": "Kein aktiver Chat für Agent-Check."})
                return
            if not raw:
                await client.send_json({"type": "system", "content": "Verwendung: /consult [claude|codex] <frage>"})
                return

            first, rest = (raw.split(None, 1) + [""])[:2]
            explicit = first.lower() if first.lower() in ("claude", "codex") else ""
            target_engine = explicit or ("claude" if current_engine == "codex" else "codex")
            prompt = rest.strip() if explicit else raw
            if not prompt:
                await client.send_json({"type": "system", "content": "Verwendung: /consult [claude|codex] <frage>"})
                return

            tool_id = f"agent-check-{_uuid.uuid4().hex[:12]}"
            target_label = _engine_label(target_engine)
            query = _short_query(prompt)
            cwd = str(Path(project)) if project and Path(project).is_dir() else str(Path(__file__).parent.parent)
            agent_display = get_agent_display(agent_id)
            prev_user_ts = None
            try:
                with get_db() as db:
                    row = db.execute(
                        "SELECT ts FROM messages WHERE conversation_id = ? AND author = 'Du' ORDER BY id DESC LIMIT 1",
                        (conv_id,),
                    ).fetchone()
                if row:
                    prev_user_ts = row[0]
            except Exception:
                pass
            time_ctx = build_time_context(prev_user_ts)
            consult_prompt = _build_consult_identity_context(conv_id, time_ctx) + _build_recent_chat_context(conv_id)
            tool_input = {
                "description": f"{target_label} Check",
                "query": query,
                "engine": target_label,
            }

            row_id = insert_partial(agent_id, project, agent_display, "<!-- agent-check -->", conv_id)
            await _send_cmd_event({
                "type": "agent.tool",
                "agent": agent_display,
                "tool": "Agent",
                "input": tool_input,
                "result": "",
                "status": "running",
                "toolId": tool_id,
            })

            try:
                answer = (await _run_agent_check(target_engine, prompt, cwd, consult_prompt)).strip()
                if not answer:
                    answer = "Keine Antwort."
                output = f"Prompt:\n{prompt}\n\nAntwort von {target_label}:\n{answer}"
            except Exception as e:
                output = f"Prompt:\n{prompt}\n\nFehler bei {target_label}:\n{str(e).strip() or 'Unbekannter Fehler'}"

            tools_json = json.dumps([{
                "id": tool_id,
                "name": "Agent",
                "input": tool_input,
                "output": output[:4000],
                "status": "completed",
            }])
            update_partial(row_id, "<!-- agent-check -->", tools=tools_json, complete=True)
            await broadcast_sync(agent_id, conv_id, source=msg.get("clientKind"))
            await _send_cmd_event({
                "type": "agent.toolDone",
                "toolId": tool_id,
                "status": "completed",
                "output": output[:4000],
            })

        try:
            if command == "new":
                conv_id = msg.get("conversationId", "")
                if conv_id:
                    if agent_id == "claude" or agent_id.startswith("claude-"):
                        set_claude_session_id(conv_id, "")
                    else:
                        set_codex_session_id(conv_id, "")
                await client.send_json({"type": "system", "content": "Neue Session gestartet.", "conversationId": conv_id})

            elif command == "stop":
                conv_id = msg.get("conversationId", "")
                stopped = await request_stop(conv_id) if conv_id else False
                if stopped:
                    await client.send_json({"type": "system", "content": "Agent gestoppt.", "conversationId": conv_id})
                else:
                    await client.send_json({"type": "system", "content": "Kein aktiver Prozess.", "conversationId": conv_id})

            elif command == "consult":
                await _handle_consult()

        except Exception as e:
            await client.send_json({"type": "system", "content": f"Fehler: {e}"})

    class _NullClient:
        """Dummy-WebSocket für Background-Queue-Processing ohne aktiven Client."""
        class _Addr:
            host = "127.0.0.1"
        client = _Addr()

        async def send_json(self, data):
            pass

    async def _queue_worker():
        """Verarbeitet pending message_queue Items wenn die Conversation idle ist."""
        while True:
            await asyncio.sleep(8)
            try:
                with get_db() as db:
                    rows = db.execute(
                        "SELECT id, conv_id, text, attachments_json, agent_id FROM message_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5"
                    ).fetchall()
                for row in rows:
                    item_id, conv_id, text, attachments_json, agent_id = row
                    sess = _stream_sessions.get(conv_id)
                    if sess and not sess.get("done"):
                        continue
                    with get_db() as db:
                        cur = db.execute("UPDATE message_queue SET status = 'processing' WHERE id = ? AND status = 'pending'", (item_id,))
                        claimed = cur.rowcount
                    # Doppel-Dispatch-Schutz: hat der Client (oder ein anderer
                    # Worker-Durchlauf) das Item schon weggenommen, claimt diese
                    # UPDATE 0 Zeilen und wir ueberspringen es.
                    if not claimed:
                        continue
                    try:
                        engine = get_conversation_engine(conv_id) if conv_id else "claude"
                        attachments = json.loads(attachments_json or "[]")
                        msg = {
                            "action": "send",
                            "agentId": agent_id or "main",
                            "message": text,
                            "conversationId": conv_id,
                            "attachments": attachments,
                            "clientKind": "background",
                            "clientMessageId": item_id,
                        }
                        null_client = _NullClient()
                        if engine == "claude":
                            await _handle_claude(null_client, msg)
                        else:
                            await _handle_codex(null_client, msg)
                        with get_db() as db:
                            db.execute("DELETE FROM message_queue WHERE id = ?", (item_id,))
                    except Exception:
                        with get_db() as db:
                            db.execute("UPDATE message_queue SET status = 'pending' WHERE id = ?", (item_id,))
            except Exception:
                pass

    global _registered_queue_worker
    _registered_queue_worker = _queue_worker

    return router
