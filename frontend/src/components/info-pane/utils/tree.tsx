// Wiederverwendbarer Tree-Look für InfoPane-Sections.
// Source of Truth für Indent + Guide-Linien-Optik. Siehe HeartbeatSection
// als Referenz, wie der Helper benutzt wird.
import type { ReactNode } from 'react'

// Die X-Achse der Linie kommt aus CSS-Variablen.
// Sie läuft durch die Icon-Mitte der jeweils geöffneten Zeile.
// Kinder starten 12px rechts der Parent-Linie: 8px Gap + 4px Row-Padding.
export const GUIDE_GAP = 8

export function Guided({ children }: { children: ReactNode }) {
  return (
    <div className="info-guided" style={{ paddingLeft: `${GUIDE_GAP}px` }}>
      {children}
    </div>
  )
}
