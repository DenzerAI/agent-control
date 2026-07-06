# Workspace-Modul-Konvention

Stand: 2026-07-06

## Ergebnis

Der Workspace hat jetzt eine verbindliche Shell-Komponente. Die sichtbaren Hauptreiter Agent, Inbox, Wissen, Aufgaben, Konnektoren, Dateien und Artefakte nutzen denselben Header-Aufbau und denselben Inhaltsfluss. Zusätzlich wurden weitere vorhandene Workspace-Reiter wie Analytics, Chatagent, Ideen und Systemagent auf dieselbe Shell gezogen. Der alte Zustand, in dem jedes Modul sein eigenes Kopfstück und eigene Abstände mitgebracht hat, ist damit breit entfernt.

## Geändert

- `frontend/src/workspace/WorkspaceShell.tsx` neu angelegt als gemeinsame Layout-Wahrheit.
- `MODULE-GUIDE.md` neu angelegt. Darin steht, wie neue Workspace-Module angelegt werden: Shell nutzen, linksbündiger Hero, Inhalte untereinander, nie dreispaltig, Claude-Coral über `--cc-orange`.
- `AgentWorkspace.tsx`, `InboxWorkspace.tsx`, `CompanyMemoryWorkspace.tsx`, `AutomationWorkspace.tsx`, `ConnectorsWorkspace.tsx`, `WorkspaceHome.tsx`, `ArtifactsWorkspace.tsx`, `AnalyticsWorkspace.tsx`, `ChatagentWorkspace.tsx`, `IdeasWorkspace.tsx` und `SystemagentWorkspace.tsx` auf `WorkspaceShell` gezogen.
- `WorkspaceNav.tsx` vereinheitlicht: alle Nav-Icons sind 18 x 18 px mit `strokeWidth={1.75}`. Wissen nutzt jetzt ein Buch-Icon, Konnektoren ein Cable-Icon, Artefakte ein ruhigeres Library-Icon.
- Verbindungstext entfernt. Unten links sitzt jetzt nur noch ein kleiner Punkt, neutral im Normalzustand und rot pulsierend bei Verbindungsverlust.
- `WorkspaceOverlay.tsx` erweitert: unten in der Rail sitzt ein schlichter Hell/Dunkel-Toggle. Der Toggle liest beim Klick den echten DOM-Zustand und schaltet robust.
- `ConnectorsWorkspace.tsx` erweitert um Telegram, SMS, WhatsApp, Eigener Dienst und Custom Messenger. Alle Connector-Icons laufen durch dieselbe 24 x 24 px Icon-Box.
- Lokale Connector-Assets unter `frontend/public/connectors/` ergänzt. OpenAI, Google, Microsoft, Slack, Anthropic, ElevenLabs, Telegram und WhatsApp sind als lokale SVGs vorhanden. SMS und Custom Messenger nutzen neutrale Lucide-Icons in derselben Box.
- `ArtifactsWorkspace.tsx` und `InboxWorkspace.tsx` nutzen die schlanke Suchleiste `workspace-search-slim`.
- `AutomationWorkspace.tsx` enthält jetzt die Demo-Aufgaben `WhatsApp beantworten`, `Firmengedächtnis-Interview` und `Termine erinnern`.
- `frontend/src/index.css` erweitert um Shell-, Search-, Connector-, Theme- und Connection-Dot-Regeln.

## Verifikation

`npm run build` läuft fehlerfrei.

Visuelle Prüfung mit Playwright:

- Mehrere Reiter nacheinander geprüft: Agent, Inbox, Artefakte, Konnektoren, Wissen.
- Shell-Header war sichtbar und der alte `workspace-system-hero` war in den geprüften Reitern nicht mehr vorhanden.
- Artefakt-Suche ist kein lauter Panel-Kasten mehr.
- Konnektoren sind leiser, Eingaben sind nur noch dünne Linien, Telegram und WhatsApp sind vorhanden.
- Nav-Icons sind einheitlich 18 x 18 px, Stroke 1.75.
- Verbindungspunkt hat keinen Textinhalt mehr.
- Theme-Toggle schaltet sichtbar auf `data-theme="light"`.
- Connector-Icon-Boxen sind einheitlich 24 x 24 px.

Screenshots liegen in `work/artifacts/`:

- `2026-07-06-workspace-agent-dark.png`
- `2026-07-06-workspace-inbox-dark.png`
- `2026-07-06-workspace-artifacts-dark.png`
- `2026-07-06-workspace-connectors-dark.png`
- `2026-07-06-workspace-connectors-light.png`
- `2026-07-06-workspace-knowledge-light.png`
- `2026-07-06-workspace-connectors-messenger-dark.png`
- `2026-07-06-workspace-connectors-whatsapp-dark.png`

## Auffälligkeit

Port `4222` war bereits belegt und lieferte in der Prüfung nicht den neuen Shell-Stand. Der frische Vite-Prozess ist deshalb auf `4223` ausgewichen und dort wurde die visuelle Kontrolle gemacht. Nach einem Neustart des bestehenden `4222`-Servers sollte der neue Stand dort erscheinen.

## Offene Punkte

Die API-Calls für echte Konnektor- und Inbox-Daten laufen im isolierten Prüfstand teilweise auf Auth-Fehler. Das betrifft nicht die UI-Änderung selbst, sondern die lokale Prüf-Session ohne volle Backend-Auth.
