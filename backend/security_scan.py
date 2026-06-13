"""Small security scanner for skills, jobs and text context.

The first pass is deliberately conservative: it labels risk and explains why,
but does not decide whether a job may run. Enforcement belongs in job
governance once the registry has enough data.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any


_SECRET_WORDS = r"(api[_-]?key|token|password|passwd|secret|credential|authorization|\.env)"

_PATTERNS: list[tuple[str, str, str, re.Pattern[str]]] = [
    (
        "warn",
        "secret_reference",
        "Erwähnt Geheimnisse oder Auth-Header und braucht Prüfung.",
        re.compile(rf"(?is)\b(send|post|upload|exfiltrat|leak|print|echo|copy)\b.{{0,100}}{_SECRET_WORDS}"),
    ),
    (
        "blocked",
        "whatsapp_bridge_direct",
        "Direkter WhatsApp-Bridge-Zugriff ist tabu.",
        re.compile(r"(?i)(127\.0\.0\.1|localhost):8891|/send-message\b"),
    ),
    (
        "warn",
        "prompt_injection",
        "Enthält typische Prompt-Injection-Formulierungen.",
        re.compile(r"(?is)(ignore|disregard).{0,40}(previous|above|system|developer)|you are now|system prompt"),
    ),
    (
        "warn",
        "unsafe_shell",
        "Enthält riskante Shell-Muster.",
        re.compile(r"(?i)\brm\s+-rf\b|\bchmod\s+777\b|\bpkill\s+-9\b|\bgit\s+reset\s+--hard\b"),
    ),
    (
        "warn",
        "hidden_html",
        "Enthält versteckte HTML-Kommentare.",
        re.compile(r"<!--[\s\S]{8,800}?-->"),
    ),
]

_INVISIBLE = re.compile(r"[\u200b\u200c\u200d\ufeff]")
_SAFE_SECRET_PLACEHOLDER = re.compile(
    r"(?i)(Authorization:\s*Bearer\s+\$[A-Z0-9_]+|\$[A-Z0-9_]*(TOKEN|KEY|SECRET)|[A-Z0-9_]*(TOKEN|KEY|SECRET))"
)
_NEGATED_RISK = re.compile(r"(?i)(nie|niemals|verboten|tabu|do not|don't|never)")
_HTML_COMMENT_RISK = re.compile(r"(?i)(ignore|disregard|system prompt|developer|secret|token|password|credential|exfiltrat)")


def _excerpt(text: str, start: int, end: int, limit: int = 140) -> str:
    left = max(0, start - 35)
    right = min(len(text), end + 35)
    s = " ".join(text[left:right].replace("\n", " ").split())
    s = re.sub(_SECRET_WORDS, "[secret]", s, flags=re.I)
    if len(s) <= limit:
        return s
    return s[: limit - 1].rstrip() + "…"


def _is_documented_safe_hit(code: str, text: str, start: int, end: int) -> bool:
    """Ignore examples that document guardrails instead of creating risk."""
    left = max(0, start - 100)
    right = min(len(text), end + 100)
    context = text[left:right]
    if code == "secret_reference":
        return bool(_SAFE_SECRET_PLACEHOLDER.search(context))
    if code == "unsafe_shell":
        return bool(_NEGATED_RISK.search(text[max(0, start - 90):start]))
    if code == "hidden_html":
        return not bool(_HTML_COMMENT_RISK.search(context))
    return False


def scan_text(kind: str, path: str, text: str) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    for severity, code, message, pattern in _PATTERNS:
        for match in pattern.finditer(text):
            if _is_documented_safe_hit(code, text, match.start(), match.end()):
                continue
            issues.append({
                "severity": severity,
                "code": code,
                "message": message,
                "excerpt": _excerpt(text, match.start(), match.end()),
            })
            break
    if _INVISIBLE.search(text):
        issues.append({
            "severity": "warn",
            "code": "invisible_chars",
            "message": "Enthält unsichtbare Steuerzeichen.",
            "excerpt": "",
        })

    if any(i["severity"] == "blocked" for i in issues):
        status = "blocked"
    elif issues:
        status = "warn"
    else:
        status = "safe"

    return {
        "kind": kind,
        "path": path,
        "status": status,
        "issueCount": len(issues),
        "issues": issues[:12],
    }


def scan_path(kind: str, path: Path, max_bytes: int = 1024 * 1024) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        return {"kind": kind, "path": str(path), "status": "blocked", "issueCount": 1, "issues": [{
            "severity": "blocked",
            "code": "missing_file",
            "message": "Datei nicht gefunden.",
            "excerpt": "",
        }]}
    if path.stat().st_size > max_bytes:
        return {"kind": kind, "path": str(path), "status": "blocked", "issueCount": 1, "issues": [{
            "severity": "blocked",
            "code": "file_too_large",
            "message": "Datei ist für den Security Scan zu groß.",
            "excerpt": "",
        }]}
    text = path.read_text(encoding="utf-8", errors="replace")
    return scan_text(kind, str(path), text)
