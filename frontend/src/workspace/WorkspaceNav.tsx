import { useCallback, useEffect, useState } from 'react'
import {
  Activity, Bot, Building2, FolderOpen, Inbox, Moon, RotateCw,
} from 'lucide-react'
import type { WorkspaceMode } from './types'
import { triggerSafeRestart, isRestartInFlight } from '../lib/restart'
import { useWerkbankNavSignal } from './werkbankSignal'

type NavItem = { id: WorkspaceMode; label: string; icon?: typeof FolderOpen }
type NavGroup = { label: string; items: NavItem[] }

const WORKSPACE_NAV_ALL: NavGroup[] = [
  {
    label: '',
    items: [
      { id: 'agent', label: 'Chat', icon: Bot },
      { id: 'inbox', label: 'Inbox', icon: Inbox },
      { id: 'companyMemory', label: 'Firmengedächtnis', icon: Building2 },
      { id: 'dreaming', label: 'Dreaming', icon: Moon },
      { id: 'automation', label: 'Automationen', icon: Activity },
      { id: 'filesystem', label: 'Dateien', icon: FolderOpen },
    ],
  },
]

const LABEL_BY_MODE = new Map<WorkspaceMode, string>()
// Public-Core: Chat-first. Weitere Module kommen bewusst pro Kunde dazu.
const PUBLIC_CORE_IDS = new Set<string>(['agent', 'inbox', 'companyMemory', 'dreaming', 'automation', 'filesystem'])
export const WORKSPACE_NAV: NavGroup[] = WORKSPACE_NAV_ALL
  .map(group => ({ ...group, items: group.items.filter(item => PUBLIC_CORE_IDS.has(item.id)) }))
  .filter(group => group.items.length > 0)

for (const group of WORKSPACE_NAV) for (const item of group.items) LABEL_BY_MODE.set(item.id, item.label)
// Datei-Ansichten haben keinen eigenen Reiter, teilen sich die Anzeige mit File System.
LABEL_BY_MODE.set('preview', 'Vorschau')
LABEL_BY_MODE.set('document', 'Dokument')
if (!LABEL_BY_MODE.has('kanban')) LABEL_BY_MODE.set('kanban', 'Agent-Läufe')

export function workspaceModeLabel(mode: WorkspaceMode): string {
  return LABEL_BY_MODE.get(mode) || 'Workspace'
}

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD lokal

// Module mit frischem Tagesoutput leuchten Terracotta, bis der Nutzer sie öffnet.
// Zwei Signal-Arten: Inbox zählt offene Mails (leuchtet solange welche warten),
// Radar merkt sich pro Tag, ob die heutige Zusammenfassung schon gesehen wurde.
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
  // Beim Öffnen eines Moduls das Tages-Signal als gesehen abhaken.
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
  // Datei-Ansichten (preview/document) leuchten unter File System.
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
                item.id === 'loops' && werkbankSignal.active > 0 ? 'has-workbench-active' : '',
                item.id === 'loops' && werkbankSignal.attention > 0 ? 'has-workbench-attention' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onModeChange(item.id)}
              aria-current={activeId === item.id ? 'page' : undefined}
              title={collapsed ? item.label : item.id === 'loops'
                ? werkbankSignal.active > 0 ? `Werkbank läuft · ${werkbankSignal.active}` : werkbankSignal.waiting > 0 ? `Werkbank wartet · ${werkbankSignal.waiting}` : werkbankSignal.attention > 0 ? `Werkbank braucht Blick · ${werkbankSignal.attention}` : undefined
                : undefined}
            >
              {item.icon ? <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} /> : null}
              <span>{item.label}</span>
              {item.id === 'loops' && (werkbankSignal.active > 0 || werkbankSignal.waiting > 0) && !collapsed && (
                <span className="workspace-nav-count" aria-label={werkbankSignal.active > 0 ? `${werkbankSignal.active} laufende Aufträge` : `${werkbankSignal.waiting} wartende Aufträge`}>{werkbankSignal.active || werkbankSignal.waiting}</span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div className="workspace-nav-group workspace-nav-footer">
        <button
          type="button"
          onClick={() => { if (!isRestartInFlight()) void triggerSafeRestart() }}
          title={collapsed ? 'Neustart' : undefined}
        >
          <RotateCw className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
          <span>Neustart</span>
        </button>
      </div>
    </nav>
  )
}
