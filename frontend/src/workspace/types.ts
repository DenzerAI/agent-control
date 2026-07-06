export type WorkspaceMode = 'preview' | 'document' | 'filesystem' | 'agent' | 'companyMemory' | 'health' | 'limits' | 'privacy' | 'systemagent' | 'chatagent' | 'loops' | 'offers' | 'pionierplaner' | 'social' | 'analytics' | 'invoice' | 'dreaming' | 'finance' | 'people' | 'skills' | 'engines' | 'inbox' | 'artifacts' | 'calendar' | 'automation' | 'settings' | 'kanban' | 'agents' | 'radar' | 'ideas' | 'pipeline' | 'projects' | 'youtube'
export type WorkspaceSpan = 1 | 2 | 3
export type WorkspaceViewport = 'mobile' | 'tablet' | 'desktop'
export type WorkspaceFileKind = 'html' | 'markdown' | 'file'

export type WorkspaceFile = {
  path: string
  kind: WorkspaceFileKind
}

export type WorkspaceController = {
  open: boolean
  mode: WorkspaceMode
  returnMode: WorkspaceMode | null
  span: WorkspaceSpan
  docked: boolean
  collapsed: boolean
  file: WorkspaceFile | null
  filesystemPath: string | null
  toggleCollapsed: () => void
  setOpen: (open: boolean) => void
  setMode: (mode: WorkspaceMode) => void
  setSpan: (span: WorkspaceSpan) => void
  toggleDocked: () => void
  setFile: (file: WorkspaceFile | null) => void
  setFilesystemPath: (path: string | null) => void
  openMode: (mode: WorkspaceMode) => void
  toggleMode: (mode: WorkspaceMode) => void
  revealPath: (path: string) => void
  openFile: (path: string) => boolean
  close: () => void
  toggle: () => void
}
