# Flexibles Layout: Chat + Workspace per Splitter

Stand: 2026-07-06

## Ergebnis

Das Hauptlayout von Agent Control hat jetzt einen einzelnen ziehbaren Splitter zwischen Workspace und Chat. Der Workspace kann breiter gezogen werden, der Chat wird dabei entsprechend schmaler, und umgekehrt. Die linke Workspace-Navigation bleibt unverändert: Sie ist weiterhin nur ein- oder ausgeklappt, aber nicht frei resizable.

## Geänderte Dateien

- `frontend/src/App.tsx`
- `frontend/src/index.css`

## Umsetzung

In `App.tsx` wurde die feste Grid-Aufteilung durch eine gemessene Hauptbreite ersetzt. Sobald genug Platz vorhanden ist, berechnet die App Workspace-Breite, Splitter-Breite und Chat-Breite explizit in Pixeln. Der Startwert liegt bei 42 Prozent Chat und 58 Prozent Workspace.

Der Splitter sitzt genau zwischen Workspace und Chat. Pointer-Drag verschiebt die Trennung gegenläufig. Tastaturbedienung über Pfeiltasten ist ebenfalls möglich, weil der Splitter als vertikaler Separator fokussierbar ist.

Die Chat-Mindestbreite liegt bei 380 px, die Workspace-Mindestbreite bei 520 px. Dadurch kollabiert der Chat nicht in einen unbrauchbaren Streifen, und der Workspace behält genug Raum für seine Module.

Die gezogene Aufteilung wird in `localStorage` unter `control:layout:chatFraction` gespeichert. Nach einem Reload bleibt die vom Nutzer gesetzte Breite erhalten.

Auf schmalen Fenstern, in denen beide Mindestbreiten plus Splitter nicht mehr sinnvoll nebeneinander passen, verschwindet der Splitter. Der Workspace öffnet dann als eigene volle Overlay-Fläche über dem Chat. Das verhindert horizontales Scrollen und abgeschnittene Inhalte.

## Design-Entscheidungen

- Ein einzelner Splitter statt mehrerer Griffe, damit die Bedienung eindeutig bleibt.
- Startwert mit etwas mehr Raum für den Workspace, weil Christians Kritik genau dort lag.
- Mindestbreiten hart im Layout, nicht nur optisch per CSS, damit Drag und Resize dieselbe Wahrheit nutzen.
- Splitter visuell dezent im Ruhezustand, mit Claude-Coral `#D97757` nur bei Hover, Fokus oder Drag.
- Keine Änderung an Chat-Inhalten, Workspace-Modulen oder der Sidebar-Navigation.

## Verifikation

- `npm run build` im Frontend: erfolgreich.
- `curl -I http://127.0.0.1:4222/`: HTTP 200.
- Playwright-Prüfung breit, mittel, schmal gegen `http://127.0.0.1:4222/`.
- Breite Ansicht 1440 px: Splitter vorhanden, Workspace 825 px, Chat 605 px.
- Drag nach rechts: Workspace 1005 px, Chat 425 px, Chat bleibt über Mindestbreite.
- Reload nach Drag: Workspace 1005 px, Chat 425 px, gespeicherter Wert bleibt erhalten.
- Mittlere Ansicht 1100 px: Splitter vorhanden, Workspace 628 px, Chat 462 px.
- Schmale Ansicht 840 px: kein Splitter, Workspace als Overlay, kein horizontaler Scroll.

Screenshots liegen lokal unter `work/screenshots/2026-07-06-flex-layout/`:

- `wide-before.png`
- `wide-after-drag.png`
- `wide-after-reload-persisted.png`
- `medium.png`
- `narrow-overlay.png`

## Beobachtungen

Im isolierten Playwright-Kontext wurden mehrere 401/403-Meldungen von API/WebSocket-Endpunkten geloggt, weil der Testbrowser keine authentifizierte Christian-Session hatte. Das betrifft die Datenanbindung, nicht das Layout. Die Seite selbst lädt auf `4222`, das Layout rendert, der Splitter funktioniert und die Screenshots wurden erzeugt.

## Offene Punkte

Keine für diesen Auftrag. Die frühere Nebenidee, die Wortmarke oben links zu entfernen, wurde bewusst nicht umgesetzt, weil dieser Lauf laut Auftrag nur das Hauptlayout und nicht die Sidebar-/Modul-Inhalte anfassen sollte.
