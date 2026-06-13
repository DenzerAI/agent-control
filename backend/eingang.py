"""Eingang-Orchestrator — zentrales Event-Recording.

Alle Quellen (Gmail, denzer-Forms, WhatsApp, Workshops, …) rufen
record_event() auf. Wir schreiben in events (chat.db); sichtbare Fokus-Signale
kommen über Leads, Wartet-auf-dich und CRM zurück.

Sieh brain/ideas/eingang-orchestrator.md für die Kette und das UI-Design.
"""
from __future__ import annotations

import json
import sqlite3
import time
from typing import Optional

from db import get_db


# Klassifikation → InfoPane-Sektion (für orange Icons)
_SECTION_FOR_KLASS = {
    "neuer-lead": "leads",
    "workshop-anmeldung": "workshops",
    "workshop-absage": "workshops",
    "kunden-antwort": "fokus",
    "termin-anfrage": "fokus",
    "info-only": "fokus",
}

# denzer-Leads Test-/Smoke-/Bot-Filter (Quelle der Wahrheit: server.py)
_DENZER_TEST_SOURCES = {
    "kv-test", "mail-test", "resend-test",
    "diag-mailfix-after-deploy", "diag-mailfix-12-42",
    "ai-sprint",  # nackte Test-Source vom Worker-Setup
    "lead-magnet-3-agents",  # interner Lead-Magnet-Test
    "watchdog-debug", "watchdog-track-debug",  # Smoketests vom Watchdog
}
_DENZER_TEST_EMAIL_EXACT = {
    "test@example.com",
    "waitlist-check@example.com",
    "test@x.de",
    "test@test.de",
}


def _is_test_lead(source: str, email: str, name: str) -> bool:
    src = (source or "").strip().lower()
    if src in _DENZER_TEST_SOURCES:
        return True
    em = (email or "").strip().lower()
    nm = (name or "").strip().lower()
    if em in _DENZER_TEST_EMAIL_EXACT:
        return True
    if "owner-account" in em or "watchdog" in em:
        return True
    if em.endswith("@example.com") or em.endswith("@trest.de") or em.endswith("@test.local"):
        return True
    for marker in ("+test", "+diag", "+nahtlos", "+kvfinal", "+subj-test"):
        if marker in em:
            return True
    if " " in em or "\t" in em:
        return True
    if nm and len(nm) >= 6 and " " not in nm and not any(v in nm for v in "aeiouäöü"):
        return True
    return False


# Workshop-Source-Prefixes → klassifikation 'workshop-anmeldung'
_WORKSHOP_SOURCE_PREFIXES = ("ai-sprint-",)


def _klassifikation_from_lead_source(source: str) -> str:
    src = (source or "").lower()
    for pfx in _WORKSHOP_SOURCE_PREFIXES:
        if src.startswith(pfx):
            return "workshop-anmeldung"
    return "neuer-lead"


def section_for(klassifikation: str) -> str:
    return _SECTION_FOR_KLASS.get(klassifikation, "fokus")


def _resolve_person(db: sqlite3.Connection, email: str, phone: str) -> tuple[Optional[int], str]:
    """Sucht in people.db nach passender Person. Gibt (person_id, name) zurück.
    name kommt vom people-Eintrag, falls vorhanden, sonst leerer String.

    people.db ist eine zweite SQLite-Datei. Wir öffnen sie hier separat.
    """
    if not email and not phone:
        return None, ""
    from pathlib import Path
    pdb_path = Path(__file__).parent.parent / "data" / "people.db"
    if not pdb_path.exists():
        return None, ""
    try:
        pdb = sqlite3.connect(pdb_path, timeout=5)
        try:
            row = None
            if email:
                em = email.strip().lower()
                row = pdb.execute(
                    "SELECT id, name FROM people WHERE LOWER(email) = ? LIMIT 1",
                    (em,),
                ).fetchone()
                if not row:
                    row = pdb.execute(
                        "SELECT p.id, p.name FROM person_identities i JOIN people p ON p.id = i.person_id "
                        "WHERE i.kind = 'email' AND i.value_norm = ? LIMIT 1",
                        (em,),
                    ).fetchone()
            if not row and phone:
                ph = phone.strip()
                row = pdb.execute(
                    "SELECT id, name FROM people WHERE phone = ? LIMIT 1",
                    (ph,),
                ).fetchone()
            if row:
                return int(row[0]), str(row[1] or "")
        finally:
            pdb.close()
    except Exception:
        return None, ""
    return None, ""


def record_event(
    *,
    source: str,
    external_id: str,
    klassifikation: str,
    subject: str = "",
    excerpt: str = "",
    person_email: str = "",
    person_phone: str = "",
    person_name: str = "",
    payload: Optional[dict] = None,
    bezug: Optional[dict] = None,
    konfidenz: float = 1.0,
    grund: str = "",
    fokus_title: str = "",
    ts: Optional[float] = None,
    silent: bool = False,
) -> dict:
    """Schreibt ein Event in events. Idempotent über UNIQUE(source, external_id).

    Eingangssignale werden als Events gespeichert. Die alte Fokus-Inbox wird
    nicht mehr befüllt; relevante Signale kommen über Leads, Wartet-auf-dich
    und CRM zurück.

    silent=True: Bestands-Backfill. Event wird sofort als seen=1 markiert
    und kein Fokus-Inbox-Eintrag wird erzeugt. Dient dazu, beim ersten Lauf
    Bestandsdaten in events zu hinterlegen, ohne der Nutzer zu spammen.

    Gibt {ok, inserted, event_id, fokus_added} zurück.
    """
    ts_val = ts if ts is not None else time.time()
    payload_json = json.dumps(payload or {}, ensure_ascii=False)
    bezug_json = json.dumps(bezug or {}, ensure_ascii=False)
    now = time.time()

    needs_focus = False
    fokus_text = ""

    with get_db() as db:
        # Schon mal gesehen?
        existing = db.execute(
            "SELECT id FROM events WHERE source = ? AND external_id = ?",
            (source, external_id),
        ).fetchone()
        if existing:
            return {"ok": True, "inserted": False, "event_id": existing[0], "fokus_added": False}

        person_id, resolved_name = _resolve_person(db, person_email, person_phone)
        if not person_name and resolved_name:
            person_name = resolved_name

        seen_val = 1 if silent else 0
        seen_at_val = now if silent else None
        cur = db.execute(
            """INSERT INTO events (
                source, external_id, ts,
                person_email, person_phone, person_name, person_id,
                subject, excerpt, payload,
                klassifikation, bezug, konfidenz, grund,
                fokus_added, fokus_title, seen, seen_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                source, external_id, ts_val,
                person_email, person_phone, person_name, person_id,
                subject[:500], excerpt[:2000], payload_json,
                klassifikation, bezug_json, konfidenz, grund[:500],
                1 if needs_focus else 0, fokus_text[:300], seen_val, seen_at_val, now,
            ),
        )
        event_id = cur.lastrowid

    return {"ok": True, "inserted": True, "event_id": event_id, "fokus_added": needs_focus, "person_id": person_id}


_ABSAGE_KEYWORDS = (
    "absag", "kann nicht", "kann doch nicht", "kann leider nicht",
    "muss absagen", "muss leider absagen", "muss canceln",
    "stornier", "cancel", "verhindert", "doch verhindert",
    "verschieb", "kann doch nicht teilnehmen", "leider nicht dabei",
)


def _is_workshop_participant(db: sqlite3.Connection, email: str) -> bool:
    """True wenn die Adresse als Teilnehmer in denzer_leads mit
    Workshop-Source (ai-sprint-*) auftaucht."""
    em = (email or "").strip().lower()
    if not em:
        return False
    row = db.execute(
        "SELECT 1 FROM denzer_leads WHERE LOWER(email) = ? AND source LIKE 'ai-sprint-%' LIMIT 1",
        (em,),
    ).fetchone()
    return bool(row)


def _classify_mail(subject: str, from_email: str, is_participant: bool) -> Optional[str]:
    """Klassifiziert eine Mail anhand Subject + Teilnehmer-Status.

    Konservativ: Nur Workshop-Teilnehmer → Klassifikation. Sonst None (skip).
    Workshop-Absage erkannt an Absage-Keywords im Subject; sonst kunden-antwort.
    """
    if not is_participant:
        return None
    subj = (subject or "").lower()
    for kw in _ABSAGE_KEYWORDS:
        if kw in subj:
            return "workshop-absage"
    return "kunden-antwort"


_SCAN_ACCOUNTS = ("owner-account", "denzer")


# Vorfilter fuer Mail-Cancel-Detector: nur wenn Subject hinweist, holen wir den Body
# und fragen das LLM. Spart pro Tag dutzende IMAP-Roundtrips + LLM-Calls.
_MAIL_CANCEL_HINTS = (
    "absag", "verschieb", "stornier", "cancel", "kann nicht",
    "muss leider", "schaff", "krank", "ausfall", "verleg",
    "klappt nicht", "termin",
    "gebunden", "kollidi", "nicht dabei", "leider doch", "doch nicht",
    "passt nicht", "anderweitig",
)


def _looks_like_mail_cancellation(subject: str) -> bool:
    s = (subject or "").lower()
    return any(h in s for h in _MAIL_CANCEL_HINTS)


def _is_active_lead(from_email: str) -> bool:
    """True wenn die Adresse aktiver Workshop-Lead ist (status='confirmed')."""
    em = (from_email or "").strip().lower()
    if not em:
        return False
    try:
        with get_db() as db:
            row = db.execute(
                "SELECT 1 FROM denzer_leads WHERE lower(email) = ? "
                "AND status = 'confirmed' AND source LIKE 'ai-sprint-%' LIMIT 1",
                (em,),
            ).fetchone()
            return row is not None
    except Exception:
        return False


def _maybe_handle_mail_cancellation(*, acc_key: str, uid: Any, from_email: str,
                                     subject: str, message_id: str) -> None:
    """Mail-Pendant zu _maybe_handle_cancellation in modules/whatsapp/core.py.

    Vorfilter: Subject-Hint ODER aktiver Workshop-Lead (deckt AW:/Re:-Replies
    ab, deren Subject das Cancel-Signal nicht enthaelt)."""
    if not _looks_like_mail_cancellation(subject) and not _is_active_lead(from_email):
        return
    try:
        from modules.cancel_detector.core import (
            person_id_for_email, handle_incoming_message,
        )
    except Exception as imp_err:
        print(f"[CANCEL-MAIL] import failed: {imp_err}")
        return
    pid = person_id_for_email(from_email)
    if not pid:
        return
    body = ""
    try:
        import mail as _mail
        msg = _mail.fetch_message(acc_key, str(uid))
        body = (msg.get("body_text") or "").strip()
        if not body:
            html = msg.get("body_html") or ""
            import re as _re
            body = _re.sub(r"<[^>]+>", " ", html)
            body = _re.sub(r"\s+", " ", body).strip()
    except Exception as fetch_err:
        print(f"[CANCEL-MAIL] body fetch failed: {fetch_err}")

    text = (subject + "\n\n" + body).strip() if body else subject
    if len(text) < 5:
        return
    import asyncio
    try:
        res = asyncio.run(handle_incoming_message(
            text=text, source="mail", source_ref=str(message_id), person_id=pid,
        ))
    except RuntimeError:
        # Falls schon ein Loop laeuft (sollte in scan_mail nicht passieren).
        loop = asyncio.new_event_loop()
        try:
            res = loop.run_until_complete(handle_incoming_message(
                text=text, source="mail", source_ref=str(message_id), person_id=pid,
            ))
        finally:
            loop.close()
    if res.get("cancelled"):
        print(f"[CANCEL-MAIL] event {res.get('event_id')} marked cancelled "
              f"(person {pid}, reason={res.get('reason')!r})")


def scan_mail(limit: int = 50) -> dict:
    """Scannt die letzten `limit` INBOX-Mails von owner-account und denzer auf Workshop-Bezug.

    Workshop-Teilnehmer (Absender in denzer_leads mit ai-sprint-*-Source) werden
    klassifiziert: Subject mit Absage-Keyword → 'workshop-absage', sonst
    'kunden-antwort'. record_event() ist idempotent über Message-ID, also egal
    wenn dieselbe Mail in beiden Konten landet.

    Returns {scanned, recorded, absagen, antworten, skipped, error}.
    """
    out = {"scanned": 0, "recorded": 0, "absagen": 0, "antworten": 0, "skipped": 0, "error": None}
    try:
        import mail as _mail
    except Exception as e:
        out["error"] = str(e)
        return out

    with get_db() as db:
        for acc_key in _SCAN_ACCOUNTS:
            try:
                threads = _mail.fetch_inbox(acc_key, limit=limit)
            except Exception as e:
                out["error"] = f"{acc_key}: {e}" if not out["error"] else f"{out['error']}; {acc_key}: {e}"
                continue
            for t in threads:
                out["scanned"] += 1
                mid = (t.get("message_id") or "").strip()
                from_raw = t.get("from_raw") or t.get("from") or ""
                from_email = ""
                from_name = ""
                try:
                    from email.utils import parseaddr
                    from_name, from_email = parseaddr(from_raw)
                    from_email = (from_email or "").strip().lower()
                except Exception:
                    pass
                if not mid or not from_email:
                    out["skipped"] += 1
                    continue
                external_id = mid

                # Cancel-Detector: für JEDE Mail mit Verdacht laufen lassen,
                # unabhängig von Workshop-Status. Trifft PT- und Normaltermine.
                try:
                    _maybe_handle_mail_cancellation(
                        acc_key=acc_key, uid=t.get("uid"),
                        from_email=from_email, subject=t.get("subject", ""),
                        message_id=mid,
                    )
                except Exception as cd_err:
                    print(f"[CANCEL-MAIL] detector error: {cd_err}")

                is_part = _is_workshop_participant(db, from_email)
                klass = _classify_mail(t.get("subject", ""), from_email, is_part)
                if not klass:
                    out["skipped"] += 1
                    continue

                ts_val = float(t.get("ts") or time.time())
                res = record_event(
                    source=f"gmail-{acc_key}",
                    external_id=external_id,
                    klassifikation=klass,
                    subject=t.get("subject", ""),
                    excerpt=t.get("subject", ""),
                    person_email=from_email,
                    person_name=from_name or "",
                    payload={"uid": t.get("uid"), "from_raw": from_raw, "account": acc_key},
                    ts=ts_val,
                )
                if res.get("inserted"):
                    out["recorded"] += 1
                    if klass == "workshop-absage":
                        out["absagen"] += 1
                    else:
                        out["antworten"] += 1
    return out


def reconcile_denzer_leads() -> dict:
    """Sucht denzer_leads ohne korrespondierendes Event und legt sie an.

    Beim ersten Lauf (events ist leer für source='denzer-form') wird der
    gesamte Bestand mit silent=True angelegt — keine Fokus-Spam-Welle. Bei
    späteren Läufen kommen nur tatsächlich neue Leads mit seen=0 rein.

    Returns {reconciled, new_visible} — Anzahl angelegter Events insgesamt
    und davon Anzahl mit seen=0 (also fürs orange Icon relevant).
    """
    with get_db() as db:
        first_run = db.execute(
            "SELECT COUNT(*) FROM events WHERE source = 'denzer-form'"
        ).fetchone()[0] == 0
        db.row_factory = sqlite3.Row
        rows = db.execute(
            """SELECT kv_key, ts_kv, name, email, phone, company, message,
                      source AS lead_source, level
               FROM denzer_leads
               WHERE kv_key NOT IN (
                   SELECT external_id FROM events WHERE source = 'denzer-form'
               )"""
        ).fetchall()

    reconciled = 0
    new_visible = 0
    for r in rows:
        if _is_test_lead(r["lead_source"], r["email"], r["name"]):
            continue
        klass = _klassifikation_from_lead_source(r["lead_source"])
        ts_val = (r["ts_kv"] or 0) / 1000.0 if r["ts_kv"] else time.time()
        result = record_event(
            source="denzer-form",
            external_id=r["kv_key"],
            klassifikation=klass,
            subject=(r["message"] or "")[:200],
            excerpt=(r["message"] or ""),
            person_email=r["email"] or "",
            person_phone=r["phone"] or "",
            person_name=r["name"] or "",
            payload={"company": r["company"], "level": r["level"], "lead_source": r["lead_source"]},
            ts=ts_val,
            silent=first_run,
        )
        if result.get("inserted"):
            reconciled += 1
            if not first_run:
                new_visible += 1

    # WhatsApp-Absage-Scanner: legt workshop-absage Events für Workshop-
    # Customers an, deren WhatsApp eine Absage-Phrase enthält. Vor dem
    # Pipeline-Sync laufen lassen, damit das Sync-Modul die frischen
    # Absagen sofort sieht und Status auf pausiert setzt.
    try:
        from whatsapp_workshop_scan import scan_whatsapp_for_workshop_absagen
        wa_stats = scan_whatsapp_for_workshop_absagen()
    except Exception as e:
        wa_stats = {"error": str(e)[:200]}

    # Lead→Pipeline-Sync: schreibt denzer_leads als Person+Customer in
    # people.db (workshops-Pipeline). Idempotent, billig.
    try:
        from lead_pipeline_sync import sync_denzer_leads_to_people
        pipeline_stats = sync_denzer_leads_to_people()
    except Exception as e:
        pipeline_stats = {"error": str(e)[:200]}

    return {"reconciled": reconciled, "new_visible": new_visible,
            "first_run": first_run, "wa_absage": wa_stats,
            "pipeline": pipeline_stats}


_mail_scan_lock = __import__("threading").Lock()
_mail_scan_state = {"last_ts": 0.0, "running": False}
_MAIL_SCAN_THROTTLE_S = 180.0  # max einmal pro 3 Minuten


def _maybe_scan_mail_async() -> None:
    """Startet scan_mail() im Hintergrund, wenn throttle abgelaufen.

    Nicht-blockierend — counts-Endpoint kommt sofort zurück. Beim nächsten
    Frontend-Poll (60s später) sieht der Nutzer dann neue orange Icons.
    """
    import threading
    now = time.time()
    with _mail_scan_lock:
        if _mail_scan_state["running"]:
            return
        if now - _mail_scan_state["last_ts"] < _MAIL_SCAN_THROTTLE_S:
            return
        _mail_scan_state["running"] = True

    def _run():
        try:
            scan_mail(limit=20)
        except Exception:
            pass
        finally:
            with _mail_scan_lock:
                _mail_scan_state["last_ts"] = time.time()
                _mail_scan_state["running"] = False

    threading.Thread(target=_run, daemon=True, name="eingang-mail-scan").start()


def count_unseen_per_section(do_reconcile: bool = True) -> dict:
    """Aggregiert unseen-Counts pro Sektion über events.

    Returns:
        {"fokus": int, "leads": int, "workshops": int, "total": int, "reconciled": int}

    Wenn do_reconcile=True, läuft vorher reconcile_denzer_leads() — lazy
    Sync von neuen denzer-Leads in events. Damit braucht's keinen separaten
    Worker neben dem launchd-Sync.

    Sektion 'leads' kommt aus events.klassifikation='neuer-lead'.
    'workshops' aus 'workshop-anmeldung' und 'workshop-absage'.
    'fokus' aus 'kunden-antwort' und 'termin-anfrage'.
    """
    reconciled = 0
    if do_reconcile:
        try:
            r = reconcile_denzer_leads()
            reconciled = r.get("new_visible", 0)
        except Exception:
            pass
        _maybe_scan_mail_async()

    out = {"fokus": 0, "leads": 0, "workshops": 0}
    with get_db() as db:
        rows = db.execute(
            "SELECT klassifikation, COUNT(*) FROM events WHERE seen = 0 GROUP BY klassifikation"
        ).fetchall()
        for klass, cnt in rows:
            sec = section_for(klass)
            if sec in out:
                out[sec] += int(cnt)
    out["total"] = out["fokus"] + out["leads"] + out["workshops"]
    out["reconciled"] = reconciled
    return out


def mark_seen(*, event_ids: Optional[list[int]] = None, section: Optional[str] = None, all_flag: bool = False) -> dict:
    """Markiert Events als gesehen.

    Modi:
      - event_ids: konkrete Liste
      - section: alle Events einer Sektion. Für 'leads' wird zusätzlich
        denzer_leads.seen mitgesetzt (alte API bleibt konsistent).
      - all_flag: alle Events + denzer_leads
    """
    now = time.time()
    affected = 0
    with get_db() as db:
        if all_flag:
            cur = db.execute("UPDATE events SET seen = 1, seen_at = ? WHERE seen = 0", (now,))
            affected = cur.rowcount
            db.execute("UPDATE denzer_leads SET seen = 1, seen_at = ? WHERE seen = 0", (now,))
        elif section:
            klasses = [k for k, sec in _SECTION_FOR_KLASS.items() if sec == section]
            if klasses:
                placeholders = ",".join("?" * len(klasses))
                cur = db.execute(
                    f"UPDATE events SET seen = 1, seen_at = ? WHERE seen = 0 AND klassifikation IN ({placeholders})",
                    (now, *klasses),
                )
                affected = cur.rowcount
            if section == "leads":
                db.execute("UPDATE denzer_leads SET seen = 1, seen_at = ? WHERE seen = 0", (now,))
        elif event_ids:
            placeholders = ",".join("?" * len(event_ids))
            cur = db.execute(
                f"UPDATE events SET seen = 1, seen_at = ? WHERE id IN ({placeholders})",
                (now, *event_ids),
            )
            affected = cur.rowcount
    return {"ok": True, "affected": affected}


def list_recent(limit: int = 50, unseen_only: bool = False) -> list[dict]:
    """Listet Events absteigend nach ts. Für die InfoPane-Anzeige."""
    sql = "SELECT id, source, external_id, ts, person_email, person_name, subject, excerpt, klassifikation, konfidenz, grund, fokus_title, seen FROM events"
    if unseen_only:
        sql += " WHERE seen = 0"
    sql += " ORDER BY ts DESC LIMIT ?"
    with get_db() as db:
        rows = db.execute(sql, (max(1, min(500, limit)),)).fetchall()
    return [
        {
            "id": r[0],
            "source": r[1],
            "external_id": r[2],
            "ts": r[3],
            "person_email": r[4],
            "person_name": r[5],
            "subject": r[6],
            "excerpt": r[7],
            "klassifikation": r[8],
            "section": section_for(r[8]),
            "konfidenz": r[9],
            "grund": r[10],
            "fokus_title": r[11],
            "seen": bool(r[12]),
        }
        for r in rows
    ]
