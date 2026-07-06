"""Connector routes for external services and engine access."""

import re

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from db import list_connectors, upsert_connector

router = APIRouter()

SERVICE_TEMPLATES = [
    {
        "id": "openai",
        "kind": "service",
        "name": "OpenAI",
        "description": "API-Zugang für Modelle, Tools und Embeddings.",
    },
    {
        "id": "anthropic",
        "kind": "service",
        "name": "Anthropic",
        "description": "Claude-Modelle für Analyse, Text und Agentenläufe.",
    },
    {
        "id": "google_workspace",
        "kind": "service",
        "name": "Google / Workspace",
        "description": "Gmail, Kalender, Drive und Workspace-Daten.",
    },
    {
        "id": "microsoft",
        "kind": "service",
        "name": "Microsoft",
        "description": "Microsoft 365, Outlook, Graph und Teams-Zugänge.",
    },
    {
        "id": "slack",
        "kind": "service",
        "name": "Slack",
        "description": "Channels, Benachrichtigungen und Team-Kommandos.",
    },
    {
        "id": "elevenlabs",
        "kind": "service",
        "name": "ElevenLabs",
        "description": "Stimmen, TTS-Ausgabe und Voice-Experimente.",
    },
    {
        "id": "custom",
        "kind": "service",
        "name": "Eigener Dienst",
        "description": "Freier Platz für Kunden-APIs und Spezialzugänge.",
    },
    {
        "id": "engine_claude",
        "kind": "engine",
        "name": "Claude",
        "description": "Engine-Zugang für Claude-basierte Arbeitsläufe.",
    },
    {
        "id": "engine_codex_openai",
        "kind": "engine",
        "name": "Codex / OpenAI",
        "description": "Engine-Zugang für Codex und OpenAI-Modelle.",
    },
    {
        "id": "engine_local_models",
        "kind": "engine",
        "name": "Lokale Modelle",
        "description": "Lokale LLMs oder interne Modell-Endpunkte.",
    },
]

_SERVICE_IDS = {item["id"] for item in SERVICE_TEMPLATES}
_SERVICE_RE = re.compile(r"^[a-z0-9_:-]{2,64}$")


def _public_item(template: dict, saved: dict | None) -> dict:
    saved = saved or {}
    return {
        **template,
        "account_label": saved.get("account_label", ""),
        "credential_hint": saved.get("credential_hint", ""),
        "status": saved.get("status", "not_connected"),
        "updated_at": saved.get("updated_at", 0),
    }


@router.get("/api/connectors")
async def connectors_overview():
    saved = {row["service"]: row for row in list_connectors()}
    return JSONResponse({
        "items": [_public_item(template, saved.get(template["id"])) for template in SERVICE_TEMPLATES],
    })


@router.post("/api/connectors/{service}")
async def save_connector(service: str, payload: dict = Body(default_factory=dict)):
    service_id = str(service or "").strip()
    if service_id not in _SERVICE_IDS and not _SERVICE_RE.match(service_id):
        raise HTTPException(status_code=400, detail="invalid_service")
    result = upsert_connector(
        service_id,
        credential=str(payload.get("credential") or ""),
        account_label=str(payload.get("account_label") or ""),
    )
    return JSONResponse(result)
