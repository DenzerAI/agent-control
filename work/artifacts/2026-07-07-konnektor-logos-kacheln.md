# Konnektor-Logos und Kacheln, Abschlussprotokoll

Stand: 2026-07-07, Werkbank-Task `werk-chat-2026-07-07-d7c7fa`, Repo `/Users/klaus/agent-control-live`, Branch `werk/agentensystem-konnektor-template`.

## Ergebnis

Die Konnektor-Übersicht auf Port 4222 ist bereinigt. OpenAI nutzt jetzt die richtige OpenAI-Glyphe, ElevenLabs hat ein echtes SVG-Logo, Hermes nutzt nicht mehr den alten Platzhalter. Die verwirrende Kachel `Eigener Dienst` wurde aus dem Demo-Katalog entfernt. Als letzte klare freie Kachel bleibt `Custom Messenger`.

Sichtbarer Stand der Kacheln:

OpenAI, Claude, Google / E-Mail, Microsoft, Slack, ElevenLabs, Telegram, SMS, WhatsApp, Hermes, OpenClaw, Custom Messenger.

Die letzten beiden Kacheln sind jetzt `OpenClaw` und `Custom Messenger`; direkt davor steht `Hermes`. Es gibt keine Kachel `Eigener Dienst` mehr.

## Geänderte Dateien

- `frontend/src/workspace/ConnectorsWorkspace.tsx`
- `frontend/public/connectors/openai.svg`
- `frontend/public/connectors/elevenlabs.svg`
- `frontend/public/connectors/hermes.svg`
- `work/artifacts/2026-07-07-konnektor-logos-kacheln.html`
- `work/artifacts/2026-07-07-konnektor-logos-kacheln.md`

Zusätzlich wurden Prüfscreenshots erzeugt:

- `work/artifacts/2026-07-07-connectors-dark.png`
- `work/artifacts/2026-07-07-connectors-light.png`
- `work/artifacts/2026-07-07-connectors-narrow.png`
- `work/artifacts/2026-07-07-connectors-bottom.png`

## Entscheidungen

OpenAI wurde durch die vorhandene offizielle Marken-Glyphe aus der denzer.ai Tool-Icon-Sammlung ersetzt. Die alte lokale SVG war eine grobe Nachzeichnung und deshalb optisch falsch.

ElevenLabs war als leere Datei vorhanden. Eingesetzt wurde die offizielle ElevenLabs-Glyphe aus der vorhandenen lokalen Logo-Sammlung.

Hermes hatte im Live-Repo nur den Platzhalter. Ein anderes internes Hermes-Asset lag weder im Live-Repo noch in den bekannten lokalen Brand-Assets. Eingesetzt wurde deshalb die Hermes-Glyphe aus der lokalen `simple-icons`-Quelle, damit die Kachel ein echtes freistehendes Logo bekommt und weiter theme-adaptiv bleibt.

`Eigener Dienst` wurde nicht umbenannt, sondern entfernt. Der Grund: Es gab bereits `Custom Messenger`, und genau das war die verständliche Bedeutung, die Christian benannt hat. Eine zweite generische Custom-Kachel hätte die Unklarheit nur konserviert, schöner lackiert. Braucht niemand.

`Custom Messenger` bekam eine konkretere Beschreibung: eigener Messenger-Kanal für Kunden-App, Community, Website-Chat oder internes System. Das Credential-Hint sagt jetzt `Messenger-Endpoint und Key leer`.

## Technische Umsetzung

Die Marken-Logos `openai`, `elevenlabs` und `hermes` bleiben in `MONOCHROME_LOGOS`. Damit werden sie über CSS-Masken gerendert und passen automatisch in Hell- und Dunkelmodus. Farbige Dienstlogos wie Google, Microsoft, Telegram, WhatsApp und Custom Messenger bleiben normale Bild-Assets.

Die `custom_messenger`-Fallback-Ikone wurde von `PlugZap` auf `MessageSquare` umgestellt. Praktisch greift weiter das vorhandene SVG-Logo, aber der Fallback passt jetzt semantisch.

Der Demo-Katalog enthält nun 12 statt 13 Einträge. Die Statistik `Offen` zeigt im leeren Demo-Zustand entsprechend 12.

## Verifikation

`npm run build` im Ordner `frontend/` läuft grün durch.

Die Oberfläche wurde auf `http://127.0.0.1:4222/` mit Playwright geprüft:

- dunkel: `--bg #1F1F1E`, 12 Kacheln, keine horizontale Breite
- hell: 12 Kacheln, keine horizontale Breite
- schmal 390 px: 12 Kacheln, keine horizontale Breite
- Bottom-Check: sichtbar sind Hermes, OpenClaw und Custom Messenger; `Eigener Dienst` ist nicht mehr vorhanden

Beim API-Load erscheint im Screenshot weiterhin `unauthorized`, weil das Template ohne echte Live-Anbindung geprüft wurde. Das ist für diesen Auftrag erwartbar und betrifft nicht die UI-Template-Änderung.

## Risiken und offen

Falls Christian mit „originales Hermes-Icon“ ein anderes internes Hermes-Agent-Logo meint, muss dieses Asset noch geliefert oder im Projekt abgelegt werden. Im aktuellen lokalen Bestand war kein anderes Hermes-Logo auffindbar. Die jetzige Lösung ist sauber theme-adaptiv und ersetzt den sichtbaren Platzhalter, aber sie ist nicht aus einem separaten internen Hermes-Brand-Ordner.
