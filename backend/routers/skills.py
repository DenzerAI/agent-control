"""Skills router: Skill-/Job-Registry, Bibliothekar-Pflegeschleife und Job-CRUD.

Extrahiert aus server.py als Schnitt 4b der Modularisierung (nach voice.py,
deck.py, chat.py und files.py). KEIN Verhalten geändert, nur verschoben.
Routen-Pfade bleiben byte-identisch.

Routen:
- GET  /api/skills                     — Skill-Index mit Kategorie-Aggregation
- GET  /api/manifest-registry          — Read-only Skill-/Job-Manifest-Pass
- GET  /api/job-governance             — Read-only Job-Governance-Übersicht
- GET  /api/skill-bibliothekar         — Read-only Skill-Pflegeschleife (DE-Alias)
- GET  /api/skill-curator              — gleicher Payload, alter Alias
- POST /api/skill-bibliothekar/decide  — Review-Entscheidung merken (kein Skill-Write)
- POST /api/skill-bibliothekar/ping    — Klaus-Channel-Ping bei pingwürdigen Punkten
- GET  /api/security-scan              — Security-Scan einer einzelnen Datei
- GET  /api/agent-detail               — Agenten-Detailansicht (Stats, Brain, Skills)
- GET  /api/briefings                  — letzte Nachricht pro Tag (Briefing-Karten)
- POST /api/forward-to-claude          — Nachricht in die Claude-Code-Konversation leiten
- GET  /api/local-job                  — einzelnen lokalen Job lesen
- PUT  /api/local-job                  — Prompt-Body eines lokalen Jobs schreiben
- GET  /api/cron-runs                  — Stub, lokale Jobs ohne Run-Log
- GET  /api/project-plan               — PLAN.md eines Projektverzeichnisses lesen
- PUT  /api/project-plan               — PLAN.md schreiben und neu indexieren

Mitgewandert aus server.py (Schnitt 4d): die gesamte Skill-Index-Helfer-Kette
liegt jetzt modul-intern in diesem Router, die Aufrufe gehen direkt lokal statt
über `server._get_skills`:
- _get_skills samt _skill_index_meta, _skill_usage_stats, _build_skill_manifest,
  _skill_frontmatter, _skill_first_paragraph, _strip_skill_md,
  _fallback_skill_category, _skill_display_name und _SKILL_DISPLAY_NAMES.
  Utility-Helfer (_parse_frontmatter, _as_list, _manifest_status) kommen direkt
  aus routers.jobs, scan_text direkt aus security_scan. PROJECT_ROOT und AGENTS
  holt die Kette per Late-Import aus server. server.py re-importiert _get_skills
  wieder, damit eventuelle externe `server._get_skills`-Aufrufer weiter greifen.

Bewusst in server.py VERBLIEBEN (von nicht-verschobenem Code genutzt, per grep
über die ganze server.py verifiziert; hier per Late-Import aus server geholt, um
Zirkularität zu vermeiden):
- _get_local_jobs: auch von verbleibendem Code (z. B. dem Krons-/Status-Pfad bei
  Zeile ~754) genutzt.
- _klaus_launchd_inventory, _resolve_local_job_path, _split_prompt_file,
  _parse_job_frontmatter: Job-Helfer, _parse_job_frontmatter wird auch von
  verbleibendem Code (~2862) genutzt; die übrigen hängen an derselben Job-Schicht.
- _read_md_file, _get_agent_model, _extract_identity_short: allgemeine Profil-/MD-
  Helfer, quer durch server.py gebraucht.
- _resolve_path, _is_allowed_path: Pfad-Auflösung und Sandbox-Gate, vom Security-
  Scan und vielen verbleibenden Routen genutzt.
- get_db: zentraler DB-Kontextmanager aus server.
- AGENTS, PROJECT_ROOT, SOURCES: geteilte Konstanten/Globals von server.

Mitgewandert, weil ausschließlich von einer dieser Routen genutzt (per grep über
die ganze server.py verifiziert):
- _manifest_registry_summary, _job_governance_summary, _proposal_severity_rank.
- _BIBLIOTHEKAR_STATE_PATH, _BIBLIOTHEKAR_STALE_SEC und die gesamte
  _bibliothekar_*-Kette (_load/_save_bibliothekar_state,
  _bibliothekar_proposal_fingerprint, _bibliothekar_hidden,
  _bibliothekar_ping_reasons, _annotate_bibliothekar_proposals,
  _bibliothekar_ping_summary, _mark_bibliothekar_pinged, _format_bibliothekar_ping).
- _manifest_curator_proposals, _skill_bundle_candidates, _skill_bibliothekar_payload.
- _get_recent_files, _get_agent_recent_messages: nur von /api/agent-detail.

scan_path kommt direkt aus security_scan (sauberer Modul-Import). index_file kommt
direkt aus db. get_agent_profile kommt direkt aus identity. SOURCES wird per
Late-Import aus server geholt, weil dort die eine Wahrheit liegt.
"""

import json
import re
import time
import hashlib
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Body
from fastapi.responses import JSONResponse

from db import get_db, index_file
from identity import get_agent_profile
from security_scan import scan_path, scan_text
from routers.jobs import _parse_frontmatter, _as_list, _manifest_status

router = APIRouter()


# ── Skill-Index-Helfer (aus server.py gewandert) ──

def _strip_skill_md(value: str) -> str:
    value = re.sub(r"`([^`]+)`", r"\1", value)
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    value = re.sub(r"[*_#>]+", "", value)
    return re.sub(r"\s+", " ", value).strip()


def _skill_frontmatter(text: str) -> dict[str, Any]:
    return _parse_frontmatter(text)


def _build_skill_manifest(
    slug: str,
    meta: dict[str, Any],
    spec: Path,
    description: str,
    category: str,
    file_count: int,
    usage: dict[str, Any],
    security: dict[str, Any] | None = None,
) -> dict[str, Any]:
    required = ["name", "description", "category"]
    governance_fields = ["triggers", "inputs", "outputs", "permissions", "risks", "owner", "status"]
    normalized = {
        "name": meta.get("name") or slug,
        "description": meta.get("description") or description,
        "category": category,
        "triggers": _as_list(meta.get("triggers") or meta.get("trigger")),
        "inputs": _as_list(meta.get("inputs")),
        "outputs": _as_list(meta.get("outputs")),
        "permissions": _as_list(meta.get("permissions") or meta.get("allowed_tools")),
        "risks": _as_list(meta.get("risks") or meta.get("risk")),
        "owner": meta.get("owner") or "",
        "status": meta.get("status") or "",
    }
    missing = [key for key in required if not normalized.get(key)]
    missing += [key for key in governance_fields if not normalized.get(key)]
    warnings: list[str] = []
    if file_count > 8 and not normalized["inputs"]:
        warnings.append("Viele Skill-Dateien, aber keine Inputs deklariert.")
    if usage.get("needsHardening") and not normalized["risks"]:
        warnings.append("Härtebedarf ohne Risiko-Feld.")
    if security and security.get("status") != "safe":
        warnings.append(f"Security Scan: {security.get('status')}")
    total = len(required) + len(governance_fields)
    return {
        "kind": "skill",
        "slug": slug,
        "path": str(spec),
        "status": _manifest_status(missing, warnings),
        "coverage": round(100 * (total - len(missing)) / max(1, total)),
        "missing": missing,
        "warnings": warnings,
        "security": security or {},
        "fields": normalized,
    }


def _skill_first_paragraph(text: str) -> str:
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            text = text[end + 3:]
    lines: list[str] = []
    in_fence = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or not line:
            if lines:
                break
            continue
        if line.startswith("#") or line.startswith("|") or line.startswith("- ") or line.startswith("* "):
            if lines:
                break
            continue
        lines.append(line)
    return _strip_skill_md(" ".join(lines))


def _skill_index_meta() -> tuple[dict[str, dict], list[tuple[str, dict]], list[str]]:
    from server import PROJECT_ROOT
    index = PROJECT_ROOT / "skills" / "INDEX.md"
    exact: dict[str, dict] = {}
    wildcards: list[tuple[str, dict]] = []
    order: list[str] = []
    if not index.exists():
        return exact, wildcards, order
    category = ""
    try:
        for raw in index.read_text(errors="replace").splitlines():
            line = raw.strip()
            if line.startswith("## "):
                category = line[3:].strip()
                if category and category not in order:
                    order.append(category)
                continue
            if not category or not line.startswith("|") or "`" not in line:
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 2 or cells[0].lower() == "skill":
                continue
            description = _strip_skill_md(cells[1])
            for code in re.findall(r"`([^`]+)`", cells[0]):
                slug = code.strip().rstrip("/")
                meta = {"category": category, "indexDescription": description}
                if slug.endswith("*/"):
                    wildcards.append((slug[:-2], meta))
                elif slug.endswith("*"):
                    wildcards.append((slug[:-1], meta))
                else:
                    exact[slug] = meta
    except Exception:
        pass
    return exact, wildcards, order


def _fallback_skill_category(slug: str) -> str:
    if slug.startswith(("gsap-", "framer-motion-", "motion-", "lottie-", "react-spring-", "scroll-reveal-", "animated-")):
        return "Animation / Motion"
    if any(x in slug for x in ("calendar", "whatsapp", "server", "scheduled", "termin")):
        return "Integrationen / Automation"
    if any(x in slug for x in ("research", "search", "youtube")):
        return "Research / Analyse"
    if any(x in slug for x in ("carousel", "instagram", "reel", "video", "ads", "content", "voice", "deck")):
        return "Content / Marketing"
    if any(x in slug for x in ("debug", "refactor", "review", "commit", "explain", "plan")):
        return "Entwicklungs-Workflow"
    return "Sonstige"


_SKILL_DISPLAY_NAMES = {
    "ad-grader": "Ad-Bewertung",
    "ads-meta": "Meta-Ads-Audit",
    "agent-control-reel": "Agent-Control-Reel",
    "angebot-erstellen": "Angebot erstellen",
    "animated-component-libraries": "Animierte Komponenten-Bibliotheken",
    "markenlook": "Design-Vorlagen echter Marken",
    "bulk-creative": "Creative-Varianten im Paket",
    "calendar-add": "Termin anlegen",
    "carousel-alex": "Alex-Karussell",
    "carousel-builder": "Karussell konzipieren",
    "carousel-image2": "Karussell mit Bildmodell",
    "carousel-render": "Karussell rendern",
    "code-review": "Code-Review",
    "commit": "Commit vorbereiten",
    "competitor-ads-extractor": "Wettbewerber-Ads auswerten",
    "content-research-writer": "Recherchegestützter Content",
    "crm-update": "CRM aktualisieren",
    "daily-log-format": "Daily Log",
    "debug": "Debugging",
    "deck-voice": "Stimme",
    "deep-research": "Marktforschung",
    "denzer-deploy": "Denzer-Deployment",
    "design-motion-principles": "Motion-Design-Prinzipien",
    "explain": "Erklären",
    "framer-motion-core": "Framer Motion: Kernfunktionen",
    "framer-motion-gestures": "Framer Motion: Gesten",
    "framer-motion-layout": "Framer Motion: Layout",
    "framer-motion-react": "Framer Motion: React",
    "framer-motion-scroll": "Framer Motion: Scroll",
    "framer-motion-variants": "Framer Motion: Varianten",
    "gsap-core": "GSAP: Kernfunktionen",
    "gsap-frameworks": "GSAP: Frameworks",
    "gsap-performance": "GSAP: Performance",
    "gsap-plugins": "GSAP: Plugins",
    "gsap-react": "GSAP: React",
    "gsap-scrolltrigger": "GSAP: ScrollTrigger",
    "gsap-timeline": "GSAP: Timelines",
    "gsap-utils": "GSAP: Hilfsfunktionen",
    "health-coach": "Health-Coach",
    "image-render": "Bild rendern",
    "impeccable": "Design-Feinschliff",
    "infopane-style": "InfoPane-Stil",
    "instagram-post": "Instagram posten",
    "job-prompt-format": "Job-Format",
    "learning-log": "Lernakte",
    "lottie-animations": "Lottie-Animationen",
    "mobile-perf-check": "Mobile-Performance prüfen",
    "motion-design": "Motion Design",
    "musk-algorithm": "Musk-Algorithmus",
    "onboarding": "Onboarding",
    "person-context": "Personenkontext",
    "plan": "Planen",
    "radar-research": "Recherche",
    "react-spring-physics": "React Spring: Physik",
    "reels-pipeline": "Reel-Pipeline",
    "refactor": "Refactoring",
    "scheduled-oneshot": "WhatsApp-Timer",
    "scroll-reveal-libraries": "Scroll-Reveal-Bibliotheken",
    "search": "Suche",
    "spot": "Ad-Live-Monitoring",
    "taste": "Geschmack",
    "termin-aus-kommunikation": "Termin aus Nachricht",
    "ui-ux-pro-max": "UI/UX-System wählen",
    "video-prompt-builder": "Video-Prompt bauen",
    "voice-dna": "Stimm-DNA",
    "watch-video": "Video ansehen",
    "whatsapp-send": "WhatsApp senden",
    "workshop-reel": "Workshop-Reel",
    "youtube-transcript": "YouTube-Transkript",
}


def _skill_display_name(slug: str, fallback: str) -> str:
    return _SKILL_DISPLAY_NAMES.get(slug) or (fallback or slug).replace("-", " ").strip().title()


def _skill_usage_stats() -> dict[str, dict[str, Any]]:
    """Aggregiert Skill-Runs aus dem bestehenden Workflow-Tracker."""
    try:
        with get_db() as db:
            rows = db.execute(
                """SELECT workflow_key, subject_ref, status, review_status, review_message,
                          created_at, review_json
                   FROM workflow_runs
                   WHERE workflow_key LIKE 'skill.%' OR subject_type='skill'"""
            ).fetchall()
    except Exception:
        return {}

    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        workflow_key = str(row[0] or "")
        subject_ref = str(row[1] or "")
        slug = subject_ref or (workflow_key[6:] if workflow_key.startswith("skill.") else "")
        slug = slug.strip()
        if not slug:
            continue
        stat = out.setdefault(slug, {
            "runs": 0,
            "successes": 0,
            "errors": 0,
            "warnings": 0,
            "lastAt": None,
            "lastStatus": "",
            "lastReviewStatus": "",
            "lastReviewMessage": "",
            "score": None,
            "needsHardening": False,
        })
        stat["runs"] += 1
        status = str(row[2] or "")
        review_status = str(row[3] or "")
        if status == "done" and review_status not in ("error", "warning"):
            stat["successes"] += 1
        if status == "error" or review_status == "error":
            stat["errors"] += 1
        if review_status == "warning":
            stat["warnings"] += 1
        created_at = float(row[5] or 0)
        if created_at and (not stat["lastAt"] or created_at > float(stat["lastAt"] or 0)):
            stat["lastAt"] = created_at
            stat["lastStatus"] = status
            stat["lastReviewStatus"] = review_status
            stat["lastReviewMessage"] = str(row[4] or "")
            try:
                review = json.loads(row[6] or "{}")
                score = review.get("metrics", {}).get("overall_score")
                stat["score"] = int(score) if score is not None else None
            except Exception:
                stat["score"] = None
    for stat in out.values():
        stat["needsHardening"] = bool(stat["errors"] or stat["warnings"])
    return out


def _get_skills(agent_id_or_ws=None, limit: int | None = None) -> list:
    """Skills aus dem lokalen skills/-Verzeichnis, kategorisiert nach skills/INDEX.md."""
    from server import PROJECT_ROOT
    skills_dir = PROJECT_ROOT / "skills"
    if not skills_dir.is_dir():
        return []
    index_exact, index_wildcards, category_order = _skill_index_meta()
    usage_stats = _skill_usage_stats()
    order_rank = {name: i for i, name in enumerate(category_order)}
    result = []
    for d in sorted(skills_dir.iterdir()):
        if not d.is_dir() or d.name.startswith(("_", ".")):
            continue
        spec = d / "SKILL.md"
        if not spec.exists():
            continue
        slug = d.name
        name = slug
        description = ""
        index_description = ""
        category = ""
        fm: dict[str, Any] = {}
        security: dict[str, Any] = {}
        try:
            text = spec.read_text(errors="replace")
            fm = _skill_frontmatter(text)
            security = scan_text("skill", str(spec), text)
            name = str(fm.get("name") or name)
            description = str(fm.get("description") or "")
            meta = index_exact.get(slug)
            if not meta:
                meta = next((m for prefix, m in index_wildcards if slug.startswith(prefix)), None)
            if meta:
                category = meta.get("category", "")
                index_description = meta.get("indexDescription", "")
            description = index_description or description or _skill_first_paragraph(text)
        except Exception:
            pass
        if not category:
            category = _fallback_skill_category(slug)
        name = _skill_display_name(slug, name)
        description = _strip_skill_md(description)
        if len(description) > 260:
            description = description[:257].rstrip() + "..."
        try:
            file_count = sum(1 for fp in d.rglob("*") if fp.is_file())
        except Exception:
            file_count = 1
        usage = usage_stats.get(slug, {
            "runs": 0,
            "successes": 0,
            "errors": 0,
            "warnings": 0,
            "lastAt": None,
            "lastStatus": "",
            "lastReviewStatus": "",
            "lastReviewMessage": "",
            "score": None,
            "needsHardening": False,
        })
        result.append({
            "name": name,
            "slug": slug,
            "path": str(spec),
            "directory": str(d),
            "description": description,
            "category": category,
            "categoryRank": order_rank.get(category, 999),
            "fileCount": file_count,
            "usage": usage,
            "manifest": _build_skill_manifest(slug, fm, spec, description, category, file_count, usage, security),
            "source": "agent",
            "always": False,
        })
        if limit is not None and len(result) >= limit:
            break
    result.sort(key=lambda s: (s.get("categoryRank", 999), s.get("category", ""), s.get("slug", s.get("name", ""))))
    return result


# ── Skills ──

@router.get("/api/skills")
async def skills_index():
    skills = _get_skills()
    categories: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}
    for skill in skills:
        cat = skill.get("category") or "Sonstige"
        group = seen.get(cat)
        if not group:
            group = {"name": cat, "rank": skill.get("categoryRank", 999), "count": 0, "runs": 0, "needsHardening": 0}
            seen[cat] = group
            categories.append(group)
        group["count"] += 1
        usage = skill.get("usage") if isinstance(skill.get("usage"), dict) else {}
        group["runs"] += int(usage.get("runs") or 0)
        if usage.get("needsHardening"):
            group["needsHardening"] += 1
        manifest = skill.get("manifest") if isinstance(skill.get("manifest"), dict) else {}
        if manifest.get("status") != "ready":
            group["manifestOpen"] = int(group.get("manifestOpen") or 0) + 1
    categories.sort(key=lambda c: (c.get("rank", 999), c.get("name", "")))
    return JSONResponse({"skills": skills, "categories": categories})


def _manifest_registry_summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    statuses: dict[str, int] = {}
    missing: dict[str, int] = {}
    warnings = 0
    for item in items:
        manifest = item.get("manifest") if isinstance(item.get("manifest"), dict) else {}
        status = str(manifest.get("status") or "missing")
        statuses[status] = statuses.get(status, 0) + 1
        warnings += len(manifest.get("warnings") or [])
        for key in manifest.get("missing") or []:
            k = str(key)
            missing[k] = missing.get(k, 0) + 1
    top_missing = [
        {"field": field, "count": count}
        for field, count in sorted(missing.items(), key=lambda kv: (-kv[1], kv[0]))[:12]
    ]
    return {
        "total": len(items),
        "statuses": statuses,
        "warnings": warnings,
        "topMissing": top_missing,
    }


def _job_governance_summary(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    statuses: dict[str, int] = {}
    open_checks: dict[str, int] = {}
    owners: dict[str, int] = {}
    for job in jobs:
        owner = str(job.get("owner") or "ohne Owner")
        owners[owner] = owners.get(owner, 0) + 1
        governance = job.get("governance") if isinstance(job.get("governance"), dict) else {}
        status = str(governance.get("status") or "missing")
        statuses[status] = statuses.get(status, 0) + 1
        for check in governance.get("checks") or []:
            if not isinstance(check, dict) or check.get("status") == "ok":
                continue
            code = str(check.get("code") or "unknown")
            open_checks[code] = open_checks.get(code, 0) + 1
    top_open = sorted(open_checks.items(), key=lambda kv: kv[1], reverse=True)[:8]
    return {
        "total": len(jobs),
        "statuses": statuses,
        "enabled": sum(1 for job in jobs if job.get("enabled")),
        "withLastRun": sum(1 for job in jobs if float(job.get("lastRunAt") or 0) > 0),
        "owners": [{"owner": owner, "count": count} for owner, count in sorted(owners.items(), key=lambda kv: (-kv[1], kv[0]))],
        "topOpen": [{"code": code, "count": count} for code, count in top_open],
    }


def _proposal_severity_rank(severity: str) -> int:
    return {"blocked": 0, "warn": 1, "info": 2}.get(severity, 3)


_BIBLIOTHEKAR_STALE_SEC = 7 * 86400


def _bibliothekar_state_path() -> Path:
    import server
    return server.PROJECT_ROOT / "data" / "skill-bibliothekar" / "state.json"


def _load_bibliothekar_state() -> dict[str, Any]:
    state_path = _bibliothekar_state_path()
    try:
        if state_path.exists():
            data = json.loads(state_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[skill-bibliothekar] state read failed: {e}", flush=True)
    return {}


def _save_bibliothekar_state(state: dict[str, Any]) -> None:
    state_path = _bibliothekar_state_path()
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as e:
        print(f"[skill-bibliothekar] state write failed: {e}", flush=True)


def _bibliothekar_proposal_fingerprint(proposal: dict[str, Any]) -> str:
    payload = {
        "severity": proposal.get("severity"),
        "code": proposal.get("code"),
        "title": proposal.get("title"),
        "reason": proposal.get("reason"),
        "action": proposal.get("action"),
        "fields": proposal.get("fields") or [],
    }
    return hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def _bibliothekar_hidden(entry: dict[str, Any], *, now: float) -> bool:
    hidden_until = float(entry.get("hiddenUntil") or 0)
    if hidden_until and hidden_until > now:
        return True
    return str(entry.get("decisionStatus") or "") in {"dismiss", "dismissed", "done"}


def _bibliothekar_ping_reasons(
    proposal: dict[str, Any],
    entry: dict[str, Any],
    *,
    is_new: bool,
    first_scan: bool,
    now: float,
) -> list[str]:
    reasons: list[str] = []
    severity = str(proposal.get("severity") or "")
    code = str(proposal.get("code") or "")
    first_seen = float(entry.get("firstSeenAt") or now)
    age_sec = max(0.0, now - first_seen)

    if severity == "blocked" and not entry.get("pingedBlockedAt"):
        reasons.append("blockiert")
    if is_new and not first_scan and not entry.get("pingedNewAt"):
        reasons.append("neu")
    if age_sec >= _BIBLIOTHEKAR_STALE_SEC and not entry.get("pingedStaleAt"):
        reasons.append("seit 7 Tagen offen")
    if code in {"writes_without_approval", "schedule_inactive", "context_freshness_missing"} and is_new and not first_scan and not entry.get("pingedDecisionAt"):
        reasons.append("braucht Entscheidung")
    return reasons


def _annotate_bibliothekar_proposals(proposals: list[dict[str, Any]], persist: bool = True) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    now = time.time()
    state = _load_bibliothekar_state()
    first_scan = not bool(state.get("createdAt"))
    if first_scan:
        state["createdAt"] = now
    seen = state.setdefault("proposals", {})
    if not isinstance(seen, dict):
        seen = {}
        state["proposals"] = seen

    open_ids: list[str] = []
    for proposal in proposals:
        pid = str(proposal.get("id") or "").strip()
        if not pid:
            continue
        open_ids.append(pid)
        entry = seen.get(pid)
        is_new = not isinstance(entry, dict)
        if is_new:
            entry = {
                "firstSeenAt": now,
                "baseline": bool(first_scan),
            }
            seen[pid] = entry
        first_seen = float(entry.get("firstSeenAt") or now)
        entry["lastSeenAt"] = now
        entry["lastSeverity"] = str(proposal.get("severity") or "")
        entry["lastCode"] = str(proposal.get("code") or "")
        entry["targetSlug"] = str(proposal.get("targetSlug") or "")
        fingerprint = _bibliothekar_proposal_fingerprint(proposal)
        if entry.get("fingerprint") and entry.get("fingerprint") != fingerprint:
            entry.pop("decisionStatus", None)
            entry.pop("decisionAt", None)
            entry.pop("decisionNote", None)
            entry.pop("hiddenUntil", None)
            entry.pop("pingedNewAt", None)
            entry.pop("pingedDecisionAt", None)
            is_new = not first_scan
        entry["fingerprint"] = fingerprint

        reasons = _bibliothekar_ping_reasons(proposal, entry, is_new=is_new, first_scan=first_scan, now=now)
        age_days = round(max(0.0, now - first_seen) / 86400, 1)
        proposal["firstSeenAt"] = first_seen
        proposal["ageDays"] = age_days
        proposal["isNew"] = bool(is_new and not first_scan)
        proposal["decisionStatus"] = str(entry.get("decisionStatus") or "")
        proposal["hiddenUntil"] = float(entry.get("hiddenUntil") or 0) or None
        proposal["hidden"] = _bibliothekar_hidden(entry, now=now)
        proposal["pingReasons"] = reasons
        proposal["pingEligible"] = bool(reasons) and not proposal["hidden"]

    state["lastScanAt"] = now
    state["openIds"] = open_ids
    if persist:
        _save_bibliothekar_state(state)
    return proposals, state


def _bibliothekar_ping_summary(proposals: list[dict[str, Any]]) -> dict[str, Any]:
    eligible = [p for p in proposals if p.get("pingEligible")]
    reasons: dict[str, int] = {}
    for proposal in eligible:
        for reason in proposal.get("pingReasons") or []:
            key = str(reason)
            reasons[key] = reasons.get(key, 0) + 1
    return {
        "eligibleCount": len(eligible),
        "reasons": [{"label": k, "count": v} for k, v in sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))],
        "policyLabel": "Ping bei neu, blockierend, seit 7 Tagen offen oder echter Entscheidung.",
        "channel": "Klaus",
    }


def _mark_bibliothekar_pinged(state: dict[str, Any], proposals: list[dict[str, Any]]) -> None:
    now = time.time()
    seen = state.setdefault("proposals", {})
    for proposal in proposals:
        pid = str(proposal.get("id") or "")
        entry = seen.get(pid)
        if not isinstance(entry, dict):
            continue
        entry["lastPingAt"] = now
        for reason in proposal.get("pingReasons") or []:
            if reason == "blockiert":
                entry["pingedBlockedAt"] = now
            elif reason == "neu":
                entry["pingedNewAt"] = now
            elif reason == "seit 7 Tagen offen":
                entry["pingedStaleAt"] = now
            elif reason == "braucht Entscheidung":
                entry["pingedDecisionAt"] = now
    state["lastPingAt"] = now
    _save_bibliothekar_state(state)


def _format_bibliothekar_ping(proposals: list[dict[str, Any]], total_open: int) -> str:
    selected = proposals[:5]
    count = len(proposals)
    label = "Punkt" if count == 1 else "Punkte"
    lines = []
    for proposal in selected:
        reasons = ", ".join(str(r) for r in (proposal.get("pingReasons") or [])) or "prüfen"
        fields = proposal.get("fields") or []
        field_hint = f" · fehlt: {', '.join(str(f) for f in fields[:3])}" if fields else ""
        lines.append(
            f"- {proposal.get('targetSlug')}: {proposal.get('title')} ({reasons}){field_hint}"
        )
    if count > len(selected):
        lines.append(f"- plus {count - len(selected)} weitere")

    return (
        f"**Systemagent-Hinweis: Werkstatt braucht deine Entscheidung**\n\n"
        f"**Was:**\n" + "\n".join(lines) + "\n\n"
        f"**Warum:** Insgesamt sind {total_open} Pflegepunkte offen; gepingt wird nur bei neu, blockierend, seit 7 Tagen offen oder echter Entscheidung.\n\n"
        "**Handlung:** Deine Entscheidung ist nötig: Soll ich die genannten Skill-Beipackzettel als Nächstes aufräumen, liegen lassen oder später wieder vorlegen?"
    )


def _manifest_curator_proposals(skills: list[dict[str, Any]], jobs: list[dict[str, Any]], limit: int = 24) -> list[dict[str, Any]]:
    """Build read-only curator proposals from the registry.

    This is intentionally a measuring loop, not an auto-writer. The proposal is
    the controlled handoff from registry/security/governance into human review.
    """
    proposals: list[dict[str, Any]] = []

    def add(
        target_kind: str,
        target_slug: str,
        path: str,
        severity: str,
        code: str,
        title: str,
        reason: str,
        action: str,
        fields: list[str] | None = None,
    ) -> None:
        proposals.append({
            "id": f"{target_kind}:{target_slug}:{code}",
            "targetKind": target_kind,
            "targetSlug": target_slug,
            "path": path,
            "severity": severity,
            "code": code,
            "title": title,
            "reason": reason,
            "action": action,
            "fields": fields or [],
            "applyMode": "manual",
        })

    for skill in skills:
        slug = str(skill.get("slug") or skill.get("name") or "")
        manifest = skill.get("manifest") if isinstance(skill.get("manifest"), dict) else {}
        usage = skill.get("usage") if isinstance(skill.get("usage"), dict) else {}
        path = str(skill.get("path") or manifest.get("path") or "")
        security = manifest.get("security") if isinstance(manifest.get("security"), dict) else {}
        missing = [str(x) for x in (manifest.get("missing") or [])]
        if security.get("status") == "blocked":
            add("skill", slug, path, "blocked", "security_blocked", "Skill blockiert", "Der Security Scan findet einen harten Regelverstoß.", "SKILL.md prüfen und riskante Stelle entfernen.")
        elif security.get("status") == "warn":
            add("skill", slug, path, "warn", "security_warn", "Skill prüfen", "Der Security Scan meldet eine mögliche Risiko-Stelle.", "Fundstelle lesen und Risiko im Manifest sauber deklarieren.")
        if missing:
            add("skill", slug, path, "warn", "manifest_missing", "Skill-Manifest ergänzen", "Der Skill ist noch nicht als gepflegtes Betriebsobjekt beschrieben.", "Fehlende Manifest-Felder in SKILL.md ergänzen.", missing[:8])
        if usage.get("needsHardening") and "risks" not in missing:
            add("skill", slug, path, "warn", "hardening", "Skill härten", "Vorherige Läufe hatten Fehler oder Warnungen.", "Risiko, Grenzen und Erfolgskriterium nachziehen.")

    for job in jobs:
        slug = str(job.get("id") or job.get("name") or "").removeprefix("local:")
        manifest = job.get("manifest") if isinstance(job.get("manifest"), dict) else {}
        governance = job.get("governance") if isinstance(job.get("governance"), dict) else {}
        path = str(job.get("promptPath") or manifest.get("path") or "")
        security = manifest.get("security") if isinstance(manifest.get("security"), dict) else {}
        missing = [str(x) for x in (manifest.get("missing") or [])]
        if security.get("status") == "blocked":
            add("job", slug, path, "blocked", "security_blocked", "Job blockiert", "Der Security Scan findet einen harten Regelverstoß.", "Prompt prüfen, riskante Stelle entfernen, dann erneut scannen.")
        elif security.get("status") == "warn":
            add("job", slug, path, "warn", "security_warn", "Job prüfen", "Der Security Scan meldet eine mögliche Risiko-Stelle.", "Fundstelle lesen und Freigabe-/Risiko-Regeln nachziehen.")
        if missing:
            add("job", slug, path, "warn", "manifest_missing", "Job-Manifest ergänzen", "Der Job hat noch keine vollständige Betriebsbeschreibung.", "Fehlende Frontmatter-Felder in prompt.md ergänzen.", missing[:8])
        for check in governance.get("checks") or []:
            if not isinstance(check, dict) or check.get("status") == "ok":
                continue
            code = str(check.get("code") or "governance_open")
            add("job", slug, path, str(check.get("status") or "warn"), code, "Job-Governance offen", str(check.get("message") or "Governance braucht Prüfung."), "Frontmatter oder Zeitplan so ergänzen, dass der Check grün wird.")

    proposals.sort(key=lambda p: (_proposal_severity_rank(str(p.get("severity"))), str(p.get("targetKind")), str(p.get("targetSlug")), str(p.get("code"))))
    return proposals[:limit]


def _skill_bundle_candidates(skills: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for skill in skills:
        category = str(skill.get("category") or "Sonstige")
        grouped.setdefault(category, []).append(skill)
    bundles = []
    for category, items in grouped.items():
        if len(items) < 3:
            continue
        open_count = 0
        for item in items:
            manifest = item.get("manifest") if isinstance(item.get("manifest"), dict) else {}
            if manifest.get("status") != "ready":
                open_count += 1
        bundles.append({
            "category": category,
            "skillCount": len(items),
            "openManifestCount": open_count,
            "skills": [str(item.get("slug") or item.get("name") or "") for item in items[:10]],
            "action": "Als Bundle prüfen: gemeinsame Inputs, Outputs, Permissions und Risiken vereinheitlichen.",
        })
    bundles.sort(key=lambda b: (-int(b["openManifestCount"]), -int(b["skillCount"]), str(b["category"])))
    return bundles[:limit]


@router.get("/api/manifest-registry")
async def manifest_registry():
    """Read-only registry for the first Skill/Job manifest pass."""
    import server
    skills = _get_skills()
    jobs = server._get_local_jobs("main")
    return JSONResponse({
        "status": "ok",
        "mode": "read-only",
        "skills": skills,
        "jobs": jobs,
        "summary": {
            "skills": _manifest_registry_summary(skills),
            "jobs": _manifest_registry_summary(jobs),
        },
    })


@router.get("/api/job-governance")
async def job_governance():
    """Read-only job governance overview. It measures; it does not block runs."""
    import server
    jobs = server._get_local_jobs("main")
    launchd = server._klaus_launchd_inventory({str(job.get("id") or "").removeprefix("local:") for job in jobs})
    return JSONResponse({
        "status": "ok",
        "mode": "read-only",
        "summary": _job_governance_summary(jobs),
        "launchd": launchd,
        "jobs": [{
            "id": job.get("id"),
            "name": job.get("name"),
            "owner": job.get("owner"),
            "purpose": job.get("purpose"),
            "enabled": job.get("enabled"),
            "schedule": job.get("schedule"),
            "promptPath": job.get("promptPath"),
            "runsLogPath": job.get("runsLogPath"),
            "logPath": job.get("logPath"),
            "lastOutputPath": job.get("lastOutputPath"),
            "lastRunAt": job.get("lastRunAt"),
            "lastRunStatus": job.get("lastRunStatus"),
            "manifest": job.get("manifest"),
            "governance": job.get("governance"),
        } for job in jobs],
    })


def _skill_bibliothekar_payload() -> dict[str, Any]:
    """Read-only maintenance loop for skills, jobs and bundle candidates."""
    import server
    skills = _get_skills()
    jobs = server._get_local_jobs("main")
    launchd = server._klaus_launchd_inventory({str(job.get("id") or "").removeprefix("local:") for job in jobs})
    all_proposals, _state = _annotate_bibliothekar_proposals(_manifest_curator_proposals(skills, jobs))
    proposals = [p for p in all_proposals if not p.get("hidden")]
    return {
        "status": "ok",
        "name": "Skill-Bibliothekar",
        "mode": "read-only",
        "reviewSurface": "infopane.systemagent.werkstatt",
        "reviewSurfaceLabel": "InfoPane > Systemagent > Werkstatt",
        "notificationPolicy": "Status im Systemagent; Ping im Klaus-Channel nur bei neu, blockierend, seit 7 Tagen offen oder echter Entscheidung.",
        "pingPolicy": {
            "channel": "klaus-channel",
            "staleDays": 7,
            "rules": ["neu", "blockierend", "seit 7 Tagen offen", "braucht Entscheidung"],
        },
        "pingSummary": _bibliothekar_ping_summary(proposals),
        "proposalCount": len(proposals),
        "totalOpenCount": len(all_proposals),
        "proposals": proposals,
        "bundleCandidates": _skill_bundle_candidates(skills),
        "summary": {
            "registry": {
                "skills": _manifest_registry_summary(skills),
                "jobs": _manifest_registry_summary(jobs),
            },
            "governance": _job_governance_summary(jobs),
            "launchd": launchd,
        },
    }


@router.get("/api/skill-bibliothekar")
async def skill_bibliothekar():
    """German API alias for the read-only skill maintenance loop."""
    return JSONResponse(_skill_bibliothekar_payload())


@router.get("/api/skill-curator")
async def skill_curator():
    """Backward-compatible alias for the read-only skill maintenance loop."""
    return JSONResponse(_skill_bibliothekar_payload())


@router.post("/api/skill-bibliothekar/decide")
async def skill_bibliothekar_decide(payload: dict = Body({})):
    """Merkt des Nutzers Review-Entscheidung für einen Bibliothekar-Hinweis.

    Body: {id: str, action: "done"|"dismiss"|"snooze"}. Es werden keine Skills
    geändert; die Entscheidung blendet nur diesen Hinweis aus, bis er sich
    inhaltlich ändert oder die Snooze-Zeit abläuft.
    """
    import server
    proposal_id = str(payload.get("id") or "").strip()
    action = str(payload.get("action") or "").strip().lower()
    if not proposal_id:
        return JSONResponse({"ok": False, "error": "id-required"}, status_code=400)
    if action not in {"done", "dismiss", "snooze"}:
        return JSONResponse({"ok": False, "error": "action must be done, dismiss or snooze"}, status_code=400)

    skills = _get_skills()
    jobs = server._get_local_jobs("main")
    proposals, state = _annotate_bibliothekar_proposals(_manifest_curator_proposals(skills, jobs))
    proposal = next((p for p in proposals if str(p.get("id") or "") == proposal_id), None)
    if not proposal:
        return JSONResponse({"ok": False, "error": "proposal-not-found"}, status_code=404)

    now = time.time()
    seen = state.setdefault("proposals", {})
    if not isinstance(seen, dict):
        seen = {}
        state["proposals"] = seen
    entry = seen.setdefault(proposal_id, {})
    if not isinstance(entry, dict):
        entry = {}
        seen[proposal_id] = entry
    entry["decisionStatus"] = action
    entry["decisionAt"] = now
    entry["decisionNote"] = {
        "done": "geprüft",
        "dismiss": "ignoriert",
        "snooze": "später",
    }[action]
    if action == "snooze":
        entry["hiddenUntil"] = now + _BIBLIOTHEKAR_STALE_SEC
    else:
        entry.pop("hiddenUntil", None)
    _save_bibliothekar_state(state)
    return JSONResponse({
        "ok": True,
        "id": proposal_id,
        "status": action,
        "hiddenUntil": entry.get("hiddenUntil"),
    })


@router.post("/api/skill-bibliothekar/ping")
async def skill_bibliothekar_ping(payload: dict = Body({})):
    """Sendet bei pingwürdigen Bibliothekar-Punkten eine Klaus-Channel-Frage.

    Body: {dryRun?: bool, force?: bool}. Ohne pingwürdigen Grund bleibt der
    Endpunkt still und gibt nur `posted: false` zurück.
    """
    import server
    dry_run = bool(payload.get("dryRun") or payload.get("dry_run"))
    force = bool(payload.get("force"))
    skills = _get_skills()
    jobs = server._get_local_jobs("main")
    proposals, state = _annotate_bibliothekar_proposals(_manifest_curator_proposals(skills, jobs))
    active = [p for p in proposals if not p.get("hidden")]
    eligible = [p for p in active if p.get("pingEligible")]
    if force and not eligible:
        eligible = active[:1]
        for proposal in eligible:
            proposal["pingReasons"] = ["manuell angefragt"]
    if not eligible:
        return JSONResponse({
            "posted": False,
            "reason": "no-pingworthy-proposals",
            "proposalCount": len(active),
            "totalOpenCount": len(proposals),
            "pingSummary": _bibliothekar_ping_summary(active),
        })

    text = _format_bibliothekar_ping(eligible, len(active))
    dedupe_src = ",".join(str(p.get("id") or "") for p in eligible[:8])
    dedupe_key = "skill-bibliothekar:" + hashlib.sha1(dedupe_src.encode("utf-8")).hexdigest()[:14]
    if dry_run:
        return JSONResponse({
            "posted": False,
            "dryRun": True,
            "text": text,
            "dedupeKey": dedupe_key,
            "proposalCount": len(active),
            "totalOpenCount": len(proposals),
            "pingCount": len(eligible),
        })

    try:
        from modules.klaus_channel.core import KLAUS_CHANNEL_AGENT, KLAUS_CHANNEL_ID, post
        result = post(
            text=text,
            source="skill-bibliothekar",
            dedupe_key=dedupe_key,
            force=force,
            cooldown_sec=6 * 3600,
        )
        if result.get("posted"):
            _mark_bibliothekar_pinged(state, eligible)
            try:
                from streaming import broadcast_sync
                await broadcast_sync(KLAUS_CHANNEL_AGENT, KLAUS_CHANNEL_ID)
            except Exception as e:
                print(f"[skill-bibliothekar] broadcast failed: {e}", flush=True)
        result.update({
            "proposalCount": len(active),
            "totalOpenCount": len(proposals),
            "pingCount": len(eligible),
            "dedupeKey": dedupe_key,
        })
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"posted": False, "reason": f"post-failed: {e}"}, status_code=500)


@router.get("/api/security-scan")
async def security_scan(path: str, kind: str = "context"):
    import server
    p = server._resolve_path(path)
    if not p.exists() or not p.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    if not server._is_allowed_path(p):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    resolved = p.resolve()
    sensitive_names = {".env", ".netrc", "credentials.json", "token.json"}
    if resolved.name in sensitive_names or resolved.name.startswith(".env"):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    return JSONResponse(scan_path(kind, p))


def _get_recent_files(ws: Path, limit: int = 5) -> list:
    files = []
    for fp in ws.rglob("*.md"):
        rel = fp.relative_to(ws)
        parts = rel.parts
        if parts[0] in ('memory', 'tmp', '_legacy', '.git', 'shared', 'node_modules'):
            continue
        if fp.name in ('BRAIN.md', 'IDENTITY.md', 'SOUL.md', 'AGENTS.md'):
            continue
        try:
            files.append({"name": fp.name, "path": str(fp), "modified": fp.stat().st_mtime})
        except Exception:
            pass
    files.sort(key=lambda f: f["modified"], reverse=True)
    return files[:limit]


def _get_agent_recent_messages(agent_id: str, limit: int = 6) -> list:
    with get_db() as db:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            """SELECT m.author, m.content, m.ts, m.conversation_id, c.title
               FROM messages m
               LEFT JOIN conversations c ON c.id = m.conversation_id
               WHERE m.agent = ? AND m.content != '' AND m.author != 'Du'
               ORDER BY m.ts DESC
               LIMIT ?""",
            (agent_id, limit),
        ).fetchall()
    items = []
    for row in rows:
        content = " ".join(str(row["content"] or "").split())
        if len(content) > 240:
            content = content[:239].rstrip() + "…"
        items.append({
            "author": row["author"] or "",
            "content": content,
            "ts": row["ts"] or 0,
            "conversationId": row["conversation_id"] or "",
            "title": row["title"] or "Chat",
        })
    return items


@router.get("/api/agent-detail")
async def agent_detail(agent: str = 'main'):
    import server
    profile = get_agent_profile(agent)
    agent = profile["id"]
    # Fuer der Nutzer ist alles Klaus. Das gesamte System ist aus Klaus entstanden,
    # in Unteragents (claude, wolf, eva, alex ...) gebrancht und holistisch wieder
    # zu Klaus zusammengefuehrt. Der main-Agent zaehlt darum die gesamte Historie.
    today_start = time.mktime(time.strptime(time.strftime('%Y-%m-%d'), '%Y-%m-%d'))
    with get_db() as db:
        if agent == 'main':
            total = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            today = db.execute("SELECT COUNT(*) FROM messages WHERE ts >= ?", (today_start,)).fetchone()[0]
            last_msg = db.execute("SELECT ts FROM messages ORDER BY ts DESC LIMIT 1").fetchone()
        else:
            total = db.execute("SELECT COUNT(*) FROM messages WHERE agent = ?", (agent,)).fetchone()[0]
            today = db.execute("SELECT COUNT(*) FROM messages WHERE agent = ? AND ts >= ?", (agent, today_start)).fetchone()[0]
            last_msg = db.execute("SELECT ts FROM messages WHERE agent = ? ORDER BY ts DESC LIMIT 1", (agent,)).fetchone()

    stats = {"total": total, "today": today, "lastActive": last_msg[0] if last_msg else 0}

    ws_raw = profile.get("workspace") or server.AGENTS.get(agent, {}).get("workspace")
    ws = server._resolve_path(str(ws_raw)) if ws_raw else None
    if not ws or not ws.exists():
        return JSONResponse({"error": f"Agent '{agent}' hat keinen Workspace"}, status_code=404)

    brain = server._read_md_file(ws / "BRAIN.md")
    identity = server._read_md_file(Path(profile["rules_path"])) if profile.get("rules_path") else ""
    soul = server._read_md_file(Path(profile["soul_path"])) if profile.get("soul_path") else ""

    return JSONResponse({
        "agent": agent,
        "name": profile.get("name", agent),
        "color": profile.get("color", "#888"),
        "model": server._get_agent_model(agent),
        "role": server._extract_identity_short(soul or identity),
        "brain": brain,
        "identity": identity,
        "soul": soul,
        "stats": stats,
        "crons": server._get_local_jobs(agent),
        "skills": _get_skills(ws),
        "recentMessages": _get_agent_recent_messages(agent),
        "recentFiles": _get_recent_files(ws),
        "workspace": str(ws),
        "files": {
            "brain": str(ws / "BRAIN.md"),
            "identity": str(profile.get("rules_path") or ""),
            "soul": str(profile.get("soul_path") or ""),
            "agents": str(profile.get("rules_path") or ""),
        }
    })


# ── Briefings ──

@router.get("/api/briefings")
async def get_briefings():
    """Return the latest message per tag (for briefing cards in InfoPane)."""
    with get_db() as db:
        rows = db.execute("""
            SELECT m.id, m.agent, m.author, m.content, m.ts, m.tags, m.conversation_id
            FROM messages m
            INNER JOIN (
                SELECT tags, MAX(ts) as max_ts FROM messages WHERE tags != '' GROUP BY tags
            ) latest ON m.tags = latest.tags AND m.ts = latest.max_ts
            ORDER BY m.ts DESC
        """).fetchall()
    return JSONResponse([
        {"id": r[0], "agent": r[1], "author": r[2], "content": r[3], "ts": r[4], "tag": r[5], "conversationId": r[6]}
        for r in rows
    ])


# ── Forward to Claude Code ──

@router.post("/api/forward-to-claude")
async def forward_to_claude(request: Request):
    """Forward a message from one chat into the Claude Code conversation."""
    body = await request.json()
    text = body.get("text", "")
    author = body.get("author", "Klaus")
    if not text.strip():
        return JSONResponse({"error": "empty"}, status_code=400)

    from db import get_channel_id
    from streaming import broadcast_sync
    conv_id = get_channel_id("claude")
    ts = time.time()
    with get_db() as db:
        db.execute(
            "INSERT INTO messages (agent, project, author, content, ts, conversation_id, tools) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("claude", "", f"↗ {author}", text, ts, conv_id, "[]")
        )
        db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (ts, conv_id))
    await broadcast_sync("claude", conv_id)
    return JSONResponse({"ok": True, "ts": ts})


# ── Local Job CRUD ──

@router.get("/api/local-job")
async def local_job_get(id: str):
    import server
    prompt_file = server._resolve_local_job_path(id)
    if prompt_file is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    _, body = server._split_prompt_file(prompt_file)
    meta = server._parse_job_frontmatter(prompt_file)
    slug = prompt_file.parent.name
    return JSONResponse({
        "id": f"local:{slug}",
        "slug": slug,
        "name": meta.get("name", slug),
        "schedule": meta.get("schedule", ""),
        "promptBody": body,
        "promptPath": str(prompt_file),
    })


@router.put("/api/local-job")
async def local_job_update(req: Request):
    import server
    body = await req.json()
    prompt_file = server._resolve_local_job_path(body.get("id", ""))
    if prompt_file is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    new_body = body.get("promptBody")
    if not isinstance(new_body, str):
        return JSONResponse({"error": "promptBody required"}, status_code=400)
    fm, _ = server._split_prompt_file(prompt_file)
    tail = new_body.rstrip("\n") + "\n"
    prompt_file.write_text(fm + tail, encoding="utf-8")
    return JSONResponse({"ok": True})


@router.get("/api/cron-runs")
async def cron_runs(id: str, limit: int = 10):
    """Stub: bisher Gateway-RPC, jetzt lokale Jobs ohne strukturiertes Run-Log."""
    return JSONResponse({"entries": []})


@router.get("/api/project-plan")
async def get_project_plan(path: str = ""):
    """Read PLAN.md for a project directory."""
    if not path:
        return JSONResponse({"error": "path required"}, status_code=400)
    plan = Path(path) / "PLAN.md"
    if not plan.exists():
        return JSONResponse({"content": None, "path": str(plan)})
    return JSONResponse({"content": plan.read_text(), "path": str(plan)})


@router.put("/api/project-plan")
async def update_project_plan(request: Request):
    """Update PLAN.md for a project directory."""
    import server
    body = await request.json()
    path = body.get("path", "").strip()
    content = body.get("content", "")
    if not path:
        return JSONResponse({"error": "path required"}, status_code=400)
    plan = Path(path) / "PLAN.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(content)
    index_file(str(plan), content, server.SOURCES)
    return JSONResponse({"ok": True, "path": str(plan)})
