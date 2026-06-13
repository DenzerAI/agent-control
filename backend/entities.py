"""Entity layer — Personen, Projekte, Mentions.

Verbindet alle Quellen (Chat, WhatsApp, Mail, Notizen) via mentions-Tabelle.
Schema in scripts/migrate-entities.py.

DB: data/people.db (gemeinsam mit Personen-CRM).
"""
import json
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent.parent / "data" / "people.db"

ENTITY_PERSON = "person"
ENTITY_PROJECT = "project"

SOURCE_CHAT = "chat"
SOURCE_WHATSAPP = "whatsapp"
SOURCE_EMAIL = "email"
SOURCE_NOTE = "note"
SOURCE_DOC = "doc"
SOURCE_CALENDAR = "calendar"
SOURCE_FOCUS = "focus"


@contextmanager
def _conn():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    finally:
        db.close()


# ---------- Identity-Normalisierung ----------

def _norm_email(v: Optional[str]) -> Optional[str]:
    v = (v or "").strip().lower()
    return v or None


def _norm_phone(v: Optional[str]) -> Optional[str]:
    if not v:
        return None
    digits = "".join(c for c in v if c.isdigit() or c == "+")
    return digits or None


def _norm_handle(v: Optional[str]) -> Optional[str]:
    v = (v or "").strip().lstrip("@").lower()
    return v or None


_NORMALIZERS = {
    "email": _norm_email,
    "phone": _norm_phone,
    "whatsapp": lambda v: (v or "").strip() or None,
    "instagram": _norm_handle,
    "linkedin": _norm_handle,
    "telegram": _norm_handle,
    "x": _norm_handle,
}


# ---------- Identity-Lookup ----------

def find_person_by_identity(kind: str, value: str) -> Optional[int]:
    """Resolve kanal-spezifische ID auf person_id. None wenn unbekannt."""
    norm = _NORMALIZERS.get(kind, lambda v: (v or "").strip() or None)(value)
    if not norm:
        return None
    with _conn() as db:
        row = db.execute(
            "SELECT person_id FROM person_identities WHERE kind=? AND value_norm=?",
            (kind, norm),
        ).fetchone()
    return row["person_id"] if row else None


def find_person_by_email(addr: str) -> Optional[int]:
    return find_person_by_identity("email", addr)


def find_person_by_phone(num: str) -> Optional[int]:
    return find_person_by_identity("phone", num)


def find_person_by_wa_chat(chat_id: str) -> Optional[int]:
    pid = find_person_by_identity("whatsapp", chat_id)
    if pid:
        return pid
    # Telefon-Brücke: chat_id wie "491700000000@c.us" auf Phone-Identity matchen.
    raw = (chat_id or "").split("@", 1)[0]
    if not raw or not raw.isdigit():
        return None
    candidates = [raw, "+" + raw]
    if raw.startswith("49"):
        candidates.append("0" + raw[2:])  # 01700000000
    for c in candidates:
        hit = find_person_by_identity("phone", c)
        if hit:
            return hit
    return None


def add_identity(
    person_id: int,
    kind: str,
    value: str,
    label: Optional[str] = None,
    is_primary: bool = False,
    source: str = "manual",
) -> Optional[int]:
    """Identity ankleben. Returns id oder None wenn schon vorhanden."""
    normalizer = _NORMALIZERS.get(kind, lambda v: (v or "").strip() or None)
    norm = normalizer(value)
    if not norm:
        return None
    now = int(time.time())
    with _conn() as db:
        try:
            cur = db.execute(
                "INSERT INTO person_identities "
                "(person_id, kind, value, value_norm, label, is_primary, source, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (person_id, kind, value.strip(), norm, label, 1 if is_primary else 0, source, now),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None


def list_identities(person_id: int) -> list[dict]:
    with _conn() as db:
        rows = db.execute(
            "SELECT id, kind, value, label, is_primary, source, created_at "
            "FROM person_identities WHERE person_id=? ORDER BY kind, is_primary DESC, id",
            (person_id,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- Lookup ----------

def find_person(name: str) -> list[dict]:
    """Suche Personen über name + aliases (case-insensitive Substring)."""
    needle = name.strip().lower()
    if not needle:
        return []
    with _conn() as db:
        rows = db.execute(
            "SELECT id, name, aliases, email, whatsapp_chat_id, phone "
            "FROM people WHERE LOWER(name) LIKE ? OR LOWER(COALESCE(aliases,'')) LIKE ?",
            (f"%{needle}%", f"%{needle}%"),
        ).fetchall()
    return [dict(r) for r in rows]


def find_project(slug_or_name: str) -> Optional[dict]:
    key = slug_or_name.strip().lower()
    with _conn() as db:
        row = db.execute(
            "SELECT * FROM projects WHERE LOWER(slug)=? OR LOWER(name)=?",
            (key, key),
        ).fetchone()
        if row:
            return dict(row)
        row = db.execute(
            "SELECT * FROM projects WHERE LOWER(slug) LIKE ? OR LOWER(name) LIKE ?",
            (f"%{key}%", f"%{key}%"),
        ).fetchone()
    return dict(row) if row else None


def list_projects(status: Optional[str] = "active") -> list[dict]:
    with _conn() as db:
        if status:
            rows = db.execute(
                "SELECT * FROM projects WHERE status=? ORDER BY slug", (status,)
            ).fetchall()
        else:
            rows = db.execute("SELECT * FROM projects ORDER BY slug").fetchall()
    return [dict(r) for r in rows]


# ---------- Aliases ----------

def add_alias(person_id: int, alias: str) -> None:
    alias = alias.strip()
    if not alias:
        return
    with _conn() as db:
        row = db.execute(
            "SELECT aliases FROM people WHERE id=?", (person_id,)
        ).fetchone()
        if not row:
            raise ValueError(f"person {person_id} not found")
        current = json.loads(row["aliases"]) if row["aliases"] else []
        if alias in current:
            return
        current.append(alias)
        db.execute(
            "UPDATE people SET aliases=?, updated_at=? WHERE id=?",
            (json.dumps(current, ensure_ascii=False), int(time.time()), person_id),
        )


# ---------- Mentions ----------

def record_mention(
    entity_type: str,
    entity_id: int,
    source_kind: str,
    source_id: str,
    snippet: str = "",
    ts: Optional[int] = None,
) -> int:
    if ts is None:
        ts = int(time.time())
    snippet = (snippet or "").strip()[:500]
    with _conn() as db:
        cur = db.execute(
            "INSERT OR IGNORE INTO mentions "
            "(entity_type, entity_id, source_kind, source_id, snippet, ts, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (entity_type, entity_id, source_kind, source_id, snippet, ts, int(time.time())),
        )
        if entity_type == ENTITY_PROJECT:
            db.execute(
                "UPDATE projects SET last_activity_ts=? WHERE id=? "
                "AND (last_activity_ts IS NULL OR last_activity_ts < ?)",
                (ts, entity_id, ts),
            )
        elif entity_type == ENTITY_PERSON:
            db.execute(
                "UPDATE people SET last_interaction_ts=? WHERE id=? "
                "AND (last_interaction_ts IS NULL OR last_interaction_ts < ?)",
                (ts, entity_id, ts),
            )
        return cur.lastrowid or 0


def whats_new(
    entity_type: str,
    entity_id: int,
    since_ts: Optional[int] = None,
    limit: int = 50,
) -> list[dict]:
    """Alle Mentions für eine Entity seit since_ts, neueste zuerst."""
    since_ts = since_ts or 0
    with _conn() as db:
        rows = db.execute(
            "SELECT id, source_kind, source_id, snippet, ts "
            "FROM mentions WHERE entity_type=? AND entity_id=? AND ts > ? "
            "ORDER BY ts DESC LIMIT ?",
            (entity_type, entity_id, since_ts, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- Auto-Tagging ----------

def detect_projects(text: str) -> list[int]:
    """Findet Projekt-IDs deren slug/name im Text vorkommt (word-boundary)."""
    if not text:
        return []
    projects = list_projects(status=None)
    hits: list[int] = []
    lower = text.lower()
    for p in projects:
        slug = p["slug"].lower()
        name = (p["name"] or "").lower()
        for needle in {slug, name}:
            if not needle or len(needle) < 3:
                continue
            pattern = r"\b" + re.escape(needle) + r"\b"
            if re.search(pattern, lower):
                hits.append(p["id"])
                break
    return hits


def detect_people(text: str) -> list[int]:
    """Findet Personen-IDs anhand name + aliases (word-boundary, min 3 chars)."""
    if not text:
        return []
    lower = text.lower()
    hits: list[int] = []
    with _conn() as db:
        rows = db.execute(
            "SELECT id, name, aliases FROM people"
        ).fetchall()
    for r in rows:
        candidates = [r["name"]]
        if r["aliases"]:
            try:
                candidates.extend(json.loads(r["aliases"]))
            except Exception:
                pass
        for c in candidates:
            c = (c or "").strip().lower()
            if len(c) < 3:
                continue
            if re.search(r"\b" + re.escape(c) + r"\b", lower):
                hits.append(r["id"])
                break
    return hits


def clear_mentions(source_kind: str, source_id: str) -> int:
    """Löscht alle Mentions einer Source (z.B. vor Re-Tagging beim Update)."""
    if not source_kind or not source_id:
        return 0
    with _conn() as db:
        cur = db.execute(
            "DELETE FROM mentions WHERE source_kind=? AND source_id=?",
            (source_kind, source_id),
        )
        return cur.rowcount or 0


def lookup_sources(entity_type: str, entity_id: int, source_kind: Optional[str] = None) -> list[dict]:
    """Alle Sources einer Entity, optional gefiltert auf einen kind."""
    with _conn() as db:
        if source_kind:
            rows = db.execute(
                "SELECT source_kind, source_id, snippet, ts FROM mentions "
                "WHERE entity_type=? AND entity_id=? AND source_kind=? ORDER BY ts DESC",
                (entity_type, entity_id, source_kind),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT source_kind, source_id, snippet, ts FROM mentions "
                "WHERE entity_type=? AND entity_id=? ORDER BY ts DESC",
                (entity_type, entity_id),
            ).fetchall()
    return [dict(r) for r in rows]


def tag_text(
    text: str,
    source_kind: str,
    source_id: str,
    ts: Optional[int] = None,
) -> dict:
    """Convenience: scannt Text, schreibt mentions für alle Treffer.

    Returns: {"projects": [ids], "people": [ids]}
    """
    project_ids = detect_projects(text)
    people_ids = detect_people(text)
    snippet = (text or "")[:500]
    for pid in project_ids:
        record_mention(ENTITY_PROJECT, pid, source_kind, source_id, snippet, ts)
    for pid in people_ids:
        record_mention(ENTITY_PERSON, pid, source_kind, source_id, snippet, ts)
    return {"projects": project_ids, "people": people_ids}


# ---------- Channel-Ingest ----------

_EMAIL_ADDR_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")


def _extract_email(raw: str) -> Optional[str]:
    if not raw:
        return None
    m = _EMAIL_ADDR_RE.search(raw)
    return m.group(0).lower() if m else None


def ingest_email(
    from_raw: str,
    subject: str,
    message_id: str,
    ts: Optional[int] = None,
    body_snippet: str = "",
) -> dict:
    """Mail-Touchpoint verbuchen. Resolved Absender, sonst Name-Detect im Subject."""
    if not message_id:
        return {"person_id": None, "projects": [], "people": []}
    addr = _extract_email(from_raw)
    person_id = find_person_by_email(addr) if addr else None
    snippet = (subject or "")[:200]
    if body_snippet:
        snippet = (snippet + " — " + body_snippet)[:500]
    out = {"person_id": person_id, "projects": [], "people": []}
    if person_id:
        record_mention(ENTITY_PERSON, person_id, SOURCE_EMAIL, message_id, snippet, ts)
        out["people"].append(person_id)
    text_for_scan = f"{subject or ''} {body_snippet or ''}".strip()
    if text_for_scan:
        scan = tag_text(text_for_scan, SOURCE_EMAIL, message_id, ts)
        out["projects"] = scan["projects"]
        for pid in scan["people"]:
            if pid not in out["people"]:
                out["people"].append(pid)
    return out


def ingest_whatsapp(
    chat_id: str,
    message_id: str,
    body: str,
    ts: Optional[int] = None,
) -> dict:
    """WhatsApp-Touchpoint verbuchen. Person via whatsapp_chat_id."""
    if not chat_id or not message_id:
        return {"person_id": None, "projects": [], "people": []}
    person_id = find_person_by_wa_chat(chat_id)
    snippet = (body or "")[:500]
    out = {"person_id": person_id, "projects": [], "people": []}
    if person_id:
        record_mention(ENTITY_PERSON, person_id, SOURCE_WHATSAPP, message_id, snippet, ts)
        out["people"].append(person_id)
    if body:
        scan = tag_text(body, SOURCE_WHATSAPP, message_id, ts)
        out["projects"] = scan["projects"]
        for pid in scan["people"]:
            if pid not in out["people"]:
                out["people"].append(pid)
    return out


def ingest_calendar(
    event_id: str,
    title: str,
    notes: str = "",
    ts: Optional[int] = None,
) -> dict:
    """Calendar-Event nach Mention-Hits scannen (Title + Notes)."""
    if not event_id:
        return {"projects": [], "people": []}
    text = f"{title or ''} {notes or ''}".strip()
    if not text:
        return {"projects": [], "people": []}
    return tag_text(text, SOURCE_DOC, f"cal:{event_id}", ts)


def person_timeline(person_id: int, limit: int = 100) -> list[dict]:
    """Alle Touchpoints einer Person, neueste zuerst. Übergreifend über alle Kanäle."""
    with _conn() as db:
        rows = db.execute(
            "SELECT id, source_kind, source_id, snippet, ts "
            "FROM mentions WHERE entity_type=? AND entity_id=? "
            "ORDER BY ts DESC LIMIT ?",
            (ENTITY_PERSON, person_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def search_mentions_semantic(
    query: str,
    person_id: Optional[int] = None,
    k: int = 10,
) -> list[dict]:
    """Semantische Suche über mention-Snippets via cosine similarity.

    Optional auf eine Person eingegrenzt. Liefert Top-k mit score, snippet,
    source_kind, ts. Embeddings müssen via scripts/embed-mentions.py existieren.
    """
    q = (query or "").strip()
    if not q:
        return []
    try:
        from backend import embeddings as emb
    except Exception:
        return []
    try:
        q_vec = emb.embed(q, feature="mention_search")
    except Exception:
        return []
    sql = (
        "SELECT m.id, m.snippet, m.source_kind, m.source_id, m.ts, "
        "       m.entity_id, e.vector "
        "FROM mentions m JOIN mention_embeddings e ON e.mention_id = m.id "
        "WHERE m.entity_type=? "
    )
    params: list = [ENTITY_PERSON]
    if person_id:
        sql += "AND m.entity_id=? "
        params.append(person_id)
    with _conn() as db:
        rows = db.execute(sql, params).fetchall()
    scored: list[tuple[float, dict]] = []
    for r in rows:
        try:
            vec = emb._unpack(r["vector"])
            s = emb.cosine(q_vec, vec)
        except Exception:
            continue
        scored.append((s, {
            "mention_id": r["id"],
            "person_id": r["entity_id"],
            "snippet": r["snippet"],
            "source_kind": r["source_kind"],
            "source_id": r["source_id"],
            "ts": r["ts"],
            "score": s,
        }))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [d for _, d in scored[:k]]
