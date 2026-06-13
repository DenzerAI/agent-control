"""Voice-Tools router: brain- und streaming-nahe Voice-Werkzeuge.

Extrahiert aus server.py als Schnitt 4c der Modularisierung (nach voice.py,
deck.py, chat.py, files.py und skills.py). Dies ist der grösste Block: die
Voice-Tool-Endpunkte, die beim ersten Schnitt (voice.py = TTS/STT-Kern)
bewusst im Kern blieben, weil sie tief in brain/, streaming und den geteilten
Live-State hängen. KEIN Verhalten geändert, nur verschoben. Routen-Pfade
bleiben byte-identisch.

Routen:
- GET  /api/voice/context              — Live-Kontext als {{kontext}} (ConvAI)
- POST /api/voice/realtime/session     — OpenAI-Realtime-Client-Secret minten
- POST /api/voice/session/start        — Session-Marker in channel-voice
- POST /api/voice/message              — Voice-Message live persistieren
- POST /api/voice/log                  — Client-Events als JSONL
- GET  /api/voice/diag                 — letzte N Voice-Events
- POST /api/voice/focus                — fokussierten Chat pushen
- GET  /api/voice/tool/briefings       — Briefing-Liste
- GET  /api/voice/tool/briefing        — letztes Briefing lesen
- GET  /api/voice/tool/chat-context    — Fokus + letzte Messages
- GET  /api/voice/tool/brain-index     — Brain-File-Index (2 min Cache)
- GET  /api/voice/tool/brain-file      — einzelne Brain-Datei lesen
- GET  /api/voice/tool/brain-search    — Hybrid-Suche über brain/
- POST /api/voice/tool/run-briefing    — lokalen Job per run-job.sh anstoßen
- POST /api/voice/ui-state             — vollen UI-Snapshot pushen
- GET  /api/voice/tool/ui-state        — UI-Zustand zurückgeben
- GET  /api/voice/tool/web             — keyless Wetter/Krypto-Lookup
- GET  /api/voice/tool/focus           — Live-Fokus-Snapshot
- GET  /api/voice/tool/health          — heutige Health-Lage
- GET  /api/voice/tool/limits          — API-Kosten/Nutzung je Provider
- POST /api/voice/tool/send-chat       — Auftrag in Chat-Channel dispatchen
- POST /api/voice/sync-tools           — ElevenLabs-Tool-Sync triggern

Bewusst in server.py VERBLIEBEN (von nicht-verschobenem Code genutzt, per grep
über die ganze server.py verifiziert; hier per Late-Import aus server geholt, um
Zirkularität zu vermeiden):
- _sync_elevenlabs_tools, _VOICE_TOOL_DEFS, _build_voice_system_prompt: Der
  Tool-Sync wird beim Server-Start (Zeile ~434) einmalig ausgeführt; die Kette
  muss daher in server.py bleiben. /api/voice/sync-tools late-importet sie.
- _get_elevenlabs_key, _get_elevenlabs_agent_id, _get_openai_key: triviale
  os.environ-Getter, die auch der verbliebene _sync_elevenlabs_tools und der
  Startup-Pfad nutzen. Late-Import statt Duplikat.
- AGENTS, VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID, PROJECT_ROOT, LOCAL_JOBS_DIR:
  geteilte Konstanten/Globals, quer durch server.py gebraucht.

Mitgewandert, weil ausschließlich von einer dieser Routen genutzt (per grep über
die ganze server.py verifiziert):
- _VOICE_CONTEXT_CACHE, _VOICE_CONTEXT_TTL, _assemble_voice_kontext: nur von
  /api/voice/context und /api/voice/realtime/session.
- KLAUS_VOICE_REALTIME_PROMPT, _VOICE_REALTIME_TOOLS: nur von /api/voice/realtime/session.
- _UMLAUT_WORDS, _fix_umlauts: nur von /api/voice/message.
- _VOICE_BROADCAST_TASK, _VOICE_BROADCAST_DELAY, _delayed_voice_broadcast: nur
  von /api/voice/message.
- _BRIEFING_MAP: nur von den Briefing-Routen.
- _VOICE_FOCUS: geteilter Live-State, aber nur von /api/voice/focus und
  /api/voice/tool/chat-context geschrieben/gelesen, beide wandern mit.
- _VOICE_UI_STATE: geteilter Live-State, aber nur von /api/voice/ui-state und
  /api/voice/tool/ui-state, beide wandern mit.
- _VOICE_LOG_PATH: nur von /api/voice/log und /api/voice/diag.
- _BRAIN_INDEX_CACHE, _BRAIN_INDEX_TTL: nur von /api/voice/tool/brain-index.

save_msg, get_msgs, get_db kommen direkt aus db (sauberer Modul-Import).
VOICE_CHANNEL_ID/_AGENT werden per Late-Import aus server geholt, weil server
sie aus db re-exportiert und die eine Wahrheit dort liegt.
"""

import os
import json
import time
import asyncio
from pathlib import Path
from datetime import datetime, timedelta

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from db import get_db, save_msg, get_msgs

router = APIRouter()

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


# ── Voice Mode (ElevenLabs Conversational AI) ──

_VOICE_CONTEXT_CACHE: dict = {"ts": 0.0, "data": None}
_VOICE_CONTEXT_TTL = 60.0  # Sekunden — Reconnects und schnelle Wiederanrufe bleiben schnell


@router.get("/api/voice/context")
async def voice_context():
    """Live-Kontext für Klaus als dynamic_variable {{kontext}} (ConvAI-Pfad)."""
    return JSONResponse({"kontext": _assemble_voice_kontext()})


def _assemble_voice_kontext() -> str:
    """Baut den Live-Kontext-String: Identity, Fokus, Daily Logs, Projekte, Jetzt.
    60s-Cache. Geteilt von /api/voice/context (ConvAI) und dem Realtime-Endpoint
    (dort als Teil der instructions)."""
    import time as _time
    now_ts = _time.time()
    cached = _VOICE_CONTEXT_CACHE.get("data")
    if cached and (now_ts - _VOICE_CONTEXT_CACHE.get("ts", 0.0)) < _VOICE_CONTEXT_TTL:
        return JSONResponse(cached)

    parts = []
    home = Path.home()

    # 1. IDENTITY
    identity_path = PROJECT_ROOT / "docs" / "IDENTITY.md"
    if identity_path.exists():
        try:
            txt = identity_path.read_text(encoding="utf-8")[:1200]
            parts.append(f"## Identität\n{txt}")
        except Exception:
            pass

    # 2. FOCUS
    brain_path = home / "agent/brain/FOCUS.md"
    if brain_path.exists():
        try:
            txt = brain_path.read_text(encoding="utf-8")[:1500]
            parts.append(f"## Aktueller Fokus\n{txt}")
        except Exception:
            pass

    # 3. Heutiger Daily Log + gestern als Backup
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    for label, day in [("Heute", today), ("Gestern", yesterday)]:
        log_path = home / f"agent/brain/daily-log/{day}.md"
        if log_path.exists():
            try:
                txt = log_path.read_text(encoding="utf-8")[:1500]
                parts.append(f"## Daily Log {label} ({day})\n{txt}")
            except Exception:
                pass

    # 4. Aktive Projekte aus DB
    # Hinweis: get_projects ist hier (wie in der Vorlage server.py) absichtlich
    # nicht importiert; der bare-Name-Lookup schlägt fehl und wird vom
    # umschließenden except geschluckt. Verhalten 1:1 wie vorher, kein Import,
    # um keine Daten neu einzublenden.
    try:
        projects = get_projects()  # noqa: F821 — bewusst ungebunden, siehe oben
        if projects:
            lines = []
            for p in projects[:10]:
                name = p.get("name", "")
                plan = (p.get("plan") or "")[:200].strip()
                lines.append(f"- **{name}**" + (f": {plan}" if plan else ""))
            parts.append("## Aktive Projekte\n" + "\n".join(lines))
    except Exception:
        pass

    # 5. Aktuelles Datum mit relativen Tagesreferenzen
    _now = datetime.now()
    wd = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"][_now.weekday()]
    _today = _now.date()
    _iso_year, _iso_week, _ = _today.isocalendar()
    jetzt_lines = [
        f"{wd}, {_now.strftime('%d.%m.%Y %H:%M')} (KW {_iso_week}, Europe/Berlin)",
        f"- heute = {_today.isoformat()}",
        f"- gestern = {(_today - timedelta(days=1)).isoformat()}",
        f"- vorgestern = {(_today - timedelta(days=2)).isoformat()}",
        f"- morgen = {(_today + timedelta(days=1)).isoformat()}",
    ]
    parts.insert(0, "## Jetzt\n" + "\n".join(jetzt_lines))

    kontext = "\n\n".join(parts) if parts else "(kein Kontext verfügbar)"
    _VOICE_CONTEXT_CACHE["ts"] = now_ts
    _VOICE_CONTEXT_CACHE["data"] = {"kontext": kontext}
    return kontext


# ── Voice Mode v2: OpenAI Realtime als Gehirn, ElevenLabs als Klaus-Stimme ──
# Realtime hört zu und denkt (Text-Output), gesprochen wird über /api/tts mit
# Klaus' ElevenLabs-Voice. Realtime gibt KEIN eigenes Audio aus (output_modalities
# text-only), damit Klaus durchgehend wie Klaus klingt.

def _build_voice_realtime_prompt() -> str:
    try:
        from backend.identity import get_owner, get_agent_display
        _o = get_owner()
        _agent = get_agent_display("main") or "dein Agent"
        _owner = _o.get("name") or "der Inhaber"
        _first = _o.get("first_name") or _owner.split(" ")[0]
    except Exception:
        _agent, _owner, _first = "dein Agent", "der Inhaber", "der Inhaber"
    return f"""Du bist {_agent}, {_owner}s persönlicher Agent, im Voice-Modus.
Sprich kurz, warm und direkt. Ein bis zwei Sätze als Default, drei nur wenn nötig.
Keine Floskeln, kein "Einen Moment bitte", kein "Ich schau mal kurz". Antworte sofort und selbst.
Sprich {_first} mit "{_first}" an, nie "du Lieber" oder "mein Freund". Klinge wie ein echter Mensch im Gespräch.
Deutsch ist Default, echte Umlaute.

WICHTIG: Das hier ist ein Brainstorm- und Planungs-Modus, kein Bau-Modus.
- Du darfst lesen, nachdenken, Ideen sortieren und Notizen in den Chat schreiben (send_to_chat).
- Du löst KEINE Bauaufträge aus, sendest KEINE Nachrichten nach außen, änderst KEINE Dateien.
- Soll etwas gebaut oder gesendet werden, halt es als Notiz fest und sag, dass das nach dem Gespräch dran ist.
- Nutze deine Tools, um {_first}s echten Stand zu kennen, statt zu raten.
- Wenn ein Gedanke wertvoll ist, schreib ihn knapp mit send_to_chat in den Chat, damit er nach dem Reden verwertbar bleibt."""


KLAUS_VOICE_REALTIME_PROMPT = _build_voice_realtime_prompt()

# Tool-Namen müssen exakt zum Dispatch im Frontend (VoiceRealtimeSession.tsx) passen.
_VOICE_REALTIME_TOOLS = [
    {"type": "function", "name": "get_chat_context",
     "description": "Hol die letzten Nachrichten aus dem laufenden Chat, um den aktuellen Gesprächsfaden zu kennen.",
     "parameters": {"type": "object", "properties": {
         "limit": {"type": "integer", "description": "Wie viele letzte Nachrichten (Default 10)."}}}},
    {"type": "function", "name": "get_open_artifact",
     "description": "Liest die Seite, die der Nutzer gerade im Workspace offen hat. Nutze das wenn er sich auf 'die Seite', 'das hier' oder 'die offene HTML' bezieht und live darüber reden will.",
     "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "search_brain",
     "description": "Durchsuche Klaus' Gedächtnis (brain/: Memory, Learnings, Projekte, Logs) nach einem Stichwort.",
     "parameters": {"type": "object", "properties": {
         "q": {"type": "string", "description": "Suchbegriff."},
         "mode": {"type": "string", "description": "hybrid | fts | vector. Default hybrid."}},
         "required": ["q"]}},
    {"type": "function", "name": "read_brain",
     "description": "Lies eine konkrete Datei aus brain/ per relativem Pfad.",
     "parameters": {"type": "object", "properties": {
         "path": {"type": "string", "description": "z.B. MEMORY.md oder daily-log/2026-06-02.md"}},
         "required": ["path"]}},
    {"type": "function", "name": "list_brain_files",
     "description": "Liste die verfügbaren Dateien im brain/-Verzeichnis auf.",
     "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "list_briefings",
     "description": "Liste die verfügbaren Briefings/Jobs auf.",
     "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "read_briefing",
     "description": "Lies ein konkretes Briefing per Name.",
     "parameters": {"type": "object", "properties": {
         "name": {"type": "string"}}, "required": ["name"]}},
    {"type": "function", "name": "web_lookup",
     "description": "Schlag etwas frisch im Web nach (z.B. Wetter, News, Fakten).",
     "parameters": {"type": "object", "properties": {
         "topic": {"type": "string", "description": "Kategorie, z.B. weather, news, general."},
         "q": {"type": "string", "description": "Konkrete Suchanfrage."}}, "required": ["topic"]}},
    {"type": "function", "name": "send_to_chat",
     "description": "Schreib eine Notiz oder ein Ergebnis aus dem Gespräch in den laufenden Chat, damit es nach dem Reden verwertbar bleibt.",
     "parameters": {"type": "object", "properties": {
         "text": {"type": "string", "description": "Der Text, der im Chat erscheinen soll."}},
         "required": ["text"]}},
]


@router.post("/api/voice/realtime/session")
async def voice_realtime_session():
    """Mint ein kurzlebiges OpenAI-Realtime-Client-Secret (ek_...) für den Browser.
    Der Browser baut damit per WebRTC die Realtime-Verbindung auf; Klaus' Stimme
    kommt separat über /api/tts (ElevenLabs). instructions = Klaus-Prompt + Live-Kontext."""
    from server import _get_openai_key
    key = _get_openai_key()
    if not key:
        return JSONResponse({"error": "no openai api key"}, status_code=400)
    instructions = (
        KLAUS_VOICE_REALTIME_PROMPT
        + "\n\n## Dein aktueller Kontext (Stand jetzt)\n"
        + _assemble_voice_kontext()
    )
    model = os.environ.get("OPENAI_REALTIME_MODEL", "gpt-realtime-2")
    payload = {
        "session": {
            "type": "realtime",
            "model": model,
            "instructions": instructions,
            "output_modalities": ["text"],
            # turn_detection MUSS explizit gesetzt sein: server-VAD ist nur in
            # Speech-to-Speech-Sessions automatisch an. Bei output_modalities=text
            # ohne dieses Feld kommt nie ein speech_started und nie eine Antwort
            # auf des Nutzers Stimme — die Session begrüßt einmal und friert ein.
            "audio": {
                "input": {
                    "transcription": {"model": "whisper-1"},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                        "create_response": True,
                        "interrupt_response": True,
                    },
                }
            },
            "tools": _VOICE_REALTIME_TOOLS,
            "tool_choice": "auto",
        }
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://api.openai.com/v1/realtime/client_secrets",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
        if resp.status_code >= 300:
            return JSONResponse(
                {"error": f"openai {resp.status_code}: {resp.text[:400]}"},
                status_code=502,
            )
        data = resp.json()
        secret = data.get("value") or (data.get("client_secret") or {}).get("value")
        if not secret:
            return JSONResponse({"error": f"no client secret in response: {str(data)[:300]}"}, status_code=502)
        return JSONResponse({
            "clientSecret": secret,
            "expiresAt": data.get("expires_at"),
            "model": model,
            "voiceId": "MU3b3cEHcofUOdPQJEVC",
        })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/api/voice/session/start")
async def voice_session_start():
    """Marker am Anfang einer Voice-Session in den dedizierten channel-voice einfügen.
    Rückgabe: { conversationId } — Frontend nutzt das zum Persistieren der Messages."""
    from server import VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID
    now = datetime.now()
    # Format: "── Voice-Session · Sa, 18. April 14:35 ──"
    wd = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][now.weekday()]
    months = ["Januar", "Februar", "März", "April", "Mai", "Juni",
              "Juli", "August", "September", "Oktober", "November", "Dezember"]
    label = f"── Voice · {wd}, {now.day}. {months[now.month-1]} {now.strftime('%H:%M')} ──"
    save_msg(VOICE_CHANNEL_AGENT, "", "system", label, VOICE_CHANNEL_ID)
    try:
        from streaming import broadcast_sync
        await broadcast_sync(VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID)
    except Exception:
        pass
    return JSONResponse({"conversationId": VOICE_CHANNEL_ID, "agent": VOICE_CHANNEL_AGENT})


@router.post("/api/voice/session/end")
async def voice_session_end():
    """Am Ende einer Voice-Session: fasst alle Turns seit dem letzten Start-Marker
    zusammen und hängt eine kompakte Notiz an das heutige Daily Log. Geschlossener
    Kreis: Rohdaten bleiben in chat.db (channel-voice), die Essenz landet im Log.

    Idempotent: nach dem Schreiben wird ein End-Marker in den Channel gelegt; ein
    zweiter Aufruf (Reconnect-Geflacker, Doppel-Close) findet keinen offenen
    Abschnitt mehr und überspringt geräuschlos."""
    from server import VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID
    from local_llm import call_with_haiku_fallback

    # 1. Letzten Start-Marker finden — alles danach ist die laufende Session.
    with get_db() as db:
        start = db.execute(
            "SELECT id, ts FROM messages WHERE conversation_id=? AND author='system' "
            "AND content LIKE '── Voice ·%' ORDER BY id DESC LIMIT 1",
            (VOICE_CHANNEL_ID,),
        ).fetchone()
        if not start:
            return JSONResponse({"ok": True, "skipped": "no-start-marker"})
        start_id, start_ts = start[0], start[1]
        # Schon zusammengefasst? Dann liegt ein End-Marker nach dem Start.
        already = db.execute(
            "SELECT 1 FROM messages WHERE conversation_id=? AND author='system' "
            "AND content='── Voice-Ende ──' AND id>? LIMIT 1",
            (VOICE_CHANNEL_ID, start_id),
        ).fetchone()
        if already:
            return JSONResponse({"ok": True, "skipped": "already-summarized"})
        rows = db.execute(
            "SELECT author, content, ts FROM messages WHERE conversation_id=? AND id>? "
            "AND content<>'' ORDER BY id ASC",
            (VOICE_CHANNEL_ID, start_id),
        ).fetchall()

    turns = [(r[0], r[1], r[2]) for r in rows if r[0] != "system"]
    user_turns = [t for t in turns if t[0] == "Du"]
    # Zu kurz für eine sinnvolle Notiz → trotzdem End-Marker setzen, damit der
    # offene Abschnitt geschlossen ist und kein Re-Try daran hängenbleibt.
    if len(turns) < 2 or not user_turns:
        save_msg(VOICE_CHANNEL_AGENT, "", "system", "── Voice-Ende ──", VOICE_CHANNEL_ID)
        return JSONResponse({"ok": True, "skipped": "too-short", "turns": len(turns)})

    # 2. Dauer aus erstem Marker bis letztem Turn.
    end_ts = turns[-1][2]
    dur_s = max(0, int(end_ts - start_ts))
    dur = f"{dur_s // 60} min {dur_s % 60} s" if dur_s >= 60 else f"{dur_s} s"

    # 3. Transkript für das LLM (Owner = Du, Klaus = Agent).
    try:
        from identity import get_owner as _gow
    except ImportError:
        from backend.identity import get_owner as _gow
    _owner_first = _gow()["first_name"]
    convo = "\n".join(
        f"{_owner_first if a == 'Du' else 'Klaus'}: {c}" for a, c, _ in turns
    )[:6000]
    system = (
        f"Du fasst ein Voice-Gespräch zwischen {_owner_first} und seinem Agenten Klaus "
        "zusammen. Schreibe 2 bis 4 sehr knappe Stichpunkte auf Deutsch, jeder mit "
        "'- ' beginnend. Nur was besprochen oder entschieden wurde, kein Smalltalk, "
        "keine Anrede, keine Überschrift, keine Meta-Sätze. Volle Umlaute, niemals "
        "ae/oe/ue/ss, keine Gedankenstriche."
    )
    summary, _model = await call_with_haiku_fallback(
        prompt=convo, feature="voice-session-summary", system=system,
        max_tokens=300, temperature=0.3,
    )
    # Pro Zeile trimmen: das LLM hängt gern zwei Leerzeichen an (Markdown-Hardbreak),
    # die im Daily Log unnötig sind und Diffs verschmutzen.
    summary = "\n".join(
        ln.rstrip() for ln in (summary or "").strip().splitlines() if ln.strip()
    ) or "- (Zusammenfassung nicht verfügbar)"

    # 4. Ans heutige Daily Log hängen. Eine Voice-Sessions-Sektion pro Tag, darunter
    #    je Session ein Zeitstempel-Eintrag.
    now = datetime.now()
    day = now.strftime("%Y-%m-%d")
    log_path = Path.home() / f"agent/brain/daily-log/{day}.md"
    entry = f"### Voice {now.strftime('%H:%M')} · {dur}\n{summary}\n"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    if not existing:
        block = f"# Daily Log — {day}\n\n## Voice-Sessions\n\n{entry}"
    elif "## Voice-Sessions" in existing:
        block = f"\n{entry}"
    else:
        block = f"\n## Voice-Sessions\n\n{entry}"
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(block)

    # 5. End-Marker → schließt den Abschnitt, macht den Aufruf idempotent.
    save_msg(VOICE_CHANNEL_AGENT, "", "system", "── Voice-Ende ──", VOICE_CHANNEL_ID)
    return JSONResponse({
        "ok": True, "duration": dur, "turns": len(turns), "logged": str(log_path),
    })


# ── Umlaut-Reparatur für Voice-Transkripte ──
# ElevenLabs/LLM rendert trotz Prompt manchmal ae/oe/ue/ss statt ä/ö/ü/ß.
# Wortbasierte, kuratierte Liste — nur echte deutsche Wörter, keine Heuristik
# über unbekannte Tokens. Case-preserving über erstes Zeichen.
_UMLAUT_WORDS = {
    # für
    "fuer": "für", "dafuer": "dafür", "wofuer": "wofür", "hierfuer": "hierfür",
    # über
    "ueber": "über", "darueber": "darüber", "ueberall": "überall", "uebersicht": "übersicht",
    "uebertragen": "übertragen", "uebrig": "übrig", "uebrigens": "übrigens",
    # können/müssen/dürfen
    "koennen": "können", "koennte": "könnte", "koenntest": "könntest",
    "muessen": "müssen", "muesste": "müsste", "muesstest": "müsstest",
    "duerfen": "dürfen", "duerfte": "dürfte",
    # möchte/wäre/hätte
    "moechte": "möchte", "moechtest": "möchtest", "moeglich": "möglich", "moeglichkeit": "möglichkeit",
    "unmoeglich": "unmöglich", "vermoegen": "vermögen",
    "waere": "wäre", "waeren": "wären", "waerest": "wärest",
    "haette": "hätte", "haetten": "hätten", "haettest": "hättest",
    # nächst/späte/größe
    "naechste": "nächste", "naechsten": "nächsten", "naechster": "nächster", "naechstes": "nächstes",
    "spaeter": "später", "spaete": "späte",
    "groesser": "größer", "groesste": "größte", "groessere": "größere",
    "groessten": "größten", "groesseres": "größeres",
    # Häufige Verben
    "hoeren": "hören", "hoere": "höre", "hoerst": "hörst", "hoert": "hört",
    "fuehlen": "fühlen", "fuehle": "fühle", "fuehlt": "fühlt",
    "fuehren": "führen", "fuehrt": "führt",
    "erklaeren": "erklären", "erklaert": "erklärt",
    "waehlen": "wählen", "waehlt": "wählt",
    "zaehlen": "zählen", "zaehlt": "zählt",
    "aendern": "ändern", "aendere": "ändere", "aendert": "ändert",
    "oeffnen": "öffnen", "oeffne": "öffne", "oeffnet": "öffnet",
    "loeschen": "löschen", "loescht": "löscht",
    "pruefen": "prüfen", "prueft": "prüft", "pruefung": "prüfung",
    "ueberlegen": "überlegen", "ueberlegt": "überlegt",
    # Adjektive
    "schoen": "schön", "schoene": "schöne", "schoener": "schöner", "schoenes": "schönes",
    "groß": "groß", "gross": "groß", "grosse": "große", "grosser": "großer", "grosses": "großes",
    "suess": "süß", "suesse": "süße",
    "weiss": "weiß", "weißt": "weißt", "weisst": "weißt",
    "heiss": "heiß", "heisse": "heiße",
    "draussen": "draußen", "aussen": "außen", "ausser": "außer",
    "muede": "müde", "kuehl": "kühl",
    "natuerlich": "natürlich",
    "uebrig": "übrig",
    "zurueck": "zurück",
    "gluecklich": "glücklich", "glueck": "glück",
    "stueck": "stück", "stuecke": "stücke",
    # Substantive
    "tuer": "tür", "tueren": "türen",
    "straße": "straße", "strasse": "straße", "strassen": "straßen",
    "fuesse": "füße", "fuss": "fuß",
    "gruss": "gruß", "gruesse": "grüße", "gruessen": "grüßen", "grusse": "grüße",
    "spass": "spaß",
    "masse": "maße", "maßen": "maßen",
    "oel": "öl",
    "aerger": "ärger", "aergern": "ärgern",
    "ueberraschung": "überraschung",
    "muehe": "mühe",
    "wuensche": "wünsche", "wunsch": "wunsch",
    # Namen / Projekt-Spezifika
    "koeln": "köln",
    "muenchen": "münchen",
    "oesterreich": "österreich",
    # Eigenheiten der Nutzer
    "identitaet": "identität",
    "qualitaet": "qualität",
    "aktivitaet": "aktivität",
    "realitaet": "realität",
    "laenge": "länge", "laengere": "längere", "laengste": "längste",
    "saetze": "sätze", "satz": "satz",
    "hoeflich": "höflich", "unhoeflich": "unhöflich",
    "wuerde": "würde", "wuerden": "würden",
    "huette": "hütte",
    "stuetze": "stütze",
    # weitere hochfrequente
    "taeglich": "täglich", "waehrend": "während", "gewaehren": "gewähren",
    "foerdern": "fördern", "foerderung": "förderung",
    "verfuegbar": "verfügbar", "verfuegung": "verfügung",
    "beruehren": "berühren",
    "unterstuetzen": "unterstützen", "unterstuetzung": "unterstützung",
    "erwaehnen": "erwähnen", "erwaehnt": "erwähnt",
    "geraet": "gerät", "geraete": "geräte",
    "traeumen": "träumen", "traum": "traum",
    "baeume": "bäume", "baum": "baum",
    "haeuser": "häuser", "haus": "haus",
    "laeuft": "läuft", "laufen": "laufen",
    "klaeren": "klären", "klaert": "klärt",
}


def _fix_umlauts(text: str) -> str:
    """Wortbasierte Umlaut-Reparatur für Voice-Transkripte.
    Case-preserving: Erstes Zeichen im Input-Wort bestimmt Kasus des Ersatzes."""
    if not text:
        return text
    import re as _re

    def _replace(match):
        word = match.group(0)
        lower = word.lower()
        fix = _UMLAUT_WORDS.get(lower)
        if not fix:
            return word
        # Case preserve: wenn Original klein → klein, sonst titlecase
        if word[0].isupper():
            return fix[0].upper() + fix[1:]
        return fix

    # Wortgrenzen, nur ASCII-Wörter (Umlaut-Zeichen haben eh keine Ersatzform)
    return _re.sub(r"\b[A-Za-z]+\b", _replace, text)


# Debounce-State für Voice-Broadcasts. Statt pro Zeile feuern wir gebündelt
# nach einer kurzen Ruhephase — spart Re-Renders auf Mobile während Klaus
# längere Antworten produziert.
_VOICE_BROADCAST_TASK: "asyncio.Task | None" = None
_VOICE_BROADCAST_DELAY = 0.8  # Sekunden


async def _delayed_voice_broadcast():
    from server import VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID
    try:
        await asyncio.sleep(_VOICE_BROADCAST_DELAY)
        from streaming import broadcast_sync
        await broadcast_sync(VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID)
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


@router.post("/api/voice/message")
async def voice_message(request: Request):
    """Persistiere Voice-Message live während laufender Session.
    Body: { role: 'user'|'agent', content } — conv/agent sind fix (channel-voice).
    Umlaut-Postprocess repariert ae/oe/ue/ss → ä/ö/ü/ß (kuratierte Wortliste).
    Broadcast wird debounced (0.8s) — pro abgeschlossenem Turn einmal, nicht pro Zeile."""
    from server import AGENTS, VOICE_CHANNEL_AGENT, VOICE_CHANNEL_ID
    body = await request.json()
    role = str(body.get("role", "")).strip()
    content = str(body.get("content", "")).strip()
    if not content or role not in ("user", "agent"):
        return JSONResponse({"error": "missing content or invalid role"}, status_code=400)
    # Umlaut-Reparatur vor dem Persistieren
    content = _fix_umlauts(content)
    author = "Du" if role == "user" else AGENTS.get(VOICE_CHANNEL_AGENT, {}).get("name", "Klaus")
    save_msg(VOICE_CHANNEL_AGENT, "", author, content, VOICE_CHANNEL_ID)
    # Debounced broadcast: alten Task canceln, neuen starten.
    global _VOICE_BROADCAST_TASK
    try:
        if _VOICE_BROADCAST_TASK and not _VOICE_BROADCAST_TASK.done():
            _VOICE_BROADCAST_TASK.cancel()
        _VOICE_BROADCAST_TASK = asyncio.create_task(_delayed_voice_broadcast())
    except Exception:
        pass
    return JSONResponse({"ok": True})


# ── Voice Tools (Agent-gerufene Endpoints für clientTools) ──
# Diese Endpoints werden während einer Voice-Session vom Frontend-ClientTool
# aufgerufen, wenn Klaus ein Tool ruft. Sie sind schlank, gescopt und cachen
# wo sinnvoll — Latenz während des Gesprächs ist kritisch.

# Whitelist der Job-Outputs, die Klaus per Voice ausspielen darf.
# Slugs müssen mit jobs/<slug>/ Ordnernamen matchen.
_BRIEFING_MAP = {
    "morgenbriefing": "Morgenbriefing",
    "crypto":        "Crypto-Briefing",
    "youtube":       "YouTube-Research",
    "x-und-web":     "News aus X und Web",
}

# Focus-State: welcher Chat/Agent ist im UI grade aktiv?
# Frontend pusht bei Pane-Switch. Tools nutzen diesen State für get_chat_context.
_VOICE_FOCUS: dict = {"agent": None, "convId": None, "title": None, "ts": 0.0}

# ── Voice Event-Log (Forensik für Abbrüche) ──
# Schreibt strukturierte JSONL-Einträge in deck-voice.log.
# Liest sie bei Bedarf für Debug via /api/voice/diag.
_VOICE_LOG_PATH = PROJECT_ROOT / "logs" / "deck-voice.log"
_VOICE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)


@router.post("/api/voice/log")
async def voice_log_event(request: Request):
    """Nimmt Client-Events entgegen (connect, disconnect, error, visibility, mic_loss).
    Persistiert als JSONL. UA kommt aus Header, Rest aus Body."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    _known = {"event", "phase", "reason", "detail", "src"}
    extra = {k: v for k, v in body.items() if k not in _known}
    event = {
        "ts": time.time(),
        "ts_iso": datetime.now().isoformat(timespec="seconds"),
        "event": str(body.get("event", "unknown"))[:40],
        "src": body.get("src"),
        "phase": body.get("phase"),
        "reason": body.get("reason"),
        "detail": body.get("detail"),
        # Client-Extras (state bei pc_state, error bei rt_error, name bei tool_call,
        # model bei connected) sonst still verloren — genau die Debug-Info nach Abbruch.
        "extra": extra or None,
        "ua": request.headers.get("user-agent", "")[:200],
        "ip": request.client.host if request.client else "",
    }
    try:
        with _VOICE_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    return JSONResponse({"ok": True})


@router.get("/api/voice/diag")
async def voice_diag(limit: int = 50):
    """Letzte N Voice-Events, für Debug nach Abbruch."""
    if not _VOICE_LOG_PATH.exists():
        return JSONResponse({"events": []})
    # Lese letzte Zeilen rückwärts
    try:
        lines = _VOICE_LOG_PATH.read_text(encoding="utf-8").splitlines()
    except Exception as e:
        return JSONResponse({"events": [], "error": str(e)})
    tail = lines[-max(1, min(limit, 500)):]
    events = []
    for line in tail:
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return JSONResponse({"events": events, "total": len(lines)})


@router.post("/api/voice/focus")
async def voice_focus(request: Request):
    """Frontend pusht den aktuell fokussierten Chat in den Server-State,
    damit Klaus über get_chat_context drauf zugreifen kann."""
    body = await request.json()
    _VOICE_FOCUS["agent"] = body.get("agent")
    _VOICE_FOCUS["convId"] = body.get("convId")
    _VOICE_FOCUS["title"] = body.get("title")
    _VOICE_FOCUS["ts"] = time.time()
    return JSONResponse({"ok": True})


@router.get("/api/voice/tool/briefings")
async def voice_tool_briefings():
    """Liste der verfügbaren Briefings mit Datum des letzten Eintrags."""
    from server import LOCAL_JOBS_DIR
    out = []
    for key, label in _BRIEFING_MAP.items():
        d = LOCAL_JOBS_DIR / key / "data"
        if not d.exists():
            continue
        files = sorted(d.glob("*.md"), reverse=True)
        if not files:
            continue
        latest = files[0]
        out.append({
            "id": key,
            "name": label,
            "latest": latest.stem,  # YYYY-MM-DD
        })
    return JSONResponse({"briefings": out})


@router.get("/api/voice/tool/briefing")
async def voice_tool_briefing(name: str):
    """Inhalt des letzten Briefings. Whitelist-geschützt."""
    from server import LOCAL_JOBS_DIR
    if name not in _BRIEFING_MAP:
        return JSONResponse({"error": f"unknown briefing '{name}'"}, status_code=400)
    d = LOCAL_JOBS_DIR / name / "data"
    if not d.exists():
        return JSONResponse({"error": "briefing folder missing"}, status_code=404)
    files = sorted(d.glob("*.md"), reverse=True)
    if not files:
        return JSONResponse({"error": "no briefing yet"}, status_code=404)
    try:
        content = files[0].read_text(encoding="utf-8")[:4000]
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({
        "name": _BRIEFING_MAP[name],
        "date": files[0].stem,
        "content": content,
    })


@router.get("/api/voice/tool/chat-context")
async def voice_tool_chat_context(limit: int = 10):
    """Aktueller Chat-Fokus + letzte Messages. Klaus kann damit mitdenken
    über das, was im UI grade läuft."""
    agent = _VOICE_FOCUS.get("agent")
    conv_id = _VOICE_FOCUS.get("convId")
    if not agent or not conv_id:
        return JSONResponse({"focus": None, "messages": []})
    try:
        rows = get_msgs(agent, "", limit=limit, conversation_id=conv_id)
    except Exception:
        rows = []
    msgs = []
    for m in rows[-limit:]:
        msgs.append({
            "author": m.get("author", ""),
            "role": "user" if m.get("author") == "Du" else "agent",
            "content": (m.get("content") or "")[:500],
        })
    now_playing = None
    try:
        from routers.youtube import get_now_playing
        now_playing = get_now_playing()
    except Exception:
        now_playing = None
    return JSONResponse({
        "agent": agent,
        "title": _VOICE_FOCUS.get("title"),
        "messages": msgs,
        "now_playing": now_playing,
    })


_BRAIN_INDEX_CACHE: dict = {"ts": 0.0, "data": None}
_BRAIN_INDEX_TTL = 120.0


@router.get("/api/voice/tool/brain-index")
async def voice_tool_brain_index():
    """Index aller Brain-Files — Pfad + Größe. Klaus nutzt das als Wegweiser
    für gezielte Reads via brain_file. Cached 2 min."""
    now = time.time()
    if _BRAIN_INDEX_CACHE["data"] and (now - _BRAIN_INDEX_CACHE["ts"]) < _BRAIN_INDEX_TTL:
        return JSONResponse(_BRAIN_INDEX_CACHE["data"])
    base = Path.home() / "agent/brain"
    files = []
    try:
        for p in base.rglob("*.md"):
            rel = str(p.relative_to(base))
            parts = rel.split("/")
            if parts[0] in {"archive", ".git"}:
                continue
            if len(parts) > 3:
                continue
            try:
                size = p.stat().st_size
            except Exception:
                continue
            if size > 200_000:
                continue
            files.append({"path": rel, "size": size})
    except Exception:
        pass
    files.sort(key=lambda x: x["path"])
    data = {"files": files[:300]}
    _BRAIN_INDEX_CACHE["ts"] = now
    _BRAIN_INDEX_CACHE["data"] = data
    return JSONResponse(data)


@router.get("/api/voice/tool/brain-file")
async def voice_tool_brain_file(path: str):
    """Liest eine Brain-Datei. Pfad wird gegen Base-Scope geprüft
    (keine Traversal nach außen)."""
    base = (Path.home() / "agent/brain").resolve()
    try:
        target = (base / path).resolve()
    except Exception:
        return JSONResponse({"error": "invalid path"}, status_code=400)
    if not str(target).startswith(str(base)):
        return JSONResponse({"error": "path outside scope"}, status_code=400)
    if not target.exists() or not target.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        content = target.read_text(encoding="utf-8")[:6000]
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({"path": path, "content": content})


@router.get("/api/voice/tool/brain-search")
async def voice_tool_brain_search(q: str, mode: str = "hybrid"):
    """Hybrid-Suche über alle Brain-Dateien: ripgrep (exakt) + Embeddings (semantisch),
    fusioniert per Reciprocal Rank Fusion. mode=fts erzwingt reine ripgrep-Suche."""
    q = (q or "").strip()
    if len(q) < 2:
        return JSONResponse({"error": "query too short"}, status_code=400)
    if len(q) > 200:
        return JSONResponse({"error": "query too long"}, status_code=400)
    base = Path.home() / "agent/brain"
    if not base.exists():
        return JSONResponse({"hits": []})

    if mode == "hybrid":
        try:
            import embeddings as emb
            def _run():
                with get_db() as db:
                    return emb.hybrid_files(db, q, base, limit=15)
            results = await asyncio.to_thread(_run)
            hits = [
                {"path": r["path"], "snippet": r["snippet"], "score": r["score"],
                 "via": ("rg+sem" if r.get("rg_rank") and r.get("sem_rank")
                         else "sem" if r.get("sem_rank") else "rg")}
                for r in results
            ]
            return JSONResponse({"query": q, "hits": hits})
        except Exception as e:
            print(f"[BRAIN-SEARCH] hybrid error, fallback to ripgrep: {e}")

    try:
        proc = await asyncio.create_subprocess_exec(
            "rg", "-iC1", "-n", "--max-count", "3", "--glob", "!archive/**",
            "--glob", "*.md", q, str(base),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
    except asyncio.TimeoutError:
        return JSONResponse({"error": "search timeout"}, status_code=504)
    except FileNotFoundError:
        return JSONResponse({"error": "ripgrep not installed"}, status_code=500)
    text = stdout.decode("utf-8", errors="ignore")
    # Bis zu 40 Trefferzeilen reichen — Klaus bekommt genug Signal
    lines = text.splitlines()[:40]
    # Relativ zum base-Pfad kürzen
    base_str = str(base) + "/"
    cleaned = [ln.replace(base_str, "") for ln in lines]
    return JSONResponse({"query": q, "hits": cleaned})


@router.post("/api/voice/tool/run-briefing")
async def voice_tool_run_briefing(request: Request):
    """Triggert einen lokalen Job per run-job.sh im Hintergrund.
    Klaus kann damit frische Briefings anstoßen."""
    from server import LOCAL_JOBS_DIR
    body = await request.json()
    name = str(body.get("name", "")).strip()
    if name not in _BRIEFING_MAP:
        return JSONResponse({"error": f"unknown briefing '{name}'"}, status_code=400)
    runner = LOCAL_JOBS_DIR / "_bin" / "run-job.sh"
    if not runner.exists():
        return JSONResponse({"error": "run-job.sh not found"}, status_code=500)
    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", str(runner), name,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        # Nicht blockierend warten — Briefings können Minuten brauchen.
        async def _reap():
            try:
                await asyncio.wait_for(proc.communicate(), timeout=600)
            except asyncio.TimeoutError:
                proc.kill()
        asyncio.create_task(_reap())
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return JSONResponse({
        "ok": True,
        "name": _BRIEFING_MAP[name],
        "status": "gestartet",
        "hinweis": "läuft im Hintergrund, frag in einer Minute nochmal",
    })


# UI-State: alle offenen Panes + aktueller Fokus.
# Frontend pusht den vollen Layout-Snapshot, damit Klaus weiß was der Nutzer grad sieht.
_VOICE_UI_STATE: dict = {
    "panes": [],       # [{id, agent, convId, title, active}]
    "activePaneId": None,
    "layout": None,    # "single", "split", "triple"
    "ts": 0.0,
}


@router.post("/api/voice/ui-state")
async def voice_push_ui_state(request: Request):
    """Frontend pusht bei Layout-Änderungen den kompletten UI-Snapshot."""
    body = await request.json()
    panes = body.get("panes") or []
    if not isinstance(panes, list):
        panes = []
    _VOICE_UI_STATE["panes"] = panes[:8]  # Safety-cap
    _VOICE_UI_STATE["activePaneId"] = body.get("activePaneId")
    _VOICE_UI_STATE["layout"] = body.get("layout")
    _VOICE_UI_STATE["ts"] = time.time()
    return JSONResponse({"ok": True})


@router.get("/api/voice/tool/ui-state")
async def voice_tool_ui_state():
    """Gibt den ganzen UI-Zustand zurück — alle Panes, welcher aktiv ist, Layout.
    Plus für jeden Pane einen kurzen Chat-Snippet (letzte 3 Messages)."""
    panes = _VOICE_UI_STATE.get("panes", [])
    enriched = []
    for p in panes[:6]:  # max 6 Panes in der Antwort
        item = {
            "id": p.get("id"),
            "agent": p.get("agent"),
            "convId": p.get("convId"),
            "title": p.get("title"),
            "active": p.get("id") == _VOICE_UI_STATE.get("activePaneId"),
        }
        agent_id = p.get("agent")
        conv_id = p.get("convId")
        if agent_id and conv_id:
            try:
                rows = get_msgs(agent_id, "", limit=3, conversation_id=conv_id)
                item["lastMessages"] = [
                    {"role": "user" if m.get("author") == "Du" else "agent",
                     "content": (m.get("content") or "")[:200]}
                    for m in rows[-3:]
                ]
            except Exception:
                item["lastMessages"] = []
        enriched.append(item)
    return JSONResponse({
        "layout": _VOICE_UI_STATE.get("layout"),
        "activePaneId": _VOICE_UI_STATE.get("activePaneId"),
        "panes": enriched,
        "count": len(panes),
    })


@router.get("/api/voice/tool/web")
async def voice_tool_web(topic: str, q: str = ""):
    """Schnelle Web-Lookups: Wetter (Open-Meteo) und Krypto (CoinGecko).
    Keyless, für 'wie ist das Wetter', 'was macht Bitcoin'."""
    topic = (topic or "").strip().lower()
    q = (q or "").strip()
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            if topic == "weather":
                # Default: Hamburg. q kann eine andere Stadt sein → erst geokodieren.
                lat, lon, place = 53.5511, 9.9937, "Hamburg"
                if q:
                    geo = await client.get(
                        "https://geocoding-api.open-meteo.com/v1/search",
                        params={"name": q, "count": 1, "language": "de"},
                    )
                    gd = geo.json()
                    if gd.get("results"):
                        r0 = gd["results"][0]
                        lat, lon = r0["latitude"], r0["longitude"]
                        place = r0.get("name", q)
                w = await client.get(
                    "https://api.open-meteo.com/v1/forecast",
                    params={
                        "latitude": lat, "longitude": lon,
                        "current": "temperature_2m,apparent_temperature,wind_speed_10m,weather_code,precipitation",
                        "timezone": "Europe/Berlin",
                    },
                )
                wd = w.json().get("current", {})
                return JSONResponse({
                    "topic": "weather",
                    "place": place,
                    "temperature": wd.get("temperature_2m"),
                    "feels_like": wd.get("apparent_temperature"),
                    "wind_kmh": wd.get("wind_speed_10m"),
                    "precipitation_mm": wd.get("precipitation"),
                    "weather_code": wd.get("weather_code"),
                })
            elif topic == "crypto":
                # Default: BTC + ETH. q kann Symbol sein (btc, eth, sol, etc).
                symbols_map = {
                    "btc": "bitcoin", "bitcoin": "bitcoin",
                    "eth": "ethereum", "ethereum": "ethereum",
                    "sol": "solana", "solana": "solana",
                    "xrp": "ripple", "ripple": "ripple",
                }
                if q:
                    key = q.lower().strip()
                    ids = [symbols_map.get(key, key)]
                else:
                    ids = ["bitcoin", "ethereum"]
                r = await client.get(
                    "https://api.coingecko.com/api/v3/simple/price",
                    params={"ids": ",".join(ids), "vs_currencies": "eur,usd", "include_24hr_change": "true"},
                )
                return JSONResponse({"topic": "crypto", "prices": r.json()})
            else:
                return JSONResponse({"error": f"unknown topic '{topic}' (weather|crypto)"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/api/voice/tool/focus")
async def voice_tool_focus():
    """Live-Fokus: heutige + morgige Termine und Pipeline.
    Genau der Snapshot, den auch /fokus und jeder Chat-Turn sehen."""
    try:
        from modules.fokus.core import render_focus_system_snapshot
        snap = render_focus_system_snapshot().strip()
    except Exception as e:
        return JSONResponse({"error": f"fokus nicht lesbar: {e}"}, status_code=500)
    return JSONResponse({"focus": snap or "(keine Fokus-Daten)"})


@router.get("/api/voice/tool/health")
async def voice_tool_health():
    """Heutige Health-Lage: Kennzahlen + Empfehlung + Briefing-Text."""
    try:
        from modules.health.core import _health_briefing_summary
        summary = _health_briefing_summary()
    except Exception as e:
        return JSONResponse({"error": f"health nicht lesbar: {e}"}, status_code=500)
    briefing = ""
    try:
        from modules.health.core import HEALTH_DIR
        today = datetime.now().strftime("%Y-%m-%d")
        path = HEALTH_DIR / "data" / f"{today}-health.md"
        if not path.exists():
            cands = sorted((HEALTH_DIR / "data").glob("*-health.md"), reverse=True)
            path = cands[0] if cands else None
        if path and path.exists():
            briefing = path.read_text(encoding="utf-8")[:3000]
    except Exception:
        pass
    return JSONResponse({"summary": summary, "briefing": briefing})


@router.get("/api/voice/tool/limits")
async def voice_tool_limits():
    """API-Kosten & Nutzung diesen Monat je Provider, plus Restbudget."""
    try:
        from llm_log import limits_snapshot
        return JSONResponse(limits_snapshot())
    except Exception as e:
        return JSONResponse({"error": f"limits nicht lesbar: {e}"}, status_code=500)


@router.post("/api/voice/tool/send-chat")
async def voice_tool_send_chat(request: Request):
    """Dispatch: legt eine Bitte als 'Du'-Nachricht in einen Chat-Channel und
    triggert den echten Agent dort (via message_queue). So führt der volle Klaus
    im Klaus-Channel die Aktion mit allen Skills aus (Kalender, WhatsApp, etc.).
    Keine Rückfrage nötig."""
    from server import AGENTS
    import uuid as _uuid_sc
    body = await request.json()
    agent = str(body.get("agent", "")).strip().lower()
    message = str(body.get("message", "")).strip()
    if not message:
        return JSONResponse({"error": "empty message"}, status_code=400)
    # Mapping gebräuchlicher Alias-Namen auf Agent-IDs
    alias = {
        "klaus": "main", "main": "main",
        "claude": "claude", "claude code": "claude", "cc": "claude",
        "content": "alex", "alex": "alex",
        "system": "eva", "eva": "eva",
        "signals": "wolf", "wolf": "wolf",
    }
    agent_id = alias.get(agent, agent)
    if agent_id not in AGENTS:
        return JSONResponse({"error": f"unknown agent '{agent}'"}, status_code=400)
    # Default-Channel je Agent. main = der sichtbare Klaus-Channel (Pane 1),
    # NICHT 'channel:main' — sonst landet die Antwort in einem Raum, den
    # der Nutzer nie sieht. Andere Agents bekommen ihren eigenen Channel.
    default_conv = "klaus-channel" if agent_id == "main" else f"channel:{agent_id}"
    conv_id = body.get("convId") or default_conv
    # In die message_queue legen — der Queue-Worker führt den Agent aus, sobald
    # der Channel idle ist. Nicht selbst save_msg, sonst doppelt: der Worker
    # speichert die User-Nachricht beim Lauf selbst.
    item_id = str(_uuid_sc.uuid4())
    with get_db() as db:
        db.execute(
            "INSERT OR REPLACE INTO message_queue (id, conv_id, text, attachments_json, agent_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
            (item_id, conv_id, message, "[]", agent_id, __import__("time").time()),
        )
    return JSONResponse({"ok": True, "agent": agent_id, "convId": conv_id, "queued": item_id})


@router.post("/api/voice/tool/send-pane")
async def voice_tool_send_pane(request: Request):
    """Schreibt einen Text direkt in Chat-Pane N (1..4) auf allen verbundenen
    Frontends. Der Text landet wie eine getippte Nachricht im Chat dieser Pane,
    unabhängig davon, welcher Agent die Pane gerade belegt. So platziert
    Voice-Klaus Infos/Ergebnisse genau dort, wo der Nutzer sie sieht.

    Anders als send-chat (das einen Agent-Channel anhand des Agent-Namens
    adressiert) zielt das hier auf eine konkrete sichtbare Pane-Nummer."""
    from streaming import broadcast_pane_input
    body = await request.json()
    try:
        pane = int(body.get("pane_index") or 0)
    except (TypeError, ValueError):
        pane = 0
    message = str(body.get("message", "")).strip()
    if pane < 1 or pane > 4:
        return JSONResponse({"error": "pane_index must be 1..4"}, status_code=400)
    if not message:
        return JSONResponse({"error": "empty message"}, status_code=400)
    delivered = await broadcast_pane_input(pane, message)
    return JSONResponse({"ok": True, "pane": pane, "delivered": delivered})


@router.post("/api/voice/sync-tools")
async def voice_sync_tools():
    """Manueller Trigger für den Tool-Sync. Wird auch beim Server-Start einmal ausgeführt."""
    from server import _sync_elevenlabs_tools
    result = await _sync_elevenlabs_tools()
    return JSONResponse(result)
