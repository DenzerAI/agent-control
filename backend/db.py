"""Database layer for Agent Control — SQLite with FTS5 search index."""
import json
import logging
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from engines import normalize_engine

log = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "data" / "chat.db"

# Pro Thread eine wiederverwendete Connection statt pro Aufruf neu zu verbinden.
# Vorher machte jeder `with get_db()` ein sqlite3.connect()/close() — dutzende
# Male pro Request, jedes Mal mit kaltem Page-Cache. sqlite3-Connections sind
# nicht thread-safe, deshalb thread-lokal: uvicorn recycelt seinen Worker-
# Threadpool, also bleibt die Connection inkl. warmem Cache ueber viele Requests
# am Leben. _depth macht verschachtelte get_db()-Bloecke reentrant — committet
# wird nur im aeussersten Block, damit die Transaktions-Semantik erhalten bleibt.
_local = threading.local()


def _new_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    # Wartet bei Lock-Konflikt bis 10s, statt sofort 'database is locked'.
    conn.execute("PRAGMA busy_timeout=10000")
    # synchronous=NORMAL ist mit WAL crash-sicher und klar schneller als FULL.
    conn.execute("PRAGMA synchronous=NORMAL")
    # 8 MB Page-Cache lohnt sich erst mit wiederverwendeter Connection.
    conn.execute("PRAGMA cache_size=-8000")
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
                # Connection selbst hin — verwerfen, naechster Aufruf baut neu auf.
                _drop_conn()
        raise
    finally:
        if getattr(_local, "depth", 0) > 0:
            _local.depth -= 1


def init_db():
    # WAL-Mode ist persistent in der DB-Datei, einmaliges Setzen reicht.
    with get_db() as db:
        db.execute("PRAGMA journal_mode=WAL")
    with get_db() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL DEFAULT '',
            author TEXT NOT NULL,
            content TEXT NOT NULL,
            ts REAL NOT NULL
        )""")
        cols = [r[1] for r in db.execute("PRAGMA table_info(messages)").fetchall()]
        if 'project' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN project TEXT NOT NULL DEFAULT ''")
        if 'attachments' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        if 'agent' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN agent TEXT NOT NULL DEFAULT ''")
        if 'conversation_id' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''")
        if 'tools' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'")
        if 'segments' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN segments TEXT NOT NULL DEFAULT '[]'")
        if 'incomplete' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0")
        if 'tags' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN tags TEXT NOT NULL DEFAULT ''")
        if 'edited_at' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN edited_at REAL DEFAULT NULL")
        if 'elapsed_ms' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN elapsed_ms INTEGER DEFAULT NULL")
        if 'input_tokens' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0")
        if 'output_tokens' not in cols:
            db.execute("ALTER TABLE messages ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0")
        # Indizes für die heißesten Read-Pfade. Ohne diese macht jeder Chat-Wechsel
        # einen vollen Tabellenscan über alle messages (get_msgs filtert conversation_id
        # und sortiert nach id DESC). Bei zehntausenden Zeilen ist das die spürbare
        # Trägheit beim Pane-Wechsel.
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project, id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_messages_agent_project ON messages(agent, project, id)")
        # Reactions table
        db.execute("""CREATE TABLE IF NOT EXISTS reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            emoji TEXT NOT NULL,
            agent TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id)")
        # Read state table for unread tracking
        db.execute("""CREATE TABLE IF NOT EXISTS read_state (
            conversation_id TEXT PRIMARY KEY,
            last_read_ts REAL NOT NULL DEFAULT 0
        )""")
        # FTS5 for chat messages (standalone, not content-sync)
        db.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(
            author, content, agent, conversation_id,
            tokenize='unicode61'
        )""")
        # Conversations table
        db.execute("""CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            agent TEXT NOT NULL DEFAULT '',
            project TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )""")
        # Migrate: assign existing messages without conversation_id
        orphans = db.execute("SELECT DISTINCT agent, project FROM messages WHERE conversation_id = ''").fetchall()
        for agent_id, proj in orphans:
            cid = str(uuid.uuid4())[:8]
            now = time.time()
            first_msg = db.execute(
                "SELECT content, ts FROM messages WHERE agent = ? AND project = ? AND conversation_id = '' ORDER BY id ASC LIMIT 1",
                (agent_id, proj)
            ).fetchone()
            title = (first_msg[0][:60] + '...') if first_msg and len(first_msg[0]) > 60 else (first_msg[0] if first_msg else 'Chat')
            created = first_msg[1] if first_msg else now
            db.execute("INSERT INTO conversations (id, agent, project, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (cid, agent_id, proj, title, created, now))
            db.execute("UPDATE messages SET conversation_id = ? WHERE agent = ? AND project = ? AND conversation_id = ''",
                       (cid, agent_id, proj))
        # FTS5 search index
        db.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
            source, path, title, content, tokenize='unicode61'
        )""")
        # Claude session ID for --resume support
        conv_cols = [r[1] for r in db.execute("PRAGMA table_info(conversations)").fetchall()]
        if 'claude_session_id' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN claude_session_id TEXT NOT NULL DEFAULT ''")
        if 'codex_session_id' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN codex_session_id TEXT NOT NULL DEFAULT ''")
        if 'archived' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        if 'engine' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex'")
            # Backfill: bestehende Claude-Code-Chats behalten die Claude-Engine.
            db.execute("UPDATE conversations SET engine = 'claude' WHERE agent = 'claude' OR agent LIKE 'claude-%'")
        # Per-Chat Prefs (effort + deepMode), damit Desktop und Mobile dieselbe
        # Auswahl pro Conversation sehen. Leeres effort = noch nichts gewählt.
        if 'effort' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN effort TEXT NOT NULL DEFAULT ''")
        if 'deep_mode' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN deep_mode INTEGER NOT NULL DEFAULT 0")
        if 'dual_mode' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN dual_mode INTEGER NOT NULL DEFAULT 0")
        # Highlight-Flag für Klaus-initiierte Convs (Morgenbriefing-Chat).
        # 1 = orange in Chat-Liste, beim ersten Öffnen auf 0 gesetzt.
        if 'highlight' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN highlight INTEGER NOT NULL DEFAULT 0")
        # kind: '' = normaler Chat, 'work_session' = von der Werkbank gespawnter
        # Arbeitslauf. Wird in der Chat-Liste per Default ausgeblendet.
        if 'kind' not in conv_cols:
            db.execute("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
            db.execute("UPDATE conversations SET kind = 'work_session' WHERE kind = '' AND (title LIKE 'Arbeitslauf -%' OR title LIKE 'Arbeitslauf ·%')")
        # Projects table
        db.execute("""CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            plan TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )""")
        proj_cols = [r[1] for r in db.execute("PRAGMA table_info(projects)").fetchall()]
        if 'archived' not in proj_cols:
            db.execute("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        # Calendar events (manuelle Eintraege; PT-Desk kommt aus JSON-Snapshot)
        db.execute("""CREATE TABLE IF NOT EXISTS calendar_events (
            id TEXT PRIMARY KEY,
            start_iso TEXT NOT NULL,
            duration_min INTEGER NOT NULL DEFAULT 60,
            title TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS calendar_events_start ON calendar_events(start_iso)")
        # Fokus-Items: operative Aufgaben aus /fokus als lokale Wahrheit.
        db.execute("""CREATE TABLE IF NOT EXISTS focus_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            bucket TEXT NOT NULL DEFAULT 'later',
            triage TEXT NOT NULL DEFAULT 'later',
            date TEXT NOT NULL DEFAULT '',
            date_end TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            people_json TEXT NOT NULL DEFAULT '[]',
            projects_json TEXT NOT NULL DEFAULT '[]',
            tags_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'open',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS focus_items_status_bucket ON focus_items(status, bucket, date)")
        db.execute("CREATE INDEX IF NOT EXISTS focus_items_updated_at ON focus_items(updated_at)")
        # Focus-Item Updates: Notizen / Voice-Transkripte zu einzelnen Fokus-Items
        db.execute("""CREATE TABLE IF NOT EXISTS focus_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key TEXT NOT NULL,
            item_title TEXT NOT NULL,
            text TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'text',
            ts REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS focus_updates_key ON focus_updates(item_key, ts)")
        # Focus-Slots: Zeitfenster-Zuweisung pro Item-Tag fuer das Wochengrid.
        # day_iso ist YYYY-MM-DD, start_min und dur_min sind Minuten ab 00:00.
        db.execute("""CREATE TABLE IF NOT EXISTS focus_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_key TEXT NOT NULL,
            item_title TEXT NOT NULL,
            day_iso TEXT NOT NULL,
            start_min INTEGER NOT NULL,
            dur_min INTEGER NOT NULL DEFAULT 30,
            updated_at REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS focus_slots_day ON focus_slots(day_iso)")
        db.execute("CREATE INDEX IF NOT EXISTS focus_slots_key ON focus_slots(item_key, day_iso)")
        # Kurztitel-Cache: Haiku verdichtet lange Item-Titel auf ~32 Zeichen.
        # full_title dient als Invalidierung: ändert sich der Titel im Fokus-Store, wird neu gekürzt.
        db.execute("""CREATE TABLE IF NOT EXISTS focus_titles (
            item_key TEXT PRIMARY KEY,
            full_title TEXT NOT NULL,
            short_title TEXT NOT NULL,
            updated_at REAL NOT NULL
        )""")
        # Mapping Fokus-Item → Conversation. N:1 erlaubt: ein Item kann eindeutig
        # einer Conv zugeordnet sein (item_key PRIMARY KEY), aber mehrere Items können
        # auf dieselbe Conv zeigen — z.B. wenn Title-Drift einen neuen Hash erzeugt
        # und Fuzzy-Match die bestehende Conv übernimmt.
        db.execute("""CREATE TABLE IF NOT EXISTS focus_item_conv (
            item_key TEXT PRIMARY KEY,
            conv_id TEXT NOT NULL,
            created_at REAL NOT NULL
        )""")
        # Migration: alte UNIQUE-Constraint auf conv_id entfernen, falls noch da.
        try:
            idx_rows = db.execute("PRAGMA index_list('focus_item_conv')").fetchall()
            for ir in idx_rows:
                if int(ir[2]) == 1:  # unique
                    cols = db.execute(f"PRAGMA index_info('{ir[1]}')").fetchall()
                    if any(c[2] == 'conv_id' for c in cols):
                        db.execute("CREATE TABLE focus_item_conv_new (item_key TEXT PRIMARY KEY, conv_id TEXT NOT NULL, created_at REAL NOT NULL)")
                        db.execute("INSERT INTO focus_item_conv_new SELECT item_key, conv_id, created_at FROM focus_item_conv")
                        db.execute("DROP TABLE focus_item_conv")
                        db.execute("ALTER TABLE focus_item_conv_new RENAME TO focus_item_conv")
                        break
        except Exception:
            pass
        # Marker für Quick-Add-Sessions: jede Plus-Voice-Anlage spawnt eine eigene
        # Conversation, die hier gelistet wird, damit der Quick-Add-Kontext pro Turn
        # injectet wird (Anlegen-Modus statt Edit-Modus).
        db.execute("""CREATE TABLE IF NOT EXISTS focus_quick_add_conv (
            conv_id TEXT PRIMARY KEY,
            created_at REAL NOT NULL
        )""")
        # Persistenter Cache für die Item-Pane-Synthese. cache_key = sha1 über Titel+Rohblöcke,
        # invalidiert sich also automatisch sobald sich der Kontext ändert. Überlebt Server-Restarts,
        # damit die Item-Pane beim Wiederöffnen nicht erneut Claude befragt.
        db.execute("""CREATE TABLE IF NOT EXISTS focus_synth_cache (
            cache_key TEXT PRIMARY KEY,
            ts REAL NOT NULL,
            data TEXT NOT NULL
        )""")
        # PT-Item-Convs: pro PT-Kunde eine persistente Chat-Conversation, in der alle
        # Termin-Notizen und Trainer-Beobachtungen über die Zeit landen. customer_id
        # ist die ptdesk-ID. Conv-Title trägt Kundennamen, wird aus normaler Chat-Liste
        # ausgefiltert wie die Fokus-Convs.
        db.execute("""CREATE TABLE IF NOT EXISTS pt_customer_conv (
            customer_id TEXT PRIMARY KEY,
            customer_name TEXT NOT NULL DEFAULT '',
            conv_id TEXT NOT NULL,
            created_at REAL NOT NULL
        )""")
        # example.com Leads — gespiegelt aus Cloudflare KV, lokale Inbox.
        db.execute("""CREATE TABLE IF NOT EXISTS denzer_leads (
            kv_key TEXT PRIMARY KEY,
            ts_kv INTEGER NOT NULL,
            ts_iso TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            phone TEXT NOT NULL DEFAULT '',
            company TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            level TEXT NOT NULL DEFAULT '',
            tools TEXT NOT NULL DEFAULT '[]',
            seat_number INTEGER DEFAULT NULL,
            waitlist INTEGER NOT NULL DEFAULT 0,
            mail_sent INTEGER NOT NULL DEFAULT 0,
            mail_reason TEXT NOT NULL DEFAULT '',
            confirmation_sent INTEGER NOT NULL DEFAULT 0,
            ip TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            raw TEXT NOT NULL DEFAULT '{}',
            seen INTEGER NOT NULL DEFAULT 0,
            seen_at REAL DEFAULT NULL,
            synced_at REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS denzer_leads_ts ON denzer_leads(ts_kv DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS denzer_leads_seen ON denzer_leads(seen, ts_kv DESC)")
        # Eingang-Orchestrator — Events aus allen Quellen (Mail, WhatsApp, Forms, …)
        # Klaus klassifiziert sie und legt sie hier ab. siehe brain/ideas/eingang-orchestrator.md
        db.execute("""CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            external_id TEXT NOT NULL,
            ts REAL NOT NULL,
            person_email TEXT NOT NULL DEFAULT '',
            person_phone TEXT NOT NULL DEFAULT '',
            person_name TEXT NOT NULL DEFAULT '',
            subject TEXT NOT NULL DEFAULT '',
            excerpt TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL DEFAULT '{}',
            klassifikation TEXT NOT NULL DEFAULT 'info-only',
            bezug TEXT NOT NULL DEFAULT '{}',
            konfidenz REAL NOT NULL DEFAULT 0.0,
            grund TEXT NOT NULL DEFAULT '',
            fokus_added INTEGER NOT NULL DEFAULT 0,
            fokus_title TEXT NOT NULL DEFAULT '',
            seen INTEGER NOT NULL DEFAULT 0,
            seen_at REAL DEFAULT NULL,
            created_at REAL NOT NULL,
            UNIQUE(source, external_id)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS events_ts ON events(ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS events_seen ON events(seen, ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS events_klass ON events(klassifikation, seen)")
        # Heartbeat-Pulses: regelmäßige Wächter mit Status pro Run.
        db.execute("""CREATE TABLE IF NOT EXISTS pulses (
            name TEXT PRIMARY KEY,
            interval_sec INTEGER NOT NULL,
            last_run REAL DEFAULT NULL,
            last_ok_at REAL DEFAULT NULL,
            last_status TEXT NOT NULL DEFAULT 'unknown',
            last_message TEXT NOT NULL DEFAULT '',
            last_payload TEXT NOT NULL DEFAULT '{}',
            fail_streak INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            updated_at REAL NOT NULL DEFAULT 0
        )""")
        # Klaus-Channel Post-Log: pro proaktiven Post ein Eintrag, mit Reaktions-Flag.
        # Grundlage für Lern-Schicht, 3x-Ignoriert-Detektor und Cross-Talk.
        db.execute("""CREATE TABLE IF NOT EXISTS klaus_pulse_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            msg_id INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT '',
            dedupe_key TEXT NOT NULL DEFAULT '',
            variant_idx INTEGER NOT NULL DEFAULT 0,
            ts REAL NOT NULL,
            response_seen INTEGER NOT NULL DEFAULT 0,
            response_ts REAL DEFAULT NULL,
            meta TEXT NOT NULL DEFAULT '{}'
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS klaus_pulse_posts_source_ts ON klaus_pulse_posts(source, ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS klaus_pulse_posts_seen ON klaus_pulse_posts(response_seen, ts DESC)")
        # LLM-Call-Log: pro LLM-Aufruf eine Zeile. Quelle für Engines-Tab und Qwen-Anteil-Auswertung.
        db.execute("""CREATE TABLE IF NOT EXISTS llm_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            feature TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            ok INTEGER NOT NULL DEFAULT 1,
            fallback_from TEXT NOT NULL DEFAULT ''
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS llm_calls_ts ON llm_calls(ts DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS llm_calls_feature_ts ON llm_calls(feature, ts DESC)")
        llm_cols = [r[1] for r in db.execute("PRAGMA table_info(llm_calls)").fetchall()]
        for _col, _decl in (
            ("input_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("output_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"),
            ("cost_usd", "REAL NOT NULL DEFAULT 0"),
            ("conversation_id", "TEXT NOT NULL DEFAULT ''"),
        ):
            if _col not in llm_cols:
                db.execute(f"ALTER TABLE llm_calls ADD COLUMN {_col} {_decl}")
        # Tool-Broker-Audit liegt jetzt in der getrennten data/broker.db
        # (siehe backend/tools/storage.py), nicht mehr in chat.db. Der Broker
        # legt seine Tabellen dort lazy selbst an.
        cal_cols = [r[1] for r in db.execute("PRAGMA table_info(calendar_events)").fetchall()]
        if 'label' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN label TEXT NOT NULL DEFAULT ''")
        if 'rrule' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN rrule TEXT NOT NULL DEFAULT ''")
        if 'rrule_until' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN rrule_until TEXT NOT NULL DEFAULT ''")
        if 'gcal_event_id' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN gcal_event_id TEXT NOT NULL DEFAULT ''")
        if 'gcal_calendar_id' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN gcal_calendar_id TEXT NOT NULL DEFAULT ''")
        if 'category' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN category TEXT NOT NULL DEFAULT 'klaus'")
        if 'person_id' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN person_id INTEGER DEFAULT NULL")
            db.execute("CREATE INDEX IF NOT EXISTS calendar_events_person ON calendar_events(person_id)")
        if 'all_day' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0")
        if 'status' not in cal_cols:
            db.execute("ALTER TABLE calendar_events ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
            db.execute("CREATE INDEX IF NOT EXISTS calendar_events_status ON calendar_events(status)")
        # Absage-Detektor: jede erkannte Cancellation wird hier festgehalten,
        # auch wenn das Event danach (manuell) reaktiviert wird. Eine Karte
        # im Klaus-Channel referenziert genau eine Zeile hier.
        db.execute("""CREATE TABLE IF NOT EXISTS cancellation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            source TEXT NOT NULL,
            source_ref TEXT NOT NULL DEFAULT '',
            person_id INTEGER DEFAULT NULL,
            person_name TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            suggested_slots_json TEXT NOT NULL DEFAULT '[]',
            raw_text TEXT NOT NULL DEFAULT '',
            detected_at REAL NOT NULL,
            confirmed INTEGER NOT NULL DEFAULT 0,
            klaus_channel_msg_id TEXT NOT NULL DEFAULT ''
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS cancellation_events_event ON cancellation_events(event_id)")
        db.execute("CREATE INDEX IF NOT EXISTS cancellation_events_detected ON cancellation_events(detected_at)")
        # Message-Queue: Nachrichten die versendet werden sollen, auch wenn der User offline ist.
        # status: pending → processing → done
        db.execute("""CREATE TABLE IF NOT EXISTS message_queue (
            id TEXT PRIMARY KEY,
            conv_id TEXT NOT NULL,
            text TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            agent_id TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS message_queue_conv_status ON message_queue(conv_id, status, created_at)")
        # Workflow Run Log: gemeinsame Laufakte für ausführbare Abläufe
        # wie WhatsApp Send, Mail Send, Kalenderanlage oder Beleg-Sweeps.
        db.execute("""CREATE TABLE IF NOT EXISTS workflow_runs (
            id TEXT PRIMARY KEY,
            workflow_key TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            trigger TEXT NOT NULL DEFAULT '',
            subject_type TEXT NOT NULL DEFAULT '',
            subject_ref TEXT NOT NULL DEFAULT '',
            conversation_id TEXT NOT NULL DEFAULT '',
            person_id INTEGER DEFAULT NULL,
            input_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT NOT NULL DEFAULT '{}',
            error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            finished_at REAL DEFAULT NULL,
            review_status TEXT NOT NULL DEFAULT 'pending',
            review_message TEXT NOT NULL DEFAULT '',
            review_json TEXT NOT NULL DEFAULT '{}'
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS workflow_runs_key_created ON workflow_runs(workflow_key, created_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS workflow_runs_status_created ON workflow_runs(status, created_at DESC)")
        db.execute("""CREATE TABLE IF NOT EXISTS workflow_run_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            step_key TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'ok',
            summary TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL DEFAULT '{}',
            ts REAL NOT NULL,
            FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS workflow_run_steps_run_ts ON workflow_run_steps(run_id, ts)")
        ev_cols = [r[1] for r in db.execute("PRAGMA table_info(events)").fetchall()]
        if 'person_id' not in ev_cols:
            db.execute("ALTER TABLE events ADD COLUMN person_id INTEGER DEFAULT NULL")
            db.execute("CREATE INDEX IF NOT EXISTS events_person ON events(person_id)")
            # Backfill: aus payload._person_id in die Spalte ziehen
            rows = db.execute("SELECT id, payload FROM events WHERE payload LIKE '%_person_id%'").fetchall()
            import json as _json
            for r in rows:
                try:
                    pl = _json.loads(r[1] or '{}')
                    pid = pl.get('_person_id')
                    if isinstance(pid, int):
                        db.execute("UPDATE events SET person_id = ? WHERE id = ?", (pid, r[0]))
                except Exception:
                    pass
    # Populate chat_search FTS5 index if empty
    with get_db() as db:
        count = db.execute("SELECT COUNT(*) FROM chat_search").fetchone()[0]
        if count == 0:
            msg_count = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            if msg_count > 0:
                db.execute("INSERT INTO chat_search (rowid, author, content, agent, conversation_id) SELECT id, author, content, agent, conversation_id FROM messages WHERE content != ''")
                print(f"[AC] Indexed {msg_count} chat messages into FTS5")
    # Stable agent channels
    ensure_channels()


AGENT_CHANNELS = {
    'main': 'channel-main',
    'eva': 'channel-eva',
    'alex': 'channel-alex',
    'wolf': 'channel-wolf',
    'claude': 'channel-claude',
}

# Dedizierter Voice-Channel (nicht per-agent): alle Voice-Sessions laufen hier.
VOICE_CHANNEL_ID = 'channel-voice'
VOICE_CHANNEL_AGENT = 'main'
VOICE_CHANNEL_TITLE = 'Voice'

# Anzeigenamen fuer Channel-Titel. Der Hauptname kommt aus config/agents.json,
# damit der Kern namens-neutral bleibt (Default-Platzhalter "Agent"). Die
# Neben-Agenten haengen ihren Bereich an den Hauptnamen.
def _main_agent_name(default: str = "Agent") -> str:
    try:
        cfg = json.loads((Path(__file__).parent.parent / "config" / "agents.json").read_text())
        return cfg.get("agents", {}).get("main", {}).get("name") or default
    except Exception:
        return default

_MAIN_NAME = _main_agent_name()
AGENT_NAMES = {
    'main': _MAIN_NAME,
    'eva': f'{_MAIN_NAME} System',
    'alex': f'{_MAIN_NAME} Content',
    'wolf': f'{_MAIN_NAME} Signals',
    'claude': 'Tony',
}


def ensure_channels():
    """Create stable channel conversations for each agent if they don't exist."""
    now = time.time()
    with get_db() as db:
        for agent_id, channel_id in AGENT_CHANNELS.items():
            row = db.execute("SELECT id FROM conversations WHERE id = ?", (channel_id,)).fetchone()
            if not row:
                name = AGENT_NAMES.get(agent_id, agent_id)
                db.execute(
                    "INSERT INTO conversations (id, agent, project, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (channel_id, agent_id, '', name, now, now)
                )
                print(f"[AC] Channel erstellt: {channel_id} ({name})")
        # Dedizierter Voice-Channel
        row = db.execute("SELECT id FROM conversations WHERE id = ?", (VOICE_CHANNEL_ID,)).fetchone()
        if not row:
            db.execute(
                "INSERT INTO conversations (id, agent, project, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (VOICE_CHANNEL_ID, VOICE_CHANNEL_AGENT, '', VOICE_CHANNEL_TITLE, now, now)
            )
            print(f"[AC] Voice-Channel erstellt: {VOICE_CHANNEL_ID}")


def get_channel_id(agent_id: str) -> str:
    """Get the stable default channel conversation ID for an agent."""
    return AGENT_CHANNELS.get(agent_id, f'channel-{agent_id}')


def _index_chat_msg(db, row_id: int, author: str, content: str, agent: str, conversation_id: str):
    """Insert a message into the chat FTS5 index."""
    try:
        db.execute("INSERT INTO chat_search (rowid, author, content, agent, conversation_id) VALUES (?, ?, ?, ?, ?)",
                   (row_id, author, content, agent, conversation_id))
    except Exception:
        pass  # FTS5 insert can fail on duplicate rowid — safe to ignore


def _has_attachments(attachments: str) -> bool:
    try:
        parsed = json.loads(attachments or "[]")
        return isinstance(parsed, list) and len(parsed) > 0
    except Exception:
        return bool((attachments or "").strip() and attachments != "[]")


def save_msg(agent: str, project: str, author: str, content: str, conversation_id: str = '', tools: str = '[]', attachments: str = '[]', elapsed_ms: int | None = None, segments: str = '[]', input_tokens: int = 0, output_tokens: int = 0):
    if author == "Du" and not (content or "").strip() and not _has_attachments(attachments):
        log.warning("empty user message discarded for conversation %s", conversation_id or "-")
        return None
    with get_db() as db:
        cur = db.execute("INSERT INTO messages (agent, project, author, content, ts, conversation_id, tools, attachments, elapsed_ms, segments, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (agent, project, author, content, time.time(), conversation_id, tools, attachments, elapsed_ms, segments, int(input_tokens or 0), int(output_tokens or 0)))
        _index_chat_msg(db, cur.lastrowid, author, content, agent, conversation_id)
        if conversation_id:
            db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (time.time(), conversation_id))
        row_id = cur.lastrowid
    _tag_message_async(row_id, author, content)
    if conversation_id == 'klaus-channel' and author == 'user':
        try:
            from modules import klaus_channel as _kc
            _kc.mark_user_response(time.time())
        except Exception as e:
            log.warning(f"klaus_channel response mark failed: {e}")
    return row_id


def _tag_message_async(row_id: int, author: str, content: str):
    """Scannt Chat-Message nach Projekt/Personen-Mentions. Best-effort."""
    if not content or len(content) < 10 or author in ("system", ""):
        return
    try:
        from backend import entities
        entities.tag_text(content, entities.SOURCE_CHAT, str(row_id))
    except Exception as e:
        log.warning(f"entity tagging failed for msg {row_id}: {e}")


def insert_partial(agent: str, project: str, author: str, content: str, conversation_id: str = '', segments: str = '[]') -> int:
    """Insert a new partial streaming message. Returns the row id for later updates."""
    with get_db() as db:
        now = time.time()
        cur = db.execute("INSERT INTO messages (agent, project, author, content, ts, conversation_id, tools, segments, incomplete) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 1)",
                   (agent, project, author, content, now, conversation_id, segments))
        if conversation_id:
            db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
        return cur.lastrowid


def update_partial(row_id: int, content: str, tools: str = '[]', elapsed_ms: int | None = None, segments: str = '[]', complete: bool = False, input_tokens: int = 0, output_tokens: int = 0):
    """Update an existing partial streaming message by row id."""
    is_final = complete or elapsed_ms is not None
    with get_db() as db:
        if is_final:
            # Final update of a stream — mark the row as complete.
            db.execute("UPDATE messages SET content = ?, tools = ?, ts = ?, elapsed_ms = ?, segments = ?, input_tokens = ?, output_tokens = ?, incomplete = 0 WHERE id = ?",
                       (content, tools, time.time(), elapsed_ms, segments, int(input_tokens or 0), int(output_tokens or 0), row_id))
        else:
            db.execute("UPDATE messages SET content = ?, tools = ?, ts = ?, segments = ? WHERE id = ?",
                       (content, tools, time.time(), segments, row_id))
        # FTS5-Index nur beim finalen Update schreiben. Zwischenstände sind
        # incomplete und werden im Stream sofort wieder überschrieben; sie pro
        # Token zu re-tokenisieren ist der teuerste Posten im Stream-Hot-Path.
        if is_final:
            try:
                db.execute("DELETE FROM chat_search WHERE rowid = ?", (row_id,))
                row = db.execute("SELECT author, agent, conversation_id FROM messages WHERE id = ?", (row_id,)).fetchone()
                if row:
                    db.execute("INSERT INTO chat_search (rowid, author, content, agent, conversation_id) VALUES (?, ?, ?, ?, ?)",
                               (row_id, row[0], content, row[1], row[2]))
            except Exception:
                pass


def reindex_chat_msg_if_incomplete(row_id: int):
    """Zieht den FTS5-Eintrag einer Chat-Row nach, falls sie noch incomplete ist.
    Der reguläre Index-Write passiert nur beim finalen complete-Update; bricht ein
    Stream hart ab (Cancel/Crash) vor diesem Call, bliebe die Teilantwort sonst
    nicht durchsuchbar. Idempotent und best-effort: No-op, wenn die Row bereits
    final indiziert oder leer ist."""
    try:
        with get_db() as db:
            row = db.execute(
                "SELECT author, content, agent, conversation_id, incomplete FROM messages WHERE id = ?",
                (row_id,)).fetchone()
            if not row or not row[4] or not (row[1] or "").strip():
                return
            db.execute("DELETE FROM chat_search WHERE rowid = ?", (row_id,))
            db.execute("INSERT INTO chat_search (rowid, author, content, agent, conversation_id) VALUES (?, ?, ?, ?, ?)",
                       (row_id, row[0], row[1], row[2], row[3]))
    except Exception:
        pass


def mark_msg_complete(row_id: int) -> bool:
    """Markiert eine Stream-Row als fertig, ohne Inhalt/Tools/Timing anzufassen.

    Schutz gegen den Flacker-Loop: Reisst die Verbindung kurz vor dem finalen
    complete-Update ab, bliebe die fertig gestreamte Antwort `incomplete=1` und
    das Frontend würde sie automatisch fortsetzen. Idempotent und gezielt:
    setzt nur das Flag, no-op wenn die Row bereits fertig oder weg ist.
    Gibt True zurück, wenn tatsächlich eine incomplete Row umgesetzt wurde."""
    try:
        with get_db() as db:
            cur = db.execute(
                "UPDATE messages SET incomplete = 0 WHERE id = ? AND incomplete = 1",
                (row_id,))
            return cur.rowcount > 0
    except Exception:
        return False


def get_msg_content(row_id: int) -> str:
    with get_db() as db:
        r = db.execute("SELECT content FROM messages WHERE id = ?", (row_id,)).fetchone()
        return r[0] if r else ""


def get_msgs(agent: str, project: str, limit: int = 100, conversation_id: str = ''):
    with get_db() as db:
        if conversation_id:
            rows = db.execute(
                "SELECT id, author, content, ts, tools, edited_at, attachments, elapsed_ms, segments, incomplete, input_tokens, output_tokens FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
                (conversation_id, limit)
            ).fetchall()
        elif project:
            rows = db.execute(
                "SELECT id, author, content, ts, tools, edited_at, attachments, elapsed_ms, segments, incomplete, input_tokens, output_tokens FROM messages WHERE project = ? ORDER BY id DESC LIMIT ?",
                (project, limit)
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT id, author, content, ts, tools, edited_at, attachments, elapsed_ms, segments, incomplete, input_tokens, output_tokens FROM messages WHERE agent = ? AND project = ? ORDER BY id DESC LIMIT ?",
                (agent, project, limit)
            ).fetchall()
    msgs = [{"id": r[0], "author": r[1], "content": r[2], "ts": r[3], "tools": r[4] if len(r) > 4 else "[]", "edited_at": r[5] if len(r) > 5 else None, "attachments": r[6] if len(r) > 6 else "[]", "elapsed_ms": r[7] if len(r) > 7 else None, "segments": r[8] if len(r) > 8 else "[]", "incomplete": bool(r[9]) if len(r) > 9 else False, "input_tokens": int(r[10] or 0) if len(r) > 10 else 0, "output_tokens": int(r[11] or 0) if len(r) > 11 else 0} for r in reversed(rows)]
    # Batch-load reactions for all messages
    msg_ids = [m["id"] for m in msgs]
    reactions_map = get_reactions_batch(msg_ids)
    for m in msgs:
        m["reactions"] = reactions_map.get(m["id"], [])
    return msgs


def edit_msg(msg_id: int, content: str) -> bool:
    """Edit a message's content. Returns True if found and updated."""
    with get_db() as db:
        row = db.execute("SELECT id, author, agent, conversation_id FROM messages WHERE id = ?", (msg_id,)).fetchone()
        if not row:
            return False
        db.execute("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
                   (content, time.time(), msg_id))
        try:
            db.execute("DELETE FROM chat_search WHERE rowid = ?", (msg_id,))
            db.execute("INSERT INTO chat_search (rowid, author, content, agent, conversation_id) VALUES (?, ?, ?, ?, ?)",
                       (msg_id, row[1], content, row[2], row[3]))
        except Exception:
            pass
        return True


def delete_msg(msg_id: int) -> bool:
    """Delete a single message. Returns True if found and deleted."""
    with get_db() as db:
        row = db.execute("SELECT id FROM messages WHERE id = ?", (msg_id,)).fetchone()
        if not row:
            return False
        db.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
        db.execute("DELETE FROM reactions WHERE message_id = ?", (msg_id,))
        try:
            db.execute("DELETE FROM chat_search WHERE rowid = ?", (msg_id,))
        except Exception:
            pass
        return True


def add_reaction(message_id: int, emoji: str, agent: str) -> bool:
    """Add a reaction to a message. Returns True if message exists."""
    with get_db() as db:
        row = db.execute("SELECT id FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return False
        # Prevent duplicate reactions from same agent with same emoji
        existing = db.execute(
            "SELECT id FROM reactions WHERE message_id = ? AND emoji = ? AND agent = ?",
            (message_id, emoji, agent)
        ).fetchone()
        if not existing:
            db.execute("INSERT INTO reactions (message_id, emoji, agent, created_at) VALUES (?, ?, ?, ?)",
                       (message_id, emoji, agent, time.time()))
        return True


def remove_reaction(message_id: int, emoji: str, agent: str) -> bool:
    """Remove a reaction. Returns True if found and removed."""
    with get_db() as db:
        db.execute("DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND agent = ?",
                   (message_id, emoji, agent))
        return True


def get_reactions(message_id: int) -> list:
    """Get all reactions for a message."""
    with get_db() as db:
        rows = db.execute(
            "SELECT emoji, agent, created_at FROM reactions WHERE message_id = ? ORDER BY created_at",
            (message_id,)
        ).fetchall()
    return [{"emoji": r[0], "agent": r[1], "ts": r[2]} for r in rows]


def get_reactions_batch(message_ids: list[int]) -> dict:
    """Get reactions for multiple messages at once. Returns {msg_id: [reactions]}."""
    if not message_ids:
        return {}
    placeholders = ",".join("?" * len(message_ids))
    with get_db() as db:
        rows = db.execute(
            f"SELECT message_id, emoji, agent, created_at FROM reactions WHERE message_id IN ({placeholders}) ORDER BY created_at",
            message_ids
        ).fetchall()
    result = {}
    for r in rows:
        result.setdefault(r[0], []).append({"emoji": r[1], "agent": r[2], "ts": r[3]})
    return result


def mark_read(conversation_id: str):
    """Mark a conversation as read up to now."""
    with get_db() as db:
        db.execute(
            "INSERT OR REPLACE INTO read_state (conversation_id, last_read_ts) VALUES (?, ?)",
            (conversation_id, time.time())
        )


def get_unread_counts() -> dict:
    """Get unread message counts per conversation. Returns {conv_id: count}."""
    with get_db() as db:
        # Get all read states
        read_rows = db.execute("SELECT conversation_id, last_read_ts FROM read_state").fetchall()
        read_map = {r[0]: r[1] for r in read_rows}
        # Count unread per conversation
        conv_rows = db.execute("SELECT id FROM conversations").fetchall()
        result = {}
        for (cid,) in conv_rows:
            last_read = read_map.get(cid, 0)
            count = db.execute(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND ts > ? AND author != 'Du'",
                (cid, last_read)
            ).fetchone()[0]
            if count > 0:
                result[cid] = count
        return result


def get_claude_session_id(conversation_id: str) -> str:
    """Get the Claude CLI session ID for a conversation."""
    if not conversation_id:
        return ''
    with get_db() as db:
        row = db.execute("SELECT claude_session_id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return row[0] if row and row[0] else ''


def set_claude_session_id(conversation_id: str, session_id: str):
    """Store the Claude CLI session ID for a conversation."""
    if not conversation_id:
        return
    with get_db() as db:
        db.execute("UPDATE conversations SET claude_session_id = ? WHERE id = ?", (session_id, conversation_id))


def get_codex_session_id(conversation_id: str) -> str:
    """Get the Codex CLI thread/session ID for a conversation."""
    if not conversation_id:
        return ''
    with get_db() as db:
        row = db.execute("SELECT codex_session_id FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return row[0] if row and row[0] else ''


def set_codex_session_id(conversation_id: str, session_id: str):
    """Store the Codex CLI thread/session ID for a conversation."""
    if not conversation_id:
        return
    with get_db() as db:
        db.execute("UPDATE conversations SET codex_session_id = ? WHERE id = ?", (session_id, conversation_id))


def get_conversation_engine(conversation_id: str) -> str:
    """Get the runtime engine for a conversation. Default: codex."""
    if not conversation_id:
        return 'codex'
    with get_db() as db:
        row = db.execute("SELECT engine FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return normalize_engine(row[0] if row and row[0] else 'codex', default='codex', runtime_only=True)


def set_conversation_engine(conversation_id: str, engine: str):
    """Set the engine for a conversation."""
    safe_engine = normalize_engine(engine, default='', runtime_only=True)
    if not conversation_id or not safe_engine:
        return
    with get_db() as db:
        db.execute("UPDATE conversations SET engine = ? WHERE id = ?", (safe_engine, conversation_id))


def create_conversation(agent: str, project: str, title: str = '', engine: str = 'claude', kind: str = '') -> str:
    cid = str(uuid.uuid4())[:8]
    now = time.time()
    safe_engine = normalize_engine(engine, default='claude', runtime_only=True)
    with get_db() as db:
        db.execute(
            "INSERT INTO conversations (id, agent, project, title, created_at, updated_at, engine, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (cid, agent, project, title or 'Neuer Chat', now, now, safe_engine, kind or '')
        )
    return cid


def get_conversation(conv_id: str) -> dict | None:
    """Get a single conversation by ID."""
    with get_db() as db:
        row = db.execute(
            "SELECT id, agent, project, title, created_at, updated_at, "
            "COALESCE(engine, 'codex') FROM conversations WHERE id = ?",
            (conv_id,)
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "agent": row[1], "project": row[2], "title": row[3],
                "created_at": row[4], "updated_at": row[5], "engine": row[6]}


# ── Projects ──

def create_project(name: str) -> dict:
    pid = str(uuid.uuid4())[:8]
    now = time.time()
    default_plan = ""
    with get_db() as db:
        db.execute("INSERT INTO projects (id, name, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                   (pid, name, default_plan, now, now))
    return {"id": pid, "name": name, "plan": default_plan, "created_at": now, "updated_at": now}


def get_projects(archived: bool = False) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT p.id, p.name, p.plan, p.created_at, p.updated_at, p.archived, "
            "(SELECT COUNT(*) FROM conversations WHERE project = p.id) as chat_count "
            "FROM projects p WHERE p.archived = ? ORDER BY p.updated_at DESC",
            (1 if archived else 0,)
        ).fetchall()
    return [{"id": r[0], "name": r[1], "plan": r[2], "created_at": r[3], "updated_at": r[4], "archived": bool(r[5]), "chatCount": r[6]} for r in rows]


def get_project(project_id: str) -> dict | None:
    with get_db() as db:
        row = db.execute("SELECT id, name, plan, created_at, updated_at FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            return None
        return {"id": row[0], "name": row[1], "plan": row[2], "created_at": row[3], "updated_at": row[4]}


def update_project_plan(project_id: str, plan: str):
    now = time.time()
    with get_db() as db:
        db.execute("UPDATE projects SET plan = ?, updated_at = ? WHERE id = ?", (plan, now, project_id))


def rename_project(project_id: str, name: str):
    now = time.time()
    with get_db() as db:
        db.execute("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?", (name, now, project_id))


def set_project_archived(project_id: str, archived: bool):
    now = time.time()
    with get_db() as db:
        db.execute("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?", (1 if archived else 0, now, project_id))


def delete_project(project_id: str):
    with get_db() as db:
        db.execute("UPDATE conversations SET project = '' WHERE project = ?", (project_id,))
        db.execute("DELETE FROM projects WHERE id = ?", (project_id,))


def get_project_conversations(project_id: str) -> list[dict]:
    with get_db() as db:
        rows = db.execute(
            "SELECT id, agent, title, created_at, updated_at FROM conversations WHERE project = ? ORDER BY updated_at DESC",
            (project_id,)
        ).fetchall()
    return [{"id": r[0], "agent": r[1], "title": r[2], "created_at": r[3], "updated_at": r[4]} for r in rows]


_title_tasks: set = set()  # prevent GC of background title tasks


def auto_title(conv_id: str, first_message: str):
    """Set a quick fallback title, then schedule async LLM title generation."""
    with get_db() as db:
        row = db.execute("SELECT title FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not row or row[0] not in ('Neuer Chat', ''):
            return row[0] if row else 'Neuer Chat'
    import re
    line = first_message.strip().split('\n')[0].strip()
    line = re.sub(r'[#*_`>\[\]|]', '', line).strip()
    if len(line) > 50:
        line = line[:47] + '...'
    if not line:
        line = 'Neuer Chat'
    with get_db() as db:
        db.execute("UPDATE conversations SET title = ? WHERE id = ?", (line, conv_id))
    # Schedule async LLM title generation
    import asyncio
    try:
        loop = asyncio.get_running_loop()
        async def _broadcast_fallback():
            from streaming import broadcast_title_update
            await broadcast_title_update(conv_id, line)
        loop.create_task(_broadcast_fallback())
        task = loop.create_task(_generate_llm_title(conv_id, first_message))
        _title_tasks.add(task)
        task.add_done_callback(_title_tasks.discard)
        log.info("[auto_title] Scheduled LLM title task for conv %s", conv_id[:8])
    except RuntimeError:
        log.warning("[auto_title] No event loop — skipping LLM title for conv %s", conv_id[:8])
    return line


async def run_claude_cli(prompt: str, model: str = "claude-haiku-4-5", timeout: float = 30.0) -> tuple[int, str, str]:
    """Run `claude -p --model <model>` once with prompt on stdin.

    Returns (returncode, stdout, stderr). Strips ANTHROPIC_API_KEY from env to
    avoid the CLI falling back to API-key auth when a stale key is present.
    """
    import asyncio
    import os
    subprocess_env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    proc = await asyncio.create_subprocess_exec(
        "claude", "-p", "--model", model,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=subprocess_env,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(input=prompt.encode()), timeout=timeout)
    return proc.returncode, stdout.decode(), stderr.decode()


async def run_codex_cli(prompt: str, model: str = "gpt-5.5", timeout: float = 120.0) -> tuple[int, str, str]:
    """Run `codex exec` once with prompt on stdin, return (returncode, text, stderr).

    Liest den finalen Text aus einem `-o`-Tempfile (wie der Dual-Review-Sidecar),
    read-only Sandbox, weil ein One-Shot-Call nichts schreiben muss.
    """
    import asyncio
    import os
    import tempfile
    from pathlib import Path
    with tempfile.NamedTemporaryFile(prefix="codex-oneshot-", suffix=".txt", delete=False) as tmp:
        out_path = tmp.name
    cwd = str(Path(__file__).resolve().parent.parent)
    try:
        proc = await asyncio.create_subprocess_exec(
            "codex", "exec",
            "--model", model,
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--sandbox", "read-only",
            "-C", cwd,
            "-o", out_path,
            "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(input=prompt.encode()), timeout=timeout)
        text = ""
        try:
            text = Path(out_path).read_text(errors="replace").strip()
        except Exception:
            text = ""
        if not text:
            text = stdout.decode(errors="replace").strip()
        return proc.returncode, text, stderr.decode(errors="replace")
    finally:
        try:
            os.remove(out_path)
        except Exception:
            pass


async def _run_haiku_title(prompt: str, timeout: float = 25.0) -> tuple[int, str, str]:
    """Legacy shim for auto-title path."""
    return await run_claude_cli(prompt, model="claude-haiku-4-5", timeout=timeout)


async def _generate_llm_title(conv_id: str, message: str):
    """Generate a short, descriptive chat title — lokales LLM zuerst, Haiku als Fallback."""
    import asyncio
    import re
    prompt = f"Gib diesem Chat einen kurzen, prägnanten Titel auf deutsch. Zwei bis fünf voll ausgeschriebene Wörter, ein vollständiger, in sich geschlossener Ausdruck — niemals ein angefangener Satz. Keine Abkürzungen, keine Auslassungspunkte, kein '...', keine Anführungszeichen, kein Markdown, kein Fett, keine Headings, keine Erklärung. Lieber ein einzelnes treffendes Schlagwort als ein hängender Halbsatz. Nur der Titel als Plain Text.\n\nErste Nachricht: {message[:300]}"
    stdout = ""
    source = "haiku"
    try:
        try:
            from local_llm import call_local, is_available
            if is_available():
                stdout = await call_local(prompt, max_tokens=40, temperature=0.3, timeout=15.0, feature="auto_title")
                source = "local"
        except Exception as e:
            log.warning("[auto_title] local LLM failed (%s) — falling back to Haiku", e)
            stdout = ""
        if not stdout.strip():
            import time as _t
            for attempt in (1, 2):
                try:
                    _t0 = _t.time()
                    rc, stdout, stderr = await _run_haiku_title(prompt, timeout=25.0)
                    try:
                        from llm_log import log_call as _lc
                        _lc(
                            "auto_title", "anthropic", "Haiku 4.5",
                            (_t.time() - _t0) * 1000,
                            ok=(rc == 0 and bool(stdout.strip())),
                            fallback_from="qwen",
                        )
                    except Exception:
                        pass
                except asyncio.TimeoutError:
                    log.warning("[auto_title] Haiku timeout attempt %d for conv %s (prompt=%d chars)",
                                attempt, conv_id[:8], len(prompt))
                    if attempt == 2:
                        return
                    await asyncio.sleep(2)
                    continue
                if rc == 0 and stdout.strip():
                    break
                log.warning("[auto_title] Haiku rc=%d attempt %d conv %s (prompt=%d chars) stdout=%r stderr=%r",
                            rc, attempt, conv_id[:8], len(prompt), stdout[:200], stderr[:200])
                if attempt == 2:
                    return
                await asyncio.sleep(2)
        title = stdout.strip().split('\n')[0].strip()
        title = re.sub(r'^(\*{1,3}|_{1,3}|`+|#+\s*)', '', title)
        title = re.sub(r'(\*{1,3}|_{1,3}|`+)$', '', title)
        title = title.strip('"\'*_`# ').strip()
        # Auslassungspunkte raus, nie als Endmarker zulassen
        title = re.sub(r'[…]+', '', title)
        title = re.sub(r'\.{2,}', '', title)
        title = title.rstrip('. ').strip()
        # Vollen, sauberen Titel speichern — die UI kürzt platzabhängig mit echtem '…'
        # (Apple/Claude-Verhalten). Hier nur eine großzügige Notbremse, damit das
        # Datenmodell bei einem ausufernden lokalen Modell nicht überläuft.
        if len(title) > 60:
            cut = title[:60].rsplit(' ', 1)[0]
            title = (cut if cut else title[:60]).rstrip('. ').strip() + '…'
        if not title or len(title) < 2:
            log.warning("[auto_title] Haiku produced unusable title %r for conv %s", stdout[:200], conv_id[:8])
            return
        with get_db() as db:
            db.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conv_id))
        from streaming import broadcast_title_update
        await broadcast_title_update(conv_id, title)
        log.warning("[auto_title] '%s' (%s) → conv %s", title, source, conv_id[:8])
    except FileNotFoundError:
        log.error("[auto_title] 'claude' binary not found — LLM titles disabled")
    except Exception as e:
        log.warning("[auto_title] Failed for conv %s: %s", conv_id[:8], e)


async def regenerate_title(conv_id: str) -> str | None:
    """Force-regenerate the LLM title for an existing conversation. Returns new title or None."""
    with get_db() as db:
        row = db.execute(
            "SELECT content FROM messages WHERE conversation_id = ? AND author = 'Du' ORDER BY id ASC LIMIT 1",
            (conv_id,)
        ).fetchone()
    if not row:
        return None
    with get_db() as db:
        db.execute("UPDATE conversations SET title = 'Neuer Chat' WHERE id = ?", (conv_id,))
    await _generate_llm_title(conv_id, row[0])
    with get_db() as db:
        t = db.execute("SELECT title FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    return t[0] if t else None


# ── Auto-Project: Klaus ordnet Chats automatisch Projekten zu ──

_project_tasks: set = set()  # prevent GC of background project-match tasks
_project_in_flight: set[str] = set()  # conv_ids gerade in Bearbeitung
_project_rejected: dict[str, set[str]] = {}  # conv_id -> {project_id} die Christian abgelehnt hat


def reject_project_suggestion(conv_id: str, project_id: str):
    """Christian hat 'Nein' auf einen Projekt-Vorschlag gesagt — nicht nochmal anbieten."""
    if not conv_id or not project_id:
        return
    _project_rejected.setdefault(conv_id, set()).add(project_id)


def auto_project(conv_id: str):
    """Wenn Bedingungen passen, dispatche async einen Haiku-Match gegen alle Projekte.

    Bedingungen:
    - conv hat noch kein Projekt
    - es existieren Projekte
    - 2..6 User-Messages im Chat
    - kein Match gerade in Flight
    """
    if not conv_id or conv_id in _project_in_flight:
        return
    with get_db() as db:
        cv = db.execute("SELECT project FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not cv or cv[0]:
            return
        proj_count = db.execute("SELECT COUNT(*) FROM projects WHERE archived = 0").fetchone()[0]
        if not proj_count:
            return
        user_msg_count = db.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND author = 'Du'",
            (conv_id,)
        ).fetchone()[0]
    if user_msg_count < 2 or user_msg_count > 6:
        return
    import asyncio
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        log.warning("[auto_project] No event loop — skip conv %s", conv_id[:8])
        return
    _project_in_flight.add(conv_id)
    task = loop.create_task(_run_project_match(conv_id))
    _project_tasks.add(task)
    task.add_done_callback(lambda t: (_project_tasks.discard(t), _project_in_flight.discard(conv_id)))


async def _run_project_match(conv_id: str):
    """Hole Projekte + Recent-Messages, frage Haiku nach Match, broadcaste Ergebnis."""
    import asyncio
    import re
    try:
        with get_db() as db:
            projects = db.execute(
                "SELECT id, name, plan FROM projects WHERE archived = 0"
            ).fetchall()
            msgs = db.execute(
                "SELECT author, content FROM messages "
                "WHERE conversation_id = ? AND content != '' "
                "ORDER BY id ASC LIMIT 6",
                (conv_id,)
            ).fetchall()
            title_row = db.execute("SELECT title FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not projects or not msgs:
            return
        chat_title = (title_row[0] if title_row else '') or ''
        rejected = _project_rejected.get(conv_id, set())
        active_projects = [(pid, name, plan) for (pid, name, plan) in projects if pid not in rejected]
        if not active_projects:
            return

        proj_lines = []
        for pid, name, plan in active_projects:
            short_plan = (plan or '').strip().replace('\n', ' ')
            if len(short_plan) > 200:
                short_plan = short_plan[:197] + '...'
            line = f"- {pid} | {name}"
            if short_plan:
                line += f" — {short_plan}"
            proj_lines.append(line)

        msg_lines = []
        for author, content in msgs:
            snippet = (content or '').strip().replace('\n', ' ')
            if len(snippet) > 280:
                snippet = snippet[:277] + '...'
            who = 'Du' if author == 'Du' else 'Klaus'
            msg_lines.append(f"{who}: {snippet}")

        try:
            from identity import get_owner as _gow
        except ImportError:
            from backend.identity import get_owner as _gow
        _owner_first = _gow()["first_name"]
        prompt = (
            f"Du ordnest einen Chat einem von {_owner_first}s Projekten zu. Antworte in EINER "
            "Zeile, exakt im Format `<project_id>|<high|medium|low>` oder `NONE` wenn kein "
            "Projekt thematisch passt. Keine Erklärung, kein Markdown.\n\n"
            "Confidence-Regeln:\n"
            "- high: klarer Themen-Treffer, der Chat gehört eindeutig dazu\n"
            "- medium: plausibler Treffer, aber nicht eindeutig — ich frage nach\n"
            "- low: schwacher Bezug — gib stattdessen NONE\n\n"
            f"Projekte:\n" + "\n".join(proj_lines) + "\n\n"
            f"Chat-Titel: {chat_title}\n\n"
            f"Bisheriger Verlauf:\n" + "\n".join(msg_lines) + "\n\n"
            "Antwort:"
        )

        # Qwen-First (lokal, schnell), Haiku als Fallback
        answer_text = ""
        qwen_failed = False
        try:
            from local_llm import call_local, is_available
            if is_available():
                answer_text = await call_local(
                    prompt=prompt,
                    system="Du bist ein präziser Klassifikator. Antworte exakt im verlangten Format, eine Zeile, keine Erklärung.",
                    max_tokens=40, temperature=0.1, timeout=15.0,
                    feature="auto_project",
                )
        except Exception as _e:
            log.warning("[auto_project] Qwen failed (%s) — falling back to Haiku", _e)
            qwen_failed = True
            answer_text = ""

        if not answer_text.strip():
            try:
                rc, stdout, stderr = await run_claude_cli(prompt, model="claude-haiku-4-5", timeout=30.0)
            except asyncio.TimeoutError:
                log.warning("[auto_project] Haiku timeout for conv %s", conv_id[:8])
                return
            if rc != 0 or not stdout.strip():
                log.warning("[auto_project] Haiku rc=%d conv %s stdout=%r stderr=%r",
                            rc, conv_id[:8], stdout[:200], stderr[:200])
                return
            try:
                from llm_log import log_call as _lc
                _lc("auto_project", "claude", "claude-haiku-4-5", 0.0, ok=True,
                    fallback_from="qwen" if qwen_failed else "")
            except Exception:
                pass
            answer_text = stdout

        answer = answer_text.strip().split('\n')[0].strip().strip('`"\' ')
        if answer.upper().startswith('NONE'):
            log.warning("[auto_project] NONE for conv %s", conv_id[:8])
            return
        m = re.match(r'^([0-9a-f]{4,})\s*\|\s*(high|medium|low)\b', answer, re.IGNORECASE)
        if not m:
            log.warning("[auto_project] unparseable answer %r for conv %s", answer, conv_id[:8])
            return
        pid = m.group(1).lower()
        confidence = m.group(2).lower()

        proj_match = next((p for p in active_projects if p[0] == pid), None)
        if not proj_match:
            log.warning("[auto_project] unknown project %s for conv %s", pid, conv_id[:8])
            return
        proj_name = proj_match[1]

        from streaming import broadcast_project_update
        if confidence in ('high', 'medium'):
            with get_db() as db:
                db.execute("UPDATE conversations SET project = ?, updated_at = ? WHERE id = ?",
                           (pid, time.time(), conv_id))
            await broadcast_project_update(conv_id, pid)
            log.warning("[auto_project] auto-assigned (%s) %s (%s) → conv %s", confidence, proj_name, pid, conv_id[:8])
        else:
            log.warning("[auto_project] low confidence — skip conv %s", conv_id[:8])
    except FileNotFoundError:
        log.error("[auto_project] 'claude' binary not found")
    except Exception as e:
        log.warning("[auto_project] Failed for conv %s: %s", conv_id[:8], e)


def reindex_all(sources, _resolve_path):
    """Scan all sources and rebuild FTS5 index."""
    with get_db() as db:
        db.execute("DELETE FROM search_index WHERE source != 'chat'")
        count = 0
        for src in sources:
            sid = src["id"]
            if src["type"] == "brain":
                bp = _resolve_path(src["path"])
                if not bp.exists():
                    continue
                for pattern in ["people.md", "projects.md", "learnings.md", "rules.md", "BRAIN.md", "memory/2*.md"]:
                    for fp in bp.glob(pattern):
                        if fp.stat().st_size > 200_000:
                            continue
                        try:
                            content = fp.read_text()
                            db.execute("INSERT INTO search_index (source, path, title, content) VALUES (?, ?, ?, ?)",
                                       (sid, str(fp), fp.name, content))
                            count += 1
                        except (UnicodeDecodeError, OSError):
                            pass
        # Index global and shared rule files
        for gp in [
            Path.home() / "agent/soul/BOOTSTRAP.md",
            Path.home() / "agent/soul/IDENTITY.md",
            Path.home() / "agent/soul/STYLE.md",
            Path.home() / "CLAUDE.md",
            Path.home() / ".claude" / "CLAUDE.md",
        ]:
            if gp.exists():
                try:
                    db.execute("INSERT INTO search_index (source, path, title, content) VALUES (?, ?, ?, ?)",
                               ("global", str(gp), gp.name, gp.read_text()))
                    count += 1
                except (UnicodeDecodeError, OSError):
                    pass
    print(f"[AC] Indexed {count} files from {len(sources)} sources")


def index_file(path: str, content: str, sources):
    """Update a single file in the FTS5 index."""
    with get_db() as db:
        db.execute("DELETE FROM search_index WHERE path = ?", (path,))
        title = Path(path).name
        source = "local"
        for src in sources:
            src_path = src.get("workspace") or src.get("path") or ""
            if src_path and src_path.replace("~", str(Path.home())) in path:
                source = src["id"]
                break
        db.execute("INSERT INTO search_index (source, path, title, content) VALUES (?, ?, ?, ?)",
                   (source, path, title, content))


# ── Calendar (manual events) ──

def calendar_list(from_iso: str = '', to_iso: str = '') -> list[dict]:
    """Liefert alle manuellen Events. Zeitfilter macht der Caller (wegen Recurrence-Expansion).

    person_id wird in calendar_events gespeichert (FK auf people.db), der Name
    wird aus people.db nachgeladen (separate DB, kein JOIN möglich).
    """
    with get_db() as db:
        rows = db.execute(
            "SELECT id, start_iso, duration_min, title, notes, location, created_at, updated_at, "
            "label, rrule, rrule_until, gcal_event_id, gcal_calendar_id, category, person_id, all_day, status "
            "FROM calendar_events ORDER BY start_iso ASC"
        ).fetchall()
    out = [
        {"id": r[0], "source": "manual", "startIso": r[1], "durationMin": r[2],
         "title": r[3], "notes": r[4], "location": r[5],
         "createdAt": r[6], "updatedAt": r[7],
         "label": r[8], "rrule": r[9], "rruleUntil": r[10],
         "gcalId": r[11], "gcalCalendarId": r[12], "category": r[13] or 'klaus',
         "personId": r[14], "allDay": bool(r[15]),
         "status": r[16] or "active"}
        for r in rows
    ]
    person_ids = {e["personId"] for e in out if e.get("personId")}
    if person_ids:
        from pathlib import Path
        import sqlite3 as _sq
        pdb = Path("/Users/klaus/agent/data/people.db")
        if pdb.exists():
            try:
                with _sq.connect(f"file:{pdb}?mode=ro", uri=True) as pcon:
                    placeholders = ",".join("?" * len(person_ids))
                    rows = pcon.execute(
                        f"SELECT id, name FROM people WHERE id IN ({placeholders})",
                        list(person_ids),
                    ).fetchall()
                names = {r[0]: r[1] for r in rows}
                for e in out:
                    if e.get("personId") and e["personId"] in names:
                        e["personName"] = names[e["personId"]]
            except Exception:
                pass
    return out


def calendar_create(start_iso: str, duration_min: int, title: str,
                    notes: str = '', location: str = '',
                    label: str = '', rrule: str = '', rrule_until: str = '',
                    category: str = 'klaus', all_day: bool = False,
                    person_id: int | None = None) -> dict:
    eid = str(uuid.uuid4())[:8]
    now = time.time()
    with get_db() as db:
        db.execute(
            "INSERT INTO calendar_events (id, start_iso, duration_min, title, notes, location, created_at, updated_at, label, rrule, rrule_until, category, all_day, person_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (eid, start_iso, duration_min, title, notes, location, now, now, label, rrule, rrule_until, category, 1 if all_day else 0, person_id)
        )
    return {"id": eid, "source": "manual", "startIso": start_iso, "durationMin": duration_min,
            "title": title, "notes": notes, "location": location,
            "createdAt": now, "updatedAt": now,
            "label": label, "rrule": rrule, "rruleUntil": rrule_until,
            "category": category, "allDay": all_day, "personId": person_id}


def calendar_update(event_id: str, fields: dict) -> bool:
    mapping = {"startIso": "start_iso", "durationMin": "duration_min",
               "title": "title", "notes": "notes", "location": "location",
               "label": "label", "rrule": "rrule", "rruleUntil": "rrule_until",
               "category": "category", "personId": "person_id", "allDay": "all_day"}
    sets = []
    vals = []
    for k, v in fields.items():
        col = mapping.get(k)
        if col:
            sets.append(f"{col} = ?")
            vals.append(1 if k == "allDay" and v else 0 if k == "allDay" else v)
    if not sets:
        return False
    sets.append("updated_at = ?")
    vals.append(time.time())
    vals.append(event_id)
    with get_db() as db:
        cur = db.execute(f"UPDATE calendar_events SET {', '.join(sets)} WHERE id = ?", vals)
        return cur.rowcount > 0


def calendar_delete(event_id: str) -> bool:
    with get_db() as db:
        cur = db.execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))
        return cur.rowcount > 0


def calendar_set_gcal_id(event_id: str, gcal_event_id: str, gcal_calendar_id: str = "") -> bool:
    with get_db() as db:
        if gcal_calendar_id:
            cur = db.execute(
                "UPDATE calendar_events SET gcal_event_id = ?, gcal_calendar_id = ? WHERE id = ?",
                (gcal_event_id, gcal_calendar_id, event_id),
            )
        else:
            cur = db.execute(
                "UPDATE calendar_events SET gcal_event_id = ? WHERE id = ?",
                (gcal_event_id, event_id),
            )
        return cur.rowcount > 0


def calendar_get_gcal_id(event_id: str) -> str:
    with get_db() as db:
        row = db.execute(
            "SELECT gcal_event_id FROM calendar_events WHERE id = ?",
            (event_id,),
        ).fetchone()
    return row[0] if row else ''


def calendar_get_gcal_ref(event_id: str) -> tuple[str, str]:
    """Liefert (gcal_event_id, gcal_calendar_id) für ein lokales Event."""
    with get_db() as db:
        row = db.execute(
            "SELECT gcal_event_id, gcal_calendar_id FROM calendar_events WHERE id = ?",
            (event_id,),
        ).fetchone()
    if not row:
        return ('', '')
    return (row[0] or '', row[1] or '')
