"""Performance router: Mobile-Performance-Telemetrie für die mobile Hülle.

Extrahiert aus server.py als weiterer Schnitt der Modularisierung. KEIN
Verhalten geändert, nur verschoben. Routen-Pfade bleiben byte-identisch.

Routen:
- POST /api/mobile-perf          — einzelnes Telemetrie-Sample nach
  data/mobile-perf.jsonl anhängen
- GET  /api/mobile-perf/summary  — Samples der letzten N Minuten zu
  Bereichs-/Routen-Buckets aggregieren

Die Helper (_merge_mobile_perf_bucket, _finalize_mobile_perf_bucket,
_new_mobile_perf_summary_bucket, _add_mobile_perf_row,
_finalize_mobile_perf_summary_bucket) werden ausschließlich von diesen beiden
Routen genutzt (per grep über die ganze server.py verifiziert) und sind
deshalb komplett mitgewandert.

Der Pfad zu data/mobile-perf.jsonl liegt unter dem Projekt-Root, identisch
zur ursprünglichen Auflösung in server.py.
"""

import json
import time
from pathlib import Path

from fastapi import APIRouter, Body, Query

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
_PROJECT_ROOT = _BACKEND_ROOT.parent

router = APIRouter()


@router.post("/api/mobile-perf")
async def mobile_perf(payload: dict = Body(default_factory=dict)):
    data_dir = _PROJECT_ROOT / "data"
    data_dir.mkdir(exist_ok=True)
    sample = {
        "received_at": int(time.time() * 1000),
        "ts": payload.get("ts"),
        "clientKind": str(payload.get("clientKind") or "unknown")[:32],
        "path": payload.get("path"),
        "hidden": bool(payload.get("hidden")),
        "event": payload.get("event"),
        "durationMs": payload.get("durationMs"),
        "ok": payload.get("ok"),
        "reason": payload.get("reason"),
        "reusedStream": payload.get("reusedStream"),
        "maxDriftMs": payload.get("maxDriftMs"),
        "longTaskCount": payload.get("longTaskCount"),
        "longTaskMs": payload.get("longTaskMs"),
        "heapUsedMb": payload.get("heapUsedMb"),
        "areas": payload.get("areas") if isinstance(payload.get("areas"), dict) else {},
        "routes": payload.get("routes") if isinstance(payload.get("routes"), dict) else {},
    }
    with (data_dir / "mobile-perf.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(sample, ensure_ascii=False) + "\n")
    return {"ok": True}


def _merge_mobile_perf_bucket(target: dict, source: dict):
    if not isinstance(source, dict):
        return
    for key, raw in source.items():
        if not isinstance(raw, dict):
            continue
        name = str(key)[:160]
        cur = target.setdefault(name, {"count": 0, "ok": 0, "error": 0, "totalMs": 0, "maxMs": 0})
        count = int(raw.get("count") or 0)
        ok = int(raw.get("ok") or 0)
        error = int(raw.get("error") or 0)
        total = float(raw.get("totalMs") or 0)
        max_ms = float(raw.get("maxMs") or 0)
        cur["count"] += count
        cur["ok"] += ok
        cur["error"] += error
        cur["totalMs"] += total
        cur["maxMs"] = max(cur["maxMs"], max_ms)


def _finalize_mobile_perf_bucket(bucket: dict, limit: int = 20):
    rows = []
    for key, value in bucket.items():
        count = int(value.get("count") or 0)
        total = float(value.get("totalMs") or 0)
        rows.append({
            "name": key,
            "count": count,
            "ok": int(value.get("ok") or 0),
            "error": int(value.get("error") or 0),
            "totalMs": round(total),
            "avgMs": round(total / max(1, count)),
            "maxMs": round(float(value.get("maxMs") or 0)),
        })
    rows.sort(key=lambda r: (r["totalMs"], r["count"]), reverse=True)
    return rows[:limit]


def _new_mobile_perf_summary_bucket():
    return {
        "areas": {},
        "routes": {},
        "events": {},
        "samples": 0,
        "maxDriftMs": 0,
        "longTaskCount": 0,
        "longTaskMs": 0,
        "latestAt": 0,
    }


def _add_mobile_perf_row(bucket: dict, row: dict, ts: int):
    bucket["samples"] += 1
    bucket["latestAt"] = max(int(bucket.get("latestAt") or 0), ts)
    bucket["maxDriftMs"] = max(int(bucket.get("maxDriftMs") or 0), int(row.get("maxDriftMs") or 0))
    bucket["longTaskCount"] += int(row.get("longTaskCount") or 0)
    bucket["longTaskMs"] += int(row.get("longTaskMs") or 0)
    event = row.get("event")
    if event:
        events = bucket["events"]
        events[str(event)] = events.get(str(event), 0) + 1
    _merge_mobile_perf_bucket(bucket["areas"], row.get("areas") or {})
    _merge_mobile_perf_bucket(bucket["routes"], row.get("routes") or {})


def _finalize_mobile_perf_summary_bucket(bucket: dict):
    return {
        "samples": bucket["samples"],
        "latestAt": bucket["latestAt"],
        "maxDriftMs": bucket["maxDriftMs"],
        "longTaskCount": bucket["longTaskCount"],
        "longTaskMs": bucket["longTaskMs"],
        "areas": _finalize_mobile_perf_bucket(bucket["areas"], 12),
        "routes": _finalize_mobile_perf_bucket(bucket["routes"], 20),
        "events": bucket["events"],
    }


@router.get("/api/mobile-perf/summary")
async def mobile_perf_summary(minutes: int = Query(default=15, ge=1, le=240)):
    path = _PROJECT_ROOT / "data" / "mobile-perf.jsonl"
    since = int((time.time() - minutes * 60) * 1000)
    total = _new_mobile_perf_summary_bucket()
    clients: dict[str, dict] = {}
    if path.exists():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()[-2000:]
        except Exception:
            lines = []
        for line in lines:
            try:
                row = json.loads(line)
            except Exception:
                continue
            ts = int(row.get("received_at") or row.get("ts") or 0)
            if ts < since:
                continue
            client_kind = str(row.get("clientKind") or "unknown")[:32]
            _add_mobile_perf_row(total, row, ts)
            _add_mobile_perf_row(clients.setdefault(client_kind, _new_mobile_perf_summary_bucket()), row, ts)
    return {
        "minutes": minutes,
        **_finalize_mobile_perf_summary_bucket(total),
        "clients": {k: _finalize_mobile_perf_summary_bucket(v) for k, v in sorted(clients.items())},
    }
