# Header-Logik vereinheitlicht

Stand: 2026-07-06

## Kurzfassung

Die Workspace-Reiter Inbox, Wissen, Aufgaben, Konnektoren, Dateien, Artefakte und Agent haben jetzt dieselbe Hero-Logik oben. Die bereits passenden Reiter Wissen, Aufgaben und Konnektoren blieben die Referenz. Inbox, Dateien, Artefakte und Agent wurden auf dieselbe Struktur umgestellt.

Der alte Dateibaum-Workspace mit Fileviewer-Rahmen ist aus dem Dateien-Reiter raus. Stattdessen steht dort eine ruhige Demo-Struktur mit `soul/`, `brain/`, `work/`, `skills/`, `config/`, `backend/` und `frontend/`, alles untereinander und ohne alten Workspace-Kopf.

Der frühere Verbindungsbalken in der Chatfläche ist entfernt. Der WebSocket-Status wird jetzt über ein globales Browser-Event an die linke Workspace-Navigation gemeldet und dort unten als dezenter Punkt angezeigt: grün bei Verbindung, rot pulsierend mit Text „Verbindung weg“ bei Abbruch.

## Geänderte Bereiche

- `frontend/src/workspace/InboxWorkspace.tsx`: Alter Kopf durch `workspace-system-hero` ersetzt, Statistik und Listen untereinander gestellt.
- `frontend/src/workspace/WorkspaceHome.tsx`: Live-Tree/Fileviewer-Optik aus der Hauptansicht entfernt, feste Demo-Ordnerstruktur aufgebaut.
- `frontend/src/workspace/ArtifactsWorkspace.tsx`: Einheitlicher Hero, hübschere Demo-Artefakte, Vollbild-Demo-Preview und Download-Button ergänzt.
- `frontend/src/workspace/AgentWorkspace.tsx`: Einheitlicher Hero, Statistik-Dashboard untereinander, Demo-Fallback bei nicht erreichbarer API.
- `frontend/src/workspace/WorkspaceNav.tsx`: Neuer Verbindungsstatus unten in der Nav.
- `frontend/src/components/ChatPane.tsx`: Oberer und mobiler „Verbindung unterbrochen“-Banner entfernt, Status per `deck:connectionStatus` ausgesendet.
- `frontend/src/index.css`: Polish für Hero-Buttons, Nav-Hit-Areas, Statuspunkt, Agent-Liste, Datei-Demo und Artefakt-Lightbox.

## Entscheidungen

Die gemeinsame optische Wahrheit bleibt `workspace-system-hero`, weil sie bereits von Wissen, Aufgaben und Konnektoren genutzt wurde. Ich habe keine zweite Header-Komponente erfunden, sondern die hinkenden Reiter auf die vorhandene Logik gebracht.

Die Dateien-Seite ist bewusst nur Demo. Der alte Tree war funktional, aber genau der störende Kasten. Für die aktuelle optische Einigung ist der feste Ordnerbaum besser, weil später die echte Verbindung sauber hinter dieselbe Oberfläche gelegt werden kann.

Die Agent-Seite zeigt Demo-Daten, wenn `/api/agent-detail` nicht erreichbar oder nicht autorisiert ist. Dadurch sieht die Oberfläche nicht kaputt aus, während die echte Datenverbindung später separat sauber angebunden werden kann.

## Kontrolle

- `curl -I http://127.0.0.1:4222` liefert HTTP 200.
- `npm run build` im Frontend läuft grün.
- Playwright-Screenshot-Prüfung lief grün: alle sieben Reiter in Hell und Dunkel haben oben `.workspace-system-hero`, kein Text „Verbindung unterbrochen“, kein alter „Klassischer Ordnerbaum“.
- Screenshots liegen unter `work/artifacts/screenshots-header-check/`.

## Screenshots

Erzeugt wurden je ein Hell- und Dunkel-Screenshot für:

- Inbox
- Wissen
- Aufgaben
- Konnektoren
- Dateien
- Artefakte
- Agent

Die Ergebnisdatei ist `work/artifacts/screenshots-header-check/result.json`.

## Offene Punkte

Die echte Funktion hinter Dateien, Artefakten und Agent-Daten ist bewusst nicht neu verbunden worden. Der Auftrag war Optik zuerst, Verbindung später.

Die Playwright-Prüfung brauchte lokal `@playwright/test` temporär in `node_modules`; keine Paketdatei wurde geändert.

