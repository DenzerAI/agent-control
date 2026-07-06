# Modul-Guide

Diese Konvention gilt für neue Workspace-Module im Kundengerüst.

## Grundform

- Jedes neue Modul nutzt `frontend/src/workspace/WorkspaceShell.tsx`.
- Der Reiter bekommt den einheitlichen Hero-Header über `eyebrow`, `title` und `subtitle`.
- Inhalte laufen untereinander. Keine dreispaltigen Layouts, keine verschachtelten Kartenflächen.
- Panels nutzen die vorhandenen `workspace-system-*` Klassen, bevor neue CSS-Muster entstehen.
- Ausnahme: schlanke Zählerleisten oder Tabs wie `Wartet`, `WhatsApp`, `E-Mail`, `Gruppen`, `Archiv` dürfen nebeneinander stehen, weil sie nur Orientierung geben und wenig Raum brauchen.

## Stil

- Akzentfarbe ist Claude-Coral über `var(--cc-orange)` (`#D97757`).
- Keine neuen Orange-, Amber- oder Warnfarben hart kodieren.
- Hell- und Dunkelmodus müssen ohne Sonderlogik lesbar bleiben.
- Zahlen bekommen `font-variant-numeric: tabular-nums`, wenn sie Status oder Scores zeigen.
- Texte bleiben kurz, alltagssprachlich und erklärend.
- Schließen-Controls und Icon-Buttons haben mindestens `40px` Klickfläche.

## Demo-Daten

- Noch nicht verdrahtete Module zeigen plausible Demo-Daten.
- Demo-Daten müssen konkret wirken: echte Namen, Datum, Größe und kurze Nutzenerklärung.
- Keine generischen Platzhalter wie `Demo 1`, `example` oder leere Datei-Labels.
- Offene Punkte werden sichtbar als offen markiert, nicht als erledigt verkauft.

## Vorschauen

- Vorschauen und Overlays sind opak.
- Nichts aus Chat, Hero oder Hintergrund darf durchscheinen.
- Fullscreen-Previews liegen über dem gesamten Viewport, nicht nur im Workspace-Container.
- Schließen oben rechts bleibt ruhig, rund, gut klickbar und visuell passend zur restlichen UI.

## Abnahme

- Neuer Nav-Eintrag ist sichtbar und öffnet den Reiter.
- Das Modul nutzt `WorkspaceShell`.
- Keine drei Spalten, auch nicht auf breiten Viewports.
- Ausnahmen für Zählerleisten bleiben kompakt, einzeilig wenn Platz vorhanden ist und wrappen nur bei Bedarf.
- `npm run build` im Frontend läuft fehlerfrei.
- Vor Übergabe werden Hell- und Dunkelmodus visuell geprüft.
