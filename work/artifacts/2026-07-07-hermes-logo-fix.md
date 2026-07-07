# Hermes-Logo-Fix

Stand: 2026-07-07

## Ergebnis

Die Hermes-Kachel im Konnektoren-Workspace zeigt nicht mehr das Modehaus-Signet, sondern ein offizielles Hermes-Agent-Badge von Nous Research. Die Quelle ist die offizielle Hermes-Agent-Seite von Nous Research: `https://hermes-agent.nousresearch.com`, konkret das dort eingebundene Asset `/img/desktop/badge.webp`.

Es wurde kein Platzhalter verwendet. Das neue Asset liegt lokal unter `frontend/public/connectors/hermes-agent.webp` und wird von der Hermes-Kachel über `ConnectorsWorkspace.tsx` referenziert.

## Geändert

In `frontend/src/workspace/ConnectorsWorkspace.tsx` zeigt `LOGOS.hermes` jetzt auf `/connectors/hermes-agent.webp` statt auf `/connectors/hermes.svg`. Außerdem ist Hermes aus `MONOCHROME_LOGOS` entfernt, weil das neue Asset ein echtes Raster-Badge ist und nicht als monochrome Maske behandelt werden darf. Für Hermes gibt es nun `BADGE_LOGOS`, damit nur diese Kachel die Badge-Darstellung bekommt.

In `frontend/src/index.css` wurde `.connector-logo.is-badge img` ergänzt. Die Darstellung bleibt in der bestehenden 32-Pixel-Logo-Fläche, nutzt 25 x 25 Pixel, rundet das Badge leicht ab und setzt eine neutrale Outline. Dark Mode nutzt `rgba(255, 255, 255, 0.1)`, Light Mode nutzt `rgba(0, 0, 0, 0.1)`.

Neu hinzugefügt wurde `frontend/public/connectors/hermes-agent.webp`. Die alte Datei `frontend/public/connectors/hermes.svg` wurde nicht gelöscht, wird aber von der Hermes-Kachel nicht mehr verwendet.

## Nicht geändert

OpenAI, Anthropic, Google, Microsoft, Slack, ElevenLabs, Telegram, SMS, WhatsApp, OpenClaw und Custom Messenger blieben in ihrer Logo-Zuordnung unberührt. Auch die Konnektor-Logik, API-Anbindung und Speichern-Funktion wurden nicht angefasst.

## Verifikation

`npm run build` im Ordner `frontend/` läuft grün durch. Vite meldet weiterhin die bereits bekannte Chunk-Size-Warnung bei großen Bundles, aber keinen Build-Fehler.

Die visuelle Prüfung lief auf `http://127.0.0.1:4222` mit geöffnetem Workspace-Modus `connectors`. Die Hermes-Karte wurde in Dark und Light geprüft. DOM-Ergebnis: Hermes ist vorhanden, das Bild lädt von `/connectors/hermes-agent.webp`, ist vollständig geladen, hat `naturalWidth: 600`, `naturalHeight: 1200` und wird in der Kachel mit 25 x 25 Pixeln angezeigt.

Erzeugte Prüfbilder:

- `work/artifacts/2026-07-07-hermes-logo-dark.png`
- `work/artifacts/2026-07-07-hermes-logo-light.png`
- `work/artifacts/2026-07-07-hermes-logo-card-dark.png`
- `work/artifacts/2026-07-07-hermes-logo-card-light.png`

## Quellen

- Offizielle Hermes-Agent-Seite: `https://hermes-agent.nousresearch.com`
- Offizielles Projekt: `https://github.com/NousResearch/hermes-agent`
- Verwendetes Asset: `https://hermes-agent.nousresearch.com/img/desktop/badge.webp`

## Risiken und offene Punkte

Das Asset ist ein offizielles Raster-Badge, kein dediziertes kleines SVG-App-Icon. Für 32-Pixel-UI ist es deshalb leicht zugeschnitten, damit es erkennbar bleibt. Falls Nous Research später ein eigenes quadratisches Logo oder SVG veröffentlicht, wäre das die sauberere Langfrist-Quelle.
