"""Mail-Schublade: Konten, IMAP-Lesen, SMTP-Senden, Smartfilter.

Das ganze Mail-Konzept lebt hier in einem Modul. Frueher in
`backend/mail.py`; `backend/mail.py` ist jetzt nur noch eine duenne
Re-Export-Fassade, damit der bestehende Aufrufer in `server.py`
(`import mail as _mail`) unveraendert bleibt.

Anschluss-Typen liegen in `providers/` -- aktuell nur `resend.py`,
spaeter koennen weitere (Gmail-API, Outlook, SES, Mailgun) als
gleichberechtigte Provider dazukommen.
"""
from __future__ import annotations

import email
import email.utils
import imaplib
import json
import os
import sqlite3
import smtplib
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime, getaddresses
from pathlib import Path
from typing import Any

# Diese Datei liegt unter `<repo>/modules/mail/core.py`, also drei Ebenen
# tief; Repo-Root ist parent.parent.parent.
ROOT = Path(__file__).parent.parent.parent
CONFIG_PATH = ROOT / "config" / "mail-accounts.json"
BLOCKLIST_PATH = ROOT / "config" / "mail-blocklist.json"
RULES_PATH = ROOT / "config" / "mail-rules.json"
ARCHIVED_STATE_PATH = ROOT / "data" / "mail-archived-state.json"
OUTBOX_LEDGER_PATH = ROOT / "data" / "outbox" / "mail-send-ledger.jsonl"
UNIFIED_ACCOUNT_KEY = "all"

from modules.mail.providers.resend import (
    _resend_api_key,
    _send_via_resend,
    fetch_resend_sent,
    fetch_resend_email,
    _tag_resend_async,
)

_cache: dict[str, dict[str, Any]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 120
ATTENTION_CACHE_TTL = 120
ARCHIVE_TOMBSTONE_TTL = 600
_archived_uid_tombstones: dict[tuple[str, str], float] = {}
# In-flight-Schutz: verhindert Cache-Stampede bei gleichzeitigen Requests.
_attention_inflight: dict[str, threading.Event] = {}
# In-Memory-Cache fuer den archivierten Zustand: verhindert N×Disk-Reads pro Request.
# Wird immer unter _cache_lock gelesen/geschrieben, daher kein eigenes Lock noetig.
_archived_state_mem: dict[str, Any] = {}
_archived_state_mem_ts: float = 0.0
ARCHIVED_STATE_MEM_TTL = 10.0


def _archived_state_key(account_key: str, uid: str) -> str:
    return f"{str(account_key)}:{str(uid)}"


def _load_archived_state() -> dict[str, Any]:
    global _archived_state_mem, _archived_state_mem_ts
    if _archived_state_mem and time.time() - _archived_state_mem_ts < ARCHIVED_STATE_MEM_TTL:
        return _archived_state_mem
    if not ARCHIVED_STATE_PATH.exists():
        _archived_state_mem = {"uids": {}, "message_ids": {}}
        _archived_state_mem_ts = time.time()
        return _archived_state_mem
    try:
        data = json.loads(ARCHIVED_STATE_PATH.read_text())
        if isinstance(data, dict) and isinstance(data.get("uids"), dict):
            if not isinstance(data.get("message_ids"), dict):
                data["message_ids"] = {}
            _archived_state_mem = data
            _archived_state_mem_ts = time.time()
            return _archived_state_mem
    except Exception:
        pass
    _archived_state_mem = {"uids": {}, "message_ids": {}}
    _archived_state_mem_ts = time.time()
    return _archived_state_mem


def _save_archived_state(data: dict[str, Any]) -> None:
    global _archived_state_mem, _archived_state_mem_ts
    ARCHIVED_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    uids = data.get("uids")
    if isinstance(uids, dict) and len(uids) > 5000:
        newest = sorted(uids.items(), key=lambda kv: int((kv[1] or {}).get("ts") or 0), reverse=True)[:5000]
        data["uids"] = dict(newest)
    message_ids = data.get("message_ids")
    if isinstance(message_ids, dict) and len(message_ids) > 5000:
        newest = sorted(message_ids.items(), key=lambda kv: int((kv[1] or {}).get("ts") or 0), reverse=True)[:5000]
        data["message_ids"] = dict(newest)
    ARCHIVED_STATE_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    _archived_state_mem = data
    _archived_state_mem_ts = time.time()


def _normalize_message_id(message_id: str | None) -> str:
    return (message_id or "").strip().strip("<>").lower()


def _remember_archived_persistent(account_key: str, uid: str, message_id: str | None = None) -> None:
    key = _archived_state_key(account_key, uid)
    mid = _normalize_message_id(message_id)
    with _cache_lock:
        data = _load_archived_state()
        data.setdefault("uids", {})[key] = {"account": str(account_key), "uid": str(uid), "ts": int(time.time())}
        if mid:
            data.setdefault("message_ids", {})[mid] = {"account": str(account_key), "uid": str(uid), "message_id": mid, "ts": int(time.time())}
        _save_archived_state(data)


def _is_archived_persistent(account_key: str, uid: str, message_id: str | None = None) -> bool:
    key = _archived_state_key(account_key, uid)
    mid = _normalize_message_id(message_id)
    with _cache_lock:
        data = _load_archived_state()
        if key in (data.get("uids") or {}):
            return True
        return bool(mid and mid in (data.get("message_ids") or {}))


def _remember_archived(account_key: str, uid: str) -> None:
    now = time.time()
    expires = now + ARCHIVE_TOMBSTONE_TTL
    key = (str(account_key), str(uid))
    with _cache_lock:
        _archived_uid_tombstones[key] = expires
        for tombstone_key, tombstone_expires in list(_archived_uid_tombstones.items()):
            if tombstone_expires < now:
                _archived_uid_tombstones.pop(tombstone_key, None)


def _is_recently_archived(account_key: str, uid: str) -> bool:
    now = time.time()
    key = (str(account_key), str(uid))
    with _cache_lock:
        expires = _archived_uid_tombstones.get(key)
        if not expires:
            return False
        if expires < now:
            _archived_uid_tombstones.pop(key, None)
            return False
        return True


def _is_archived_done(account_key: str, uid: str, message_id: str | None = None) -> bool:
    return _is_recently_archived(account_key, uid) or _is_archived_persistent(account_key, uid, message_id)


def load_blocklist() -> list[str]:
    if not BLOCKLIST_PATH.exists():
        return []
    try:
        return [b.strip().lower() for b in json.loads(BLOCKLIST_PATH.read_text()).get("blocked", []) if b.strip()]
    except Exception:
        return []


def save_blocklist(entries: list[str]) -> None:
    seen = set()
    out = []
    for e in entries:
        e = (e or "").strip().lower()
        if e and e not in seen:
            seen.add(e)
            out.append(e)
    BLOCKLIST_PATH.write_text(json.dumps({"blocked": out}, indent=2, ensure_ascii=False))
    _invalidate(None)


def add_blocked(entry: str) -> list[str]:
    cur = load_blocklist()
    cur.append(entry)
    save_blocklist(cur)
    return load_blocklist()


def remove_blocked(entry: str) -> list[str]:
    e = (entry or "").strip().lower()
    cur = [x for x in load_blocklist() if x != e]
    save_blocklist(cur)
    return cur


def _is_blocked(from_raw: str, blocklist: list[str]) -> bool:
    name, addr = parseaddr(from_raw or "")
    addr = (addr or "").lower()
    if not addr:
        return False
    for b in blocklist:
        if not b:
            continue
        if b.startswith("@"):
            if addr.endswith(b):
                return True
        elif "@" in b:
            if addr == b:
                return True
        else:
            if b in addr:
                return True
    return False


def load_rules() -> dict[str, Any]:
    if not RULES_PATH.exists():
        return {"rules": [], "tabs": ["primary"], "tab_labels": {"all": "Alle", "primary": "Primär"}}
    try:
        return json.loads(RULES_PATH.read_text())
    except Exception:
        return {"rules": [], "tabs": ["primary"], "tab_labels": {"all": "Alle", "primary": "Primär"}}


def _classify(thread: dict[str, Any], headers_lower: dict[str, str], rules: list[dict[str, Any]]) -> str:
    frm = (thread.get("from_raw") or "").lower()
    subj = (thread.get("subject") or "").lower()
    to_cc = (thread.get("to_cc_raw") or "").lower()
    for rule in rules:
        m = rule.get("match", {})
        if "header" in m and m["header"].lower() in headers_lower:
            return rule.get("category", "primary")
        for needle in m.get("from_contains", []):
            if needle.lower() in frm:
                return rule.get("category", "primary")
        for needle in m.get("to_contains", []):
            if needle.lower() in to_cc:
                return rule.get("category", "primary")
        for needle in m.get("address_contains", []):
            n = needle.lower()
            if n in frm or n in to_cc:
                return rule.get("category", "primary")
        for needle in m.get("subject_contains", []):
            if needle.lower() in subj:
                return rule.get("category", "primary")
    return "primary"


def _bucket(thread: dict[str, Any]) -> tuple[str, str]:
    """Christians Arbeitskörbe: Aufmerksamkeit, Rechnung, Rest."""
    cat = thread.get("category") or "primary"
    subj = (thread.get("subject") or "").lower()
    frm = (thread.get("from_raw") or "").lower()
    to_cc = (thread.get("to_cc_raw") or "").lower()
    has_unsub = bool(thread.get("unsubscribe_url"))

    if cat == "rechnung":
        explicit_invoice = any(w in subj for w in (
            "rechnung", "invoice", "quittung", "beleg", "receipt",
            "zahlung erhalten", "payment received",
        )) or any(w in frm for w in (
            "lexoffice", "lexware", "stripe.com", "billing@", "invoice@",
            "rechnung@", "buchhaltung@", "noreply@paypal", "service@paypal",
            "buchung@",
        ))
        if has_unsub and not explicit_invoice:
            return "rest", "Marketing trotz Rechnungsregel"
        return "rechnung", "Rechnung oder Beleg"
    if cat in ("newsletter", "amazon", "werbung", "social"):
        return "rest", f"Kategorie {cat}"
    if cat in ("denzer", "fch"):
        return "attention", f"Kategorie {cat}"
    if "owner@example.com" in to_cc or "example.com" in to_cc:
        return "attention", "An Denzer AI adressiert"
    if has_unsub:
        return "rest", "Bulk-Mail"

    attention_words = (
        "antwort", "rückfrage", "frage", "anfrage", "termin", "meeting",
        "angebot", "auftrag", "vertrag", "kündigung", "mahnung", "onboarding",
        "workshop", "freigabe", "bitte", "wichtig",
    )
    if any(w in subj for w in attention_words):
        return "attention", "Betreff braucht Prüfung"
    if thread.get("to_me"):
        return "attention", "Direkt adressiert"
    return "rest", "Kein Aufmerksamkeits-Signal"


def _is_silent_system_mail(thread: dict[str, Any]) -> bool:
    """Erfolgreiche technische Checks aus Christians Arbeits-Inbox halten."""
    subject = (thread.get("subject") or "").lower()
    _, from_addr = parseaddr(thread.get("from_raw") or "")
    from_addr = (from_addr or "").lower()
    return from_addr == "leads@example.com" and "watchdog mailtest" in subject


def _enrich_thread_account(thread: dict[str, Any], acc: dict[str, Any]) -> dict[str, Any]:
    bucket, reason = _bucket(thread)
    thread["account"] = acc["key"]
    thread["account_name"] = acc.get("name") or acc.get("email") or acc["key"]
    thread["account_email"] = acc.get("email") or ""
    thread["bucket"] = bucket
    thread["bucket_reason"] = reason
    return thread


def _merge_threads(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    rank = {"attention": 3, "rechnung": 2, "rest": 1}
    by_key: dict[str, dict[str, Any]] = {}
    for t in items:
        mid = (t.get("message_id") or "").strip().lower()
        key = mid or f"{t.get('account')}:{t.get('uid')}"
        prev = by_key.get(key)
        if not prev:
            by_key[key] = t
            continue
        prev_sources = prev.setdefault("source_accounts", [prev.get("account_name") or prev.get("account")])
        src = t.get("account_name") or t.get("account")
        if src and src not in prev_sources:
            prev_sources.append(src)
        current_rank = rank.get(t.get("bucket") or "rest", 0)
        previous_rank = rank.get(prev.get("bucket") or "rest", 0)
        if current_rank > previous_rank or (current_rank == previous_rank and t.get("account") == "denzer"):
            t["source_accounts"] = prev_sources
            by_key[key] = t
    out = list(by_key.values())
    out.sort(key=lambda x: x.get("ts", 0), reverse=True)
    return out[:limit]


_oauth_token_cache: dict[str, dict[str, Any]] = {}


def _oauth_access_token(token_file: str) -> str | None:
    """Aktuellen Access-Token aus OAuth-File holen.

    Access-Token wird gecacht (Google-Tokens leben ~1h), damit nicht bei jedem
    IMAP-Connect ein Refresh-Roundtrip zu Google nötig ist. Schlägt ein Refresh
    fehl, aber ein noch gültiger Token liegt im Cache, wird der genutzt.
    """
    now = time.time()
    with _cache_lock:
        hit = _oauth_token_cache.get(token_file)
        if hit and hit["exp"] > now:
            return hit["token"]
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request as _GReq
    except ImportError:
        return None
    path = ROOT / token_file
    if not path.exists():
        return None
    t = json.loads(path.read_text())
    creds = Credentials(
        token=None,
        refresh_token=t["refresh_token"],
        client_id=t["client_id"],
        client_secret=t["client_secret"],
        token_uri=t["token_uri"],
        scopes=t["scopes"],
    )
    try:
        creds.refresh(_GReq())
    except Exception:
        with _cache_lock:
            stale = _oauth_token_cache.get(token_file)
        if stale and stale.get("token"):
            return stale["token"]
        raise
    # 50 Minuten cachen, sicher unter der 1h-Lebensdauer von Google-Tokens.
    with _cache_lock:
        _oauth_token_cache[token_file] = {"token": creds.token, "exp": now + 3000}
    return creds.token


def load_accounts() -> list[dict[str, Any]]:
    """Konten laden. Reale Konten haben `password_env` (IMAP-Passwort) ODER
    `oauth_token_file` (XOAUTH2). Virtuelle Konten teilen das IMAP des Parent."""
    if not CONFIG_PATH.exists():
        return []
    data = json.loads(CONFIG_PATH.read_text())
    raw = data.get("accounts", [])
    real_by_key: dict[str, dict[str, Any]] = {}
    out: list[dict[str, Any]] = []
    for acc in raw:
        if acc.get("parent_key"):
            continue
        if acc.get("oauth_token_file"):
            full = {**acc, "auth": "xoauth2", "virtual": False}
        else:
            pw = os.environ.get(acc.get("password_env", ""), "")
            if not pw:
                continue
            full = {**acc, "password": pw, "auth": "password", "virtual": False}
        real_by_key[acc["key"]] = full
        out.append(full)
    for acc in raw:
        pk = acc.get("parent_key")
        if not pk:
            continue
        parent = real_by_key.get(pk)
        if not parent:
            continue
        out.append({
            **acc,
            "virtual": True,
            "parent": parent,
            "password": parent["password"],
            "imap_host": parent["imap_host"],
            "imap_port": parent.get("imap_port", 993),
            "smtp_host": parent.get("smtp_host"),
            "smtp_port": parent.get("smtp_port"),
        })
    return out


def get_account(key: str) -> dict[str, Any] | None:
    for acc in load_accounts():
        if acc["key"] == key:
            return acc
    return None


def _decode(s: Any) -> str:
    if s is None:
        return ""
    if isinstance(s, bytes):
        try:
            return s.decode("utf-8", errors="replace")
        except Exception:
            return s.decode("latin-1", errors="replace")
    try:
        return str(make_header(decode_header(str(s))))
    except Exception:
        return str(s)


def _addr_label(raw: str) -> str:
    name, addr = parseaddr(_decode(raw))
    return name or addr or ""


def _snippet(msg: email.message.Message, limit: int = 140) -> str:
    text = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    try:
                        text = payload.decode(charset, errors="replace")
                    except Exception:
                        text = payload.decode("utf-8", errors="replace")
                    break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            try:
                text = payload.decode(charset, errors="replace")
            except Exception:
                text = payload.decode("utf-8", errors="replace")
    text = " ".join(text.split())
    return text[:limit]


def _connect_imap(acc: dict[str, Any]) -> imaplib.IMAP4_SSL:
    ctx = ssl.create_default_context()
    m = imaplib.IMAP4_SSL(acc["imap_host"], acc.get("imap_port", 993), ssl_context=ctx, timeout=15)
    # Virtuelle Konten teilen das IMAP des Parent — Login mit Parent-Email.
    login_email = acc.get("parent", {}).get("email") if acc.get("virtual") else acc["email"]
    login_email = login_email or acc["email"]
    auth_acc = acc.get("parent") if acc.get("virtual") else acc
    if (auth_acc or {}).get("auth") == "xoauth2":
        token = _oauth_access_token(auth_acc["oauth_token_file"])
        if not token:
            raise RuntimeError(f"OAuth-Token fuer {login_email} nicht ladbar")
        auth_string = f"user={login_email}\x01auth=Bearer {token}\x01\x01"
        m.authenticate("XOAUTH2", lambda _x: auth_string.encode())
    else:
        m.login(login_email, acc["password"])
    return m


def fetch_inbox(account_key: str, limit: int = 50) -> list[dict[str, Any]]:
    """Letzte `limit` Nachrichten aus INBOX, neueste zuerst.

    Filtert geblockte Absender raus und klassifiziert in Kategorien.
    """
    if account_key == UNIFIED_ACCOUNT_KEY:
        real_accs = [acc for acc in load_accounts() if not acc.get("hidden") and not acc.get("virtual")]

        def _fetch_one_acc(acc: dict[str, Any]) -> list[dict[str, Any]]:
            try:
                return fetch_inbox(acc["key"], max(limit, 50))
            except Exception as e:
                return [{
                    "uid": f"error:{acc['key']}",
                    "message_id": "",
                    "account": acc["key"],
                    "account_name": acc.get("name") or acc.get("email") or acc["key"],
                    "account_email": acc.get("email") or "",
                    "from": acc.get("name") or acc.get("email") or acc["key"],
                    "from_raw": acc.get("email") or "",
                    "subject": f"Postfach nicht erreichbar: {e}",
                    "snippet": "",
                    "ts": int(time.time()),
                    "unread": False,
                    "starred": False,
                    "to_me": False,
                    "has_attachment": False,
                    "category": "primary",
                    "bucket": "attention",
                    "bucket_reason": "Quelle prüfen",
                    "to_cc_raw": "",
                }]

        items: list[dict[str, Any]] = []
        if len(real_accs) <= 1:
            for acc in real_accs:
                items.extend(_fetch_one_acc(acc))
        else:
            with ThreadPoolExecutor(max_workers=min(len(real_accs), 4)) as pool:
                for batch in pool.map(_fetch_one_acc, real_accs):
                    items.extend(batch)
        return _merge_threads(items, limit)

    cache_key = f"inbox:{account_key}:{limit}"
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit and time.time() - hit["ts"] < CACHE_TTL:
            return hit["data"]

    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden oder Passwort fehlt")

    blocklist = load_blocklist()
    rules_cfg = load_rules()
    rules = rules_cfg.get("rules", [])

    # Virtuelles Konto: Mailbox des Parent lesen, lokal nach Adress-Filter sieben.
    virtual_filters = [f.lower() for f in (acc.get("filter_address_contains") or [])] if acc.get("virtual") else []
    # Bei virtuellen Konten mehr holen, damit nach Filter noch genug bleibt.
    effective_limit = limit * 6 if virtual_filters else limit

    out: list[dict[str, Any]] = []
    m = _connect_imap(acc)
    try:
        m.select("INBOX", readonly=True)
        status, data = m.uid("SEARCH", None, "ALL")
        if status != "OK" or not data or not data[0]:
            return []
        uids = data[0].split()
        # Etwas mehr holen als Limit, damit nach Blocklist-/Virtuell-Filter immer
        # noch genug bleibt. +50 reicht als Reserve; ein Faktor 2 verdoppelte nur
        # die IMAP-Last fuer Mails, die am Ende ohnehin abgeschnitten werden.
        fetch_count = min(len(uids), effective_limit + 50)
        uids = uids[-fetch_count:][::-1]
        if not uids:
            return []
        seq = b",".join(uids)
        status, fetched = m.uid(
            "FETCH", seq,
            "(FLAGS BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID LIST-UNSUBSCRIBE)])"
        )
        if status != "OK":
            return []
        # imaplib liefert pro UID: (b"<seq> (UID <uid> FLAGS (...) BODY[...] {len}", b"<headers>"), b")"
        parsed: dict[str, dict[str, Any]] = {}
        for item in fetched:
            if not isinstance(item, tuple) or len(item) < 2:
                continue
            head_bytes, body_bytes = item[0], item[1]
            head = head_bytes.decode("utf-8", errors="replace") if isinstance(head_bytes, bytes) else str(head_bytes)
            uid_val = ""
            if "UID " in head:
                after = head.split("UID ", 1)[1]
                uid_val = after.split(" ", 1)[0].rstrip(")")
            flags = ""
            if "FLAGS (" in head:
                fstart = head.index("FLAGS (") + len("FLAGS (")
                fend = head.index(")", fstart)
                flags = head[fstart:fend]
            head_lower = head.lower()
            has_attachment = (
                '"attachment"' in head_lower
                or "(\"attachment\"" in head_lower
                or '("filename"' in head_lower
                or '"name" "' in head_lower
            )
            msg = email.message_from_bytes(body_bytes if isinstance(body_bytes, bytes) else body_bytes.encode())
            subj = _decode(msg.get("Subject"))
            frm = _decode(msg.get("From"))
            from_label = _addr_label(frm)
            date_raw = msg.get("Date")
            ts = 0
            try:
                if date_raw:
                    ts = int(parsedate_to_datetime(date_raw).timestamp())
            except Exception:
                ts = 0
            mid = msg.get("Message-ID", "").strip()
            unread = "\\Seen" not in flags
            starred = "\\Flagged" in flags
            tos = getaddresses(msg.get_all("To", []) + msg.get_all("Cc", []))
            to_me = any(acc["email"].lower() in (a or "").lower() for _, a in tos)
            to_cc_raw = " ".join(f"{n} {a}" for n, a in tos).strip()
            list_unsub = msg.get("List-Unsubscribe")
            headers_lower = {}
            unsubscribe_url = ""
            if list_unsub:
                headers_lower["list-unsubscribe"] = str(list_unsub)
                import re as _re
                _m = _re.search(r'<\s*(https?://[^>\s]+)\s*>', str(list_unsub))
                if _m:
                    unsubscribe_url = _m.group(1)
            thread = {
                "uid": uid_val,
                "message_id": mid,
                "from": from_label,
                "from_raw": frm,
                "subject": subj or "(kein Betreff)",
                "snippet": "",
                "ts": ts,
                "unread": unread,
                "starred": starred,
                "to_me": to_me,
                "has_attachment": has_attachment,
                "unsubscribe_url": unsubscribe_url,
                "to_cc_raw": to_cc_raw,
            }
            thread["category"] = _classify(thread, headers_lower, rules)
            _enrich_thread_account(thread, acc)
            parsed[uid_val] = thread
        for u in uids:
            key = u.decode() if isinstance(u, bytes) else str(u)
            if key in parsed:
                t = parsed[key]
                if _is_archived_done(account_key, key, t.get("message_id")):
                    continue
                if _is_blocked(t.get("from_raw", ""), blocklist):
                    continue
                if _is_silent_system_mail(t):
                    continue
                if virtual_filters:
                    haystack = (t.get("to_cc_raw") or "").lower()
                    if not any(f in haystack for f in virtual_filters):
                        continue
                out.append(t)
                if len(out) >= limit:
                    break
        # Inverses Filter: das Real-Konto soll Mails, die zu einem virtuellen Konto gehören,
        # nicht zeigen (sonst doppelt). Liste aus config sammeln.
        if not acc.get("virtual"):
            try:
                cfg = json.loads(CONFIG_PATH.read_text())
                excludes: list[str] = []
                for sub in cfg.get("accounts", []):
                    if sub.get("parent_key") == acc["key"]:
                        excludes.extend([s.lower() for s in (sub.get("filter_address_contains") or [])])
                if excludes:
                    out = [
                        t for t in out
                        if not any(e in (t.get("to_cc_raw") or "").lower() for e in excludes)
                    ]
            except Exception:
                pass
    finally:
        try:
            m.logout()
        except Exception:
            pass

    with _cache_lock:
        _cache[cache_key] = {"ts": time.time(), "data": out}
    _tag_threads_async(out)
    return out


def _tag_threads_async(threads: list[dict[str, Any]]):
    """Mail-Touchpoints in mentions schreiben. Best-effort, blockt Fetch nicht."""
    try:
        from backend import entities
        for t in threads:
            mid = t.get("message_id") or t.get("uid") or ""
            if not mid:
                continue
            entities.ingest_email(
                from_raw=t.get("from_raw", ""),
                subject=t.get("subject", ""),
                message_id=str(mid),
                ts=t.get("ts") or None,
            )
    except Exception:
        pass


def fetch_message(account_key: str, uid: str) -> dict[str, Any]:
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")
    m = _connect_imap(acc)
    try:
        m.select("INBOX", readonly=True)
        status, fetched = m.uid("FETCH", uid.encode(), "(BODY.PEEK[])")
        if status != "OK" or not fetched:
            raise ValueError("UID nicht gefunden")
        item = next((x for x in fetched if isinstance(x, tuple) and len(x) >= 2), None)
        if not item:
            raise ValueError("UID nicht gefunden")
        raw = item[1]
        msg = email.message_from_bytes(raw if isinstance(raw, bytes) else raw.encode())
        body_text, body_html = "", ""
        attachments: list[dict[str, Any]] = []
        cid_map: dict[str, int] = {}
        if msg.is_multipart():
            idx = 0
            for part in msg.walk():
                if part.is_multipart():
                    continue
                ct = part.get_content_type()
                disp = (part.get("Content-Disposition") or "").lower()
                fname = part.get_filename()
                if fname:
                    fname = _decode(fname)
                cid_raw = part.get("Content-ID") or ""
                cid = cid_raw.strip().strip("<>").strip()
                is_inline_image = ct.startswith("image/") and ("inline" in disp or cid)
                is_attachment = ("attachment" in disp or (fname and ct not in ("text/plain", "text/html"))) and not is_inline_image
                if is_inline_image:
                    if cid:
                        cid_map[cid.lower()] = idx
                elif is_attachment:
                    payload = part.get_payload(decode=True) or b""
                    attachments.append({
                        "index": idx,
                        "filename": fname or f"anhang-{idx}",
                        "content_type": ct,
                        "size": len(payload),
                    })
                elif ct == "text/plain" and not body_text:
                    payload = part.get_payload(decode=True)
                    if payload:
                        cs = part.get_content_charset() or "utf-8"
                        body_text = payload.decode(cs, errors="replace")
                elif ct == "text/html" and not body_html:
                    payload = part.get_payload(decode=True)
                    if payload:
                        cs = part.get_content_charset() or "utf-8"
                        body_html = payload.decode(cs, errors="replace")
                idx += 1
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                cs = msg.get_content_charset() or "utf-8"
                if msg.get_content_type() == "text/html":
                    body_html = payload.decode(cs, errors="replace")
                else:
                    body_text = payload.decode(cs, errors="replace")

        if body_html and cid_map:
            import re as _re
            def _sub(match: "_re.Match[str]") -> str:
                cid_val = match.group(1).strip().strip("<>").lower()
                idx = cid_map.get(cid_val)
                if idx is None:
                    return match.group(0)
                from urllib.parse import quote as _q
                return f'/api/mail/attachment?account={_q(account_key)}&uid={_q(uid)}&index={idx}&inline=1'
            body_html = _re.sub(r'cid:([^"\'\s>)]+)', _sub, body_html, flags=_re.IGNORECASE)

        list_unsub = msg.get("List-Unsubscribe") or ""
        unsubscribe_url = ""
        if list_unsub:
            import re as _re2
            _mu = _re2.search(r'<\s*(https?://[^>\s]+)\s*>', str(list_unsub))
            if _mu:
                unsubscribe_url = _mu.group(1)
        return {
            "uid": uid,
            "from": _decode(msg.get("From")),
            "to": _decode(msg.get("To")),
            "cc": _decode(msg.get("Cc")),
            "subject": _decode(msg.get("Subject")),
            "date": _decode(msg.get("Date")),
            "message_id": (msg.get("Message-ID") or "").strip(),
            "body_text": body_text,
            "body_html": body_html,
            "attachments": attachments,
            "unsubscribe_url": unsubscribe_url,
        }
    finally:
        try:
            m.logout()
        except Exception:
            pass


def fetch_attachment(account_key: str, uid: str, index: int) -> dict[str, Any]:
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")
    m = _connect_imap(acc)
    try:
        m.select("INBOX", readonly=True)
        status, fetched = m.uid("FETCH", uid.encode(), "(BODY.PEEK[])")
        if status != "OK" or not fetched:
            raise ValueError("UID nicht gefunden")
        item = next((x for x in fetched if isinstance(x, tuple) and len(x) >= 2), None)
        if not item:
            raise ValueError("UID nicht gefunden")
        msg = email.message_from_bytes(item[1])
        idx = 0
        for part in msg.walk():
            if part.is_multipart():
                continue
            if idx == index:
                payload = part.get_payload(decode=True) or b""
                fname = part.get_filename()
                if fname:
                    fname = _decode(fname)
                return {
                    "filename": fname or f"anhang-{idx}",
                    "content_type": part.get_content_type(),
                    "data": payload,
                }
            idx += 1
        raise ValueError("Anhang nicht gefunden")
    finally:
        try:
            m.logout()
        except Exception:
            pass


def archive_message(account_key: str, uid: str) -> None:
    """Aus INBOX entfernen. Gmail: X-GM-LABELS \\Inbox abziehen.
    Fallback: COPY nach 'Archive' + \\Deleted + EXPUNGE."""
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")
    m = _connect_imap(acc)
    message_id = ""
    try:
        m.select("INBOX")
        status, fetched = m.uid("FETCH", uid.encode(), "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
        if status == "OK":
            for item in fetched or []:
                if not isinstance(item, tuple) or len(item) < 2:
                    continue
                msg = email.message_from_bytes(item[1] if isinstance(item[1], bytes) else str(item[1]).encode())
                message_id = (msg.get("Message-ID") or "").strip()
                if message_id:
                    break
        is_gmail = "gmail" in (acc.get("imap_host") or "").lower()
        if is_gmail:
            status, _ = m.uid("STORE", uid.encode(), "-X-GM-LABELS", "(\\Inbox)")
            if status != "OK":
                raise RuntimeError("Archive fehlgeschlagen")
        else:
            status, _ = m.uid("COPY", uid.encode(), "Archive")
            if status != "OK":
                raise RuntimeError("Archive-Mailbox fehlt")
            m.uid("STORE", uid.encode(), "+FLAGS", "\\Deleted")
            m.expunge()
    finally:
        try:
            m.logout()
        except Exception:
            pass
    _remember_archived(account_key, uid)
    _remember_archived_persistent(account_key, uid, message_id)
    _invalidate(None)


def delete_message(account_key: str, uid: str) -> None:
    """In Papierkorb verschieben. Gmail: Trash-Label setzen."""
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")
    m = _connect_imap(acc)
    try:
        m.select("INBOX")
        is_gmail = "gmail" in (acc.get("imap_host") or "").lower()
        trash = "[Gmail]/Trash" if is_gmail else "Trash"
        status, _ = m.uid("MOVE", uid.encode(), trash)
        if status != "OK":
            status, _ = m.uid("COPY", uid.encode(), trash)
            if status == "OK":
                m.uid("STORE", uid.encode(), "+FLAGS", "\\Deleted")
                m.expunge()
            else:
                raise RuntimeError("Trash-Mailbox fehlt")
    finally:
        try:
            m.logout()
        except Exception:
            pass
    _invalidate(account_key)


def mark_read(account_key: str, uid: str) -> None:
    acc = get_account(account_key)
    if not acc:
        return
    m = _connect_imap(acc)
    try:
        m.select("INBOX")
        m.uid("STORE", uid.encode(), "+FLAGS", "\\Seen")
    finally:
        try:
            m.logout()
        except Exception:
            pass
    _invalidate(account_key)


def mark_unread(account_key: str, uid: str) -> None:
    acc = get_account(account_key)
    if not acc:
        return
    m = _connect_imap(acc)
    try:
        m.select("INBOX")
        m.uid("STORE", uid.encode(), "-FLAGS", "\\Seen")
    finally:
        try:
            m.logout()
        except Exception:
            pass
    _invalidate(account_key)


def send_mail(account_key: str, to: str, subject: str, body: str,
              cc: str = "", in_reply_to: str = "", references: str = "") -> dict[str, Any]:
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")

    # Virtuelle Konten mit `smtp_provider: "resend"` versenden über die Resend-API
    # (owner@example.com), nicht via SMTP des Parent-Postfachs.
    if acc.get("smtp_provider") == "resend":
        res = _send_via_resend(acc, to, subject, body, cc=cc,
                               in_reply_to=in_reply_to, references=references)
        _record_outbox_sent(to, subject, body, res.get("message_id") or "")
        # Cache leeren, damit die beantwortete Mail beim naechsten attention-Abruf
        # sofort als `replied` erscheint und nicht 45s im alten Stand haengt.
        _invalidate(None)
        return res

    msg = EmailMessage()
    msg["From"] = email.utils.formataddr((acc.get("name", ""), acc["email"]))
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=acc["email"].split("@")[1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
    if references:
        msg["References"] = references
    msg.set_content(body)

    ctx = ssl.create_default_context()
    port = acc.get("smtp_port", 465)
    host = acc["smtp_host"]
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as s:
            s.login(acc["email"], acc["password"])
            s.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20) as s:
            s.starttls(context=ctx)
            s.login(acc["email"], acc["password"])
            s.send_message(msg)
    _tag_outbound_async(to, subject, body, msg["Message-ID"])
    _record_outbox_sent(to, subject, body, msg["Message-ID"])
    _invalidate(None)
    return {"ok": True, "message_id": msg["Message-ID"]}


def _record_outbox_sent(to: str, subject: str, body: str, message_id: str) -> None:
    """Jeden erfolgreichen Versand ins Outbox-Ledger schreiben, damit
    `_has_later_outbound` Antworten unabhaengig vom Transport (SMTP wie Resend)
    erkennt und beantwortete Mails in der Inbox als `replied` markiert werden."""
    try:
        OUTBOX_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "ts": time.time(),
            "status": "sent",
            "to": to,
            "subject": subject or "",
            "message_id": message_id or "",
            "body_text": (body or "")[:2000],
        }
        with OUTBOX_LEDGER_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _tag_outbound_async(to: str, subject: str, body: str, message_id: str):
    """Outbound-Mail nach Empfänger-Resolve + Body-Scan in mentions verbuchen."""
    try:
        from backend import entities
        if not message_id:
            return
        entities.ingest_email(
            from_raw=to,
            subject=f"→ {subject or ''}",
            message_id=str(message_id),
            ts=int(time.time()),
            body_snippet=(body or "")[:300],
        )
    except Exception:
        pass


def search_inbox(account_key: str, query: str, limit: int = 50) -> list[dict[str, Any]]:
    """Volltextsuche über das gesamte Postfach.

    Gmail: nutzt X-GM-RAW (gleiche Syntax wie das Suchfeld in der Web-Oberfläche).
    Andere IMAP-Server: SEARCH TEXT als Fallback. Trifft alle Mailboxes/Labels
    via 'All Mail' bei Gmail, sonst nur INBOX.
    """
    q = (query or "").strip()
    if not q:
        return fetch_inbox(account_key, limit)
    if account_key == UNIFIED_ACCOUNT_KEY:
        items: list[dict[str, Any]] = []
        for acc in load_accounts():
            if acc.get("hidden") or acc.get("virtual"):
                continue
            try:
                items.extend(search_inbox(acc["key"], q, max(limit, 50)))
            except Exception as e:
                items.append({
                    "uid": f"error:{acc['key']}",
                    "message_id": "",
                    "account": acc["key"],
                    "account_name": acc.get("name") or acc.get("email") or acc["key"],
                    "account_email": acc.get("email") or "",
                    "from": acc.get("name") or acc.get("email") or acc["key"],
                    "from_raw": acc.get("email") or "",
                    "subject": f"Postfach nicht erreichbar: {e}",
                    "snippet": "",
                    "ts": int(time.time()),
                    "unread": False,
                    "starred": False,
                    "to_me": False,
                    "has_attachment": False,
                    "category": "primary",
                    "bucket": "attention",
                    "bucket_reason": "Quelle prüfen",
                    "to_cc_raw": "",
                })
        return _merge_threads(items, limit)

    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden oder Passwort fehlt")

    blocklist = load_blocklist()
    rules_cfg = load_rules()
    rules = rules_cfg.get("rules", [])
    is_gmail = "gmail" in (acc.get("imap_host") or "").lower()

    out: list[dict[str, Any]] = []
    m = _connect_imap(acc)
    try:
        # Gmail: 'All Mail' enthält archivierte und Label-Mails. Bei Workspace mit
        # deutscher UI heißt der Ordner '[Gmail]/Alle Nachrichten'. Wir lesen LIST
        # und nehmen den Ordner mit \All-Attribut, sonst INBOX-Fallback.
        if is_gmail:
            # LIST liefert z.B. (\HasNoChildren \All) "/" "[Gmail]/Alle Nachrichten"
            # — bei deutschem Workspace heißt der Ordner anders als bei englischem.
            # Wir nehmen den Eintrag mit \All-Attribut, sonst Fallback.
            all_mailbox = None
            try:
                status_list, mailboxes = m.list()
                if status_list == "OK" and mailboxes:
                    import re as _re
                    for entry in mailboxes:
                        if not entry:
                            continue
                        line = entry.decode("utf-8", errors="replace") if isinstance(entry, bytes) else str(entry)
                        if "\\All" not in line:
                            continue
                        match = _re.search(r'"([^"]+)"\s*$', line)
                        if match:
                            all_mailbox = f'"{match.group(1)}"'
                        break
            except Exception:
                all_mailbox = None
            mailbox = all_mailbox or '"[Gmail]/All Mail"'
        else:
            mailbox = "INBOX"
        status, _ = m.select(mailbox, readonly=True)
        if status != "OK":
            m.select("INBOX", readonly=True)
            is_gmail = False

        if is_gmail:
            status, data = m.uid("SEARCH", "X-GM-RAW", _imap_quote(q))
        else:
            # Mehrere Wörter als TEXT-Suche
            terms: list[str] = []
            for w in q.split():
                terms.extend(["TEXT", _imap_quote(w)])
            status, data = m.uid("SEARCH", *terms)
        if status != "OK" or not data or not data[0]:
            return []
        uids = data[0].split()
        # Neueste zuerst, hartes Limit
        uids = uids[-max(limit * 2, limit + 50):][::-1]
        if not uids:
            return []
        seq = b",".join(uids)
        status, fetched = m.uid(
            "FETCH", seq,
            "(FLAGS BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID LIST-UNSUBSCRIBE)])"
        )
        if status != "OK":
            return []
        parsed: dict[str, dict[str, Any]] = {}
        for item in fetched:
            if not isinstance(item, tuple) or len(item) < 2:
                continue
            head_bytes, body_bytes = item[0], item[1]
            head = head_bytes.decode("utf-8", errors="replace") if isinstance(head_bytes, bytes) else str(head_bytes)
            uid_val = ""
            if "UID " in head:
                after = head.split("UID ", 1)[1]
                uid_val = after.split(" ", 1)[0].rstrip(")")
            flags = ""
            if "FLAGS (" in head:
                fstart = head.index("FLAGS (") + len("FLAGS (")
                fend = head.index(")", fstart)
                flags = head[fstart:fend]
            head_lower = head.lower()
            has_attachment = (
                '"attachment"' in head_lower
                or "(\"attachment\"" in head_lower
                or '("filename"' in head_lower
                or '"name" "' in head_lower
            )
            msg = email.message_from_bytes(body_bytes if isinstance(body_bytes, bytes) else body_bytes.encode())
            subj = _decode(msg.get("Subject"))
            frm = _decode(msg.get("From"))
            from_label = _addr_label(frm)
            date_raw = msg.get("Date")
            ts = 0
            try:
                if date_raw:
                    ts = int(parsedate_to_datetime(date_raw).timestamp())
            except Exception:
                ts = 0
            mid = msg.get("Message-ID", "").strip()
            unread = "\\Seen" not in flags
            starred = "\\Flagged" in flags
            tos = getaddresses(msg.get_all("To", []) + msg.get_all("Cc", []))
            to_me = any(acc["email"].lower() in (a or "").lower() for _, a in tos)
            to_cc_raw = " ".join(f"{n} {a}" for n, a in tos).strip()
            list_unsub = msg.get("List-Unsubscribe")
            headers_lower = {}
            unsubscribe_url = ""
            if list_unsub:
                headers_lower["list-unsubscribe"] = str(list_unsub)
                import re as _re
                _m = _re.search(r'<\s*(https?://[^>\s]+)\s*>', str(list_unsub))
                if _m:
                    unsubscribe_url = _m.group(1)
            thread = {
                "uid": uid_val,
                "message_id": mid,
                "from": from_label,
                "from_raw": frm,
                "subject": subj or "(kein Betreff)",
                "snippet": "",
                "ts": ts,
                "unread": unread,
                "starred": starred,
                "to_me": to_me,
                "has_attachment": has_attachment,
                "unsubscribe_url": unsubscribe_url,
                "to_cc_raw": to_cc_raw,
            }
            thread["category"] = _classify(thread, headers_lower, rules)
            _enrich_thread_account(thread, acc)
            parsed[uid_val] = thread
        virtual_filters = [f.lower() for f in (acc.get("filter_address_contains") or [])] if acc.get("virtual") else []
        excludes: list[str] = []
        if not acc.get("virtual"):
            try:
                cfg = json.loads(CONFIG_PATH.read_text())
                for sub in cfg.get("accounts", []):
                    if sub.get("parent_key") == acc["key"]:
                        excludes.extend([s.lower() for s in (sub.get("filter_address_contains") or [])])
            except Exception:
                pass
        for u in uids:
            key = u.decode() if isinstance(u, bytes) else str(u)
            if key in parsed:
                t = parsed[key]
                if _is_blocked(t.get("from_raw", ""), blocklist):
                    continue
                if _is_silent_system_mail(t):
                    continue
                haystack = (t.get("to_cc_raw") or "").lower()
                if virtual_filters and not any(f in haystack for f in virtual_filters):
                    continue
                if excludes and any(e in haystack for e in excludes):
                    continue
                out.append(t)
                if len(out) >= limit:
                    break
    finally:
        try:
            m.logout()
        except Exception:
            pass
    out.sort(key=lambda x: x.get("ts", 0), reverse=True)
    return out


def _imap_quote(s: str) -> str:
    """IMAP-Literal-Quote: Backslash und Quote escapen, in Anführungszeichen."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def star_message(account_key: str, uid: str, on: bool) -> None:
    """Stern setzen oder entfernen. Gmail: zusätzlich \\Starred-Label."""
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")
    is_gmail = "gmail" in (acc.get("imap_host") or "").lower()
    m = _connect_imap(acc)
    try:
        m.select("INBOX")
        op = "+FLAGS" if on else "-FLAGS"
        m.uid("STORE", uid.encode(), op, "\\Flagged")
        if is_gmail:
            label_op = "+X-GM-LABELS" if on else "-X-GM-LABELS"
            m.uid("STORE", uid.encode(), label_op, "\\Starred")
    finally:
        try:
            m.logout()
        except Exception:
            pass
    _invalidate(account_key)


def list_gmail_labels(account_key: str) -> list[str]:
    """Gmail-Labels für die Move-Auswahl. Bei Nicht-Gmail leere Liste."""
    if account_key == UNIFIED_ACCOUNT_KEY:
        labels: set[str] = set()
        for acc in load_accounts():
            if acc.get("hidden") or acc.get("virtual"):
                continue
            labels.update(list_gmail_labels(acc["key"]))
        return sorted(labels, key=lambda x: x.lower())

    acc = get_account(account_key)
    if not acc:
        return []
    is_gmail = "gmail" in (acc.get("imap_host") or "").lower()
    if not is_gmail:
        return []
    m = _connect_imap(acc)
    out: list[str] = []
    try:
        status, data = m.list()
        if status != "OK":
            return []
        for line in data or []:
            if not line:
                continue
            s = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else str(line)
            # Format: (\HasNoChildren) "/" "Labelname"
            if '"/"' not in s:
                continue
            name = s.rsplit('"/"', 1)[1].strip().strip('"')
            if not name:
                continue
            # System-Sonderordner ausblenden
            if name.startswith("[Gmail]"):
                continue
            if name.upper() == "INBOX":
                continue
            out.append(name)
    finally:
        try:
            m.logout()
        except Exception:
            pass
    out.sort(key=lambda x: x.lower())
    return out


def move_message(account_key: str, uid: str, label: str, remove_inbox: bool = True) -> None:
    """In ein Gmail-Label verschieben (oder bei IMAP echtem Ordner-MOVE).

    Bei Gmail wird Label hinzugefügt und INBOX-Label entfernt, sodass die Mail
    aus der Inbox verschwindet, aber unter dem Label gefunden wird.
    """
    acc = get_account(account_key)
    if not acc:
        raise ValueError(f"Account {account_key} nicht gefunden")
    label = (label or "").strip()
    if not label:
        raise ValueError("label fehlt")
    is_gmail = "gmail" in (acc.get("imap_host") or "").lower()
    m = _connect_imap(acc)
    try:
        m.select("INBOX")
        if is_gmail:
            status, _ = m.uid("STORE", uid.encode(), "+X-GM-LABELS", _imap_quote(label))
            if status != "OK":
                raise RuntimeError(f"Label '{label}' setzen fehlgeschlagen")
            if remove_inbox:
                m.uid("STORE", uid.encode(), "-X-GM-LABELS", "\\Inbox")
        else:
            status, _ = m.uid("MOVE", uid.encode(), label)
            if status != "OK":
                status, _ = m.uid("COPY", uid.encode(), label)
                if status != "OK":
                    raise RuntimeError(f"Ordner '{label}' fehlt")
                if remove_inbox:
                    m.uid("STORE", uid.encode(), "+FLAGS", "\\Deleted")
                    m.expunge()
    finally:
        try:
            m.logout()
        except Exception:
            pass
    _invalidate(account_key)


def _invalidate(account_key: str | None = None) -> None:
    # Stale statt Clear: ts=0 statt pop/clear, damit fetch_contact_inbox_state
    # den stale-while-revalidate-Pfad nimmt (sofort zurueckgeben, Hintergrund-Refresh)
    # statt in den blockierenden Cold-Start-Pfad zu fallen.
    with _cache_lock:
        if account_key is None:
            for v in _cache.values():
                if isinstance(v, dict) and "ts" in v:
                    v["ts"] = 0.0
            return
        for k in list(_cache.keys()):
            v = _cache.get(k)
            if not isinstance(v, dict) or "ts" not in v:
                continue
            if k.startswith(f"inbox:{account_key}:") or k.startswith(f"attention:{account_key}:"):
                v["ts"] = 0.0
            elif account_key != UNIFIED_ACCOUNT_KEY and k.startswith(f"attention:{UNIFIED_ACCOUNT_KEY}:"):
                v["ts"] = 0.0


# ---------------------------------------------------------------------------
# Smartfilter: gruen / gelb / rot. Lernspeicher in mail-learning.json.
# ---------------------------------------------------------------------------

LEARNING_PATH = ROOT / "config" / "mail-learning.json"

_LEARNING_DEFAULT = {
    "trusted_addresses": [],
    "trusted_domains": ["example.com"],
    "distrusted_addresses": [],
    "subject_keywords_in": [],
    "subject_keywords_out": [],
}


def load_learning() -> dict[str, Any]:
    if not LEARNING_PATH.exists():
        return dict(_LEARNING_DEFAULT)
    try:
        data = json.loads(LEARNING_PATH.read_text())
        out = dict(_LEARNING_DEFAULT)
        out.update({k: data.get(k, v) for k, v in _LEARNING_DEFAULT.items()})
        return out
    except Exception:
        return dict(_LEARNING_DEFAULT)


def save_learning(data: dict[str, Any]) -> None:
    LEARNING_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _norm_addr(raw: str) -> tuple[str, str]:
    """Liefert (volle adresse, domain)."""
    _, addr = parseaddr(raw or "")
    addr = (addr or "").lower().strip()
    domain = addr.split("@", 1)[1] if "@" in addr else ""
    return addr, domain


PEOPLE_DB_PATH = ROOT / "data" / "people.db"


def _own_mail_addresses() -> set[str]:
    out: set[str] = set()
    for acc in load_accounts():
        for key in ("email", "smtp_from"):
            _, value = parseaddr(acc.get(key) or "")
            if value:
                out.add(value.lower().strip())
    return out


def _is_own_mail_address(addr: str) -> bool:
    addr = (addr or "").lower().strip()
    if not addr:
        return False
    if addr in _own_mail_addresses() or addr == "owner@example.com":
        return True
    domain = addr.rsplit("@", 1)[1] if "@" in addr else ""
    return domain in {"example.com", "example.de"}


def _mail_attention_context(
    thread: dict[str, Any],
    con: sqlite3.Connection | None = None,
    all_projects: list[Any] | None = None,
) -> dict[str, Any] | None:
    """Resolve a mail thread against people.db.

    Inbox-worthy means: exact known sender email, or an active project name/slug
    appears in the mail header context. This keeps the Inbox from becoming a
    mirror of the whole mailbox.

    `con`/`all_projects` lassen sich von Batch-Aufrufen durchreichen, damit nicht
    pro Thread eine neue DB-Verbindung und Projekt-Query entsteht.
    """
    addr, _domain = _norm_addr(thread.get("from_raw") or "")
    if not PEOPLE_DB_PATH.exists():
        return None
    hay = " ".join([
        thread.get("subject") or "",
        thread.get("from_raw") or "",
        thread.get("from") or "",
        thread.get("to_cc_raw") or "",
    ]).lower()
    own_con = con is None
    if own_con:
        con = sqlite3.connect(PEOPLE_DB_PATH)
        con.row_factory = sqlite3.Row
    try:
        person = None
        if addr and not _is_own_mail_address(addr):
            person = con.execute(
                """SELECT DISTINCT p.id, p.name, p.email, p.company, p.relation,
                          p.customer_status, p.pipeline_stream, p.pipeline_stage,
                          p.company_cluster, p.tags
                     FROM people p
                LEFT JOIN person_identities i
                       ON i.person_id=p.id AND i.kind='email'
                    WHERE LOWER(COALESCE(p.email,''))=?
                       OR LOWER(COALESCE(p.billing_email,''))=?
                       OR i.value_norm=?
                    ORDER BY CASE
                       WHEN COALESCE(p.customer_status,'')='aktiv' THEN 0
                       WHEN COALESCE(p.relation,'')='kunde' THEN 1
                       ELSE 2 END,
                       p.id
                    LIMIT 1""",
                (addr, addr, addr),
            ).fetchone()

        projects: list[dict[str, Any]] = []
        if person:
            rows = con.execute(
                """SELECT pr.id, pr.slug, pr.name
                     FROM person_projects pp
                     JOIN projects pr ON pr.id=pp.project_id
                    WHERE pp.person_id=? AND COALESCE(pr.status,'active') != 'archived'
                    ORDER BY pp.confidence DESC, pr.updated_at DESC
                    LIMIT 4""",
                (person["id"],),
            ).fetchall()
            projects.extend({"id": r["id"], "slug": r["slug"], "name": r["name"]} for r in rows)

        if all_projects is None:
            all_projects = con.execute(
                "SELECT id, slug, name FROM projects WHERE COALESCE(status,'active') != 'archived'"
            ).fetchall()
        seen_project_ids = {p["id"] for p in projects}
        for r in all_projects:
            slug = (r["slug"] or "").lower()
            name = (r["name"] or "").lower()
            match_slug = slug and len(slug) >= 3 and slug in hay
            match_name = name and len(name) >= 4 and name in hay
            if (match_slug or match_name) and r["id"] not in seen_project_ids:
                projects.append({"id": r["id"], "slug": r["slug"], "name": r["name"]})
                seen_project_ids.add(r["id"])
            if len(projects) >= 4:
                break

        if not person and not projects:
            return None

        ctx: dict[str, Any] = {"projects": projects}
        if person:
            relation = person["relation"] or ""
            customer_status = person["customer_status"] or ""
            active_customer = (
                relation == "kunde"
                or customer_status == "aktiv"
                or bool(person["pipeline_stream"])
            )
            ctx.update({
                "person_id": person["id"],
                "person_name": person["name"],
                "company": person["company"] or "",
                "relation": relation,
                "customer_status": customer_status,
                "active_customer": active_customer,
                "reason": "Aktiver Kunde" if active_customer else "Bekannter Kontakt",
            })
        else:
            ctx["reason"] = "Projektbezug"
        return ctx
    finally:
        if own_con:
            con.close()


def _person_email_addresses(person_id: int | str | None) -> set[str]:
    if not person_id or not PEOPLE_DB_PATH.exists():
        return set()
    con = sqlite3.connect(PEOPLE_DB_PATH)
    con.row_factory = sqlite3.Row
    out: set[str] = set()
    try:
        row = con.execute(
            "SELECT email, billing_email FROM people WHERE id=?",
            (person_id,),
        ).fetchone()
        if row:
            for key in ("email", "billing_email"):
                _, addr = parseaddr(row[key] or "")
                addr = (addr or "").lower().strip()
                if addr and not _is_own_mail_address(addr):
                    out.add(addr)
        rows = con.execute(
            "SELECT value_norm FROM person_identities WHERE person_id=? AND kind='email'",
            (person_id,),
        ).fetchall()
        for r in rows:
            addr = (r["value_norm"] or "").lower().strip()
            if addr and not _is_own_mail_address(addr):
                out.add(addr)
    finally:
        con.close()
    return out


def _context_email_addresses(ctx: dict[str, Any] | None, thread: dict[str, Any] | None = None) -> set[str]:
    out = _person_email_addresses((ctx or {}).get("person_id"))
    if thread:
        for key in ("from_raw", "from", "to", "to_cc_raw"):
            for _, addr in getaddresses([thread.get(key) or ""]):
                addr = (addr or "").lower().strip()
                if addr and not _is_own_mail_address(addr):
                    out.add(addr)
    return out


_resend_sent_index_cache: dict[str, Any] = {"ts": 0.0, "data": {}}


def _local_outbox_sent(limit: int = 120) -> list[dict[str, Any]]:
    if not OUTBOX_LEDGER_PATH.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        lines = OUTBOX_LEDGER_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        try:
            row = json.loads(line)
        except Exception:
            continue
        if row.get("status") != "sent" or not row.get("to"):
            continue
        ts = int(float(row.get("ts") or 0))
        rows.append({
            "uid": row.get("message_id") or row.get("key") or "",
            "source": "ledger",
            "from": row.get("from") or _default_from(),
            "to": row.get("to") or "",
            "subject": row.get("subject") or "(kein Betreff)",
            "ts": ts,
            "status": row.get("status") or "sent",
            "snippet": (row.get("body_text") or row.get("body_preview") or "")[:220],
            "body_text": row.get("body_text") or row.get("body_preview") or "",
        })
    rows.sort(key=lambda x: x.get("ts", 0), reverse=True)
    return rows[:limit]


def _outbound_sent_items(limit: int = 120) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    try:
        items.extend({**item, "source": item.get("source") or "resend"} for item in fetch_resend_sent(limit))
    except Exception:
        pass
    items.extend(_local_outbox_sent(limit))
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in sorted(items, key=lambda x: int(x.get("ts") or 0), reverse=True):
        key = str(item.get("uid") or item.get("message_id") or "")
        if not key:
            key = f"{item.get('to') or ''}:{item.get('subject') or ''}:{item.get('ts') or ''}"
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _latest_resend_outbound_by_address(limit: int = 120) -> dict[str, int]:
    now = time.time()
    cached = _resend_sent_index_cache.get("data")
    if isinstance(cached, dict) and now - float(_resend_sent_index_cache.get("ts") or 0) < 60:
        return {str(k): int(v or 0) for k, v in cached.items()}
    latest: dict[str, int] = {}
    for item in _outbound_sent_items(limit):
        ts = int(item.get("ts") or 0)
        if not ts:
            continue
        for _, addr in getaddresses([item.get("to") or ""]):
            addr = (addr or "").lower().strip()
            if addr:
                latest[addr] = max(latest.get(addr, 0), ts)
    _resend_sent_index_cache["ts"] = now
    _resend_sent_index_cache["data"] = latest
    return latest


def _has_later_outbound(ctx: dict[str, Any] | None, thread: dict[str, Any], sent_by_addr: dict[str, int]) -> bool:
    incoming_ts = int(thread.get("ts") or 0)
    if not incoming_ts:
        return False
    for addr in _context_email_addresses(ctx, thread):
        if int(sent_by_addr.get(addr) or 0) > incoming_ts:
            return True
    return False


def _mail_attention_key(thread: dict[str, Any], account_key: str) -> str:
    uid = str(thread.get("uid") or "").strip()
    if not uid:
        return ""
    return f"{thread.get('account') or account_key}:{uid}"


def _do_attention_fetch(account_key: str, limit: int, cache_key: str) -> dict[str, Any]:
    """IMAP-Fetch fuer fetch_contact_inbox_state. Schreibt Ergebnis in _cache."""
    threads = fetch_inbox(account_key, max(limit * 3, 120))
    sent_by_addr = _latest_resend_outbound_by_address()
    out: list[dict[str, Any]] = []
    done_keys: set[str] = set()
    con: sqlite3.Connection | None = None
    all_projects: list[Any] | None = None
    if PEOPLE_DB_PATH.exists():
        con = sqlite3.connect(PEOPLE_DB_PATH)
        con.row_factory = sqlite3.Row
        all_projects = con.execute(
            "SELECT id, slug, name FROM projects WHERE COALESCE(status,'active') != 'archived'"
        ).fetchall()
    verdicts: dict[str, Any] = {}
    try:
        from modules.mail import triage as _triage
        verdicts = _triage.get_verdicts([t.get("message_id") for t in threads])
    except Exception:
        verdicts = {}
    try:
        for t in threads:
            key = _mail_attention_key(t, account_key)
            if _is_archived_done(t.get("account") or account_key, t.get("uid") or "", t.get("message_id")):
                if key:
                    done_keys.add(key)
                continue
            ctx = _mail_attention_context(t, con=con, all_projects=all_projects)
            v = verdicts.get(t.get("message_id") or "")
            relevant_by_llm = bool(v and v.get("relevant"))
            if not ctx and not relevant_by_llm:
                continue
            # Bulk bleibt draussen, ausser ein bekannter Mensch steckt dahinter
            # oder Klaus hat die Mail ausdruecklich als wichtig markiert.
            if not relevant_by_llm and (not ctx or not ctx.get("person_id")) and (t.get("category") in ("newsletter", "werbung", "social") or t.get("unsubscribe_url")):
                continue
            # Beantwortete Mails verschwinden nicht mehr, sondern bleiben als
            # `replied` sichtbar (Frontend zeigt sie weiss in der E-Mails-Gruppe,
            # bis Christian sie archiviert). Lesen demotet eine Mail nicht mehr;
            # erst eine echte Antwort macht sie zu `replied`.
            replied = _has_later_outbound(ctx, t, sent_by_addr)
            inbox_ctx = ctx or {"projects": [], "reason": (v or {}).get("reason") or "Von Klaus als wichtig markiert"}
            out.append({**t, "inbox_context": inbox_ctx, "replied": replied})
            if len(out) >= limit:
                break
    finally:
        if con is not None:
            con.close()
    out.sort(key=lambda x: x.get("ts", 0))
    data = {"items": out, "done_keys": sorted(done_keys)}
    with _cache_lock:
        _cache[cache_key] = {"ts": time.time(), "data": data}
    return data


def _run_attention_bg(account_key: str, limit: int, cache_key: str, ev: threading.Event) -> None:
    """Hintergrund-Thread-Wrapper: holt frische Daten, bereinigt Inflight-Eintrag."""
    try:
        _do_attention_fetch(account_key, limit, cache_key)
    except Exception:
        pass
    finally:
        with _cache_lock:
            _attention_inflight.pop(cache_key, None)
        ev.set()


def fetch_contact_inbox_state(account_key: str, limit: int = 80) -> dict[str, Any]:
    """Mail rows plus explicit keys that should be removed from held UI state.

    Stale-while-revalidate: abgelaufene Cache-Eintraege werden sofort
    zurueckgegeben; der IMAP-Fetch laeuft im Hintergrund-Thread, ohne den
    Request zu blockieren. Nur beim ersten Aufruf (leerer Cache) wird
    einmalig synchron geladen.
    """
    cache_key = f"attention:{account_key}:{limit}"
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit and time.time() - hit["ts"] < ATTENTION_CACHE_TTL:
            return hit["data"]
        if cache_key in _attention_inflight:
            # Refresh laeuft bereits im Hintergrund.
            if hit:
                return hit["data"]
            ev = _attention_inflight[cache_key]
            is_leader = False
        elif hit:
            # Stale Daten vorhanden: Hintergrund-Refresh starten, sofort zurueckgeben.
            ev = threading.Event()
            _attention_inflight[cache_key] = ev
            threading.Thread(
                target=_run_attention_bg,
                args=(account_key, limit, cache_key, ev),
                daemon=True,
            ).start()
            return hit["data"]
        else:
            # Kein Cache vorhanden: einmalig blockierend laden (erster Request).
            ev = threading.Event()
            _attention_inflight[cache_key] = ev
            is_leader = True

    if not is_leader:
        ev.wait(timeout=30)
        with _cache_lock:
            hit = _cache.get(cache_key)
            if hit:
                return hit["data"]
        return {"items": [], "done_keys": []}

    try:
        return _do_attention_fetch(account_key, limit, cache_key)
    finally:
        with _cache_lock:
            _attention_inflight.pop(cache_key, None)
        ev.set()


def fetch_contact_inbox(account_key: str, limit: int = 80) -> list[dict[str, Any]]:
    """Mail rows for the unified communication Inbox."""
    return list(fetch_contact_inbox_state(account_key, limit).get("items") or [])


def _parse_mail_ts(date_raw: str | None) -> int:
    try:
        if date_raw:
            return int(parsedate_to_datetime(date_raw).timestamp())
    except Exception:
        pass
    return 0


def _parse_iso_ts(value: str | None) -> int:
    if not value:
        return 0
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def _resend_detail_text(data: dict[str, Any]) -> tuple[str, str]:
    text = data.get("text") or data.get("body") or ""
    html = data.get("html") or ""
    if isinstance(text, list):
        text = "\n".join(str(x) for x in text)
    if isinstance(html, list):
        html = "\n".join(str(x) for x in html)
    return str(text or ""), str(html or "")


def fetch_contact_thread(account_key: str, uid: str, limit: int = 30) -> dict[str, Any]:
    """Current mail plus matching outgoing Resend mails for the same person."""
    msg = fetch_message(account_key, uid)
    base_thread = {
        "from_raw": msg.get("from") or "",
        "from": msg.get("from") or "",
        "to": msg.get("to") or "",
        "to_cc_raw": " ".join([msg.get("to") or "", msg.get("cc") or ""]),
        "subject": msg.get("subject") or "",
    }
    ctx = _mail_attention_context(base_thread)
    contact_addrs = _context_email_addresses(ctx, base_thread)
    current_ts = _parse_mail_ts(msg.get("date"))
    messages: list[dict[str, Any]] = [{
        "id": f"imap:{account_key}:{uid}",
        "source": "imap",
        "direction": "in",
        "account": account_key,
        "uid": uid,
        "message_id": msg.get("message_id") or "",
        "from": msg.get("from") or "",
        "to": msg.get("to") or "",
        "cc": msg.get("cc") or "",
        "subject": msg.get("subject") or "",
        "date": msg.get("date") or "",
        "ts": current_ts,
        "body_text": msg.get("body_text") or "",
        "body_html": msg.get("body_html") or "",
        "attachments": msg.get("attachments") or [],
        "unsubscribe_url": msg.get("unsubscribe_url") or "",
        "current": True,
    }]

    answered_after_current = False
    sent_items = _outbound_sent_items(max(limit * 4, 80))
    for item in sent_items:
        recipients = {
            (addr or "").lower().strip()
            for _, addr in getaddresses([item.get("to") or ""])
            if addr
        }
        if contact_addrs and not recipients.intersection(contact_addrs):
            continue
        sent_ts = int(item.get("ts") or 0)
        if current_ts and sent_ts > current_ts:
            answered_after_current = True
        detail: dict[str, Any] = {}
        try:
            if item.get("uid") and item.get("source") != "ledger":
                detail = fetch_resend_email(str(item["uid"]))
        except Exception:
            detail = {}
        body_text, body_html = _resend_detail_text(detail)
        created = detail.get("created_at") or detail.get("createdAt") or ""
        if not sent_ts:
            sent_ts = _parse_iso_ts(str(created or ""))
        to_value = detail.get("to") or item.get("to") or ""
        if isinstance(to_value, list):
            to_value = ", ".join(str(x) for x in to_value)
        messages.append({
            "id": f"resend:{item.get('uid') or detail.get('id') or sent_ts}",
            "source": item.get("source") or "resend",
            "direction": "out",
            "uid": item.get("uid") or detail.get("id") or "",
            "message_id": item.get("uid") or detail.get("id") or "",
            "from": detail.get("from") or item.get("from") or _default_from(),
            "to": str(to_value),
            "cc": ", ".join(detail.get("cc") or []) if isinstance(detail.get("cc"), list) else str(detail.get("cc") or ""),
            "subject": detail.get("subject") or item.get("subject") or "",
            "date": str(created or ""),
            "ts": sent_ts,
            "body_text": body_text or item.get("body_text") or item.get("snippet") or "",
            "body_html": body_html,
            "status": item.get("status") or detail.get("last_event") or "sent",
            "current": False,
        })
        if len(messages) >= limit:
            break

    messages.sort(key=lambda x: int(x.get("ts") or 0))
    return {
        "message": msg,
        "context": ctx or {},
        "contact_emails": sorted(contact_addrs),
        "messages": messages[-limit:],
        "answered_after_current": answered_after_current,
    }


def smart_classify(thread: dict[str, Any], learning: dict[str, Any] | None = None) -> dict[str, Any]:
    """Bewertet einen Thread fuer den Inbox-Smartfilter.

    Rueckgabe: {"verdict": "green"|"yellow"|"red", "reason": str, "score": int}
    """
    L = learning if learning is not None else load_learning()
    addr, domain = _norm_addr(thread.get("from_raw") or "")
    subj = (thread.get("subject") or "").lower()
    to_cc = (thread.get("to_cc_raw") or "").lower()
    has_unsub = bool(thread.get("unsubscribe_url"))
    cat = thread.get("category") or "primary"

    trusted_addr = {a.lower() for a in L.get("trusted_addresses", [])}
    trusted_dom = {d.lower().lstrip("@") for d in L.get("trusted_domains", [])}
    distrust = {a.lower() for a in L.get("distrusted_addresses", [])}
    kw_in = [k.lower() for k in L.get("subject_keywords_in", [])]
    kw_out = [k.lower() for k in L.get("subject_keywords_out", [])]

    # Rot zuerst (harte Filter)
    if addr and addr in distrust:
        return {"verdict": "red", "reason": "Adresse als unwichtig markiert", "score": -100}
    if cat in ("newsletter", "werbung", "social"):
        return {"verdict": "red", "reason": f"Kategorie {cat}", "score": -50}
    if has_unsub and not (domain in trusted_dom or addr in trusted_addr):
        # List-Unsubscribe vorhanden -> Bulk-Mail; nur durchlassen wenn whitelisted
        return {"verdict": "red", "reason": "Newsletter-Header", "score": -30}
    for k in kw_out:
        if k and k in subj:
            return {"verdict": "red", "reason": f"Subject enthaelt {k!r}", "score": -20}

    # Gruen
    if domain and domain in trusted_dom:
        return {"verdict": "green", "reason": f"Vertraute Domain {domain}", "score": 100}
    if addr and addr in trusted_addr:
        return {"verdict": "green", "reason": f"Vertraute Adresse {addr}", "score": 100}
    if cat == "denzer":
        return {"verdict": "green", "reason": "EXAMPLE.COM", "score": 90}
    for k in kw_in:
        if k and k in subj:
            return {"verdict": "green", "reason": f"Schluesselwort {k!r} im Betreff", "score": 60}

    # Gelb: persoenlich an dich, kein klares Signal
    if thread.get("to_me"):
        return {"verdict": "yellow", "reason": "Persoenlich adressiert, unbekannt", "score": 10}

    # Rest: gelb mit niedrigerem Score (lieber zur Pruefung als verschwinden lassen)
    return {"verdict": "yellow", "reason": "Unbekannter Absender", "score": 0}


def fetch_inbox_feed(account_key: str, limit: int = 80) -> dict[str, Any]:
    """Liefert die fuer die Inbox relevanten Mails, nach Smartfilter sortiert.

    {"green": [...], "yellow": [...], "red_count": int}
    """
    threads = fetch_inbox(account_key, limit=limit)
    L = load_learning()
    green: list[dict[str, Any]] = []
    yellow: list[dict[str, Any]] = []
    red_count = 0
    for t in threads:
        verdict = smart_classify(t, L)
        enriched = {**t, "smart": verdict}
        v = verdict["verdict"]
        if v == "green":
            green.append(enriched)
        elif v == "yellow":
            yellow.append(enriched)
        else:
            red_count += 1
    green.sort(key=lambda x: x.get("ts", 0), reverse=True)
    yellow.sort(key=lambda x: x.get("ts", 0), reverse=True)
    return {"green": green, "yellow": yellow, "red_count": red_count}


def learn_from_feedback(address: str, decision: str) -> dict[str, Any]:
    """decision: 'in' (Daumen hoch -> trusted) | 'out' (Daumen runter -> distrust)."""
    L = load_learning()
    addr = (address or "").strip().lower()
    if not addr:
        raise ValueError("address fehlt")
    if decision == "in":
        if addr not in L["trusted_addresses"]:
            L["trusted_addresses"].append(addr)
        L["distrusted_addresses"] = [a for a in L["distrusted_addresses"] if a != addr]
    elif decision == "out":
        if addr not in L["distrusted_addresses"]:
            L["distrusted_addresses"].append(addr)
        L["trusted_addresses"] = [a for a in L["trusted_addresses"] if a != addr]
    else:
        raise ValueError("decision muss 'in' oder 'out' sein")
    save_learning(L)
    _invalidate(None)
    return L


def _default_from() -> str:
    """Absender aus der Owner-Identitaet, namens-neutral fuer Skelette."""
    try:
        from backend.identity import get_owner
        o = get_owner()
        if o.get("email"):
            return f"{o['name']} <{o['email']}>"
    except Exception:
        pass
    return "Agent <noreply@example.com>"
