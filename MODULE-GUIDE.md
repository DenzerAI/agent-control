# Workspace-Modul-Konvention

`frontend/src/workspace/WorkspaceShell.tsx` ist die einzige Layout-Wahrheit für sichtbare Workspace-Module. Neue Module werden nicht mit eigenem Header, eigener Hero-Fläche oder eigenem Grid-Grundriss gebaut.

## Neues Modul anlegen

1. Komponente unter `frontend/src/workspace/<Name>Workspace.tsx` anlegen.
2. `WorkspaceShell` importieren.
3. `eyebrow`, `title`, `subtitle` und optional `action` übergeben.
4. Inhalte darunter als einspaltigen Fluss bauen, meistens mit `workspace-system-main workspace-system-stack`.
5. In `WorkspaceOverlay.tsx` einhängen und in `WorkspaceNav.tsx` einen Nav-Eintrag ergänzen.

## Harte Regeln

- Jedes Workspace-Modul nutzt `WorkspaceShell`.
- Der Hero ist linksbündig, randlos, ohne eigene Kartenfläche.
- Inhalte laufen untereinander. Nie dreispaltig.
- Statistik- und Kachelgruppen nutzen `workspace-system-strip`; auch das bleibt einspaltig.
- Claude-Coral ist die einzige Akzentfarbe: `var(--cc-orange)` / `#D97757`.
- Nav-Icons haben eine Größe und eine Strichstärke.
- Interaktive Ziele sind mindestens 40 x 40 px.
- Suche, Filter, Keys und Verbindungsfelder bleiben dünn, ruhig und nicht laut.

## Minimalbeispiel

```tsx
import { WorkspaceShell } from './WorkspaceShell'

export function ExampleWorkspace() {
  return (
    <WorkspaceShell
      eyebrow="Beispiel"
      title="Ein ruhiger Modul-Titel"
      subtitle="Ein Satz, der sagt, wofür der Reiter da ist."
    >
      <main className="workspace-system-main workspace-system-stack">
        <section className="workspace-system-panel">Inhalt untereinander.</section>
      </main>
    </WorkspaceShell>
  )
}
```
