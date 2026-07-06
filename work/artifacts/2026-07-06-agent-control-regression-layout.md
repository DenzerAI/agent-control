# Agent-Control-Live: Regressionen zurück, Layout bereinigt

Stand: 2026-07-06, Werkbank-Task `werk-chat-2026-07-06-ec7e8a`, Branch `werk/base-entkernen`.

## Ergebnis

Der Chat-Umbau aus `06d94ee` wurde gezielt korrigiert: Die entfernte Multi-Slot-Mechanik bleibt draußen, aber die fälschlich entfernten Chat-Header-Funktionen sind wieder sichtbar. Der Chat hat wieder die ruhige Trennlinie unter der oberen Chat-Leiste, die Engine-/Model-Auswahl hängt wieder am Header-Portal, und der Maximieren/Verkleinern-Button ist zurück.

Die Workspace-Navigation ist neu sortiert. Der frühere Nav-Eintrag `Chat`, der eigentlich die Agent-Statusseite geöffnet hat, heißt jetzt `Agent` und steht ganz unten. `Artefakte` ist als neuer Reiter in der Nav sichtbar.

Das Workspace-Layout ist randloser. Der generische `Workspace`-Titelkopf ist weg, Inhalte starten oben direkter und linksbündig, und die bisherigen Rahmen um Root-Workspaces wurden entfernt. Die geprüften Workspace-Reiter stapeln Inhalte untereinander statt sie dreispaltig zu verteilen.

## Geänderte Bereiche

- `frontend/src/App.tsx`: Header-Portal `chat-pane-controls-*` wiederhergestellt, Trenn-/Header-Funktionen reaktiviert, Fokusmodus für die eine Chat-Pane zurückgebracht, ohne Multi-Slot-Auswahl oder Pane-Pillen wieder einzubauen.
- `frontend/src/index.css`: obere Chat-Trennlinie wiederhergestellt, Workspace-Root-Rahmen entfernt, `workspace-system-*` auf gestapelte Layouts umgestellt, dreispaltige Hero-Grid-Definitionen entfernt.
- `frontend/src/workspace/WorkspaceNav.tsx`: `Artefakte` aufgenommen, `Agent` nach unten verschoben und korrekt benannt.
- `frontend/src/workspace/WorkspaceOverlay.tsx`: generischen Workspace-Titelkopf entfernt, Aufgaben-Reiter auf Demo-Aufgabenansicht geroutet.
- `frontend/src/workspace/ConnectorsWorkspace.tsx`: Demo-Konnektoren für OpenAI, Claude, Google/E-Mail, Microsoft, Slack, ElevenLabs und Eigener Dienst ergänzt, alle mit `nicht verbunden` und leerer Key-Eingabe.
- `frontend/src/workspace/WorkspaceHome.tsx`: klassischer Demo-Ordnerbaum sichtbar ergänzt, basierend auf Setup-/Repo-Struktur wie `soul/`, `config/`, `brain/`, `work/`, `skills/`, `backend/`, `frontend/`, `scripts/`.
- `frontend/src/workspace/CompanyMemoryWorkspace.tsx`: Wissen von dreispaltigen Karten auf eine untereinander stehende Demo-Liste umgestellt.
- `frontend/src/workspace/AutomationWorkspace.tsx`: Aufgaben-Demo-Liste und Freigabe-Hinweis ergänzt.
- `frontend/src/workspace/ArtifactsWorkspace.tsx`: Bibliotheksliste mit Demo-Fallback, Öffnen per Klick und Download-Link pro Artefakt ergänzt.
- `frontend/src/workspace/AgentWorkspace.tsx`: dreispaltige Statistikreihe auf ein gestapeltes beziehungsweise maximal zweispaltiges Layout umgestellt.

## Verifikation

`npm run build` läuft grün. Vite auf `http://127.0.0.1:4222` antwortet mit HTTP 200.

Die Screenshot-/DOM-Selbstkontrolle lief in Dark und Light. Geprüft wurden Chat, Konnektoren, Dateien, Wissen, Aufgaben, Artefakte und Agent. Ergebnis: Nav-Reihenfolge `Inbox | Wissen | Aufgaben | Konnektoren | Dateien | Artefakte | Agent`, Header-Controls vorhanden, alle geprüften Reiter ohne dreispaltige Grid-Treffer.

Screenshot-Ordner: `work/screenshots/2026-07-06-regression-layout/`

Erzeugte Screenshots:

- `chat-dark.png`, `chat-light.png`
- `connectors-dark.png`, `connectors-light.png`
- `files-dark.png`, `files-light.png`
- `knowledge-dark.png`, `knowledge-light.png`
- `tasks-dark.png`, `tasks-light.png`
- `artifacts-dark.png`, `artifacts-light.png`
- `agent-dark.png`, `agent-light.png`

Headless-Playwright meldete 401/403 für geschützte API/WebSocket-Endpunkte, weil der Browserlauf ohne eingeloggten Sitzungstoken lief. Das ist kein Frontend-Buildfehler; die sichtbare UI und die DOM-Prüfungen liefen trotzdem durch.

## Entscheidungen

Die entfernte Slot-Mechanik wurde nicht rekonstruiert. Wiederhergestellt wurde nur das Header-Ziel, an dem Composer/Engine-Controls per Portal hängen, plus der Pane-Fokusbutton. Damit bleibt die Zielarchitektur `eine Chat-Pane mit leichtem Wechsler` erhalten.

Für Dateien wurde eine Demo-Struktur ergänzt, ohne den echten Dateibrowser zu ersetzen. Die Demo erklärt die klassische Struktur, darunter bleibt die echte File-System-Ansicht nutzbar.

Für Artefakte wurde ein Demo-Fallback ergänzt, damit der Reiter sofort als Bibliothek wirkt, selbst wenn `/api/recent-entries` keine Daten liefert.

## Risiken und offen

Die Demo-Artefaktpfade sind Platzhalter, solange keine echten Dateien unter diesen Demo-Namen existieren. Sobald der Artefakte-Index echte Einträge liefert, ersetzt er den Demo-Fallback.

Die visuelle Prüfung lief headless ohne Auth-Token. Für echte API-Daten sollte Christian die Ansicht in seiner laufenden 4222-Session einmal mit bestehender Anmeldung ansehen.

Kein Backend wurde geändert, daher ist kein Server-Neustart nötig.
