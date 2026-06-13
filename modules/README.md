# modules/ — Schubladen am Grundkasten

Modulare Erweiterungen zu Agent Control. Der **Grundkasten** (Chat, Composer, CLI-Bruecke, Voice, FS, Settings) bleibt immer drin. Alles andere ist eine **Schublade** in diesem Verzeichnis, die aktiviert oder deaktiviert werden kann.

## Struktur pro Modul

```
modules/<name>/
├── module.json     Manifest (Name, Beschreibung, Default an/aus, benoetigte ENV-Keys)
├── routes.py       FastAPI-Routen (optional)
├── service.py      Business-Logik (optional)
└── ui/             Frontend-Komponenten (optional, lazy-loaded)
```

## modules.json

Die Datei `modules.json` ist die zentrale Registry. Sie listet alle Module, die der Server beim Start aktivieren soll. Leeres `modules`-Array = Skelett-Modus, nichts wird geladen, das System verhaelt sich wie vor dem Umbau.

## Status

Skelett und Loader sind vorhanden. `backend/module_loader.py` liest `modules/modules.json` und bindet aktive Router-Module dynamisch ein. Provider-Module bleiben aktuell als Marker in der Registry, weil Teile des Kern-Codes sie noch direkt importieren.

## Setup-Profile

`config/setup-profiles.json` beschreibt wiederholbare Install-Profile:

- `core`: neutraler Grundkasten
- `client-basic`: Kundenstart mit People und Kalender
- `christian`: des Nutzers volle lokale Instanz

`scripts/agent-control-setup.py` schreibt daraus `config/agent-control.json` und `modules/modules.json`.

## Doctor

Der Setup-Doctor prüft ohne Server-Neustart, ob eine Instanz startklar ist:

```bash
python3 scripts/agent-control-setup.py --doctor --yes --profile client-basic --enable-module mail --enable-module whatsapp
bash scripts/install-agent-control.sh --doctor --profile=client-basic --enable-module=mail --enable-module=whatsapp
```

Wenn der Server erreichbar ist, werden die in `module.json` hinterlegten Health-Endpoints geprüft. `401` und `403` zählen dabei als Route vorhanden, weil Kundensysteme später mit Token laufen können.
