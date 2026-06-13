import { PipelineView } from '../FokusApp'

// Vertriebspipeline als Workspace-Reiter: dieselbe Funktion und derselbe
// Slashfocus-Look wie unter /fokus, nur in die Workspace-Huelle gehaengt.
// Quelle bleibt dieselbe lokale Wahrheit (GET /api/customers). Das Responsive-
// Verhalten fuer Breite 1/2/3 steuert rein CSS ueber .workspace-span-N
// (s. index.css, Block "Pipeline-Workspace").
//
// PipelineView nutzt todayIso/onOpenItem aktuell nur als optionale Haken
// (intern _todayIso/_onOpenItem). Wir reichen den echten heutigen Tag durch
// und einen No-op, damit die Signatur sauber bleibt.
function isoToday(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

export function PipelineWorkspace() {
  return (
    <div className="pipeline-workspace">
      <PipelineView todayIso={isoToday()} onOpenItem={() => {}} />
    </div>
  )
}
