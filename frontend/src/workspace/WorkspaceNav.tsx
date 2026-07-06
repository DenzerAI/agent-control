import { useCallback, useEffect, useState } from 'react'
import { Bot, BrainCircuit, CheckSquare2, FolderOpen, Inbox, Library, PlugZap } from 'lucide-react'
import type { WorkspaceMode } from './types'
import { useWerkbankNavSignal } from './werkbankSignal'

type NavItem = { id: WorkspaceMode; label: string; icon: typeof FolderOpen }
type NavGroup = { label: string; items: NavItem[] }

const WORKSPACE_NAV: NavGroup[] = [
  {
    label: '',
    items: [
      { id: 'inbox', label: 'Inbox', icon: Inbox },
      { id: 'knowledge', label: 'Wissen', icon: BrainCircuit },
      { id: 'tasks', label: 'Aufgaben', icon: CheckSquare2 },
      { id: 'connectors', label: 'Konnektoren', icon: PlugZap },
      { id: 'filesystem', label: 'Dateien', icon: FolderOpen },
      { id: 'artifacts', label: 'Artefakte', icon: Library },
      { id: 'agent', label: 'Agent', icon: Bot },
    ],
  },
]

const LABEL_BY_MODE = new Map<WorkspaceMode, string>()
for (const group of WORKSPACE_NAV) for (const item of group.items) LABEL_BY_MODE.set(item.id, item.label)
LABEL_BY_MODE.set('preview', 'Vorschau')
LABEL_BY_MODE.set('document', 'Dokument')
LABEL_BY_MODE.set('loops', 'Aufgaben')

export function workspaceModeLabel(mode: WorkspaceMode): string {
  return LABEL_BY_MODE.get(mode) || 'Workspace'
}

const today = () => new Date().toLocaleDateString('en-CA')

function useNotifyModes(activeId: WorkspaceMode): Set<WorkspaceMode> {
  const [notify, setNotify] = useState<Set<WorkspaceMode>>(new Set())
  const load = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    const next = new Set<WorkspaceMode>()
    try {
      const r = await fetch('/api/inbox/mail-attention?limit=80')
      if (r.ok) {
        const d = await r.json()
        if ((Array.isArray(d.items) ? d.items.length : 0) > 0) next.add('inbox')
      }
    } catch {}
    try {
      const r = await fetch('/api/radar/today')
      if (r.ok) {
        const d = await r.json()
        const date = d?.konsolidiert?.date || d?.youtube?.date || ''
        if (date && date === today() && localStorage.getItem('ws-seen-radar') !== date) next.add('radar')
      }
    } catch {}
    setNotify(next)
  }, [])
  useEffect(() => {
    void load()
    const id = window.setInterval(load, 60000)
    window.addEventListener('deck:inboxChanged', load)
    document.addEventListener('visibilitychange', load)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('deck:inboxChanged', load)
      document.removeEventListener('visibilitychange', load)
    }
  }, [load])
  useEffect(() => {
    if (activeId === 'radar') {
      localStorage.setItem('ws-seen-radar', today())
      setNotify(prev => {
        if (!prev.has('radar')) return prev
        const n = new Set(prev); n.delete('radar'); return n
      })
    }
  }, [activeId])
  return notify
}

export function WorkspaceNav({ mode, collapsed = false, onModeChange }: {
  mode: WorkspaceMode
  collapsed?: boolean
  onModeChange: (mode: WorkspaceMode) => void
}) {
  const activeId: WorkspaceMode = mode === 'document' || mode === 'preview' ? 'filesystem' : mode
  const notify = useNotifyModes(activeId)
  const werkbankSignal = useWerkbankNavSignal()
  return (
    <nav className={`workspace-nav${collapsed ? ' is-collapsed' : ''}`} aria-label="Workspace Navigation">
      {WORKSPACE_NAV.map((group, gi) => (
        <div key={group.label || `g${gi}`} className="workspace-nav-group">
          {!collapsed && group.label && <div className="workspace-nav-grouplabel">{group.label}</div>}
          {group.items.map(item => (
            <button
              key={item.id}
              type="button"
              className={[
                activeId === item.id ? 'is-active' : '',
                notify.has(item.id) ? 'has-notify' : '',
                item.id === 'tasks' && werkbankSignal.active > 0 ? 'has-workbench-active' : '',
                item.id === 'tasks' && werkbankSignal.attention > 0 ? 'has-workbench-attention' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onModeChange(item.id)}
              aria-current={activeId === item.id ? 'page' : undefined}
              title={collapsed ? item.label : item.id === 'tasks'
                ? werkbankSignal.active > 0 ? `Werkbank läuft · ${werkbankSignal.active}` : werkbankSignal.waiting > 0 ? `Werkbank wartet · ${werkbankSignal.waiting}` : werkbankSignal.attention > 0 ? `Werkbank braucht Blick · ${werkbankSignal.attention}` : undefined
                : undefined}
            >
              <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
              <span>{item.label}</span>
              {item.id === 'tasks' && (werkbankSignal.active > 0 || werkbankSignal.waiting > 0) && !collapsed && (
                <span className="workspace-nav-count" aria-label={werkbankSignal.active > 0 ? `${werkbankSignal.active} laufende Aufträge` : `${werkbankSignal.waiting} wartende Aufträge`}>{werkbankSignal.active || werkbankSignal.waiting}</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}
