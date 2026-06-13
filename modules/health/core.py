"""Health-Pane — Klaus-eigenes Health-Log (food/training/peptide/mood/notiz).

Vorher: ~280 Zeilen in `backend/server.py` (2558-2794 + 2870-2907). Jetzt isoliert.

Cross-Deps:
- `from db import run_claude_cli` (Verdichtung via Haiku)
- `from auth import client_ip_trusted` (Trust-Check fuer Health-Export-Ingest)

Routen:
- GET  /api/health/state         Heutige Zahlen + Eintraege + Briefing
- POST /api/health/log           Eintrag anhaengen (verdichtet via Claude wenn ohne kind)
- POST /api/health-export        Auto-Auto-Sleep-Cycle-Ingest aus Health-Export-App
"""
from __future__ import annotations

import json
import hashlib
import math
import re as _re
import sqlite3
import statistics
import subprocess
import sys
import time
from datetime import datetime, date, timedelta, time as dt_time
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

# backend/ in sys.path damit `from db import …` / `from auth import …` aus modules/ klappt
_REPO_ROOT = Path(__file__).parent.parent.parent
_BACKEND_DIR = _REPO_ROOT / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from db import run_claude_cli, get_db  # noqa: E402
from auth import client_ip_trusted  # noqa: E402


PROJECT_ROOT = _REPO_ROOT
HEALTH_DIR = PROJECT_ROOT / "jobs" / "health"
HEALTH_LOG_DIR = HEALTH_DIR / "log"
HEALTH_LOG_DIR.mkdir(parents=True, exist_ok=True)
HEALTH_BASELINE_DIR = HEALTH_DIR / "baselines"
HEALTH_DATA_DIR = PROJECT_ROOT / "data" / "health"
HEALTH_CORRECTIONS_PATH = HEALTH_DATA_DIR / "manual-corrections.json"
PEOPLE_DB = PROJECT_ROOT / "data" / "people.db"
HEALTH_TZ = ZoneInfo("Europe/Berlin")


HEALTH_KIND_KEYWORDS = [
    ("caffeine", ["koffein", "kaffee", "espresso", "cappuccino", "latte", "energy", "red bull",
                  "monster", "booster", "preworkout", "pre workout", "stimulanz", "stims",
                  "doping"]),
    ("training", ["gym", "training", "satz", "sätze", "saetze", "kg ", "kg,", "rep", "wiederholung",
                  "bank", "kniebeuge", "rudern", "kreuzheben", "klimmzug", "cardio", "laufen",
                  "schwimm", "rad ", "sprint", "deadlift", "squat", "press", "curl"]),
    ("food",     ["gegessen", "mahlzeit", "shake", "gramm ", " g ", " kcal", "frühstück", "fruehstueck",
                  "mittag", "abend", "snack", "kohlenhydrat", "eiweiß", "eiweiss", "protein",
                  "obst", "gemüse", "huhn", "hähnchen", "fisch", "ei ", "eier", "reis", "haferflock"]),
    ("peptide",  ["reta", "retatrutide", "peptid", " mg", "dosis", "injektion", "übel", "uebel",
                  "magen", "ozempic", "wegovy", "tirzep", "semaglutid"]),
    ("mood",     ["stimmung", "energie", "müde", "muede", "fit ", "schlapp", "leer", "belastbar",
                  "mittagstief", "gefühl", "gefuehl", "fokus", "drive", "kopf "]),
]

HEALTH_KIND_ORDER = ["caffeine", "food", "training", "peptide", "mood", "notiz"]


router = APIRouter()


def _health_classify(text: str) -> str:
    """Klassifiziert einen Log-Eintrag in eine Kategorie. Heuristik, kein LLM."""
    t = text.strip().lower()
    for kind in HEALTH_KIND_ORDER:
        if t.startswith(f"{kind}:") or t.startswith(f"{kind} :"):
            return kind
    if "leer" in t or "belastbar" in t:
        return "mood"
    if "mittagstief" in t and not any(kw in t for kw in ("booster", "preworkout", "pre workout", "energy")):
        return "mood"
    for kind, keywords in HEALTH_KIND_KEYWORDS:
        for kw in keywords:
            if kw in t:
                return kind
    return "notiz"


def _health_today_path() -> Path:
    today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    return HEALTH_LOG_DIR / f"{today}.md"


def _health_parse_log(path: Path) -> list[dict]:
    """Liest eine log/YYYY-MM-DD.md und gibt Einträge als {kind, time, text} zurück."""
    if not path.exists():
        return []
    entries: list[dict] = []
    current_kind = "notiz"
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip()
        if line.startswith("## "):
            current_kind = line[3:].strip().lower() or "notiz"
            continue
        if line.startswith("- "):
            body = line[2:].strip()
            m = _re.match(r"^(\d{1,2}:\d{2})\s*[—–-]\s*(.+)$", body)
            if m:
                entries.append({"kind": current_kind, "time": m.group(1), "text": m.group(2)})
            else:
                entries.append({"kind": current_kind, "time": "", "text": body})
    return entries


def _health_briefing_summary() -> dict:
    """Zieht ein paar Kennzahlen aus dem heutigen Briefing für den Section-Header."""
    today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    path = HEALTH_DIR / "data" / f"{today}-health.md"
    if not path.exists():
        candidates = sorted((HEALTH_DIR / "data").glob("*-health.md"), reverse=True)
        if not candidates:
            return {"available": False, "date": today}
        path = candidates[0]
    txt = path.read_text(encoding="utf-8")
    file_date = path.stem.replace("-health", "")
    summary: dict = {"available": True, "date": file_date, "stale": file_date != today}
    m = _re.search(r"Dauer\s+([0-9]+h?[0-9]*)", txt)
    if m: summary["sleep"] = m.group(1)
    m = _re.search(r"HRV\s+(\d+)\s*ms", txt)
    if m: summary["hrv"] = int(m.group(1))
    m = _re.search(r"Ruhepuls\s+(\d+)", txt)
    if m: summary["rhr"] = int(m.group(1))
    m = _re.search(r"##\s+Empfehlung heute\s*\n\*\*([^*]+)\*\*", txt)
    if m: summary["recommendation"] = m.group(1).strip()
    return summary


def _clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> float:
    if math.isnan(value):
        return lo
    return max(lo, min(hi, value))


def _mean(values: list[float]) -> float | None:
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return None
    return sum(clean) / len(clean)


def _median(values: list[float]) -> float | None:
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return None
    return float(statistics.median(clean))


def _stdev(values: list[float], fallback: float = 1.0) -> float:
    clean = [float(v) for v in values if v is not None]
    if len(clean) < 3:
        return fallback
    sd = float(statistics.pstdev(clean))
    return sd if sd > 0.01 else fallback


def _to_float(value) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except Exception:
        return None


def _parse_health_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    s = str(value).strip()
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=HEALTH_TZ)
        return dt.astimezone(HEALTH_TZ)
    except Exception:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(s[:25] if "%z" in fmt else s[:19], fmt)
            if dt.tzinfo is None:
                return dt.replace(tzinfo=HEALTH_TZ)
            return dt.astimezone(HEALTH_TZ)
        except Exception:
            continue
    return None


def _row_dt(row: dict, *keys: str) -> datetime | None:
    for key in keys:
        dt = _parse_health_dt(row.get(key))
        if dt:
            return dt
    return None


def _manual_correction(day_iso: str) -> dict:
    if not HEALTH_CORRECTIONS_PATH.exists():
        return {}
    try:
        data = json.loads(HEALTH_CORRECTIONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    correction = data.get(day_iso) if isinstance(data, dict) else None
    return correction if isinstance(correction, dict) else {}


def _apply_sleep_correction(feature: dict, day_iso: str, sleep_start: datetime | None, sleep_end: datetime | None) -> tuple[datetime | None, datetime | None]:
    correction = _manual_correction(day_iso).get("sleep")
    if not isinstance(correction, dict):
        return sleep_start, sleep_end

    corrected_start = _parse_health_dt(correction.get("start")) or sleep_start
    corrected_end = _parse_health_dt(correction.get("end")) or sleep_end
    corrected_hours = _to_float(correction.get("hours"))
    if corrected_hours is None and corrected_start and corrected_end:
        corrected_hours = max(0.0, (corrected_end - corrected_start).total_seconds() / 3600.0)
    if corrected_hours is None:
        return sleep_start, sleep_end

    feature.update({
        "sleep_raw_hours": feature.get("sleep_hours"),
        "sleep_raw_start": feature.get("sleep_start") or "",
        "sleep_raw_end": feature.get("sleep_end") or "",
        "sleep_hours": corrected_hours,
        "sleep_start": corrected_start.isoformat() if corrected_start else "",
        "sleep_end": corrected_end.isoformat() if corrected_end else "",
        "sleep_source": "manual_correction",
        "sleep_correction_note": str(correction.get("note") or ""),
    })
    stage_keys = {
        "deep_hours": "sleep_deep_hours",
        "rem_hours": "sleep_rem_hours",
        "core_hours": "sleep_core_hours",
        "awake_hours": "sleep_awake_hours",
    }
    for correction_key, feature_key in stage_keys.items():
        corrected_stage = _to_float(correction.get(correction_key))
        if corrected_stage is not None:
            feature[f"{feature_key}_raw"] = feature.get(feature_key)
            feature[feature_key] = corrected_stage
    if corrected_start and corrected_end:
        midpoint = corrected_start + (corrected_end - corrected_start) / 2
        feature["sleep_midpoint_min"] = midpoint.hour * 60 + midpoint.minute
    return corrected_start, corrected_end


def _latest_snapshot_path(day_iso: str) -> Path | None:
    day_dir = HEALTH_DATA_DIR / day_iso
    if not day_dir.exists():
        return None
    files = sorted(day_dir.glob("*.json"))
    return files[-1] if files else None


def _snapshot_mtime_iso(path: str | Path | None) -> str:
    if not path:
        return ""
    try:
        p = Path(path)
        return datetime.fromtimestamp(p.stat().st_mtime, HEALTH_TZ).isoformat()
    except OSError:
        return ""


def _snapshot_paths(day_iso: str) -> list[Path]:
    day_dir = HEALTH_DATA_DIR / day_iso
    if not day_dir.exists():
        return []
    return sorted(day_dir.glob("*.json"))


def _load_snapshot(path: Path | None) -> dict:
    if not path:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _metric_rows(snapshot: dict, name: str) -> tuple[list[dict], str]:
    metrics = (snapshot.get("data") or {}).get("metrics") or []
    for metric in metrics:
        if metric.get("name") == name:
            rows = metric.get("data") or []
            return (rows if isinstance(rows, list) else []), str(metric.get("units") or "")
    return [], ""


def _metric_rows_from_paths(paths: list[Path], name: str) -> tuple[list[dict], str]:
    rows: list[dict] = []
    units = ""
    seen: set[tuple[str, str, str]] = set()
    for path in paths:
        metric_rows, metric_units = _metric_rows(_load_snapshot(path), name)
        if metric_units and not units:
            units = metric_units
        for row in metric_rows:
            key = (
                str(row.get("date") or row.get("start") or ""),
                str(row.get("source") or ""),
                str(row.get("qty") or row.get("value") or ""),
            )
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows, units


def _has_metric_rows(snapshot: dict) -> bool:
    metrics = (snapshot.get("data") or {}).get("metrics") or []
    return any(isinstance(metric.get("data"), list) and metric.get("data") for metric in metrics)


def _latest_metric_snapshot_path(day_iso: str) -> Path | None:
    for path in reversed(_snapshot_paths(day_iso)):
        if _has_metric_rows(_load_snapshot(path)):
            return path
    return None


def _workout_rows(snapshot: dict) -> list[dict]:
    rows = (snapshot.get("data") or {}).get("workouts") or snapshot.get("workouts") or []
    return rows if isinstance(rows, list) else []


def _qty_value(value) -> float | None:
    if isinstance(value, dict):
        return _to_float(value.get("qty"))
    return _to_float(value)


def _qty_kcal(value) -> float:
    if not isinstance(value, dict):
        return _to_float(value) or 0.0
    qty = _to_float(value.get("qty")) or 0.0
    units = str(value.get("units") or "").lower()
    return qty / 4.184 if units == "kj" else qty


def _workout_summary(day_iso: str, paths: list[Path]) -> dict:
    workouts: list[dict] = []
    seen: set[str] = set()
    for path in paths:
        snapshot = _load_snapshot(path)
        for row in _workout_rows(snapshot):
            start = _row_dt(row, "start")
            end = _row_dt(row, "end")
            day_dt = end or start
            if not day_dt or day_dt.strftime("%Y-%m-%d") != day_iso:
                continue
            key = str(row.get("id") or f"{row.get('name')}|{row.get('start')}|{row.get('end')}")
            if key in seen:
                continue
            seen.add(key)
            duration_min = (_to_float(row.get("duration")) or 0.0) / 60.0
            steps = _sum_qty(row.get("stepCount") or []) if isinstance(row.get("stepCount"), list) else _qty_value(row.get("stepCount"))
            workouts.append({
                "name": str(row.get("name") or "Training"),
                "start": start.isoformat() if start else "",
                "end": end.isoformat() if end else "",
                "duration_min": round(duration_min, 1),
                "active_kcal": round(_qty_kcal(row.get("activeEnergyBurned"))),
                "avg_hr": round(_qty_value(row.get("avgHeartRate")) or 0),
                "max_hr": round(_qty_value(row.get("maxHeartRate")) or 0),
                "intensity": round(_qty_value(row.get("intensity")) or 0.0, 2),
                "steps": round(steps or 0),
                "source": str(path),
            })
    workouts.sort(key=lambda w: w.get("start") or "")
    return {
        "workouts": workouts,
        "workout_count": len(workouts),
        "workout_min": round(sum(float(w.get("duration_min") or 0.0) for w in workouts), 1),
        "workout_active_kcal": round(sum(float(w.get("active_kcal") or 0.0) for w in workouts)),
        "workout_steps": round(sum(float(w.get("steps") or 0.0) for w in workouts)),
    }


def _rows_in_day(rows: list[dict], day_iso: str, key: str = "date") -> list[dict]:
    out: list[dict] = []
    for row in rows:
        dt = _row_dt(row, key)
        if dt and dt.strftime("%Y-%m-%d") == day_iso:
            out.append(row)
    return out


def _rows_between(rows: list[dict], start: datetime | None, end: datetime | None) -> list[dict]:
    if not start or not end:
        return []
    out: list[dict] = []
    for row in rows:
        dt = _row_dt(row, "date")
        if dt and start <= dt <= end:
            out.append(row)
    return out


def _sum_qty(rows: list[dict]) -> float | None:
    vals = [_to_float(r.get("qty")) for r in rows]
    vals = [v for v in vals if v is not None]
    return sum(vals) if vals else None


def _avg_qty(rows: list[dict]) -> float | None:
    vals = [_to_float(r.get("qty")) for r in rows]
    return _mean([v for v in vals if v is not None])


def _date_dirs(limit: int = 90) -> list[str]:
    if not HEALTH_DATA_DIR.exists():
        return []
    days = [p.name for p in HEALTH_DATA_DIR.iterdir() if p.is_dir() and _re.match(r"^\d{4}-\d{2}-\d{2}$", p.name)]
    return sorted(days)[-limit:]


def _daily_feature(day_iso: str) -> dict:
    paths = _snapshot_paths(day_iso)
    latest_path = paths[-1] if paths else None
    metric_path = _latest_metric_snapshot_path(day_iso)
    snapshot = _load_snapshot(metric_path)
    workout_summary = _workout_summary(day_iso, paths)
    feature: dict = {
        "date": day_iso,
        "snapshot": str(latest_path) if latest_path else "",
        "metric_snapshot": str(metric_path) if metric_path else "",
        "has_data": bool(snapshot) or bool(workout_summary["workout_count"]),
    }

    sleep_candidates: list[dict] = []
    # AutoExport liefert tagsüber oft Snapshots ohne Schlafdaten. Schlaf ist
    # rückwirkend stabiler, deshalb alle Tages-Snapshots prüfen und den
    # vollständigsten Schlafblock für diesen Tag nehmen.
    sleep_paths = list(reversed(paths))
    for sleep_path in sleep_paths:
        sleep_snapshot = _load_snapshot(sleep_path)
        sleep_rows, _ = _metric_rows(sleep_snapshot, "sleep_analysis")
        for row in sleep_rows:
            end = _row_dt(row, "sleepEnd", "inBedEnd", "date")
            if end and end.strftime("%Y-%m-%d") == day_iso:
                sleep_candidates.append(row)
    sleep_row = max(sleep_candidates, key=lambda r: _to_float(r.get("totalSleep")) or 0.0) if sleep_candidates else None
    if sleep_row:
        sleep_start = _row_dt(sleep_row, "sleepStart", "inBedStart")
        sleep_end = _row_dt(sleep_row, "sleepEnd", "inBedEnd")
        feature.update({
            "sleep_hours": _to_float(sleep_row.get("totalSleep")),
            "sleep_deep_hours": _to_float(sleep_row.get("deep")),
            "sleep_rem_hours": _to_float(sleep_row.get("rem")),
            "sleep_core_hours": _to_float(sleep_row.get("core")),
            "sleep_awake_hours": _to_float(sleep_row.get("awake")) or 0.0,
            "sleep_start": sleep_start.isoformat() if sleep_start else "",
            "sleep_end": sleep_end.isoformat() if sleep_end else "",
        })
        if sleep_start and sleep_end:
            midpoint = sleep_start + (sleep_end - sleep_start) / 2
            feature["sleep_midpoint_min"] = midpoint.hour * 60 + midpoint.minute
    else:
        sleep_start = sleep_end = None

    sleep_start, sleep_end = _apply_sleep_correction(feature, day_iso, sleep_start, sleep_end)

    hrv_rows, _ = _metric_rows(snapshot, "heart_rate_variability")
    hrv_window = _rows_between(hrv_rows, sleep_start, sleep_end + timedelta(hours=2) if sleep_end else None)
    hrv_day = _rows_in_day(hrv_rows, day_iso)
    feature["hrv_ms"] = _avg_qty(hrv_window or hrv_day)

    rhr_rows, _ = _metric_rows(snapshot, "resting_heart_rate")
    rhr_day = _rows_in_day(rhr_rows, day_iso)
    feature["resting_hr"] = _avg_qty(rhr_day)

    resp_rows, _ = _metric_rows(snapshot, "respiratory_rate")
    resp_window = _rows_between(resp_rows, sleep_start, sleep_end) if sleep_start and sleep_end else []
    feature["respiratory_rate"] = _avg_qty(resp_window or _rows_in_day(resp_rows, day_iso))

    temp_rows, _ = _metric_rows(snapshot, "apple_sleeping_wrist_temperature")
    temp_window = _rows_between(temp_rows, sleep_start, sleep_end) if sleep_start and sleep_end else []
    feature["wrist_temp"] = _avg_qty(temp_window or _rows_in_day(temp_rows, day_iso))

    oxy_rows, _ = _metric_rows(snapshot, "blood_oxygen_saturation")
    oxy_window = _rows_between(oxy_rows, sleep_start, sleep_end) if sleep_start and sleep_end else []
    feature["spo2"] = _avg_qty(oxy_window or _rows_in_day(oxy_rows, day_iso))

    steps_rows, _ = _metric_rows_from_paths(paths, "step_count")
    daily_steps = _sum_qty(_rows_in_day(steps_rows, day_iso))
    feature["steps"] = round(daily_steps) if daily_steps is not None else None
    feature["steps_source"] = "step_count" if daily_steps is not None else "missing"
    feature["steps_export_rows"] = len(_rows_in_day(steps_rows, day_iso))
    feature["steps_workout_fallback"] = round(float(workout_summary["workout_steps"] or 0.0))

    exercise_rows, _ = _metric_rows_from_paths(paths, "apple_exercise_time")
    daily_exercise = _sum_qty(_rows_in_day(exercise_rows, day_iso)) or 0.0
    feature["exercise_min"] = max(daily_exercise, float(workout_summary["workout_min"] or 0.0))

    active_rows, active_units = _metric_rows_from_paths(paths, "active_energy")
    active = _sum_qty(_rows_in_day(active_rows, day_iso)) or 0.0
    if active_units.lower() == "kj":
        active = active / 4.184
    feature["active_kcal"] = max(active, float(workout_summary["workout_active_kcal"] or 0.0))

    effort_rows, _ = _metric_rows_from_paths(paths, "physical_effort")
    feature["physical_effort"] = _avg_qty(_rows_in_day(effort_rows, day_iso))
    feature.update(workout_summary)
    feature["training_strain"] = _training_strain(feature)
    # Backwards-compatible name for older score files; steps are intentionally
    # not part of hard training load anymore.
    feature["cardio_load"] = feature["training_strain"]
    feature["activity_score"] = _daily_activity_score(feature)
    return feature


def _score_from_z(value: float | None, baseline: list[float], higher_is_better: bool = True) -> tuple[float, float | None, float | None]:
    if value is None or len(baseline) < 5:
        return 50.0, None, None
    med = _median(baseline)
    sd = _stdev(baseline, fallback=max(abs(med or 1) * 0.15, 1.0))
    if med is None:
        return 50.0, None, None
    z = (value - med) / sd
    if not higher_is_better:
        z = -z
    return _clamp(50.0 + z * 15.0), med, sd


def _sleep_debt(history: list[dict], sleep_need: float) -> float:
    debt = 0.0
    for f in history[-14:]:
        hours = f.get("sleep_hours")
        if hours is None:
            continue
        debt += max(0.0, sleep_need - float(hours))
        debt -= max(0.0, float(hours) - sleep_need) * 0.7
        debt = max(0.0, debt)
    return debt


def _sleep_debt_pressure(debt: float) -> float:
    """Debt is a risk signal, not a fitness score. Cap its daily impact."""
    if debt <= 5.0:
        return debt
    return 5.0 + (debt - 5.0) * 0.35


def _sleep_need_for_tonight(base_need: float, debt: float, recovery: float, stress: float, load_ratio: float, current: dict) -> dict:
    debt_extra = min(0.8, max(0.0, debt) * 0.08)
    strain_extra = 0.0
    strain_extra += min(0.25, max(0.0, load_ratio - 1.0) * 0.30)
    strain_extra += min(0.25, float(current.get("exercise_min") or 0.0) / 180.0)
    recovery_extra = 0.25 if recovery < 50 else 0.10 if recovery < 65 else 0.0
    stress_extra = 0.15 if stress > 70 else 0.05 if stress > 55 else 0.0
    need = max(7.0, min(9.2, base_need + debt_extra + strain_extra + recovery_extra + stress_extra))
    return {
        "base_h": round(base_need, 1),
        "tonight_h": round(need, 1),
        "debt_extra_h": round(debt_extra, 1),
        "strain_extra_h": round(strain_extra, 1),
        "recovery_extra_h": round(recovery_extra + stress_extra, 1),
    }


def _activity_stress_relief(current: dict) -> float:
    """Moderate movement tends to buffer stress; keep the effect small."""
    steps = float(current.get("steps") or 0.0)
    relief = min(5.0, steps / 1000.0 * 0.7)
    relief += min(2.0, max(0.0, float(current.get("activity_score") or 0.0) - 55.0) * 0.05)
    return round(min(7.0, relief), 1)


def _daily_activity_score(current: dict) -> float:
    """Alltagsbewegung ist Erholung/Grundaktivität, keine harte Trainingslast."""
    steps = float(current.get("steps") or 0.0)
    exercise_min = float(current.get("exercise_min") or 0.0)
    score = 35.0 + min(40.0, steps / 8000.0 * 40.0) + min(15.0, exercise_min / 60.0 * 15.0)
    if steps > 16000:
        score -= min(15.0, (steps - 16000.0) / 1000.0 * 1.5)
    return round(_clamp(score), 1)


def _is_strength_workout(workout: dict) -> bool:
    name = str(workout.get("name") or "").lower()
    return any(token in name for token in ("kraft", "strength", "widerstand", "resistance"))


def _training_strain(current: dict) -> float:
    """Deterministische Reizpunkte: echte Workouts zuerst, Alltag nur als Fallback."""
    workouts = current.get("workouts") or []
    strain = 0.0
    for workout in workouts:
        minutes = float(workout.get("duration_min") or 0.0)
        kcal = float(workout.get("active_kcal") or 0.0)
        avg_hr = float(workout.get("avg_hr") or 0.0)
        max_hr = float(workout.get("max_hr") or 0.0)
        intensity = float(workout.get("intensity") or 0.0)
        is_strength = _is_strength_workout(workout)
        hr_factor = 1.0
        if is_strength:
            if avg_hr >= 145:
                hr_factor = 1.18
            elif avg_hr >= 125:
                hr_factor = 1.10
            elif avg_hr >= 105:
                hr_factor = 1.04
            peak_bonus = 4.0 if max_hr >= 160 else 2.0 if max_hr >= 145 else 0.0
            intensity_bonus = min(22.0, max(0.0, intensity) * 3.2)
        else:
            if avg_hr >= 145:
                hr_factor = 1.35
            elif avg_hr >= 125:
                hr_factor = 1.18
            elif avg_hr >= 105:
                hr_factor = 1.08
            peak_bonus = 8.0 if max_hr >= 160 else 4.0 if max_hr >= 145 else 0.0
            intensity_bonus = max(0.0, intensity) * 12.0
        strain += minutes * hr_factor + kcal / 12.0 + peak_bonus + intensity_bonus
    if strain > 0:
        return round(strain, 1)

    exercise_min = float(current.get("exercise_min") or 0.0)
    active_kcal = float(current.get("active_kcal") or 0.0)
    physical_effort = current.get("physical_effort")
    if exercise_min >= 20 or active_kcal >= 180:
        effort_factor = 1.0 + min(0.4, max(0.0, float(physical_effort or 0.0)) * 0.08)
        return round(exercise_min * effort_factor + active_kcal / 15.0, 1)
    return 0.0


def _strain_status(points: float) -> str:
    if points >= 160:
        return "hoch"
    if points >= 90:
        return "stark"
    if points >= 40:
        return "moderat"
    if points > 0:
        return "leicht"
    return "kein Reiz"


def _strain_display_score(points: float) -> float:
    """Visible 0-100 training dose scale; raw points stay in scores/raw_value."""
    return _clamp(float(points or 0.0) / 220.0 * 100.0)


def _data_quality(current: dict, day_iso: str) -> dict:
    has_sleep = current.get("sleep_hours") is not None
    has_hrv = current.get("hrv_ms") is not None
    has_rhr = current.get("resting_hr") is not None
    has_vitals = has_hrv and has_rhr
    has_activity = current.get("steps") is not None or current.get("active_kcal") is not None
    has_metrics = bool(current.get("metric_snapshot"))
    has_workout = bool(current.get("workout_count"))
    is_today = day_iso == datetime.now(HEALTH_TZ).strftime("%Y-%m-%d")

    missing: list[str] = []
    if not has_sleep:
        missing.append("Schlaf")
    if not has_hrv:
        missing.append("HRV")
    if not has_rhr:
        missing.append("Ruhepuls")
    if not has_activity:
        missing.append("Aktivität")

    if missing:
        label = "vorläufig"
        detail = f"Es fehlen noch: {', '.join(missing)}. Spätere Exporte dürfen die Scores korrigieren."
        confidence = 55 if len(missing) == 1 else 40
    elif is_today:
        label = "aktualisiert"
        extra = "Workout liegt vor." if has_workout else "Workout kann noch nachkommen."
        detail = f"Schlaf, Vitals und Aktivität liegen vor. {extra}"
        confidence = 85
    else:
        label = "stabil"
        detail = "Tag ist abgeschlossen; spätere Korrekturen sind unwahrscheinlich."
        confidence = 95

    return {
        "label": label,
        "detail": detail,
        "confidence": confidence,
        "has_metrics": has_metrics,
        "has_sleep": has_sleep,
        "has_vitals": has_vitals,
        "has_activity": has_activity,
        "has_workout": has_workout,
    }


def _coach_assessment(current: dict, scores: dict, load_balance: dict, lifestyle: dict | None = None) -> dict:
    """Deterministic coach layer: explains numbers without changing them."""
    strain = float(scores.get("training_strain") or 0.0)
    readiness = float(scores.get("readiness") or 0.0)
    body_battery = float(scores.get("body_battery") or 0.0)
    sleep_quality = float(scores.get("sleep_quality") or 0.0)
    activity = float(scores.get("activity_score") or 0.0)
    load_ratio = float(scores.get("load_ratio") or 1.0)

    if strain >= 70 and load_ratio < 0.9:
        label = "Trainingsreiz sitzt"
        detail = (
            f"Das Training zählt heute klar als echter Reiz: {round(strain)} Punkte Tagesreiz. "
            f"Die Wochenlast bleibt mit {load_ratio:.2f}× trotzdem unter deiner Basis, weil sie den 7-Tage-Schnitt gegen dein normales Pensum misst."
        )
    elif strain >= 70:
        label = "Reiz sitzt"
        detail = (
            f"Heute war mit {round(strain)} Punkten ein echter Trainingsreiz drin. "
            "Für den Rest des Tages zählt jetzt eher auffüllen: essen, runterfahren, Schlaf vorbereiten."
        )
    elif load_ratio < 0.85 and readiness >= 55:
        label = "Noch Luft für Reiz"
        detail = (
            f"Die Woche liegt mit {load_ratio:.2f}× noch unter deiner Basis, und die Bereitschaft trägt. "
            "Ein sauberer Reiz wäre sinnvoll, aber nicht als hektisches Nachholen."
        )
    elif body_battery < 40 and readiness < 50:
        label = "Zahlen bremsen"
        detail = (
            f"Nicht beschönigen: Körperakku {round(body_battery)}/100 und Bereitschaft {round(readiness)}/100 sind knapp. "
            "Leichte Bewegung kann helfen, hartes Nachlegen eher nicht."
        )
    else:
        label = "Stabil arbeiten"
        detail = (
            "Die Werte sprechen für einen stabilen, aber nicht grenzenlosen Tag. "
            "Halten, bewegen, sauber essen und den Abend nicht unnötig schwer machen."
        )

    facts: list[str] = []
    if strain > 0:
        facts.append(f"Tagesreiz {_strain_status(strain)}")
    facts.append(f"Wochenlast {load_balance.get('status', 'normal')}")
    if sleep_quality >= 80:
        facts.append("Schlaf stark")
    if activity >= 55:
        facts.append("Grundaktivität hilft")

    lifestyle = lifestyle or {}
    subjective = lifestyle.get("subjective") or {}
    caffeine = lifestyle.get("caffeine") or {}
    nutrition = lifestyle.get("nutrition") or {}
    rhythm = lifestyle.get("training_rhythm") or {}
    pulse = lifestyle.get("pulse") or {}
    context_notes: list[str] = []
    if subjective.get("low_energy"):
        context_notes.append("Dein Log sagt eher leer oder koffeingetrieben; das deckelt Volumen, auch wenn ein Reiz möglich ist.")
        facts.append("Gefühl leer")
    if caffeine.get("status") == "hoch":
        facts.append("Koffein hoch")
    if nutrition.get("status") == "Protein sicher":
        facts.append("Protein passt")
    if rhythm.get("status") in ("wieder dran", "lange Pause"):
        facts.append(rhythm.get("status"))
    if pulse.get("status") in ("erhöht", "hoch"):
        facts.append(f"Puls {pulse.get('status')}")
    if context_notes:
        detail = f"{detail} {' '.join(context_notes)}"

    return {
        "label": label,
        "detail": detail,
        "facts": facts[:5],
        "deterministic": True,
        "llm_role": "Klaus bewertet Kontext und Sprache, verändert aber keine Rohscores.",
    }


def _load_balance(load_ratio: float, readiness: float, recovery: float, body_battery: float, stress: float, debt: float, reta: dict) -> dict:
    ratio = max(0.0, float(load_ratio or 0.0))
    position = _clamp(((ratio - 0.4) / 1.2) * 100.0)
    can_overreach = (
        readiness >= 72
        and recovery >= 65
        and body_battery >= 50
        and stress < 65
        and debt <= 8
        and reta.get("days_since") not in (1, 2)
    )

    if ratio < 0.75:
        status = "unterreiz"
        direction = "links"
        detail = "Deutlich unter deiner Basis. Wenn Bereitschaft passt, ist Aufbau sinnvoll."
    elif ratio < 0.9:
        status = "leicht unter"
        direction = "links"
        detail = "Etwas unter deiner Basis. Ein sauberer Reiz passt, aber nicht aus Müdigkeit heraus."
    elif ratio <= 1.15:
        status = "Idealbereich"
        direction = "mitte"
        detail = "Nah an deiner normalen Belastung. Halten oder gezielt fein erhöhen."
    elif ratio <= 1.35:
        status = "Aufbaureiz"
        direction = "rechts"
        detail = "Über deiner eigenen 42-Tage-Basis, aber noch kontrolliert. Gute Zone für Progression."
    elif ratio <= 1.55:
        status = "rechts raus"
        direction = "rechts"
        detail = "Bewusst hohe Woche. Morgen eher verarbeiten als stapeln, außer Bereitschaft und Schlaf tragen klar."
    else:
        status = "sehr hohe Woche"
        direction = "rechts"
        detail = "Deutlich über deiner eigenen 42-Tage-Basis. Morgen zählt vor allem Erholung; weitere Last nur sehr bewusst."

    if ratio >= 1.35:
        mode = "Überreiz erlaubt" if can_overreach else "Last senken"
    elif ratio < 0.85 and readiness >= 55:
        mode = "Reiz aufbauen"
    elif readiness >= 70:
        mode = "Schwer trainieren"
    elif readiness < 45:
        mode = "Aufladen"
    else:
        mode = "Erhalten"

    score = _clamp(100.0 - abs(ratio - 1.0) * 95.0)
    return {
        "ratio": round(ratio, 3),
        "position": round(position, 1),
        "status": status,
        "direction": direction,
        "detail": detail,
        "score": round(score),
        "can_overreach": can_overreach,
        "mode": mode,
        "zones": {"low": 0.75, "ideal_min": 0.9, "ideal_max": 1.15, "build_max": 1.35, "overreach_max": 1.55},
    }


def _day_balance(readiness: float, recovery: float, body_battery: float, stress: float, debt: float, load_ratio: float, training_strain: float) -> dict:
    """Coach-facing balance ratio. Raw 0-100 scores stay unchanged."""
    load_delta = float(load_ratio or 1.0) - 1.0
    load_push = max(-0.08, min(0.30, load_delta * (0.25 if load_delta < 0 else 0.42)))
    strain_push = max(0.0, min(0.14, float(training_strain or 0.0) / 700.0))
    readiness_push = max(-0.06, min(0.08, (float(readiness or 0.0) - 55.0) * 0.002))
    recovery_push = max(-0.05, min(0.06, (float(recovery or 0.0) - 55.0) * 0.0015))
    battery_push = max(-0.06, min(0.06, (float(body_battery or 0.0) - 50.0) * 0.002))
    stress_push = max(-0.07, min(0.05, (55.0 - float(stress or 0.0)) * 0.0015))
    debt_penalty = max(0.0, min(0.09, (float(debt or 0.0) - 8.0) * 0.008))
    if body_battery >= 50 and recovery >= 50:
        debt_penalty = min(debt_penalty, 0.045)
    value = max(0.60, min(1.35, 1.0 + load_push + strain_push + readiness_push + recovery_push + battery_push + stress_push - debt_penalty))

    if value < 0.82:
        label = "unterversorgt"
        zone = "low"
        detail = "Der Körper wirkt eher leer oder gebremst. Bewegung ja, harter Reiz nur sehr bewusst."
    elif value < 0.92:
        label = "leicht unter"
        zone = "low"
        detail = "Noch nicht ganz in der Mitte. Das ist kein schlechter Tag, eher Luft für einen sauberen Reiz."
    elif value <= 1.08:
        label = "im Einklang"
        zone = "ideal"
        detail = "Belastung und Erholung liegen nah an der Mitte. Das ist ein guter Arbeitstag für Körper und Kopf."
    elif value <= 1.18:
        label = "Aufbau"
        zone = "build"
        detail = "Reiz ist sichtbar und noch konstruktiv. Fortschritt ja, aber nicht unnötig stapeln."
    elif value <= 1.28:
        label = "hohe Last"
        zone = "high"
        detail = "Der Tag ist rechts der Mitte. Das kann Aufbau sein, braucht danach Essen, Ruhe und Schlaf."
    else:
        label = "Überreiz"
        zone = "over"
        detail = "Deutlich rechts der Mitte. Weitere Last nur, wenn sie wirklich geplant ist."

    return {
        "value": round(value, 2),
        "label": label,
        "zone": zone,
        "detail": detail,
        "anchors": {"low": 0.8, "ideal": 1.0, "build": 1.15, "over": 1.25},
    }


def _time_label(total_min: int) -> str:
    total_min = total_min % 1440
    return f"{total_min // 60:02d}:{total_min % 60:02d}"


def _time_label_dt(value: datetime) -> str:
    return value.astimezone(HEALTH_TZ).strftime("%H:%M")


def _hours_label(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def _tonight_obligations(wake_day: date) -> list[dict]:
    obligations: list[dict] = []
    day_iso = wake_day.isoformat()

    try:
        with get_db() as db:
            rows = db.execute(
                """
                SELECT start_iso, title
                FROM calendar_events
                WHERE substr(start_iso, 1, 10) = ?
                  AND COALESCE(all_day, 0) = 0
                  AND COALESCE(status, 'active') NOT LIKE 'cancelled%'
                ORDER BY start_iso ASC
                """,
                (day_iso,),
            ).fetchall()
            for row in rows:
                start_iso = row["start_iso"] if hasattr(row, "keys") else row[0]
                title = row["title"] if hasattr(row, "keys") else row[1]
                start = _parse_health_dt(start_iso)
                if start:
                    obligations.append({"start": start, "label": title or "Kalender", "source": "Kalender"})
    except Exception:
        pass

    if PEOPLE_DB.exists():
        try:
            with sqlite3.connect(PEOPLE_DB) as con:
                con.row_factory = sqlite3.Row
                rows = con.execute(
                    """
                    SELECT a.date, a.start_time, COALESCE(p.name, 'PT') AS title
                    FROM pt_appointments a
                    LEFT JOIN people p ON p.id = a.person_id
                    WHERE a.date = ?
                      AND COALESCE(a.status, 'scheduled') NOT LIKE 'cancelled%'
                    ORDER BY a.start_time ASC
                    """,
                    (day_iso,),
                ).fetchall()
                for row in rows:
                    start = _parse_health_dt(f"{row['date']}T{row['start_time']}:00")
                    if start:
                        obligations.append({"start": start, "label": row["title"] or "PT", "source": "PT"})
        except Exception:
            pass

    return sorted(obligations, key=lambda item: item["start"])


def _sleep_schedule_for_tonight(sleep_plan: dict, now: datetime | None = None) -> dict:
    current = (now or datetime.now(HEALTH_TZ)).astimezone(HEALTH_TZ)
    wake_day = current.date() + timedelta(days=1)
    default_wake = datetime.combine(wake_day, dt_time(8, 0), HEALTH_TZ)
    wake_target = default_wake
    wake_source = "Standard 08:00"

    first_obligation = next(iter(_tonight_obligations(wake_day)), None)
    if first_obligation:
        obligation_start = first_obligation["start"].astimezone(HEALTH_TZ)
        planned_wake = obligation_start - timedelta(minutes=60)
        if planned_wake < wake_target:
            wake_target = planned_wake
            wake_source = f"{_time_label_dt(obligation_start)} {first_obligation['label']}"

    need_h = float(sleep_plan.get("tonight_h") or sleep_plan.get("base_h") or 8.0)
    bedtime = wake_target - timedelta(hours=need_h)
    wind_down = bedtime - timedelta(minutes=45)
    possible_h = max(0.0, (wake_target - current).total_seconds() / 3600.0)
    deficit_h = max(0.0, need_h - possible_h)
    is_late = current > bedtime

    if is_late:
        detail = (
            f"Schlaf heute: jetzt ins Bett; bis {_time_label_dt(wake_target)} "
            f"sind maximal {_hours_label(possible_h)}h möglich statt {_hours_label(need_h)}h."
        )
    else:
        detail = (
            f"Schlaf heute: Bett bis {_time_label_dt(bedtime)}, runterfahren ab {_time_label_dt(wind_down)}, "
            f"damit {_hours_label(need_h)}h bis {_time_label_dt(wake_target)} drin sind."
        )

    return {
        "wake_date": wake_day.isoformat(),
        "wake_target": _time_label_dt(wake_target),
        "wake_target_iso": wake_target.isoformat(),
        "wake_source": wake_source,
        "bedtime": _time_label_dt(bedtime),
        "bedtime_iso": bedtime.isoformat(),
        "wind_down": _time_label_dt(wind_down),
        "wind_down_iso": wind_down.isoformat(),
        "need_h": round(need_h, 1),
        "possible_h": round(possible_h, 1),
        "deficit_h": round(deficit_h, 1),
        "is_late": is_late,
        "detail": detail,
    }


def _minute_from_iso(value: str | None, fallback: int) -> int:
    dt = _parse_health_dt(value)
    if not dt:
        return fallback
    return dt.hour * 60 + dt.minute


def _day_curve(current: dict, scores: dict, sleep_plan: dict) -> list[dict]:
    wake = _minute_from_iso(current.get("sleep_end"), 7 * 60)
    performance = float(scores.get("performance") or 50.0)
    body_battery = float(scores.get("body_battery") or 50.0)
    recovery = float(scores.get("recovery") or 50.0)
    training_ok = performance >= 58 and recovery >= 55 and body_battery >= 45
    bed_target = wake + 16 * 60 - int(max(0.0, sleep_plan.get("tonight_h", 8.0) - 8.0) * 45)
    wind_down = bed_target - 90
    windows = [
        {
            "kind": "ramp",
            "label": "Hochfahren",
            "tone": "neutral",
            "start": _time_label(wake),
            "end": _time_label(wake + 75),
            "level": round(max(35.0, min(70.0, performance - 8.0))),
            "detail": "Licht, Bewegung, ruhig starten.",
        },
        {
            "kind": "focus",
            "label": "Fokusfenster",
            "tone": "good",
            "start": _time_label(wake + 90),
            "end": _time_label(wake + 210),
            "level": round(max(45.0, min(95.0, performance + 10.0))),
            "detail": "Bestes Fenster für Kopf und saubere Arbeit.",
        },
        {
            "kind": "dip",
            "label": "Mittagstief",
            "tone": "attention",
            "start": _time_label(wake + 330),
            "end": _time_label(wake + 430),
            "level": round(max(25.0, min(70.0, performance - 18.0))),
            "detail": "Nicht erzwingen. Essen, Spaziergang, weniger Druck.",
        },
        {
            "kind": "training",
            "label": "Trainingsfenster" if training_ok else "Lockeres Fenster",
            "tone": "good",
            "start": _time_label(wake + 510),
            "end": _time_label(wake + 690),
            "level": round(max(35.0, min(92.0, performance + (6.0 if training_ok else -6.0)))),
            "detail": "Schwer vertretbar." if training_ok else "Eher Technik, Mobility oder kurzer Ausgleich.",
        },
        {
            "kind": "wind_down",
            "label": "Runterfahren",
            "tone": "neutral",
            "start": _time_label(wind_down),
            "end": _time_label(bed_target),
            "level": 30,
            "detail": f"Bettziel aus Bedarf heute: {_time_label(bed_target)}.",
        },
    ]
    return windows


def _regularity_score(today: dict, history: list[dict]) -> float:
    midpoint = today.get("sleep_midpoint_min")
    mids = [f.get("sleep_midpoint_min") for f in history[-14:-1] if f.get("sleep_midpoint_min") is not None]
    if midpoint is None or len(mids) < 4:
        return 75.0
    med = float(statistics.median(mids))
    delta = abs(float(midpoint) - med)
    delta = min(delta, 1440.0 - delta)
    return _clamp(100.0 - delta / 3.0)


def _reta_context(day_iso: str) -> dict:
    memory_path = PROJECT_ROOT / "brain" / "MEMORY.md"
    text = ""
    try:
        text = memory_path.read_text(encoding="utf-8")
    except Exception:
        pass
    dose = ""
    taken_at = ""
    m = _re.search(r"Aktuelle Dosis:\s*\*\*([^*]+)\*\*.*?ab Samstag\s+(\d{4}-\d{2}-\d{2})(?:,\s*genommen um\s*([0-9:]+))?", text)
    if m:
        dose = m.group(1).strip()
        taken_at = m.group(3) or ""
        inj_date = date.fromisoformat(m.group(2))
    else:
        target = date.fromisoformat(day_iso)
        inj_date = target - timedelta(days=(target.weekday() - 5) % 7)
    target_date = date.fromisoformat(day_iso)
    days_since = (target_date - inj_date).days
    if days_since < 0 or days_since > 6:
        days_since = (target_date.weekday() - 5) % 7
    if days_since == 0:
        score = 45.0
        label = "Spritztag"
    elif days_since == 1:
        score = 25.0
        label = "Tag 1 nach Spritze"
    elif days_since == 2:
        score = 35.0
        label = "Tag 2 nach Spritze"
    else:
        score = 70.0
        label = f"Tag {days_since} nach Spritze"
    return {"dose": dose, "taken_at": taken_at, "days_since": days_since, "label": label, "score": score}


def _decimal_match(pattern: str, text: str) -> float | None:
    m = _re.search(pattern, text, flags=_re.IGNORECASE | _re.DOTALL)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except Exception:
        return None


def _body_composition_points() -> list[dict]:
    points: list[dict] = []
    if not HEALTH_BASELINE_DIR.exists():
        return points
    for path in sorted(HEALTH_BASELINE_DIR.glob("*-seca.md")):
        m = _re.match(r"^(\d{4}-\d{2}-\d{2})", path.name)
        if not m:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        weight = _decimal_match(r"Gewicht:\s*([0-9]+(?:[,.][0-9]+)?)\s*kg", text)
        body_fat = (
            _decimal_match(r"([0-9]+(?:[,.][0-9]+)?)\s*%\s*KFA", text)
            or _decimal_match(r"Körperfett:\s*([0-9]+(?:[,.][0-9]+)?)\s*%", text)
        )
        fat_mass = _decimal_match(r"Fettmasse:\s*(?:ca\.\s*)?([0-9]+(?:[,.][0-9]+)?)\s*kg", text)
        muscle = _decimal_match(r"Skelettmuskel(?:masse)?:\s*([0-9]+(?:[,.][0-9]+)?)\s*kg", text)
        phase_angle = _decimal_match(r"Phasenwinkel:\s*([0-9]+(?:[,.][0-9]+)?)", text)
        if weight is None and body_fat is None and muscle is None:
            continue
        points.append({
            "date": m.group(1),
            "weight_kg": round(weight, 1) if weight is not None else None,
            "body_fat_pct": round(body_fat, 1) if body_fat is not None else None,
            "fat_mass_kg": round(fat_mass, 1) if fat_mass is not None else None,
            "skeletal_muscle_kg": round(muscle, 2) if muscle is not None else None,
            "phase_angle": round(phase_angle, 1) if phase_angle is not None else None,
            "source": str(path),
        })
    return points


def _body_composition_context(day_iso: str) -> dict | None:
    points = [p for p in _body_composition_points() if p.get("date", "") <= day_iso]
    if not points:
        return None
    current = points[-1]
    previous = points[-2] if len(points) >= 2 else None
    delta: dict = {}
    if previous:
        for key in ("weight_kg", "body_fat_pct", "fat_mass_kg", "skeletal_muscle_kg", "phase_angle"):
            if current.get(key) is not None and previous.get(key) is not None:
                digits = 2 if key == "skeletal_muscle_kg" else 1
                delta[key] = round(float(current[key]) - float(previous[key]), digits)

    body_fat = current.get("body_fat_pct")
    muscle_delta = delta.get("skeletal_muscle_kg")
    fat_delta = delta.get("fat_mass_kg")
    weight_delta = delta.get("weight_kg")
    current_muscle = current.get("skeletal_muscle_kg")
    phase_delta = delta.get("phase_angle")
    muscle_floor = 38.0
    status = "Verlauf stabil"
    if current_muscle is not None and current_muscle < muscle_floor - 0.4:
        status = "Muskel prüfen"
    elif muscle_delta is not None and muscle_delta < -0.8:
        status = "Muskel schützen"
    elif current_muscle is not None and current_muscle >= muscle_floor and (phase_delta is None or phase_delta >= -0.2):
        status = "Muskel gehalten"
    elif fat_delta is not None and fat_delta < -0.8 and (muscle_delta is None or muscle_delta >= -0.25):
        status = "Muskel gehalten"
    elif body_fat is not None and body_fat <= 12.0:
        status = "Zielkorridor"

    score = 72.0
    if fat_delta is not None and fat_delta < 0:
        score += min(12.0, abs(fat_delta) * 3.0)
    if muscle_delta is not None:
        if current_muscle is not None and current_muscle >= muscle_floor and (phase_delta is None or phase_delta >= -0.2):
            score += 8.0
        elif muscle_delta >= -0.25:
            score += 8.0
        elif muscle_delta < -0.8:
            score -= 18.0
        else:
            score -= 2.0
    if body_fat is not None and body_fat <= 12.0:
        score += 4.0
    score = _clamp(score)

    detail_parts: list[str] = []
    if status == "Muskel gehalten" and fat_delta is not None and fat_delta < 0:
        detail_parts.append("Fettverlust sauber")
    if previous and weight_delta is not None:
        detail_parts.append(f"Seit {previous['date']}: Gewicht {weight_delta:+.1f} kg".replace(".", ","))
    if fat_delta is not None:
        detail_parts.append(f"Fett {fat_delta:+.1f} kg".replace(".", ","))
    if muscle_delta is not None:
        detail_parts.append(f"Muskel {muscle_delta:+.2f} kg".replace(".", ","))
    if body_fat is not None:
        detail_parts.append(f"KFA {body_fat:.1f}%".replace(".", ","))
    detail = "; ".join(detail_parts) or "Körperkomposition als Verlaufsschutz für Cut und Muskelhalt."

    return {
        "current": current,
        "previous": previous,
        "delta": delta,
        "status": status,
        "score": round(score),
        "target": {
            "body_fat_pct_min": 10.0,
            "body_fat_pct_max": 12.0,
            "skeletal_muscle_floor_kg": muscle_floor,
            "protein_goal_g": 180,
        },
        "detail": detail,
    }


def _log_entries_for_day(day_iso: str) -> list[dict]:
    return _health_parse_log(HEALTH_LOG_DIR / f"{day_iso}.md")


def _log_text_for_day(day_iso: str, kinds: set[str] | None = None) -> str:
    entries = _log_entries_for_day(day_iso)
    if kinds:
        entries = [entry for entry in entries if str(entry.get("kind") or "") in kinds]
    return " ".join(str(entry.get("text") or "") for entry in entries).lower()


def _extract_mg(text: str) -> float | None:
    values = []
    for match in _re.finditer(r"(\d{2,4})\s*mg", text, flags=_re.IGNORECASE):
        values.append(float(match.group(1)))
    return sum(values) if values else None


def _extract_protein_g(text: str) -> float | None:
    values: list[float] = []
    patterns = [
        r"(\d{1,3})\s*g\s*(?:eiweiß|eiweiss|protein)",
        r"(?:eiweiß|eiweiss|protein)[^\d]{0,16}(\d{1,3})\s*g?",
    ]
    for pattern in patterns:
        for match in _re.finditer(pattern, text, flags=_re.IGNORECASE):
            values.append(float(match.group(1)))
    return sum(values) if values else None


def _training_rhythm_context(day_iso: str, history: list[dict]) -> dict:
    target = date.fromisoformat(day_iso)
    by_date = {str(f.get("date")): f for f in history}
    days = [(target - timedelta(days=offset)).isoformat() for offset in range(13, -1, -1)]
    trained: dict[str, dict] = {}

    for day in days:
        feature = by_date.get(day) or {}
        log_text = _log_text_for_day(day, {"training", "notiz"})
        has_log_training = bool(log_text and any(token in log_text for token in (
            "training", "trainiert", "gym", "kraft", "bein", "rücken", "brust", "schulter",
            "squat", "kreuzheben", "rudern", "klimm", "mobility", "powerplate"
        )))
        strain = float(feature.get("training_strain") or 0.0)
        has_workout = bool(feature.get("workout_count"))
        if has_log_training or has_workout:
            trained[day] = {
                "date": day,
                "strain": round(strain, 1),
                "source": "Workout" if has_workout else "Log",
                "text": log_text[:260],
            }

    streak = 0
    cursor = target
    while cursor.isoformat() in trained:
        streak += 1
        cursor -= timedelta(days=1)

    last_day = max(trained.keys()) if trained else ""
    days_since = (target - date.fromisoformat(last_day)).days if last_day else None
    trained_today = days_since == 0

    if days_since is None:
        status = "unklar"
        label = "Keine Trainingsspur"
        detail = "Noch zu wenig Log- oder Workout-Historie für eine saubere Trainingspause."
        score = 45.0
    elif trained_today and streak >= 4:
        status = "Streak hoch"
        label = f"{streak} Tage am Stück"
        detail = "Reiz ist konstant da. Nächstes Training eher kurz, sauber oder als Gegenbewegung."
        score = 62.0
    elif trained_today:
        status = "heute Reiz"
        label = f"{streak} Tag{'e' if streak != 1 else ''} Streak"
        detail = "Heute ist schon Trainingsreiz im System. Weitere Last nur bewusst."
        score = 72.0
    elif days_since <= 2:
        status = "Pause läuft"
        label = f"{days_since} Tag{'e' if days_since != 1 else ''} Pause"
        detail = "Pause ist noch normal. Nächster Reiz nach Tagesform, nicht aus schlechtem Gewissen."
        score = 82.0
    elif days_since <= 4:
        status = "wieder dran"
        label = f"{days_since} Tage Pause"
        detail = "Trainingspause ist lang genug. Wenn Erholung trägt, passt ein sauberer Reiz."
        score = 70.0
    else:
        status = "lange Pause"
        label = f"{days_since} Tage Pause"
        detail = "Wieder einsteigen, aber nicht alles nachholen. Erst Qualität, dann Volumen."
        score = 52.0

    next_hint = "Nächster Reiz nach Tagesform dosieren."
    latest_text = (trained.get(last_day) or {}).get("text", "") if last_day else ""
    if any(token in latest_text for token in ("bein", "squat", "kreuzheben", "ausfallschritt")):
        next_hint = "Nach Beinreiz eher Oberkörper, Technik oder lockere Bewegung."
    elif any(token in latest_text for token in ("rücken", "rudern", "klimm", "lat")):
        next_hint = "Nach Rücken/Pull eher Beine, Push oder bewusst leicht."
    elif any(token in latest_text for token in ("brust", "bank", "schulter", "press", "trizeps")):
        next_hint = "Nach Push eher Pull, Beine oder Erholung."

    recent = [trained[d] for d in sorted(trained.keys(), reverse=True)[:5]]
    return {
        "label": label,
        "status": status,
        "score": round(score),
        "streak_days": streak,
        "days_since_training": days_since,
        "trained_today": trained_today,
        "last_training_date": last_day,
        "recent_14d": len(trained),
        "recent": recent,
        "detail": detail,
        "next_hint": next_hint,
    }


def _pulse_context(current: dict, rhr_median: float | None, rhr_sd: float | None) -> dict:
    resting = current.get("resting_hr")
    if resting is None:
        return {"label": "Puls unklar", "status": "fehlt", "score": 50, "detail": "Ruhepuls fehlt im aktuellen Export."}
    resting_f = float(resting)
    if rhr_median is None:
        return {
            "label": f"{round(resting_f)} bpm",
            "status": "Basis fehlt",
            "score": 55,
            "detail": "Ruhepuls liegt vor; persönliche Vergleichsbasis ist noch dünn.",
        }
    delta = resting_f - float(rhr_median)
    if delta <= -3:
        status = "ruhig"
        score = 84.0
    elif delta <= 3:
        status = "normal"
        score = 72.0
    elif delta <= max(7.0, float(rhr_sd or 0.0) * 1.5):
        status = "erhöht"
        score = 52.0
    else:
        status = "hoch"
        score = 35.0
    detail = f"Ruhepuls {round(resting_f)} bpm, Basis {round(float(rhr_median))} bpm, Differenz {delta:+.0f}.".replace(".", ",")
    return {
        "label": f"{round(resting_f)} bpm",
        "status": status,
        "score": round(score),
        "delta_bpm": round(delta, 1),
        "detail": detail,
    }


def _lifestyle_context(day_iso: str, current: dict, history: list[dict], rhr_median: float | None, rhr_sd: float | None) -> dict:
    today = date.fromisoformat(day_iso)
    recent_days = [(today - timedelta(days=offset)).isoformat() for offset in range(1, -1, -1)]
    recent_entries = [entry for day in recent_days for entry in _log_entries_for_day(day)]
    recent_text = " ".join(str(entry.get("text") or "") for entry in recent_entries).lower()
    food_text = " ".join(str(entry.get("text") or "") for entry in recent_entries if entry.get("kind") == "food").lower()
    caffeine_text = " ".join(str(entry.get("text") or "") for entry in recent_entries if entry.get("kind") == "caffeine").lower()
    mood_text = " ".join(str(entry.get("text") or "") for entry in recent_entries if entry.get("kind") == "mood").lower()

    caffeine_mg = _extract_mg(caffeine_text or recent_text)
    has_caffeine = bool(caffeine_text or any(token in recent_text for token in ("koffein", "kaffee", "espresso", "booster", "goat", "energy")))
    if caffeine_mg is not None and caffeine_mg >= 350:
        caffeine_status = "hoch"
        caffeine_detail = f"Geloggtes Koffein ca. {round(caffeine_mg)} mg. Leistung zählt, aber Schlafschutz wird wichtiger."
    elif caffeine_mg is not None:
        caffeine_status = "dosiert"
        caffeine_detail = f"Geloggtes Koffein ca. {round(caffeine_mg)} mg."
    elif has_caffeine:
        caffeine_status = "unklar"
        caffeine_detail = "Koffein/Stims erwähnt, aber ohne klare Menge."
    else:
        caffeine_status = "nicht geloggt"
        caffeine_detail = "Kein Koffeinwert im heutigen oder gestrigen Log."

    protein_g = _extract_protein_g(food_text or recent_text)
    protein_goal = 180
    has_food = bool(food_text)
    if protein_g is not None and protein_g >= 160:
        nutrition_status = "Protein sicher"
        nutrition_score = 86
    elif protein_g is not None and protein_g >= 90:
        nutrition_status = "Protein teilweise"
        nutrition_score = 66
    elif has_food:
        nutrition_status = "Menge unklar"
        nutrition_score = 55
    else:
        nutrition_status = "nicht geloggt"
        nutrition_score = 45
    nutrition_detail = (
        f"Protein grob {round(protein_g)} g gegen Ziel {protein_goal} g."
        if protein_g is not None else
        "Essen ist geloggt, Proteinmenge aber nicht belastbar." if has_food else
        "Kein Essens-/Proteinlog für heute oder gestern."
    )

    low_energy_terms = ("leer", "nicht normal belastbar", "koffeinabh", "ohne koffein", "mittagstief", "schlapp")
    low_energy = any(term in mood_text or term in recent_text for term in low_energy_terms)
    subjective = {
        "status": "leer" if low_energy else "unauffällig" if mood_text else "nicht geloggt",
        "low_energy": low_energy,
        "detail": "Tagesgefühl wirkt leer oder koffeingetrieben." if low_energy else "Kein klares Leere-Signal im Log.",
    }

    return {
        "training_rhythm": _training_rhythm_context(day_iso, history),
        "pulse": _pulse_context(current, rhr_median, rhr_sd),
        "caffeine": {
            "status": caffeine_status,
            "mg": round(caffeine_mg) if caffeine_mg is not None else None,
            "logged": has_caffeine,
            "detail": caffeine_detail,
        },
        "nutrition": {
            "status": nutrition_status,
            "protein_g": round(protein_g) if protein_g is not None else None,
            "protein_goal_g": protein_goal,
            "score": nutrition_score,
            "detail": nutrition_detail,
        },
        "subjective": subjective,
    }


def build_health_scores(day_iso: str | None = None) -> dict:
    today = day_iso or datetime.now(HEALTH_TZ).strftime("%Y-%m-%d")
    days = [d for d in _date_dirs(90) if d <= today]
    features = [_daily_feature(d) for d in days]
    if not features or features[-1].get("date") != today:
        features.append(_daily_feature(today))
    current = next((f for f in reversed(features) if f.get("date") == today), features[-1])
    previous = [f for f in features if f.get("date") < today]
    history = [f for f in features if f.get("date") <= today]

    sleep_need = 8.0
    debt = _sleep_debt(history, sleep_need)
    debt_pressure = _sleep_debt_pressure(debt)
    hrv_base = [f["hrv_ms"] for f in previous[-60:] if f.get("hrv_ms") is not None]
    rhr_base = [f["resting_hr"] for f in previous[-60:] if f.get("resting_hr") is not None]
    load_base_42 = [f.get("training_strain") or f.get("cardio_load") or 0.0 for f in previous[-42:]]
    load_base_7 = [f.get("training_strain") or f.get("cardio_load") or 0.0 for f in history[-7:]]

    hrv_score, hrv_median, _ = _score_from_z(current.get("hrv_ms"), hrv_base, True)
    rhr_score, rhr_median, _ = _score_from_z(current.get("resting_hr"), rhr_base, False)
    if hrv_median is None and hrv_base:
        hrv_median = _median(hrv_base)
    if rhr_median is None and rhr_base:
        rhr_median = _median(rhr_base)

    sleep_hours = current.get("sleep_hours")
    if sleep_hours is not None:
        # Schlafqualitaet hat eine Zielzone: deutlich zu wenig und deutlich zu viel
        # sind beide kein sauberer Erholungstag.
        duration_score = _clamp(100.0 - abs(float(sleep_hours) - sleep_need) * 18.0)
    else:
        duration_score = 50.0
    awake_hours = float(current.get("sleep_awake_hours") or 0.0)
    awake_score = _clamp(100.0 - awake_hours * 60.0)
    regularity = _regularity_score(current, history)
    vitals_score = (hrv_score + rhr_score) / 2.0
    sleep_quality = _clamp(duration_score * 0.45 + regularity * 0.25 + awake_score * 0.15 + vitals_score * 0.15)

    debt_score = _clamp(100.0 - debt_pressure * 7.0)
    reta = _reta_context(today)
    recovery = _clamp(hrv_score * 0.48 + rhr_score * 0.27 + sleep_quality * 0.15 + debt_score * 0.05 + reta["score"] * 0.05)

    rhr_raw_score, _, rhr_sd = _score_from_z(current.get("resting_hr"), rhr_base, True)
    hrv_raw_score, _, hrv_sd = _score_from_z(current.get("hrv_ms"), hrv_base, True)
    if rhr_sd is None and rhr_base:
        rhr_sd = _stdev(rhr_base, fallback=max(abs(rhr_median or 1) * 0.15, 1.0))
    if hrv_sd is None and hrv_base:
        hrv_sd = _stdev(hrv_base, fallback=max(abs(hrv_median or 1) * 0.15, 1.0))
    stress = _clamp(50.0 + (rhr_raw_score - 50.0) * 0.7 - (hrv_raw_score - 50.0) * 0.8 + (50.0 - reta["score"]) * 0.25)
    activity_stress_relief = _activity_stress_relief(current)
    stress = _clamp(stress - activity_stress_relief)

    training_strain_today = float(current.get("training_strain") or 0.0)
    activity_score = float(current.get("activity_score") or 0.0)
    today_drain = min(25.0, training_strain_today * 0.11 + (current.get("steps") or 0.0) / 1000.0 * 0.25 + (current.get("active_kcal") or 0.0) / 95.0)
    activity_buffer = max(0.0, activity_score - 55.0) * 0.05
    body_battery = _clamp(35.0 + recovery * 0.32 + sleep_quality * 0.26 - debt_pressure * 1.1 - today_drain - stress * 0.08 + activity_buffer)

    atl = _mean(load_base_7) or 0.0
    ctl = _mean(load_base_42) or atl or 1.0
    load_ratio = atl / ctl if ctl > 0 else 1.0

    vitals_today = _clamp(hrv_score * 0.58 + rhr_score * 0.42)
    readiness_score = _clamp(
        vitals_today * 0.34
        + recovery * 0.28
        + body_battery * 0.20
        + (100.0 - stress) * 0.12
        + sleep_quality * 0.06
        - debt_pressure * 0.35
    )
    load_balance = _load_balance(load_ratio, readiness_score, recovery, body_battery, stress, debt, reta)
    load_score = float(load_balance["score"])
    strain_score = _strain_display_score(training_strain_today)
    data_quality = _data_quality(current, today)
    performance_score = _clamp(
        vitals_today * 0.30
        + recovery * 0.24
        + body_battery * 0.22
        + sleep_quality * 0.10
        + (100.0 - stress) * 0.08
        + load_score * 0.06
    )
    sleep_plan = _sleep_need_for_tonight(sleep_need, debt, recovery, stress, load_ratio, current)
    sleep_schedule = _sleep_schedule_for_tonight(sleep_plan)
    sleep_plan["schedule"] = sleep_schedule
    body_composition = _body_composition_context(today)
    day_curve = _day_curve(current, {
        "performance": performance_score,
        "body_battery": body_battery,
        "recovery": recovery,
    }, sleep_plan)
    lifestyle = _lifestyle_context(today, current, history, rhr_median, rhr_sd)
    training_rhythm = lifestyle.get("training_rhythm") or {}
    pulse = lifestyle.get("pulse") or {}
    subjective = lifestyle.get("subjective") or {}
    caffeine = lifestyle.get("caffeine") or {}

    if recovery < 35 or stress > 80:
        decision = "Kein hartes Training"
        decision_detail = "Regeneration, Spaziergang oder Mobility."
    elif recovery < 55 or (debt > 8 and performance_score < 60) or reta["days_since"] in (1, 2):
        decision = "Kurz und leicht"
        decision_detail = "20 bis 30 Minuten Technik, Mobility oder wenige saubere Kraftsätze."
    elif load_ratio > 1.5 and not load_balance["can_overreach"]:
        decision = "Moderat bleiben"
        decision_detail = "Last ist schon hoch. Kein weiteres Stapeln."
    elif load_balance["mode"] == "Überreiz erlaubt":
        decision = "Hart, aber kontrolliert"
        decision_detail = "Überreiz ist heute vertretbar: schwer trainieren, Volumen begrenzen, morgen gegenprüfen."
    elif (
        not training_rhythm.get("trained_today")
        and (training_rhythm.get("days_since_training") or 0) >= 3
        and readiness_score >= 55
        and recovery >= 50
        and load_ratio <= 1.35
    ):
        decision = "Reiz wieder dran"
        decision_detail = f"{training_rhythm.get('detail', 'Trainingspause ist lang genug.')} {training_rhythm.get('next_hint', '')}".strip()
    else:
        decision = "Training möglich"
        decision_detail = "Normale Einheit, solange Magen und Energie mitspielen."
    if subjective.get("low_energy") and decision not in ("Kein hartes Training", "Kurz und leicht"):
        stimulant_note = " Koffein ist hoch; " if caffeine.get("status") == "hoch" else " "
        decision_detail = f"{decision_detail}{stimulant_note}Volumen nicht durch Drive erzwingen.".strip()

    day_balance = _day_balance(readiness_score, recovery, body_battery, stress, debt, load_ratio, training_strain_today)

    if performance_score < 45 or body_battery < 35:
        compass = {
            "label": "Aufladen",
            "detail": "Leistungsfähigkeit sichern: runterfahren, leicht essen, Schlaf vorbereiten.",
        }
    elif load_balance["mode"] == "Überreiz erlaubt":
        compass = {
            "label": "Überreiz erlaubt",
            "detail": "Bereitschaft passt und die Last ist hoch. Hart trainieren geht, aber bewusst kurz und sauber.",
        }
    elif performance_score >= 70 and recovery >= 65 and body_battery >= 50:
        compass = {
            "label": "Schwer möglich",
            "detail": "Tagesform trägt. Schlafschuld bleibt Kontext, aber heute sprechen die Körpersignale für Belastbarkeit.",
        }
    elif load_ratio < 0.85 and readiness_score >= 55:
        compass = {
            "label": "Reiz setzen",
            "detail": "Wochenlast liegt links der Mitte und Bereitschaft reicht. Kurz und sauber trainieren, nicht nachholen.",
        }
    else:
        compass = {
            "label": "Stabil bleiben",
            "detail": "Energie über den Tag halten. Training als Ausgleich, nicht als Zusatzstress.",
        }

    sleep_hint = f"14 Tage Minus gegen {sleep_need:.0f}h Ziel. Wirkt gedeckelt auf Tagesform, weil Schuld nicht gleich Fitness ist."
    quality_hint = f"Zielzone {sleep_need:.0f}h, Wachzeit, Rhythmus, HRV und Ruhepuls."
    rhr_label = f"{round(current['resting_hr'])}" if current.get("resting_hr") is not None else "fehlt"
    recovery_hint = f"HRV {round(current.get('hrv_ms') or 0)} ms, Ruhepuls {rhr_label}, letzte Nacht, Reta."
    battery_hint = "Startreserve aus Schlaf und Erholung, minus heutige Last und Stress."
    stress_hint = "Ruhepuls und HRV gegen deine Basis, plus Reta Belastung."
    readiness_hint = "Bereitschaft aus HRV, Ruhepuls, Erholung, Körperakku, Stress und gedeckelter Schlafschuld."
    training_hint = "Balance: deine letzten 7 Tage echte Trainingsreize gegen deine 42-Tage-Basis. Rechts wirkt in den nächsten Tag nach."
    daily_strain_hint = "Tagesreiz aus Workout-Dauer, Puls/Peak, Kalorien und Export-Intensität; Krafttraining bekommt mehr Luft als Cardio. Schritte zählen hier nicht."
    activity_hint = "Grundaktivität aus Schritten und leichter Bewegung. Hilft Stresspuffer, ist aber kein harter Trainingsreiz."
    body_composition_hint = "Körperziel aus Seca-Verlauf: Gewicht, KFA und Muskelmasse. Das schützt den Cut, ohne die Tagesform hart zu bestrafen."

    cards = [
        {"key": "sleep_debt", "label": "Schlafschuld", "value": round(debt_score), "unit": "/100", "score": debt_score, "raw_value": round(debt, 1), "raw_unit": "h", "status": "gut" if debt <= 3 else "okay" if debt <= 5 else "vorsichtig" if debt <= 8 else "hoch", "detail": sleep_hint},
        {"key": "sleep_quality", "label": "Schlafqualität", "value": round(sleep_quality), "unit": "/100", "score": sleep_quality, "status": "stark" if sleep_quality >= 80 else "okay" if sleep_quality >= 60 else "knapp", "detail": quality_hint},
        {"key": "recovery", "label": "Erholung", "value": round(recovery), "unit": "/100", "score": recovery, "status": "grün" if recovery >= 80 else "normal" if recovery >= 60 else "vorsichtig" if recovery >= 40 else "rot", "detail": recovery_hint},
        {"key": "readiness", "label": "Bereitschaft", "value": round(readiness_score), "unit": "/100", "score": readiness_score, "status": "hoch" if readiness_score >= 75 else "tragfähig" if readiness_score >= 60 else "gebremst" if readiness_score >= 35 else "kritisch", "detail": readiness_hint},
        {"key": "body_battery", "label": "Körperakku", "value": round(body_battery), "unit": "/100", "score": body_battery, "status": "voll" if body_battery >= 75 else "brauchbar" if body_battery >= 50 else "knapp" if body_battery >= 35 else "leer", "detail": battery_hint},
        {"key": "stress", "label": "Stresslevel", "value": round(stress), "unit": "/100", "score": 100.0 - stress, "status": "ruhig" if stress <= 20 else "normal" if stress <= 60 else "erhöht" if stress <= 80 else "Überlast", "detail": stress_hint},
        {"key": "daily_strain", "label": "Tagesreiz", "value": round(strain_score), "unit": "/100", "score": strain_score, "raw_value": round(training_strain_today), "raw_unit": "P", "status": _strain_status(training_strain_today), "detail": daily_strain_hint},
        {"key": "training_rhythm", "label": "Trainingstakt", "value": round(training_rhythm.get("score") or 50), "unit": "/100", "score": float(training_rhythm.get("score") or 50), "raw_value": training_rhythm.get("days_since_training"), "raw_unit": "Tage", "status": training_rhythm.get("status", "unklar"), "detail": f"{training_rhythm.get('detail', '')} {training_rhythm.get('next_hint', '')}".strip()},
        {"key": "activity", "label": "Grundaktivität", "value": round(activity_score), "unit": "/100", "score": activity_score, "status": "stark" if activity_score >= 75 else "solide" if activity_score >= 55 else "niedrig", "detail": activity_hint},
        {"key": "training_load", "label": "Wochenlast", "value": round(load_score), "unit": "/100", "score": load_score, "raw_value": round(load_ratio, 2), "raw_unit": "×", "status": load_balance["status"], "detail": f"{training_hint} {load_balance['detail']}"},
    ]
    if current.get("resting_hr") is not None:
        cards.insert(3, {"key": "heart_rate", "label": "Puls", "value": round(current.get("resting_hr") or 0), "unit": "bpm", "score": float(pulse.get("score") or 50), "raw_value": pulse.get("delta_bpm"), "raw_unit": "bpm", "status": pulse.get("status", "unklar"), "detail": pulse.get("detail", "Ruhepuls gegen deine eigene Basis.")})
    if body_composition:
        current_body = body_composition.get("current") or {}
        body_fat = current_body.get("body_fat_pct")
        weight = current_body.get("weight_kg")
        cards.insert(8, {
            "key": "body_composition",
            "label": "Körperziel",
            "value": float(body_fat or body_composition["score"]),
            "unit": "%" if body_fat is not None else "/100",
            "score": float(body_composition["score"]),
            "raw_value": weight,
            "raw_unit": "kg" if weight is not None else "",
            "status": body_composition["status"],
            "detail": f"{body_composition_hint} {body_composition['detail']}",
        })
    coach = _coach_assessment(current, {
        "readiness": readiness_score,
        "body_battery": body_battery,
        "sleep_quality": sleep_quality,
        "recovery": recovery,
        "stress": stress,
        "training_strain": training_strain_today,
        "activity_score": activity_score,
        "load_ratio": load_ratio,
    }, load_balance, lifestyle)
    if sleep_schedule.get("detail"):
        coach["detail"] = f"{coach['detail']} {sleep_schedule['detail']}"
        facts = list(coach.get("facts") or [])
        coach["facts"] = [f"Bettziel {sleep_schedule['bedtime']}", *facts][:4]

    return {
        "date": today,
        "generated_at": datetime.now(HEALTH_TZ).isoformat(),
        "latest_snapshot_at": _snapshot_mtime_iso(current.get("snapshot")),
        "latest_snapshot_file": current.get("snapshot") or "",
        "sleep_need_h": sleep_need,
        "sleep_plan": sleep_plan,
        "day_curve": day_curve,
        "features": current,
        "baselines": {
            "hrv_median": hrv_median,
            "hrv_count": len(hrv_base),
            "rhr_median": rhr_median,
            "rhr_count": len(rhr_base),
            "rhr_sd": rhr_sd,
            "hrv_sd": hrv_sd,
        },
        "reta": reta,
        "scores": {
            "sleep_debt_h": debt,
            "sleep_debt_pressure_h": debt_pressure,
            "sleep_quality": sleep_quality,
            "recovery": recovery,
            "body_battery": body_battery,
            "stress": stress,
            "training_load_ratio": load_ratio,
            "training_strain_today": training_strain_today,
            "activity_score": activity_score,
            "readiness": readiness_score,
            "vitals_today": vitals_today,
            "performance": performance_score,
            "atl_7d": atl,
            "ctl_42d": ctl,
            "activity_stress_relief": activity_stress_relief,
            "data_confidence": data_quality["confidence"],
        },
        "training_context": {
            "readiness": {"score": round(readiness_score), "status": "hoch" if readiness_score >= 75 else "tragfähig" if readiness_score >= 60 else "gebremst" if readiness_score >= 35 else "kritisch"},
            "load_balance": load_balance,
            "target_mode": {"label": load_balance["mode"], "allows_overreach": load_balance["can_overreach"]},
            "rhythm": training_rhythm,
        },
        "lifestyle_context": lifestyle,
        "body_composition": body_composition,
        "coach": coach,
        "data_quality": data_quality,
        "compass": {**compass, "score": round(performance_score), "balance": day_balance},
        "cards": cards,
        "decision": {"label": decision, "detail": decision_detail},
        "history": history[-21:],
        "formula_version": "2026-06-04-v10",
    }


def write_health_scores(day_iso: str | None = None) -> Path:
    scores = build_health_scores(day_iso)
    out = HEALTH_DIR / "data" / f"{scores['date']}-scores.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(scores, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def _health_recommendations(dashboard: dict, entries: list[dict]) -> list[dict]:
    scores = dashboard.get("scores") or {}
    features = dashboard.get("features") or {}
    reta = dashboard.get("reta") or {}
    load_balance = ((dashboard.get("training_context") or {}).get("load_balance") or {})
    lifestyle = dashboard.get("lifestyle_context") or {}
    rhythm = lifestyle.get("training_rhythm") or {}
    pulse = lifestyle.get("pulse") or {}
    caffeine = lifestyle.get("caffeine") or {}
    nutrition = lifestyle.get("nutrition") or {}
    entry_text = " ".join(str(e.get("text") or "") for e in entries).lower()
    recs: list[dict] = []

    debt = float(scores.get("sleep_debt_h") or 0.0)
    body_battery = float(scores.get("body_battery") or 0.0)
    recovery = float(scores.get("recovery") or 0.0)
    readiness = float(scores.get("readiness") or recovery)
    load_ratio = float(scores.get("training_load_ratio") or 1.0)
    sleep_hours = features.get("sleep_hours")

    if body_battery < 35 and readiness < 50:
        recs.append({
            "title": "Akku schützen",
            "detail": "Keine Zusatzlast stapeln. Essen, ruhiger Abend und Schlafvorbereitung zählen heute mehr als noch ein Reiz.",
            "source": f"Körperakku {round(body_battery)}/100",
        })

    if debt > 8:
        recs.append({
            "title": "Schlafschuld tilgen",
            "detail": "Ab jetzt kein Koffein mehr, Licht abends runter, Bettfenster vorziehen. Eine gute Nacht zählt mehr als mehr Training.",
            "source": f"{round(debt, 1)}h Minus",
        })

    if recovery < 50 or reta.get("days_since") in (1, 2):
        recs.append({
            "title": "Erholung schützen",
            "detail": "Kein Volumen stapeln. Wenn Training, dann nur sauber und begrenzt.",
            "source": f"Erholung {round(recovery)}/100, {reta.get('label', 'Reta Kontext')}",
        })

    if load_ratio >= 1.35:
        if load_balance.get("can_overreach"):
            recs.append({
                "title": "Überreiz bewusst setzen",
                "detail": "Schwer ist heute vertretbar. Begrenze Volumen, keine Zusatzfinisher, morgen ehrlich gegenprüfen.",
                "source": f"Zielmodus {load_balance.get('mode', 'Überreiz erlaubt')}",
            })
        else:
            recs.append({
                "title": "Lastspitze bremsen",
                "detail": "Wochenlast ist rechts raus. Training nur moderat oder als Technik, bis Bereitschaft wieder klar trägt.",
                "source": f"Wochenlast {round(load_ratio, 2)}",
            })

    if load_ratio < 0.85 and readiness >= 55:
        recs.append({
            "title": "Reiz aufbauen",
            "detail": "Wochenlast ist links der Mitte. Kurzer Qualitätsreiz reicht, sauber statt wild nachholen.",
            "source": f"Wochenlast {round(load_ratio, 2)}",
        })

    if (
        not rhythm.get("trained_today")
        and rhythm.get("days_since_training") is not None
        and int(rhythm.get("days_since_training") or 0) >= 3
        and readiness >= 55
    ):
        recs.append({
            "title": "Training wieder dran",
            "detail": rhythm.get("next_hint") or "Sauberer Reiz passt wieder, aber nicht alles nachholen.",
            "source": rhythm.get("label", "Trainingstakt"),
        })

    low_energy_terms = ("leer", "nicht normal belastbar", "koffeinabh", "ohne koffein", "mittagstief")
    if any(term in entry_text for term in low_energy_terms):
        recs.append({
            "title": "Tagesgefühl prüfen",
            "detail": "Wenn der Drive erst durch Koffein kommt, zählt das als Kontext. Trainieren geht, aber Volumen und Abenddruck nicht schönrechnen.",
            "source": "subjektives Health Log",
        })

    if caffeine.get("logged") or "koffein" in entry_text or "goat" in entry_text or "energy" in entry_text or "booster" in entry_text:
        recs.append({
            "title": "Koffein steuern",
            "detail": "Stims erklären Leistung, ersetzen aber keine Erholung. Nach dem Trainingsfenster nichts mehr nachlegen, damit die Nacht wirklich wirken kann.",
            "source": caffeine.get("detail") or "heutiges Health Log",
        })

    if nutrition.get("status") in ("Menge unklar", "nicht geloggt"):
        recs.append({
            "title": "Protein klären",
            "detail": "Für Cut + Muskelhalt reicht eine grobe Zahl. Ein Satz wie „Protein heute ca. 160 g“ würde die Bewertung deutlich verbessern.",
            "source": nutrition.get("status", "Ernährungslog"),
        })

    if pulse.get("status") in ("erhöht", "hoch"):
        recs.append({
            "title": "Puls mitlesen",
            "detail": "Wenn der Ruhepuls über Basis liegt, Training eher technisch oder kurz halten und Abendstress reduzieren.",
            "source": pulse.get("detail", "Ruhepuls"),
        })

    if sleep_hours and sleep_hours > 9.0:
        recs.append({
            "title": "Nicht träge werden",
            "detail": "Lange Nacht nutzen, aber nicht mit viel Volumen verballern. Kurz bewegen, dann ruhig bleiben.",
            "source": f"Schlaf {round(float(sleep_hours), 1)}h",
        })

    deduped: list[dict] = []
    seen: set[str] = set()
    for rec in recs:
        title = rec["title"]
        if title in seen:
            continue
        seen.add(title)
        deduped.append(rec)
    return deduped[:3]


@router.get("/api/health/state")
async def health_state():
    """Health-Pane: heutige Briefing-Zahlen + heute geloggte Einträge + Briefing-Markdown."""
    today_path = _health_today_path()
    entries = _health_parse_log(today_path)
    summary = _health_briefing_summary()
    today_str = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
    briefing_md = ""
    briefing_path = HEALTH_DIR / "data" / f"{today_str}-health.md"
    if not briefing_path.exists():
        candidates = sorted((HEALTH_DIR / "data").glob("*-health.md"), reverse=True)
        if candidates:
            briefing_path = candidates[0]
    if briefing_path.exists():
        try:
            briefing_md = briefing_path.read_text(encoding="utf-8")
        except OSError:
            pass
    dashboard = build_health_scores(today_str)
    return JSONResponse({
        "date": today_str,
        "summary": summary,
        "dashboard": dashboard,
        "recommendations": _health_recommendations(dashboard, entries),
        "entries": entries,
        "briefing_md": briefing_md,
        "briefing_path": str(briefing_path) if briefing_path.exists() else "",
    })


async def _health_distill(raw: str) -> tuple[str, str]:
    """Verdichtet Rohtext zu (kind, kurzer Stichpunkt) via Claude Haiku.
    Fällt bei Fehler auf Heuristik + Rohtext zurück."""
    prompt = f"""Du bekommst eine gesprochene Notiz von der Nutzer zu seinem Health-Log. Verdichte sie zu einem KURZEN Stichpunkt (max. 12 Wörter, keine Einleitung, kein "der Nutzer hat …", keine Sätze) und ordne sie einer Kategorie zu.

Kategorien:
- caffeine: Koffein, Kaffee, Energy Drink, Preworkout
- food: Mahlzeit, Snack, Shake, Trinken
- training: Übung, Satz, Cardio, Gym
- peptide: Reta, Dosis, Nebenwirkung, Magen
- mood: Stimmung, Energie, Schlafgefühl, Fokus
- notiz: alles andere (Gewicht, Fragen, Beobachtungen)

Antworte STRIKT in genau zwei Zeilen, nichts sonst:
KIND: <caffeine|food|training|peptide|mood|notiz>
TEXT: <Stichpunkt, max 12 Wörter, telegrammartig, Zahlen behalten>

Bei training NICHT jede Übung listen. Stattdessen das Training als Ganzes einordnen: Muskelgruppe oder Modalität, Intensität/Volumen grob, Gefühl. Einzel-Übungen nur wenn die ganze Notiz nur eine Übung war.

Beispiele:
"Ich habe gerade nen Eiweißshake mit 40 Gramm gedrückt"
KIND: food
TEXT: Shake 40g Eiweiß

"Heute Rücken: Lat-Pulldown 6 reps, Klimmzüge eng und breit, Rudern, alles schwer und sauber"
KIND: training
TEXT: Rücken schwer, ~6 reps, sauber

"30 Minuten Zone 2 auf dem Rad, easy"
KIND: training
TEXT: Zone 2 30 min, locker

"Hab Bank gemacht, vier Sätze à sechs Wiederholungen mit 90 Kilo"
KIND: training
TEXT: Bank 4x6 @ 90 kg

"Magen ist heute ruhig nach der Reta-Spritze"
KIND: peptide
TEXT: Reta — Magen ruhig

Notiz:
{raw}
"""
    try:
        from local_llm import call_with_haiku_fallback
        stdout, _model = await call_with_haiku_fallback(
            prompt, feature="health_distill",
            system="Du verdichtest Health-Notizen strikt im KIND/TEXT-Format.",
            max_tokens=120, temperature=0.2, qwen_timeout=10.0, haiku_timeout=15.0,
        )
        if stdout.strip():
            kind = ""
            text = ""
            for line in stdout.strip().splitlines():
                s = line.strip()
                if s.upper().startswith("KIND:"):
                    kind = s.split(":", 1)[1].strip().lower()
                elif s.upper().startswith("TEXT:"):
                    text = s.split(":", 1)[1].strip()
            if kind in HEALTH_KIND_ORDER and text:
                return kind, text
    except Exception:
        pass
    return _health_classify(raw), raw


@router.post("/api/health/log")
async def health_log(payload: dict = Body(...)):
    """Hängt einen Eintrag an log/YYYY-MM-DD.md. Verdichtet via Claude Haiku, falls kind fehlt."""
    text = (payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text required"}, status_code=400)
    kind = (payload.get("kind") or "").strip().lower()

    low = text.lower()
    explicit_prefix = False
    for k in HEALTH_KIND_ORDER:
        if low.startswith(f"{k}:") or low.startswith(f"{k} :"):
            kind = k
            text = text.split(":", 1)[1].strip()
            explicit_prefix = True
            break

    if not explicit_prefix and kind not in HEALTH_KIND_ORDER:
        kind, text = await _health_distill(text)

    now = datetime.now(ZoneInfo("Europe/Berlin"))
    time_str = now.strftime("%H:%M")
    today_str = now.strftime("%Y-%m-%d")
    path = _health_today_path()

    if path.exists():
        content = path.read_text(encoding="utf-8")
    else:
        content = f"# Health-Log {today_str}\n"

    section_header = f"## {kind}"
    if section_header not in content:
        if not content.endswith("\n"):
            content += "\n"
        content += f"\n{section_header}\n"

    lines = content.splitlines()
    insert_at = len(lines)
    in_section = False
    for i, line in enumerate(lines):
        if line.strip() == section_header:
            in_section = True
            continue
        if in_section and line.startswith("## "):
            insert_at = i
            break
        if in_section:
            insert_at = i + 1
    new_line = f"- {time_str} — {text}"
    lines.insert(insert_at, new_line)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    return JSONResponse({"ok": True, "kind": kind, "time": time_str, "text": text})


def _sleep_analysis_rows(payload: dict) -> list[dict]:
    metrics = (payload.get("data") or {}).get("metrics") or []
    for metric in metrics:
        if metric.get("name") == "sleep_analysis":
            rows = metric.get("data") or []
            return rows if isinstance(rows, list) else []
    return []


def _sleep_row_date(row: dict) -> str:
    for key in ("date", "sleepEnd", "inBedEnd"):
        value = str(row.get(key) or "")
        if len(value) >= 10 and value[:4].isdigit():
            return value[:10]
    return ""


def _sleep_signature(rows: list[dict]) -> str:
    raw = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _remember_sleep_hook(date_iso: str, signature: str) -> bool:
    state_path = PROJECT_ROOT / "data" / "health" / ".sleep-hook-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception:
        state = {}
    # der Nutzer will exactly one conversational health push per day. Apple may
    # export the same sleep later with corrected rows; that should refresh data,
    # not start another Klaus-Channel message.
    if state.get("date") == date_iso:
        return False
    state_path.write_text(
        json.dumps({"date": date_iso, "signature": signature, "ts": time.time()}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return True


def _maybe_trigger_health_job(payload: dict) -> bool:
    try:
        rows = _sleep_analysis_rows(payload)
        if not rows:
            return False
        today = datetime.now(ZoneInfo("Europe/Berlin")).strftime("%Y-%m-%d")
        latest_sleep_date = max((_sleep_row_date(r) for r in rows), default="")
        if latest_sleep_date != today:
            return False
        signature = _sleep_signature(rows)
        if not _remember_sleep_hook(today, signature):
            return False
        script = PROJECT_ROOT / "scripts" / "health-chat-spawn.py"
        log_dir = PROJECT_ROOT / "jobs" / "health-chat" / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        out = open(log_dir / "health-export-hook.out", "a", encoding="utf-8")
        err = open(log_dir / "health-export-hook.err", "a", encoding="utf-8")
        subprocess.Popen(
            [
                "/usr/bin/python3",
                str(script),
                "--date",
                today,
                "--dedupe-key",
                f"health-chat-{today}",
            ],
            stdout=out,
            stderr=err,
            start_new_session=True,
        )
        return True
    except Exception:
        return False


@router.post("/api/health-export")
async def health_export(request: Request):
    if not client_ip_trusted(request.client.host if request.client else ""):
        raise HTTPException(status_code=403, detail="not trusted")
    try:
        payload = await request.json()
    except Exception:
        raw = await request.body()
        payload = {"_raw_text": raw.decode("utf-8", errors="replace")}
    now = datetime.now(ZoneInfo("Europe/Berlin"))
    out_dir = PROJECT_ROOT / "data" / "health" / now.strftime("%Y-%m-%d")
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = now.strftime("%H%M%S") + ".json"
    (out_dir / fname).write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    triggered = _maybe_trigger_health_job(payload) if isinstance(payload, dict) else False
    return {"ok": True, "saved": str(out_dir / fname), "health_job_triggered": triggered}
