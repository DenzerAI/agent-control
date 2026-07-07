# Konnektoren Hermes und OpenClaw einzeln

Stand: 2026-07-07

## Ergebnis

Der generische Agentensystem-Template-Konnektor ist aus der Konnektoren-Ansicht entfernt. Hermes und OpenClaw erscheinen jetzt als zwei eigene Konnektor-Kacheln in derselben Systematik wie OpenAI, Claude, WhatsApp, Mail und die übrigen Dienste.

Beide Kacheln sind einzeln auswählbar und nutzen die bestehende Anbinden-/Speichern-Logik der Konnektoren. Es wurde keine echte externe Anbindung gebaut und kein Außen-Call ergänzt. Die Felder bleiben Platzhalter für Pfad, Endpoint oder Key.

## Geänderte Dateien

- `frontend/src/workspace/ConnectorsWorkspace.tsx`: Entfernt den Sammel-Konnektor `AgentSystemRegistry`, ergänzt Hermes und OpenClaw als normale `ConnectorItem`-Einträge, hängt Logos ein und passt die Feldbeschriftung für Engine-Konnektoren an.
- `frontend/src/index.css`: Entfernt CSS für den alten Sammel-Konnektor, stabilisiert die Formularspalten, setzt schmale Workspace-Breiten konsequent einspaltig und sorgt dafür, dass Button, Statuszeile und Kartenkopf nicht horizontal überlaufen.
- `frontend/public/connectors/hermes.svg`: Neues monochromes Hermes-Logo als theme-adaptives SVG.
- `work/artifacts/2026-07-07-connectors-dark.png`, `2026-07-07-connectors-light.png`, `2026-07-07-connectors-narrow.png`, `2026-07-07-connectors-narrow-hermes.png`: Verifikationsscreenshots.
- `work/artifacts/2026-07-07-konnektoren-hermes-openclaw.html` und diese Markdown-Datei: Abschlussbericht.

## Entscheidungen

Hermes und OpenClaw wurden nicht als Sondermodul gebaut, sondern bewusst in die bestehende Konnektor-Liste aufgenommen. Das hält die Bedienung gleich: Kachel öffnen, Zugang eintragen, speichern.

Die Statistik oben zählt jetzt nur die echten Agentensysteme Hermes und OpenClaw als `2`. Claude bleibt technisch eine Engine, ist aber kein Agentensystem in Christians Sinn für diesen Bereich.

OpenClaw nutzt das bereits vorhandene `frontend/public/openclaw.png`. Hermes bekam ein neues monochromes SVG, damit es sich wie OpenAI oder Anthropic sauber an Hell/Dunkel anpasst.

## Verifikation

`npm run build` im `frontend/` ist grün.

Playwright-Prüfung auf `http://127.0.0.1:4222/`:

- Dunkel, 1440 x 1000: Hermes vorhanden, OpenClaw vorhanden, kein Template-Konnektor, kein Horizontal-Overflow.
- Hell, 1440 x 1000: Hermes vorhanden, OpenClaw vorhanden, kein Template-Konnektor, kein Horizontal-Overflow.
- Schmal, 390 x 920: Hermes vorhanden, OpenClaw vorhanden, kein Template-Konnektor, kein Horizontal-Overflow.
- Zusatzprüfung schmal nach Scroll zu Hermes: Hermes und OpenClaw bleiben als eigene Karten sichtbar, keine horizontale Überbreite im Dokument oder Workspace-Body.

## Offen

Die echte Anbindung bleibt absichtlich offen. Das ist aktuell weiter ein UI-Template: Speichern nutzt die vorhandene Konnektoren-Mechanik, aber Hermes/OpenClaw starten noch nichts und laden noch keine Skills.

Das von Christian später genannte Skill-Modul ist ein eigener nächster Bauabschnitt. Dafür braucht es eine eigene kleine Architekturentscheidung, weil dort Skills gelesen, erklärt, gezählt und pro Agentensystem geladen werden sollen.

## Laien-Briefing

Wir haben aus einem unklaren Sammel-Kasten zwei normale Schalter gemacht: Hermes und OpenClaw stehen jetzt einzeln neben den anderen Zugängen.

Christian kann beide Systeme separat auswählen und vorbereiten, ohne dass sie in einem generischen Template versteckt sind.

Für Kunden kann Christian sagen: "Die Agentensysteme sind jetzt wie normale Konnektoren aufgebaut, einzeln sichtbar, einzeln anschließbar und sauber mobil bedienbar."
