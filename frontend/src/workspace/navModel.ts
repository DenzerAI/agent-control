import { Bot, Cable, CheckSquare2, FolderOpen, Inbox, LibraryBig, BookOpenText, ShieldCheck, Wrench } from 'lucide-react'
import type { WorkspaceMode } from './types'

export type NavItem = { id: WorkspaceMode; label: string; icon?: typeof FolderOpen }
export type NavGroup = { label: string; items: NavItem[] }

// Eine Quelle fuer Desktop-Rail und mobiles Kunden-Menue.
export const WORKSPACE_NAV: NavGroup[] = [
  {
    label: 'Kundenversion',
    items: [
      { id: 'inbox', label: 'Inbox', icon: Inbox },
      { id: 'knowledge', label: 'Wissen', icon: BookOpenText },
      { id: 'tasks', label: 'Aufgaben', icon: CheckSquare2 },
      { id: 'connectors', label: 'Konnektoren', icon: Cable },
      { id: 'skills', label: 'Skills', icon: Wrench },
      { id: 'privacy', label: 'Datenschutz', icon: ShieldCheck },
      { id: 'filesystem', label: 'Dateien', icon: FolderOpen },
      { id: 'artifacts', label: 'Artefakte', icon: LibraryBig },
      { id: 'agent', label: 'Agent', icon: Bot },
    ],
  },
]

export const MOBILE_PRIMARY: WorkspaceMode[] = ['inbox', 'tasks', 'knowledge', 'filesystem']

const ITEM_BY_MODE = new Map<WorkspaceMode, NavItem>()
for (const group of WORKSPACE_NAV) for (const item of group.items) ITEM_BY_MODE.set(item.id, item)

const LABEL_BY_MODE = new Map<WorkspaceMode, string>()
for (const group of WORKSPACE_NAV) for (const item of group.items) LABEL_BY_MODE.set(item.id, item.label)
LABEL_BY_MODE.set('preview', 'Vorschau')
LABEL_BY_MODE.set('document', 'Dokument')
LABEL_BY_MODE.set('loops', 'Werkbank')
LABEL_BY_MODE.set('settings', 'Einstellungen')
LABEL_BY_MODE.set('health', 'Health')

export function navItem(id: WorkspaceMode): NavItem | undefined {
  return ITEM_BY_MODE.get(id)
}

export function workspaceModeLabel(mode: WorkspaceMode): string {
  return LABEL_BY_MODE.get(mode) || 'Workspace'
}
