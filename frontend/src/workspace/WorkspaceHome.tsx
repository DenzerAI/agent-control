import { BrainCircuit, Code2, FileText, FolderOpen, Hammer, Settings, Sparkles, Workflow } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

const DEMO_TREE = [
  { name: 'soul/', text: 'Identität, Stimme und Grundregeln des Agenten', icon: Sparkles, children: ['SOUL.md', 'ROLLEN.md'] },
  { name: 'brain/', text: 'Gedächtnis, Repo-Karte, Infra und Learnings', icon: BrainCircuit, children: ['REPO-MAP.md', 'INFRA.md', 'learnings/'] },
  { name: 'work/', text: 'Artefakte, Werkbank-Läufe und laufende Arbeitsstände', icon: Hammer, children: ['artifacts/', 'werkbank/', 'reports/'] },
  { name: 'skills/', text: 'Wiederverwendbare Fähigkeiten und Spezial-Workflows', icon: Workflow, children: ['html-artifact/', 'imagegen/', 'custom/'] },
  { name: 'config/', text: 'Agenten, Profile und lokale Konfiguration', icon: Settings, children: ['agents.json', 'secrets.local.example'] },
  { name: 'backend/', text: 'FastAPI, Streaming, Kontext und lokale Dienste', icon: Code2, children: ['server.py', 'streaming.py', 'modules/'] },
  { name: 'frontend/', text: 'Vite-App, Chat, Workspace und mobile Oberfläche', icon: FileText, children: ['src/', 'public/', 'index.html'] },
]

function DemoFolderTree() {
  return (
    <section className="workspace-system-panel">
      <div className="workspace-system-panel-head">
        <div><FolderOpen className="h-4 w-4" /><strong>Ordnerbaum</strong></div>
        <span>Demo</span>
      </div>
      <div className="workspace-system-list">
        {DEMO_TREE.map(({ name, text, icon: Icon, children }) => (
          <article key={name} className="workspace-system-row is-neutral workspace-files-row">
            <span />
            <div>
              <strong className="flex items-center gap-2"><Icon className="h-4 w-4 text-[var(--warm)]" />{name}</strong>
              <em>{text}</em>
              <small>{children.join(' · ')}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

export function WorkspaceHome({ onOpenFile, onClose, onRevealPath, path, filePath }: {
  onOpenFile: (path: string) => boolean
  onClose: () => void
  onRevealPath?: (path: string) => void
  path?: string | null
  filePath?: string | null
}) {
  void onOpenFile; void onClose; void onRevealPath; void path; void filePath

  return (
    <WorkspaceShell
      className="workspace-files-root"
      eyebrow="Dateien"
      title="Lokaler Arbeitsbaum"
      subtitle="Optische Demo der festen Struktur. Die echte Dateiverbindung kommt später wieder dazu, ohne den alten Workspace-Kasten."
    >
      <DemoFolderTree />
    </WorkspaceShell>
  )
}
