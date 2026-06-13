"""Lokale semantische Suche via Ollama (nomic-embed-text, 768d).

Embeddings liegen als BLOB neben den Messages in chat.db. Index ist ein
Wegwerf-Artefakt: jederzeit löschbar, jederzeit neu baubar. MD-Files
bleiben unangetastet.
"""
from __future__ import annotations

import array
import math
import sqlite3
import time
from pathlib import Path
from typing import Iterable

import httpx

OLLAMA_URL = "http://localhost:11434/api/embeddings"
OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate"
MODEL = "dengcao/Qwen3-Embedding-0.6B:Q8_0"
DIM = 1024
RERANK_MODEL = "dengcao/Qwen3-Reranker-0.6B:Q8_0"
MIN_CHARS = 20  # Voice-Fragmente wie "Läuft." rausfiltern


def init(db: sqlite3.Connection) -> None:
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS embeddings (
            message_id INTEGER PRIMARY KEY,
            vector BLOB NOT NULL,
            model TEXT NOT NULL,
            created_at REAL NOT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        )
        """
    )
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS file_embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            chunk_idx INTEGER NOT NULL,
            content TEXT NOT NULL,
            mtime REAL NOT NULL,
            vector BLOB NOT NULL,
            model TEXT NOT NULL,
            created_at REAL NOT NULL,
            UNIQUE(path, chunk_idx)
        )
        """
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_file_emb_path ON file_embeddings(path)")
    db.commit()


def _pack(vec: list[float]) -> bytes:
    return array.array("f", vec).tobytes()


def _unpack(blob: bytes) -> list[float]:
    a = array.array("f")
    a.frombytes(blob)
    return list(a)


def embed(text: str, timeout: float = 30.0, feature: str = "memory_embed") -> list[float]:
    text = (text or "").strip()
    if not text:
        return [0.0] * DIM
    t0 = time.time()
    ok = True
    try:
        r = httpx.post(OLLAMA_URL, json={"model": MODEL, "prompt": text}, timeout=timeout)
        r.raise_for_status()
        return r.json()["embedding"]
    except Exception:
        ok = False
        raise
    finally:
        try:
            from llm_log import log_call
            log_call(feature, "ollama", MODEL, (time.time() - t0) * 1000, ok=ok)
        except Exception:
            pass


def rerank(query: str, docs: list[str], timeout: float = 30.0,
           feature: str = "memory_rerank") -> list[float]:
    """Cross-Encoder-Rerank via Qwen3-Reranker.
    Score = P(yes) aus Logits. Höher = relevanter. Liefert Score je Doc."""
    if not query or not docs:
        return [0.0] * len(docs)
    t0 = time.time()
    ok = True
    scores: list[float] = []
    try:
        for doc in docs:
            prompt = (
                "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n"
                "<|im_start|>user\n"
                "<Instruct>: Given a web search query, retrieve relevant passages that answer the query\n"
                f"<Query>: {query}\n<Document>: {doc[:2000]}<|im_end|>\n"
                "<|im_start|>assistant\n<think>\n\n</think>\n\n"
            )
            try:
                r = httpx.post(
                    OLLAMA_GENERATE_URL,
                    json={
                        "model": RERANK_MODEL,
                        "prompt": prompt,
                        "stream": False,
                        "raw": True,
                        "options": {"num_predict": 1, "temperature": 0.0, "logprobs": True, "top_logprobs": 20},
                    },
                    timeout=timeout,
                )
                r.raise_for_status()
                out = (r.json().get("response") or "").strip().lower()
                scores.append(1.0 if out.startswith("yes") else 0.0)
            except Exception:
                scores.append(0.0)
                ok = False
        return scores
    finally:
        try:
            from llm_log import log_call
            log_call(feature, "ollama", RERANK_MODEL, (time.time() - t0) * 1000, ok=ok)
        except Exception:
            pass


def cosine(a: list[float], b: list[float]) -> float:
    s = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        s += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return s / (math.sqrt(na) * math.sqrt(nb))


def index_pending(db: sqlite3.Connection, batch: int = 64, max_messages: int | None = None) -> int:
    """Embed alle Messages, die noch keinen Vektor haben. Gibt Anzahl zurück."""
    init(db)
    rows = db.execute(
        """
        SELECT m.id, m.content
        FROM messages m
        LEFT JOIN embeddings e ON e.message_id = m.id
        WHERE e.message_id IS NULL AND length(trim(m.content)) >= ?
        ORDER BY m.id ASC
        """
        + (f" LIMIT {int(max_messages)}" if max_messages else ""),
        (MIN_CHARS,),
    ).fetchall()

    n = 0
    now = time.time()
    for mid, content in rows:
        try:
            vec = embed(content[:8000])
        except Exception:
            continue
        db.execute(
            "INSERT OR REPLACE INTO embeddings (message_id, vector, model, created_at) VALUES (?,?,?,?)",
            (mid, _pack(vec), MODEL, now),
        )
        n += 1
        if n % batch == 0:
            db.commit()
    db.commit()
    return n


def search(db: sqlite3.Connection, query: str, limit: int = 10, agent: str = "") -> list[dict]:
    """Reine semantische Suche. Liefert Messages mit Score sortiert."""
    qvec = embed(query)
    agent_clause = " AND m.agent = ?" if agent else ""
    params: tuple = (agent,) if agent else ()
    rows = db.execute(
        f"""
        SELECT m.id, m.author, m.content, m.ts, m.agent, m.conversation_id, e.vector
        FROM embeddings e
        JOIN messages m ON m.id = e.message_id
        WHERE 1=1{agent_clause}
        """,
        params,
    ).fetchall()

    scored = []
    for mid, author, content, ts, ag, cid, blob in rows:
        score = cosine(qvec, _unpack(blob))
        scored.append((score, mid, author, content, ts, ag, cid))
    scored.sort(reverse=True)
    return [
        {"id": r[1], "author": r[2], "content": r[3], "ts": r[4], "agent": r[5], "conversationId": r[6], "score": round(r[0], 4)}
        for r in scored[:limit]
    ]


def stats(db: sqlite3.Connection) -> dict:
    init(db)
    total = db.execute(
        "SELECT COUNT(*) FROM messages WHERE length(trim(content)) >= ?", (MIN_CHARS,)
    ).fetchone()[0]
    indexed = db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
    return {"total": total, "indexed": indexed, "pending": total - indexed, "model": MODEL, "dim": DIM}


def cleanup_short(db: sqlite3.Connection) -> int:
    """Löscht Embeddings von Messages, die unter MIN_CHARS liegen (Voice-Fragmente)."""
    init(db)
    cur = db.execute(
        "DELETE FROM embeddings WHERE message_id IN ("
        " SELECT e.message_id FROM embeddings e "
        " JOIN messages m ON m.id = e.message_id "
        f" WHERE length(trim(m.content)) < ?)",
        (MIN_CHARS,),
    )
    db.commit()
    return cur.rowcount


def _fts5(db: sqlite3.Connection, query: str, limit: int, agent: str = "") -> list[tuple]:
    words = [w.strip().replace('"', '') for w in query.split() if w.strip()]
    fts_query = " AND ".join(f'"{w}"*' for w in words) if words else query
    agent_clause = " AND m.agent = ?" if agent else ""
    params: list = [fts_query]
    if agent:
        params.append(agent)
    params.append(limit)
    try:
        rows = db.execute(
            f"SELECT m.id, m.author, m.content, m.ts, m.agent, m.conversation_id "
            f"FROM messages m JOIN chat_search cs ON m.id = cs.rowid "
            f"WHERE chat_search MATCH ?{agent_clause} ORDER BY cs.rank LIMIT ?",
            tuple(params),
        ).fetchall()
    except Exception:
        rows = []
    return rows


FILE_CHUNK_MAX = 1200      # Zeichen pro Chunk (~250 Tokens)
FILE_CHUNK_MIN = 80        # winzige Chunks rausfiltern
FILE_MAX_BYTES = 200_000   # riesige Files überspringen


def _chunk_text(text: str, max_chars: int = FILE_CHUNK_MAX) -> list[str]:
    """Teilt nach Absätzen, packt zusammen bis max_chars."""
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paras:
        if len(p) > max_chars:
            if buf:
                chunks.append(buf)
                buf = ""
            for i in range(0, len(p), max_chars):
                chunks.append(p[i:i + max_chars])
            continue
        if not buf:
            buf = p
        elif len(buf) + 2 + len(p) <= max_chars:
            buf += "\n\n" + p
        else:
            chunks.append(buf)
            buf = p
    if buf:
        chunks.append(buf)
    return [c for c in chunks if len(c) >= FILE_CHUNK_MIN]


def index_files(db: sqlite3.Connection, base: Path, glob: str = "*.md",
                exclude_dirs: tuple = ("archive", ".git", "node_modules"),
                max_files: int | None = None) -> dict:
    """Indexiert alle MD-Files unter base. Re-embed nur wenn mtime sich änderte.
    Returnt {indexed_files, indexed_chunks, skipped, removed}."""
    init(db)
    base = base.resolve()
    if not base.exists():
        return {"indexed_files": 0, "indexed_chunks": 0, "skipped": 0, "removed": 0}

    seen_paths: set[str] = set()
    indexed_files = 0
    indexed_chunks = 0
    skipped = 0
    now = time.time()

    files = []
    for fp in base.rglob(glob):
        if not fp.is_file():
            continue
        rel = fp.relative_to(base)
        if any(part in exclude_dirs for part in rel.parts):
            continue
        try:
            size = fp.stat().st_size
        except Exception:
            continue
        if size > FILE_MAX_BYTES or size < FILE_CHUNK_MIN:
            continue
        files.append(fp)
    if max_files:
        files = files[:max_files]

    for fp in files:
        rel = str(fp.relative_to(base))
        seen_paths.add(rel)
        try:
            mtime = fp.stat().st_mtime
        except Exception:
            continue
        existing = db.execute(
            "SELECT mtime FROM file_embeddings WHERE path = ? LIMIT 1", (rel,)
        ).fetchone()
        if existing and abs(existing[0] - mtime) < 1.0:
            skipped += 1
            continue
        try:
            text = fp.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        chunks = _chunk_text(text)
        if not chunks:
            continue
        # Phase 1: alle Embeddings ausserhalb jeder Schreib-Transaktion
        rows = []
        failed = False
        for idx, chunk in enumerate(chunks):
            try:
                vec = embed(chunk[:8000])
            except Exception:
                failed = True
                break
            rows.append((rel, idx, chunk, mtime, _pack(vec), MODEL, now))
        if failed or not rows:
            # Alten Stand stehen lassen — nächster Lauf versucht es erneut
            continue
        # Phase 2: eine kurze atomare Transaktion pro File
        db.execute("DELETE FROM file_embeddings WHERE path = ?", (rel,))
        db.executemany(
            "INSERT INTO file_embeddings (path, chunk_idx, content, mtime, vector, model, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            rows,
        )
        db.commit()
        indexed_chunks += len(rows)
        indexed_files += 1

    # Verschwundene Files aufräumen
    all_paths = {row[0] for row in db.execute("SELECT DISTINCT path FROM file_embeddings").fetchall()}
    stale = all_paths - seen_paths
    removed = 0
    for path in stale:
        # Nur löschen wenn Pfad zu base gehört (Heuristik: File existiert nicht mehr)
        if not (base / path).exists():
            db.execute("DELETE FROM file_embeddings WHERE path = ?", (path,))
            removed += 1
    db.commit()
    return {"indexed_files": indexed_files, "indexed_chunks": indexed_chunks,
            "skipped": skipped, "removed": removed}


def file_stats(db: sqlite3.Connection) -> dict:
    init(db)
    chunks = db.execute("SELECT COUNT(*) FROM file_embeddings").fetchone()[0]
    files = db.execute("SELECT COUNT(DISTINCT path) FROM file_embeddings").fetchone()[0]
    return {"files": files, "chunks": chunks, "model": MODEL, "dim": DIM}


def search_files(db: sqlite3.Connection, query: str, limit: int = 10) -> list[dict]:
    """Reine semantische Suche über File-Chunks."""
    qvec = embed(query)
    rows = db.execute(
        "SELECT id, path, chunk_idx, content, vector FROM file_embeddings"
    ).fetchall()
    scored = []
    for fid, path, idx, content, blob in rows:
        score = cosine(qvec, _unpack(blob))
        scored.append((score, fid, path, idx, content))
    scored.sort(reverse=True)
    return [
        {"id": r[1], "path": r[2], "chunk_idx": r[3], "content": r[4], "score": round(r[0], 4)}
        for r in scored[:limit]
    ]


def _ripgrep_files(query: str, base: Path, limit: int = 30) -> list[dict]:
    """Synchroner ripgrep-Aufruf für Hybrid. Liefert Hits mit path und Snippet."""
    import subprocess
    try:
        proc = subprocess.run(
            ["rg", "-iC1", "-n", "--max-count", "3", "--glob", "!archive/**",
             "--glob", "*.md", query, str(base)],
            capture_output=True, text=True, timeout=5.0,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []
    base_str = str(base) + "/"
    hits: list[dict] = []
    seen_files: dict[str, dict] = {}
    for ln in proc.stdout.splitlines()[:limit * 3]:
        ln = ln.replace(base_str, "")
        # Format: path:lineno:content  oder  path-lineno-content (Kontextzeile)
        parts = ln.split(":", 2) if ":" in ln else ln.split("-", 2)
        if len(parts) < 3:
            continue
        path = parts[0]
        if path not in seen_files:
            seen_files[path] = {"path": path, "snippet": parts[2], "matches": 1}
            if len(seen_files) >= limit:
                break
        else:
            seen_files[path]["matches"] += 1
    return list(seen_files.values())


def hybrid_files(db: sqlite3.Connection, query: str, base: Path,
                 limit: int = 10, k: int = 60, use_rerank: bool = False) -> list[dict]:
    """RRF von ripgrep (file-level) und semantischer Chunk-Suche.
    Gewinner sind Files; pro File der best-scorende semantische Chunk als Snippet.
    Optional: Qwen3-Reranker als Final-Pass über die Top-Kandidaten."""
    rg_hits = _ripgrep_files(query, base, limit=limit * 3)
    sem_hits = search_files(db, query, limit=limit * 3)

    scores: dict[str, dict] = {}
    for rank, h in enumerate(rg_hits):
        path = h["path"]
        scores[path] = {
            "path": path, "snippet": h["snippet"], "rg_rank": rank + 1,
            "sem_rank": None, "sem_score": None,
            "score": 1.0 / (k + rank + 1),
        }
    # Semantik: pro Pfad nur den besten Chunk zählen
    sem_best: dict[str, dict] = {}
    for rank, h in enumerate(sem_hits):
        if h["path"] not in sem_best:
            sem_best[h["path"]] = {**h, "rank": rank + 1}
    for path, h in sem_best.items():
        bonus = 1.0 / (k + h["rank"])
        if path in scores:
            scores[path]["sem_rank"] = h["rank"]
            scores[path]["sem_score"] = h["score"]
            scores[path]["score"] += bonus
            # Lieber den semantischen Chunk als Snippet (ganze Absätze, nicht 1 Zeile)
            scores[path]["snippet"] = h["content"][:400]
        else:
            scores[path] = {
                "path": path, "snippet": h["content"][:400],
                "rg_rank": None, "sem_rank": h["rank"], "sem_score": h["score"],
                "score": bonus,
            }
    out = sorted(scores.values(), key=lambda x: x["score"], reverse=True)

    if use_rerank and len(out) > 1:
        candidates = out[:max(limit * 2, 10)]
        try:
            rscores = rerank(query, [c.get("snippet", "") for c in candidates])
            for c, rs in zip(candidates, rscores):
                c["rerank"] = rs
                c["score"] = c["score"] + rs * 0.5
            out = sorted(candidates, key=lambda x: x["score"], reverse=True) + out[len(candidates):]
        except Exception:
            pass

    out = out[:limit]
    for x in out:
        x["score"] = round(x["score"], 4)
    return out


def hybrid(db: sqlite3.Connection, query: str, limit: int = 10, agent: str = "", k: int = 60) -> list[dict]:
    """Reciprocal Rank Fusion: kombiniert FTS5- und Semantic-Ranking."""
    fts_rows = _fts5(db, query, limit=limit * 3, agent=agent)
    sem_rows = search(db, query, limit=limit * 3, agent=agent)

    scores: dict[int, dict] = {}
    for rank, r in enumerate(fts_rows):
        mid, author, content, ts, ag, cid = r
        scores[mid] = {
            "id": mid, "author": author, "content": content, "ts": ts,
            "agent": ag, "conversationId": cid,
            "fts_rank": rank + 1, "sem_rank": None, "sem_score": None,
            "score": 1.0 / (k + rank + 1),
        }
    for rank, r in enumerate(sem_rows):
        mid = r["id"]
        bonus = 1.0 / (k + rank + 1)
        if mid in scores:
            scores[mid]["sem_rank"] = rank + 1
            scores[mid]["sem_score"] = r["score"]
            scores[mid]["score"] += bonus
        else:
            scores[mid] = {
                "id": mid, "author": r["author"], "content": r["content"], "ts": r["ts"],
                "agent": r["agent"], "conversationId": r["conversationId"],
                "fts_rank": None, "sem_rank": rank + 1, "sem_score": r["score"],
                "score": bonus,
            }
    out = sorted(scores.values(), key=lambda x: x["score"], reverse=True)[:limit]
    for x in out:
        x["score"] = round(x["score"], 4)
    return out
