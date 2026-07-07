"""Executors for the first Tool Broker cuts."""
from __future__ import annotations

import difflib
import hashlib
from html.parser import HTMLParser
import ipaddress
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, OpenerDirector, Request, build_opener

from engines import engine_profiles, runtime_engine_ids
from engines.discovery import scan_engines
from engines.deployment_readiness import deployment_readiness_manifest
from engines.install_readiness import install_readiness_manifest
from engines.process_guard import scan_engine_processes
from engines.value_flywheel import value_flywheel_manifest
from security.secret_broker import secret_broker
from security.secret_zones import (
    ALLOWED_SHELL_CWD_ROOTS,
    SHELL_BLOCKED_ROOT_TOKENS,
    SHELL_HIDDEN_DIR_DENIES,
    SHELL_NETWORK_COMMANDS,
    SHELL_NETWORK_EXFIL_FLAGS,
    SHELL_OPERATORS,
    shell_policy,
    token_has_hidden_or_sensitive_path,
    has_hidden_or_sensitive_path,
)

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS_DIR = ROOT / "work" / "artifacts"
KNOWLEDGE_DIR = ROOT / "work" / "agent-control" / "knowledge"
USER_ROOT = Path.home().resolve()
TMP_ROOT = Path("/tmp")

BLOCKED_PARTS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
}
BLOCKED_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    "id_rsa",
    "id_ed25519",
    "known_hosts",
}
BLOCKED_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx"}
MAX_READ_BYTES = 80_000
MAX_WRITE_BYTES = 250_000
MAX_PATCH_BYTES = 500_000
MAX_SHELL_OUTPUT_BYTES = 80_000
MAX_SHELL_TIMEOUT_SECONDS = 120
MAX_WEB_FETCH_BYTES = 120_000
MAX_KNOWLEDGE_TEXT_CHARS = 40_000
MAX_CODE_BYTES = 80_000
MAX_CODE_OUTPUT_BYTES = 80_000
MAX_CODE_TIMEOUT_SECONDS = 60
MAX_SEARCH_RESULTS = 80
SHELL_NETWORK_URL_RE = re.compile(r"\b(?:https?|ftp|sftp)://", re.IGNORECASE)
SECRET_TEXT_MARKERS = (
    "api_key",
    "apikey",
    "openai_api_key",
    "anthropic_api_key",
    "google_api_key",
    "gemini_api_key",
    "xai_api_key",
    "access_token",
    "refresh_token",
    "auth_token",
    "bearer ",
    "client_secret",
    "private_key",
    "secret_key",
    "secret=",
    "token=",
    "password=",
)
SHELL_SANDBOX = shutil.which("sandbox-exec") or ""
_SHELL_SANDBOX_PROBE: tuple[bool, str] | None = None
TAILSCALE = shutil.which("tailscale") or ""
NETWORK_POLICY_FILE = ROOT / "work" / "agent-control" / "security" / "network-policy.json"
AGENT_CONFIG_FILE = ROOT / "config" / "agents.json"
AGENT_PROFILE_ROOT = ROOT / "agents"
JOBS_DIR = ROOT / "jobs"
MEMORY_DIR = ROOT / "brain"
ADMIN_RECIPES_DIR = ROOT / "work" / "agent-control" / "admin-recipes"
DRAFTS_DIR = ROOT / "work" / "agent-control" / "drafts"
MCP_CONFIG_CANDIDATES = (
    ROOT / ".mcp.json",
    ROOT / "config" / "mcp.json",
    ROOT / "work" / "agent-control" / "security" / "mcp-policy.json",
)
PROTECTED_WRITE_PATHS = (
    ROOT / "backend" / "tools",
    ROOT / "backend" / "engines" / "runtime_policy.py",
    ROOT / "scripts" / "agent-control-tool.py",
    ROOT / "scripts" / "agent-control-capability-benchmark.py",
    ROOT / "work" / "agent-control" / "security",
)


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        raise PermissionError("url_redirect_blocked")


_NO_REDIRECT_OPENER: OpenerDirector = build_opener(_NoRedirectHandler)


class _PageTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.description = ""
        self.text_parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        if lowered in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if lowered == "title":
            self._in_title = True
            return
        if lowered == "meta":
            data = {str(k).lower(): str(v or "") for k, v in attrs}
            name = (data.get("name") or data.get("property") or "").lower()
            if name in {"description", "og:description", "twitter:description"} and data.get("content") and not self.description:
                self.description = data["content"].strip()

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if lowered == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        text = " ".join(str(data or "").split())
        if not text:
            return
        if self._in_title:
            self.title_parts.append(text)
            return
        if self._skip_depth:
            return
        self.text_parts.append(text)


def _resolve_project_path(raw: str) -> Path:
    candidate = Path(str(raw or "")).expanduser()
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise PermissionError("path_outside_project") from exc
    lowered_parts = {part.lower() for part in resolved.parts}
    if lowered_parts & BLOCKED_PARTS:
        raise PermissionError("blocked_path_part")
    if resolved.name in BLOCKED_NAMES or resolved.suffix.lower() in BLOCKED_SUFFIXES:
        raise PermissionError("blocked_sensitive_file")
    if any(part.startswith(".") and part not in {".agents"} for part in resolved.relative_to(ROOT).parts):
        raise PermissionError("hidden_path_blocked")
    return resolved


def _ensure_workspace_write_allowed(path: Path) -> None:
    resolved = path.resolve()
    protected = tuple(item.resolve() for item in PROTECTED_WRITE_PATHS)
    if any(resolved == item or item in resolved.parents for item in protected):
        raise PermissionError("protected_write_path")


def _artifact_type(path: Path) -> str:
    if path.suffix.lower() == ".html":
        return "html"
    if path.suffix.lower() == ".md":
        return "markdown"
    return path.suffix.lower().lstrip(".") or "file"


def agent_identity(_: dict[str, Any]) -> dict[str, Any]:
    agent_id = "main"
    profile = "klaus"
    agent_name = "Klaus"
    if AGENT_CONFIG_FILE.exists():
        try:
            config = json.loads(AGENT_CONFIG_FILE.read_text(encoding="utf-8"))
            agent_id = str(config.get("active") or config.get("default") or agent_id)
            agents = config.get("agents") if isinstance(config.get("agents"), dict) else {}
            agent_cfg = agents.get(agent_id) if isinstance(agents.get(agent_id), dict) else {}
            profile = str(agent_cfg.get("profile") or agent_id or profile)
            agent_name = str(agent_cfg.get("name") or profile or agent_name)
        except (json.JSONDecodeError, OSError):
            agent_id = "main"
            profile = "klaus"
            agent_name = "Klaus"
    soul = AGENT_PROFILE_ROOT / profile / "SOUL.md"
    summary = ""
    if soul.exists():
        text = soul.read_text(encoding="utf-8", errors="replace")
        summary = "\n".join(line for line in text.splitlines() if line.startswith(("# ", "## ", "- ")))[:4000]
    return {
        "agent": agent_name,
        "agent_id": agent_id,
        "profile": profile,
        "profile_path": str((AGENT_PROFILE_ROOT / profile).relative_to(ROOT)),
        "identity_file": str(soul.relative_to(ROOT)) if soul.exists() else "",
        "summary": summary,
    }


def agent_capability_matrix(_: dict[str, Any]) -> dict[str, Any]:
    dimensions = [
        {
            "id": "identity",
            "label": "Agent-Identität und Profil",
            "state": "green",
            "ours": "Aktives Profil, SOUL/AGENTS und lokaler Kontext sind vorhanden.",
            "target": "Pro Kunde klar getrennte Identität, Tonalität, Grenzen und Rollen.",
        },
        {
            "id": "tool_broker",
            "label": "Sicherer Tool-Broker",
            "state": "green",
            "ours": "50 Tools laufen über Broker, Gateway, Capability-Token, Approval und Audit.",
            "target": "Alle Werkzeuge immer über denselben geprüften Weg, egal welches Modell ausführt.",
        },
        {
            "id": "sandbox",
            "label": "Code- und Shell-Sandbox",
            "state": "green",
            "ours": "Code-Run, Shell-Policy, Secret-Zonen, Netzwerk- und Redirect-Guard sind aktiv.",
            "target": "Hermes/OpenHands-Niveau: isolierte Laufzeit pro Task, keine Host-Secrets, klare Limits.",
        },
        {
            "id": "human_approval",
            "label": "Human-in-the-loop",
            "state": "green",
            "ours": "Riskante Tools fragen Approval, externe Sends bleiben draft/geschlossen.",
            "target": "Für Kunden: Freigabe bei Geld, Versand, Kalender, CRM und produktiven Writes.",
        },
        {
            "id": "memory",
            "label": "Gedächtnis und Wissen",
            "state": "yellow",
            "ours": "Lokales Memory und Kontextsuche existieren; Kunden-KB braucht klarere Namespaces.",
            "target": "Mandantengetrennte Wissensräume mit Quellen, Ablaufwissen und Löschbarkeit.",
        },
        {
            "id": "knowledge_ingest",
            "label": "Quellen in Workspace-Wissen verwandeln",
            "state": "green",
            "ours": "URLs werden über den Broker geholt, bereinigt und als Markdown/JSON mit Quelle, Hash und Vorschau abgelegt.",
            "target": "Perplexity-artige Recherche, aber lokal besitzbar, auditierbar und wiederverwendbar im Kunden-Workspace.",
        },
        {
            "id": "multi_agent",
            "label": "Multi-Agent-Orchestrierung",
            "state": "yellow",
            "ours": "Mehrere Engines sind verdrahtet, aber kein dauerhaftes Rollen-/Task-Graph-System.",
            "target": "Claude/AutoGen/CrewAI-Muster: Planner, Worker, Reviewer, Verifier als kontrollierte Rollen.",
        },
        {
            "id": "durable_workflows",
            "label": "Dauerhafte Workflows",
            "state": "yellow",
            "ours": "Jobs und Agent-Control-Loops existieren; Wiederaufnahme und State-Migration sind noch dünn.",
            "target": "LangGraph-Muster: pausieren, fortsetzen, auditieren, nach Fehler exakt weiterlaufen.",
        },
        {
            "id": "connectors",
            "label": "Kunden-Connectoren",
            "state": "yellow",
            "ours": "Mail, WhatsApp, Kalender, MCP und Module sind als Tools sichtbar, teils bewusst geschlossen.",
            "target": "Pro Kunde sichere Connector-Pakete mit Secrets nur über Broker-Handles.",
        },
        {
            "id": "process_governor",
            "label": "Prozess-Governor",
            "state": "yellow",
            "ours": "Bypass-Prozesse werden erkannt und als Quarantäne-Befund gemeldet.",
            "target": "Freigabe-gestütztes Aufräumen, keine hängenden Agent-Prozesse mit Direktrechten.",
        },
        {
            "id": "observability",
            "label": "Beobachtung und Kosten",
            "state": "yellow",
            "ours": "Audit und Benchmark sind da; Kosten, Latenz und Erfolgsquote pro Kunde fehlen als Dashboard.",
            "target": "Klare Metriken: Laufzeit, Kosten, Toolrisiko, Erfolgsrate, manuelle Eingriffe.",
        },
        {
            "id": "evals",
            "label": "Evals und Regressionen",
            "state": "green",
            "ours": "Capability-Benchmark läuft lokal und prüft Security, Sandbox, Gateway und Tools.",
            "target": "Kunden-spezifische Aufgaben-Suites plus Sicherheits-Fixtures vor jedem Release.",
        },
        {
            "id": "product_surface",
            "label": "Kundentaugliche Oberfläche",
            "state": "yellow",
            "ours": "Workspace und Artefakte existieren; Admin-/Approval-/Agent-Graph-Ansicht ist noch nicht rund.",
            "target": "Ein einfaches Cockpit: Ziele, Wissen, Freigaben, Läufe, Ergebnisse.",
        },
    ]
    gaps = [item for item in dimensions if item["state"] != "green"]
    return {
        "score": {
            "green": sum(1 for item in dimensions if item["state"] == "green"),
            "yellow": sum(1 for item in dimensions if item["state"] == "yellow"),
            "red": sum(1 for item in dimensions if item["state"] == "red"),
            "total": len(dimensions),
        },
        "dimensions": dimensions,
        "next_build_order": [item["id"] for item in gaps[:4]],
        "github_reference_patterns": [
            {"project": "OpenHands", "pattern": "sandboxed autonomous coding agent"},
            {"project": "LangGraph", "pattern": "durable workflows and human-in-the-loop state"},
            {"project": "Microsoft AutoGen", "pattern": "multi-agent collaboration"},
            {"project": "CrewAI", "pattern": "role-based agent crews"},
        ],
    }


def agent_install_readiness(_: dict[str, Any]) -> dict[str, Any]:
    return install_readiness_manifest()


def agent_deployment_readiness(_: dict[str, Any]) -> dict[str, Any]:
    return deployment_readiness_manifest()


def agent_value_flywheel(_: dict[str, Any]) -> dict[str, Any]:
    return value_flywheel_manifest()


def engine_list(_: dict[str, Any]) -> dict[str, Any]:
    profiles = engine_profiles()
    installed = scan_engines()
    return {
        "runtime": list(runtime_engine_ids()),
        "installed": sorted(installed),
        "profiles": [
            {
                "id": profile.id,
                "label": profile.label,
                "kind": profile.kind,
                "provider": profile.provider,
                "runtime": profile.runtime,
                "available": profile.id in installed,
                "default_model": profile.default_model,
                "models": sorted(profile.models),
            }
            for profile in profiles.values()
        ],
    }


def model_list(_: dict[str, Any]) -> dict[str, Any]:
    profiles = engine_profiles()
    models = []
    seen: set[tuple[str, str]] = set()
    for profile in profiles.values():
        for model in sorted(profile.models):
            key = (profile.provider, model)
            if key in seen:
                continue
            seen.add(key)
            models.append(
                {
                    "model": model,
                    "provider": profile.provider,
                    "engine": profile.id,
                    "runtime": profile.runtime,
                    "default": model == profile.default_model,
                }
            )
    return {"models": models, "count": len(models)}


def engine_switch(arguments: dict[str, Any]) -> dict[str, Any]:
    engine = str(arguments.get("engine") or arguments.get("id") or "").strip()
    if not engine:
        raise ValueError("engine_missing")
    profiles = engine_profiles()
    if engine not in profiles:
        raise ValueError("engine_unknown")
    return {
        "engine": engine,
        "known": True,
        "applied": False,
        "reason": "engine_switch_requires_chat_session_integration",
    }


def secret_manifest(_: dict[str, Any]) -> dict[str, Any]:
    return secret_broker.manifest()


def secret_classify_path(arguments: dict[str, Any]) -> dict[str, Any]:
    return secret_broker.classify_path(str(arguments.get("path") or ""))


def artifact_list(arguments: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(arguments.get("limit") or 50), 200))
    suffixes = {".html", ".md", ".pdf", ".png", ".jpg", ".jpeg", ".json"}
    items = []
    if ARTIFACTS_DIR.exists():
        for path in sorted(ARTIFACTS_DIR.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
            if not path.is_file() or path.suffix.lower() not in suffixes:
                continue
            st = path.stat()
            items.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "type": _artifact_type(path),
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                }
            )
            if len(items) >= limit:
                break
    return {"artifacts": items, "count": len(items)}


def artifact_write(arguments: dict[str, Any]) -> dict[str, Any]:
    name = str(arguments.get("name") or arguments.get("path") or "").strip()
    content = arguments.get("content")
    if not name:
        raise ValueError("artifact_name_missing")
    if "/" in name or "\\" in name or name.startswith("."):
        raise PermissionError("artifact_name_invalid")
    if not isinstance(content, str):
        raise ValueError("content_must_be_string")
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("content_too_large")
    path = (ARTIFACTS_DIR / name).resolve()
    try:
        path.relative_to(ARTIFACTS_DIR.resolve())
    except ValueError as exc:
        raise PermissionError("artifact_outside_dir") from exc
    if path.suffix.lower() not in {".html", ".md", ".json", ".txt"}:
        raise PermissionError("artifact_suffix_not_allowed")
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    before = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    path.write_text(content, encoding="utf-8")
    return {
        "path": str(path),
        "created": not bool(before),
        "bytes": len(content.encode("utf-8")),
        **_diff_text(path, before, content),
    }


def _run_git(args: list[str], timeout: int = 10) -> dict[str, Any]:
    git_env = dict(os.environ)
    git_env.update({
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "XDG_CONFIG_HOME": "/tmp",
    })
    completed = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        env=git_env,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    return {
        "return_code": int(completed.returncode),
        "stdout": stdout[:80_000],
        "stderr": stderr[:20_000],
        "truncated": len(stdout.encode("utf-8", errors="replace")) > 80_000,
    }


def git_status(arguments: dict[str, Any]) -> dict[str, Any]:
    porcelain = bool(arguments.get("porcelain", True))
    args = ["status", "--short"] if porcelain else ["status"]
    return _run_git(args)


def git_diff(arguments: dict[str, Any]) -> dict[str, Any]:
    path = str(arguments.get("path") or "").strip()
    args = ["diff", "--stat"]
    if path:
        _resolve_project_path(path)
        args.extend(["--", path])
    return _run_git(args)


def git_show(arguments: dict[str, Any]) -> dict[str, Any]:
    ref = str(arguments.get("ref") or "HEAD").strip()
    if not ref or any(item in ref for item in ("\n", "\r", "--")):
        raise PermissionError("git_ref_invalid")
    return _run_git(["show", "--stat", "--oneline", "--no-renames", ref], timeout=10)


def _git_paths(arguments: dict[str, Any]) -> list[str]:
    raw = arguments.get("paths") or arguments.get("path") or []
    if isinstance(raw, str):
        paths = [raw]
    elif isinstance(raw, list):
        paths = [str(item) for item in raw]
    else:
        raise ValueError("paths_invalid")
    if not paths:
        raise ValueError("paths_missing")
    safe = []
    for path in paths:
        resolved = _resolve_project_path(path)
        safe.append(str(resolved.relative_to(ROOT)))
    return safe


def git_add(arguments: dict[str, Any]) -> dict[str, Any]:
    paths = _git_paths(arguments)
    result = _run_git(["add", "--", *paths], timeout=10)
    return {"paths": paths, **result}


def git_commit(arguments: dict[str, Any]) -> dict[str, Any]:
    message = str(arguments.get("message") or "").strip()
    if not message:
        raise ValueError("commit_message_missing")
    if "\n" in message or len(message) > 200:
        raise ValueError("commit_message_invalid")
    return _run_git(["commit", "-m", message], timeout=30)


def git_branch(arguments: dict[str, Any]) -> dict[str, Any]:
    action = str(arguments.get("action") or "list").strip().lower()
    name = str(arguments.get("name") or "").strip()
    if action == "list":
        return _run_git(["branch", "--list"], timeout=10)
    if action not in {"create", "switch"}:
        raise ValueError("branch_action_invalid")
    if not name or any(ch in name for ch in (" ", "\n", "\r", "~", "^", ":", "?", "*", "[", "\\")) or name.startswith("-"):
        raise ValueError("branch_name_invalid")
    args = ["switch", "-c", name] if action == "create" else ["switch", name]
    return _run_git(args, timeout=15)


def _search_paths(query: str, roots: list[Path], limit: int) -> dict[str, Any]:
    if not query.strip():
        raise ValueError("query_missing")
    if len(query) > 200:
        raise ValueError("query_too_long")
    safe_roots = []
    for root in roots:
        resolved = root.resolve()
        try:
            resolved.relative_to(ROOT)
        except ValueError:
            continue
        if resolved.exists():
            safe_roots.append(str(resolved.relative_to(ROOT)))
    if not safe_roots:
        return {"query": query, "matches": [], "count": 0}
    rg = shutil.which("rg")
    if not rg:
        raise RuntimeError("rg_unavailable")
    completed = subprocess.run(
        [
            rg,
            "--json",
            "--fixed-strings",
            "--case-sensitive",
            "--max-count",
            str(max(1, min(limit, MAX_SEARCH_RESULTS))),
            "--glob",
            "!**/.*/**",
            "--glob",
            "!**/node_modules/**",
            "--glob",
            "!**/*.db",
            "--glob",
            "!**/*.sqlite*",
            query,
            *safe_roots,
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
    )
    secret_markers = [str(item).lower() for item in secret_broker.manifest().get("markers", [])] + list(SECRET_TEXT_MARKERS)
    blocked_names = {str(item).lower() for item in BLOCKED_NAMES}
    matches = []
    for line in (completed.stdout or "").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("type") != "match":
            continue
        data = item.get("data") or {}
        path = str((data.get("path") or {}).get("text") or "")
        try:
            _resolve_project_path(path)
        except PermissionError:
            continue
        text = str((data.get("lines") or {}).get("text") or "").strip()[:500]
        lowered_text = text.lower()
        if any(marker and marker in lowered_text for marker in secret_markers):
            continue
        if any(name and name in lowered_text for name in blocked_names):
            continue
        matches.append(
            {
                "path": path,
                "line": int(data.get("line_number") or 0),
                "text": text,
            }
        )
        if len(matches) >= limit:
            break
    return {"query": query, "matches": matches, "count": len(matches), "return_code": completed.returncode}


def context_search(arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "")
    limit = max(1, min(int(arguments.get("limit") or 30), MAX_SEARCH_RESULTS))
    roots = [ROOT / "agents", ROOT / "brain", ROOT / "skills", ROOT / "work" / "agent-control"]
    return _search_paths(query, roots, limit)


def _parse_skill_frontmatter(text: str) -> dict[str, Any]:
    """Liest die YAML-artige Frontmatter einer SKILL.md ohne yaml-Dependency.

    Erkennt name, description, category als Skalare und triggers als Liste.
    """
    meta: dict[str, Any] = {"name": "", "description": "", "category": "", "triggers": []}
    if not text.startswith("---"):
        return meta
    end = text.find("\n---", 3)
    if end == -1:
        return meta
    block = text[3:end]
    current_list_key: str | None = None
    for raw in block.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()
        if current_list_key and stripped.startswith("- "):
            meta[current_list_key].append(stripped[2:].strip().strip("'\""))
            continue
        current_list_key = None
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key == "triggers" and not value:
            current_list_key = "triggers"
            meta["triggers"] = []
        elif key in {"name", "description", "category"}:
            meta[key] = value
    return meta


def skill_search(arguments: dict[str, Any]) -> dict[str, Any]:
    """Durchsucht skills/*/SKILL.md nach Name, Beschreibung und Triggern.

    Ohne query werden alle Skills gelistet. Mit query wird case-insensitiv
    ueber Slug, Beschreibung und Trigger gematcht und nach Relevanz sortiert.
    Gibt pro Treffer den klickbaren Repo-Pfad zur SKILL.md zurueck, damit der
    dokumentierte Weg (Endpunkte, Ablauf) sofort auffindbar ist.
    """
    query = str(arguments.get("query") or "").strip().lower()
    limit = max(1, min(int(arguments.get("limit") or 20), 60))
    skills_dir = ROOT / "skills"
    results: list[dict[str, Any]] = []
    if not skills_dir.is_dir():
        return {"query": query, "matches": []}
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta = _parse_skill_frontmatter(text)
        slug = meta.get("name") or skill_md.parent.name
        rel = skill_md.relative_to(ROOT).as_posix()
        haystacks = [
            (str(slug).lower(), 3),
            (str(meta.get("description") or "").lower(), 2),
            (" ".join(meta.get("triggers") or []).lower(), 2),
            (skill_md.parent.name.lower(), 3),
        ]
        score = 0
        if query:
            for hay, weight in haystacks:
                if query in hay:
                    score += weight
            if score == 0:
                continue
        results.append({
            "name": slug,
            "description": meta.get("description") or "",
            "category": meta.get("category") or "",
            "triggers": meta.get("triggers") or [],
            "path": rel,
            "score": score,
        })
    results.sort(key=lambda r: (-r["score"], r["name"]))
    return {"query": query, "count": len(results[:limit]), "matches": results[:limit]}


def _network_policy() -> dict[str, Any]:
    data: dict[str, Any] = {
        "version": 1,
        "allowed_schemes": ["https"],
        "allow_http_localhost": False,
        "allow_private_networks": False,
        "allow_tailnet": False,
        "tailnet_suffixes": [".ts.net"],
        "max_fetch_bytes": MAX_WEB_FETCH_BYTES,
        "blocked_host_markers": ["metadata.google.internal", "169.254.169.254"],
    }
    if NETWORK_POLICY_FILE.exists():
        try:
            loaded = json.loads(NETWORK_POLICY_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            loaded = {}
        if isinstance(loaded, dict):
            data.update(loaded)
    return data


def _is_tailnet_host(host: str, policy: dict[str, Any]) -> bool:
    lowered = host.lower()
    suffixes = [str(item).lower() for item in policy.get("tailnet_suffixes") or []]
    if any(lowered.endswith(suffix) for suffix in suffixes):
        return True
    try:
        ip = ipaddress.ip_address(lowered)
    except ValueError:
        return False
    return ip in ipaddress.ip_network("100.64.0.0/10")


def _guard_fetch_url(url: str, policy: dict[str, Any]) -> tuple[str, str]:
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").strip().lower()
    if not scheme or not host:
        raise PermissionError("url_invalid")
    allowed_schemes = {str(item).lower() for item in policy.get("allowed_schemes") or []}
    if scheme not in allowed_schemes:
        if not (scheme == "http" and host in {"localhost", "127.0.0.1", "::1"} and policy.get("allow_http_localhost")):
            raise PermissionError("url_scheme_blocked")
    if any(marker and marker in host for marker in policy.get("blocked_host_markers") or []):
        raise PermissionError("url_host_blocked")
    allow_private = bool(policy.get("allow_private_networks"))
    allow_tailnet = bool(policy.get("allow_tailnet"))
    infos = socket.getaddrinfo(host, parsed.port or (443 if scheme == "https" else 80), type=socket.SOCK_STREAM)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        is_tailnet = ip in ipaddress.ip_network("100.64.0.0/10") or _is_tailnet_host(host, policy)
        if is_tailnet:
            if allow_tailnet:
                continue
            raise PermissionError("url_tailnet_blocked")
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            if not allow_private:
                raise PermissionError("url_private_network_blocked")
    return scheme, host


def web_fetch(arguments: dict[str, Any]) -> dict[str, Any]:
    url = str(arguments.get("url") or "").strip()
    if not url:
        raise ValueError("url_missing")
    policy = _network_policy()
    scheme, host = _guard_fetch_url(url, policy)
    max_bytes = max(1, min(int(arguments.get("max_bytes") or policy.get("max_fetch_bytes") or MAX_WEB_FETCH_BYTES), MAX_WEB_FETCH_BYTES))
    request = Request(url, headers={"User-Agent": "Agent-Control-Broker/1.0"})
    started = time.time()
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=10) as response:
            body = response.read(max_bytes + 1)
            headers = dict(response.headers.items())
            status = int(getattr(response, "status", 0) or 0)
    except HTTPError as exc:
        body = exc.read(max_bytes + 1)
        headers = dict(exc.headers.items())
        status = int(exc.code)
    except URLError as exc:
        raise ConnectionError(f"web_fetch_failed:{exc.reason}") from exc
    content_type = headers.get("Content-Type", "")
    text = body[:max_bytes].decode("utf-8", errors="replace")
    return {
        "url": url,
        "scheme": scheme,
        "host": host,
        "status": status,
        "content_type": content_type,
        "elapsed_ms": int((time.time() - started) * 1000),
        "bytes": min(len(body), max_bytes),
        "truncated": len(body) > max_bytes,
        "text": text,
    }


def web_search(arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("query_missing")
    if len(query) > 200:
        raise ValueError("query_too_long")
    return {
        "query": query,
        "results": [],
        "count": 0,
        "status": "search_provider_not_configured",
    }


def _clean_page_text(raw: str, content_type: str) -> tuple[str, str, str]:
    if "html" not in content_type.lower():
        text = "\n".join(line.strip() for line in raw.splitlines() if line.strip())
        return "", "", text[:MAX_KNOWLEDGE_TEXT_CHARS]
    parser = _PageTextParser()
    parser.feed(raw)
    title = " ".join(" ".join(parser.title_parts).split())
    description = " ".join(parser.description.split())
    text = " ".join(" ".join(parser.text_parts).split())
    return title, description, text[:MAX_KNOWLEDGE_TEXT_CHARS]


def _slugify(text: str, fallback: str = "source") -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return (cleaned or fallback)[:72].strip("-") or fallback


def _markdown_quote(text: str, limit: int = 2400) -> str:
    clipped = text[:limit].strip()
    if not clipped:
        return "_Kein lesbarer Text extrahiert._"
    return clipped.replace("\r\n", "\n")


def knowledge_ingest(arguments: dict[str, Any]) -> dict[str, Any]:
    url = str(arguments.get("url") or "").strip()
    if not url:
        raise ValueError("url_missing")
    fetched = web_fetch({"url": url, "max_bytes": arguments.get("max_bytes") or MAX_WEB_FETCH_BYTES})
    title, description, text = _clean_page_text(str(fetched.get("text") or ""), str(fetched.get("content_type") or ""))
    parsed = urlparse(url)
    host = str(fetched.get("host") or parsed.hostname or "source")
    supplied_title = str(arguments.get("title") or "").strip()
    title = supplied_title or title or host
    notes = str(arguments.get("notes") or "").strip()
    content_hash = hashlib.sha256((url + "\n" + text).encode("utf-8", errors="replace")).hexdigest()
    basename = f"{_slugify(title or host, _slugify(host))}-{content_hash[:12]}"
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    md_path = (KNOWLEDGE_DIR / f"{basename}.md").resolve()
    json_path = (KNOWLEDGE_DIR / f"{basename}.json").resolve()
    for path in (md_path, json_path):
        try:
            path.relative_to(KNOWLEDGE_DIR.resolve())
        except ValueError as exc:
            raise PermissionError("knowledge_path_outside_root") from exc
    fetched_at = int(time.time())
    preview = description or text[:600].strip()
    metadata = {
        "url": url,
        "host": host,
        "title": title,
        "description": description,
        "content_hash": content_hash,
        "fetched_at": fetched_at,
        "status": fetched.get("status"),
        "content_type": fetched.get("content_type"),
        "bytes": fetched.get("bytes"),
        "truncated": fetched.get("truncated"),
        "notes": notes,
        "text": text,
    }
    md = (
        f"# {title}\n\n"
        f"- Quelle: {url}\n"
        f"- Host: {host}\n"
        f"- Abruf: {fetched_at}\n"
        f"- Hash: `{content_hash}`\n"
        f"- Status: {fetched.get('status')}\n\n"
        "## Kurzfassung\n\n"
        f"{preview or '_Keine Vorschau extrahiert._'}\n\n"
        + (f"## Notiz\n\n{notes}\n\n" if notes else "")
        + "## Bereinigter Auszug\n\n"
        f"{_markdown_quote(text)}\n"
    )
    before_md = md_path.read_text(encoding="utf-8", errors="replace") if md_path.exists() else ""
    md_path.write_text(md, encoding="utf-8")
    json_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "captured": True,
        "url": url,
        "host": host,
        "title": title,
        "path": str(md_path.relative_to(ROOT)),
        "json_path": str(json_path.relative_to(ROOT)),
        "content_hash": content_hash,
        "bytes": fetched.get("bytes"),
        "truncated": fetched.get("truncated"),
        "preview": preview[:600],
        **_diff_text(md_path, before_md, md),
    }


def tailscale_status(_: dict[str, Any]) -> dict[str, Any]:
    if not TAILSCALE:
        return {"installed": False, "running": False, "peers": 0}
    completed = subprocess.run([TAILSCALE, "status", "--json"], text=True, capture_output=True, timeout=8)
    if completed.returncode != 0:
        return {"installed": True, "running": False, "peers": 0, "error": (completed.stderr or completed.stdout).strip()[:500]}
    data = json.loads(completed.stdout or "{}")
    peers = data.get("Peer") if isinstance(data.get("Peer"), dict) else {}
    return {
        "installed": True,
        "running": True,
        "backend_state": data.get("BackendState", ""),
        "self_online": bool((data.get("Self") or {}).get("Online")),
        "peers": len(peers),
        "tailnet": data.get("CurrentTailnet", {}).get("Name", "") if isinstance(data.get("CurrentTailnet"), dict) else "",
    }


def file_list(arguments: dict[str, Any]) -> dict[str, Any]:
    path = _resolve_project_path(str(arguments.get("path") or "."))
    limit = max(1, min(int(arguments.get("limit") or 100), 500))
    if not path.exists():
        raise FileNotFoundError("directory_not_found")
    if not path.is_dir():
        raise NotADirectoryError("not_a_directory")
    items = []
    for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        try:
            safe = _resolve_project_path(str(child))
        except PermissionError:
            continue
        if child.name.startswith(".") or child.name in BLOCKED_NAMES:
            continue
        if child.suffix.lower() in BLOCKED_SUFFIXES:
            continue
        st = safe.stat()
        items.append(
            {
                "name": safe.name,
                "path": str(safe),
                "type": "folder" if safe.is_dir() else "file",
                "size": None if safe.is_dir() else st.st_size,
                "mtime": int(st.st_mtime),
            }
        )
        if len(items) >= limit:
            break
    return {"path": str(path), "items": items, "count": len(items)}


def file_read(arguments: dict[str, Any]) -> dict[str, Any]:
    path = _resolve_project_path(str(arguments.get("path") or ""))
    max_bytes = max(1, min(int(arguments.get("max_bytes") or MAX_READ_BYTES), MAX_READ_BYTES))
    if not path.exists():
        raise FileNotFoundError("file_not_found")
    if not path.is_file():
        raise IsADirectoryError("not_a_file")
    size = path.stat().st_size
    if size > max_bytes:
        content = path.read_bytes()[:max_bytes].decode("utf-8", errors="replace")
        truncated = True
    else:
        content = path.read_text(encoding="utf-8", errors="replace")
        truncated = False
    return {
        "path": str(path),
        "size": size,
        "truncated": truncated,
        "content": content,
    }


def file_search(arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "")
    limit = max(1, min(int(arguments.get("limit") or 50), MAX_SEARCH_RESULTS))
    raw_path = str(arguments.get("path") or ".")
    root = _resolve_project_path(raw_path)
    return _search_paths(query, [root], limit)


def _diff_text(path: Path, before: str, after: str, limit: int = 40_000) -> dict[str, Any]:
    rel = str(path.relative_to(ROOT))
    lines = list(difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"a/{rel}",
        tofile=f"b/{rel}",
    ))
    text = "".join(lines)
    return {
        "diff": text[:limit],
        "diff_truncated": len(text) > limit,
        "lines": len(lines),
    }


def file_write(arguments: dict[str, Any]) -> dict[str, Any]:
    path = _resolve_project_path(str(arguments.get("path") or ""))
    _ensure_workspace_write_allowed(path)
    content = arguments.get("content")
    if not isinstance(content, str):
        raise ValueError("content_must_be_string")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_WRITE_BYTES:
        raise ValueError("content_too_large")
    parent = _resolve_project_path(str(path.parent))
    if not parent.exists() or not parent.is_dir():
        raise FileNotFoundError("parent_directory_not_found")
    if path.exists() and not path.is_file():
        raise IsADirectoryError("not_a_file")
    before = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    created = not path.exists()
    path.write_text(content, encoding="utf-8")
    diff = _diff_text(path, before, content)
    return {
        "path": str(path),
        "created": created,
        "bytes": len(encoded),
        **diff,
    }


def file_move(arguments: dict[str, Any]) -> dict[str, Any]:
    source = _resolve_project_path(str(arguments.get("source") or arguments.get("from") or ""))
    target = _resolve_project_path(str(arguments.get("target") or arguments.get("to") or ""))
    _ensure_workspace_write_allowed(source)
    _ensure_workspace_write_allowed(target)
    overwrite = bool(arguments.get("overwrite", False))
    if not source.exists() or not source.is_file():
        raise FileNotFoundError("source_file_not_found")
    if target.exists() and not overwrite:
        raise FileExistsError("target_exists")
    parent = _resolve_project_path(str(target.parent))
    if not parent.exists() or not parent.is_dir():
        raise FileNotFoundError("target_parent_not_found")
    before = target.read_text(encoding="utf-8", errors="replace") if target.exists() and target.is_file() else ""
    shutil.move(str(source), str(target))
    after = target.read_text(encoding="utf-8", errors="replace")
    return {"source": str(source), "target": str(target), "overwrote": bool(before), **_diff_text(target, before, after)}


def file_delete(arguments: dict[str, Any]) -> dict[str, Any]:
    path = _resolve_project_path(str(arguments.get("path") or ""))
    _ensure_workspace_write_allowed(path)
    if not path.exists():
        raise FileNotFoundError("file_not_found")
    if not path.is_file():
        raise IsADirectoryError("delete_file_only")
    size = path.stat().st_size
    path.unlink()
    return {"path": str(path), "deleted": True, "bytes": size}


def process_kill(arguments: dict[str, Any]) -> dict[str, Any]:
    pid = int(arguments.get("pid") or 0)
    dry_run = bool(arguments.get("dry_run", False))
    if pid <= 1:
        raise ValueError("pid_invalid")
    report = scan_engine_processes()
    unsafe = {int(item["pid"]): item for item in report.get("unsafe", []) if isinstance(item, dict) and item.get("pid")}
    if pid not in unsafe:
        raise PermissionError("process_not_in_guard_quarantine")
    target = unsafe[pid]
    if dry_run:
        return {"pid": pid, "killed": False, "dry_run": True, "target": target}
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        return {"pid": pid, "killed": False, "reason": "process_already_exited", "target": target}
    return {"pid": pid, "killed": True, "signal": "TERM", "target": target}


def _patch_paths(patch: str) -> set[str]:
    paths: set[str] = set()
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            for raw in parts[2:4]:
                if raw.startswith(("a/", "b/")):
                    paths.add(raw[2:])
        elif line.startswith(("--- ", "+++ ")):
            raw = line[4:].strip().split("\t", 1)[0]
            if raw != "/dev/null" and raw.startswith(("a/", "b/")):
                paths.add(raw[2:])
        elif line.startswith(("rename from ", "rename to ", "copy from ", "copy to ")):
            paths.add(line.split(" ", 2)[2].strip())
    return {p for p in paths if p and not p.startswith("/")}


def file_patch(arguments: dict[str, Any]) -> dict[str, Any]:
    patch = arguments.get("patch")
    if not isinstance(patch, str):
        raise ValueError("patch_must_be_string")
    if not patch.strip():
        raise ValueError("patch_empty")
    if len(patch.encode("utf-8")) > MAX_PATCH_BYTES:
        raise ValueError("patch_too_large")
    paths = sorted(_patch_paths(patch))
    if not paths:
        raise ValueError("patch_paths_missing")
    for rel in paths:
        _ensure_workspace_write_allowed(_resolve_project_path(rel))

    check = subprocess.run(
        ["git", "apply", "--check", "--whitespace=nowarn", "-"],
        cwd=ROOT,
        input=patch,
        text=True,
        capture_output=True,
        timeout=10,
    )
    if check.returncode != 0:
        raise ValueError(f"patch_check_failed:{(check.stderr or check.stdout).strip()[:500]}")
    applied = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", "-"],
        cwd=ROOT,
        input=patch,
        text=True,
        capture_output=True,
        timeout=10,
    )
    if applied.returncode != 0:
        raise ValueError(f"patch_apply_failed:{(applied.stderr or applied.stdout).strip()[:500]}")
    diff = subprocess.run(
        ["git", "diff", "--", *paths],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=10,
    )
    diff_text = diff.stdout or ""
    return {
        "paths": paths,
        "path_count": len(paths),
        "diff": diff_text[:40_000],
        "diff_truncated": len(diff_text) > 40_000,
    }


def _resolve_shell_cwd(raw: str | None) -> Path:
    if not raw:
        return ROOT
    candidate = Path(str(raw)).expanduser()
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    path = candidate.resolve()
    policy_roots = []
    for raw_root in shell_policy().get("allowed_cwd_roots") or []:
        try:
            policy_roots.append(Path(str(raw_root)).expanduser().resolve())
        except OSError:
            continue
    allowed_roots = tuple(policy_roots) or ALLOWED_SHELL_CWD_ROOTS
    if not any(path == root or root in path.parents for root in allowed_roots):
        raise PermissionError("cwd_outside_user_scope")
    if has_hidden_or_sensitive_path(path):
        raise PermissionError("cwd_sensitive_or_hidden")
    if not path.exists() or not path.is_dir():
        raise FileNotFoundError("cwd_not_found")
    return path


def _safe_shell_env() -> dict[str, str]:
    keep = {"HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR", "USER"}
    env = {key: value for key, value in os.environ.items() if key in keep and isinstance(value, str)}
    base_path = env.get("PATH") or "/usr/bin:/bin"
    preferred = ["/opt/homebrew/bin", "/usr/local/bin"]
    parts = [part for part in base_path.split(":") if part]
    env["PATH"] = ":".join(preferred + [part for part in parts if part not in preferred])
    return env


def _network_command_names() -> set[str]:
    return {str(item).strip() for item in SHELL_NETWORK_COMMANDS if str(item).strip()}


def _contains_shell_network_command(command: str, tokens: list[str]) -> bool:
    names = _network_command_names()
    if not names:
        return False
    if any(Path(token).name in names for token in tokens):
        return True
    pattern = r"(^|[^A-Za-z0-9_./-])(" + "|".join(re.escape(name) for name in sorted(names)) + r")([^A-Za-z0-9_-]|$)"
    return bool(re.search(pattern, command))


def _is_network_version_probe(tokens: list[str]) -> bool:
    if not tokens:
        return False
    names = _network_command_names()
    if Path(tokens[0]).name not in names:
        return False
    allowed = {"--version", "-V", "-v", "--help", "-h"}
    return any(token in allowed for token in tokens[1:]) and not any(SHELL_NETWORK_URL_RE.search(token) for token in tokens)


def _guard_shell_command(command: str) -> list[str]:
    lowered = command.lower()
    manifest = secret_broker.manifest()
    policy = shell_policy()
    denied_markers = [str(item).lower() for item in policy.get("denied_command_markers") or []]
    if any(marker and marker in lowered for marker in denied_markers):
        raise PermissionError("shell_policy_denied_marker")
    if any(marker in lowered for marker in manifest["markers"]):
        raise PermissionError("shell_sensitive_marker_blocked")
    if "/." in command or "~/." in command:
        raise PermissionError("shell_hidden_path_blocked")
    if "$(" in command or "`" in command or "<(" in command or ">(" in command:
        raise PermissionError("shell_dynamic_expansion_blocked")
    try:
        tokens = shlex.split(command)
    except ValueError as exc:
        raise ValueError("command_parse_failed") from exc
    if not tokens:
        raise ValueError("command_missing")
    if tokens and Path(tokens[0]).name in {"bash", "sh", "zsh"} and any(token in {"-c", "-lc", "-ic"} for token in tokens[1:]):
        raise PermissionError("shell_nested_command_blocked")
    if any(Path(token).name in SHELL_BLOCKED_ROOT_TOKENS for token in tokens):
        raise PermissionError("shell_root_escalation_blocked")
    allowed_first_commands = {str(item) for item in policy.get("allowed_first_commands") or []}
    if allowed_first_commands and tokens:
        first_command = Path(tokens[0]).name
        if first_command not in allowed_first_commands:
            raise PermissionError("shell_command_not_allowlisted")
    if any(token_has_hidden_or_sensitive_path(token) for token in tokens):
        raise PermissionError("shell_hidden_or_sensitive_path_blocked")
    network_positions = [index for index, token in enumerate(tokens) if Path(token).name in SHELL_NETWORK_COMMANDS]
    if network_positions:
        if not _is_network_version_probe(tokens):
            first_network_position = min(network_positions)
            if any(token in SHELL_NETWORK_EXFIL_FLAGS or any(token.startswith(f"{flag}=") for flag in SHELL_NETWORK_EXFIL_FLAGS) for token in tokens):
                raise PermissionError("shell_network_upload_blocked")
            if any(token.startswith("@") for token in tokens):
                raise PermissionError("shell_network_file_upload_blocked")
            if "|" in tokens and tokens.index("|") < first_network_position:
                raise PermissionError("shell_network_pipe_upload_blocked")
            if "<" in tokens and tokens.index("<") < first_network_position:
                raise PermissionError("shell_network_pipe_upload_blocked")
            raise PermissionError("shell_network_command_blocked")
    elif _contains_shell_network_command(command, tokens):
        raise PermissionError("shell_network_command_blocked")
    if any(token in SHELL_OPERATORS for token in tokens):
        raise PermissionError("shell_operator_blocked")
    first_command = Path(tokens[0]).name if tokens else ""
    if first_command in {"python", "python3", "node", "ruby", "perl", "php", "osascript"}:
        inline_flags = {"-c", "-e", "--eval", "-m", "-"}
        if len(tokens) < 2 or any(token in inline_flags for token in tokens[1:]):
            raise PermissionError("shell_interpreter_inline_blocked")
    return tokens


def _sandbox_profile() -> str:
    denies = []
    for name in SHELL_HIDDEN_DIR_DENIES:
        path = USER_ROOT / name
        denies.append(f'(deny file-read* file-write* (subpath "{path}"))')
    return "(version 1)(allow default)(deny network*)" + "".join(denies)


def _shell_sandbox_available() -> tuple[bool, str]:
    global _SHELL_SANDBOX_PROBE
    if not SHELL_SANDBOX:
        return (False, "sandbox_exec_missing")
    if _SHELL_SANDBOX_PROBE is not None:
        return _SHELL_SANDBOX_PROBE
    try:
        proc = subprocess.run(
            [SHELL_SANDBOX, "-p", "(version 1)(allow default)", "/usr/bin/true"],
            text=True,
            capture_output=True,
            timeout=2,
        )
        if proc.returncode == 0:
            _SHELL_SANDBOX_PROBE = (True, "")
        else:
            _SHELL_SANDBOX_PROBE = (False, (proc.stderr or proc.stdout or f"exit:{proc.returncode}").strip()[:240])
    except Exception as exc:  # noqa: BLE001
        _SHELL_SANDBOX_PROBE = (False, f"{type(exc).__name__}: {exc}"[:240])
    return _SHELL_SANDBOX_PROBE


def _code_sandbox_profile(workdir: Path) -> str:
    return (
        "(version 1)"
        "(allow default)"
        "(deny network*)"
        "(deny file-write*)"
        f'(deny file-read* file-write* (subpath "{USER_ROOT}"))'
        f'(allow file-read* file-write* (subpath "{workdir}"))'
    )


def _guard_code_text(code: str) -> None:
    lowered = code.lower()
    manifest = secret_broker.manifest()
    if any(marker in lowered for marker in manifest["markers"]):
        raise PermissionError("code_sensitive_marker_blocked")
    if any(item in lowered for item in ("~/.ssh", "~/.config", ".env", ".netrc", "id_rsa", "id_ed25519")):
        raise PermissionError("code_secret_path_blocked")
    if any(item in lowered for item in ("import subprocess", "from subprocess", "os.system", "pty.spawn", "socket.", "urllib.request", "http.client")):
        raise PermissionError("code_process_or_network_blocked")


def admin_recipe_list(_: dict[str, Any]) -> dict[str, Any]:
    items = []
    if ADMIN_RECIPES_DIR.exists():
        for path in sorted(ADMIN_RECIPES_DIR.iterdir(), key=lambda p: p.name.lower()):
            if path.is_file() and path.suffix.lower() in {".json", ".md", ".yaml", ".yml"} and not path.name.startswith("."):
                items.append({"name": path.stem, "path": str(path.relative_to(ROOT)), "type": path.suffix.lower().lstrip(".")})
    return {"recipes": items, "count": len(items)}


def admin_recipe_run(arguments: dict[str, Any]) -> dict[str, Any]:
    name = str(arguments.get("name") or "").strip()
    if not name or "/" in name or name.startswith("."):
        raise ValueError("recipe_name_invalid")
    return {"name": name, "ran": False, "reason": "admin_recipe_execution_not_connected"}


def job_list(arguments: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(arguments.get("limit") or 100), 200))
    items = []
    if JOBS_DIR.exists():
        for path in sorted(JOBS_DIR.iterdir(), key=lambda p: p.name.lower()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            prompt = path / "prompt.md"
            items.append(
                {
                    "name": path.name,
                    "path": str(path.relative_to(ROOT)),
                    "has_prompt": prompt.exists(),
                    "has_state": (path / "state").exists(),
                }
            )
            if len(items) >= limit:
                break
    return {"jobs": items, "count": len(items)}


def job_run(arguments: dict[str, Any]) -> dict[str, Any]:
    name = str(arguments.get("name") or "").strip()
    if not name or "/" in name or name.startswith("."):
        raise ValueError("job_name_invalid")
    path = (JOBS_DIR / name).resolve()
    try:
        path.relative_to(JOBS_DIR.resolve())
    except ValueError as exc:
        raise PermissionError("job_outside_root") from exc
    if not path.exists() or not path.is_dir():
        raise FileNotFoundError("job_not_found")
    return {"name": name, "ran": False, "reason": "job_execution_requires_named_recipe_allowlist"}


def mcp_list(_: dict[str, Any]) -> dict[str, Any]:
    configs = []
    servers = []
    for path in MCP_CONFIG_CANDIDATES:
        if not path.exists():
            continue
        configs.append(str(path.relative_to(ROOT)))
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        raw_servers = data.get("mcpServers") or data.get("servers") or {}
        if isinstance(raw_servers, dict):
            for name, value in raw_servers.items():
                servers.append({"name": str(name), "configured": isinstance(value, dict)})
    return {"configs": configs, "servers": servers, "count": len(servers)}


def mcp_call(arguments: dict[str, Any]) -> dict[str, Any]:
    server = str(arguments.get("server") or "").strip()
    tool = str(arguments.get("tool") or "").strip()
    if not server or not tool:
        raise ValueError("mcp_target_missing")
    return {"server": server, "tool": tool, "called": False, "reason": "mcp_call_allowlist_not_connected"}


def module_call(arguments: dict[str, Any]) -> dict[str, Any]:
    module = str(arguments.get("module") or "").strip()
    action = str(arguments.get("action") or "").strip()
    if not module or not action:
        raise ValueError("module_target_missing")
    return {"module": module, "action": action, "called": False, "reason": "module_call_allowlist_not_connected"}


def werkbank_task_create(arguments: dict[str, Any]) -> dict[str, Any]:
    """Bewusster Werkbank-Spawn aus Klaus' Hand.

    Kein Stichwort-Trigger: Klaus zieht dieses Werkzeug bewusst, wenn im Gespraech
    Konsens fuer eine eigene Worker-Session gewachsen ist. Legt Worker-Chat,
    Werkbank-Task und Queue-Item an, indem es die fertige async-Spawn-Kette
    (spawn_work_session_from_request -> create_work_session_record) in einem
    isolierten Thread mit eigenem Event-Loop faehrt. Der Broker ruft Executors
    synchron im Server-Event-Loop auf; ein Self-HTTP-Call wuerde deadlocken, ein
    eigener Loop in einem frischen Thread (mit eigener threading.local-DB-Conn)
    nicht.
    """
    conv_id = str(
        arguments.get("parent_conversation_id")
        or arguments.get("conversation_id")
        or ""
    ).strip()
    brief = str(arguments.get("brief") or "").strip()
    if not conv_id:
        raise ValueError("parent_conversation_id_missing")
    if not brief:
        raise ValueError("brief_missing")
    title = str(arguments.get("title") or "").strip()
    acceptance = str(arguments.get("acceptance") or "").strip()
    project = str(arguments.get("project") or "").strip()
    agent_id = str(arguments.get("agent") or "main").strip() or "main"
    engine = str(arguments.get("engine") or "").strip()
    network_access = bool(arguments.get("networkAccess") or arguments.get("network_access") or arguments.get("requiresNetwork") or arguments.get("requires_network"))

    import asyncio
    import threading

    box: dict[str, Any] = {}

    def _worker() -> None:
        try:
            from streaming import spawn_work_session_from_request
            box["result"] = asyncio.run(
                spawn_work_session_from_request(
                    conv_id=conv_id,
                    brief=brief,
                    title=title,
                    acceptance=acceptance,
                    agent_id=agent_id,
                    project=project,
                    engine=engine,
                    network_access=network_access,
                )
            )
        except Exception as exc:  # noqa: BLE001
            box["error"] = f"{type(exc).__name__}: {exc}"

    thread = threading.Thread(target=_worker, name="werkbank-spawn", daemon=True)
    thread.start()
    thread.join(timeout=90)
    if thread.is_alive():
        raise RuntimeError("werkbank_spawn_timeout")
    if box.get("error"):
        raise RuntimeError(box["error"])
    result = box.get("result")
    if not result:
        raise RuntimeError("werkbank_spawn_failed")
    return {"ok": True, **result}


def _resolve_memory_path(raw: str) -> Path:
    candidate = Path(str(raw or "")).expanduser()
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        text = str(candidate)
        resolved = (ROOT / text).resolve() if text.startswith("brain/") else (MEMORY_DIR / text).resolve()
    try:
        resolved.relative_to(MEMORY_DIR.resolve())
    except ValueError as exc:
        raise PermissionError("memory_path_outside_brain") from exc
    if has_hidden_or_sensitive_path(resolved):
        raise PermissionError("memory_sensitive_or_hidden")
    if resolved.suffix.lower() not in {".md", ".txt", ".json"}:
        raise PermissionError("memory_suffix_not_allowed")
    return resolved


def memory_read(arguments: dict[str, Any]) -> dict[str, Any]:
    path = _resolve_memory_path(str(arguments.get("path") or ""))
    max_bytes = max(1, min(int(arguments.get("max_bytes") or MAX_READ_BYTES), MAX_READ_BYTES))
    if not path.exists() or not path.is_file():
        raise FileNotFoundError("memory_file_not_found")
    data = path.read_bytes()
    text = data[:max_bytes].decode("utf-8", errors="replace")
    lowered = text.lower()
    markers = [str(item).lower() for item in secret_broker.manifest().get("markers", [])] + list(SECRET_TEXT_MARKERS)
    if any(marker and marker in lowered for marker in markers) or any(marker in lowered for marker in SECRET_TEXT_MARKERS):
        raise PermissionError("memory_secret_marker_blocked")
    return {
        "path": str(path.relative_to(ROOT)),
        "size": len(data),
        "truncated": len(data) > max_bytes,
        "content": text,
    }


def memory_search(arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "")
    limit = max(1, min(int(arguments.get("limit") or 50), MAX_SEARCH_RESULTS))
    return _search_paths(query, [MEMORY_DIR], limit)


def memory_write(arguments: dict[str, Any]) -> dict[str, Any]:
    path = _resolve_memory_path(str(arguments.get("path") or ""))
    content = arguments.get("content")
    if not isinstance(content, str):
        raise ValueError("content_must_be_string")
    if len(content.encode("utf-8")) > MAX_WRITE_BYTES:
        raise ValueError("content_too_large")
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    before = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    path.write_text(content, encoding="utf-8")
    return {"path": str(path.relative_to(ROOT)), "created": not bool(before), "bytes": len(content.encode("utf-8")), **_diff_text(path, before, content)}


def _write_local_draft(kind: str, arguments: dict[str, Any]) -> dict[str, Any]:
    recipient = str(arguments.get("to") or arguments.get("recipient") or "").strip()
    body = str(arguments.get("body") or arguments.get("text") or "").strip()
    subject = str(arguments.get("subject") or "").strip()
    if not body:
        raise ValueError("draft_body_missing")
    DRAFTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = int(time.time())
    name = f"{stamp}-{kind}.md"
    path = DRAFTS_DIR / name
    content = f"# {kind} draft\n\nTo: {recipient}\nSubject: {subject}\n\n{body}\n"
    path.write_text(content, encoding="utf-8")
    return {"draft": str(path.relative_to(ROOT)), "created": True, "sent": False}


def mail_draft(arguments: dict[str, Any]) -> dict[str, Any]:
    return _write_local_draft("mail", arguments)


def whatsapp_draft(arguments: dict[str, Any]) -> dict[str, Any]:
    return _write_local_draft("whatsapp", arguments)


def mail_send(arguments: dict[str, Any]) -> dict[str, Any]:
    return {"sent": False, "reason": "mail_connector_not_configured", "draft_id": str(arguments.get("draft_id") or "")}


def whatsapp_send(arguments: dict[str, Any]) -> dict[str, Any]:
    return {"sent": False, "reason": "whatsapp_connector_not_configured", "draft_id": str(arguments.get("draft_id") or "")}


def calendar_read(_: dict[str, Any]) -> dict[str, Any]:
    return {"events": [], "count": 0, "reason": "calendar_connector_not_configured"}


def calendar_write(arguments: dict[str, Any]) -> dict[str, Any]:
    return {"written": False, "reason": "calendar_connector_not_configured", "title": str(arguments.get("title") or "")}


def voice_speak(arguments: dict[str, Any]) -> dict[str, Any]:
    return {"spoken": False, "reason": "voice_provider_not_configured", "text_bytes": len(str(arguments.get("text") or "").encode("utf-8"))}


def image_generate(arguments: dict[str, Any]) -> dict[str, Any]:
    prompt = str(arguments.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt_missing")
    return {"generated": False, "reason": "image_provider_not_configured"}


def browser_open(arguments: dict[str, Any]) -> dict[str, Any]:
    url = str(arguments.get("url") or "").strip()
    if not url:
        raise ValueError("url_missing")
    return {"opened": False, "url": url, "reason": "managed_browser_not_connected"}


def browser_click(arguments: dict[str, Any]) -> dict[str, Any]:
    return {"clicked": False, "reason": "managed_browser_not_connected", "selector": str(arguments.get("selector") or "")}


def browser_type(arguments: dict[str, Any]) -> dict[str, Any]:
    return {"typed": False, "reason": "managed_browser_not_connected", "selector": str(arguments.get("selector") or "")}


def browser_screenshot(_: dict[str, Any]) -> dict[str, Any]:
    return {"captured": False, "reason": "managed_browser_not_connected"}


def code_run(arguments: dict[str, Any]) -> dict[str, Any]:
    if not SHELL_SANDBOX:
        raise PermissionError("code_sandbox_unavailable")
    sandbox_ok, sandbox_error = _shell_sandbox_available()
    if not sandbox_ok:
        raise PermissionError(f"code_sandbox_unavailable:{sandbox_error}")
    language = str(arguments.get("language") or "python").strip().lower()
    if language not in {"python", "py", "python3"}:
        raise PermissionError("code_language_not_allowed")
    code = arguments.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code_missing")
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise ValueError("code_too_large")
    _guard_code_text(code)
    timeout = max(1, min(int(arguments.get("timeout_seconds") or arguments.get("timeout") or 10), MAX_CODE_TIMEOUT_SECONDS))
    python = sys.executable or shutil.which("python3") or "python3"
    with tempfile.TemporaryDirectory(prefix="agent-control-code-") as tmp:
        workdir = Path(tmp).resolve()
        script = workdir / "snippet.py"
        script.write_text(code, encoding="utf-8")
        argv = [python, "-I", str(script)]
        argv = [SHELL_SANDBOX, "-p", _code_sandbox_profile(workdir), *argv]
        sandboxed = True
        start = time.time()
        try:
            completed = subprocess.run(
                argv,
                cwd=workdir,
                env={
                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "HOME": str(workdir),
                },
                text=True,
                capture_output=True,
                timeout=timeout,
            )
            timed_out = False
        except subprocess.TimeoutExpired as exc:
            completed = subprocess.CompletedProcess(argv, 124, exc.stdout or "", exc.stderr or "code_timeout")
            timed_out = True
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    combined_size = len(stdout.encode("utf-8", errors="replace")) + len(stderr.encode("utf-8", errors="replace"))
    return {
        "language": "python",
        "policy": "code-isolated",
        "sandboxed": sandboxed,
        "return_code": int(completed.returncode),
        "timed_out": timed_out,
        "elapsed_ms": int((time.time() - start) * 1000),
        "stdout": stdout[:MAX_CODE_OUTPUT_BYTES],
        "stderr": stderr[:MAX_CODE_OUTPUT_BYTES],
        "output_truncated": combined_size > (MAX_CODE_OUTPUT_BYTES * 2),
    }


def shell_run(arguments: dict[str, Any]) -> dict[str, Any]:
    command = str(arguments.get("command") or arguments.get("cmd") or "").strip()
    if not command:
        raise ValueError("command_missing")
    argv = _guard_shell_command(command)
    cwd = _resolve_shell_cwd(str(arguments.get("cwd") or "") or None)
    timeout = max(1, min(int(arguments.get("timeout_seconds") or arguments.get("timeout") or 30), MAX_SHELL_TIMEOUT_SECONDS))
    start = time.time()
    try:
        completed = subprocess.run(
            argv,
            cwd=cwd,
            env=_safe_shell_env(),
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        timed_out = False
    except subprocess.TimeoutExpired as exc:
        completed = subprocess.CompletedProcess(argv, 124, exc.stdout or "", exc.stderr or "command_timeout")
        timed_out = True
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    combined_size = len(stdout.encode("utf-8", errors="replace")) + len(stderr.encode("utf-8", errors="replace"))
    return {
        "command": command,
        "cwd": str(cwd),
        "policy": "user-free-guarded-local-policy",
        "sandboxed": False,
        "sandbox_mode": "local-guard",
        "sandbox_error": "",
        "return_code": int(completed.returncode),
        "timed_out": timed_out,
        "elapsed_ms": int((time.time() - start) * 1000),
        "stdout": stdout[:MAX_SHELL_OUTPUT_BYTES],
        "stderr": stderr[:MAX_SHELL_OUTPUT_BYTES],
        "output_truncated": combined_size > (MAX_SHELL_OUTPUT_BYTES * 2),
    }
