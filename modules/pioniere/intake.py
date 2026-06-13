"""Redaktion: Pioniere-Post-Agent von der Idee zur freigegebenen Veröffentlichung.

Trigger: der Job `pioniere-impuls` läuft im Vorlauf, recherchiert im Radar und
schreibt einen fertigen Community-Post. Statt blind zu posten ruft er
`stage_post`. Daraus baut der Agent eine prüfbare Vorschau im Klaus-Channel,
NICHT sofort einen echten Post.

Schritte: Recherche-Notiz -> Entwurf + Selbst-Check -> Freigabe-Vorschau.
Erst auf ausdrückliche Freigabe (approve_post) geht der Post über
scripts/pioniere-post.sh wirklich in die Pioniere-Community. So geht nie etwas
ungesehen raus, ganz nach des Nutzers Outbound-Regel.

Bausteine aus dem Bestand:
- scripts/pioniere-post.sh (echter Community-Post + Klaus-Channel-Ping)
- workflows.start_run / add_step / finish_run / review_background_run
- klaus_channel.post (proaktive Vorschau im Klaus-Channel)
- config/pioniere-learning.json (Lern-Kreis: fail_streak)
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
from pathlib import Path
from typing import Any

_log = logging.getLogger("pioniere.intake")

WORKFLOW_KEY = "agent.pioniere"
PING_SOURCE = "redaktion"

_ROOT = Path(__file__).resolve().parents[2]
_LEARNING_PATH = _ROOT / "config" / "pioniere-learning.json"
_POST_SCRIPT = _ROOT / "scripts" / "pioniere-post.sh"


# ── Lern-Kreis: Fehlschläge in Folge dämpfen Fehlalarme ──

def _load_learning() -> dict[str, Any]:
    try:
        return json.loads(_LEARNING_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"fail_streak": 0, "fail_streak_max": 3}


def _save_learning(data: dict[str, Any]) -> None:
    _LEARNING_PATH.parent.mkdir(parents=True, exist_ok=True)
    _LEARNING_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
    )


def _bump_fail_streak(reset: bool = False) -> int:
    data = _load_learning()
    streak = 0 if reset else int(data.get("fail_streak", 0)) + 1
    data["fail_streak"] = streak
    _save_learning(data)
    return streak


# ── Titel + kurze ID, damit der Nutzer über einen Entwurf reden kann ──

def _make_title(body: str, source_note: str = "") -> str:
    """Kurzer, sprechbarer Titel für einen Entwurf.

    Bevorzugt die Recherche-Notiz, sonst der erste Satz des Bodys, knapp
    gehalten, damit man ihn im Chat nennen kann.
    """
    raw = (source_note or "").strip() or (body or "").strip()
    if not raw:
        return "Entwurf"
    first = raw.replace("\n", " ").split(". ")[0].strip()
    words = first.split()
    if len(words) > 8:
        first = " ".join(words[:8]) + " …"
    if len(first) > 64:
        first = first[:64].rstrip() + " …"
    return first


def _short_ref(run_id: str, idx: int = 0) -> str:
    """Kurzes Handle wie 'A3F9', stabil aus run_id abgeleitet."""
    tail = "".join(c for c in (run_id or "") if c.isalnum())[-4:].upper() or "0000"
    return f"{tail}-{idx}" if idx else tail


# ── Selbst-Check eines Entwurfs (wiederverwendbar für stage + edit) ──

def _self_check(body: str) -> tuple[int, list[str]]:
    body = (body or "").strip()
    words = len(body.split())
    warnings: list[str] = []
    if not body:
        warnings.append("Leerer Entwurf")
    if words > 160:
        warnings.append(f"Recht lang ({words} Wörter), Pioniere-Posts sind kurz")
    if "—" in body or " – " in body:
        warnings.append("Gedankenstrich im Text, der Nutzer mag keine")
    return words, warnings


# ── Vorschau anlegen ──

async def stage_post(
    body: str,
    ping: str = "",
    *,
    kind: str = "hint",
    source_note: str = "",
    trigger: str = "job",
) -> dict[str, Any]:
    """Legt einen Pioniere-Post als prüfbare Vorschau an. Postet NICHTS.

    Rückgabe: {run_id, ready, item}
    """
    import workflows
    from modules.klaus_channel import core as channel

    body = (body or "").strip()
    ping = (ping or "").strip()
    run_id = workflows.start_run(
        WORKFLOW_KEY,
        "Pioniereplaner",
        trigger=trigger,
        subject_type="pioniere",
        subject_ref="community",
        conversation_id=channel.KLAUS_CHANNEL_ID,
    )

    try:
        # --- Schritt 1: Recherche-Notiz festhalten ---
        if source_note:
            workflows.add_step(
                run_id, "research", "Radar gesichtet", "ok",
                source_note[:200],
            )

        # --- Schritt 2: Entwurf + Selbst-Check ---
        words, warnings = _self_check(body)
        ready = bool(body)
        check_status = "warning" if warnings else "ok"
        workflows.add_step(
            run_id, "draft", "Entwurf geprüft", check_status,
            f"{words} Wörter" + (f" · {len(warnings)} Hinweis(e)" if warnings else ""),
            {"words": words, "warnings": warnings},
        )

        item = {
            "idx": 0,
            "title": _make_title(body, source_note),
            "ref": _short_ref(run_id, 0),
            "body": body,
            "ping": ping,
            "kind": kind or "hint",
            "words": words,
            "warnings": warnings,
            "source_note": source_note,
            "status": "ready" if ready else "blocked",
        }

        # --- Schritt 3: Freigabe vorbereiten ---
        workflows.add_step(
            run_id, "await_approval", "Wartet auf Freigabe", "ok",
            "Vorschau bereit, noch nichts veröffentlicht" if ready
            else "Entwurf unvollständig, erst nachschärfen",
            {"ready": ready},
        )

        # --- Schritt 4: Vorschau in den Klaus-Channel ---
        if ready:
            preview = body if len(body) <= 600 else body[:600].rstrip() + " …"
            msg = (
                "**Pioniereplaner:** Nächster Pioniere-Post liegt als Entwurf bereit. "
                "Schau drüber, auf dein OK geht er in die Community. Ich poste nichts ohne Freigabe.\n\n"
                f"> {preview.replace(chr(10), chr(10) + '> ')}"
            )
        else:
            msg = (
                "**Pioniereplaner:** Ich wollte einen Pioniere-Post vorlegen, aber der Entwurf trägt nicht. "
                "Diesmal lieber Stille als Füllstoff."
            )
        channel.post(msg, source=PING_SOURCE, dedupe_key=f"pioniere:{run_id}", cooldown_sec=0)

        workflows.finish_run(run_id, "done", result={
            "ready": ready,
            "items": [item],
            "payload": {"important": True, "changed": ready},
        })
        workflows.review_background_run(run_id)
        _bump_fail_streak(reset=True)

        return {"run_id": run_id, "ready": ready, "item": item}

    except Exception as e:  # noqa: BLE001
        workflows.add_step(run_id, "error", "Fehler im Lauf", "error", str(e)[:200])
        workflows.finish_run(run_id, "error", error=str(e)[:500])
        workflows.review_background_run(run_id)
        streak = _bump_fail_streak()
        max_streak = _load_learning().get("fail_streak_max", 3)
        if streak >= max_streak:
            try:
                from modules.klaus_channel import core as channel
                channel.post(
                    f"**Pioniereplaner** ist {streak}x in Folge gescheitert, zuletzt: {str(e)[:160]}. "
                    f"Da stimmt etwas Grundsätzliches, schau bitte drauf.",
                    source=PING_SOURCE, dedupe_key=f"pioniere-failstreak:{streak}", force=True,
                )
            except Exception:
                pass
        raise


def list_runs(limit: int = 10) -> list[dict[str, Any]]:
    """Letzte Redaktions-Läufe inkl. Entwürfe für die InfoPane-Section."""
    import workflows
    return workflows.recent_runs(limit=limit, workflow_key=WORKFLOW_KEY, visible_only=False)


def _find_item(run_id: str, idx: int) -> tuple[dict | None, dict | None, str]:
    import workflows
    runs = workflows.recent_runs(limit=50, workflow_key=WORKFLOW_KEY, visible_only=False)
    run = next((r for r in runs if r.get("id") == run_id), None)
    if not run:
        return None, None, "Lauf nicht gefunden"
    items = (run.get("result") or {}).get("items") or []
    item = next((d for d in items if int(d.get("idx", -1)) == int(idx)), None)
    if not item:
        return run, None, "Entwurf nicht gefunden"
    return run, item, ""


def _already_done(run: dict, idx: int) -> str:
    for st in run.get("steps") or []:
        key = st.get("step_key") or ""
        if key == f"posted_{idx}" and st.get("status") == "ok":
            return "posted"
        if key == f"discarded_{idx}" and st.get("status") == "ok":
            return "discarded"
        if key == f"queued_{idx}" and st.get("status") == "ok":
            return "queued"
    return ""


# ── Veröffentlichen über scripts/pioniere-post.sh (wiederverwendbar) ──

async def _publish(body: str, ping: str = "", *, kind: str = "hint") -> tuple[bool, str]:
    """Ruft das echte Post-Skript. Gibt (ok, detail) zurück.

    Eine Stelle für den Subprocess, damit Sofort-Freigabe und getakteter
    Versand identisch veröffentlichen.
    """
    body = (body or "").strip()
    ping = (ping or "").strip()
    if not body:
        return False, "Leerer Entwurf"

    body_file = ping_file = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as bf:
            bf.write(body + "\n")
            body_file = bf.name
        args = [str(_POST_SCRIPT), body_file, kind or "hint"]
        if ping:
            with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as pf:
                pf.write(ping + "\n")
                ping_file = pf.name
            args.append(ping_file)

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, errb = await proc.communicate()
        if proc.returncode != 0:
            detail = (errb or out or b"").decode("utf-8", "replace")[:200]
            return False, detail or "pioniere-post.sh fehlgeschlagen"
        return True, (out or b"").decode("utf-8", "replace")[:200]
    finally:
        for f in (body_file, ping_file):
            if f:
                try:
                    Path(f).unlink()
                except Exception:
                    pass


async def edit_post(run_id: str, idx: int, body: str, *, title: str = "") -> dict[str, Any]:
    """Bearbeitet einen wartenden Entwurf, ohne neu zu posten.

    Aktualisiert Body, Titel, Wortzahl und Selbst-Check-Warnungen direkt im
    Lauf-Ergebnis. Schon veröffentlichte oder verworfene Entwürfe sind tabu.
    """
    import workflows

    run, item, err = _find_item(run_id, idx)
    if err:
        return {"ok": False, "error": err}
    state = _already_done(run, idx)
    if state == "posted":
        return {"ok": False, "error": "Schon veröffentlicht, nicht mehr änderbar"}
    if state == "discarded":
        return {"ok": False, "error": "Entwurf wurde verworfen"}

    new_body = (body or "").strip()
    if not new_body:
        return {"ok": False, "error": "Leerer Entwurf, nichts zu speichern"}

    words, warnings = _self_check(new_body)
    result = dict(run.get("result") or {})
    items = list(result.get("items") or [])
    updated = None
    for d in items:
        if int(d.get("idx", -1)) == int(idx):
            d["body"] = new_body
            d["words"] = words
            d["warnings"] = warnings
            d["status"] = "ready" if new_body else "blocked"
            d["title"] = (title or "").strip() or _make_title(new_body, d.get("source_note", ""))
            d.setdefault("ref", _short_ref(run_id, idx))
            updated = d
            break
    if updated is None:
        return {"ok": False, "error": "Entwurf nicht gefunden"}

    result["items"] = items
    result["ready"] = any((d.get("status") == "ready") for d in items)
    workflows.update_run_result(run_id, result)
    workflows.add_step(
        run_id, f"edited_{idx}", "Entwurf bearbeitet", "ok",
        f"{words} Wörter" + (f" · {len(warnings)} Hinweis(e)" if warnings else ""),
    )
    return {"ok": True, "item": updated}


async def approve_post(run_id: str, idx: int = 0) -> dict[str, Any]:
    """Freigabe: legt den Entwurf in die Versand-Queue. Postet NICHT sofort.

    des Nutzers Takt: Freigabe und Versand sind getrennt. Der freigegebene
    Entwurf wartet in der Queue, der Versand-Job schiebt ihn getaktet (alle
    zwei Tage) automatisch raus. Sofortversand geht über publish_now.
    """
    import workflows
    from modules.pioniere import queue as pqueue

    run, item, err = _find_item(run_id, idx)
    if err:
        return {"ok": False, "error": err}
    state = _already_done(run, idx)
    if state == "posted":
        return {"ok": False, "error": "Schon veröffentlicht"}
    if state == "queued":
        return {"ok": False, "error": "Liegt schon in der Versand-Queue"}
    if state == "discarded":
        return {"ok": False, "error": "Entwurf wurde verworfen"}

    body = (item.get("body") or "").strip()
    if not body:
        return {"ok": False, "error": "Leerer Entwurf"}

    entry = pqueue.enqueue({
        "id": pqueue.make_id(run_id, idx),
        "run_id": run_id,
        "idx": int(idx),
        "title": item.get("title") or "Pioniere-Post",
        "ref": item.get("ref") or "",
        "body": body,
        "ping": (item.get("ping") or "").strip(),
        "kind": (item.get("kind") or "hint").strip() or "hint",
        "source_note": item.get("source_note") or "",
    })
    workflows.add_step(
        run_id, f"queued_{idx}", "Für Versand freigegeben", "ok",
        f"In der Queue, nächster Versand {pqueue.next_slot_label()}",
    )
    return {"ok": True, "queued": True, "next_slot": pqueue.next_slot_label(), "entry_id": entry["id"]}


async def publish_now(run_id: str, idx: int = 0) -> dict[str, Any]:
    """Sofortversand eines wartenden oder bereits eingereihten Entwurfs.

    Umgeht den Zwei-Tage-Takt. Veröffentlicht direkt und entfernt den Eintrag
    aus der Queue, falls er drin lag.
    """
    import workflows
    from modules.pioniere import queue as pqueue

    run, item, err = _find_item(run_id, idx)
    if err:
        return {"ok": False, "error": err}
    state = _already_done(run, idx)
    if state == "posted":
        return {"ok": False, "error": "Schon veröffentlicht"}
    if state == "discarded":
        return {"ok": False, "error": "Entwurf wurde verworfen"}

    ok, detail = await _publish(item.get("body") or "", item.get("ping") or "", kind=item.get("kind") or "hint")
    if not ok:
        workflows.add_step(run_id, f"post_error_{idx}", "Veröffentlichen fehlgeschlagen", "error", detail)
        return {"ok": False, "error": detail}

    pqueue.remove(pqueue.make_id(run_id, idx))
    workflows.add_step(
        run_id, f"posted_{idx}", "In Community veröffentlicht", "ok",
        "Sofort gepostet, Klaus-Channel-Ping gesetzt",
    )
    return {"ok": True, "posted": True}


async def dispatch_due(*, force: bool = False) -> dict[str, Any]:
    """Getakteter Versand: schiebt den ältesten Queue-Eintrag raus, wenn fällig.

    Vom Versand-Job (scripts/pioniere-dispatch.py) gerufen. Ein Post pro Lauf.
    force=True ignoriert den Zwei-Tage-Takt (für manuellen Anstoß).
    """
    import workflows
    from modules.pioniere import queue as pqueue

    if not force and not pqueue.dispatch_due():
        return {"ok": True, "posted": False, "reason": "kein Versand fällig"}

    entry = pqueue.peek_next()
    if not entry:
        return {"ok": True, "posted": False, "reason": "Queue leer"}

    ok, detail = await _publish(entry.get("body") or "", entry.get("ping") or "", kind=entry.get("kind") or "hint")
    if not ok:
        # Eintrag bleibt in der Queue, damit nichts verloren geht; Fehler im Lauf vermerken.
        run_id = entry.get("run_id") or ""
        if run_id:
            workflows.add_step(run_id, f"dispatch_error_{entry.get('idx', 0)}", "Auto-Versand fehlgeschlagen", "error", detail)
        return {"ok": False, "posted": False, "error": detail, "entry_id": entry.get("id")}

    pqueue.mark_dispatched(entry.get("id") or "")
    run_id = entry.get("run_id") or ""
    if run_id:
        workflows.add_step(
            run_id, f"posted_{entry.get('idx', 0)}", "Automatisch veröffentlicht", "ok",
            "Getakteter Versand, Klaus-Channel-Ping gesetzt",
        )
    return {"ok": True, "posted": True, "entry_id": entry.get("id"), "title": entry.get("title")}


def list_pending_drafts(limit: int = 30) -> list[dict[str, Any]]:
    """Alle wartenden Entwürfe quer über die letzten Läufe (für den Workspace).

    Wartend = weder gepostet noch verworfen noch in der Queue. So sieht
    der Nutzer den ganzen Sammel-Stapel, nicht nur den jüngsten Lauf.
    """
    import workflows
    runs = workflows.recent_runs(limit=limit, workflow_key=WORKFLOW_KEY, visible_only=False)
    pending: list[dict[str, Any]] = []
    for run in runs:
        items = (run.get("result") or {}).get("items") or []
        for d in items:
            idx = int(d.get("idx", 0))
            if _already_done(run, idx):
                continue
            pending.append({**d, "run_id": run.get("id"), "run_created_at": run.get("created_at")})
    return pending


async def discard_post(run_id: str, idx: int = 0) -> dict[str, Any]:
    """Verwirft den Entwurf. Es wird nichts veröffentlicht."""
    import workflows
    run, item, err = _find_item(run_id, idx)
    if err:
        return {"ok": False, "error": err}
    state = _already_done(run, idx)
    if state == "posted":
        return {"ok": False, "error": "Schon veröffentlicht, nicht mehr verwerfbar"}
    if state == "discarded":
        return {"ok": True, "discarded": True}
    workflows.add_step(run_id, f"discarded_{idx}", "Entwurf verworfen", "ok", "Nichts veröffentlicht")
    return {"ok": True, "discarded": True}
