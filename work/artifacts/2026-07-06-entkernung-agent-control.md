# Agent Control Live: Konnektoren, Navigation und Chat-Pane finalisiert

Stand: 2026-07-06

## Kurzfassung

Der offene Zwischenstand ist jetzt sauber geschlossen. Dreaming ist im Frontend vollständig raus, die Workspace-Navigation zeigt genau `Chat`, `Inbox`, `Wissen`, `Aufgaben`, `Konnektoren`, `Dateien`, und der Chat läuft sichtbar nur noch als eine Pane. Die alten Slot-Umschalter, die 1/2/3-Breitenleiste über dem Workspace und die vier unteren Pane-Pillen sind weg.

## Geändert

`frontend/src/workspace/WorkspaceNav.tsx` ist wieder eine vollständige Nav-Komponente. Sie enthält die sechs gewünschten Einträge in der richtigen Reihenfolge und nutzt weiter das bestehende Werkbank-Signal am Aufgaben-Eintrag.

`frontend/src/workspace/WorkspaceOverlay.tsx` rendert `knowledge` als Wissen, `tasks` als Aufgaben und `connectors` als Konnektoren. Die sichtbare 1/2/3-Breitensteuerung oben rechts wurde entfernt, damit dort keine alte Slot-Anmutung mehr hängt.

`frontend/src/workspace/ConnectorsWorkspace.tsx` ist als Konnektoren-Seite eingebunden und über die Nav erreichbar. Die Seite lädt `/api/connectors`, zeigt verbundene Dienste und Engines und speichert Zugänge über den bestehenden maskierten Connector-Endpunkt.

`frontend/src/App.tsx` ist auf eine Chat-Pane reduziert. Die vorher sichtbaren unteren Slot-Pillen sind entfernt, alte Layout-Umschaltungen werden nicht mehr als mehrere feste Panes sichtbar, und der Gesprächswechsel läuft über den schlanken Chat-Wechsler oben links. Die ehemalige Vollbreiten-Tab-Leiste über dem Chat wurde zur kleinen Schaltfläche ohne horizontale Trennlinie umgebaut.

`frontend/src/workspace/CompanyMemoryWorkspace.tsx`, `frontend/src/workspace/AutomationWorkspace.tsx`, `frontend/src/components/InfoPane.tsx`, `frontend/src/components/HeartbeatSection.tsx` und `frontend/src/workspace/ChatagentWorkspace.tsx` verwenden sichtbar `Wissen` beziehungsweise `Aufgaben` statt `Firmengedächtnis`, `Automation` oder `Automationen`.

`frontend/src/workspace/DreamingWorkspace.tsx` ist gelöscht. `frontend/src/index.css` enthält keine Dreaming-Styles mehr.

## Kontrolle

`rg -n "dreaming|Dreaming" frontend/src` liefert keine Treffer.

`rg -n "Firmenged|Automationen|title=\"Automation|>Automation<|Automation im Workspace|Automation-Snapshot|companyMemory|mode === 'automation'|mode === 'companyMemory'" frontend/src` liefert keine Treffer.

`rg -n "DEFAULT_PANES|slotSyncSig|savePaneConfigs|setLayout|collapseToSinglePane|chatPanesHidden|visiblePaneIdx|paneSwitcherNode|workspace-actions|Slot-Pillen|selectSlot1|SLOT_COUNT|desktopSlots|activeSlot1" frontend/src/App.tsx frontend/src/workspace/WorkspaceOverlay.tsx` liefert keine Treffer.

`npm run build` im Frontend läuft erfolgreich durch. Vite meldet nur die bekannte Chunk-Size-Warnung für große Bundles.

Der lokale Vite-Port `4222` liefert per Header-Check `200 OK`.

Die Screenshot-Kontrolle per lokalem Chrome Headless zeigt die sechs Nav-Einträge, eine einzelne Chat-Pane, keinen 1/2/3-Umschalter, keine vier unteren Slot-Pillen und keine horizontale Tab-Leiste über dem Chat.

## Risiken und offen

Der In-App-Browser war in dieser Werkbank-Session nicht verfügbar (`iab` nicht registriert). Die visuelle Kontrolle wurde deshalb mit lokalem Google Chrome Headless gegen denselben laufenden Vite-Port `4222` gemacht.

Die Connector-Seite speichert Zugänge über den vorhandenen lokalen Backend-Mechanismus. Echte externe Verbindungen wurden nicht ausgelöst und keine Secrets wurden ausgegeben.

## Laienbriefing

Wir haben die linke Arbeitsleiste auf sechs klare Bereiche gebracht und den alten Dreaming-Bereich entfernt.

Der Chat ist jetzt wieder ein normaler einzelner Chat, nicht mehr ein System aus mehreren festen Fenstern mit kleinen Slot-Punkten.

Christian kann einem Kunden sagen: "Wir haben die Oberfläche aufgeräumt: klare Module links, Konnektoren als eigener Bereich und ein einfacher Chat statt eines verwirrenden Mehrfenster-Systems."
