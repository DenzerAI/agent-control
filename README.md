# Agent Control

Multi-Agent Dashboard — Chat-first, lokal, dein eigenes Personal-Agent-System.

Eine schwarze Leinwand, ein Chat, dein Agent. Backend: Codex, Claude oder ein anderes Engine-Profil. Memory, Skills, Jobs und ein InfoPane für Detailansichten. Läuft lokal auf deinem Mac, deine Daten bleiben bei dir.

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/DenzerAI/agent-control/main/install.sh | bash
```

Der Installer klont Agent Control nach `~/agent-control`, fragt Profil, Engine, Module und Agent-Identität ab, baut Backend und Frontend und kann die App danach direkt starten.

## Was du brauchst

- macOS (Apple Silicon empfohlen)
- Python 3.11+
- Node.js 18+
- Codex CLI, Claude Code oder ein anderes Engine-Profil
- API-Keys nur, wenn du eine API-Engine statt OAuth/CLI nutzt

## Architektur

```
backend/   FastAPI-Server
frontend/  React + Vite UI
modules/   Domain-Module (calendar, fokus, people, ...)
skills/    Wiederverwendbare Fähigkeiten
soul/      Deine Agent-Identität (gerendert aus Templates)
brain/     Dein Gedächtnis (du fütterst es)
jobs/      Geplante Tasks
data/      Lokale DBs
```

## Updates

Updates aus dem Public-Repo:

```bash
cd ~/agent-control
git pull
./setup.sh   # nur wenn Templates sich geändert haben
```

Deine `brain/`, `work/`, `jobs/`, `data/` und `.env` werden nie überschrieben.

## Status

Public-Skelett, frühe Phase. Erwartungen ehrlich: läuft auf einem Mac, ist kein Produkt mit Support-Team. Wer es nutzt, weiß was er tut.

## Lizenz

Noch offen.
