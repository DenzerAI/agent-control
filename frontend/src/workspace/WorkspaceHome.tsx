import { useCallback, useEffect, useState } from 'react'
import { WorkspaceTree } from '../components/info-pane/sections/WorkspaceTree'
import { FsBusProvider } from '../components/info-pane/utils/fsBus'
import { workspaceFileKind } from './fileRouting'
import { WorkspaceFilePane } from './WorkspaceFilePane'

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
    <div className="h-full min-h-0 overflow-auto bg-[var(--bg)] text-[var(--t1)]">
      <FsBusProvider>
        <WorkspaceTree onOpenFile={openFile} fullMode onToggleFull={onClose} initialPath={path} />
      </FsBusProvider>
    </div>
  )
}
