import { ProjectOverviewView } from '../FokusApp'

// Projekte als Workspace-Reiter: dieselbe Funktion und derselbe Slashfocus-Look
// wie unter /fokus (Ansicht "Projekte"), nur in die Workspace-Huelle gehaengt.
// Quelle bleibt dieselbe lokale Wahrheit (GET /api/customers). Das Responsive-
// Verhalten fuer Breite 1/2/3 steuert CSS ueber .workspace-span-N
// (s. index.css, Block "Projekte-Workspace").
export function ProjectsWorkspace() {
  return (
    <div className="projects-workspace">
      <ProjectOverviewView />
    </div>
  )
}
