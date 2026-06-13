"""Heartbeat-Pulses — zentrale Wächter-Registry.

Ein Pulse ist ein kleiner Check, der regelmäßig läuft. Der Heartbeat-Runner
ruft `run_due()` alle 60s auf und führt alle fälligen Pulses aus. Jeder Pulse
schreibt seinen Status (ok/found/error/timeout) in die pulses-Tabelle, damit
das Frontend eine Statusleiste rendern kann.

Status-Konvention:
  - ok:      Pulse lief sauber, nichts Neues
  - found:   Pulse lief sauber und hat was gefunden (orange im UI)
  - error:   Pulse hat eine Exception geworfen (rot)
  - timeout: Pulse hat das Zeitlimit überschritten (rot)
"""
from __future__ import annotations

import json
import hashlib
import multiprocessing
import re
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Any

# Pulses laufen teils in einem Scheduler-Prozess, der server.py (und dessen
# sys.path-Setup) nicht importiert. Damit lazy `from modules.* import ...` in
# einem Pulse nicht an ModuleNotFoundError('modules') scheitert, sichern wir
# Projekt- und Backend-Root hier selbst im Pfad — identisch zu server.py.
_BACKEND_ROOT = Path(__file__).resolve().parent
_PROJECT_ROOT = _BACKEND_ROOT.parent
for _path in (str(_PROJECT_ROOT), str(_BACKEND_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from db import get_db

# Hartes Timeout pro Pulse (Sekunden). Ein hängender Wächter darf den
# Runner nicht blockieren.
PULSE_TIMEOUT = 10.0


@dataclass
class Pulse:
    name: str
    interval_sec: int
    fn: Callable[[], dict]
    timeout_sec: float = PULSE_TIMEOUT
    engine: str | None = None  # 'claude' | 'codex' | 'qwen' | None (kein LLM)


_REGISTRY: dict[str, Pulse] = {}

_PULSE_META: dict[str, dict[str, str]] = {
    "mail-scanner": {
        "label": "Neue Mails",
        "what": "Schaut nach neuen wichtigen Mails und erkennt vor allem Workshop-Antworten oder Absagen.",
        "how": "Liest die letzten Mails per IMAP und prüft sie mit festen Regeln, ganz ohne Modell.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "health-sleep-watcher": {
        "label": "Schlaf-Wächter",
        "what": "Wartet zwischen 06:00 und 12:00 auf vollständige Schlafdaten und triggert dann den Health-Job.",
        "how": "Prüft die neuesten AutoExport-Dateien auf sleep_analysis mit sleepEnd von heute. Sobald komplett, startet er den Health-Job genau einmal pro Tag.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "youtube-digest": {
        "label": "YouTube-Digest",
        "what": "Verdichtet angesehene und ausgewertete YouTube-Dossiers zu umsetzbaren YT-Codes für Morgenbriefing und Radar.",
        "how": "Läuft morgens einmal lokal über scripts/youtube-digest.py und liest activity.jsonl plus Dossier-Dateien.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "lead-reconciler": {
        "label": "Website-Anfragen",
        "what": "Macht frisch geholte Website-Leads im Eingangssystem sichtbar.",
        "how": "Vergleicht lokale Lead-Daten mit den gespeicherten Events und legt nur fehlende Einträge an.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "lead-digest": {
        "label": "Lead-Digest",
        "what": "Postet 2x am Tag (09:00 + 16:30) eine Sammelkarte mit neuen Anmeldungen und Absagen.",
        "how": "Liest denzer_leads + cancellation_events seit dem letzten Lauf, postet im Klaus-Channel wenn was zu posten ist.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "denzer-leads-pull": {
        "label": "Lead-Import",
        "what": "Holt neue Anmeldungen von der example.com-Seite in die lokale Datenbank.",
        "how": "Startet das Skript `scripts/sync-denzer-leads.py` und zieht neue Einträge aus Cloudflare KV.",
        "who": "Python-Skript `scripts/sync-denzer-leads.py`",
        "llm": "Nein",
    },
    "server-ping": {
        "label": "Server erreichbar",
        "what": "Prüft nur, ob der Server grundsätzlich noch ansprechbar ist.",
        "how": "Macht einen schnellen HTTP-Check auf `/api/system-status`.",
        "who": "Einfacher HTTP-Check in Python",
        "llm": "Nein",
    },
    "health-watchdog": {
        "label": "Server-Selbstheilung",
        "what": "Merkt, wenn der Server wirklich hängt, und stößt dann einen Neustart an.",
        "how": "Prüft `/api/conversations` und ruft nach drei Fehlschlägen `launchctl kickstart` auf.",
        "who": "Python plus launchd",
        "llm": "Nein",
    },
    "backup-freshness": {
        "label": "Backup-Stand",
        "what": "Prüft, ob das letzte Backup noch frisch genug ist.",
        "how": "Schaut auf Datum und Uhrzeit der jüngsten Backup-Datei unter `~/Backups/agent/`.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "crm-reindexer": {
        "label": "Kontakte verknüpfen",
        "what": "Aktualisiert, welche Menschen in FOCUS und Kalender gemeint sind.",
        "how": "Startet `scripts/reindex-crm-mentions.py` und schreibt die Treffer neu in die DB.",
        "who": "Python-Skript `scripts/reindex-crm-mentions.py`",
        "llm": "Nein",
    },
    "whatsapp-people-sync": {
        "label": "WhatsApp-Kontakte importieren",
        "what": "Übernimmt aktive WhatsApp-Chats in die Personen-Datenbank.",
        "how": "Startet `scripts/people-import-whatsapp.py` und gleicht per Chat-ID ab.",
        "who": "Python-Skript `scripts/people-import-whatsapp.py`",
        "llm": "Nein",
    },
    "people-enrich": {
        "label": "Kontaktdaten ergänzen",
        "what": "Füllt fehlende Mailadressen oder Telefonnummern bei Personen nach.",
        "how": "Startet `scripts/people-enrich.py` und sucht per Regex in Chats und WhatsApp-Nachrichten.",
        "who": "Python-Skript `scripts/people-enrich.py`",
        "llm": "Nein",
    },
    "radar-intraday": {
        "label": "Radar-Nachbauchance",
        "what": "Meldet nach dem Morgenradar einmal täglich, wenn OpenClaw, Hermes oder ein anderes Agenten-Signal echten Nachbau-Wert für Klaus hat.",
        "how": "Liest das konsolidierte Morgenradar, sucht nach Agent-Control-Relevanz und postet nur bei substanziellem Treffer in den Klaus-Channel.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "app-perf-check": {
        "label": "App-Stabilität",
        "what": "Vergleicht Desktop-, Mobile- und Remote-Messwerte für Ladehänger, langsame API-Routen und Fehler.",
        "how": "Liest `data/mobile-perf.jsonl`, bewertet die letzten Minuten und postet nur bei klarer Auffälligkeit in den Klaus-Channel.",
        "who": "Python direkt im Server",
        "llm": "Nein",
    },
    "local-llm": {
        "label": "Lokales Modell",
        "what": "Prüft, ob LM Studio erreichbar ist, und zeigt, wie oft das lokale Modell heute genutzt wurde.",
        "how": "Pingt den lokalen LM-Studio-Server und liest den Tageszähler aus der Datei `data/local_llm_counter.json`.",
        "who": "LM Studio Check in Python",
        "llm": "Nein, nur Verfügbarkeit. Beobachtet Qwen `qwen/qwen3-vl-30b`.",
    },
}


def register(name: str, interval_sec: int, fn: Callable[[], dict], timeout_sec: float | None = None,
             engine: str | None = None) -> None:
    """Registriert einen Pulse. fn() muss ein Dict zurückgeben mit Keys:
      status: 'ok' | 'found'
      message: kurzer Text
      payload: optional dict
    Exceptions werden vom Runner gefangen und als 'error' gewertet.
    timeout_sec überschreibt das Default-Timeout für lange Pulses (Netzwerk).
    """
    _REGISTRY[name] = Pulse(
        name=name,
        interval_sec=interval_sec,
        fn=fn,
        timeout_sec=timeout_sec if timeout_sec is not None else PULSE_TIMEOUT,
        engine=engine,
    )


def list_registered() -> list[Pulse]:
    return list(_REGISTRY.values())


def _ensure_row(db, pulse: Pulse) -> None:
    db.execute(
        """INSERT INTO pulses (name, interval_sec, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET interval_sec = excluded.interval_sec""",
        (pulse.name, pulse.interval_sec, time.time()),
    )


def _is_due(row: dict, interval_sec: int, now: float) -> bool:
    if not row.get("enabled", 1):
        return False
    last = row.get("last_run") or 0.0
    return (now - last) >= interval_sec


def _run_one_in_subprocess(fn: Callable, q: multiprocessing.Queue) -> None:
    try:
        result = fn() or {}
        q.put({"ok": True, "result": result})
    except Exception as e:
        q.put({"ok": False, "error": f"{type(e).__name__}: {e}", "tb": traceback.format_exc()})


def _execute(pulse: Pulse) -> dict:
    """Führt einen Pulse mit Timeout aus. Gibt ein Status-Dict zurück."""
    ctx = multiprocessing.get_context("fork")
    q: multiprocessing.Queue = ctx.Queue()
    proc = ctx.Process(target=_run_one_in_subprocess, args=(pulse.fn, q))
    proc.start()
    proc.join(pulse.timeout_sec)
    if proc.is_alive():
        proc.terminate()
        proc.join(1)
        return {"status": "timeout", "message": f"Pulse > {pulse.timeout_sec}s, abgebrochen", "payload": {}}
    if q.empty():
        return {"status": "error", "message": "kein Ergebnis vom Subprozess", "payload": {}}
    out = q.get()
    if not out.get("ok"):
        return {"status": "error", "message": out.get("error", "unknown"), "payload": {"tb": out.get("tb", "")}}
    res = out.get("result") or {}
    status = res.get("status") or "ok"
    if status not in ("ok", "found"):
        status = "ok"
    return {
        "status": status,
        "message": str(res.get("message", "") or "")[:500],
        "payload": res.get("payload") or {},
    }


def _record_pulse_learning_run(pulse: Pulse, res: dict, *, duration_ms: int) -> None:
    """Schreibt nur relevante Pulse-Läufe ins Learning Log."""
    try:
        import workflows
        meta = _PULSE_META.get(pulse.name, {})
        label = meta.get("label") or pulse.name
        status = res.get("status") or "ok"
        payload = res.get("payload") or {}
        important = bool(payload.get("learning_log") is True or payload.get("important") or payload.get("changed"))
        if status in ("ok", "found") and not important:
            return
        run_id = workflows.start_run(
            "pulse.run",
            f"Pulse: {label}",
            trigger="heartbeat",
            subject_type="pulse",
            subject_ref=pulse.name,
            input_data={
                "pulse": pulse.name,
                "label": label,
                "interval_sec": pulse.interval_sec,
                "engine": pulse.engine,
            },
        )
        workflows.add_step(run_id, "execute", "Pulse ausgeführt", status, res.get("message") or "", {"payload": payload})
        finished_status = "done" if status in ("ok", "found") else "error"
        workflows.finish_run(
            run_id,
            finished_status,
            result={
                "status": status,
                "message": res.get("message"),
                "duration_ms": duration_ms,
                "payload": payload,
            },
            error="" if finished_status == "done" else str(res.get("message") or "")[:1000],
        )
        workflows.review_background_run(run_id)
    except Exception as e:
        print(f"[pulse learning] {pulse.name}: {e}", flush=True)


def run_due() -> dict:
    """Iteriert alle registrierten Pulses, führt fällige aus. Returns:
      {ran: N, ok: N, found: N, errors: N, skipped: N}
    """
    now = time.time()
    out = {"ran": 0, "ok": 0, "found": 0, "errors": 0, "skipped": 0}

    with get_db() as db:
        db.row_factory = __import__("sqlite3").Row
        for pulse in list_registered():
            _ensure_row(db, pulse)

        rows = {r["name"]: dict(r) for r in db.execute("SELECT * FROM pulses").fetchall()}

    for pulse in list_registered():
        row = rows.get(pulse.name, {})
        if not _is_due(row, pulse.interval_sec, now):
            out["skipped"] += 1
            continue
        pulse_started = time.time()
        res = _execute(pulse)
        pulse_duration_ms = max(0, int((time.time() - pulse_started) * 1000))
        out["ran"] += 1
        if res["status"] == "found":
            out["found"] += 1
        elif res["status"] == "ok":
            out["ok"] += 1
        else:
            out["errors"] += 1

        prev_fail = int(row.get("fail_streak") or 0)
        is_err = res["status"] not in ("ok", "found")
        new_fail = prev_fail + 1 if is_err else 0
        last_ok = row.get("last_ok_at") if is_err else time.time()

        with get_db() as db:
            db.execute(
                """UPDATE pulses
                   SET last_run = ?, last_ok_at = ?, last_status = ?,
                       last_message = ?, last_payload = ?, fail_streak = ?, updated_at = ?
                   WHERE name = ?""",
                (
                    time.time(), last_ok, res["status"],
                    res["message"], json.dumps(res["payload"], ensure_ascii=False),
                    new_fail, time.time(),
                    pulse.name,
                ),
            )
        _record_pulse_learning_run(pulse, res, duration_ms=pulse_duration_ms)
    return out


def snapshot() -> list[dict]:
    """Liest den aktuellen Status aller Pulses für das Frontend.

    UI-Farbe:
      green:  Pulse lief sauber durch (ok ODER found — „found" ist nur Info, kein Alarm)
      red:    fail_streak >= 3 (drei Fehlläufe in Folge; ein einzelner Aussetzer bleibt grün)
      gray:   noch nie gelaufen
    """
    out = []
    now = time.time()
    registry = list_registered()
    engines = {p.name: p.engine for p in registry}
    order = {p.name: idx for idx, p in enumerate(registry)}
    with get_db() as db:
        db.row_factory = __import__("sqlite3").Row
        rows = {r["name"]: dict(r) for r in db.execute("SELECT * FROM pulses").fetchall()}
        for pulse in registry:
            d = dict(rows.get(pulse.name) or {})
            if not d:
                d = {
                    "name": pulse.name,
                    "interval_sec": pulse.interval_sec,
                    "last_run": None,
                    "last_ok_at": None,
                    "last_status": "unknown",
                    "last_message": "",
                    "last_payload": "{}",
                    "fail_streak": 0,
                    "enabled": 1,
                    "updated_at": 0,
                }
            last = d.get("last_run") or 0.0
            fail = int(d.get("fail_streak") or 0)
            status = d.get("last_status") or "unknown"
            if not last:
                color = "gray"
            elif fail >= 3:
                # Erst nach drei Fehlläufen in Folge Rot, ein einzelner transienter
                # Aussetzer (IMAP-/KV-Netzwackler) bleibt grün und heilt sich selbst.
                color = "red"
            else:
                color = "green"
            try:
                d["last_payload"] = json.loads(d.get("last_payload") or "{}")
            except Exception:
                d["last_payload"] = {}
            d["color"] = color
            d["age_sec"] = int(now - last) if last else None
            d["engine"] = engines.get(d.get("name"))
            meta = _PULSE_META.get(pulse.name, {})
            d["label"] = meta.get("label") or pulse.name
            d["what"] = meta.get("what") or "Noch nicht beschrieben."
            d["how"] = meta.get("how") or "Noch nicht beschrieben."
            d["who"] = meta.get("who") or "Unbekannt"
            d["llm"] = meta.get("llm") or "Unbekannt"
            d["internal_name"] = pulse.name
            d["sort_order"] = order.get(pulse.name, 9999)
            out.append(d)
    out.sort(key=lambda x: (int(x.get("sort_order") or 9999), str(x.get("label") or "")))
    return out


# ── Registrierungen ────────────────────────────────────────────────────
def _pulse_mail_scanner() -> dict:
    import eingang
    res = eingang.scan_mail(limit=20)
    err = res.get("error")
    if err:
        raise RuntimeError(err)
    found = int(res.get("recorded") or 0)
    absagen = int(res.get("absagen") or 0)
    # Echte Eingänge (keine reinen Absagen) → in den Klaus-Channel posten,
    # dedupe per Stunde damit Re-Scans nicht doppeln.
    real_new = found - absagen
    if real_new > 0:
        word = "neue Mail" if real_new == 1 else "neue Mails"
        verb = "ist" if real_new == 1 else "sind"
        variants = [
            f"{real_new} {word} im Posteingang, magst du draufschauen?",
            f"Im Eingang {verb} {real_new} {word} gelandet.",
            f"Schlage vor, kurz in die {real_new} {word} reinzulesen, bevor's mehr werden.",
        ]
        _post_to_klaus_channel(
            source="mail-scanner",
            variants=variants,
        )
    return {
        "status": "found" if found > 0 else "ok",
        "message": f"{res.get('scanned',0)} gescannt, {found} neu ({absagen} Absagen)",
        "payload": res,
    }


def _pulse_mail_triage() -> dict:
    """Bewertet neue Mails im Hintergrund (Klaus liest vor).

    Bekannte Kontakte/Bulk gehen ohne LLM durch, Graufaelle an Haiku (bis 12 pro
    Lauf, Rest beim naechsten Tick). Die Inbox liest nur die fertigen Urteile,
    bleibt also schnell. Postet nichts, ist reine Vorsortierung.
    """
    from modules.mail import triage
    res = triage.triage_pending(limit=150, max_llm=12)
    if res.get("error"):
        raise RuntimeError(res["error"])
    judged = int(res.get("judged") or 0)
    return {
        "status": "found" if judged else "ok",
        "message": f"{res.get('scanned', 0)} gescannt, {judged} bewertet, {res.get('relevant', 0)} relevant",
        "payload": res,
    }


def _pulse_lead_digest() -> dict:
    """Sammelt Lead-Bewegungen und postet 2x am Tag (09:00 + 16:30 lokal).

    State: last_morning (YYYY-MM-DD), last_afternoon (YYYY-MM-DD),
           last_cutoff (unix ts — alles danach gilt als "neu").
    Erster Lauf setzt last_cutoff auf jetzt, damit keine Backfill-Flut entsteht.
    """
    from datetime import datetime as _dt
    state = _get_pulse_state("lead-digest")
    now = time.time()
    last_cutoff = float(state.get("last_cutoff") or 0)
    if last_cutoff <= 0:
        state["last_cutoff"] = now
        return {"status": "ok", "message": "init", "payload": state}

    today_str = _dt.now().strftime("%Y-%m-%d")
    hour = _dt.now().hour
    minute = _dt.now().minute
    slot = None
    if hour == 9 and minute < 30 and state.get("last_morning") != today_str:
        slot = "morning"
    elif hour == 16 and minute >= 30 and state.get("last_afternoon") != today_str:
        slot = "afternoon"
    elif hour == 17 and minute < 30 and state.get("last_afternoon") != today_str:
        slot = "afternoon"

    if not slot:
        return {"status": "ok", "message": "kein Slot", "payload": state}

    new_leads: list[dict] = []
    cancellations: list[dict] = []
    try:
        with get_db() as db:
            db.row_factory = __import__("sqlite3").Row
            new_leads = [dict(r) for r in db.execute(
                "SELECT name, email, source, status, ts_kv FROM denzer_leads "
                "WHERE (ts_kv / 1000.0) > ? AND status = 'confirmed' "
                "ORDER BY ts_kv DESC LIMIT 30",
                (last_cutoff,),
            ).fetchall()]
            cancellations = [dict(r) for r in db.execute(
                "SELECT person_name, reason, source, detected_at "
                "FROM cancellation_events WHERE detected_at > ? "
                "ORDER BY detected_at DESC LIMIT 30",
                (last_cutoff,),
            ).fetchall()]
    except Exception as e:
        return {"status": "error", "message": f"db read: {e}"}

    real_new = [l for l in new_leads if not _looks_like_test_lead(l)]
    real_cancels = [c for c in cancellations if (c.get("person_name") or "").strip()]

    if not real_new and not real_cancels:
        state[f"last_{slot}"] = today_str
        state["last_cutoff"] = now
        return {"status": "ok", "message": f"{slot}: nichts", "payload": state}

    lines: list[str] = []
    when = "Morgen-Stand" if slot == "morning" else "Nachmittag-Stand"
    lines.append(f"**Lead-Digest, {when}.**")
    if real_new:
        lines.append("")
        lines.append(f"**Neu reingekommen ({len(real_new)}):**")
        for l in real_new[:10]:
            src = (l.get("source") or "").replace("ai-sprint-", "AI Sprint ")
            lines.append(f"- {l.get('name','?')} · {src} · {l.get('email','')}")
    if real_cancels:
        lines.append("")
        lines.append(f"**Abgesagt ({len(real_cancels)}):**")
        for c in real_cancels[:10]:
            reason = (c.get("reason") or "").strip()
            q1, q2 = chr(0x201E), chr(0x201C)
            r = f" · {q1}{reason}{q2}" if reason else ""
            lines.append(f"- {c.get('person_name','?')} · via {c.get('source')}{r}")
    text = "\n".join(lines)

    _post_to_klaus_channel(
        text=text,
        source="lead-digest",
        dedupe_key=f"lead-digest:{today_str}:{slot}",
        force=True,
    )
    state[f"last_{slot}"] = today_str
    state["last_cutoff"] = now
    return {
        "status": "found",
        "message": f"{slot}: {len(real_new)} neu, {len(real_cancels)} abgesagt",
        "payload": state,
    }


def _looks_like_test_lead(lead: dict) -> bool:
    name = (lead.get("name") or "").lower()
    email = (lead.get("email") or "").lower()
    source = (lead.get("source") or "").lower()
    if any(k in name for k in ("test", "diag", "kvfinal", "nahtlos", "warteliste", "smoke")):
        return True
    if any(k in email for k in ("test@", "diag", "smoke", "waitlist-check", "owner-account")):
        return True
    if any(k in source for k in ("test", "diag", "watchdog", "smoke", "kv-test", "mail-test")):
        return True
    return False


def _pulse_lead_reconciler() -> dict:
    import eingang
    res = eingang.reconcile_denzer_leads()
    new_count = int(res.get("inserted") or res.get("recorded") or 0)
    if new_count > 0:
        # Proaktiv in den Klaus-Channel posten. HTTP statt direkter Aufruf,
        # weil Pulses im Subprocess laufen — der Server muss broadcast_sync()
        # im laufenden async-Loop ausführen.
        s = "" if new_count == 1 else "s"
        ist = "ist" if new_count == 1 else "sind"
        variants = [
            f"{new_count} neue{'r' if new_count == 1 else ''} Lead{s} da, magst du draufschauen?",
            f"Gerade {ist} {new_count} Lead{s} reingekommen.",
            f"Würde sagen, gleich den/die {new_count} Lead{s} im Eingang abklopfen, bevor sie kalt werden.",
        ]
        _post_to_klaus_channel(
            source="lead-reconciler",
            variants=variants,
        )
    return {
        "status": "found" if new_count > 0 else "ok",
        "message": f"{new_count} neue Leads",
        "payload": res,
    }


def _post_to_klaus_channel(
    text: str | None = None,
    source: str = "",
    dedupe_key: str | None = None,
    variants: list[str] | None = None,
    cooldown_sec: int | None = None,
    force: bool = False,
) -> None:
    """Fire-and-forget Post in den Klaus-Channel. Best-effort, blockiert nie.

    Mit `variants` rotiert der Tonfall zwischen Frage/Beobachtung/Vorschlag.
    """
    import json as _json
    import os as _os
    import urllib.request as _ur
    import urllib.error as _ue
    payload: dict = {"source": source, "dedupe_key": dedupe_key}
    if variants:
        payload["variants"] = variants
    if text is not None:
        payload["text"] = text
    if cooldown_sec is not None:
        payload["cooldown_sec"] = cooldown_sec
    if force:
        payload["force"] = True
    body = _json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = _os.environ.get("AGENT_TOKEN", "").strip()
    if not token:
        try:
            from pathlib import Path as _P
            for line in (_P(__file__).resolve().parent.parent / ".env").read_text().splitlines():
                if line.startswith("AGENT_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except OSError:
            pass
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = _ur.Request(
        "http://127.0.0.1:8890/api/klaus-channel/post",
        data=body,
        method="POST",
        headers=headers,
    )
    try:
        with _ur.urlopen(req, timeout=3) as r:
            r.read()
    except _ue.HTTPError as e:
        print(f"[klaus-channel post] HTTP {e.code} source={source}", flush=True)
    except (_ue.URLError, TimeoutError, OSError) as e:
        print(f"[klaus-channel post] {type(e).__name__}: {e} source={source}", flush=True)


def _pulse_server_ping() -> dict:
    import urllib.request
    url = "http://127.0.0.1:8890/api/system-status"
    req = urllib.request.Request(url, headers={"User-Agent": "heartbeat"})
    with urllib.request.urlopen(req, timeout=3) as r:
        code = r.getcode()
    if code != 200:
        raise RuntimeError(f"system-status HTTP {code}")
    return {"status": "ok", "message": "200 OK", "payload": {"code": code}}


# Mehrfach-Bestaetigungs-Schwelle: so oft muss derselbe App-Stabilitaetsfall
# (gleiche Signatur) ueber aufeinanderfolgende Laeufe bestaetigt sein, bevor ein
# einziger Handlungs-Ping in den Klaus-Channel geht. Lauf-Intervall ~300s.
_APP_PERF_CONFIRM_THRESHOLD = 3


def _pulse_app_perf_check() -> dict:
    """Slimmer App-Stabilitätscheck: keine Diagnosewand, nur klare Auffälligkeiten."""
    path = _PROJECT_ROOT / "data" / "mobile-perf.jsonl"
    if not path.exists():
        return {"status": "ok", "message": "noch keine App-Messwerte", "payload": {}}

    state = _get_pulse_state("app-perf-check")
    prior_case = state.get("case") if isinstance(state.get("case"), dict) else {}
    since_ms = int((time.time() - 15 * 60) * 1000)
    clients: dict[str, dict] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-3000:]
    except Exception as e:
        raise RuntimeError(f"App-Perf nicht lesbar: {e}")

    def _client(name: str) -> dict:
        return clients.setdefault(name or "unknown", {
            "samples": 0,
            "maxDriftMs": 0,
            "longTaskMs": 0,
            "longTaskCount": 0,
            "routes": {},
            "areas": {},
            "events": {},
        })

    def _merge_bucket(target: dict, source: dict) -> None:
        if not isinstance(source, dict):
            return
        for key, raw in source.items():
            if not isinstance(raw, dict):
                continue
            cur = target.setdefault(str(key)[:160], {"count": 0, "ok": 0, "error": 0, "totalMs": 0.0, "maxMs": 0.0})
            cur["count"] += int(raw.get("count") or 0)
            cur["ok"] += int(raw.get("ok") or 0)
            cur["error"] += int(raw.get("error") or 0)
            cur["totalMs"] += float(raw.get("totalMs") or 0)
            cur["maxMs"] = max(float(cur.get("maxMs") or 0), float(raw.get("maxMs") or 0))

    for line in lines:
        try:
            row = json.loads(line)
        except Exception:
            continue
        ts = int(row.get("received_at") or row.get("ts") or 0)
        if ts < since_ms:
            continue
        client = _client(str(row.get("clientKind") or "unknown")[:32])
        client["samples"] += 1
        client["maxDriftMs"] = max(client["maxDriftMs"], int(row.get("maxDriftMs") or 0))
        client["longTaskMs"] += int(row.get("longTaskMs") or 0)
        client["longTaskCount"] += int(row.get("longTaskCount") or 0)
        event = row.get("event")
        if event:
            client["events"][str(event)] = client["events"].get(str(event), 0) + 1
        _merge_bucket(client["routes"], row.get("routes") or {})
        _merge_bucket(client["areas"], row.get("areas") or {})

    findings: list[str] = []
    payload_clients: dict[str, dict] = {}
    for name, c in sorted(clients.items()):
        if c["samples"] <= 0:
            continue
        req_count = sum(int(v.get("count") or 0) for v in c["routes"].values())
        req_errors = sum(int(v.get("error") or 0) for v in c["routes"].values())
        slow_routes = []
        for route, v in c["routes"].items():
            count = int(v.get("count") or 0)
            if count < 3:
                continue
            avg = float(v.get("totalMs") or 0) / max(1, count)
            if avg >= 1500 or float(v.get("maxMs") or 0) >= 4000:
                slow_routes.append((route, round(avg), round(float(v.get("maxMs") or 0)), count))
        slow_routes.sort(key=lambda r: (r[2], r[1]), reverse=True)

        bits = []
        # Reiner Timer-Drift ohne Longtask ist kein UI-Hänger, sondern OS-Throttling
        # (verdecktes Fenster / macOS App Nap). Echte Blockaden erzeugen immer Longtasks.
        if c["maxDriftMs"] >= 700 and c["longTaskMs"] >= 200:
            bits.append(f"UI-Hänger bis {c['maxDriftMs']} ms")
        if c["longTaskMs"] >= 2500:
            bits.append(f"lange Hauptthread-Arbeit {round(c['longTaskMs'] / 1000, 1)} s")
        if req_count >= 10 and req_errors / max(1, req_count) >= 0.08:
            bits.append(f"{req_errors}/{req_count} API-Fehler")
        if slow_routes:
            route, avg, max_ms, count = slow_routes[0]
            bits.append(f"langsame Route {route} Ø {avg} ms, max {max_ms} ms")

        payload_clients[name] = {
            "samples": c["samples"],
            "request_count": req_count,
            "request_errors": req_errors,
            "max_drift_ms": c["maxDriftMs"],
            "long_task_ms": c["longTaskMs"],
            "slow_routes": slow_routes[:5],
            "events": c["events"],
        }
        if bits:
            findings.append(f"{name}: " + "; ".join(bits))

    def _open_case(signature: str, confirmations: int, pinged: bool) -> dict:
        same_case = prior_case if prior_case.get("signature") == signature else {}
        return {
            "id": same_case.get("id") or f"app-perf-{int(time.time())}",
            "status": "open",
            "signature": signature,
            "opened_at": same_case.get("opened_at") or int(time.time()),
            "updated_at": int(time.time()),
            "confirmations": confirmations,
            "pinged": pinged,
            "findings": findings,
            "fix_policy": (
                "Klaus darf klare Stabilitäts- und Funktionserhalt-Fixes selbst angehen; "
                "Produkt-, Design- oder Risikoentscheidungen fragt er vorher."
            ),
        }

    if findings:
        main = findings[0]
        signature = hashlib.sha1("|".join(findings).encode("utf-8")).hexdigest()[:12]
        # Mehrfach-Bestaetigung: derselbe Fall (gleiche Signatur) muss ueber
        # mehrere aufeinanderfolgende Laeufe stehen, bevor wir pingen. Eine neue
        # oder veraenderte Signatur startet die Zaehlung wieder bei 1. So kommt
        # kein sofortiger "ich gucke nochmal"-Ping pro Einzelbeobachtung mehr.
        if prior_case.get("status") == "open" and prior_case.get("signature") == signature:
            confirmations = int(prior_case.get("confirmations") or 0) + 1
            already_pinged = bool(prior_case.get("pinged"))
        else:
            confirmations = 1
            already_pinged = False
        should_ping = confirmations >= _APP_PERF_CONFIRM_THRESHOLD and not already_pinged
        case = _open_case(signature, confirmations, already_pinged or should_ping)
        # Fall persistent in die Fix-Queue legen, damit der Fix-Job ihn echt
        # abarbeitet statt dass er im Chat versandet. Idempotent ueber die Signatur.
        # Laeuft unveraendert weiter, unabhaengig vom Ping.
        try:
            from modules.systemcheck import fix_queue as _fixq
            _fixq.upsert(signature, findings)
        except Exception as _e:
            print(f"[app-perf-check] fix_queue.upsert failed: {_e}", flush=True)
        if should_ping:
            text = (
                "**System-Check App**\n\n"
                f"- **Befund:** {main}.\n"
                f"- **Einordnung:** Ich habe diesen Fall ueber {confirmations} Laeufe geprueft, er bestaetigt sich. Das muessen wir jetzt angehen.\n"
                "- **Naechster Schritt:** Der Fix-Job nimmt sich den Fall vor, untersucht die Ursache und meldet hier Fix plus Gegenmessung oder eine Rueckfrage bei Produkt- und Designthemen. Bis dahin bleibt der Fall offen."
            )
            _post_to_klaus_channel(
                text=text,
                source="app-perf-check",
                dedupe_key=f"app-perf-open:{signature}",
                cooldown_sec=1800,
            )
        return {
            "status": "found",
            "message": f"Fall offen ({confirmations}x): {'; '.join(findings[:2])}",
            "payload": {
                "case": case,
                "clients": payload_clients,
                "findings": findings,
                "important": should_ping,
            },
        }

    total_samples = sum(int(c.get("samples") or 0) for c in clients.values())
    label = ", ".join(f"{name}:{c['samples']}" for name, c in sorted(clients.items()) if c.get("samples"))
    if prior_case.get("status") == "open":
        closed_case = dict(prior_case)
        closed_case["status"] = "closed"
        closed_case["closed_at"] = int(time.time())
        closed_case["close_reason"] = f"stabile Gegenmessung ({label or 'keine frischen Samples'})"
        # Fall still aus der Fix-Queue nehmen: er hat sich in der Messung beruhigt.
        # Kein Ping bei gruenem Zustand. Weder ueber den Check noch ueber das
        # Ergebnis ("stabil"/"geschlossen"). Es bleibt beim Logbuch/Queue-Eintrag.
        try:
            from modules.systemcheck import fix_queue as _fixq
            _fixq.resolve(prior_case.get("signature") or "", "stabile Gegenmessung", resolved_by="app-perf-check")
        except Exception as _e:
            print(f"[app-perf-check] fix_queue.resolve failed: {_e}", flush=True)
        return {
            "status": "ok",
            "message": f"Fall geschlossen, stabil ({label or 'keine frischen Samples'})",
            "payload": {
                "samples": total_samples,
                "clients": payload_clients,
                "case": closed_case,
                "important": False,
            },
        }

    return {"status": "ok", "message": f"stabil ({label or 'keine frischen Samples'})", "payload": {"samples": total_samples, "clients": payload_clients, "case": prior_case}}


def _pulse_backup_freshness() -> dict:
    """Schaut nach jüngstem Backup unter ~/Backups/agent/."""
    from pathlib import Path
    bdir = Path.home() / "Backups" / "agent"
    if not bdir.exists():
        return {"status": "ok", "message": "kein Backup-Verzeichnis", "payload": {}}
    files = sorted(bdir.glob("*"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    if not files:
        raise RuntimeError("keine Backup-Datei im Verzeichnis")
    newest = files[0]
    age_h = (time.time() - newest.stat().st_mtime) / 3600
    if age_h > 36:
        raise RuntimeError(f"letztes Backup {age_h:.1f}h alt")
    return {
        "status": "ok",
        "message": f"jüngstes Backup vor {age_h:.1f}h",
        "payload": {"newest": newest.name, "age_h": round(age_h, 2)},
    }


def _pulse_denzer_leads_pull() -> dict:
    """Zieht neue Leads aus Cloudflare KV in die lokale denzer_leads-Tabelle."""
    import subprocess
    from pathlib import Path
    script = Path(__file__).resolve().parent.parent / "scripts" / "sync-denzer-leads.py"
    proc = subprocess.run(
        ["/usr/bin/python3", str(script)],
        capture_output=True, text=True, timeout=25,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()[:300])
    out = (proc.stdout or "").strip()
    new = 0
    for tok in out.split():
        if tok.startswith("new="):
            try:
                new = int(tok.split("=", 1)[1])
            except ValueError:
                pass
    return {
        "status": "found" if new > 0 else "ok",
        "message": out[-200:] if out else "ok",
        "payload": {"new": new},
    }


def _pulse_health_watchdog() -> dict:
    """Prüft Server-Health gegen /api/conversations. Bei 3 Fails in Folge
    triggert er einen launchd-Kickstart des Servers."""
    import os
    import subprocess
    import urllib.request
    from pathlib import Path
    from restart_policy import RestartBlockedError, assert_restart_allowed

    state_file = Path("/tmp/klaus-agent-watchdog-fails")
    token = os.environ.get("AGENT_TOKEN", "")
    url = "http://localhost:8890/api/conversations"
    req = urllib.request.Request(url, headers={"User-Agent": "heartbeat-watchdog"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    ok = False
    code = 0
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            code = r.getcode()
            ok = code == 200
    except Exception:
        ok = False

    if ok:
        try:
            state_file.write_text("0")
        except Exception:
            pass
        return {"status": "ok", "message": "200 OK", "payload": {"code": code}}

    fails = 0
    try:
        fails = int(state_file.read_text().strip() or "0")
    except Exception:
        fails = 0
    fails += 1
    try:
        state_file.write_text(str(fails))
    except Exception:
        pass

    if fails >= 3:
        try:
            assert_restart_allowed("pulse:health-watchdog")
            uid = os.getuid()
            subprocess.run(
                ["launchctl", "kickstart", "-k", f"gui/{uid}/com.klaus.agent"],
                capture_output=True, timeout=10,
            )
            state_file.write_text("0")
        except RestartBlockedError as exc:
            raise RuntimeError(f"unhealthy (code={code}) → {exc}") from exc
        except Exception:
            pass
        raise RuntimeError(f"unhealthy (code={code}) → kickstart nach {fails} Fails")

    raise RuntimeError(f"unhealthy (code={code}, {fails}/3 Fails)")


def _pulse_crm_reindexer() -> dict:
    """Indexiert FOCUS-Items und lokale Calendar-Events neu, damit Personen-
    Mentions frisch bleiben. GCal-Pull bewusst ausgespart (zu langsam fuer Pulse)."""
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    script = root / "scripts" / "reindex-crm-mentions.py"
    py = root / ".venv" / "bin" / "python3"
    py_path = str(py) if py.exists() else "/usr/bin/python3"
    proc = subprocess.run(
        [py_path, str(script), "--skip-gcal"],
        capture_output=True, text=True, timeout=25,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()[:300])
    out = (proc.stdout or "").strip()
    # Erwartete Zeilen: "  → N Items, M Personen-Hits, K Projekt-Hits" — wir summieren Personen-Hits
    people_hits = 0
    items_total = 0
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("→"):
            line = line[1:].strip()
        if "Personen-Hits" in line:
            parts = line.split(",")
            for p in parts:
                p = p.strip()
                if p.endswith("Items") or p.endswith("Events"):
                    try:
                        items_total += int(p.split()[0])
                    except (ValueError, IndexError):
                        pass
                elif p.endswith("Personen-Hits"):
                    try:
                        people_hits += int(p.split()[0])
                    except (ValueError, IndexError):
                        pass
    return {
        "status": "found" if people_hits > 0 else "ok",
        "message": f"{items_total} Items, {people_hits} Personen-Hits",
        "payload": {"items": items_total, "people_hits": people_hits},
    }


def _pulse_whatsapp_people_sync() -> dict:
    """Importiert aktive WhatsApp-Chats nach people.db. Idempotent über
    whatsapp_chat_id. Quelle der Wahrheit für Personen bleibt people.db,
    whatsapp.db ist nur Transport."""
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    script = root / "scripts" / "people-import-whatsapp.py"
    py = root / ".venv" / "bin" / "python3"
    py_path = str(py) if py.exists() else "/usr/bin/python3"
    proc = subprocess.run(
        [py_path, str(script)],
        capture_output=True, text=True, timeout=55,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()[:300])
    out = (proc.stdout or "").strip()
    # Erwartet: "created: N, updated: M, unchanged: K"
    created = updated = unchanged = 0
    for line in out.splitlines():
        if line.startswith("created:"):
            parts = [p.strip() for p in line.split(",")]
            for p in parts:
                k, _, v = p.partition(":")
                try: n = int(v.strip())
                except ValueError: continue
                if k.strip() == "created": created = n
                elif k.strip() == "updated": updated = n
                elif k.strip() == "unchanged": unchanged = n
    found = created > 0 or updated > 0
    return {
        "status": "found" if found else "ok",
        "message": f"created={created}, updated={updated}, unchanged={unchanged}",
        "payload": {"created": created, "updated": updated, "unchanged": unchanged},
    }


def _pulse_people_enrich() -> dict:
    """Ergänzt fehlende email/phone in people.db aus WhatsApp-Messages und
    Klaus-Chats. Idempotent (schreibt nie über vorhandene Werte). Regex-basiert
    — Firma/Stadt/Rolle bleiben dem User oder einem späteren LLM-Schritt überlassen."""
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    script = root / "scripts" / "people-enrich.py"
    py = root / ".venv" / "bin" / "python3"
    py_path = str(py) if py.exists() else "/usr/bin/python3"
    proc = subprocess.run(
        [py_path, str(script)],
        capture_output=True, text=True, timeout=110,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()[:300])
    out = (proc.stdout or "").strip()
    # Erwartet: "scanned N people, enriched email=E, phone=P"
    scanned = email_n = phone_n = 0
    m = re.search(r"scanned\s+(\d+)\s+people", out)
    if m: scanned = int(m.group(1))
    m = re.search(r"email=(\d+)", out)
    if m: email_n = int(m.group(1))
    m = re.search(r"phone=(\d+)", out)
    if m: phone_n = int(m.group(1))
    found = email_n > 0 or phone_n > 0
    return {
        "status": "found" if found else "ok",
        "message": f"scanned={scanned}, email+={email_n}, phone+={phone_n}",
        "payload": {"scanned": scanned, "email": email_n, "phone": phone_n},
    }


def _get_pulse_state(name: str) -> dict:
    """Liest last_payload eines Pulses als Dict — als State-Storage zwischen Läufen."""
    try:
        with get_db() as db:
            row = db.execute(
                "SELECT last_payload FROM pulses WHERE name=?", (name,)
            ).fetchone()
            if not row:
                return {}
            return json.loads(row["last_payload"] or "{}") or {}
    except Exception:
        return {}


def _pulse_radar_intraday() -> dict:
    """Liest das heutige radar-konsolidiert.md und pingt einmal pro Tag einen
    Punkt, der zu des Nutzers scharfen Themen passt. Fokus liegt auf
    Agenten-Systemen, OpenClaw/Hermes und konkretem Nachbau-Wert für Agent
    Control. Bewusst getrennt vom Morgenbriefing — feuert frühestens 12:00,
    einmal pro Tag.
    """
    from datetime import datetime
    from pathlib import Path

    now = datetime.now()
    if now.hour < 12:
        return {"status": "ok", "message": "vor 12:00", "payload": {}}

    state = _get_pulse_state("radar-intraday")
    today_key = now.strftime("%Y-%m-%d")
    if state.get("last_post_day") == today_key:
        return {"status": "ok", "message": "schon gepostet heute", "payload": state}

    radar_file = Path(f"/Users/klaus/agent/jobs/radar-konsolidiert/data/{today_key}-radar-konsolidiert.md")
    if not radar_file.exists():
        return {"status": "ok", "message": "kein Radar heute", "payload": state}

    text = radar_file.read_text(encoding="utf-8", errors="replace")
    # Themen-Keywords, scharf an des Nutzers Interessen. OpenClaw/Hermes sind
    # Beobachtungsquellen, aber gepostet wird nur bei Substanz oder Nachbau-Wert.
    themes = [
        "openclaw", "hermes agent", "hermes", "personal agent", "memory-agent",
        "agent control", "agent-control", "agent-markt", "agent market",
        "claude code", "mcp", "workflow", "workflows", "memory", "kontext",
        "context", "skills", "tooling", "eval", "checkpoint",
        "workshop", "inhouse", "ai-engineer", "ai engineer", "coach",
    ]
    implementation_terms = [
        "nachbau", "nachbauen", "übernehmen", "bauen", "umbauen", "pattern",
        "architektur", "für klaus", "für unseren stack", "agent control",
        "workflow", "memory", "checkpoint", "dashboard", "inspiration",
        "implikation für christian",
    ]
    # Iteriere nur über echte Story-Bullets aus dem aktuellen Konsolidierer-Format.
    blocks = re.findall(r"(?ms)^- \*\*\[[^\]]+\]\([^)]+\)\*\*.*?(?=^\- \*\*\[|^---|\Z)", text)
    hit: tuple[str, str] | None = None
    for block in blocks:
        low = block.lower()
        theme_score = any(t in low for t in themes)
        implementation_score = any(t in low for t in implementation_terms)
        if not (theme_score and implementation_score):
            continue
        # Titel extrahieren
        m_title = re.search(r"\*\*\[([^\]]+)\]", block)
        m_why = (
            re.search(r"\*\*Implikation für der Nutzer:\*\*\s*([^\n]+)", block)
            or re.search(r"\*\*Warum wichtig:\*\*\s*([^\n]+)", block)
        )
        if not m_title:
            continue
        title = m_title.group(1).strip()
        why = (m_why.group(1).strip() if m_why else "").rstrip(" .")
        hit = (title, why)
        break

    if not hit:
        # Heute nichts Passendes — Tag trotzdem als "gesehen" markieren.
        return {"status": "ok", "message": "kein Themen-Treffer", "payload": {"last_post_day": today_key}}

    title, why = hit
    # Editorial-Ping-Format: fette weisse Headline (Titel), dann kurze Bullets
    # mit fettem Label vorn. Kein Prosablock mehr.
    why_clean = why.rstrip(" .") if why else ""
    if why_clean:
        variants = [
            f"**{title}**\n\n- **Bedeutung:** {why_clean}.\n- **Vorschlag:** Als Nachbau-Spur für Klaus prüfen?",
            f"**{title}**\n\n- **Aus dem Radar:** {why_clean}.\n- **Spur:** Könnte für unseren Stack taugen, kurz reinschauen?",
            f"**{title}**\n\n- **Worum es geht:** {why_clean}.\n- **Frage:** Lohnt ein Blick als Bau-Idee?",
        ]
    else:
        variants = [
            f"**{title}**\n\n- **Aus dem Radar:** Sieht nach einer Nachbau-Spur für Klaus aus.\n- **Frage:** Magst du kurz reinschauen?",
            f"**{title}**\n\n- **Aufgefallen:** Agenten-Inspiration aus dem heutigen Radar.\n- **Frage:** Für unseren Stack interessant?",
            f"**{title}**\n\n- **Notiz:** Würde ich dir als mögliche Bau-Idee nachreichen.\n- **Frage:** Kurz prüfen?",
        ]
    _post_to_klaus_channel(
        source="radar-intraday",
        variants=variants,
        dedupe_key=f"radar-{today_key}",
        cooldown_sec=20 * 3600,
    )
    return {
        "status": "found",
        "message": f"Radar-Hit: {title[:60]}",
        "payload": {"last_post_day": today_key, "title": title, "why": why},
    }


def _pulse_dreaming_pattern() -> dict:
    """Bringt das einzelne staerkste, noch nicht gezeigte Dreaming-Muster als
    leisen Muster-Ping in den Klaus-Channel. Hoechstens einmal pro Tag, jedes
    Muster nur einmal. Feuert fruehestens 14:00, damit es ruhig im Nachmittag
    liegt, getrennt vom Morgenbriefing.
    """
    from datetime import datetime
    import dreaming_module as _dream

    now = datetime.now()
    if now.hour < 14:
        return {"status": "ok", "message": "vor 14:00", "payload": {}}

    state = _get_pulse_state("dreaming-pattern")
    today_key = now.strftime("%Y-%m-%d")
    if state.get("last_post_day") == today_key:
        return {"status": "ok", "message": "schon gepostet heute", "payload": state}

    shown = set(state.get("shown_ids") or [])
    hit = _dream.strongest_unshown_pattern(shown)
    if not hit:
        # Kein neues gefestigtes Muster: Tag nicht verbrauchen, State halten.
        return {"status": "ok", "message": "kein neues Muster", "payload": state}

    body = str(hit.get("body") or "").strip()
    # Keine Gedankenstriche im sichtbaren Output: Em-/En-Dash zu Komma glaetten.
    for _dash in ("\u2014", "\u2013"):
        body = body.replace(f" {_dash} ", ", ").replace(_dash, ", ")
    body = re.sub(r"\s+", " ", body).strip().rstrip(",").strip()

    cid = str(hit.get("id") or "")
    _post_to_klaus_channel(
        source="dreaming-pattern",
        text=body,
        dedupe_key=f"dreaming-{cid}",
        cooldown_sec=20 * 3600,
    )
    shown.add(cid)
    shown_list = list(shown)[-200:]  # State gedeckelt halten
    return {
        "status": "found",
        "message": f"Muster-Ping: {body[:60]}",
        "payload": {"last_post_day": today_key, "shown_ids": shown_list},
    }


def _pulse_local_llm() -> dict:
    """Prüft, ob LM Studio antwortet, und meldet, wie oft das lokale Modell
    heute schon dran war. Rein lesend — selbst kein LLM-Call.
    """
    from local_llm import is_available, read_counter, LOCAL_LLM_MODEL
    up = is_available(timeout=1.5)
    counter = read_counter()
    today = int(counter.get("today_count") or 0)
    total = int(counter.get("total_30d") or 0)
    if not up:
        raise RuntimeError(f"LM Studio nicht erreichbar (heute {today} Calls, 30d {total})")
    return {
        "status": "found" if today > 0 else "ok",
        "message": f"{today} Calls heute (30d: {total}) · {LOCAL_LLM_MODEL}",
        "payload": {"today": today, "total_30d": total, "model": LOCAL_LLM_MODEL},
    }


def _pulse_health_sleep_watcher() -> dict:
    """Wartet zwischen 06:00 und 12:00 auf vollständige Schlafdaten von heute
    und triggert den Health-Job genau einmal, sobald sleepEnd vorliegt.
    """
    import json
    import subprocess
    from datetime import datetime
    from zoneinfo import ZoneInfo

    now = datetime.now(ZoneInfo("Europe/Berlin"))
    if not (6 <= now.hour < 12):
        return {"status": "ok", "message": "außerhalb Zeitfenster (06–12 Uhr)"}

    today_str = now.strftime("%Y-%m-%d")
    PROJECT_ROOT = Path(__file__).parent.parent

    # Neuestes Export-File von heute auf vollständige sleep_analysis prüfen
    health_data_dir = PROJECT_ROOT / "data" / "health" / today_str
    if not health_data_dir.exists():
        return {"status": "ok", "message": "Noch kein Export heute"}

    sleep_end_found = None
    for f in sorted(health_data_dir.glob("*.json"), reverse=True):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            metrics = data.get("data", {}).get("metrics", [])
            for m in metrics:
                if m.get("name") == "sleep_analysis":
                    for entry in m.get("data", []):
                        sleep_end = entry.get("sleepEnd", "")
                        if sleep_end and today_str in sleep_end:
                            sleep_end_found = sleep_end
                            break
            if sleep_end_found:
                break
        except Exception:
            continue

    if not sleep_end_found:
        return {"status": "ok", "message": "Schlafdaten noch unvollständig, warte..."}

    # Ein früher Morgenreport darf nicht als erledigt gelten, wenn die fertige
    # Schlafanalyse erst danach gepusht wurde.
    health_report = PROJECT_ROOT / "jobs" / "health" / "data" / f"{today_str}-health.md"
    health_meta = PROJECT_ROOT / "jobs" / "health" / "data" / f"{today_str}-health.meta.json"
    if health_report.exists():
        content = health_report.read_text(encoding="utf-8")
        report_ended_at = None
        if health_meta.exists():
            try:
                meta = json.loads(health_meta.read_text(encoding="utf-8"))
                ended_at = meta.get("ended_at")
                if ended_at:
                    report_ended_at = datetime.fromisoformat(ended_at.replace("Z", "+00:00")).astimezone(ZoneInfo("Europe/Berlin"))
            except Exception:
                report_ended_at = None

        try:
            sleep_end_dt = datetime.strptime(sleep_end_found[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("Europe/Berlin"))
        except Exception:
            sleep_end_dt = None

        report_is_after_sleep = bool(report_ended_at and sleep_end_dt and report_ended_at >= sleep_end_dt)
        if report_is_after_sleep and "noch nicht synchronisiert" not in content and "Fragment" not in content:
            return {"status": "ok", "message": "Schlafanalyse heute bereits komplett"}
        # Job läuft gerade oder wurde kürzlich gestartet → nicht doppelt triggern
        if report_is_after_sleep and (time.time() - health_report.stat().st_mtime) < 900:
            return {"status": "ok", "message": "Health-Job läuft noch, warte..."}

    runner = PROJECT_ROOT / "jobs" / "_bin" / "run-job.sh"
    subprocess.Popen(
        [str(runner), "health"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {
        "status": "found",
        "message": f"Schlafdaten komplett (Ende {sleep_end_found[11:16]}), Health-Job getriggert",
    }


def _pulse_youtube_digest() -> dict:
    from datetime import datetime
    import subprocess

    now = datetime.now()
    if now.hour < 6:
        return {"status": "ok", "message": "Warte bis nach 06:00"}

    today = now.strftime("%Y-%m-%d")
    out = _PROJECT_ROOT / "jobs" / "youtube-digest" / "data" / f"{today}-youtube-digest.md"
    if out.exists() and out.stat().st_size > 0:
        return {"status": "ok", "message": "YouTube-Digest heute bereits geschrieben"}

    script = _PROJECT_ROOT / "scripts" / "youtube-digest.py"
    proc = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(_PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        return {"status": "error", "message": (proc.stderr or proc.stdout or "Digest fehlgeschlagen")[-500:]}

    text = out.read_text(encoding="utf-8", errors="replace").strip() if out.exists() else ""
    if text == "NO_REPLY":
        return {"status": "ok", "message": "Keine frischen YouTube-Signale"}
    return {"status": "found", "message": "YouTube-Digest geschrieben", "changed": True}


def _pulse_problem_radar() -> dict:
    """Problem-Radar: einmal taeglich X nach echten Schmerzpunkten absuchen,
    hart filtern, nur belastbare Funde als Idee parken. Tages-Sperre + Uhrzeit
    stecken im Modul (run_pulse), hier nur der Aufruf."""
    try:
        from modules.problem_radar.core import run_pulse
        return run_pulse()
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "message": f"problem_radar: {e}"[:300]}


def register_defaults() -> None:
    """Default-Pulses. Idempotent — kann mehrfach aufgerufen werden."""
    register("mail-scanner",       300, _pulse_mail_scanner, timeout_sec=30.0)
    register("mail-triage",        900, _pulse_mail_triage, timeout_sec=200.0)
    register("lead-reconciler",    300, _pulse_lead_reconciler)
    register("lead-digest",        300, _pulse_lead_digest)
    register("denzer-leads-pull",  300, _pulse_denzer_leads_pull, timeout_sec=30.0)
    register("server-ping",         60, _pulse_server_ping)
    register("health-watchdog",     60, _pulse_health_watchdog)
    register("app-perf-check",      300, _pulse_app_perf_check, timeout_sec=5.0)
    register("backup-freshness",  3600, _pulse_backup_freshness)
    register("crm-reindexer",      600, _pulse_crm_reindexer, timeout_sec=30.0)
    register("whatsapp-people-sync", 600, _pulse_whatsapp_people_sync, timeout_sec=60.0)
    register("people-enrich",       1800, _pulse_people_enrich, timeout_sec=120.0)
    register("local-llm",             300, _pulse_local_llm, timeout_sec=5.0, engine="qwen")
    register("health-sleep-watcher",  900, _pulse_health_sleep_watcher, timeout_sec=10.0)
    register("youtube-digest",       1800, _pulse_youtube_digest, timeout_sec=40.0)
    register("radar-intraday",       3600, _pulse_radar_intraday)
    register("dreaming-pattern",     3600, _pulse_dreaming_pattern)
    register("problem-radar",        3600, _pulse_problem_radar, timeout_sec=180.0)
    # Radar darf bei konkreter Nachbauchance einmal täglich durchkommen.
