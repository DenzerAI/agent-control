# Datei-Explorer und neutrales Kundengerüst

Stand: 2026-07-06, Werkbank-Lauf `werk-chat-20260706-f29cd3`.

## Kurzfassung

Der Dateien-Bereich ist von der statischen Demo-Karte auf einen echten Explorer-Pfad umgestellt. Die linke Workspace-Rail trägt keine Agent-Control-Wortmarke mehr, und die Vorschau/Settings-Texte enthalten im Header keine Produktmarke mehr. Der Artefakt-Bereich blieb als ruhige Liste bestehen; sein Vorschau-Overlay ist bereits deckend und hat ein klares 40x40-Schließen-X.

## Geändert

- `frontend/src/workspace/WorkspaceHome.tsx`: Die alte Demo-Struktur wurde ersetzt durch `WorkspaceTree` im Vollmodus, inklusive `FsBusProvider`, direktem Öffnen von Dateien und Fallback-Reader für Markdown/Text/Bilder/PDF.
- `frontend/src/components/info-pane/sections/WorkspaceTree.tsx`: Der Vollmodus ist jetzt ein zweigeteilter Explorer mit linker Ordnernavigation und rechter einzeiliger Dateiliste. Ordner behalten Icons, Dateien zeigen Typ-Icons, Metadaten und eine kleine Hover-Vorschau für Bilder, HTML, Markdown und Textdateien.
- `frontend/src/workspace/WorkspaceOverlay.tsx`: Die Wortmarke oben links wurde entfernt. Die Rail bleibt funktional, aber neutral und kundenbrandbar.
- `frontend/src/workspace/SettingsWorkspace.tsx` und `frontend/src/workspace/PreviewPane.tsx`: Produktname aus sichtbaren Header-/Empty-State-Texten entfernt.
- `backend/server.py` und `modules/fs/core.py`: `/workspace` wird sauber auf den Projekt-Root gemappt und der Projekt-Root ist als erlaubter Dateibereich eingetragen. Das ist die eigentliche Ursache dafür, dass der Explorer live Daten sehen kann.

## Entscheidungen

Die Dateiansicht bleibt bewusst kompakt wie ein Filesystem, nicht als Kartenwand. Die Trennung zwischen Navigation und Inhalt passiert über eine klare linke Baumspalte und eine rechte Listenfläche. HTML-Dateien gehen weiter über die vorhandene Datei-Öffnen-Logik in die Vorschau, Markdown/Text öffnen im integrierten Reader.

Der Backend-Teil war nötig, weil `/workspace` vorher nur als Demo-Begriff im Frontend existierte. Die API hat den Pfad geblockt, deshalb konnte ein echter Explorer im laufenden Server nicht zuverlässig Daten zeigen.

## Kontrolle

- `npm run build` in `frontend/`: grün.
- `python3 -m py_compile backend/server.py modules/fs/core.py`: grün.
- Port `4222` per Playwright-Screenshot geprüft: Header/Wortmarke ist weg, Dateien-Bereich rendert in hell und dunkel. Der laufende Server zeigt bis zum Backend-Neustart noch einen leeren `/workspace`, weil die neue Pfadauflösung erst nach Server-Neustart aktiv wird.

## Offen

Nach Backend-Neustart muss der Dateien-Bereich einmal live geprüft werden. Erwartung: `/workspace` zeigt dann den Projekt-Root des Kundengerüsts statt leerer Liste. Kein Code-Blocker offen.
