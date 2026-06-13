"""Jobs router: Job-/Cron-/launchd-Cluster der Agent-Control-Schicht.

Extrahiert aus server.py als Schnitt C der Modularisierung (nach voice.py,
deck.py, chat.py, files.py, skills.py, voice_tools.py, performance.py und
state.py). KEIN Verhalten geändert, nur verschoben. Routen-Pfade bleiben
byte-identisch.

Routen:
- GET /api/system-status — kompakter Systemstatus für Topbar und InfoPane,
  Hauptzweck: Job-Status (Cron-Zähler, nächster Lauf) plus Restart-Policy.

Helper und State (alle hierher verschoben):
- _read_md_file, _extract_identity_short, _get_agent_model — MD-/Profil-Helfer.
- _next_cron_run — minimaler Cron-Parser für die nächste Laufzeit.
- _parse_frontmatter, _parse_job_frontmatter — YAML-Frontmatter aus Markdown.
- _as_list, _manifest_has, _manifest_status, _boolish,
  _job_has_declared_autonomous_writes, _build_job_manifest — Manifest-Logik.
- _build_job_governance — Governance-Checks pro Job.
- _split_prompt_file, _resolve_local_job_path, _local_job_prompt_file —
  Prompt-Datei-Auflösung.
- _local_job_has_launchd_schedule, _classify_klaus_launchd_entry,
  _klaus_launchd_inventory — launchd-Inventar.
- _last_run_for_local_job — letzten Lauf aus _runs.log lesen.
- _get_local_jobs — Hauptlister der lokalen Jobs.
- State: LOCAL_JOBS_DIR, LOCAL_LAUNCHD_DIR, LOCAL_JOB_UI_KEEP.

Externe Aufrufer (routers/skills.py, routers/voice_tools.py, routers/files.py)
greifen weiter über `server._foo` bzw. `from server import LOCAL_JOBS_DIR` zu.
Damit das intakt bleibt, re-importiert server.py diese Symbole aus diesem Modul.

Server-globale Werte (AGENTS, DEFAULT_CODEX_MODEL_ID, DEFAULT_CLAUDE_MODEL_NAME,
_get_version_info, _SERVER_STARTED_AT) werden per Late-Import aus server geholt,
um Zirkularität zu vermeiden (server.py importiert dieses Modul). PROJECT_ROOT
wird hier eigenständig aus __file__ abgeleitet, damit der Modul-Load nicht von
server abhängt.
"""

from typing import Any
from pathlib import Path

import plistlib
import time

import yaml

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from security_scan import scan_text
from restart_policy import status_payload as restart_policy_status

router = APIRouter()

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


# ── Agent Detail ──


def _read_md_file(path: Path, max_lines: int = 0) -> str:
    try:
        text = path.read_text(errors='replace')
        if max_lines:
            text = '\n'.join(text.splitlines()[:max_lines])
        return text.strip()
    except Exception:
        return ''


def _extract_identity_short(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith('#') and not line.startswith('_') and len(line) > 10:
            return line[:120]
    return ''


def _get_agent_model(agent_id: str) -> str:
    from server import AGENTS, DEFAULT_CODEX_MODEL_ID, DEFAULT_CLAUDE_MODEL_NAME
    agent = AGENTS.get(agent_id, {})
    if agent.get("model"):
        return agent["model"]
    return DEFAULT_CODEX_MODEL_ID if agent.get("type") == "codex" else DEFAULT_CLAUDE_MODEL_NAME


# ── Local Jobs ──
# Unsere eigenen Jobs unter /Users/klaus/agent/jobs/
# Scheduler: launchd (macOS), Executor: claude -p
LOCAL_JOBS_DIR = PROJECT_ROOT / "jobs"
LOCAL_LAUNCHD_DIR = Path.home() / "Library" / "LaunchAgents"
LOCAL_JOB_UI_KEEP: set[str] = set()


def _next_cron_run(expr: str) -> float:
    """Minimal cron parser. Supports 'M H * * *' (daily), 'M H * * D' (weekly),
    '*/N * * * *' (every N minutes), '0 */N * * *' (every N hours).
    Returns unix timestamp of next run, or 0 if unparseable."""
    import datetime as _dt
    parts = expr.strip().split()
    if len(parts) != 5:
        return 0.0
    minute, hour, dom, month, dow = parts
    now = _dt.datetime.now()
    # every N minutes: */5 * * * *
    if minute.startswith("*/") and hour == "*" and dom == "*" and dow == "*":
        try:
            step = int(minute[2:])
            nxt = now.replace(second=0, microsecond=0) + _dt.timedelta(minutes=step - (now.minute % step))
            return nxt.timestamp()
        except Exception:
            return 0.0
    # every N hours: 0 */6 * * *
    if minute.isdigit() and hour.startswith("*/") and dom == "*" and dow == "*":
        try:
            step = int(hour[2:])
            m = int(minute)
            nxt_hour = (now.hour // step + 1) * step
            candidate = now.replace(hour=nxt_hour % 24, minute=m, second=0, microsecond=0)
            if nxt_hour >= 24:
                candidate += _dt.timedelta(days=1)
            if candidate <= now:
                candidate += _dt.timedelta(hours=step)
            return candidate.timestamp()
        except Exception:
            return 0.0
    # multi-hour list: M H1,H2,H3 * * *  (e.g. "0 6,12,18 * * *")
    if minute.isdigit() and "," in hour and dom == "*" and dow == "*":
        try:
            m = int(minute)
            hours = sorted({int(h) for h in hour.split(",") if h.strip().isdigit()})
            if not hours:
                return 0.0
            for h in hours:
                cand = now.replace(hour=h, minute=m, second=0, microsecond=0)
                if cand > now:
                    return cand.timestamp()
            cand = now.replace(hour=hours[0], minute=m, second=0, microsecond=0) + _dt.timedelta(days=1)
            return cand.timestamp()
        except Exception:
            return 0.0
    # daily / weekly: M H * * [*|D]
    if not (minute.isdigit() and hour.isdigit()):
        return 0.0
    try:
        m, h = int(minute), int(hour)
        candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate <= now:
            candidate += _dt.timedelta(days=1)
        if dow != "*" and dow.isdigit():
            cron_dow = int(dow)  # Sun=0..Sat=6
            py_target = (cron_dow + 6) % 7  # Python: Mon=0..Sun=6
            while candidate.weekday() != py_target:
                candidate += _dt.timedelta(days=1)
        return candidate.timestamp()
    except Exception:
        return 0.0


def _parse_frontmatter(text: str) -> dict[str, Any]:
    """Extract YAML frontmatter from markdown without touching the body."""
    meta: dict[str, Any] = {}
    if not text.startswith("---"):
        return meta
    try:
        end = text.index("\n---", 3)
    except ValueError:
        return meta
    block = text[3:end].strip()
    if not block:
        return meta
    try:
        parsed = yaml.safe_load(block)
        if isinstance(parsed, dict):
            return {str(k).strip(): v for k, v in parsed.items() if str(k).strip()}
    except Exception:
        pass
    for line in block.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta


def _parse_job_frontmatter(md_path: Path) -> dict[str, Any]:
    """Extract YAML frontmatter from a prompt markdown file."""
    try:
        text = md_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return {}
    return _parse_frontmatter(text)


def _as_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, tuple):
        return [str(v).strip() for v in value if str(v).strip()]
    text = str(value).strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [part.strip().strip('"').strip("'") for part in text.split(",") if part.strip().strip('"').strip("'")]


def _manifest_has(meta: dict[str, Any], key: str) -> bool:
    if key not in meta:
        return False
    value = meta.get(key)
    if isinstance(value, bool):
        return True
    if isinstance(value, (list, tuple, dict)):
        return bool(value)
    return bool(str(value or "").strip())


def _manifest_status(missing: list[str], warnings: list[str]) -> str:
    if missing:
        return "partial"
    if warnings:
        return "warn"
    return "ready"


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"true", "1", "ja", "yes"}


def _job_has_declared_autonomous_writes(meta: dict[str, Any]) -> bool:
    return _boolish(meta.get("autonomous_writes"))


def _build_job_manifest(slug: str, meta: dict[str, Any], prompt_file: Path, security: dict[str, Any] | None = None) -> dict[str, Any]:
    governance_fields = [
        "purpose", "skills", "inputs", "outputs", "success_criteria",
        "failure_policy", "approval_required", "delivery",
    ]
    required = ["name", "category", "owner", "timeout_seconds", "env_scope"]
    if meta.get("schedule"):
        required.append("schedule")
    missing = []
    for key in required:
        if key == "env_scope":
            if key not in meta:
                missing.append(key)
        elif not _manifest_has(meta, key):
            missing.append(key)
    missing += [key for key in governance_fields if not _manifest_has(meta, key)]
    warnings: list[str] = []
    if "env_scope" not in meta:
        warnings.append("env_scope fehlt; Job-Rechte sind noch nicht explizit.")
    if _as_list(meta.get("context_from")) and not _manifest_has(meta, "max_context_age_hours"):
        warnings.append("context_from ohne Frische-Regel.")
    if str(meta.get("approval_required", "")).lower() in {"false", "0", "nein", "no"} and _as_list(meta.get("writes_to")) and not _job_has_declared_autonomous_writes(meta):
        warnings.append("Schreibziel ohne Freigabe prüfen.")
    if security and security.get("status") != "safe":
        warnings.append(f"Security Scan: {security.get('status')}")
    total = len(required) + len(governance_fields)
    return {
        "kind": "job",
        "slug": slug,
        "path": str(prompt_file),
        "status": _manifest_status(missing, warnings),
        "coverage": round(100 * (total - len(missing)) / max(1, total)),
        "missing": missing,
        "warnings": warnings,
        "security": security or {},
        "fields": {
            "name": meta.get("name") or slug,
            "category": meta.get("category") or "",
            "owner": meta.get("owner") or "",
            "schedule": meta.get("schedule") or "",
            "model": meta.get("model") or "",
            "timeoutSeconds": meta.get("timeout_seconds") or "",
            "envScope": _as_list(meta.get("env_scope")),
            "skills": _as_list(meta.get("skills")),
            "inputs": _as_list(meta.get("inputs")),
            "outputs": _as_list(meta.get("outputs")),
            "contextFrom": _as_list(meta.get("context_from")),
            "writesTo": _as_list(meta.get("writes_to")),
            "approvalRequired": meta.get("approval_required", ""),
            "autonomousWrites": _job_has_declared_autonomous_writes(meta),
            "delivery": meta.get("delivery") or "",
            "successCriteria": meta.get("success_criteria") or "",
            "failurePolicy": meta.get("failure_policy") or "",
            "purpose": meta.get("purpose") or "",
        },
    }


def _build_job_governance(
    meta: dict[str, Any],
    manifest: dict[str, Any],
    security: dict[str, Any],
    has_launchd: bool,
    last_status: str,
) -> dict[str, Any]:
    checks: list[dict[str, str]] = []

    def add(status: str, code: str, message: str) -> None:
        checks.append({"status": status, "code": code, "message": message})

    if security.get("status") == "blocked":
        add("blocked", "security_blocked", "Security Scan blockiert den Job.")
    elif security.get("status") == "warn":
        add("warn", "security_warn", "Security Scan braucht Prüfung.")
    else:
        add("ok", "security_safe", "Security Scan sauber.")

    if manifest.get("status") == "ready":
        add("ok", "manifest_ready", "Manifest vollständig.")
    else:
        add("warn", "manifest_open", "Manifest noch unvollständig.")

    schedule = str(meta.get("schedule") or "").strip()
    if schedule and has_launchd:
        add("ok", "schedule_active", "Zeitplan ist aktiv.")
    elif schedule:
        add("warn", "schedule_inactive", "Zeitplan steht im Prompt, aber launchd ist nicht aktiv.")
    else:
        add("ok", "manual_job", "Manueller Job ohne Zeitplan.")

    if "env_scope" in meta:
        add("ok", "env_scope_declared", "Rechte sind explizit deklariert.")
    else:
        add("warn", "env_scope_missing", "Rechte sind noch nicht explizit deklariert.")

    if _as_list(meta.get("context_from")) and not _manifest_has(meta, "max_context_age_hours"):
        add("warn", "context_freshness_missing", "Kontextquellen haben noch keine Frische-Regel.")

    approval = str(meta.get("approval_required", "")).lower()
    autonomous_writes = _job_has_declared_autonomous_writes(meta)
    if approval in {"true", "1", "ja", "yes"}:
        add("ok", "approval_required", "Freigabe ist vorgeschrieben.")
    elif _as_list(meta.get("writes_to")) and autonomous_writes:
        add("ok", "autonomous_writes_declared", "Autonome Schreibziele sind explizit deklariert.")
    elif _as_list(meta.get("writes_to")):
        add("warn", "writes_without_approval", "Schreibziel ohne klare Freigabe prüfen.")

    if last_status == "error":
        add("warn", "last_run_error", "Letzter Lauf endete mit Fehler.")

    if any(c["status"] == "blocked" for c in checks):
        status = "blocked"
    elif any(c["status"] == "warn" for c in checks):
        status = "warn"
    else:
        status = "ready"

    return {
        "status": status,
        "checks": checks,
        "openCount": sum(1 for c in checks if c["status"] != "ok"),
        "fields": {
            "approvalRequired": meta.get("approval_required", ""),
            "autonomousWrites": autonomous_writes,
            "contextFrom": _as_list(meta.get("context_from")),
            "envScope": _as_list(meta.get("env_scope")),
            "writesTo": _as_list(meta.get("writes_to")),
        },
    }


def _split_prompt_file(md_path: Path) -> tuple[str, str]:
    """Split prompt.md into (frontmatter_block_with_delimiters, body)."""
    text = md_path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return "", text
    try:
        end = text.index("\n---", 3)
    except ValueError:
        return "", text
    fm_end = end + len("\n---")
    if fm_end < len(text) and text[fm_end] == "\n":
        fm_end += 1
    return text[:fm_end], text[fm_end:]


def _resolve_local_job_path(cron_id: str) -> Path | None:
    slug = cron_id.removeprefix("local:") if cron_id.startswith("local:") else cron_id
    if not slug or slug.startswith(("_", ".")) or "/" in slug or "\\" in slug:
        return None
    return _local_job_prompt_file(slug)


def _local_job_prompt_file(slug: str) -> Path | None:
    job_dir = LOCAL_JOBS_DIR / slug
    for name in ("prompt.md", "PROMPT.md"):
        prompt_file = job_dir / name
        if prompt_file.exists():
            return prompt_file
    return None


def _local_job_has_launchd_schedule(name: str) -> bool:
    plist = LOCAL_LAUNCHD_DIR / f"com.klaus.job.{name}.plist"
    return plist.exists()


def _classify_klaus_launchd_entry(label: str, program: Any) -> tuple[str, str, str]:
    program_text = " ".join(str(x) for x in program) if isinstance(program, list) else str(program or "")
    if label.startswith("com.klaus.job."):
        # Ein echter Prompt-Job hat jobs/<slug>/prompt.md. Traegt ein Eintrag den
        # job-Praefix, laeuft aber als direktes Skript ohne Prompt, ist es ein
        # skriptgetriebener Dienst (z.B. brain-index, pioniere-dispatch) und kein
        # verwaister Job. So bleibt die Loose-Erkennung ehrlich.
        slug = label.removeprefix("com.klaus.job.")
        if _local_job_prompt_file(slug):
            return "job", "job", "Geplanter Job"
        return "agent", "service", "Skript-Dienst"
    if label == "com.klaus.agent":
        return "agent", "core", "FastAPI-Hauptserver"
    if label == "com.klaus.agent.heartbeat":
        return "agent", "scheduler", "Pulse-Scheduler"
    if label in {"com.klaus.agent.lmstudio", "com.klaus.agent.qwen", "com.klaus.agent.whatsapp"}:
        return "agent", "service", "Lokaler Dienst"
    if label == "com.klaus.fch-core-preview":
        return "agent", "service", "FCH Preview-Service"
    if label.startswith("com.klaus.publish-"):
        return "agent", "oneshot", "Einmalige Veröffentlichung"
    if label.endswith(".watchdog") or "watchdog" in label or "watchdog" in program_text:
        return "watcher", "watcher", "Wächter"
    if label.endswith("-sync") or "sync-" in label or "sync_" in program_text or "backfill" in program_text:
        return "agent", "sync", "Synchronisation"
    if label.startswith("com.klaus.agent.oneshot-") or "oneshot-" in program_text:
        return "agent", "oneshot", "Einmalauftrag"
    if "transcript" in label or "transcript" in program_text:
        return "agent", "worker", "Worker"
    return "agent", "unknown", "Unklassifiziert"


def _klaus_launchd_inventory(known_jobs: set[str] | None = None) -> dict[str, Any]:
    """Inventory local launchd entries that belong to Klaus.

    This deliberately stays read-only. It makes old watchers/scripts visible in
    the Systemagent layer without turning them into clean jobs automatically.
    """
    known_jobs = known_jobs or set()
    entries: list[dict[str, Any]] = []
    if not LOCAL_LAUNCHD_DIR.is_dir():
        return {"total": 0, "jobCount": 0, "agentCount": 0, "looseJobs": [], "unclassifiedAgents": [], "roleCounts": [], "entries": []}
    for plist_path in sorted(LOCAL_LAUNCHD_DIR.glob("com.klaus*.plist")):
        label = plist_path.stem
        try:
            data = plistlib.loads(plist_path.read_bytes())
            label = str(data.get("Label") or label)
            program = data.get("Program") or data.get("ProgramArguments") or ""
        except Exception:
            program = ""
        slug = ""
        kind, role, description = _classify_klaus_launchd_entry(label, program)
        if kind == "job":
            slug = label.removeprefix("com.klaus.job.")
        entries.append({
            "label": label,
            "kind": kind,
            "role": role,
            "description": description,
            "slug": slug,
            "registered": bool(slug and slug in known_jobs),
            "path": str(plist_path),
        })
    loose_jobs = [e for e in entries if e["kind"] == "job" and not e["registered"]]
    unclassified_agents = [e for e in entries if e["kind"] in {"agent", "watcher"} and e.get("role") in {"unknown", ""}]
    role_counts: dict[str, int] = {}
    for entry in entries:
        if entry["kind"] not in {"agent", "watcher"}:
            continue
        role = str(entry.get("role") or "unknown")
        role_counts[role] = role_counts.get(role, 0) + 1
    return {
        "total": len(entries),
        "jobCount": sum(1 for e in entries if e["kind"] == "job"),
        "agentCount": sum(1 for e in entries if e["kind"] in {"agent", "watcher"}),
        "roleCounts": [{"role": role, "count": count} for role, count in sorted(role_counts.items())],
        "looseJobs": loose_jobs,
        "unclassifiedAgents": unclassified_agents,
        "entries": entries,
    }


def _last_run_for_local_job(name: str) -> tuple[float, str, str]:
    """Read runs.log and return (lastRunTs, lastStatus, lastError) for given job name."""
    runs_log = LOCAL_JOBS_DIR / "_runs.log"
    if not runs_log.exists():
        return 0.0, "", ""
    last_ts = 0.0
    last_status = ""
    last_error = ""
    try:
        for line in runs_log.read_text(encoding="utf-8", errors="ignore").splitlines():
            parts = line.strip().split(None, 2)
            if len(parts) < 3:
                continue
            ts_str, job_name, rest = parts
            if job_name != name:
                continue
            if "ok" in rest:
                last_status = "ok"
                last_error = ""
            elif "error" in rest:
                last_status = "error"
                last_error = rest.strip()
            elif "started" in rest:
                continue
            try:
                import datetime as _dt
                last_ts = _dt.datetime.fromisoformat(ts_str).timestamp()
            except Exception:
                pass
    except Exception as e:
        print(f"[LOCAL-JOBS] runs.log parse failed: {e}")
    return last_ts, last_status, last_error


def _get_local_jobs(agent_id: str) -> list:
    """Read Agent Control local jobs. Only for main agent.

    Struktur: jobs/<job-name>/prompt.md, jobs/<job-name>/data/, jobs/<job-name>/logs/
    Shared:   jobs/_bin/, jobs/_runs.log (Unterstrich = kein Job).
    """
    if agent_id != "main":
        return []
    if not LOCAL_JOBS_DIR.is_dir():
        return []
    result = []
    for job_dir in sorted(LOCAL_JOBS_DIR.iterdir()):
        if not job_dir.is_dir() or job_dir.name.startswith(("_", ".")):
            continue
        prompt_file = _local_job_prompt_file(job_dir.name)
        if not prompt_file:
            continue
        name = job_dir.name
        has_launchd = _local_job_has_launchd_schedule(name)
        keep_visible = name in LOCAL_JOB_UI_KEEP
        prompt_text = ""
        try:
            prompt_text = prompt_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            pass
        meta = _parse_frontmatter(prompt_text) if prompt_text else _parse_job_frontmatter(prompt_file)
        security = scan_text("job", str(prompt_file), prompt_text) if prompt_text else {}
        manifest = _build_job_manifest(name, meta, prompt_file, security)
        display_name = str(meta.get("name") or name)
        category = str(meta.get("category") or "").strip().lower() or "radar"
        # Latest output file. Default <job>/data/; falls data_source im Frontmatter
        # gesetzt ist, lese dort (relativ zu PROJECT_ROOT). So koennen Jobs auf
        # Ausgaben ausserhalb des jobs/-Baums zeigen, z.B. brain/dreams/.
        data_source = str(meta.get("data_source") or "").strip()
        if data_source:
            output_dir = (PROJECT_ROOT / data_source).resolve()
        else:
            output_dir = job_dir / "data"
        last_output_path = ""
        last_output_ts = 0.0
        if output_dir.is_dir():
            files = sorted(output_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
            if files:
                last_output_path = str(files[0])
                last_output_ts = files[0].stat().st_mtime
        last_run_ts, last_status, last_error = _last_run_for_local_job(name)
        if last_output_ts > last_run_ts:
            last_run_ts = last_output_ts
            if not last_status:
                last_status = "ok"
        schedule_expr = str(meta.get("schedule") or "")
        next_run_ts = _next_cron_run(schedule_expr) if schedule_expr and has_launchd else 0.0
        governance = _build_job_governance(meta, manifest, security, has_launchd, last_status)
        result.append({
            "id": f"local:{name}",
            "name": display_name,
            "owner": str(meta.get("owner") or ""),
            "purpose": str(meta.get("purpose") or ""),
            # Prompt im Repo allein reicht nicht. Sichtbar bleiben nur Jobs, die
            # wirklich per launchd geplant sind. Fokus-Kurator bleibt waehrend der
            # Slash-Fokus-Migration bewusst sichtbar, obwohl sein Plist aktuell fehlt.
            "enabled": has_launchd or keep_visible,
            "schedule": schedule_expr,  # leer = manuell
            "tz": "Europe/Berlin",
            "model": "claude",
            "lastStatus": last_status,
            "lastRunStatus": last_status,
            "lastRunAt": last_run_ts,
            "lastDurationMs": 0,
            "nextRunAt": next_run_ts,
            "consecutiveErrors": 0,
            "lastError": last_error,
            "message": "",  # Prompt-Inhalt bewusst nicht mitgeliefert
            "lastOutputPath": last_output_path,
            "lastOutputTs": last_output_ts,
            "runsLogPath": str(LOCAL_JOBS_DIR / "_runs.log"),
            "logPath": str(job_dir / "logs"),
            "source": "local",
            "promptPath": str(prompt_file),
            "category": category,
            "manifest": manifest,
            "governance": governance,
        })
    return result


# ── System Status ──

@router.get("/api/system-status")
async def system_status():
    """Compact system status for top bar and InfoPane."""
    from server import _get_version_info, _SERVER_STARTED_AT
    cron_total = 0
    cron_ok = 0
    cron_errors = 0
    next_cron = None
    next_cron_ts = float("inf")
    for job in _get_local_jobs("main"):
        if not job.get("enabled", True):
            continue
        cron_total += 1
        if job.get("consecutiveErrors", 0) > 0 or job.get("lastStatus") == "error":
            cron_errors += 1
        else:
            cron_ok += 1
        nr = job.get("nextRunAt", 0)
        if nr and nr < next_cron_ts:
            next_cron_ts = nr
            next_cron = {"name": job.get("name", ""), "agent": "main", "nextRunAt": nr}
    return JSONResponse({
        "gateway": True,  # Codex CLI ist lokal — kein externer Gateway nötig
        "gatewayLatencyMs": 0,
        "version": _get_version_info().get("short", ""),
        "commit": _get_version_info(),
        "serverStartedAt": int(_SERVER_STARTED_AT * 1000),
        "uptimeSeconds": int(time.time() - _SERVER_STARTED_AT),
        "restartPolicy": restart_policy_status(),
        "crons": {"total": cron_total, "ok": cron_ok, "errors": cron_errors},
        "nextCron": next_cron,
    })
