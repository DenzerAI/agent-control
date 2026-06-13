import { useCallback, useEffect, useRef, useState } from 'react'
import { setOpenArtifact } from './openArtifactStore'
import { playUISound } from '../uiSounds'
import { workspaceDirectory, workspaceFileKind } from './fileRouting'
import type { WorkspaceController, WorkspaceFile, WorkspaceMode, WorkspaceSpan } from './types'

function playWorkspaceOpen(mode: WorkspaceMode) {
  playUISound(mode === 'filesystem' ? 'workspace-reveal' : 'workspace-open', 0.45)
}

const PARENT_MODE_BY_MODE: Partial<Record<WorkspaceMode, WorkspaceMode>> = {
  chatagent: 'automation',
  mailagent: 'automation',
  systemagent: 'automation',
  kanban: 'automation',
}

export function useWorkspaceController(): WorkspaceController {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('workspace:open') === '1' } catch { return false }
  })
  const [mode, setMode] = useState<WorkspaceMode>(() => {
    // Zuhause ist Artefakte. preview/document brauchen eine offene Datei, die nach
    // Hard Refresh fehlt — darum fallen sie aufs Zuhause zurück statt leer zu starten.
    try {
      const saved = localStorage.getItem('workspace:mode') as WorkspaceMode | null
      if (!saved || saved === 'preview' || saved === 'document') return 'artifacts'
      return saved
    } catch { return 'artifacts' }
  })
  // Letzte Breite überlebt den Hard Refresh: gespeicherten Span wieder einlesen,
  // damit der Workspace nicht stur auf 1 zurückspringt.
  const [span, setSpan] = useState<WorkspaceSpan>(() => {
    try {
      const saved = parseInt(localStorage.getItem('workspace:span') || '1', 10)
      return (saved === 2 || saved === 3 ? saved : 1) as WorkspaceSpan
    } catch { return 1 }
  })
  const [docked, setDocked] = useState<boolean>(() => {
    try { return localStorage.getItem('workspace:docked') === '1' } catch { return false }
  })
  // Eingeklappte Nav-Rail (nur Icons). Lebt hier statt im Overlay, damit das
  // Layout in App.tsx die schmalere Breite kennt und die Chats ranwachsen können.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('workspace-rail-collapsed') === '1' } catch { return false }
  })
  const [file, setFile] = useState<WorkspaceFile | null>(null)
  const [filesystemPath, setFilesystemPath] = useState<string | null>(null)
  // Modus, zu dem ein Zurück-Sprung führt, wenn aus einem Listen-Modul (z.B.
  // Artefakte) eine Datei geöffnet wurde. So findet der Nutzer aus der Preview
  // zurück in die Liste, statt im Datei-Modus festzustecken.
  const [returnMode, setReturnMode] = useState<WorkspaceMode | null>(() => PARENT_MODE_BY_MODE[mode] || null)
  const openRef = useRef(open)
  const modeRef = useRef(mode)
  const spanRef = useRef(span)

  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { spanRef.current = span }, [span])

  useEffect(() => {
    try { localStorage.setItem('workspace:mode', mode) } catch {}
  }, [mode])

  useEffect(() => {
    try { localStorage.setItem('workspace:open', open ? '1' : '0') } catch {}
  }, [open])

  const setOpenWithSound = useCallback((nextOpen: boolean) => {
    setOpen(prev => {
      if (prev !== nextOpen) playUISound(nextOpen ? 'workspace-open' : 'workspace-close', 0.45)
      openRef.current = nextOpen
      return nextOpen
    })
  }, [])

  const setModeWithSound = useCallback((nextMode: WorkspaceMode) => {
    setMode(prev => {
      if (prev !== nextMode && openRef.current) playUISound('workspace-mode', 0.35)
      modeRef.current = nextMode
      return nextMode
    })
  }, [])

  // Nur die manuelle Breitenwahl wird persistiert. Der HTML-Auto-Zwang auf Stufe 3
  // (in openFile) bleibt flüchtig, damit er den gespeicherten Wunsch nicht überschreibt
  // und nach Hard Refresh wirklich die zuletzt selbst gewählte Breite zurückkommt.
  const setSpanWithSound = useCallback((nextSpan: WorkspaceSpan) => {
    setSpan(prev => {
      if (prev !== nextSpan) playUISound('workspace-span', 0.45)
      spanRef.current = nextSpan
      return nextSpan
    })
    try { localStorage.setItem('workspace:span', String(nextSpan)) } catch {}
  }, [])

  const openMode = useCallback((nextMode: WorkspaceMode) => {
    const previousMode = modeRef.current
    setReturnMode(PARENT_MODE_BY_MODE[nextMode] || null)
    const _t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    setMode(nextMode)
    modeRef.current = nextMode
    setOpen(prev => {
      if (!prev) playWorkspaceOpen(nextMode)
      else if (previousMode !== nextMode) playUISound('workspace-mode', 0.35)
      openRef.current = true
      return true
    })
    // TEMP-Diagnose: Zeit vom Klick bis zum naechsten fertigen Frame ins Server-Log.
    try {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0)
        fetch('/api/build-id?modeswitch=' + nextMode + '&ms=' + ms, { keepalive: true }).catch(() => {})
      }))
    } catch {}
  }, [])

  const toggleMode = useCallback((nextMode: WorkspaceMode) => {
    setReturnMode(PARENT_MODE_BY_MODE[nextMode] || null)
    setOpen(isOpen => {
      if (isOpen && modeRef.current === nextMode) {
        playUISound('workspace-close', 0.45)
        openRef.current = false
        return false
      }
      if (isOpen) playUISound('workspace-mode', 0.35)
      else playWorkspaceOpen(nextMode)
      setMode(nextMode)
      modeRef.current = nextMode
      openRef.current = true
      return true
    })
  }, [])

  const revealPath = useCallback((path: string) => {
    const dir = workspaceDirectory(path)
    setFilesystemPath(dir || null)
    setMode('filesystem')
    modeRef.current = 'filesystem'
    setOpen(prev => {
      playUISound(prev ? 'workspace-mode' : 'workspace-reveal', prev ? 0.35 : 0.45)
      openRef.current = true
      return true
    })
  }, [])

  const openFile = useCallback((path: string): boolean => {
    const filePath = String(path || '')
    if (!filePath) return false
    const kind = workspaceFileKind(filePath)
    if (!kind) return false
    const nextMode = kind === 'html' ? 'preview' : 'filesystem'
    const wasOpen = openRef.current
    const prevMode = modeRef.current
    // Nur echte Modul-Modi taugen als Rücksprungziel, nicht die Datei-Modi selbst.
    if (prevMode !== 'preview' && prevMode !== 'document' && prevMode !== 'filesystem') {
      setReturnMode(prevMode)
    }
    setFile({ path: filePath, kind })
    setOpenArtifact(filePath)
    if (nextMode === 'filesystem') setFilesystemPath(workspaceDirectory(filePath) || null)
    // Breite nicht erzwingen: ist der Workspace schon offen, erbt die neue HTML
    // die vorhandene Breite (Stufe 1/2/3 bleibt). Erst beim Öffnen aus dem
    // geschlossenen Zustand startet eine Seite frisch auf Stufe 2.
    if (kind === 'html' && !wasOpen) { setSpan(2); spanRef.current = 2 }
    setMode(nextMode)
    modeRef.current = nextMode
    setOpen(prev => {
      playUISound('workspace-file', prev ? 0.35 : 0.45)
      openRef.current = true
      return true
    })
    return true
  }, [])

  const toggleDocked = useCallback(() => {
    setDocked(prev => {
      const next = !prev
      try { localStorage.setItem('workspace:docked', next ? '1' : '0') } catch {}
      playUISound('workspace-span', 0.45)
      return next
    })
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('workspace-rail-collapsed', next ? '1' : '0') } catch {}
      playUISound('workspace-span', 0.4)
      return next
    })
  }, [])

  const close = useCallback(() => {
    setOpen(prev => {
      if (prev) playUISound('workspace-close', 0.45)
      openRef.current = false
      return false
    })
  }, [])

  const toggle = useCallback(() => {
    setOpen(prev => {
      const next = !prev
      playUISound(next ? 'workspace-open' : 'workspace-close', 0.45)
      openRef.current = next
      return next
    })
  }, [])

  return {
    open,
    setOpen: setOpenWithSound,
    mode,
    returnMode,
    setMode: setModeWithSound,
    span,
    setSpan: setSpanWithSound,
    docked,
    toggleDocked,
    collapsed,
    toggleCollapsed,
    file,
    setFile,
    filesystemPath,
    setFilesystemPath,
    openMode,
    toggleMode,
    revealPath,
    openFile,
    close,
    toggle,
  }
}
