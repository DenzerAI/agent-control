"""Deterministischer Context Router fuer Klaus.

Liest nur vorhandene Quellen, schreibt keine neue Wissensablage und protokolliert
jeden Lauf im bestehenden Workflow Run Log.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from db import get_db
from identity import get_agent_profile


ROOT = Path(__file__).resolve().parents[1]
BRAIN = ROOT / "brain"
ACTIVE_PROFILE = get_agent_profile("main")
MAX_SOURCES = 4
MAX_BLOCK_CHARS = 1800
MAX_SNIPPET_CHARS = 360

STOP = {
    "aber", "auch", "dann", "dass", "dein", "deine", "dem", "den", "der", "des",
    "die", "doch", "ein", "eine", "einer", "einem", "einen", "egal", "erst",
    "ganz", "gibt", "haben", "habe", "hat", "heute", "hier", "ich", "ihm",
    "immer", "ist", "jetzt", "kein", "keine", "klaus", "mal", "mehr", "mich",
    "mit", "nach", "nicht", "noch", "oder", "sind", "und", "uns", "vom",
    "von", "wann", "was", "weil", "wenn", "wie", "wir", "wird", "würde",
    "zum", "zur",
    "context", "kontext", "system", "bauen", "gebaut", "sachen", "sache",
    "thema", "themen", "irgendwie", "wirklich",
    "alt", "alte", "alten", "treffer", "quelle", "quellen", "geladen",
    "kandidaten", "ranking", "feedback", "begruendung", "begründung",
}

CORE_FILES = [
    BRAIN / "MEMORY.md",
    BRAIN / "LEARNINGS.md",
    BRAIN / "PROJECTS.md",
    BRAIN / "threads.md",
    Path(ACTIVE_PROFILE["rules_path"]),
    Path(ACTIVE_PROFILE["soul_path"]),
]


def _tokens(text: str, limit: int = 8) -> list[str]:
    words = re.findall(r"[A-Za-zÄÖÜäöüß0-9]{3,}", (text or "").lower())
    out: list[str] = []
    for w in words:
        if w in STOP or w in out:
            continue
        out.append(w)
        if len(out) >= limit:
            break
    return out


def _score(tokens: list[str], text: str) -> int:
    body = (text or "").lower()
    return sum(1 for t in tokens if t in body)


def _matched_tokens(tokens: list[str], text: str) -> list[str]:
    body = (text or "").lower()
    return [t for t in tokens if t in body]


def _weak_partial_match(tokens: list[str], matched: list[str]) -> bool:
    return (
        len(tokens) >= 2
        and len(matched) == 1
        and len(matched[0]) <= 3
        and any(len(t) > 3 for t in tokens)
    )


def _clean(text: str, max_chars: int = 520) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return text if len(text) <= max_chars else text[: max_chars - 1].rstrip() + "…"


def _snippet(path: Path, tokens: list[str], max_chars: int = MAX_SNIPPET_CHARS) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    ranked = sorted(
        ((sum(1 for t in tokens if t in ln.lower()), idx, ln) for idx, ln in enumerate(lines)),
        key=lambda x: (-x[0], x[1]),
    )
    parts = [ln for sc, _, ln in ranked if sc > 0][:3]
    if not parts:
        parts = lines[:2]
    return _clean(" ".join(parts), max_chars=max_chars)


def _daily_log_date(path: Path) -> date | None:
    m = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


def _age_days(hit: dict[str, Any]) -> int | None:
    if isinstance(hit.get("age_days"), int):
        return hit["age_days"]
    ts = hit.get("ts")
    if isinstance(ts, (int, float)) and ts > 0:
        return max(0, int((time.time() - float(ts)) / 86400))
    return None


def _age_label(hit: dict[str, Any]) -> str:
    days = _age_days(hit)
    if days is None:
        return "ohne Datum"
    if days <= 0:
        return "heute"
    if days == 1:
        return "gestern"
    if days <= 14:
        return f"{days} Tage alt"
    return f"historisch, {days} Tage alt"


def _kind_weight(hit: dict[str, Any]) -> int:
    kind = hit.get("kind")
    title = str(hit.get("title") or "")
    if kind == "focus":
        return 8
    if kind == "person":
        return 8
    if kind == "file" and title in ("brain/MEMORY.md", "brain/LEARNINGS.md", "brain/PROJECTS.md"):
        return 7
    if kind == "file" and "daily-log" in title:
        return 5
    if kind == "chat":
        return 4
    return 3


def _recency_weight(hit: dict[str, Any]) -> int:
    days = _age_days(hit)
    if days is None:
        return 1
    if days <= 1:
        return 5
    if days <= 7:
        return 4
    if days <= 30:
        return 2
    return -2


def _rank_score(hit: dict[str, Any]) -> int:
    raw = int(hit.get("raw_score") or hit.get("score") or 0)
    matched = hit.get("matched_tokens") if isinstance(hit.get("matched_tokens"), list) else []
    return raw * 10 + len(matched) * 4 + _kind_weight(hit) + _recency_weight(hit)


def _reason(hit: dict[str, Any]) -> str:
    matched = hit.get("matched_tokens") if isinstance(hit.get("matched_tokens"), list) else []
    terms = ", ".join(str(t) for t in matched[:3]) if matched else "semantischer Treffer"
    return f"Begriffe: {terms}; Alter: {_age_label(hit)}; Score: {hit.get('rank_score', 0)}"


def _file_hits(tokens: list[str], limit: int = 8) -> list[dict[str, Any]]:
    if not tokens:
        return []
    files = [p for p in CORE_FILES if p.exists()]
    log_dir = BRAIN / "daily-log"
    for i in range(0, 7):
        p = log_dir / f"{(date.today() - timedelta(days=i)).isoformat()}.md"
        if p.exists():
            files.append(p)

    hits: list[tuple[int, float, dict[str, Any]]] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            stat = path.stat()
        except OSError:
            continue
        matched = _matched_tokens(tokens, text)
        if _weak_partial_match(tokens, matched):
            continue
        sc = len(matched)
        if sc <= 0:
            continue
        log_date = _daily_log_date(path)
        age_days = (date.today() - log_date).days if log_date else max(0, int((time.time() - stat.st_mtime) / 86400))
        hits.append((
            sc,
            stat.st_mtime,
            {
                "kind": "file",
                "title": str(path.relative_to(ROOT)),
                "path": str(path),
                "snippet": _snippet(path, tokens),
                "raw_score": sc,
                "score": sc,
                "matched_tokens": matched,
                "age_days": age_days,
            },
        ))
    hits.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [h[2] for h in hits[:limit]]


def _chat_hits(tokens: list[str], conv_id: str = "", limit: int = 6) -> list[dict[str, Any]]:
    if not tokens:
        return []
    fts_query = " OR ".join(f'"{t}"*' for t in tokens[:5])
    rows: list[sqlite3.Row] = []
    try:
        with get_db() as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                """SELECT m.content, m.ts, m.conversation_id, c.title
                   FROM messages m
                   JOIN chat_search cs ON m.id = cs.rowid
                   LEFT JOIN conversations c ON c.id = m.conversation_id
                   WHERE chat_search MATCH ?
                   ORDER BY cs.rank
                   LIMIT ?""",
                (fts_query, max(limit * 3, 6)),
            ).fetchall()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        cid = r["conversation_id"] or ""
        if cid == conv_id or cid in seen:
            continue
        content = r["content"] or ""
        matched = _matched_tokens(tokens, content)
        if not matched or _weak_partial_match(tokens, matched):
            continue
        seen.add(cid)
        out.append({
            "kind": "chat",
            "title": r["title"] or f"Chat {cid}",
            "path": cid,
            "snippet": _clean(content, MAX_SNIPPET_CHARS),
            "raw_score": len(matched),
            "score": len(matched),
            "matched_tokens": matched,
            "ts": r["ts"],
        })
        if len(out) >= limit:
            break
    return out


def _focus_hits(tokens: list[str], limit: int = 6) -> list[dict[str, Any]]:
    if not tokens:
        return []
    try:
        from modules.fokus.core import collect_focus_briefing_payload
        payload = collect_focus_briefing_payload()
    except Exception:
        return []
    hits: list[tuple[int, dict[str, Any]]] = []
    for key in ("slots_today", "slots_tomorrow", "calendar_today", "calendar_tomorrow", "waiting_on_you", "lead_pipeline"):
        for entry in payload.get(key, []) or []:
            text = str(entry)
            matched = _matched_tokens(tokens, text)
            if _weak_partial_match(tokens, matched):
                continue
            sc = len(matched)
            if sc <= 0:
                continue
            hits.append((sc, {
                "kind": "focus",
                "title": key,
                "path": "/fokus",
                "snippet": _clean(text),
                "raw_score": sc,
                "score": sc,
                "matched_tokens": matched,
                "age_days": 0,
            }))
    hits.sort(key=lambda x: x[0], reverse=True)
    return [h[1] for h in hits[:limit]]


def _people_hits(tokens: list[str], limit: int = 6) -> list[dict[str, Any]]:
    if not tokens:
        return []
    db_path = ROOT / "data" / "people.db"
    if not db_path.exists():
        return []
    likes = [f"%{t}%" for t in tokens[:5]]
    fields = " OR ".join([
        "lower(coalesce(p.name,'')) LIKE ?",
        "lower(coalesce(p.company,'')) LIKE ?",
        "lower(coalesce(p.aliases,'')) LIKE ?",
        "lower(coalesce(p.tags,'')) LIKE ?",
        "lower(coalesce(p.notes,'')) LIKE ?",
        "lower(coalesce(p.agent_name,'')) LIKE ?",
        "lower(coalesce(p.agent_system,'')) LIKE ?",
        "lower(coalesce(p.agent_model,'')) LIKE ?",
        "lower(coalesce(s.body,'')) LIKE ?",
    ])
    where = " OR ".join([f"({fields})" for _ in likes])
    params: list[str] = []
    for like in likes:
        params.extend([like] * 9)
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            f"""SELECT p.id, p.name, p.company, p.role, p.relation, p.status,
                       p.city, p.tags, p.notes, p.updated_at, p.last_interaction_ts,
                       p.agent_enabled, p.agent_name, p.agent_system, p.agent_model, p.agent_status,
                       s.body AS summary, s.last_mention_ts
                FROM people p
                LEFT JOIN person_summary s ON s.person_id = p.id
                WHERE {where}
                ORDER BY COALESCE(s.last_mention_ts, p.last_interaction_ts, p.updated_at, 0) DESC
                LIMIT ?""",
            [*params, max(limit * 3, 12)],
        ).fetchall()
        person_ids = [int(r["id"]) for r in rows]
        memberships_by_pid: dict[int, list[sqlite3.Row]] = {}
        agents_by_pid: dict[int, list[sqlite3.Row]] = {}
        offers_by_pid: dict[int, sqlite3.Row] = {}
        if person_ids:
            placeholders = ",".join(["?"] * len(person_ids))
            for m in con.execute(
                f"""SELECT person_id, stream, stage, stage_progress, next_step_text, next_step_due
                      FROM person_pipeline_memberships
                     WHERE person_id IN ({placeholders})""",
                person_ids,
            ).fetchall():
                memberships_by_pid.setdefault(int(m["person_id"]), []).append(m)
            for a in con.execute(
                f"""SELECT id, person_id, name, system, model, status, notes, stage_progress, is_primary
                      FROM person_agents
                     WHERE person_id IN ({placeholders})
                     ORDER BY is_primary DESC, name COLLATE NOCASE""",
                person_ids,
            ).fetchall():
                memberships_by_pid.setdefault(int(a["person_id"]), memberships_by_pid.get(int(a["person_id"]), []))
                agents_by_pid.setdefault(int(a["person_id"]), []).append(a)
            for o in con.execute(
                f"""SELECT person_id, status, package, amount_eur, slug
                      FROM offers
                     WHERE person_id IN ({placeholders})
                     ORDER BY COALESCE(accepted_at, sent_at, created_at) DESC""",
                person_ids,
            ).fetchall():
                pid_int = int(o["person_id"])
                if pid_int not in offers_by_pid:
                    offers_by_pid[pid_int] = o
        con.close()
    except Exception:
        return []

    try:
        from modules.people.core import PIPELINE_STAGES, STAGE_CHECKLISTS
        agent_stage_labels = dict(PIPELINE_STAGES.get("agent", []))
        agent_checklists = STAGE_CHECKLISTS.get("agent", {})
    except Exception:
        agent_stage_labels = {}
        agent_checklists = {}

    out: list[dict[str, Any]] = []
    exact: list[dict[str, Any]] = []
    for r in rows:
        text = " ".join(str(r[k] or "") for k in ("name", "company", "role", "relation", "status", "city", "tags", "notes", "agent_name", "agent_system", "agent_model", "agent_status", "summary"))
        matched = _matched_tokens(tokens, text)
        if not matched or _weak_partial_match(tokens, matched):
            continue
        pid = int(r["id"])
        agent_rows = agents_by_pid.get(pid) or []
        agent_bits = "; ".join(
            " ".join(x for x in [
                a["name"],
                f"({a['system']})" if a["system"] else "",
                a["model"] or "",
                a["status"] or "",
            ] if x)
            for a in agent_rows
        ) or " ".join(x for x in [r["agent_name"], r["agent_system"], r["agent_model"], r["agent_status"]] if x)
        agent_membership = next((m for m in memberships_by_pid.get(pid, []) if m["stream"] == "agent"), None)
        agent_state = ""
        if agent_membership:
            try:
                membership_sp = json.loads(agent_membership["stage_progress"] or "{}")
                if not isinstance(membership_sp, dict):
                    membership_sp = {}
            except Exception:
                membership_sp = {}
            total = 0
            agent_progress_parts: list[str] = []
            for stage_id, items in agent_checklists.items():
                for key, label in items:
                    total += 1
            rows_for_progress = agent_rows or []
            if rows_for_progress:
                for a in rows_for_progress:
                    try:
                        sp = json.loads(a["stage_progress"] or "{}")
                        if not isinstance(sp, dict):
                            sp = {}
                    except Exception:
                        sp = {}
                    if not sp:
                        sp = membership_sp
                    done = 0
                    next_label = ""
                    for stage_id, items in agent_checklists.items():
                        for key, label in items:
                            if sp.get(f"{stage_id}:{key}"):
                                done += 1
                            elif not next_label:
                                next_label = label
                    bit = f"{a['name']}: Haken {done}/{total}" if total else str(a["name"])
                    if next_label:
                        bit += f", nächster Haken: {next_label}"
                    agent_progress_parts.append(bit)
            else:
                done = 0
                next_label = ""
                for stage_id, items in agent_checklists.items():
                    for key, label in items:
                        if membership_sp.get(f"{stage_id}:{key}"):
                            done += 1
                        elif not next_label:
                            next_label = label
                bit = f"Haken {done}/{total}" if total else ""
                if next_label:
                    bit += f", nächster Haken: {next_label}" if bit else f"nächster Haken: {next_label}"
                if bit:
                    agent_progress_parts.append(bit)
            stage_label = agent_stage_labels.get(agent_membership["stage"], agent_membership["stage"] or "")
            parts = [f"Agent-Projekt: {stage_label}" if stage_label else "Agent-Projekt"]
            parts.extend(agent_progress_parts)
            if agent_membership["next_step_text"]:
                parts.append(f"nächster Schritt: {agent_membership['next_step_text']}")
            offer = offers_by_pid.get(pid)
            if offer:
                amount = f"{offer['amount_eur']} EUR" if offer["amount_eur"] else "Betrag offen"
                parts.append(f"Angebot: {offer['status']} {amount} {offer['package'] or offer['slug']}")
            agent_state = "; ".join(parts)
        status = ", ".join(x for x in [r["company"], r["role"], r["relation"], r["status"], r["city"], agent_bits] if x)
        summary = ". ".join(x for x in [agent_state, r["summary"] or r["notes"] or status] if x)
        ts = int(r["last_mention_ts"] or r["last_interaction_ts"] or r["updated_at"] or 0)
        item = {
            "kind": "person",
            "title": r["name"] or f"Person {r['id']}",
            "path": f"people:{r['id']}",
            "snippet": _clean(f"{status}. {summary}", MAX_SNIPPET_CHARS),
            "raw_score": len(matched),
            "score": len(matched),
            "matched_tokens": matched,
            "ts": ts,
        }
        name_text = " ".join(str(r[k] or "") for k in ("name", "company")).lower()
        if all(t in name_text for t in tokens):
            exact.append(item)
        else:
            out.append(item)
        if len(out) >= limit:
            break
    return (exact or out)[:limit]


def _dedupe_rank(hits: list[dict[str, Any]], limit: int = MAX_SOURCES) -> list[dict[str, Any]]:
    seen: set[str] = set()
    ranked: list[dict[str, Any]] = []
    for h in hits:
        key = f"{h.get('kind')}:{h.get('path')}:{h.get('title')}"
        if key in seen:
            continue
        seen.add(key)
        item = dict(h)
        item["rank_score"] = _rank_score(item)
        item["age_label"] = _age_label(item)
        item["reason"] = _reason(item)
        ranked.append(item)
    ranked.sort(key=lambda h: (int(h.get("rank_score") or 0), -(_age_days(h) or 0)), reverse=True)
    return ranked[:limit]


def _build_block(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return ""
    lines = [
        "Automatisch geladener Kontext (Context Router, deterministisch aus vorhandenen Quellen):",
        "Nutze diesen Block als Hintergrund, nicht als Wahrheit. Alte Treffer sind historisch markiert.",
    ]
    for h in hits:
        title = h.get("title") or h.get("path") or h.get("kind") or "Quelle"
        snippet = h.get("snippet") or ""
        source = h.get("path") or h.get("kind") or ""
        reason = h.get("reason") or ""
        lines.append(f"- {title} [{source}; {_age_label(h)}; Grund: {reason}]: {snippet}")
    block = "\n".join(lines) + "\n\n"
    if len(block) > MAX_BLOCK_CHARS:
        block = block[: MAX_BLOCK_CHARS - 2].rstrip() + "\n\n"
    return block



def _youtube_hits(tokens: list[str], limit: int = 3) -> list[dict[str, Any]]:
    """YouTube-Dossiers (data/youtube/dossiers) als Hintergrundquelle.

    Das gerade laufende Video kommt auch ohne Titel-Treffer mit, sobald die
    Nachricht erkennbar über ein Video spricht ("video", "youtube", "kanal").
    """
    dossier_dir = ROOT / "data" / "youtube" / "dossiers"
    index_path = dossier_dir / "index.json"
    try:
        index = json.loads(index_path.read_text())
    except Exception:
        return []
    if not isinstance(index, dict):
        return []

    now_id = ""
    try:
        from routers.youtube import get_now_playing
        now = get_now_playing()
        if now and now.get("video"):
            now_id = str(now["video"].get("id") or "")
    except Exception:
        now_id = ""
    video_words = {"video", "youtube", "kanal", "clip", "schaue", "transkript"}
    talks_video = bool(set(tokens) & video_words)

    hits: list[dict[str, Any]] = []
    for vid, entry in index.items():
        if not isinstance(entry, dict) or entry.get("status") != "done":
            continue
        path = dossier_dir / f"{vid}.md"
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        title_matched = _matched_tokens(tokens, f"{entry.get('title', '')} {entry.get('channel', '')}")
        body_matched = _matched_tokens(tokens, text[:6000])
        matched = title_matched + [t for t in body_matched if t not in title_matched]
        is_now = vid == now_id
        # Einzelne Allerwelts-Wörter im Dossier-Text reichen nicht: entweder
        # Titel/Kanal-Treffer, mindestens zwei Text-Treffer, oder das Video
        # läuft gerade und die Nachricht spricht erkennbar über ein Video.
        relevant = bool(title_matched) or len(body_matched) >= 2 or (is_now and talks_video)
        if not relevant:
            continue
        if matched and _weak_partial_match(tokens, matched) and not is_now:
            continue
        ts = float(entry.get("ts") or 0)
        title = entry.get("title") or vid
        prefix = "läuft gerade: " if is_now else ""
        hits.append({
            "kind": "youtube",
            "title": f"YouTube-Dossier ({prefix}{title})",
            "path": str(path),
            "snippet": _snippet(path, tokens),
            "raw_score": len(matched) + (3 if is_now else 0),
            "score": len(matched) + (3 if is_now else 0),
            "matched_tokens": matched,
            "ts": ts or None,
        })
    hits.sort(key=lambda h: h["raw_score"], reverse=True)
    return hits[:limit]


def build_context(message: str, conv_id: str = "", *, trigger: str = "chat_turn", log_run: bool = True) -> str:
    tokens = _tokens(message)
    run_id = ""
    started = time.time()
    if log_run:
        try:
            import workflows
            run_id = workflows.start_run(
                "context.router",
                "Context Router",
                trigger=trigger,
                subject_type="conversation",
                subject_ref=conv_id,
                conversation_id=conv_id,
                input_data={"query": message[:1000], "tokens": tokens},
            )
        except Exception:
            run_id = ""

    candidates: list[dict[str, Any]] = []
    stages: list[tuple[str, list[dict[str, Any]]]] = []
    for name, fn in (
        ("brain_files", _file_hits),
        ("people", _people_hits),
        ("focus", _focus_hits),
        ("chat_history", lambda toks: _chat_hits(toks, conv_id=conv_id)),
        ("youtube_dossiers", _youtube_hits),
    ):
        try:
            got = fn(tokens)
        except Exception:
            got = []
        stages.append((name, got))
        candidates.extend(got)

    hits = _dedupe_rank(candidates)

    block = _build_block(hits)
    if run_id:
        try:
            import workflows
            for name, got in stages:
                workflows.add_step(
                    run_id,
                    name,
                    name.replace("_", " ").title(),
                    "ok",
                    f"{len(got)} Treffer",
                    {
                        "count": len(got),
                        "items": [
                            {
                                "kind": h.get("kind"),
                                "title": h.get("title"),
                                "path": h.get("path"),
                                "matched_tokens": h.get("matched_tokens"),
                                "raw_score": h.get("raw_score") or h.get("score"),
                            }
                            for h in got[:8]
                        ],
                    },
                )
            workflows.add_step(
                run_id,
                "rank_and_limit",
                "Ranking und Limit",
                "ok",
                f"{len(hits)} von {len(candidates)} Kandidaten injiziert",
                {
                    "candidate_count": len(candidates),
                    "loaded_count": len(hits),
                    "max_sources": MAX_SOURCES,
                    "dropped_count": max(0, len(candidates) - len(hits)),
                },
            )
            result = {
                "loaded_count": len(hits),
                "candidate_count": len(candidates),
                "dropped_count": max(0, len(candidates) - len(hits)),
                "max_sources": MAX_SOURCES,
                "injected_chars": len(block),
                "sources": [
                    {
                        "kind": h.get("kind"),
                        "title": h.get("title"),
                        "path": h.get("path"),
                        "rank_score": h.get("rank_score"),
                        "reason": h.get("reason"),
                        "age_label": h.get("age_label"),
                        "matched_tokens": h.get("matched_tokens"),
                    }
                    for h in hits
                ],
                "duration_ms": int((time.time() - started) * 1000),
            }
            workflows.finish_run(run_id, "done", result=result)
            workflows.review_context_router(run_id)
        except Exception:
            pass
    return block
