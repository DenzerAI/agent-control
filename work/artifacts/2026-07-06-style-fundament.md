# Style-Fundament festgeschrieben

Stand: 2026-07-06

## Ziel

Der Workspace sollte eine verbindliche Modul-Konvention bekommen, damit neue Reiter nicht mehr unterschiedlich aussehen. Zusätzlich sollten konkrete sichtbare Störungen behoben werden: ungleich wirkende Nav-Icons, zu laute Artefakte-Suche, zu schwere Konnektoren, fehlender Hell/Dunkel-Schalter unten in der linken Leiste und ein Verbindungshinweis, der nur noch ein Punkt sein soll.

## Geändert

- `frontend/src/workspace/MODULE_GUIDE.md` ist jetzt die verbindliche Modul-Doku direkt neben der Shell. Die frühere ungetrackte `docs/MODULE-GUIDE.md` wurde entfernt, damit es nicht zwei Wahrheiten gibt.
- `frontend/src/workspace/WorkspaceShell.tsx` ist die gemeinsame Layout-Komponente für Workspace-Module mit einheitlichem, linksbündigem Hero-Header.
- `AgentWorkspace`, `AnalyticsWorkspace`, `ArtifactsWorkspace`, `AutomationWorkspace`, `ChatagentWorkspace`, `CompanyMemoryWorkspace`, `ConnectorsWorkspace`, `IdeasWorkspace`, `InboxWorkspace`, `SystemagentWorkspace` und `WorkspaceHome` hängen an der gemeinsamen Shell oder waren bereits darauf vorbereitet und wurden in diesem Stand mitgezogen.
- `frontend/src/index.css` erzwingt die ruhige Shell-Optik, einspaltige Workspace-Flüsse, gleiche Nav-Icon-Größen, schlanke Such- und Connector-Felder, den Theme-Toggle unten und den reinen Verbindungspunkt.
- `frontend/src/workspace/WorkspaceNav.tsx` nutzt einheitliche `workspace-nav-icon`-Icons und gibt den Verbindungspunkt ohne Text aus.
- `frontend/src/workspace/WorkspaceOverlay.tsx` enthält den Theme-Toggle unten in der linken Werkzeugleiste neben Einklappen/Suche und Verbindungspunkt.
- `frontend/src/workspace/ArtifactsWorkspace.tsx` nutzt `WorkspaceShell`; die Suche ist auf `workspace-artifact-search` umgestellt und wird gegen Grid-Stretching geschützt.
- `frontend/src/workspace/ConnectorsWorkspace.tsx` nutzt `WorkspaceShell`, zeigt lokale Connector-Logos und enthält zusätzlich Telegram, SMS, WhatsApp und Custom Messenger als nicht verbundene Demo-Dienste.
- `frontend/public/connectors/*.svg` enthält lokale Icons/Platzhalter für OpenAI, Anthropic, Google, Microsoft, Slack, ElevenLabs, Telegram, WhatsApp, SMS und Custom Messenger.

## Entscheidungen

- Die Shell sitzt in `frontend/src/workspace`, nicht in einem entfernten `docs`-Bereich, weil neue Module dort entstehen und die Konvention im Code greifen muss.
- Die Workspace-Struktur bleibt bewusst einspaltig. Statistikstreifen und Modulbereiche werden untereinander gezeigt, nicht dreispaltig.
- Claude-Coral bleibt `#D97757` beziehungsweise `var(--cc-orange)` als Akzent. Es wurden keine zusätzlichen Signalfarben eingeführt.
- Für Dienstlogos wurden lokale SVGs hinterlegt. Wo ein offizielles Logo nicht sinnvoll oder nicht vorhanden war, wurde ein sauberer lokaler Platzhalter gleicher Größe genutzt.

## Verifikation

- `npm run build` im Frontend: erfolgreich.
- `curl -I http://127.0.0.1:4222/`: HTTP 200.
- Playwright-Selbstkontrolle:
  - Artefakte im Dunkelmodus geöffnet.
  - Konnektoren nach Theme-Toggle im Hellmodus geöffnet.
  - Nav-Icons geprüft: alle 20 x 20 px mit Stroke 1.75.
  - Artefakte-Suchzeile geprüft: 36 px hoch.
  - Verbindungspunkt geprüft: kein sichtbarer Text.
  - Neue Konnektoren geprüft: Telegram, SMS, WhatsApp und Custom Messenger vorhanden.
  - Connector-Felder geprüft: 40 px hoch.
- Screenshots:
  - `work/artifacts/2026-07-06-style-fundament-artifacts-dark.png`
  - `work/artifacts/2026-07-06-style-fundament-connectors-light.png`

## Risiken und offene Punkte

Die Screenshot-Kontrolle lief gegen den lokalen Vite-Server auf Port 4222. Einige Backend-Aufrufe antworteten im Screenshot-Kontext mit `unauthorized`, das ist für diesen UI-Lauf akzeptabel, weil der Auftrag keine externen Verbindungen oder echten Credentials ändern sollte. Die Demo-Daten und die UI-Zustände wurden trotzdem sichtbar und automatisiert geprüft.

Der Build meldet weiterhin die vorhandene Vite-Warnung zu großen Chunks. Das ist nicht neu durch diesen Style-Lauf und blockiert die Abnahme nicht.

## Laienbriefing

Gebaut wurde ein gemeinsames Form-Fundament für die Workspace-Reiter.

Das System kann neue Module jetzt deutlich konsistenter anzeigen, weil Header, Reihenfolge, Akzentfarbe, Icon-Größe und wichtige Bedienflächen an einer gemeinsamen Regel hängen.

Kundensatz: „Wir haben die Oberfläche nicht nur hübscher gemacht, sondern ihr feste Gestaltungsregeln gegeben, damit neue Funktionen automatisch in derselben ruhigen Linie entstehen.“
