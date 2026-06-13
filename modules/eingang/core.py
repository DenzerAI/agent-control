"""Eingang-Orchestrator + Pulses-Heartbeat + Klaus-Channel.

Drei thematisch verwandte Blöcke, die zusammen die "Was ist neu?"-Schicht
des Dashboards bilden:

- **Eingang** zählt Unseen-Events pro InfoPane-Sektion (Fokus/Leads/Workshops),
  liefert die Liste und markiert als gesehen. Quellen-spezifisches Recording
  passiert in den Adaptern (denzer-leads, workshops, …) via
  `eingang.record_event()`. Konzept: brain/ideas/eingang-orchestrator.md.
- **Pulses** sind die Heartbeats für die UI-Statusleiste (z. B. Mail-Polling,
  Sync-Jobs). `register_defaults()` setzt sie auf, `snapshot()` liefert den
  aktuellen Status, `run_due()` triggert fällige Pulses manuell.
- **Klaus-Channel** ist der proaktive Faden für Klaus-initiierte Posts. Geht
  durch Dedup + Rate-Limit + Cooldown und broadcastet bei Erfolg per SSE,
  damit offene Frontends den Channel sofort orange ziehen.
  Konzept: brain/ideas/klaus-channel.md.

Vorher: ~100 Zeilen in `backend/server.py` (6580–6681).
"""
from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse


router = APIRouter()


# ── Eingang-Orchestrator ─────────────────────────────────────────────
@router.get("/api/eingang/counts")
async def eingang_counts():
    """Unseen-Counts pro InfoPane-Sektion. Frontend nutzt das, um Section-Icons
    orange zu färben. Aggregiert aus events + denzer_leads."""
    import eingang as _eingang
    return _eingang.count_unseen_per_section()


@router.get("/api/eingang/list")
async def eingang_list(limit: int = 50, unseen_only: int = 0):
    import eingang as _eingang
    return {"events": _eingang.list_recent(limit=limit, unseen_only=bool(unseen_only))}


@router.post("/api/eingang/scan-mail")
async def eingang_scan_mail(payload: dict = Body(default={})):
    """Manueller Mail-Scan. Throttle gilt nicht — sofortiger Lauf."""
    import eingang as _eingang
    limit = int(payload.get("limit") or 50)
    return _eingang.scan_mail(limit=limit)


@router.post("/api/eingang/seen")
async def eingang_seen(payload: dict = Body(...)):
    """Markiert Events als gesehen.
    Body: {event_ids: [..]} oder {section: "fokus"|"leads"|"workshops"} oder {all: true}.
    """
    import eingang as _eingang
    return _eingang.mark_seen(
        event_ids=payload.get("event_ids"),
        section=payload.get("section"),
        all_flag=bool(payload.get("all")),
    )


# ── Pulses / Heartbeat ────────────────────────────────────────────────
@router.get("/api/pulses")
async def pulses_snapshot():
    """Status aller Heartbeat-Pulses für die UI-Statusleiste."""
    import pulses as _pulses
    _pulses.register_defaults()
    return {"pulses": _pulses.snapshot()}


@router.post("/api/pulses/run")
async def pulses_run():
    """Manueller Tick. Führt fällige Pulses synchron aus. Für Debug/UI-Button."""
    import pulses as _pulses
    _pulses.register_defaults()
    return _pulses.run_due()


@router.get("/api/automation")
async def automation_overview():
    """Aggregiert pulses + workers + hooks + tasks für den Automation-Tab.

    pulses/workers/hooks kommen aus Code-Registries. tasks listet die Ordner
    unter jobs/<slug>/data/ und zeigt die jüngste Datei pro Slug.
    """
    import pulses as _pulses
    _pulses.register_defaults()
    pulse_rows = _pulses.snapshot()

    import automation_registry as _ar
    workers = _ar.snapshot("worker")
    hooks = _ar.snapshot("hook")

    from pathlib import Path
    import time as _time
    repo = Path(__file__).resolve().parent.parent.parent
    jobs_dir = repo / "jobs"
    tasks: list[dict] = []
    if jobs_dir.exists():
        for slug_dir in sorted(jobs_dir.iterdir()):
            if not slug_dir.is_dir() or slug_dir.name.startswith("_"):
                continue
            data_dir = slug_dir / "data"
            if not data_dir.exists():
                continue
            # .meta.json ist Begleit-Datei zum eigentlichen Output (.md/.txt) — die zeigen wir nicht.
            files = [
                f for f in data_dir.iterdir()
                if f.is_file() and not f.name.startswith(".") and not f.name.endswith(".meta.json")
            ]
            if not files:
                tasks.append({
                    "name": slug_dir.name,
                    "label": slug_dir.name,
                    "internal_name": slug_dir.name,
                    "last_run": None, "age_sec": None,
                    "last_status": "unknown", "last_message": "",
                    "color": "gray", "fail_streak": 0,
                    "last_file": None,
                })
                continue
            newest = max(files, key=lambda p: p.stat().st_mtime)
            mtime = newest.stat().st_mtime
            age = int(_time.time() - mtime)
            tasks.append({
                "name": slug_dir.name,
                "label": slug_dir.name,
                "internal_name": slug_dir.name,
                "last_run": mtime, "age_sec": age,
                "last_status": "ok", "last_message": newest.name,
                "color": "green" if age < 36 * 3600 else "gray",
                "fail_streak": 0,
                "last_file": str(newest.relative_to(repo)),
            })

    try:
        import workflows as _workflows
        workflow_rows = _workflows.recent_runs(limit=5)
    except Exception:
        workflow_rows = []

    return {
        "pulses": pulse_rows,
        "workers": workers,
        "hooks": hooks,
        "tasks": tasks,
        "workflows": workflow_rows,
    }


@router.get("/api/workflows/runs")
async def workflow_runs(limit: int = 30, workflow_key: str = ""):
    import workflows as _workflows
    return {
        "runs": _workflows.recent_runs(
            limit=limit,
            workflow_key=workflow_key.strip() or None,
        )
    }


# ── Klaus-Channel (proaktiver Faden) ──────────────────────────────────
@router.post("/api/klaus-channel/post")
async def klaus_channel_post(payload: dict = Body(...)):
    """Postet eine Nachricht in den Klaus-Channel.

    Body: {text?: str, variants?: [str], source: str, dedupe_key?: str, force?: bool, cooldown_sec?: int}

    Geht durch Dedup + Rate-Limit + Cooldown (siehe klaus_channel.py). Broadcastet
    bei Erfolg per SSE, damit offene Frontends den Channel sofort orange ziehen.
    """
    from modules import klaus_channel as _kc
    text = str(payload.get("text") or "").strip()
    variants = payload.get("variants")
    if isinstance(variants, list) and variants:
        variants = [str(v) for v in variants if str(v).strip()]
    else:
        variants = None
    source = str(payload.get("source") or "unknown")
    dedupe_key = payload.get("dedupe_key")
    force = bool(payload.get("force"))
    cooldown_sec = payload.get("cooldown_sec")
    if cooldown_sec is not None:
        try:
            cooldown_sec = int(cooldown_sec)
        except (TypeError, ValueError):
            cooldown_sec = None
    if not text and not variants:
        return JSONResponse({"posted": False, "reason": "leerer Text"}, status_code=400)
    result = _kc.post(
        text=text or None,
        source=source,
        dedupe_key=dedupe_key,
        force=force,
        variants=variants,
        cooldown_sec=cooldown_sec,
    )
    if result.get("posted"):
        try:
            from streaming import broadcast_sync
            await broadcast_sync(_kc.KLAUS_CHANNEL_AGENT, _kc.KLAUS_CHANNEL_ID)
        except Exception as e:
            print(f"[klaus-channel] broadcast_sync failed: {e}", flush=True)
    return JSONResponse(result)


@router.post("/api/learning-curator/decide")
async def learning_curator_decide(payload: dict = Body(...)):
    """Nimmt Learning-Curator-Vorschläge an oder lehnt sie ab.

    Body: {source_run_ids: [str], action: "accept"|"reject", message_id?: int}
    """
    from modules import klaus_channel as _kc
    raw_ids = payload.get("source_run_ids") or payload.get("source_run_id") or []
    if isinstance(raw_ids, str):
        source_run_ids = [raw_ids]
    elif isinstance(raw_ids, list):
        source_run_ids = [str(x) for x in raw_ids]
    else:
        source_run_ids = []
    message_id = payload.get("message_id")
    try:
        message_id = int(message_id) if message_id else None
    except (TypeError, ValueError):
        message_id = None
    result = _kc.decide_learning_proposals(
        source_run_ids=source_run_ids,
        action=str(payload.get("action") or ""),
        message_id=message_id,
    )
    if not result.get("ok"):
        return JSONResponse(result, status_code=400)
    if result.get("changed"):
        try:
            from streaming import broadcast_sync
            await broadcast_sync(_kc.KLAUS_CHANNEL_AGENT, _kc.KLAUS_CHANNEL_ID)
        except Exception as e:
            print(f"[learning-curator] broadcast_sync failed: {e}", flush=True)
    return JSONResponse(result)
