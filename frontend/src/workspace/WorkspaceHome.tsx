import { useCallback, useEffect, useState } from 'react'
import { WorkspaceTree } from '../components/info-pane/sections/WorkspaceTree'
import { FsBusProvider } from '../components/info-pane/utils/fsBus'
import { workspaceDirectory, workspaceFileKind } from './fileRouting'
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

  const openFile = useCallback((nextPath: string) => {
    if (workspaceFileKind(nextPath) === 'html' && onOpenFile(nextPath)) return
    setFallbackFile(nextPath)
  }, [onOpenFile])

  if (fallbackFile) {
    return <WorkspaceFilePane path={fallbackFile} onBack={() => setFallbackFile('')} onRevealPath={onRevealPath} />
  }

  return (
    <div className="h-full min-h-0 overflow-hidden bg-[var(--bg)] text-[var(--t1)]">
      <FsBusProvider>
        <WorkspaceTree
          onOpenFile={openFile}
          fullMode
          onToggleFull={onClose}
          initialPath={path || (filePath ? workspaceDirectory(filePath) : null)}
        />
      </FsBusProvider>
    </div>
  )
}
