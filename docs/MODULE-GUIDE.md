# Modul-Guide

Diese Konvention gilt für neue Workspace-Module im Kundengerüst.

## Grundform

- Jedes neue Modul nutzt `frontend/src/workspace/WorkspaceShell.tsx`.
- Der Reiter bekommt den einheitlichen Hero-Header über `eyebrow`, `title` und `subtitle`.
- Inhalte laufen untereinander. Keine dreispaltigen Layouts, keine verschachtelten Kartenflächen.
- Panels nutzen die vorhandenen `workspace-system-*` Klassen, bevor neue CSS-Muster entstehen.

## Stil

- Akzentfarbe ist Claude-Coral über `var(--cc-orange)` (`#D97757`).
- Hell- und Dunkelmodus müssen ohne Sonderlogik lesbar bleiben.
- Zahlen bekommen `font-variant-numeric: tabular-nums`, wenn sie Status oder Scores zeigen.
- Texte bleiben kurz, alltagssprachlich und erklärend.

## Demo-Daten

- Noch nicht verdrahtete Module zeigen plausible Demo-Daten.
- Demo-Texte müssen fachlich sinnvoll sein und klar machen, was später echt angebunden wird.
- Offene Punkte werden sichtbar als offen markiert, nicht als erledigt verkauft.

## Abnahme

- Neuer Nav-Eintrag ist sichtbar und öffnet den Reiter.
- Das Modul nutzt `WorkspaceShell`.
- Keine drei Spalten, auch nicht auf breiten Viewports.
- `npm run build` im Frontend läuft fehlerfrei.
- Vor Übergabe werden Hell- und Dunkelmodus visuell geprüft.
