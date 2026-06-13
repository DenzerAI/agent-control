"""Chat router: Konversations- und Nachrichten-Kern.

Extrahiert aus server.py als dritter Schnitt der Modularisierung (nach
voice.py und deck.py). KEIN Verhalten geändert, nur verschoben. Routen-Pfade
bleiben byte-identisch.

Routen:
- GET    /api/conversations/{conv_id}/prefs           — Per-Chat Prefs lesen
- PUT    /api/conversations/{conv_id}/prefs           — Prefs setzen (+ Broadcast)
- GET    /api/conversations                           — Chat-Liste
- POST   /api/conversations/{conv_id}/seen            — Highlight quittieren
- POST   /api/conversations                           — neue Conversation
- PATCH  /api/conversations/{conv_id}                 — Titel/Archiv/Projekt/Engine/Modell
- DELETE /api/conversations/{conv_id}                 — Conversation + Messages löschen
- POST   /api/conversations/{conv_id}/retitle         — Titel neu generieren
- POST   /api/conversations/{conv_id}/reject-project  — Projekt-Vorschlag ablehnen
- GET    /api/conversations/{conv_id}/queue           — Pending-Queue lesen
- POST   /api/conversations/{conv_id}/queue           — in Queue legen
- DELETE /api/conversations/{conv_id}/queue/{item_id} — Queue-Eintrag entfernen
- PUT    /api/messages/{msg_id}                        — Nachricht editieren
- DELETE /api/messages/{msg_id}                        — Nachricht löschen
- POST   /api/messages/{msg_id}/reactions             — Reaktion setzen
- DELETE /api/messages/{msg_id}/reactions             — Reaktion entfernen
- GET    /api/messages/{msg_id}/reactions             — Reaktionen lesen
- GET    /api/unread                                  — Unread-Counts

Bewusst in server.py VERBLIEBEN (von nicht-verschobenem Code genutzt):
- ALL_CHAT_MODELS / _model_for_engine: leben oben in server.py bei den übrigen
  Modell-Konstanten (CODEX_MODELS/CLAUDE_MODELS/...). Sie werden in der PATCH-
  Route gebraucht und sonst nur am Definitionsort; hier per Late-Import aus
  server geholt (gegen Zirkularität), statt sie aus ihrem Konstanten-Block zu
  reißen.
- Benachbarte, NICHT in der Routen-Liste stehende Routen (/api/history,
  /api/message-queue/counts, /api/mark-read) bleiben in server.py.
  /api/link-preview samt Helfern (_extract_og, _link_preview_cache) ist nach
  routers/state.py gewandert.

Mitgewandert, weil ausschließlich von einer dieser Routen genutzt (per grep
über die ganze server.py verifiziert):
- _VALID_EFFORT: nur von der prefs-PUT-Route gelesen.

Die Live-Brücke zum Chat (streaming._broadcast) wird per Late-Import in der
prefs-PUT-Funktion geholt, exakt wie zuvor in server.py, um Zirkularität
zwischen server/streaming/chat zu vermeiden.
"""

import json

from fastapi import APIRouter, Request, Body
from fastapi.responses import JSONResponse

from db import get_db
from engines import is_runtime_engine, normalize_engine

router = APIRouter()


# ── Per-Chat Prefs (Effort + DeepMode + DualMode), Desktop ↔ Mobile sync ──

_VALID_EFFORT = {"low", "medium", "high", "xhigh", "max", ""}


@router.get("/api/conversations/{conv_id}/prefs")
async def conv_prefs_get(conv_id: str):
    with get_db() as db:
        row = db.execute(
            "SELECT effort, deep_mode, dual_mode FROM conversations WHERE id = ?",
            (conv_id,),
        ).fetchone()
    if not row:
        return JSONResponse({"effort": "", "deepMode": False, "dualMode": False})
    return JSONResponse({"effort": row[0] or "", "deepMode": bool(row[1]), "dualMode": bool(row[2])})


@router.put("/api/conversations/{conv_id}/prefs")
async def conv_prefs_put(conv_id: str, payload: dict = Body(...)):
    effort_raw = payload.get("effort")
    if effort_raw is not None:
        effort = str(effort_raw)
        if effort not in _VALID_EFFORT:
            return JSONResponse({"error": "invalid effort"}, status_code=400)
    else:
        effort = None
    deep_mode = payload.get("deepMode")
    if deep_mode is not None:
        deep_mode_int = 1 if bool(deep_mode) else 0
    else:
        deep_mode_int = None
    dual_mode = payload.get("dualMode")
    if dual_mode is not None:
        dual_mode_int = 1 if bool(dual_mode) else 0
    else:
        dual_mode_int = None
    with get_db() as db:
        row = db.execute("SELECT 1 FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not row:
            return JSONResponse({"error": "not found"}, status_code=404)
        sets, args = [], []
        if effort is not None:
            sets.append("effort = ?"); args.append(effort)
        if deep_mode_int is not None:
            sets.append("deep_mode = ?"); args.append(deep_mode_int)
        if dual_mode_int is not None:
            sets.append("dual_mode = ?"); args.append(dual_mode_int)
        if sets:
            args.append(conv_id)
            db.execute(f"UPDATE conversations SET {', '.join(sets)} WHERE id = ?", args)
        cur = db.execute("SELECT effort, deep_mode, dual_mode FROM conversations WHERE id = ?", (conv_id,)).fetchone()
    result = {"effort": cur[0] or "", "deepMode": bool(cur[1]), "dualMode": bool(cur[2])}
    source = str(payload.get("source") or "")
    try:
        from streaming import _broadcast
        await _broadcast(json.dumps({
            "type": "conv.prefsUpdate",
            "conversationId": conv_id,
            "effort": result["effort"],
            "deepMode": result["deepMode"],
            "dualMode": result["dualMode"],
            "source": source,
        }))
    except Exception:
        pass
    return JSONResponse(result)


@router.get("/api/conversations")
async def list_conversations(agent: str = '', project: str = '', limit: int = 30, archived: bool = False, include_work: bool = False):
    with get_db() as db:
        archive_filter = "" if archived else "AND archived = 0"
        # Fokus-Item- und Quick-Add-Convs werden ausgeblendet — sie leben unter /fokus
        # und würden die normale Chat-Liste verwässern.
        fokus_filter = (
            "AND id NOT IN (SELECT conv_id FROM focus_item_conv) "
            "AND id NOT IN (SELECT conv_id FROM focus_quick_add_conv) "
            "AND id NOT IN (SELECT conv_id FROM pt_customer_conv)"
        )
        # Von der Werkbank gespawnte Arbeitslaeufe leben in der Werkbank und
        # verstopfen sonst die Chat-Liste. Per Default raus, mit include_work rein.
        work_filter = "" if include_work else "AND COALESCE(kind, '') != 'work_session'"
        cols = "id, agent, project, title, created_at, updated_at, archived, COALESCE(engine, 'codex'), COALESCE(highlight, 0), COALESCE(model, ''), COALESCE(kind, '')"
        # limit <= 0 → keine Obergrenze (Chat-Liste lädt alles für Titel-Suche)
        limit_clause = "" if limit <= 0 else "LIMIT ?"
        if project:
            params: tuple = (project,) if limit <= 0 else (project, limit)
            rows = db.execute(
                f"SELECT {cols} FROM conversations WHERE project = ? {archive_filter} {fokus_filter} {work_filter} ORDER BY updated_at DESC {limit_clause}",
                params
            ).fetchall()
        elif agent:
            params = (agent,) if limit <= 0 else (agent, limit)
            rows = db.execute(
                f"SELECT {cols} FROM conversations WHERE agent = ? AND project = '' {archive_filter} {fokus_filter} {work_filter} ORDER BY updated_at DESC {limit_clause}",
                params
            ).fetchall()
        else:
            params = () if limit <= 0 else (limit,)
            rows = db.execute(
                f"SELECT {cols} FROM conversations WHERE 1=1 {archive_filter} {fokus_filter} {work_filter} ORDER BY updated_at DESC {limit_clause}",
                params
            ).fetchall()
    return JSONResponse({"conversations": [
        {"id": r[0], "agent": r[1], "project": r[2], "title": r[3],
         "created_at": r[4], "updated_at": r[5], "archived": bool(r[6]), "engine": r[7],
         "highlight": bool(r[8]), "model": r[9], "kind": r[10]}
        for r in rows
    ]})


@router.post("/api/conversations/{conv_id}/seen")
async def conv_seen(conv_id: str):
    """Highlight (Klaus-initiierter Chat) auf 0 setzen, sobald Christian öffnet."""
    with get_db() as db:
        db.execute("UPDATE conversations SET highlight = 0 WHERE id = ?", (conv_id,))
    return JSONResponse({"ok": True})


@router.post("/api/conversations")
async def create_conv(request: Request):
    from db import create_conversation
    body = await request.json()
    engine = normalize_engine(body.get("engine", "claude"), default="claude", runtime_only=True)
    cid = create_conversation(
        body.get("agent", "main"),
        body.get("project", ""),
        body.get("title", ""),
        engine,
    )
    return JSONResponse({"id": cid, "engine": engine})


@router.patch("/api/conversations/{conv_id}")
async def update_conv(conv_id: str, request: Request):
    from server import ALL_CHAT_MODELS, _model_for_engine
    body = await request.json()
    with get_db() as db:
        if "title" in body:
            db.execute("UPDATE conversations SET title = ? WHERE id = ?", (body["title"], conv_id))
        if "archived" in body:
            db.execute("UPDATE conversations SET archived = ? WHERE id = ?", (1 if body["archived"] else 0, conv_id))
        if "project" in body:
            db.execute("UPDATE conversations SET project = ? WHERE id = ?", (body["project"], conv_id))
        if "model" in body:
            new_model = (body.get("model") or "").strip()
            if new_model in ALL_CHAT_MODELS:
                row = db.execute("SELECT COALESCE(engine, 'codex') FROM conversations WHERE id = ?", (conv_id,)).fetchone()
                new_model = _model_for_engine((row[0] if row else "codex"), new_model)
                db.execute("UPDATE conversations SET model = ? WHERE id = ?", (new_model, conv_id))
                # Modellwechsel: Sessions resetten, damit der nächste Send
                # eine frische Session öffnet und das neue Modell auch wirklich greift.
                db.execute("UPDATE conversations SET claude_session_id = '' WHERE id = ?", (conv_id,))
                db.execute("UPDATE conversations SET codex_session_id = '' WHERE id = ?", (conv_id,))
        if "engine" in body and is_runtime_engine(body["engine"]):
            row = db.execute("SELECT engine FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            prev = (row[0] if row and row[0] else None)
            new_engine = normalize_engine(body["engine"], default="codex", runtime_only=True)
            model_row = db.execute("SELECT COALESCE(model, '') FROM conversations WHERE id = ?", (conv_id,)).fetchone()
            new_model = _model_for_engine(new_engine, model_row[0] if model_row else "")
            db.execute("UPDATE conversations SET engine = ?, model = ? WHERE id = ?", (new_engine, new_model, conv_id))
            # Wirklicher Wechsel? Session-ID der neuen Engine resetten, damit sie beim naechsten
            # Send den letzten Thread-Kontext (20 Messages) frisch eingespielt bekommt — sonst
            # waeren die beiden Engines im selben Chat unsichtbar auseinandergelaufen.
            if prev and prev != new_engine:
                col = 'codex_session_id' if new_engine == 'codex' else 'claude_session_id'
                db.execute(f"UPDATE conversations SET {col} = ? WHERE id = ?", ('', conv_id))
    return JSONResponse({"ok": True})


@router.delete("/api/conversations/{conv_id}")
async def delete_conv(conv_id: str):
    with get_db() as db:
        db.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
        db.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
    return JSONResponse({"ok": True})


@router.post("/api/conversations/{conv_id}/retitle")
async def retitle_conv(conv_id: str):
    from db import regenerate_title
    title = await regenerate_title(conv_id)
    if not title:
        return JSONResponse({"ok": False, "error": "no first message"}, status_code=404)
    return JSONResponse({"ok": True, "title": title})


@router.post("/api/conversations/{conv_id}/reject-project")
async def reject_project(conv_id: str, request: Request):
    """Christian hat einen Projekt-Vorschlag abgelehnt — nicht nochmal anbieten."""
    from db import reject_project_suggestion
    body = await request.json()
    project_id = (body.get("projectId") or "").strip()
    if not project_id:
        return JSONResponse({"error": "projectId required"}, status_code=400)
    reject_project_suggestion(conv_id, project_id)
    return JSONResponse({"ok": True})


@router.get("/api/conversations/{conv_id}/queue")
async def get_message_queue(conv_id: str):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, text, attachments_json, agent_id, created_at FROM message_queue WHERE conv_id = ? AND status = 'pending' ORDER BY created_at ASC",
            (conv_id,)
        ).fetchall()
    return JSONResponse({"items": [
        {"id": r[0], "text": r[1], "attachments": json.loads(r[2] or "[]"), "agentId": r[3], "ts": r[4]}
        for r in rows
    ]})


@router.post("/api/conversations/{conv_id}/queue")
async def add_to_message_queue(conv_id: str, request: Request):
    import uuid as _uuid2
    body = await request.json()
    text = (body.get("text") or "").strip()
    item_id = body.get("id") or str(_uuid2.uuid4())
    attachments = body.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []
    if not text and not attachments:
        return JSONResponse({"error": "text or attachments required"}, status_code=400)
    agent_id = body.get("agentId") or ""
    with get_db() as db:
        db.execute(
            "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
            (item_id, conv_id, text, json.dumps(attachments), agent_id, __import__("time").time())
        )
    return JSONResponse({"ok": True, "id": item_id})


@router.delete("/api/conversations/{conv_id}/queue/{item_id}")
async def remove_from_message_queue(conv_id: str, item_id: str):
    with get_db() as db:
        db.execute("DELETE FROM message_queue WHERE id = ? AND conv_id = ?", (item_id, conv_id))
    return JSONResponse({"ok": True})


@router.put("/api/conversations/{conv_id}/queue/order")
async def reorder_message_queue(conv_id: str, request: Request):
    """Persistiert die Reihenfolge der wartenden Queue-Eintraege.

    Die Queue wird ueberall nach created_at ASC sortiert (Anzeige und Worker-
    Dispatch), darum schreiben wir created_at fuer die uebergebene id-Reihenfolge
    monoton neu. Kein Schema-Wechsel noetig.
    """
    body = await request.json()
    ids = body.get("ids") or []
    if not isinstance(ids, list):
        return JSONResponse({"error": "ids required"}, status_code=400)
    base = __import__("time").time()
    with get_db() as db:
        for i, item_id in enumerate(ids):
            db.execute(
                "UPDATE message_queue SET created_at = ? WHERE id = ? AND conv_id = ? AND status = 'pending'",
                (base + i * 0.001, item_id, conv_id),
            )
    return JSONResponse({"ok": True})


# ── Message Actions (Edit, Delete, Reactions) ──

@router.put("/api/messages/{msg_id}")
async def edit_message(msg_id: int, request: Request):
    body = await request.json()
    content = body.get("content", "").strip()
    if not content:
        return JSONResponse({"error": "content required"}, status_code=400)
    from db import edit_msg
    if edit_msg(msg_id, content):
        return JSONResponse({"ok": True})
    return JSONResponse({"error": "message not found"}, status_code=404)


@router.delete("/api/messages/{msg_id}")
async def delete_message(msg_id: int):
    from db import delete_msg
    if delete_msg(msg_id):
        return JSONResponse({"ok": True})
    return JSONResponse({"error": "message not found"}, status_code=404)


@router.post("/api/messages/{msg_id}/reactions")
async def add_reaction_endpoint(msg_id: int, request: Request):
    body = await request.json()
    emoji = body.get("emoji", "")
    agent = body.get("agent", "")
    if not emoji:
        return JSONResponse({"error": "emoji required"}, status_code=400)
    from db import add_reaction
    if add_reaction(msg_id, emoji, agent):
        return JSONResponse({"ok": True})
    return JSONResponse({"error": "message not found"}, status_code=404)


@router.delete("/api/messages/{msg_id}/reactions")
async def remove_reaction_endpoint(msg_id: int, request: Request):
    body = await request.json()
    emoji = body.get("emoji", "")
    agent = body.get("agent", "")
    from db import remove_reaction
    remove_reaction(msg_id, emoji, agent)
    return JSONResponse({"ok": True})


@router.get("/api/messages/{msg_id}/reactions")
async def get_reactions_endpoint(msg_id: int):
    from db import get_reactions
    return JSONResponse({"reactions": get_reactions(msg_id)})


# ── Unread Tracking ──

@router.get("/api/unread")
async def get_unread():
    from db import get_unread_counts
    return JSONResponse({"unread": get_unread_counts()})
