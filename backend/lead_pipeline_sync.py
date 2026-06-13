"""denzer_leads (chat.db) → people.db Sync.

Schreibt direkt in `people` (alle Customer-Felder leben dort als Spalten).

Schutzschichten:
- Identity-only Match (email, phone) via person_identities, kein Name-Fallback.
- Konflikt zwischen Email-Person und Phone-Person → Quarantine, nicht mergen.
- Wenn Email bereits an anderer Person hängt → Quarantine.
- Test/Spam-Leads → Quarantine, kein PII in people.
- Pro Lead (kv_key) genau eine Entscheidung in lead_sync_state.
- Bei Neuanlage werden email und phone sofort als person_identities registriert.
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from eingang import _is_test_lead


_ROOT = Path(__file__).resolve().parent.parent
_CHAT_DB = _ROOT / "data" / "chat.db"
_PEOPLE_DB = _ROOT / "data" / "people.db"


def _norm_email(v: str) -> str | None:
    v = (v or "").strip().lower()
    return v or None


def _norm_phone(v: str) -> str | None:
    if not v:
        return None
    digits = "".join(c for c in v if c.isdigit() or c == "+")
    return digits or None


def _ensure_schema(p_con: sqlite3.Connection) -> None:
    p_con.execute(
        """CREATE TABLE IF NOT EXISTS lead_sync_state (
            kv_key TEXT PRIMARY KEY,
            person_id INTEGER,
            decision TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            synced_at INTEGER NOT NULL
        )"""
    )
    p_con.execute(
        """CREATE TABLE IF NOT EXISTS lead_quarantine (
            kv_key TEXT PRIMARY KEY,
            reason TEXT NOT NULL,
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            email_person_id INTEGER,
            phone_person_id INTEGER,
            created_at INTEGER NOT NULL
        )"""
    )


def _workshop_kind_from_source(source: str) -> str | None:
    s = (source or "").lower()
    if s.startswith("ai-sprint-"):
        return "ai-sprint"
    if s.startswith("agent-bound-"):
        return "agent-bound"
    if s.startswith("dsgvo-"):
        return "dsgvo"
    return None


def _default_stage_for(source: str, confirmation_sent: bool) -> str:
    # Ein ausgefuelltes Workshop-Formular ist faktisch schon eine Anmeldung.
    # Die fruehere 'lead'-Stage gibt es nicht mehr; ob bestaetigt wurde,
    # steckt im Checklist-Item 'anmeldung:bestaetigung', nicht in der Stage.
    s = (source or "").lower()
    if s == "ai-sprint-2026-05-06":
        return "durchgefuehrt"
    return "anmeldung"


def _load_absage_index() -> tuple[dict[str, dict], dict[str, dict], dict[int, dict]]:
    by_email: dict[str, dict] = {}
    by_phone: dict[str, dict] = {}
    by_person: dict[int, dict] = {}
    with sqlite3.connect(_CHAT_DB) as con:
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT person_email, person_phone, person_name, person_id, ts, source "
            "FROM events WHERE klassifikation='workshop-absage' ORDER BY ts ASC"
        ).fetchall()
    for r in rows:
        rec = {
            "ts_iso": datetime.fromtimestamp(float(r["ts"] or 0), tz=timezone.utc).date().isoformat() if r["ts"] else "",
            "source": r["source"] or "",
            "name": r["person_name"] or "",
        }
        em = (r["person_email"] or "").strip().lower()
        ph = (r["person_phone"] or "").strip()
        pid = r["person_id"]
        if em:
            by_email[em] = rec
        if ph:
            by_phone[ph] = rec
        if pid:
            by_person[int(pid)] = rec
    return by_email, by_phone, by_person


def _find_person_by_identity(p_con: sqlite3.Connection, kind: str, value_norm: str) -> int | None:
    row = p_con.execute(
        "SELECT person_id FROM person_identities WHERE kind=? AND value_norm=? LIMIT 1",
        (kind, value_norm),
    ).fetchone()
    return int(row[0]) if row else None


def _find_person_by_legacy_email(p_con: sqlite3.Connection, email_norm: str) -> int | None:
    """Fallback fuer Bestandsdaten: people.email ohne person_identities-Eintrag."""
    row = p_con.execute(
        "SELECT id FROM people WHERE LOWER(email)=? LIMIT 1", (email_norm,)
    ).fetchone()
    return int(row[0]) if row else None


def _find_person_by_legacy_phone(p_con: sqlite3.Connection, phone_norm: str) -> int | None:
    row = p_con.execute(
        "SELECT id FROM people WHERE REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'/','')=? LIMIT 1",
        (phone_norm,),
    ).fetchone()
    return int(row[0]) if row else None


def _quarantine(p_con: sqlite3.Connection, kv_key: str, reason: str,
                email: str, phone: str, name: str, source: str,
                email_pid: int | None = None, phone_pid: int | None = None) -> None:
    now = int(time.time())
    p_con.execute(
        """INSERT OR REPLACE INTO lead_quarantine
           (kv_key, reason, email, phone, name, source, email_person_id, phone_person_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (kv_key, reason, email, phone, name, source, email_pid, phone_pid, now),
    )
    p_con.execute(
        """INSERT OR REPLACE INTO lead_sync_state
           (kv_key, person_id, decision, reason, synced_at)
           VALUES (?, NULL, 'quarantined', ?, ?)""",
        (kv_key, reason, now),
    )


def _record_sync_state(p_con: sqlite3.Connection, kv_key: str, person_id: int,
                       decision: str, reason: str = "") -> None:
    p_con.execute(
        """INSERT OR REPLACE INTO lead_sync_state
           (kv_key, person_id, decision, reason, synced_at)
           VALUES (?, ?, ?, ?, ?)""",
        (kv_key, person_id, decision, reason, int(time.time())),
    )


def _resolve_person(p_con: sqlite3.Connection, email_norm: str | None,
                    phone_norm: str | None) -> tuple[int | None, str | None, int | None, int | None]:
    """Identity-only Match. Returns (pid, conflict_reason, email_pid, phone_pid)."""
    email_pid: int | None = None
    phone_pid: int | None = None
    if email_norm:
        email_pid = _find_person_by_identity(p_con, "email", email_norm)
        if email_pid is None:
            email_pid = _find_person_by_legacy_email(p_con, email_norm)
    if phone_norm:
        phone_pid = _find_person_by_identity(p_con, "phone", phone_norm)
        if phone_pid is None:
            phone_pid = _find_person_by_legacy_phone(p_con, phone_norm)

    if email_pid and phone_pid and email_pid != phone_pid:
        return None, "identity_conflict", email_pid, phone_pid

    return (email_pid or phone_pid), None, email_pid, phone_pid


def _attach_identity(p_con: sqlite3.Connection, person_id: int, kind: str,
                     value: str, value_norm: str, source: str) -> None:
    try:
        p_con.execute(
            """INSERT INTO person_identities
               (person_id, kind, value, value_norm, label, is_primary, source, created_at)
               VALUES (?, ?, ?, ?, 'lead', 0, ?, ?)""",
            (person_id, kind, value.strip(), value_norm, source, int(time.time())),
        )
    except sqlite3.IntegrityError:
        pass


def _create_person(p_con: sqlite3.Connection, name: str, email: str, phone: str,
                   company: str, email_norm: str | None, phone_norm: str | None,
                   kv_key: str) -> int:
    now = int(time.time())
    cur = p_con.execute(
        """INSERT INTO people (name, email, phone, company, source, relation,
                               created_at, updated_at, last_interaction_ts)
           VALUES (?, ?, ?, ?, 'denzer-form', 'lead', ?, ?, ?)""",
        (name.strip() or email.strip() or "Unbekannt",
         email.strip() or None, phone.strip() or None, company.strip() or None,
         now, now, now),
    )
    pid = int(cur.lastrowid)
    src_label = f"denzer_lead:{kv_key}"
    if email_norm:
        _attach_identity(p_con, pid, "email", email, email_norm, src_label)
    if phone_norm:
        _attach_identity(p_con, pid, "phone", phone, phone_norm, src_label)
    return pid


def _quarantine_pii_reason(email: str, name: str, phone: str) -> str | None:
    """Pre-check: Test-Marker, role-Pattern, Wegwerf-Domains."""
    em = (email or "").lower().strip()
    nm = (name or "").lower().strip()
    if not em and not phone:
        return "no_contact"
    role_locals = {"info", "kontakt", "office", "admin", "noreply", "no-reply",
                   "postmaster", "webmaster", "rechnung", "buchhaltung"}
    if em and em.split("@", 1)[0] in role_locals:
        return "role_email"
    disposable = ("mailinator.com", "guerrillamail.com", "tempmail",
                  "yopmail.com", "trashmail", "10minutemail")
    if em and any(d in em for d in disposable):
        return "disposable_email"
    if nm in {"test", "abc", "asdf", "xxx"} or (nm and len(nm) < 2):
        return "implausible_name"
    return None


def _upsert_customer(p_con: sqlite3.Connection, person_id: int, stage: str,
                     workshop_kind: str, lead_source_label: str, source_id: str,
                     absage: dict | None) -> tuple[bool, bool]:
    """Schreibt Customer-Felder direkt auf people. `created` heisst hier:
    Person hatte vorher keine Customer-Daten (categories leer und
    pipeline_stream NULL)."""
    now = int(time.time())
    status = "pausiert" if absage else "aktiv"
    note_line = f"Workshop-Quelle: {source_id}"
    if absage:
        note_line += f" · Abgesagt {absage['ts_iso']} ({absage['source']})"

    row = p_con.execute(
        "SELECT customer_notes, pipeline_stage, categories, pipeline_stream "
        "  FROM people WHERE id=?",
        (person_id,),
    ).fetchone()
    if not row:
        return False, False

    existing_note = (row[0] or "").strip()
    current_stage = row[1] or ""
    current_cats = (row[2] or "").strip()
    current_stream = (row[3] or "").strip()
    had_customer_data = bool(current_stream) or (current_cats not in ("", "[]"))

    if note_line in existing_note:
        new_note = existing_note
    else:
        new_note = (existing_note + "\n" + note_line).strip() if existing_note else note_line
    stage_rank = {"anmeldung": 1, "gebucht": 2, "durchgefuehrt": 3,
                  "nachfass": 4, "abgeschlossen": 5}
    if absage:
        # Absage zieht die Stage auf 'anmeldung' zurueck und markiert
        # die Person als pausiert (status oben). Verhindert, dass abgesagte
        # Anmeldungen ewig auf 'gebucht'/'durchgefuehrt' kleben.
        stage = "anmeldung"
    elif stage_rank.get(current_stage, 0) > stage_rank.get(stage, 0):
        # Sonst: manuell hochgezogene Stage (z.B. gebucht, durchgefuehrt)
        # nicht runterspielen.
        stage = current_stage

    p_con.execute(
        """UPDATE people
           SET pipeline_stream='workshops',
               pipeline_stage=?,
               workshop_kind=COALESCE(?, workshop_kind),
               lead_source=COALESCE(lead_source, ?),
               customer_status=?,
               customer_notes=?,
               categories=CASE WHEN categories='[]' OR categories IS NULL OR categories='' THEN ? ELSE categories END,
               updated_at=?
           WHERE id=?""",
        (stage, workshop_kind, lead_source_label, status, new_note,
         json.dumps(["workshops"], ensure_ascii=False), now, person_id),
    )
    p_con.execute(
        """INSERT INTO person_pipeline_memberships
           (person_id, stream, stage, created_at, updated_at)
           VALUES (?, 'workshops', ?, ?, ?)
           ON CONFLICT(person_id, stream) DO UPDATE SET
             stage=excluded.stage, updated_at=excluded.updated_at""",
        (person_id, stage, now, now),
    )
    if had_customer_data:
        return False, True
    return True, False


def sync_denzer_leads_to_people() -> dict:
    """Idempotent. Returns counts."""
    if not _CHAT_DB.exists() or not _PEOPLE_DB.exists():
        return {"error": "db missing"}

    absagen_by_email, absagen_by_phone, absagen_by_person = _load_absage_index()

    with sqlite3.connect(_CHAT_DB) as c_con:
        c_con.row_factory = sqlite3.Row
        rows = c_con.execute(
            """SELECT kv_key, name, email, phone, company, source, confirmation_sent
               FROM denzer_leads"""
        ).fetchall()

    persons_created = 0
    customers_created = 0
    customers_updated = 0
    skipped_test = 0
    quarantined = 0
    skipped_already_synced = 0

    with sqlite3.connect(_PEOPLE_DB) as p_con:
        _ensure_schema(p_con)
        for r in rows:
            kv_key = r["kv_key"]
            src = r["source"] or ""
            name = (r["name"] or "").strip()
            email = (r["email"] or "").strip()
            phone = (r["phone"] or "").strip()
            company = (r["company"] or "").strip()

            already = p_con.execute(
                "SELECT decision, person_id FROM lead_sync_state WHERE kv_key=?",
                (kv_key,),
            ).fetchone()
            if already and already[0] == "quarantined":
                quarantined += 1
                continue

            if _is_test_lead(src, email, name):
                _quarantine(p_con, kv_key, "test_lead", email, phone, name, src)
                skipped_test += 1
                continue

            email_norm = _norm_email(email)
            phone_norm = _norm_phone(phone)
            pid, conflict, email_pid, phone_pid = _resolve_person(p_con, email_norm, phone_norm)

            if conflict:
                _quarantine(p_con, kv_key, conflict, email, phone, name, src,
                            email_pid=email_pid, phone_pid=phone_pid)
                quarantined += 1
                continue

            if pid is None:
                # Neuanlage: hier PII-Schutz aktivieren. Bestehende Personen
                # duerfen ueber role_email/disposable trotzdem aktualisiert werden.
                pii_reason = _quarantine_pii_reason(email, name, phone)
                if pii_reason:
                    _quarantine(p_con, kv_key, pii_reason, email, phone, name, src)
                    quarantined += 1
                    continue
                pid = _create_person(p_con, name, email, phone, company,
                                     email_norm, phone_norm, kv_key)
                persons_created += 1
                _record_sync_state(p_con, kv_key, pid, "created")
            else:
                src_label = f"denzer_lead:{kv_key}"
                if email_norm and not _find_person_by_identity(p_con, "email", email_norm):
                    _attach_identity(p_con, pid, "email", email, email_norm, src_label)
                if phone_norm and not _find_person_by_identity(p_con, "phone", phone_norm):
                    _attach_identity(p_con, pid, "phone", phone, phone_norm, src_label)
                _record_sync_state(p_con, kv_key, pid, "matched")

            kind = _workshop_kind_from_source(src)
            if not kind:
                continue

            stage = _default_stage_for(src, bool(r["confirmation_sent"]))

            absage = None
            if email:
                absage = absagen_by_email.get(email.lower())
            if not absage and phone:
                absage = absagen_by_phone.get(phone.strip())
            if not absage and pid in absagen_by_person:
                absage = absagen_by_person[pid]
            if not absage:
                prow = p_con.execute(
                    "SELECT email, phone FROM people WHERE id=?", (pid,)
                ).fetchone()
                if prow:
                    pe = (prow[0] or "").strip().lower()
                    pp = (prow[1] or "").strip()
                    if pe and pe in absagen_by_email:
                        absage = absagen_by_email[pe]
                    elif pp and pp in absagen_by_phone:
                        absage = absagen_by_phone[pp]

            c_created, c_updated = _upsert_customer(
                p_con, pid, stage, kind,
                lead_source_label="formular",
                source_id=src,
                absage=absage,
            )
            if c_created:
                customers_created += 1
            elif c_updated:
                customers_updated += 1
        p_con.commit()

    return {
        "persons_created": persons_created,
        "customers_created": customers_created,
        "customers_updated": customers_updated,
        "skipped_test": skipped_test,
        "quarantined": quarantined,
        "skipped_already_synced": skipped_already_synced,
    }
