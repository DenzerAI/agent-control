"""Search — FTS5 + Semantic + Hybrid Suche.

Vorher: ~150 Zeilen in `backend/server.py` (10 Routen verteilt auf 781-877 und 3123-3258).
Jetzt isoliert.

Cross-Deps:
- `from db import get_db, reindex_all`
- `embeddings` wird lokal importiert (Ollama-Down toleriert)
- `_is_allowed_path`/`HIDDEN`/`SOURCES`/`_resolve_path` werden lokal gespiegelt
  (gleicher Stil wie `modules/fs/core.py`, vermeidet Circular-Imports auf `backend.server`).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from db import get_db, reindex_all


PROJECT_ROOT = Path(__file__).resolve().parents[2]

HIDDEN = {'.git', '.venv', 'node_modules', '__pycache__', '.DS_Store', 'dist', '.next'}

# Sources Config — wird beim Modul-Load aus config/sources.json gelesen.
SOURCES_PATH = PROJECT_ROOT / "config" / "sources.json"


def _load_sources() -> list:
    if SOURCES_PATH.exists():
        return json.loads(SOURCES_PATH.read_text()).get("sources", [])
    return []


SOURCES = _load_sources()


def _resolve_path(p: str) -> Path:
    return Path(p.replace("~", str(Path.home())))


router = APIRouter()


# ── File-Name-Search ueber Sources ──

@router.get("/api/search/files")
async def search_files(q: str = '', limit: int = 30, since: float = 0):
    """Search filenames across all source directories."""
    if not q.strip():
        return JSONResponse({"files": []})
    q_lower = q.lower()
    results = []
    for src in SOURCES:
        sid, label, color = src["id"], src["label"], src["color"]
        if src["type"] == "brain":
            base = _resolve_path(src["path"])
        elif src["type"] == "claude":
            base = _resolve_path(src["path"])
        else:
            continue
        if not base.exists():
            continue
        for fp in base.rglob("*"):
            if not fp.is_file():
                continue
            if any(h in fp.parts for h in HIDDEN):
                continue
            if q_lower in fp.name.lower():
                mtime = fp.stat().st_mtime
                if since and mtime < since:
                    continue
                results.append({
                    "name": fp.name,
                    "path": str(fp),
                    "source": label,
                    "color": color,
                    "relative": str(fp.relative_to(base)),
                    "size": fp.stat().st_size,
                    "ts": mtime,
                })
                if len(results) >= limit:
                    break
        if len(results) >= limit:
            break
    results.sort(key=lambda r: r["ts"], reverse=True)
    return JSONResponse({"files": results})


# ── Chat-History-Search (FTS5 + optional Hybrid) ──

@router.get("/api/search/chat")
async def search_messages(q: str = '', agent: str = '', limit: int = 50, since: float = 0, mode: str = 'hybrid'):
    if not q.strip():
        return JSONResponse({"results": []})
    # Hybrid (FTS5 + Embeddings) ist Default. Bei Ollama-Ausfall fällt's auf FTS5 zurück.
    # mode=fts erzwingt reine FTS5-Suche (für Debug/Vergleich).
    if mode == 'hybrid' and not since:
        try:
            import embeddings as emb
            with get_db() as db:
                results = emb.hybrid(db, q, limit=limit, agent=agent)
            return JSONResponse({"results": [
                {"author": r["author"], "content": r["content"], "ts": r["ts"],
                 "agent": r.get("agent", ""), "conversationId": r.get("conversationId", "")}
                for r in results
            ]})
        except Exception:
            pass  # Fallback auf FTS5
    with get_db() as db:
        # Try FTS5 first, fallback to LIKE for special characters
        try:
            # FTS5 query — each word as prefix match, combined with AND
            words = [w.strip().replace('"', '') for w in q.split() if w.strip()]
            fts_query = " AND ".join(f'"{w}"*' for w in words) if words else q
            since_clause = " AND m.ts >= ?" if since else ""
            params: list = [fts_query]
            if agent:
                params.append(agent)
            if since:
                params.append(since)
            params.append(limit)
            agent_clause = " AND m.agent = ?" if agent else ""
            rows = db.execute(
                f"SELECT m.author, m.content, m.ts, m.agent, m.conversation_id FROM messages m JOIN chat_search cs ON m.id = cs.rowid WHERE chat_search MATCH ?{agent_clause}{since_clause} ORDER BY cs.rank LIMIT ?",
                tuple(params)
            ).fetchall()
        except Exception:
            # Fallback to LIKE for queries FTS5 can't handle
            since_clause = " AND ts >= ?" if since else ""
            params = [f"%{q}%"]
            if agent:
                params.append(agent)
            if since:
                params.append(since)
            params.append(limit)
            agent_clause = " AND agent = ?" if agent else ""
            rows = db.execute(
                f"SELECT author, content, ts, agent, conversation_id FROM messages WHERE content LIKE ?{agent_clause}{since_clause} ORDER BY ts DESC LIMIT ?",
                tuple(params)
            ).fetchall()
    return JSONResponse({"results": [
        {"author": r[0], "content": r[1], "ts": r[2], "agent": r[3] if len(r) > 3 else "", "conversationId": r[4] if len(r) > 4 else ""}
        for r in rows
    ]})


# ── Conversation-Search: ein Treffer pro Chat, Titel + Hybrid-Content ──

@router.get("/api/search/conversations")
async def search_conversations(q: str = '', limit: int = 20):
    """Semantische Chat-Suche: ein Treffer pro Conversation.
    Kombiniert Titel-Match (LIKE) mit Hybrid-Message-Suche (FTS5 + Embeddings),
    gruppiert per conversation_id, RRF-Merge."""
    q = q.strip()
    if not q:
        return JSONResponse({"results": []})

    k = 60  # RRF-Konstante
    words = [w.strip() for w in q.split() if w.strip()]

    with get_db() as db:
        # 1. Titel-Match: alle Worte müssen im Titel vorkommen (case-insensitive).
        title_clauses = " AND ".join(["LOWER(title) LIKE ?"] * len(words)) if words else "1=1"
        title_params = [f"%{w.lower()}%" for w in words]
        title_rows = db.execute(
            f"SELECT id, title, agent, updated_at FROM conversations "
            f"WHERE archived = 0 AND {title_clauses} "
            f"ORDER BY updated_at DESC LIMIT ?",
            (*title_params, limit * 3),
        ).fetchall()

        # 2. Hybrid-Message-Suche (FTS5 + Embeddings via embeddings.hybrid).
        msg_hits: list[dict] = []
        try:
            import embeddings as emb
            msg_hits = emb.hybrid(db, q, limit=limit * 3)
        except Exception:
            # Fallback: reine FTS5
            try:
                fts_query = " AND ".join(f'"{w}"*' for w in words) if words else q
                rows = db.execute(
                    "SELECT m.author, m.content, m.ts, m.agent, m.conversation_id "
                    "FROM messages m JOIN chat_search cs ON m.id = cs.rowid "
                    "WHERE chat_search MATCH ? ORDER BY cs.rank LIMIT ?",
                    (fts_query, limit * 3),
                ).fetchall()
                msg_hits = [
                    {"author": r[0], "content": r[1], "ts": r[2], "agent": r[3], "conversationId": r[4]}
                    for r in rows
                ]
            except Exception:
                msg_hits = []

        # 3. RRF-Merge: Score pro conversation_id.
        scored: dict[str, dict] = {}

        for rank, row in enumerate(title_rows):
            cid, title, agent, ts = row
            if not cid:
                continue
            scored[cid] = {
                "conversationId": cid,
                "title": title or "",
                "agent": agent or "",
                "ts": ts or 0,
                "snippet": "",
                "matchedTitle": True,
                "score": 2.0 / (k + rank + 1),  # Titel etwas stärker gewichten
            }

        # Gruppiere Message-Hits pro Conversation: erster Treffer = bester (hybrid ist schon sortiert).
        seen_conv_rank: dict[str, int] = {}
        for rank, h in enumerate(msg_hits):
            cid = h.get("conversationId") or ""
            if not cid or cid in seen_conv_rank:
                continue
            seen_conv_rank[cid] = rank
            bonus = 1.0 / (k + rank + 1)
            snippet = (h.get("content") or "").strip()
            if len(snippet) > 200:
                snippet = snippet[:200] + "…"
            if cid in scored:
                scored[cid]["score"] += bonus
                if not scored[cid]["snippet"]:
                    scored[cid]["snippet"] = snippet
            else:
                scored[cid] = {
                    "conversationId": cid,
                    "title": "",
                    "agent": h.get("agent") or "",
                    "ts": h.get("ts") or 0,
                    "snippet": snippet,
                    "matchedTitle": False,
                    "score": bonus,
                }

        # 4. Fehlende Titel/Agent/ts auffüllen für Conv-Treffer, die nur über Messages kamen.
        missing = [cid for cid, v in scored.items() if not v["title"]]
        if missing:
            placeholders = ",".join("?" for _ in missing)
            for cid, title, agent, ts in db.execute(
                f"SELECT id, title, agent, updated_at FROM conversations "
                f"WHERE id IN ({placeholders})",
                missing,
            ).fetchall():
                if cid in scored:
                    scored[cid]["title"] = title or scored[cid]["title"]
                    if not scored[cid]["agent"]:
                        scored[cid]["agent"] = agent or ""
                    if not scored[cid]["ts"]:
                        scored[cid]["ts"] = ts or 0

    out = sorted(scored.values(), key=lambda x: x["score"], reverse=True)[:limit]
    for x in out:
        x.pop("score", None)
    return JSONResponse({"results": out})


# ── Globale FTS+Hybrid-Suche ueber search_index ──

@router.get("/api/search")
async def search(q: str = "", limit: int = 20):
    if not q.strip():
        return JSONResponse({"results": []})
    import embeddings as emb
    brain_base = Path.home() / "agent/brain"

    def _run():
        with get_db() as db:
            try:
                fts_rows = db.execute(
                    "SELECT source, path, title, snippet(search_index, 3, '<b>', '</b>', '...', 32) "
                    "FROM search_index WHERE content MATCH ? ORDER BY rank LIMIT ?",
                    (q, limit * 2)
                ).fetchall()
            except Exception:
                fts_rows = []
            if not fts_rows:
                fts_rows = db.execute(
                    "SELECT source, path, title, '' FROM search_index WHERE title LIKE ? OR path LIKE ? LIMIT ?",
                    (f"%{q}%", f"%{q}%", limit)
                ).fetchall()
            try:
                sem_hits = emb.hybrid_files(db, q, brain_base, limit=limit * 2)
            except Exception:
                sem_hits = []
            return fts_rows, sem_hits

    fts_rows, sem_hits = await asyncio.to_thread(_run)

    # RRF-Merge per Pfad. FTS-Pfade sind absolut, brain-hybrid liefert relative Pfade.
    k = 60
    brain_abs = str(brain_base.resolve()) + "/"
    scored: dict[str, dict] = {}
    for rank, r in enumerate(fts_rows):
        source, path, title, snippet = r[0], r[1], r[2], r[3]
        key = path
        scored[key] = {
            "source": source, "path": path, "title": title, "snippet": snippet,
            "score": 1.0 / (k + rank + 1),
        }
    for rank, h in enumerate(sem_hits):
        rel = h["path"]
        abs_path = brain_abs + rel
        bonus = 1.0 / (k + rank + 1)
        if abs_path in scored:
            scored[abs_path]["score"] += bonus
            if not scored[abs_path]["snippet"]:
                scored[abs_path]["snippet"] = h["snippet"]
        else:
            scored[abs_path] = {
                "source": "brain", "path": abs_path, "title": rel,
                "snippet": h["snippet"], "score": bonus,
            }
    out = sorted(scored.values(), key=lambda x: x["score"], reverse=True)[:limit]
    for x in out:
        x.pop("score", None)
    return JSONResponse({"results": out})


@router.post("/api/search/reindex")
async def trigger_reindex():
    reindex_all(SOURCES, _resolve_path)
    return JSONResponse({"ok": True})


@router.get("/api/search/semantic")
async def search_semantic(q: str = "", limit: int = 10, agent: str = ""):
    if not q.strip():
        return JSONResponse({"results": []})
    import embeddings as emb
    with get_db() as db:
        try:
            results = emb.search(db, q, limit=limit, agent=agent)
        except Exception as e:
            return JSONResponse({"error": str(e), "results": []}, status_code=500)
    return JSONResponse({"results": results})


@router.get("/api/search/hybrid")
async def search_hybrid(q: str = "", limit: int = 10, agent: str = ""):
    if not q.strip():
        return JSONResponse({"results": []})
    import embeddings as emb
    with get_db() as db:
        try:
            results = emb.hybrid(db, q, limit=limit, agent=agent)
        except Exception as e:
            return JSONResponse({"error": str(e), "results": []}, status_code=500)
    return JSONResponse({"results": results})


@router.get("/api/search/semantic/stats")
async def semantic_stats():
    import embeddings as emb
    with get_db() as db:
        s = emb.stats(db)
        s["files"] = emb.file_stats(db)
        return JSONResponse(s)


@router.post("/api/search/semantic/index")
async def semantic_index(max_messages: int = 0):
    import embeddings as emb
    with get_db() as db:
        n = emb.index_pending(db, max_messages=max_messages or None)
    return JSONResponse({"indexed": n})


@router.post("/api/search/semantic/index-files")
async def semantic_index_files():
    """Brain-MD-Files (re-)indexieren. Re-embed nur bei mtime-Änderung."""
    import embeddings as emb
    base = Path.home() / "agent/brain"
    def _run():
        with get_db() as db:
            return emb.index_files(db, base)
    res = await asyncio.to_thread(_run)
    return JSONResponse(res)


@router.get("/api/search/files-hybrid")
async def search_files_hybrid(q: str = "", limit: int = 10):
    """Hybrid-Suche über Brain-MD-Files (ripgrep + Embeddings)."""
    if not q.strip():
        return JSONResponse({"results": []})
    import embeddings as emb
    base = Path.home() / "agent/brain"
    def _run():
        with get_db() as db:
            return emb.hybrid_files(db, q, base, limit=limit)
    try:
        results = await asyncio.to_thread(_run)
    except Exception as e:
        return JSONResponse({"error": str(e), "results": []}, status_code=500)
    return JSONResponse({"results": results})
