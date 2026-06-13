"""Google Calendar Client.

Teilt sich den OAuth-Client mit finance-receipts (jobs/finance-receipts/config/credentials.json),
hält aber einen eigenen Token mit erweiterten Scopes unter data/google_token.json.

Setup-Flow (einmalig):
    python3 scripts/google-oauth-setup.py

Danach kann der Server lesen/schreiben:
    from google_calendar import GoogleCalendar
    gc = GoogleCalendar()
    gc.list_events(from_iso, to_iso)
    gc.create_event(title, start, end, description=...)
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from datetime import datetime
from typing import Optional

from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

AGENT_ROOT = Path(__file__).resolve().parents[3]
CREDENTIALS_FILE = AGENT_ROOT / "jobs" / "finance-receipts" / "config" / "credentials.json"
TOKEN_FILE = AGENT_ROOT / "data" / "google_token.json"
CALENDAR_ID_FILE = AGENT_ROOT / "data" / "google_calendar_id.txt"
CATEGORY_IDS_FILE = AGENT_ROOT / "data" / "google_calendar_ids.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar",
]

KLAUS_CALENDAR_NAME = "Klaus"

# Kalender, die der UI-Endpoint /api/calendar zusätzlich aus Google zieht.
# Klaus-Kalender selbst wird ausgelassen, weil lokale calendar_events die Quelle sind
# und nach Klaus gespiegelt werden (sonst Duplikate).
READ_CALENDAR_NAMES = [
    "Privat",
    "Beispielkunde",
    "FCH",
    "PT-Desk",
    "AI Workshop",
    "AI Agent",
    "AI Beratung",
]

# Categories, in die Klaus per POST schreiben kann (Mapping name → calendar-id wird live aufgelöst)
WRITABLE_CATEGORIES = [
    "klaus",
    "privat",
    "fch",
    "ai-workshop",
    "ai-agent",
    "ai-beratung",
    "gecko",
    "ptdesk",
]
CATEGORY_TO_CALENDAR_NAME = {
    "klaus": "Klaus",
    "privat": "Privat",
    "fch": "FCH",
    "ai-workshop": "AI Workshop",
    "ai-agent": "AI Agent",
    "ai-beratung": "AI Beratung",
    "gecko": "Beispielkunde",
    "ptdesk": "PT-Desk",
}


def has_credentials() -> bool:
    return False


def _load_credentials() -> Credentials:
    if not TOKEN_FILE.exists():
        raise FileNotFoundError(
            f"Kein Google-Token unter {TOKEN_FILE}. "
            f"Setup einmalig laufen lassen: python3 scripts/google-oauth-setup.py"
        )
    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
        TOKEN_FILE.write_text(creds.to_json())
        os.chmod(TOKEN_FILE, 0o600)
    return creds


class GoogleCalendar:
    def __init__(self) -> None:
        creds = _load_credentials()
        self.service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        self._calendar_id: Optional[str] = None

    def calendar_id(self) -> str:
        """Liefert die Klaus-Kalender-ID. Legt den Kalender beim ersten Aufruf an."""
        if self._calendar_id:
            return self._calendar_id
        if CALENDAR_ID_FILE.exists():
            cid = CALENDAR_ID_FILE.read_text().strip()
            if cid:
                self._calendar_id = cid
                return cid
        cals = self.service.calendarList().list().execute().get("items", [])
        for c in cals:
            if c.get("summary") == KLAUS_CALENDAR_NAME:
                self._calendar_id = c["id"]
                CALENDAR_ID_FILE.write_text(self._calendar_id)
                return self._calendar_id
        body = {"summary": KLAUS_CALENDAR_NAME, "timeZone": "Europe/Berlin"}
        created = self.service.calendars().insert(body=body).execute()
        self._calendar_id = created["id"]
        CALENDAR_ID_FILE.write_text(self._calendar_id)
        return self._calendar_id

    def list_calendars(self) -> list[dict]:
        items = self.service.calendarList().list().execute().get("items", [])
        return [{"id": c["id"], "summary": c.get("summary", ""), "primary": c.get("primary", False)} for c in items]

    def calendar_id_by_name(self, name: str) -> Optional[str]:
        """Sucht eine Calendar-ID per Anzeigenamen."""
        try:
            for c in self.list_calendars():
                if c.get("summary") == name:
                    return c["id"]
        except Exception:
            return None
        return None

    def resolve_category(self, category: str) -> Optional[str]:
        """Mappt eine Klaus-Kategorie ('ai-workshop' etc.) auf die Calendar-ID.
        Liest erst aus dem Cache google_calendar_ids.json, fällt sonst auf Live-Lookup zurück.
        """
        cat = (category or "").strip().lower()
        if not cat or cat == "klaus":
            return self.calendar_id()
        name = CATEGORY_TO_CALENDAR_NAME.get(cat)
        if not name:
            return None
        if CATEGORY_IDS_FILE.exists():
            try:
                data = json.loads(CATEGORY_IDS_FILE.read_text())
                if name in data:
                    return data[name]
            except Exception:
                pass
        return self.calendar_id_by_name(name)

    def list_events(self, time_min_iso: str, time_max_iso: str, calendar_id: Optional[str] = None) -> list[dict]:
        cid = calendar_id or self.calendar_id()
        resp = self.service.events().list(
            calendarId=cid,
            timeMin=time_min_iso,
            timeMax=time_max_iso,
            singleEvents=True,
            orderBy="startTime",
            maxResults=500,
        ).execute()
        return resp.get("items", [])

    def list_read_calendars(self) -> list[dict]:
        """Liefert die Kalender, aus denen /api/calendar Events ziehen soll
        (alle aus READ_CALENDAR_NAMES, sofern vorhanden)."""
        all_cals = self.list_calendars()
        by_name = {c["summary"]: c for c in all_cals}
        out: list[dict] = []
        for name in READ_CALENDAR_NAMES:
            if name in by_name:
                out.append(by_name[name])
        return out

    def create_event(self, title: str, start_iso: str, end_iso: str,
                     description: str = "", location: str = "",
                     calendar_id: Optional[str] = None) -> dict:
        cid = calendar_id or self.calendar_id()
        body = {
            "summary": title,
            "description": description,
            "location": location,
            "start": {"dateTime": start_iso, "timeZone": "Europe/Berlin"},
            "end": {"dateTime": end_iso, "timeZone": "Europe/Berlin"},
        }
        return self.service.events().insert(calendarId=cid, body=body).execute()

    def update_event(self, event_id: str, patch: dict, calendar_id: Optional[str] = None) -> dict:
        cid = calendar_id or self.calendar_id()
        return self.service.events().patch(calendarId=cid, eventId=event_id, body=patch).execute()

    def delete_event(self, event_id: str, calendar_id: Optional[str] = None) -> None:
        cid = calendar_id or self.calendar_id()
        self.service.events().delete(calendarId=cid, eventId=event_id).execute()
