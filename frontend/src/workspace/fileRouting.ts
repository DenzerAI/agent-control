import type { WorkspaceFileKind } from './types'

const WORKSPACE_ROOT = '/workspace'

export function workspaceFileKind(path: string): WorkspaceFileKind | null {
  const p = String(path || '')
  if (!p) return null
  if (/\.(html|htm)$/i.test(p)) return 'html'
  if (/\.(md|markdown|mdx)$/i.test(p)) return 'markdown'
  // Alles andere (json, txt, yaml, csv, log, code, pdf, Bilder, Binär) öffnet
  // der Workspace im Filesystem-Pane. Die InfoPane zeigt keine Dateien mehr an.
  return 'file'
}

export function workspacePathParts(path: string): { dir: string; name: string } {
  const clean = String(path || '')
  const name = clean.split('/').pop() || clean || 'workspace'
  const rawDir = clean.includes('/') ? clean.replace(/\/[^/]+$/, '') : ''
  const dir = rawDir ? `${rawDir.replace(/^\/Users\/[^/]+\//, '~/')}/` : ''
  return { dir, name }
}

export function workspaceDirectory(path: string): string {
  const raw = String(path || '').trim()
  if (!raw) return ''
  const clean = raw.startsWith('~/workspace') ? raw.replace(/^~\/agent/, WORKSPACE_ROOT) : raw
  if (!clean.startsWith('/')) return ''
  const dir = clean.includes('/') ? clean.replace(/\/[^/]+$/, '') : clean
  return dir || WORKSPACE_ROOT
}
