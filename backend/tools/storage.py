"""Dedicated database for Tool Broker bookkeeping.

Audit log, approvals and gateway capability-nonces live in their OWN SQLite file
(`data/broker.db`), separate from the live `chat.db`. Reason: the running server
writes `chat.db` constantly (messages, pulses, streaming). When the broker wrote
into the same file, every broker run could block up to busy_timeout on the write
lock — the intermittent "hang" Codex hit because it can only reach tools through
this chain. Separate file = separate write lock = no contention.

Same `get_db()` contextmanager contract as backend/db.py: thread-local, reentrant
(commit only on the outermost block), WAL + busy_timeout.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[2] / "data" / "broker.db"

_local = threading.local()


def _new_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _drop_conn() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    _local.conn = None
    _local.depth = 0


@contextmanager
def get_db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _new_conn()
        _local.conn = conn
        _local.depth = 0
    _local.depth += 1
    outer = _local.depth == 1
    try:
        yield conn
        if outer:
            conn.commit()
    except Exception:
        if outer:
            try:
                conn.rollback()
            except Exception:
                _drop_conn()
        raise
    finally:
        if getattr(_local, "depth", 0) > 0:
            _local.depth -= 1


__all__ = ["get_db", "DB_PATH"]
