import { useCallback, useEffect, useState } from 'react'
import { WorkspaceTree } from '../components/info-pane/sections/WorkspaceTree'
import { FsBusProvider } from '../components/info-pane/utils/fsBus'
import { workspaceFileKind } from './fileRouting'
import { WorkspaceFilePane } from './WorkspaceFilePane'

const CLASSIC_TREE = [
  ['soul/', 'Identität, Stimme und Grundregeln des Agenten'],
  ['config/', 'Agenten, Profile und lokale Konfiguration'],
  ['brain/', 'Gedächtnis, Repo-Karte, Infra und Learnings'],
  ['work/', 'Artefakte, Werkbank-Läufe und laufende Arbeitsstände'],
  ['skills/', 'Wiederverwendbare Fähigkeiten und Spezial-Workflows'],
  ['backend/', 'FastAPI, Streaming, Kontext und lokale Dienste'],
  ['frontend/', 'Vite-App, Chat, Workspace und mobile Oberfläche'],
  ['scripts/', 'Start, Setup, Wartung und lokale Hilfswerkzeuge'],
]

function ClassicFolderTree() {
  return (
    <section className="workspace-files-demo">
      <div className="workspace-system-panel-head">
        <div><strong>Klassischer Ordnerbaum</strong></div>
        <span>Setup-Struktur</span>
      </div>
      <div className="workspace-system-list">
        {CLASSIC_TREE.map(([name, text]) => (
          <article key={name} className="workspace-system-row is-neutral">
            <span />
            <div>
              <strong>{name}</strong>
              <em>{text}</em>
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
  const [fallbackFile, setFallbackFile] = useState('')

  useEffect(() => {
    if (filePath) setFallbackFile(filePath)
  }, [filePath])

  const openFile = useCallback((path: string) => {
    if (workspaceFileKind(path) === 'html' && onOpenFile(path)) return
    setFallbackFile(path)
  }, [onOpenFile])

  if (fallbackFile) {
    return (
      <WorkspaceFilePane path={fallbackFile} onBack={() => setFallbackFile('')} onRevealPath={onRevealPath} />
    )
  }

  return (
    <div className="workspace-files-root h-full min-h-0 overflow-auto text-[var(--t1)]">
      <ClassicFolderTree />
      <FsBusProvider>
        <WorkspaceTree onOpenFile={openFile} fullMode onToggleFull={onClose} initialPath={path} />
      </FsBusProvider>
    </div>
  )
}
