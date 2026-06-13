"""Schubladen-Verteiler fuer Agent Control.

Liest beim Server-Start die Datei `modules/modules.json` und haengt fuer
jedes als `enabled: true` markierte Modul die FastAPI-Routen aus
`modules/<name>/routes.py` an die App. Wenn die Datei fehlt, leer ist
oder keine Module aktiviert sind, passiert nichts -- der Server
verhaelt sich wie vor dem Modular-Umbau.

Konvention pro Modul:

    modules/<name>/
    +-- module.json     Manifest (optional gelesen, hier nicht erzwungen)
    +-- routes.py       muss `router: APIRouter` exportieren
    +-- service.py      Business-Logik (optional, von routes.py importiert)

Defensive Loader-Logik: ein Modul-Fehler stoppt nie den Server, sondern
landet im stderr-Log und das Modul wird uebersprungen.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI

MODULES_DIR = Path(__file__).resolve().parent.parent / "modules"
MANIFEST = MODULES_DIR / "modules.json"


def _read_manifest() -> dict[str, Any]:
    if not MANIFEST.exists():
        return {"modules": []}
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[module_loader] modules.json kaputt, ueberspringe alles: {e}", file=sys.stderr)
        return {"modules": []}


def _load_one(name: str) -> Any | None:
    mod_dir = MODULES_DIR / name
    routes_file = mod_dir / "routes.py"
    if not routes_file.exists():
        print(f"[module_loader] {name}: routes.py fehlt", file=sys.stderr)
        return None
    spec = importlib.util.spec_from_file_location(f"modules.{name}.routes", routes_file)
    if spec is None or spec.loader is None:
        print(f"[module_loader] {name}: spec fehlgeschlagen", file=sys.stderr)
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    router = getattr(mod, "router", None)
    if router is None:
        print(f"[module_loader] {name}: kein 'router' in routes.py exportiert", file=sys.stderr)
        return None
    return router


def load_modules(app: FastAPI) -> list[str]:
    """Haengt alle aktivierten Module an die App. Gibt die Liste der
    erfolgreich geladenen Modul-Namen zurueck."""
    cfg = _read_manifest()
    loaded: list[str] = []
    for entry in cfg.get("modules", []) or []:
        if not isinstance(entry, dict):
            continue
        if not entry.get("enabled", False):
            continue
        name = entry.get("name") or ""
        if not name:
            continue
        # Provider-Module liefern keine HTTP-Routen, sondern werden direkt
        # vom Kern-Code importiert (z. B. mail_resend in backend/mail.py).
        # Der Eintrag hier ist nur Marker -- Loader-seitig skip.
        if entry.get("kind") == "provider":
            continue
        try:
            router = _load_one(name)
            if router is None:
                continue
            app.include_router(router)
            loaded.append(name)
            print(f"[module_loader] {name}: geladen", file=sys.stderr)
        except Exception as e:
            print(f"[module_loader] {name}: Fehler -- {e}", file=sys.stderr)
    return loaded
