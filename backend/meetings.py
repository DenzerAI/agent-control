"""Meeting-Recorder: Chunk-basierte Aufnahme, Transkription via OpenAI Whisper, Listing.

Nach finish_meeting läuft ein lokales LLM (Qwen, Haiku-Fallback) drüber und
extrahiert summary/facts/decisions/action_items. Wenn die Aufnahme einer
Person zugewiesen ist, landet die Zusammenfassung als datierter Eintrag in
brain/people/<slug>.md unter ## Journal (zwischen AUTO-JOURNAL-Markern), mit
Backlink auf das Meeting.
"""
import asyncio
import json
import logging
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

router = APIRouter()
log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).parent.parent / "jobs" / "meetings" / "data"
_PEOPLE_DIR = Path(__file__).parent.parent / "brain" / "people"
_PEOPLE_INDEX = _PEOPLE_DIR / "_index.json"

_JOURNAL_BEGIN = "<!-- AUTO-JOURNAL:BEGIN -->"
_JOURNAL_END = "<!-- AUTO-JOURNAL:END -->"

_BODY_BEGIN = "<!-- TRANSCRIPT:BEGIN -->"
_BODY_END = "<!-- TRANSCRIPT:END -->"


def _meeting_dirs() -> list[Path]:
    if not _DATA_DIR.exists():
        return []
    return sorted(
        [d for d in _DATA_DIR.iterdir() if d.is_dir()],
        reverse=True,
    )


def _parse_date(dir_name: str) -> str:
    try:
        dt = datetime.strptime(dir_name, "%Y-%m-%d-%H%M%S")
        return dt.strftime("%d.%m.%Y %H:%M")
    except ValueError:
        return dir_name


def _read_meta(meeting_dir: Path) -> dict:
    meta_path = meeting_dir / "meta.json"
    if meta_path.exists():
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _write_meta(meeting_dir: Path, meta: dict) -> None:
    (meeting_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def _person_slug_for_id(person_id: str) -> tuple[str, str] | None:
    """Findet (slug, name) für eine person_id über brain/people/_index.json. None wenn nichts."""
    if not person_id or not _PEOPLE_INDEX.exists():
        return None
    try:
        idx = json.loads(_PEOPLE_INDEX.read_text(encoding="utf-8"))
    except Exception:
        return None
    by_pid = idx.get("by_person_id") or {}
    entry = by_pid.get(str(person_id)) or by_pid.get(person_id)
    if not entry:
        for slug, e in (idx.get("by_slug") or {}).items():
            if str(e.get("person_id")) == str(person_id):
                return slug, e.get("name") or slug
        return None
    slug = entry.get("slug") or entry.get("file", "").split("/")[-1].removesuffix(".md")
    return slug, entry.get("name") or slug


def _ensure_person_md(slug: str, name: str) -> Path:
    """Stellt sicher, dass brain/people/<slug>.md existiert. Legt minimalen Stub an wenn nicht."""
    target = _PEOPLE_DIR / f"{slug}.md"
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {name}\n\n## Notizen / Freitext\n\n", encoding="utf-8")
    return target


def _write_journal_entry(person_id: str, meeting_id: str, when: datetime,
                          title: str, summary: str, action_items: list[str]) -> bool:
    """Hängt einen Eintrag in die AUTO-JOURNAL-Section der Person-MD. Idempotent pro meeting_id."""
    pair = _person_slug_for_id(person_id)
    if not pair:
        return False
    slug, name = pair
    md_path = _ensure_person_md(slug, name)
    content = md_path.read_text(encoding="utf-8")

    if _JOURNAL_BEGIN not in content:
        section = f"\n## Journal\n\n{_JOURNAL_BEGIN}\n{_JOURNAL_END}\n"
        content = content.rstrip() + "\n" + section
    if f"meeting:{meeting_id}" in content:
        md_path.write_text(content, encoding="utf-8")
        return True

    ai_block = ""
    if action_items:
        ai_block = "\n" + "\n".join(f"- [ ] {a}" for a in action_items if a)
    entry = (
        f"\n### {when.strftime('%Y-%m-%d %H:%M')} · {title}\n\n"
        f"{summary.strip()}\n"
        f"{ai_block}\n"
        f"\n_Quelle: [meeting:{meeting_id}](/api/meetings/{meeting_id}/transcript)_\n"
    )
    start = content.index(_JOURNAL_BEGIN) + len(_JOURNAL_BEGIN)
    new_content = content[:start] + entry + content[start:]
    md_path.write_text(new_content, encoding="utf-8")
    return True


def _read_body_text(meeting_dir: Path) -> str:
    """Liest reinen Transkript-Text aus transcript.md (zwischen BODY-Markern wenn vorhanden,
    sonst alles ausser Header-Zeilen)."""
    path = meeting_dir / "transcript.md"
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    if _BODY_BEGIN in text and _BODY_END in text:
        start = text.index(_BODY_BEGIN) + len(_BODY_BEGIN)
        end = text.index(_BODY_END, start)
        return text[start:end].strip()
    lines = [ln for ln in text.splitlines() if not ln.startswith("#")]
    return "\n".join(lines).strip()


def _load_chat_title(chat_id: str) -> str:
    if not chat_id:
        return ""
    try:
        from db import get_conversation
        conv = get_conversation(chat_id)
        if conv and conv.get("title"):
            return str(conv["title"])
    except Exception:
        pass
    return ""


def _render_transcript_md(meeting_dir: Path) -> None:
    """Schreibt transcript.md neu: Header (Bezug + Extract) + Volltext zwischen Body-Markern.

    Bezug-Block sowie Extract-Sektionen sind optional; bei leerem Inhalt werden sie weggelassen.
    """
    meta = _read_meta(meeting_dir)
    body = _read_body_text(meeting_dir)

    date_label = _parse_date(meeting_dir.name)
    title = meta.get("title") or f"Meeting {date_label}"

    extract: dict = {}
    extract_path = meeting_dir / "extract.json"
    if extract_path.exists():
        try:
            extract = json.loads(extract_path.read_text(encoding="utf-8")) or {}
        except Exception:
            extract = {}

    lines: list[str] = [f"# {title}", "", f"_{date_label}_", ""]

    person_label = (meta.get("person_label") or "").strip()
    chat_id = (meta.get("chat_id") or "").strip()
    chat_title = _load_chat_title(chat_id)
    bezug_bits: list[str] = []
    if person_label:
        bezug_bits.append(f"**Person:** {person_label}")
    if chat_title:
        bezug_bits.append(f"**Chat:** {chat_title}")
    elif chat_id:
        bezug_bits.append(f"**Chat:** `{chat_id}`")
    if bezug_bits:
        lines.append(" · ".join(bezug_bits))
        lines.append("")

    summary = (extract.get("summary") or "").strip()
    if summary:
        lines += ["## Zusammenfassung", "", summary, ""]

    def _section(label: str, items) -> None:
        if not items:
            return
        lines.append(f"## {label}")
        lines.append("")
        for it in items:
            s = str(it).strip()
            if s:
                lines.append(f"- {s}")
        lines.append("")

    _section("Entscheidungen", extract.get("decisions") or [])
    _section("To dos", extract.get("action_items") or [])
    _section("Fakten", extract.get("facts") or [])

    lines.append("---")
    lines.append("")
    lines.append("## Volltext")
    lines.append("")
    lines.append(_BODY_BEGIN)
    lines.append(body)
    lines.append(_BODY_END)
    lines.append("")

    (meeting_dir / "transcript.md").write_text("\n".join(lines), encoding="utf-8")


try:
    from identity import get_owner as _get_owner
except ImportError:
    from backend.identity import get_owner as _get_owner
_OWNER_FIRST = _get_owner()["first_name"]

_EXTRACT_PROMPT_SYS = (
    "Du bist ein Extrakt-Assistent für Meetings. Antworte ausschließlich mit gültigem JSON "
    "in dieser Form (Deutsch, keine Erklärungen):\n"
    '{"title": "<5-8 Wörter Thema>", "summary": "<3-6 Sätze Substanz: Entscheidungen, Fakten, '
    'Kontext, keine Floskeln>", "facts": ["<neue Fakten über die Person/Lage>"], '
    '"decisions": ["<getroffene Entscheidungen>"], "action_items": ["<konkrete Todos>"], '
    f'"participants": ["<Vor- und Nachnamen der erkennbaren Gesprächspartner, ohne {_OWNER_FIRST}; '
    'leeres Array wenn unklar>"]}'
)


def _match_person_in_db(name: str) -> dict | None:
    """Sucht Name in people.db via LIKE (Vor-/Nachname-Token). Liefert {id, label} oder None."""
    name = (name or "").strip()
    if len(name) < 3:
        return None
    people_db = Path("/Users/klaus/agent/data/people.db")
    if not people_db.exists():
        return None
    parts = [p for p in re.split(r"\s+", name) if len(p) >= 2]
    if not parts:
        return None
    con = sqlite3.connect(f"file:{people_db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        if len(parts) >= 2:
            like_full = f"%{parts[0]}%{parts[-1]}%"
            rows = con.execute(
                "SELECT id, name, company FROM people WHERE name LIKE ? "
                "ORDER BY COALESCE(last_interaction_ts, updated_at) DESC LIMIT 1",
                (like_full,),
            ).fetchall()
            if rows:
                r = rows[0]
                label = r["name"] + (f" · {r['company']}" if r["company"] else "")
                return {"id": str(r["id"]), "label": label}
        like_one = f"%{parts[0]}%"
        rows = con.execute(
            "SELECT id, name, company FROM people WHERE name LIKE ? "
            "ORDER BY COALESCE(last_interaction_ts, updated_at) DESC LIMIT 3",
            (like_one,),
        ).fetchall()
        if len(rows) == 1:
            r = rows[0]
            label = r["name"] + (f" · {r['company']}" if r["company"] else "")
            return {"id": str(r["id"]), "label": label}
    finally:
        con.close()
    return None


def _suggest_person_from_participants(participants: list) -> dict | None:
    """Wählt den ersten matchbaren Eintrag aus der LLM-Participant-Liste."""
    if not participants:
        return None
    seen: set[str] = set()
    for p in participants:
        name = str(p or "").strip()
        if not name or name.lower() in {"klaus"}:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        m = _match_person_in_db(name)
        if m:
            return {"id": m["id"], "label": m["label"], "matched_name": name}
    return None


def _parse_extract_json(text: str) -> dict:
    """Robust: holt das erste JSON-Objekt aus dem Antworttext."""
    if not text:
        return {}
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return data


async def _run_meeting_extract(meeting_id: str) -> None:
    """Background-Task: liest Transkript, ruft lokales LLM, schreibt extract.json und Journal."""
    from local_llm import call_with_haiku_fallback

    meeting_dir = _DATA_DIR / meeting_id
    if not meeting_dir.exists():
        return
    transcript_path = meeting_dir / "transcript.md"
    if not transcript_path.exists():
        return
    raw = transcript_path.read_text(encoding="utf-8").strip()
    body_lines = [ln for ln in raw.splitlines() if not ln.startswith("#")]
    body = "\n".join(body_lines).strip()
    if len(body) < 40:
        return

    meta = _read_meta(meeting_dir)
    meta["extract_status"] = "running"
    meta["extract_started_at"] = datetime.now().isoformat(timespec="seconds")
    _write_meta(meeting_dir, meta)

    person_label = meta.get("person_label", "") or ""
    chat_id = meta.get("chat_id", "") or ""
    context_hint = ""
    if person_label:
        context_hint = f"\n\nKontext: Meeting/Gespräch mit {person_label}."
    elif chat_id:
        context_hint = f"\n\nKontext: Chat {chat_id}."

    prompt = (
        f"Transkript:{context_hint}\n\n---\n{body[:12000]}\n---\n\n"
        "Extrahiere wie im System-Prompt beschrieben. Wenn ein Feld leer wäre, gib [] zurück."
    )

    try:
        text, model_used = await call_with_haiku_fallback(
            prompt=prompt,
            feature="meeting_extract",
            system=_EXTRACT_PROMPT_SYS,
            max_tokens=900,
            temperature=0.2,
            qwen_timeout=45.0,
            haiku_timeout=60.0,
        )
    except Exception as e:
        log.warning("[meeting_extract] llm call failed: %s", e)
        meta["extract_status"] = "error"
        meta["extract_error"] = str(e)[:200]
        _write_meta(meeting_dir, meta)
        return

    data = _parse_extract_json(text)
    if not data:
        meta["extract_status"] = "error"
        meta["extract_error"] = "no_json"
        _write_meta(meeting_dir, meta)
        return

    (meeting_dir / "extract.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    meta["extract_status"] = "ok"
    meta["extract_at"] = datetime.now().isoformat(timespec="seconds")
    meta["extract_model"] = model_used
    meta["title"] = meta.get("title") or data.get("title", "")

    person_id = str(meta.get("person_id") or "").strip()
    if not person_id:
        sug = _suggest_person_from_participants(data.get("participants") or [])
        if sug:
            meta["suggested_person_id"] = sug["id"]
            meta["suggested_person_label"] = sug["label"]
            meta["suggested_person_name"] = sug["matched_name"]
        else:
            meta.pop("suggested_person_id", None)
            meta.pop("suggested_person_label", None)
            meta.pop("suggested_person_name", None)

    _write_meta(meeting_dir, meta)

    _render_transcript_md(meeting_dir)

    if person_id:
        try:
            when = datetime.strptime(meeting_id, "%Y-%m-%d-%H%M%S")
        except ValueError:
            when = datetime.now()
        title = (data.get("title") or "Meeting").strip()
        summary = (data.get("summary") or "").strip()
        action_items = [str(a).strip() for a in (data.get("action_items") or []) if a]
        try:
            _write_journal_entry(person_id, meeting_id, when, title, summary, action_items)
        except Exception as e:
            log.warning("[meeting_extract] journal write failed: %s", e)


def _transcribe_chunk(chunk_path: Path, content_type: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return ""
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    try:
        with open(chunk_path, "rb") as f:
            result = client.audio.transcriptions.create(
                model="whisper-1",
                file=(chunk_path.name, f, content_type or "audio/webm"),
            )
        return result.text.strip()
    except Exception:
        return ""


# ── Session starten ──

@router.post("/api/meetings/start")
async def start_meeting(request: Request):
    body = await request.json()
    chat_id = body.get("chat_id", "")
    person_id = body.get("person_id", "")
    person_label = body.get("person_label", "")

    ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    meeting_dir = _DATA_DIR / ts
    meeting_dir.mkdir(parents=True, exist_ok=True)

    _write_meta(meeting_dir, {
        "started": ts,
        "chat_id": chat_id,
        "person_id": person_id,
        "person_label": person_label,
        "finished": False,
    })
    (meeting_dir / "transcript.md").write_text("", encoding="utf-8")

    return JSONResponse({"session_id": ts})


# ── Chunk hochladen und transkribieren ──

@router.post("/api/meetings/{session_id}/chunk")
async def upload_chunk(session_id: str, file: UploadFile = File(...)):
    if "/" in session_id or ".." in session_id:
        raise HTTPException(400, "Ungültige ID")

    meeting_dir = _DATA_DIR / session_id
    if not meeting_dir.exists():
        raise HTTPException(404, "Session nicht gefunden")

    data = await file.read()
    if not data:
        transcript_path = meeting_dir / "transcript.md"
        existing = transcript_path.read_text(encoding="utf-8") if transcript_path.exists() else ""
        return JSONResponse({"text": "", "transcript": existing})

    suffix = Path(file.filename).suffix if file.filename else ".webm"
    chunk_count = len(list(meeting_dir.glob("chunk_*")))
    chunk_path = meeting_dir / f"chunk_{chunk_count:04d}{suffix}"
    chunk_path.write_bytes(data)

    new_text = _transcribe_chunk(chunk_path, file.content_type or "audio/webm")

    transcript_path = meeting_dir / "transcript.md"
    existing = transcript_path.read_text(encoding="utf-8") if transcript_path.exists() else ""
    if new_text:
        sep = " " if existing and not existing.endswith("\n") else ""
        updated = existing + sep + new_text
        transcript_path.write_text(updated, encoding="utf-8")
    else:
        updated = existing

    return JSONResponse({"text": new_text, "transcript": updated})


# ── Session abschließen ──

@router.post("/api/meetings/{session_id}/finish")
async def finish_meeting(session_id: str, background_tasks: BackgroundTasks):
    if "/" in session_id or ".." in session_id:
        raise HTTPException(400, "Ungültige ID")

    meeting_dir = _DATA_DIR / session_id
    if not meeting_dir.exists():
        raise HTTPException(404, "Session nicht gefunden")

    meta = _read_meta(meeting_dir)
    meta["finished"] = True
    _write_meta(meeting_dir, meta)

    _render_transcript_md(meeting_dir)
    background_tasks.add_task(_kickoff_extract, session_id)

    return JSONResponse({"ok": True, "session_id": session_id, "chat_id": meta.get("chat_id", "")})


def _kickoff_extract(session_id: str) -> None:
    """BackgroundTasks läuft sync — wir starten den async-Extract in einem eigenen Loop."""
    try:
        asyncio.run(_run_meeting_extract(session_id))
    except Exception as e:
        log.warning("[meeting_extract] kickoff failed for %s: %s", session_id, e)


# ── Metadaten aktualisieren ──

@router.patch("/api/meetings/{session_id}")
async def update_meeting(session_id: str, request: Request):
    if "/" in session_id or ".." in session_id:
        raise HTTPException(400, "Ungültige ID")

    meeting_dir = _DATA_DIR / session_id
    if not meeting_dir.exists():
        raise HTTPException(404, "Session nicht gefunden")

    body = await request.json()
    meta = _read_meta(meeting_dir)
    if "chat_id" in body:
        meta["chat_id"] = body["chat_id"]
    if "person_id" in body:
        meta["person_id"] = body["person_id"]
    if "person_label" in body:
        meta["person_label"] = body["person_label"]
    if "title" in body:
        meta["title"] = body["title"]
    if "suggested_person_id" in body:
        v = body["suggested_person_id"]
        if v:
            meta["suggested_person_id"] = v
        else:
            meta.pop("suggested_person_id", None)
    if "suggested_person_label" in body:
        v = body["suggested_person_label"]
        if v:
            meta["suggested_person_label"] = v
        else:
            meta.pop("suggested_person_label", None)
    _write_meta(meeting_dir, meta)

    if meta.get("finished"):
        _render_transcript_md(meeting_dir)

    new_pid = str(meta.get("person_id") or "").strip()
    if "person_id" in body and new_pid:
        extract_path = meeting_dir / "extract.json"
        if extract_path.exists():
            try:
                ex = json.loads(extract_path.read_text(encoding="utf-8")) or {}
                try:
                    when = datetime.strptime(session_id, "%Y-%m-%d-%H%M%S")
                except ValueError:
                    when = datetime.now()
                _write_journal_entry(
                    new_pid, session_id, when,
                    (ex.get("title") or "Meeting").strip(),
                    (ex.get("summary") or "").strip(),
                    [str(a).strip() for a in (ex.get("action_items") or []) if a],
                )
            except Exception as e:
                log.warning("[meeting_extract] journal backfill failed: %s", e)

    return JSONResponse({"ok": True})


# ── Legacy: einmaliger Upload ──

@router.post("/api/meetings/upload")
async def upload_meeting(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Leere Datei")

    ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    meeting_dir = _DATA_DIR / ts
    meeting_dir.mkdir(parents=True, exist_ok=True)

    suffix = ".webm"
    if file.filename:
        suffix = Path(file.filename).suffix or ".webm"
    raw_path = meeting_dir / f"raw{suffix}"
    raw_path.write_bytes(data)

    new_text = _transcribe_chunk(raw_path, file.content_type or "audio/webm")
    (meeting_dir / "transcript.md").write_text(new_text, encoding="utf-8")
    _write_meta(meeting_dir, {"started": ts, "finished": True})
    _render_transcript_md(meeting_dir)

    return JSONResponse({"id": ts, "transcript": new_text})


# ── Listing ──

@router.get("/api/meetings")
async def list_meetings(person_id: str = "", chat_id: str = ""):
    meetings = []
    for d in _meeting_dirs():
        meta = _read_meta(d)
        if person_id and str(meta.get("person_id", "")) != person_id:
            continue
        if chat_id and meta.get("chat_id", "") != chat_id:
            continue
        transcript_path = d / "transcript.md"
        has_transcript = transcript_path.exists() and transcript_path.stat().st_size > 0
        preview = ""
        if has_transcript:
            text = transcript_path.read_text(encoding="utf-8")
            lines = [l for l in text.splitlines() if l and not l.startswith("#")]
            raw_preview = " ".join(lines)[:120]
            preview = raw_preview + ("..." if len(raw_preview) == 120 else "")
        extract_path = d / "extract.json"
        has_extract = extract_path.exists()
        chat_id_v = meta.get("chat_id", "")
        meetings.append({
            "id": d.name,
            "date": _parse_date(d.name),
            "title": meta.get("title") or f"Meeting {_parse_date(d.name)}",
            "has_transcript": has_transcript,
            "transcript_preview": preview,
            "transcript_path": f"jobs/meetings/data/{d.name}/transcript.md",
            "chat_id": chat_id_v,
            "chat_title": _load_chat_title(chat_id_v),
            "person_id": meta.get("person_id", ""),
            "person_label": meta.get("person_label", ""),
            "suggested_person_id": meta.get("suggested_person_id", ""),
            "suggested_person_label": meta.get("suggested_person_label", ""),
            "finished": meta.get("finished", True),
            "extract_status": meta.get("extract_status", "none") if not has_extract else "ok",
            "has_extract": has_extract,
        })
    return JSONResponse({"meetings": meetings})


@router.get("/api/meetings/{meeting_id}/transcript")
async def get_transcript(meeting_id: str):
    if "/" in meeting_id or ".." in meeting_id:
        raise HTTPException(400, "Ungültige ID")
    meeting_dir = _DATA_DIR / meeting_id
    transcript_path = meeting_dir / "transcript.md"
    if not transcript_path.exists():
        raise HTTPException(404, "Transkript nicht gefunden")
    extract = None
    extract_path = meeting_dir / "extract.json"
    if extract_path.exists():
        try:
            extract = json.loads(extract_path.read_text(encoding="utf-8"))
        except Exception:
            extract = None
    meta = _read_meta(meeting_dir)
    return JSONResponse({
        "transcript": transcript_path.read_text(encoding="utf-8"),
        "extract": extract,
        "person_id": meta.get("person_id", ""),
        "person_label": meta.get("person_label", ""),
        "chat_id": meta.get("chat_id", ""),
    })


@router.post("/api/meetings/{meeting_id}/reextract")
async def reextract(meeting_id: str, background_tasks: BackgroundTasks):
    if "/" in meeting_id or ".." in meeting_id:
        raise HTTPException(400, "Ungültige ID")
    if not (_DATA_DIR / meeting_id).exists():
        raise HTTPException(404, "Meeting nicht gefunden")
    background_tasks.add_task(_kickoff_extract, meeting_id)
    return JSONResponse({"ok": True})
