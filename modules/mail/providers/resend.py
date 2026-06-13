"""Resend-Versand-Provider innerhalb der Mail-Schublade.

Frueher lag der Code in `modules/mail_resend/provider.py` (parallel zu mail).
Mit der Vereinheitlichung "ein Modul pro Thema" zieht der Resend-Anschluss
unter `modules/mail/providers/` — Mail ist die Schublade, Resend ein
Anschluss-Typ darin (neben spaeter Gmail-API, SES, Mailgun).
"""
from __future__ import annotations

import email.utils
import json
import os
from typing import Any

# Cloudflare (vor api.resend.com) blockt den nackten urllib-Default-Agent
# ("Python-urllib/x.y") mit 403/Error-1010. Ein expliziter User-Agent reicht,
# um die WAF-Sperre zu passieren — gilt fuer Senden wie Lesen.
_RESEND_UA = "klaus-agent/1.0 (+https://example.com)"


def _resend_api_key() -> str:
    """Resend-API-Key aus .env. Faellt zurueck auf DENZER_RESEND_API_KEY."""
    return os.environ.get("RESEND_API_KEY") or os.environ.get("DENZER_RESEND_API_KEY") or ""


def _send_via_resend(acc: dict[str, Any], to: str, subject: str, body: str,
                     cc: str = "", in_reply_to: str = "", references: str = "") -> dict[str, Any]:
    key = _resend_api_key()
    if not key:
        raise RuntimeError("Resend nicht konfiguriert (DENZER_RESEND_API_KEY fehlt)")
    from_addr = acc.get("smtp_from") or acc.get("email")
    from_label = email.utils.formataddr((acc.get("name", ""), from_addr))
    payload: dict[str, Any] = {
        "from": from_label,
        "to": [a.strip() for a in to.split(",") if a.strip()],
        "subject": subject or "",
        "text": body or "",
    }
    if cc:
        payload["cc"] = [a.strip() for a in cc.split(",") if a.strip()]
    headers: dict[str, str] = {}
    if in_reply_to:
        headers["In-Reply-To"] = in_reply_to
    if references:
        headers["References"] = references
    if headers:
        payload["headers"] = headers
    import urllib.request
    import urllib.error
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "User-Agent": _RESEND_UA,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Resend Fehler {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}")
    message_id = resp.get("id") or ""
    # Outbound-Tagging haengt im Mail-Kern (core.py); lazy import vermeidet Zyklus.
    try:
        from modules.mail.core import _tag_outbound_async
        _tag_outbound_async(to, subject, body, message_id)
    except Exception:
        pass
    return {"ok": True, "message_id": message_id, "via": "resend"}


def fetch_resend_sent(limit: int = 50) -> list[dict[str, Any]]:
    """Liefert gesendete Mails aus Resend, neueste zuerst."""
    key = _resend_api_key()
    if not key:
        return []
    import urllib.request
    import urllib.error
    req = urllib.request.Request(
        f"https://api.resend.com/emails?limit={int(limit)}",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": _RESEND_UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Resend API Fehler {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}")
    except Exception as e:
        raise RuntimeError(f"Resend API nicht erreichbar: {e}")
    items = data.get("data") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for it in items:
        ts = 0
        created = it.get("created_at") or it.get("createdAt") or ""
        try:
            from datetime import datetime
            ts = int(datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp())
        except Exception:
            ts = 0
        to_list = it.get("to") or []
        if isinstance(to_list, str):
            to_list = [to_list]
        out.append({
            "uid": it.get("id", ""),
            "from": it.get("from", ""),
            "to": ", ".join(to_list),
            "subject": it.get("subject", "(kein Betreff)"),
            "ts": ts,
            "status": it.get("last_event") or it.get("status") or "sent",
            "snippet": (it.get("text") or "")[:140],
        })
    out.sort(key=lambda x: x.get("ts", 0), reverse=True)
    _tag_resend_async(out)
    return out


def _tag_resend_async(items: list[dict[str, Any]]):
    """Resend-Sends nach Empfaenger-Resolve in mentions verbuchen."""
    try:
        from backend import entities
        for it in items:
            mid = it.get("uid") or ""
            if not mid:
                continue
            entities.ingest_email(
                from_raw=it.get("to", ""),
                subject=f"→ {it.get('subject') or ''}",
                message_id=str(mid),
                ts=it.get("ts") or None,
                body_snippet=it.get("snippet", ""),
            )
    except Exception:
        pass


def fetch_resend_email(email_id: str) -> dict[str, Any]:
    key = _resend_api_key()
    if not key:
        raise RuntimeError("RESEND_API_KEY fehlt")
    import urllib.request
    req = urllib.request.Request(
        f"https://api.resend.com/emails/{email_id}",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": _RESEND_UA},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8", errors="replace"))
