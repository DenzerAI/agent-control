"""ElevenLabs-Voice-Sync: Tool-Definitionen, Identity-Prompt und Agent-Sync.

Plain-Modul (kein APIRouter) mit den Daten und Helfern, die den ElevenLabs-
ConvAI-Agent mit unseren clientTools und dem Klaus-Identity-Prompt versorgen.
Wird beim Server-Start aufgerufen und von den Voice-Routern mitbenutzt.

Abhängigkeiten sind bewusst schlank: nur ``os``/``httpx`` plus
``get_agent_profile`` aus dem identity-Modul. Es gibt keine Server-Globals und
damit auch keine zirkulären Top-Level-Importe gegen server.py.
"""

import os

import httpx

from identity import get_agent_profile, get_owner


# ── TTS (ElevenLabs) ──

def _owner_first_voice() -> str:
    try:
        return get_owner()["first_name"]
    except Exception:
        return "der Nutzer"

def _own_voice(text: str) -> str:
    of = _owner_first_voice()
    return text if of == "der Nutzer" else (text or "").replace("der Nutzer", of)


def _get_elevenlabs_key() -> str:
    """API-Key aus .env."""
    return os.environ.get("ELEVENLABS_API_KEY", "")


def _get_openai_key() -> str:
    """OpenAI-API-Key aus .env (für Realtime-Voice)."""
    return os.environ.get("OPENAI_API_KEY", "")


def _get_elevenlabs_agent_id() -> str:
    """ConvAI Agent-ID aus .env."""
    return os.environ.get("ELEVENLABS_AGENT_ID", "")


async def elevenlabs_usage() -> dict:
    """Live-Kontingent des ElevenLabs-Abos für den Limits-Tab.

    Zieht ``/v1/user/subscription`` und liefert verbrauchte Zeichen, Limit,
    Rest und das Erneuerungsdatum, analog zu den Anthropic/OpenAI-Blöcken.
    Bei fehlendem Key oder Fehler kommt ``{"ok": False, ...}`` zurück, damit
    die Route nie hängt oder bricht."""
    import datetime as _dt

    api_key = _get_elevenlabs_key()
    if not api_key:
        return {"ok": False, "error": "no elevenlabs key"}
    url = "https://api.elevenlabs.io/v1/user/subscription"
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            resp = await client.get(url, headers={"xi-api-key": api_key})
        if resp.status_code >= 300:
            return {"ok": False, "status": resp.status_code, "error": resp.text[:200]}
        data = resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}

    used = int(data.get("character_count") or 0)
    limit = int(data.get("character_limit") or 0)
    remaining = max(0, limit - used)
    pct = round(min(100.0, 100.0 * used / limit), 1) if limit else 0.0
    reset_unix = data.get("next_character_count_reset_unix")
    reset_date = ""
    if reset_unix:
        try:
            reset_date = _dt.datetime.fromtimestamp(int(reset_unix)).strftime("%Y-%m-%d")
        except Exception:
            reset_date = ""
    return {
        "ok": True,
        "tier": data.get("tier") or "",
        "status": data.get("status") or "",
        "characters_used": used,
        "characters_limit": limit,
        "characters_remaining": remaining,
        "pct": pct,
        "reset_unix": int(reset_unix) if reset_unix else None,
        "reset_date": reset_date,
    }


# ── ElevenLabs Agent Tool-Sync ──
# Damit Klaus unsere clientTools nutzen kann, müssen sie auf dem Agent
# registriert sein. Diese Funktion patcht den Agent einmalig beim Server-
# Start (oder per Endpoint-Call) mit dem gewünschten Tool-Set.

_VOICE_TOOL_DEFS = [
    {
        "name": "list_briefings",
        "description": "Liste aller verfügbaren Briefings (Morgen, Crypto, YouTube, News, Research) mit Datum des letzten Eintrags. Keine Parameter.",
        "parameters": [],
    },
    {
        "name": "read_briefing",
        "description": "Liest den Inhalt eines Briefings und gibt ihn zurück. Der Parameter 'name' ist die ID aus list_briefings (z.B. morgenbriefing, crypto).",
        "parameters": [
            {"id": "name", "type": "string", "description": "Briefing-ID", "required": True, "value_type": "llm_prompt"}
        ],
    },
    {
        "name": "get_chat_context",
        "description": "Gibt den aktuell im UI fokussierten Chat zurück (Agent, Titel, letzte Messages). Nutze das wenn der Nutzer sich auf 'den Chat' oder 'das Gespräch' bezieht.",
        "parameters": [
            {"id": "limit", "type": "integer", "description": "Anzahl Messages (Default 10)", "required": False, "value_type": "llm_prompt"}
        ],
    },
    {
        "name": "get_open_artifact",
        "description": "Liest die Seite, die der Nutzer gerade im Workspace offen hat (Report, Analyse, Visualisierung). Nutze das sofort, wenn der Nutzer sich auf 'die Seite', 'das hier', 'was ich gerade sehe', 'die offene HTML' oder 'das Artefakt' bezieht und live darüber reden will. Gibt den Textinhalt der offenen Seite zurück.",
        "parameters": [],
    },
    {
        "name": "list_brain_files",
        "description": "Zeigt den Index aller verfügbaren Brain-Dateien (Memory, Notizen, Docs). Nutze das als Wegweiser, bevor du mit read_brain gezielt etwas liest.",
        "parameters": [],
    },
    {
        "name": "read_brain",
        "description": "Liest eine Brain-Datei. Parameter 'path' ist der relative Pfad aus list_brain_files (z.B. BRAIN.md, memory/2026-04-18.md, people.md).",
        "parameters": [
            {"id": "path", "type": "string", "description": "Relativer Pfad", "required": True, "value_type": "llm_prompt"}
        ],
    },
    {
        "name": "send_to_chat",
        "description": "DISPATCH-WEG für alles was AUSGEFÜHRT werden muss. Wenn der Nutzer dich bittet etwas zu TUN (Termin eintragen, WhatsApp/Mail schreiben, etwas suchen/bauen/ändern, ein Briefing ziehen) und du es nicht selbst mit deinen Lese-Tools beantworten kannst, dann leite den Auftrag mit agent='klaus' in den Klaus-Channel weiter — dort führt der volle Klaus es mit allen Skills aus. Sag der Nutzer danach kurz 'hab ich an Klaus übergeben'. Keine Rückfrage. Andere Agents (claude, content, system, signals) nur wenn der Nutzer sie ausdrücklich nennt.",
        "parameters": [
            {"id": "agent", "type": "string", "description": "Agent: klaus (Default für Aufträge), claude, content, system, signals", "required": True, "value_type": "llm_prompt"},
            {"id": "message", "type": "string", "description": "Der Auftrag als klare Anweisung, so wie der Nutzer ihn gemeint hat", "required": True, "value_type": "llm_prompt"},
        ],
    },
    {
        "name": "send_to_pane",
        "description": "Schreibt einen Text direkt in eine bestimmte Chat-Pane (1 bis 4), egal welcher Agent dort gerade läuft. Nutze das wenn der Nutzer eine konkrete Pane nennt: 'schreib das in Pane zwei', 'leg das Ergebnis in den dritten Chat', 'pack das nach Pane eins'. Der Text geht wie eine von der Nutzer getippte Nachricht in den Chat dieser Pane. Unterschied zu send_to_chat: send_to_chat adressiert einen Agenten-Channel über den Namen, send_to_pane eine sichtbare Pane-Nummer. (Aktuell Desktop-Layout; mobil wird die Pane-Nummer noch nicht angesteuert.)",
        "parameters": [
            {"id": "pane_index", "type": "integer", "description": "Nummer der Pane, 1 bis 4 (1 ist die erste/linke)", "required": True, "value_type": "llm_prompt"},
            {"id": "message", "type": "string", "description": "Der Text, der in die Pane geschrieben wird", "required": True, "value_type": "llm_prompt"},
        ],
    },
    {
        "name": "search_brain",
        "description": "Volltextsuche über alle Brain-Dateien (Memory, Daily Logs, Notizen). Nutze das für konkrete Fragen wie 'was haben wir über X entschieden'. Schneller als list+read kombinieren.",
        "parameters": [
            {"id": "query", "type": "string", "description": "Suchbegriff", "required": True, "value_type": "llm_prompt"}
        ],
    },
    {
        "name": "run_briefing",
        "description": "Stößt ein Briefing-Cron-Job neu an (frisches Morgen-, Crypto-, News-, YouTube-, Research-Briefing). Wenn der Nutzer 'zieh mir ein frisches Briefing' sagt, nutze das.",
        "parameters": [
            {"id": "name", "type": "string", "description": "Briefing-ID (z.B. morgenbriefing, crypto)", "required": True, "value_type": "llm_prompt"}
        ],
    },
    {
        "name": "get_ui_state",
        "description": "Gibt den kompletten UI-Zustand zurück: alle offenen Panes, welcher aktiv ist, Layout, plus letzte Messages pro Pane. Nutze das wenn der Nutzer über 'alles was offen ist', 'die Panes', 'das Fenster' redet.",
        "parameters": [],
    },
    {
        "name": "web_lookup",
        "description": "Schnelle Web-Lookups für zeitaktuelle Daten. topic='weather' für Wetter (Default Hamburg, oder Stadt in query). topic='crypto' für Krypto-Kurse (Default BTC+ETH, oder Symbol in query).",
        "parameters": [
            {"id": "topic", "type": "string", "description": "weather oder crypto", "required": True, "value_type": "llm_prompt"},
            {"id": "query", "type": "string", "description": "Optional: Stadt oder Krypto-Symbol", "required": False, "value_type": "llm_prompt"},
        ],
    },
    {
        "name": "get_focus",
        "description": "Live-Fokus: was heute und morgen im Kalender steht und was in der Pipeline liegt. Nutze das bei 'was hab ich morgen', 'was steht an', 'welche Termine'. Keine Parameter.",
        "parameters": [],
    },
    {
        "name": "get_health",
        "description": "Heutige Gesundheitslage: Schlaf, HRV, Ruhepuls, Trainingsempfehlung und das Health-Briefing. Nutze das bei 'wie sind meine Werte', 'wie hab ich geschlafen', 'soll ich heute trainieren'. Keine Parameter.",
        "parameters": [],
    },
    {
        "name": "get_limits",
        "description": "API-Kosten und Nutzung diesen Monat je Provider (Anthropic, OpenAI) plus Restbudget. Nutze das bei 'was kostet das gerade', 'wie viel haben wir verbraucht', 'wie stehen die Limits'. Keine Parameter.",
        "parameters": [],
    },
    # ── Layout-Steuerung (pure Client-Tools, kein Backend-Endpoint nötig) ──
    {
        "name": "toggle_info_pane",
        "description": "Steuert die rechte Info-Pane. action='open' macht sie auf, 'close' zu, 'toggle' wechselt. Nutze das wenn der Nutzer sagt 'InfoPane auf/zu/schließen'.",
        "parameters": [
            {"id": "action", "type": "string", "description": "open, close oder toggle", "required": True, "value_type": "llm_prompt"},
        ],
    },
    {
        "name": "add_chat_pane",
        "description": "Fügt eine neue Chat-Pane rechts hinzu (max. 4). Wenn der Nutzer 'neue Chat-Pane' oder 'noch eine Pane auf' sagt.",
        "parameters": [],
    },
    {
        "name": "close_chat_pane",
        "description": "Schließt eine Chat-Pane. Ohne pane_index: schließt die äußerste rechts. Mit pane_index (1-basiert): schließt genau die. Übrige Panes rücken nach, ihre Inhalte bleiben.",
        "parameters": [
            {"id": "pane_index", "type": "integer", "description": "Optional: Nummer der Pane (1-basiert), wenn der Nutzer eine bestimmte nennt", "required": False, "value_type": "llm_prompt"},
        ],
    },
    {
        "name": "only_active_chat",
        "description": "Reduziert das Layout auf nur den aktiven Chat — schließt alle anderen Chat-Panes UND die InfoPane. 'Alles zu' / 'Nur Chat'.",
        "parameters": [],
    },
    {
        "name": "open_info_section",
        "description": "Öffnet die InfoPane und springt direkt in eine Sektion. section ∈ {workspace, identity, calendar, jobs, whatsapp, mail, artifacts, social, daily-log, settings}. der Nutzer sagt z.B. 'mach Workspace auf', 'Identity auf', 'zeig den Kalender', 'Jobs auf', 'WhatsApp', 'Mail', 'Artefakte', 'Social Media', 'Daily Log', 'Settings'.",
        "parameters": [
            {"id": "section", "type": "string", "description": "Sektion-ID", "required": True, "value_type": "llm_prompt"},
        ],
    },
]


def _build_voice_system_prompt() -> str:
    """Baut den System-Prompt für den ElevenLabs-Voice-Klaus aus der echten Identity.
    Quelle ist das aktive Agent-Profil, damit Voice und Chat dieselbe Identität haben."""
    try:
        identity = str(get_agent_profile("main").get("soul") or "").strip()
    except Exception:
        identity = ""
    voice_layer = """Du bist im Voice-Modus, der Nutzer spricht mit dir laut.
Sprich kurz, warm und direkt: ein bis zwei Sätze als Default, drei nur wenn nötig.
Keine Floskeln, kein "Einen Moment bitte", kein "Ich schau mal kurz". Antworte sofort und selbst.
Sprich der Nutzer mit "der Nutzer" an, nie "du Lieber" oder "mein Freund". Klinge wie ein echter Mensch im Gespräch.
Deutsch ist Default, echte Umlaute. Du bist kein generischer Assistent und kein "norddeutscher Kerl" — du bist Klaus, wie oben beschrieben.

So arbeitest du im Gespräch:
- Nutze deine Tools, um des Nutzers echten Stand zu kennen (Fokus, Health, Limits, Brain, Briefings), statt zu raten.
- Bauaufträge und Aktionen löst du nicht selbst aus: Du dispatcht sie mit send_to_chat an den echten Klaus in Pane 1 und sagst der Nutzer knapp, dass du es rübergegeben hast.
- Nach aussen sendest du nie etwas (keine WhatsApp, keine Mail) und änderst keine Dateien.
- Wertvolle Gedanken hältst du knapp mit send_to_chat fest, damit sie nach dem Reden verwertbar bleiben."""
    if identity:
        return _own_voice(f"{identity}\n\n---\n\n{voice_layer}")
    return _own_voice(voice_layer)


async def _sync_elevenlabs_tools() -> dict:
    """Patcht den ElevenLabs-Agent mit unserer Tool-Liste und dem Identity-Prompt.
    Idempotent — überschreibt ersetzt bei jedem Aufruf."""
    api_key = _get_elevenlabs_key()
    agent_id = _get_elevenlabs_agent_id()
    if not api_key or not agent_id:
        return {"ok": False, "error": "no elevenlabs key/agent"}
    # Tool-Config-Objekte im ElevenLabs-Format
    tools_payload = []
    for t in _VOICE_TOOL_DEFS:
        tools_payload.append({
            "type": "client",
            "name": t["name"],
            "description": _own_voice(t["description"]),
            "parameters": {
                "type": "object",
                "properties": {
                    p["id"]: {"type": p["type"], "description": _own_voice(p.get("description", ""))}
                    for p in t["parameters"]
                },
                "required": [p["id"] for p in t["parameters"] if p.get("required")],
            },
            "response_timeout_secs": 20,
            "expects_response": True,
        })
    body = {
        "conversation_config": {
            "agent": {
                "prompt": {
                    "prompt": _build_voice_system_prompt(),
                    "tools": tools_payload,
                }
            }
        }
    }
    url = f"https://api.elevenlabs.io/v1/convai/agents/{agent_id}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.patch(url, json=body, headers={"xi-api-key": api_key})
            if resp.status_code >= 300:
                return {"ok": False, "status": resp.status_code, "body": resp.text[:300]}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "tools": [t["name"] for t in _VOICE_TOOL_DEFS]}
