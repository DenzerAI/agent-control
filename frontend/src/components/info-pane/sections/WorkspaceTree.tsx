import React, { useState, useEffect, useCallback, useRef, useMemo, useContext, createContext, Fragment } from 'react'
import { ChevronRight, ChevronLeft, Search, X, FolderOpen, FolderClosed, FolderPlus, Brain, Heart, Cog, Briefcase, Loader2, Upload, Plus, Download, Copy, Pencil, Trash2, Archive, FileText, ArrowDown, ArrowUp, Maximize2, Home, Shield } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { HIDDEN_FOLDERS } from '../utils/constants'
import { Guided } from '../utils/tree'
import { fileIcon } from '../utils/fileIcon'
import { formatBytes, formatRelTime } from '../utils/format'
import { FsBusContext, fsCall } from '../utils/fsBus'
import { TrashSection } from './TrashSection'

interface FsItem { name: string; type: string; path: string; size?: number | null; mtime?: number | null }

// ── Tree Components (from DeckPanel) ──

export function TreeFolder({ label, icon: Icon, color, level, open, onToggle, count, onAction, actionIcon: ActionIcon, children, mobile }: {
  label: string; icon?: typeof Shield; color?: string; level: number
  open: boolean; onToggle: () => void; count?: number
  onAction?: () => void; actionIcon?: typeof Shield
  children?: React.ReactNode; mobile?: boolean
}) {
  const FolderIcon = open ? FolderOpen : FolderClosed
  return (
    <div>
      <div className="group relative flex items-center hover:bg-white/[0.06] transition-colors">
        <button onClick={onToggle}
          className={`flex-1 flex items-center pr-3 ${level === 0 ? `pl-2 ${mobile ? 'py-3' : 'py-2'}` : `pl-1 ${mobile ? 'py-2' : 'py-[5px]'}`} info-text-body text-left cursor-pointer`}>
          <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
          {Icon && level === 0 && <Icon className="info-icon-md mr-2 text-[var(--t2)] flex-shrink-0" />}
          {level > 0 && <FolderIcon className="info-icon-md mr-2 text-[var(--t3)] flex-shrink-0" />}
          {color && !Icon && <span className="w-2 h-2 rounded-full mr-2 flex-shrink-0" style={{ background: color }} />}
          <span className="truncate flex-1 text-left text-[var(--t2)] group-hover:text-[var(--t1)]">{label}</span>
          {typeof count === 'number' && count > 0 && (
            <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0">{count}</span>
          )}
        </button>
        {onAction && ActionIcon && (
          <button onClick={e => { e.stopPropagation(); onAction() }}
            className="absolute right-2 opacity-0 group-hover:opacity-100 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer transition-opacity">
            <ActionIcon className="info-icon-sm" />
          </button>
        )}
      </div>
      {open && <Guided>{children}</Guided>}
    </div>
  )
}
// Selection + Keyboard-Steuerung für den Workspace-Tree.
// selected ist der einzige aktuell selektierte Pfad. registerFolderCtrl erlaubt
// Pfeiltasten ←/→, einen Folder programmatisch zu öffnen/schließen, ohne dass
// der Tree wissen muss, in welchem ProjectBrowse-Knoten der Pfad sitzt.
type FsSelCtx = {
  selected: string | null
  setSelected: (p: string | null) => void
  focusContainer: () => void
  registerFolderCtrl: (path: string, ctrl: { setOpen: (next: boolean) => void; isOpen: () => boolean }) => () => void
  toggleFolder: (path: string, next?: boolean) => void
  isFolderOpen: (path: string) => boolean
  openFile: (p: string) => void
  trashPath: (p: string, label: string) => Promise<void>
  // Inline-Rename: Wenn renaming === path, rendert die Row statt Label ein <input>.
  renaming: string | null
  startRename: (p: string) => void
  cancelRename: () => void
  commitRename: (p: string, newLabel: string) => Promise<void>
  // Rechtsklick-Kontextmenü: openCtxMenu öffnet bei (x, y) für ein Item.
  openCtxMenu: (info: { x: number; y: number; path: string; folder: boolean; level: number; label: string }) => void
  // Hover-Vorschau für Bilder/SVGs (PDF & Video später).
  onHoverEnter: (path: string, name: string, e: React.MouseEvent) => void
  onHoverLeave: () => void
}

// Welche Extensions im Hover als Bild vorab gerendert werden — alles, was der
// Browser nativ rendern kann. PDF und Video kommen später, falls gewünscht.
const HOVER_IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])
function isHoverPreviewable(name: string): boolean {
  const dot = name.lastIndexOf('.'); if (dot < 0) return false
  return HOVER_IMG_EXT.has(name.slice(dot + 1).toLowerCase())
}
const FsSelContext = createContext<FsSelCtx | null>(null)

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current; if (!el) return
    el.focus()
    // Selektiere nur den Stamm-Namen, nicht die Endung — wie im Finder.
    const dot = initial.lastIndexOf('.')
    if (dot > 0) el.setSelectionRange(0, dot); else el.select()
  }, [initial])
  return (
    <input
      ref={ref}
      value={val}
      onChange={e => setVal(e.target.value)}
      onClick={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); onCommit(val) }
        else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
      onBlur={() => onCommit(val)}
      className="flex-1 min-w-0 bg-white/[0.08] border border-[var(--t3)]/40 rounded px-1 outline-none info-text-body text-[var(--t1)]"
    />
  )
}

// Persist Folder-Open-State pro Pfad in localStorage. Damit bleibt der Tree
// nach Reload genau so aufgeklappt, wie ihn der Nutzer zuletzt verlassen hat.
const FS_OPEN_KEY = 'infopane:fs:openFolders'
function loadOpenSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FS_OPEN_KEY) || '[]')) }
  catch { return new Set() }
}
function saveOpenSet(s: Set<string>) {
  try { localStorage.setItem(FS_OPEN_KEY, JSON.stringify(Array.from(s))) } catch {}
}
function useFolderOpen(path: string, defaultOpen: boolean): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(() => {
    const s = loadOpenSet()
    if (s.has(path)) return true
    if (s.has(`!${path}`)) return false
    return defaultOpen
  })
  const set = useCallback((next: boolean) => {
    setOpen(next)
    const s = loadOpenSet()
    if (next) { s.add(path); s.delete(`!${path}`) }
    else { s.delete(path); if (defaultOpen) s.add(`!${path}`) }
    saveOpenSet(s)
  }, [path, defaultOpen])
  return [open, set]
}

// Klassen-Icons für die Top-Level-Folder im Agent-Workspace. Brain = Gedächtnis,
// Heart = Wesen, Cog = System, Briefcase = Arbeit.
const TOP_LEVEL_ICON: Record<string, typeof FolderClosed> = {
  brain: Brain, data: Brain, logs: Brain,
  soul: Heart,
  backend: Cog, frontend: Cog, scripts: Cog, config: Cog, certs: Cog, _local: Cog,
  work: Briefcase, jobs: Briefcase, skills: Briefcase, video: Briefcase,
}

function fsRowClass(selected: boolean, dragOver = false): string {
  if (dragOver) return 'bg-white/[0.08] ring-1 ring-[var(--t3)]/30'
  return selected ? 'hover:bg-white/[0.04]' : 'hover:bg-white/[0.06]'
}

function displayWorkspaceLabel(name: string, opts?: { root?: boolean; topLevel?: boolean }): string {
  if (opts?.root) return 'Workspace'
  return name
}

function ProjectBrowse({ path, level, onOpenFile, onArchive, label, defaultOpen, mobile, headerSlot, footerSlot, headerActionSlot }: {
  path: string; level: number; onOpenFile: (p: string) => void; onArchive?: () => void; label?: string; defaultOpen?: boolean; mobile?: boolean; headerSlot?: React.ReactNode; footerSlot?: React.ReactNode; headerActionSlot?: React.ReactNode
}) {
  const [open, setOpen] = useFolderOpen(path, defaultOpen ?? false)
  const [items, setItems] = useState<FsItem[]>([])
  const [, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bus = useContext(FsBusContext)
  const sel = useContext(FsSelContext)
  const isSelected = sel?.selected === path
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => {
    if (!sel) return
    return sel.registerFolderCtrl(path, { setOpen: (n) => setOpen(n), isOpen: () => openRef.current })
  }, [sel, path, setOpen])

  // Refresh on bus event for this path
  useEffect(() => {
    if (!bus) return
    return bus.subscribe(path, () => setTick(t => t + 1))
  }, [bus, path])

  useEffect(() => {
    if (!open) return
    fetch(`/api/files?path=${encodeURIComponent(path)}`)
      .then(r => r.json())
      .then(d => { setItems(d.files || []); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [open, path, tick])

  const folders = items.filter(f => f.type === 'folder' && !HIDDEN_FOLDERS.has(f.name) && !f.name.startsWith('.'))
  const files = items.filter(f => f.type !== 'folder' && !f.name.startsWith('.'))
  const name = label ?? (path.split('/').pop() || path)
  const displayName = level === 1 ? displayWorkspaceLabel(name, { topLevel: true }) : name
  const hasPlan = files.some(f => f.name === 'PLAN.md')
  const otherFiles = files.filter(f => f.name !== 'PLAN.md')

  const refresh = () => { bus?.bump(path); setTick(t => t + 1) }
  const refreshParent = () => { const parent = path.slice(0, path.lastIndexOf('/')); if (parent) bus?.bump(parent) }

  const handleNewFile = async () => {
    const name = window.prompt('Neue Datei (z. B. notiz.md):')?.trim()
    if (!name) return
    const res = await fsCall('/api/fs/touch', { parent: path, name })
    if (res.error) { alert(res.error); return }
    if (!open) setOpen(true)
    refresh()
  }
  const handleNewFolder = async () => {
    const name = window.prompt('Neuer Ordner:')?.trim()
    if (!name) return
    const res = await fsCall('/api/fs/mkdir', { parent: path, name })
    if (res.error) { alert(res.error); return }
    if (!open) setOpen(true)
    refresh()
  }
  const handleRename = async () => {
    const next = window.prompt('Umbenennen:', name)?.trim()
    if (!next || next === name) return
    const res = await fsCall('/api/fs/rename', { path, name: next })
    if (res.error) { alert(res.error); return }
    refreshParent()
  }
  const handleDelete = async () => {
    if (!window.confirm(`"${name}" in den Papierkorb verschieben?`)) return
    const res = await fsCall('/api/fs/delete', { path })
    if (res.error) { alert(res.error); return }
    refreshParent()
  }
  const handleDuplicate = async () => {
    const res = await fsCall('/api/fs/duplicate', { path })
    if (res.error) { alert(res.error); return }
    refreshParent()
  }
  const handleDownloadZip = () => {
    window.location.href = `/api/fs/download-zip?path=${encodeURIComponent(path)}`
  }
  const uploadFiles = async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList)
    if (!arr.length) return
    setUploading(true)
    try {
      for (const f of arr) {
        const fd = new FormData()
        fd.append('parent', path)
        fd.append('file', f)
        const r = await fetch('/api/fs/upload', { method: 'POST', body: fd })
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) alert(`Upload "${f.name}" fehlgeschlagen: ${j.error || r.statusText}`)
      }
    } finally {
      setUploading(false)
      if (!open) setOpen(true)
      refresh()
    }
  }
  const handleUploadClick = () => fileInputRef.current?.click()

  // Drag & Drop: this folder accepts drops, and it can be dragged itself (except root level=0)
  const onDragStartFolder = (e: React.DragEvent) => {
    if (level === 0) { e.preventDefault(); return }
    e.dataTransfer.setData('text/x-fs-path', path)
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
  }
  const onDragOverFolder = (e: React.DragEvent) => {
    const types = e.dataTransfer.types
    if (types.includes('text/x-fs-path') || types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = types.includes('text/x-fs-path') ? 'move' : 'copy'
      setDragOver(true)
    }
  }
  const onDragLeaveFolder = () => setDragOver(false)
  const onDropFolder = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files)
      return
    }
    const src = e.dataTransfer.getData('text/x-fs-path')
    if (!src || src === path) return
    if (path.startsWith(src + '/')) { alert('Kann Ordner nicht in sich selbst verschieben.'); return }
    const srcParent = src.slice(0, src.lastIndexOf('/'))
    if (srcParent === path) return
    const res = await fsCall('/api/fs/move', { path: src, dest: path })
    if (res.error) { alert(res.error); return }
    bus?.bump(srcParent)
    refresh()
    if (!open) setOpen(true)
  }

  // Tiefe entsteht durch verschachtelte Guided-Wrapper, Header bekommt nur pl-1.
  // Top-Level-Klassen-Icons: System / Wesen / Gedächtnis / Arbeit. Greift nur
  // bei direkten Kindern des Workspace (level === 1).
  const classIcon = level === 1 ? TOP_LEVEL_ICON[name] : undefined
  const FolderIcon = classIcon ?? (open ? FolderOpen : FolderClosed)

  return (
    <div>
      <div
        data-fs-path={path}
        data-fs-folder="true"
        data-fs-level={level}
        className={`group relative flex items-center transition-colors ${fsRowClass(Boolean(isSelected && level !== 0), dragOver)}`}
        draggable={level !== 0}
        onDragStart={onDragStartFolder}
        onDragOver={onDragOverFolder}
        onDragLeave={onDragLeaveFolder}
        onDrop={onDropFolder}
        onContextMenu={(e) => { e.preventDefault(); sel?.openCtxMenu({ x: e.clientX, y: e.clientY, path, folder: true, level, label: displayName }) }}
      >
        <button onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(!open); sel?.setSelected(path); sel?.focusContainer() }}
          className={`flex-1 flex items-center pr-3 ${level === 0 ? `pl-2 ${mobile ? 'py-3' : 'py-2'}` : `pl-1 ${mobile ? 'py-2' : 'py-[5px]'}`} info-text-body text-left cursor-pointer`}>
          <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
          <FolderIcon className={`info-icon-md mr-2 flex-shrink-0 ${isSelected && level !== 0 ? 'text-[var(--t2)]' : 'text-[var(--t3)]'}`} />
          {sel?.renaming === path
            ? <RenameInput initial={name} onCommit={(v) => sel.commitRename(path, v)} onCancel={() => sel.cancelRename()} />
            : <span className={`truncate flex-1 text-left group-hover:text-[var(--t1)] ${isSelected && level !== 0 ? 'text-[var(--t1)]' : 'text-[var(--t2)]'}`}>{displayName}</span>}
        </button>
        <div className="absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {headerActionSlot}
          <input ref={fileInputRef} type="file" multiple className="hidden"
            onChange={e => { if (e.target.files) { uploadFiles(e.target.files); e.target.value = '' } }} />
          {mobile && (
            <>
              <button onClick={e => { e.stopPropagation(); handleUploadClick() }}
                className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
                title="Datei hochladen">
                {uploading ? <Loader2 className="info-icon-sm animate-spin" /> : <Upload className="info-icon-sm" />}
              </button>
              <button onClick={e => { e.stopPropagation(); handleNewFile() }}
                className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
                title="Neue Datei">
                <Plus className="info-icon-sm" />
              </button>
            </>
          )}
          <button onClick={e => { e.stopPropagation(); handleNewFolder() }}
            className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
            title="Neuer Ordner">
            <FolderClosed className="info-icon-sm" />
          </button>
          {mobile && level !== 0 && (
            <>
              <button onClick={e => { e.stopPropagation(); handleDownloadZip() }}
                className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
                title="Als ZIP herunterladen">
                <Download className="info-icon-sm" />
              </button>
              <button onClick={e => { e.stopPropagation(); handleDuplicate() }}
                className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
                title="Duplizieren">
                <Copy className="info-icon-sm" />
              </button>
              <button onClick={e => { e.stopPropagation(); handleRename() }}
                className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
                title="Umbenennen">
                <Pencil className="info-icon-sm" />
              </button>
              <button onClick={e => { e.stopPropagation(); handleDelete() }}
                className="text-[var(--t3)] hover:text-[#ff8080] cursor-pointer p-0.5"
                title="In Papierkorb">
                <Trash2 className="info-icon-sm" />
              </button>
            </>
          )}
          {onArchive && level === 0 && (
            <button onClick={e => { e.stopPropagation(); onArchive() }}
              className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5" title="Archivieren">
              <Archive className="info-icon-sm" />
            </button>
          )}
        </div>
      </div>
      {open && (
        <Guided>
          {headerSlot}
          {folders.map(f => <ProjectBrowse key={f.path} path={f.path} level={level + 1} onOpenFile={onOpenFile} mobile={mobile} />)}
          {hasPlan && (
            <ProjectFileLeaf key={`${path}/PLAN.md`} path={`${path}/PLAN.md`} label="Plan" level={level + 1} onOpenFile={onOpenFile} />
          )}
          {otherFiles.map(f => (
            <ProjectFileLeaf key={f.path} path={f.path} label={f.name} level={level + 1} onOpenFile={onOpenFile} size={f.size} mtime={f.mtime} />
          ))}
          {footerSlot}
        </Guided>
      )}
    </div>
  )
}

function ProjectFileLeaf({ path, label, level, onOpenFile, size, mtime }: {
  path: string; label: string; level: number; onOpenFile: (p: string) => void; size?: number | null; mtime?: number | null
}) {
  const bus = useContext(FsBusContext)
  const sel = useContext(FsSelContext)
  const isSelected = sel?.selected === path
  const parent = path.slice(0, path.lastIndexOf('/'))
  const pad = 24  // Fallback; CSS überschreibt im InfoPane-Tree die echte Achse.

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/x-fs-path', path)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleRename = async () => {
    const next = window.prompt('Umbenennen:', label)?.trim()
    if (!next || next === label) return
    const res = await fsCall('/api/fs/rename', { path, name: next })
    if (res.error) { alert(res.error); return }
    bus?.bump(parent)
  }
  const handleDelete = async () => {
    if (!window.confirm(`"${label}" in den Papierkorb verschieben?`)) return
    const res = await fsCall('/api/fs/delete', { path })
    if (res.error) { alert(res.error); return }
    bus?.bump(parent)
  }
  const handleDuplicate = async () => {
    const res = await fsCall('/api/fs/duplicate', { path })
    if (res.error) { alert(res.error); return }
    bus?.bump(parent)
  }
  const handleDownload = () => {
    window.location.href = `/api/fs/download?path=${encodeURIComponent(path)}`
  }
  const meta = [formatBytes(size), formatRelTime(mtime)].filter(Boolean).join(' · ')
  const isRenaming = sel?.renaming === path
  const FileIcon = fileIcon(path.split('/').pop() || label)
  return (
    <div
      data-fs-path={path}
      data-fs-folder="false"
      data-fs-level={level}
      className={`group relative flex items-center transition-colors ${fsRowClass(Boolean(isSelected))}`}
      draggable onDragStart={onDragStart}
      onMouseEnter={(e) => sel?.onHoverEnter(path, label, e)}
      onMouseLeave={() => sel?.onHoverLeave()}
      onContextMenu={(e) => { e.preventDefault(); sel?.onHoverLeave(); sel?.openCtxMenu({ x: e.clientX, y: e.clientY, path, folder: false, level, label }) }}>
      <button onClick={() => { sel?.setSelected(path); sel?.focusContainer(); if (!isRenaming) onOpenFile(path) }}
        className={`workspace-file-row flex-1 flex items-center pr-3 info-text-body hover:text-[var(--t1)] cursor-pointer truncate ${isSelected ? 'text-[var(--t1)]' : 'text-[var(--t2)]'}`}
        style={{ paddingLeft: `${pad}px` }}>
        <FileIcon className={`info-icon-md mr-2 flex-shrink-0 ${isSelected ? 'text-[var(--t2)]' : 'text-[var(--t3)]'}`} />
        {isRenaming
          ? <RenameInput initial={label} onCommit={(v) => sel.commitRename(path, v)} onCancel={() => sel.cancelRename()} />
          : <span className="truncate flex-1 text-left">{label}</span>}
        {!isRenaming && meta && (
          <span className="ml-2 text-[12px] text-[var(--t3)] tabular-nums flex-shrink-0 group-hover:hidden">{meta}</span>
        )}
      </button>
      <div className="absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={e => { e.stopPropagation(); handleDownload() }}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5" title="Herunterladen">
          <Download className="info-icon-sm" />
        </button>
        <button onClick={e => { e.stopPropagation(); handleDuplicate() }}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5" title="Duplizieren">
          <Copy className="info-icon-sm" />
        </button>
        <button onClick={e => { e.stopPropagation(); handleRename() }}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5" title="Umbenennen">
          <Pencil className="info-icon-sm" />
        </button>
        <button onClick={e => { e.stopPropagation(); handleDelete() }}
          className="text-[var(--t3)] hover:text-[#ff8080] cursor-pointer p-0.5" title="In Papierkorb">
          <Trash2 className="info-icon-sm" />
        </button>
      </div>
    </div>
  )
}

// ── Listen-Modus: flach im aktuellen Folder, sortierbar nach Name/Größe/Datum.
// Spalten-Header sind klickbar, ein zweiter Klick auf dieselbe Spalte dreht die Richtung.
function FsListView({ cwd, sortKey, sortDesc, onSort, onOpenFolder, onOpenFile, mobile }: {
  cwd: string; sortKey: 'name' | 'mtime' | 'size'; sortDesc: boolean;
  onSort: (k: 'name' | 'mtime' | 'size') => void;
  onOpenFolder: (p: string) => void; onOpenFile: (p: string) => void; mobile?: boolean
}) {
  const [items, setItems] = useState<FsItem[]>([])
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const bus = useContext(FsBusContext)
  const sel = useContext(FsSelContext)

  useEffect(() => {
    if (!bus) return
    return bus.subscribe(cwd, () => setTick(t => t + 1))
  }, [bus, cwd])

  useEffect(() => {
    setLoading(true)
    fetch(`/api/files?path=${encodeURIComponent(cwd)}`)
      .then(r => r.json())
      .then(d => setItems(d.files || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [cwd, tick])

  const visible = items.filter(f => !f.name.startsWith('.') && !HIDDEN_FOLDERS.has(f.name))
  const sorted = [...visible].sort((a, b) => {
    // Folder immer vor Dateien (macOS-Default), innerhalb dann nach gewählter Spalte.
    const af = a.type === 'folder' ? 0 : 1
    const bf = b.type === 'folder' ? 0 : 1
    if (af !== bf) return af - bf
    let cmp = 0
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name)
    else if (sortKey === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0)
    else if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0)
    return sortDesc ? -cmp : cmp
  })

  const Sorter = ({ k, label, w, right }: { k: 'name' | 'mtime' | 'size'; label: string; w: string; right?: boolean }) => (
    <button onClick={() => onSort(k)}
      className={`flex items-center gap-1 px-2 py-1 info-text-meta text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer ${right ? 'justify-end' : ''}`}
      style={{ width: w, flexShrink: 0 }}>
      {sortKey === k && (sortDesc
        ? <ArrowDown className="info-icon-sm" />
        : <ArrowUp className="info-icon-sm" />)}
      <span className="uppercase tracking-wider">{label}</span>
    </button>
  )

  return (
    <div>
      <div className="flex items-center px-2 py-1 border-b border-[var(--border)]/30 sticky top-[88px] bg-[var(--bg)]/95 backdrop-blur-sm z-[5]">
        <Sorter k="name" label="Name" w="auto" />
        <div className="flex-1" />
        <Sorter k="size" label="Größe" w="80px" right />
        <Sorter k="mtime" label="Geändert" w="120px" right />
      </div>
      {loading && <div className="info-text-body text-[var(--t3)] px-3 py-4">Lade…</div>}
      {!loading && sorted.length === 0 && (
        <div className="info-text-body text-[var(--t3)] px-3 py-4 italic">Leer.</div>
      )}
      {sorted.map(it => {
        const isSelected = sel?.selected === it.path
        const isTopLevel = cwd === '/Users/klaus/agent' && it.type === 'folder'
        const displayName = isTopLevel ? displayWorkspaceLabel(it.name, { topLevel: true }) : it.name
        const Icon = it.type === 'folder'
          ? (isTopLevel && TOP_LEVEL_ICON[it.name] ? TOP_LEVEL_ICON[it.name] : FolderClosed)
          : fileIcon(it.name)
        return (
          <div key={it.path}
            data-fs-path={it.path}
            data-fs-folder={it.type === 'folder' ? 'true' : 'false'}
            data-fs-level={0}
            className={`group relative flex items-center transition-colors ${fsRowClass(Boolean(isSelected))}`}
            onMouseEnter={(e) => { if (it.type !== 'folder') sel?.onHoverEnter(it.path, it.name, e) }}
            onMouseLeave={() => sel?.onHoverLeave()}
            onContextMenu={(e) => { e.preventDefault(); sel?.onHoverLeave(); sel?.openCtxMenu({ x: e.clientX, y: e.clientY, path: it.path, folder: it.type === 'folder', level: 0, label: displayName }) }}
            onClick={() => {
              sel?.setSelected(it.path); sel?.focusContainer()
              if (it.type === 'folder') onOpenFolder(it.path); else onOpenFile(it.path)
            }}>
            <div className={`flex items-center gap-2 px-2 ${mobile ? 'py-2' : 'py-[6px]'} flex-1 min-w-0 cursor-pointer info-text-body hover:text-[var(--t1)] ${isSelected ? 'text-[var(--t1)]' : 'text-[var(--t2)]'}`}>
              <Icon className={`info-icon-sm ${it.type === 'folder' ? 'text-[var(--cc-orange)]' : isSelected ? 'text-[var(--t2)]' : 'text-[var(--t3)]'} flex-shrink-0`} />
              <span className="truncate flex-1">{displayName}</span>
            </div>
            <div className="info-text-meta text-[var(--t3)] tabular-nums text-right pr-2" style={{ width: '80px', flexShrink: 0 }}>
              {it.type === 'folder' ? '—' : formatBytes(it.size)}
            </div>
            <div className="info-text-meta text-[var(--t3)] tabular-nums text-right pr-3" style={{ width: '120px', flexShrink: 0 }}>
              {formatRelTime(it.mtime)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Workspace Tree (with filter) ──

export function WorkspaceTree({ onOpenFile, mobile, fullMode, onToggleFull, initialPath }: { onOpenFile: (p: string) => void; mobile?: boolean; fullMode?: boolean; onToggleFull?: () => void; initialPath?: string | null }) {
  // cwd: aktueller Ordner für Breadcrumb und Listen-Modus.
  const ROOT = '/Users/klaus/agent'
  const ROOT_LABEL = 'Workspace'
  const [cwd, setCwd] = useState<string>(() => {
    // Vollmodus (Workspace) startet immer bei der Ordnerübersicht, nicht im letzten Zustand.
    if (fullMode) return initialPath && initialPath.startsWith(ROOT) ? initialPath : ROOT
    try { return localStorage.getItem('infopane:fs:cwd') || ROOT } catch { return ROOT }
  })
  const setCwdPersist = useCallback((p: string) => {
    setCwd(p)
    try { localStorage.setItem('infopane:fs:cwd', p) } catch {}
  }, [])
  useEffect(() => {
    if (!initialPath) return
    if (!initialPath.startsWith(ROOT)) return
    setCwdPersist(initialPath)
  }, [initialPath, setCwdPersist])
  type SortKey = 'name' | 'mtime' | 'size'
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    try { const v = localStorage.getItem('infopane:fs:sortKey'); if (v === 'name' || v === 'mtime' || v === 'size') return v } catch {}
    return 'name'
  })
  const [sortDesc, setSortDesc] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:fs:sortDesc') === '1' } catch { return false }
  })
  const setSort = useCallback((k: SortKey) => {
    setSortKey(prev => {
      if (prev === k) {
        setSortDesc(d => { const next = !d; try { localStorage.setItem('infopane:fs:sortDesc', next ? '1' : '0') } catch {}; return next })
        return prev
      }
      try { localStorage.setItem('infopane:fs:sortKey', k); localStorage.setItem('infopane:fs:sortDesc', '0') } catch {}
      setSortDesc(false)
      return k
    })
  }, [])
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [debounced, setDebounced] = useState('')
  const [results, setResults] = useState<FsItem[]>([])
  const [searching, setSearching] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const bus = useContext(FsBusContext)
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus() }, [searchOpen])

  // ── Selektion + Tastatur ──
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelectedState] = useState<string | null>(() => {
    try { return localStorage.getItem('infopane:fs:selected') } catch { return null }
  })
  const setSelected = useCallback((p: string | null) => {
    setSelectedState(p)
    try { if (p) localStorage.setItem('infopane:fs:selected', p); else localStorage.removeItem('infopane:fs:selected') } catch {}
  }, [])
  const focusContainer = useCallback(() => { containerRef.current?.focus({ preventScroll: true }) }, [])
  const folderCtrls = useRef(new Map<string, { setOpen: (next: boolean) => void; isOpen: () => boolean }>())
  const registerFolderCtrl = useCallback((path: string, ctrl: { setOpen: (next: boolean) => void; isOpen: () => boolean }) => {
    folderCtrls.current.set(path, ctrl)
    return () => { folderCtrls.current.delete(path) }
  }, [])
  const isFolderOpen = useCallback((p: string) => folderCtrls.current.get(p)?.isOpen() ?? false, [])
  const toggleFolder = useCallback((p: string, next?: boolean) => {
    const c = folderCtrls.current.get(p); if (!c) return
    c.setOpen(typeof next === 'boolean' ? next : !c.isOpen())
  }, [])
  const trashPath = useCallback(async (p: string, label: string) => {
    if (!window.confirm(`"${label}" in den Papierkorb verschieben?`)) return
    const res = await fsCall('/api/fs/delete', { path: p })
    if (res.error) { alert(res.error); return }
    const parent = p.slice(0, p.lastIndexOf('/'))
    bus?.bump(parent)
  }, [bus])

  // ── Inline-Rename ──
  const [renaming, setRenaming] = useState<string | null>(null)
  const startRename = useCallback((p: string) => {
    if (p === '/Users/klaus/agent') return // Root nicht umbenennen
    setRenaming(p)
  }, [])
  const cancelRename = useCallback(() => setRenaming(null), [])
  const commitRename = useCallback(async (p: string, newLabel: string) => {
    const trimmed = newLabel.trim()
    const cur = p.split('/').pop() || ''
    if (!trimmed || trimmed === cur) { setRenaming(null); return }
    const res = await fsCall('/api/fs/rename', { path: p, name: trimmed })
    if (res.error) { alert(res.error); setRenaming(null); return }
    const parent = p.slice(0, p.lastIndexOf('/'))
    setRenaming(null)
    if (res.path) setSelected(res.path)
    bus?.bump(parent)
  }, [bus, setSelected])

  // ── Hover-Vorschau ──
  const [hoverPreview, setHoverPreview] = useState<{ path: string; x: number; y: number } | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const onHoverEnter = useCallback((path: string, name: string, e: React.MouseEvent) => {
    if (!isHoverPreviewable(name)) return
    const x = e.clientX, y = e.clientY
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHoverPreview({ path, x, y }), 350)
  }, [])
  const onHoverLeave = useCallback(() => {
    if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null }
    setHoverPreview(null)
  }, [])
  useEffect(() => () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current) }, [])

  // ── Rechtsklick-Kontextmenü ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; folder: boolean; level: number; label: string } | null>(null)
  const openCtxMenu = useCallback((info: { x: number; y: number; path: string; folder: boolean; level: number; label: string }) => {
    setCtxMenu(info); setSelected(info.path)
  }, [setSelected])
  const closeCtxMenu = useCallback(() => setCtxMenu(null), [])
  useEffect(() => {
    if (!ctxMenu) return
    const onDocClick = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey) }
  }, [ctxMenu])

  const ctxNewFile = async (parentPath: string) => {
    const name = window.prompt('Neue Datei:')?.trim(); if (!name) return
    const res = await fsCall('/api/fs/touch', { parent: parentPath, name })
    if (res.error) { alert(res.error); return }
    folderCtrls.current.get(parentPath)?.setOpen(true)
    bus?.bump(parentPath)
  }
  const ctxNewFolder = async (parentPath: string) => {
    const name = window.prompt('Neuer Ordner:')?.trim(); if (!name) return
    const res = await fsCall('/api/fs/mkdir', { parent: parentPath, name })
    if (res.error) { alert(res.error); return }
    folderCtrls.current.get(parentPath)?.setOpen(true)
    bus?.bump(parentPath)
  }
  const ctxDuplicate = async (p: string) => {
    const res = await fsCall('/api/fs/duplicate', { path: p })
    if (res.error) { alert(res.error); return }
    bus?.bump(p.slice(0, p.lastIndexOf('/')))
  }
  const ctxCopyPath = async (p: string) => {
    try { await navigator.clipboard.writeText(p) } catch { alert('Clipboard nicht verfügbar') }
  }
  const ctxRevealParent = (p: string) => {
    const parent = p.slice(0, p.lastIndexOf('/'))
    setSelected(parent || p)
  }

  // Liste der gerade sichtbaren Items aus dem DOM lesen — folgt automatisch der
  // Reihenfolge, in der ProjectBrowse/ProjectFileLeaf rendern. Spart eine
  // separate Datenstruktur.
  const visibleItems = useCallback((): { path: string; folder: boolean; el: HTMLElement }[] => {
    const root = containerRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[data-fs-path]')).map(el => ({
      path: el.dataset.fsPath || '',
      folder: el.dataset.fsFolder === 'true',
      el,
    }))
  }, [])
  const scrollIntoView = (el: HTMLElement) => {
    el.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Suchfeld nicht kapern
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return

    const items = visibleItems()
    if (items.length === 0) return
    const idx = selected ? items.findIndex(i => i.path === selected) : -1
    const cur = idx >= 0 ? items[idx] : null

    if (e.key === 'ArrowDown') {
      const next = items[Math.min(items.length - 1, idx < 0 ? 0 : idx + 1)]
      setSelected(next.path); scrollIntoView(next.el); e.preventDefault(); return
    }
    if (e.key === 'ArrowUp') {
      const next = items[Math.max(0, idx < 0 ? 0 : idx - 1)]
      setSelected(next.path); scrollIntoView(next.el); e.preventDefault(); return
    }
    if (e.key === 'ArrowRight') {
      if (!cur) return
      if (cur.folder) {
        if (!isFolderOpen(cur.path)) { toggleFolder(cur.path, true); e.preventDefault(); return }
        // schon offen → springe ins erste Kind, falls vorhanden
        const child = items.find((it, j) => j > idx && it.path.startsWith(cur.path + '/'))
        if (child) { setSelected(child.path); scrollIntoView(child.el) }
        e.preventDefault(); return
      }
      e.preventDefault(); return
    }
    if (e.key === 'ArrowLeft') {
      if (!cur) return
      if (cur.folder && isFolderOpen(cur.path)) { toggleFolder(cur.path, false); e.preventDefault(); return }
      const parent = parentOf(cur.path)
      const p = items.find(it => it.path === parent)
      if (p) { setSelected(p.path); scrollIntoView(p.el) }
      e.preventDefault(); return
    }
    if (e.key === 'Enter') {
      if (!cur) return
      if (cur.folder) toggleFolder(cur.path)
      else onOpenFile(cur.path)
      e.preventDefault(); return
    }
    if (e.key === ' ') {
      // Quick-Look-Platzhalter: öffnet aktuell wie Enter, kann später eine
      // leichtere Vorschau bekommen.
      if (!cur) return
      if (cur.folder) toggleFolder(cur.path)
      else onOpenFile(cur.path)
      e.preventDefault(); return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (!cur) return
      const label = cur.path.split('/').pop() || cur.path
      // Root nicht löschen
      if (cur.path === '/Users/klaus/agent') return
      trashPath(cur.path, label)
      e.preventDefault(); return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
      if (!cur) return
      const parent = parentOf(cur.path)
      const p = items.find(it => it.path === parent)
      if (p) { setSelected(p.path); scrollIntoView(p.el) }
      e.preventDefault(); return
    }
    if (e.key === 'Escape') {
      setSelected(null); e.preventDefault(); return
    }
    if (e.key === 'F2') {
      if (cur) { startRename(cur.path); e.preventDefault(); return }
    }
  }

  const selCtx = useMemo<FsSelCtx>(() => ({
    selected, setSelected, focusContainer, registerFolderCtrl, toggleFolder, isFolderOpen, openFile: onOpenFile, trashPath,
    renaming, startRename, cancelRename, commitRename, openCtxMenu, onHoverEnter, onHoverLeave,
  }), [selected, setSelected, focusContainer, registerFolderCtrl, toggleFolder, isFolderOpen, onOpenFile, trashPath, renaming, startRename, cancelRename, commitRename, openCtxMenu, onHoverEnter, onHoverLeave])

  useEffect(() => {
    const id = setTimeout(() => setDebounced(filter.trim()), 200)
    return () => clearTimeout(id)
  }, [filter])

  useEffect(() => {
    if (!debounced) { setResults([]); setTruncated(false); return }
    setSearching(true)
    fetch(`/api/fs/find?q=${encodeURIComponent(debounced)}&limit=300`)
      .then(r => r.json())
      .then(d => { setResults(d.items || []); setTruncated(!!d.truncated) })
      .catch(() => setResults([]))
      .finally(() => setSearching(false))
  }, [debounced])

  const header = (
    <>
      {searchOpen && (
      <div className="workspace-search-row flex items-center gap-2 py-[5px] pr-3">
        <Search className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
        <input
          ref={searchInputRef}
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { setFilter(''); setSearchOpen(false) } }}
          placeholder="Im Workspace suchen…"
          className="flex-1 bg-transparent border-none outline-none info-text-body text-[var(--t1)] placeholder:text-[var(--t3)]/60"
        />
        <button onClick={() => { setFilter(''); setSearchOpen(false) }} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer">
          <X className="info-icon-sm" />
        </button>
      </div>
      )}
      {debounced && (
        <div className="border-y border-[var(--border)]/30 bg-black/20">
          {searching && <div className="workspace-search-row info-text-body text-[var(--t3)] py-2">Suche…</div>}
          {!searching && results.length === 0 && (
            <div className="workspace-search-row info-text-body text-[var(--t3)] py-2">Keine Treffer.</div>
          )}
          {results.map(it => {
            const rel = it.path.replace('/Users/klaus/agent/', '~/agent/')
            const meta = [formatBytes(it.size), formatRelTime(it.mtime)].filter(Boolean).join(' · ')
            const ResultIcon = it.type === 'folder' ? FolderClosed : fileIcon(it.name)
            return (
              <div key={it.path} className="group relative flex items-center hover:bg-white/[0.06] transition-colors">
                <button
                  onClick={() => it.type === 'file' ? onOpenFile(it.path) : undefined}
                  className="flex-1 flex items-center gap-2 pr-3 py-[7px] info-text-body text-[var(--t2)] hover:text-[var(--t1)] cursor-pointer text-left truncate"
                >
                  <ResultIcon className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                  <span className="truncate flex-1">{rel}</span>
                  {meta && <span className="text-[12px] text-[var(--t3)] tabular-nums flex-shrink-0">{meta}</span>}
                </button>
                <div className="absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {it.type === 'file' && (
                    <button onClick={e => { e.stopPropagation(); window.location.href = `/api/fs/download?path=${encodeURIComponent(it.path)}` }}
                      className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5" title="Herunterladen">
                      <Download className="info-icon-sm" />
                    </button>
                  )}
                  <button onClick={async e => {
                    e.stopPropagation()
                    if (!window.confirm(`"${it.name}" in den Papierkorb verschieben?`)) return
                    const res = await fsCall('/api/fs/delete', { path: it.path })
                    if (res.error) { alert(res.error); return }
                    setResults(rs => rs.filter(r => r.path !== it.path))
                    const parent = it.path.slice(0, it.path.lastIndexOf('/'))
                    bus?.bump(parent)
                  }}
                    className="text-[var(--t3)] hover:text-[#ff8080] cursor-pointer p-0.5" title="In Papierkorb">
                    <Trash2 className="info-icon-sm" />
                  </button>
                </div>
              </div>
            )
          })}
          {truncated && (
            <div className="workspace-search-row info-text-body text-[var(--t3)] py-2 italic">… weitere Treffer ausgeblendet, Suche verfeinern.</div>
          )}
        </div>
      )}
    </>
  )

  // Esc verlässt Vollbild-Modus, wenn nichts selektiert ist (sonst Selektion-Clear vorgehen lassen).
  useEffect(() => {
    if (!fullMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !selected && !ctxMenu && !renaming) {
        e.preventDefault(); onToggleFull?.()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fullMode, selected, ctxMenu, renaming, onToggleFull])

  // Breadcrumb-Pfadteile relativ zum Workspace-Root.
  const crumbs = (() => {
    const rel = cwd.startsWith(ROOT) ? cwd.slice(ROOT.length) : ''
    const parts = rel.split('/').filter(Boolean)
    const items: { label: string; path: string }[] = [{ label: displayWorkspaceLabel(ROOT, { root: true }), path: ROOT }]
    let acc = ROOT
    for (const [index, p] of parts.entries()) {
      acc = acc + '/' + p
      items.push({ label: index === 0 ? displayWorkspaceLabel(p, { topLevel: true }) : p, path: acc })
    }
    return items
  })()

  const TopBar = fullMode ? (
    <div className="sticky top-0 z-10 bg-[var(--bg)]/95 backdrop-blur-sm border-b border-[var(--border)]/40">
      {/* Reihe 1: Breadcrumb + Schließen */}
      <div className="flex items-center gap-1 px-3 py-2 min-w-0">
        <button onClick={() => setCwdPersist(ROOT)}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 p-1"
          title="Zum Workspace-Root">
          <Home className="info-icon-sm" />
        </button>
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto scrollbar-none">
          {crumbs.map((c, i) => (
            <Fragment key={c.path}>
              {i > 0 && <ChevronRight className="info-icon-sm text-[var(--t3)]/50 flex-shrink-0" />}
              <button onClick={() => setCwdPersist(c.path)}
                className={`px-1.5 py-0.5 rounded info-text-body cursor-pointer flex-shrink-0 ${i === crumbs.length - 1 ? 'text-[var(--t1)] font-medium' : 'text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06]'}`}>
                {c.label}
              </button>
            </Fragment>
          ))}
        </div>
        <button onClick={onToggleFull}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 p-1"
          title="Vollbild verlassen (Esc)">
          <X className="info-icon-md" />
        </button>
      </div>
      {/* Reihe 2: Aktionen (Ordner anlegen, löschen) + globale Suche */}
      <div className="flex items-center gap-1 px-3 pb-2">
        <button onClick={() => ctxNewFolder(cwd)}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 p-1"
          title="Neuer Ordner">
          <FolderPlus className="info-icon-sm" />
        </button>
        <button onClick={async () => {
          if (!selected) return
          await trashPath(selected, selected.split('/').pop() || selected)
          setSelected(null)
        }}
          disabled={!selected}
          className="text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-30 disabled:hover:text-[var(--t3)] cursor-pointer flex-shrink-0 p-1"
          title="Auswahl in den Papierkorb">
          <Trash2 className="info-icon-sm" />
        </button>
        <div className="flex-1" />
        <button onClick={() => window.dispatchEvent(new CustomEvent('deck:openSearch'))}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-1"
          title="Alles durchsuchen">
          <Search className="info-icon-sm" />
        </button>
      </div>
    </div>
  ) : null

  return (
    <FsSelContext.Provider value={selCtx}>
      <div ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} className="workspace-tree outline-none">
        {TopBar}
        {fullMode ? (
          <FsListView
            cwd={cwd}
            sortKey={sortKey}
            sortDesc={sortDesc}
            onSort={setSort}
            onOpenFolder={(p) => setCwdPersist(p)}
            onOpenFile={(p) => onOpenFile(p)}
            mobile={mobile}
          />
        ) : (
          <ProjectBrowse
            key={fullMode ? cwd : ROOT}
            path={fullMode ? cwd : ROOT}
            level={0}
            onOpenFile={onOpenFile}
            label={fullMode ? (cwd === ROOT ? ROOT_LABEL : (cwd.split('/').pop() || cwd)) : ROOT_LABEL}
            defaultOpen={fullMode ? true : false}
            mobile={mobile}
            headerSlot={header}
            footerSlot={fullMode ? null : <TrashSection mobile={mobile} indent />}
            headerActionSlot={
              <>
                {mobile && !fullMode && (
                  <button
                    onClick={e => { e.stopPropagation(); onToggleFull?.() }}
                    className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5"
                    title="Vollbild öffnen">
                    <Maximize2 className="info-icon-sm" />
                  </button>
                )}
                <button
                  onClick={e => { e.stopPropagation(); setSearchOpen(v => !v) }}
                  className={`cursor-pointer p-0.5 ${searchOpen ? 'text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
                  title="Im Workspace suchen">
                  <Search className="info-icon-sm" />
                </button>
              </>
            }
          />
        )}
      </div>
      {ctxMenu && (() => {
        const isRoot = ctxMenu.path === '/Users/klaus/agent'
        const parentPath = ctxMenu.folder ? ctxMenu.path : ctxMenu.path.slice(0, ctxMenu.path.lastIndexOf('/'))
        const Item = ({ icon: Icon, label, onClick, danger }: { icon: typeof FileText; label: string; onClick: () => void; danger?: boolean }) => (
          <button
            onClick={(e) => { e.stopPropagation(); closeCtxMenu(); onClick() }}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left info-text-body hover:bg-white/[0.08] cursor-pointer ${danger ? 'text-[#ff8080] hover:text-[#ff9999]' : 'text-[var(--t2)] hover:text-[var(--t1)]'}`}>
            <Icon className="info-icon-sm flex-shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        )
        const Sep = () => <div className="my-1 border-t border-[var(--border)]/40" />
        // Position fenster-grenzen-bewusst klemmen.
        const W = 220, H = 320
        const x = Math.min(ctxMenu.x, window.innerWidth - W - 8)
        const y = Math.min(ctxMenu.y, window.innerHeight - H - 8)
        return (
          <div
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
            className="fixed z-[90] bg-[var(--bg-2)] border border-[var(--border)] rounded-md shadow-xl py-1"
            style={{ left: x, top: y, width: W }}>
            {ctxMenu.folder
              ? <Item icon={FolderOpen} label={isFolderOpen(ctxMenu.path) ? 'Schließen' : 'Öffnen'} onClick={() => toggleFolder(ctxMenu.path)} />
              : <Item icon={FileText} label="Öffnen" onClick={() => onOpenFile(ctxMenu.path)} />}
            {!isRoot && <Item icon={Pencil} label="Umbenennen" onClick={() => startRename(ctxMenu.path)} />}
            {!isRoot && <Item icon={Copy} label="Duplizieren" onClick={() => ctxDuplicate(ctxMenu.path)} />}
            {ctxMenu.folder
              ? <Item icon={Download} label="Als ZIP laden" onClick={() => { window.location.href = `/api/fs/download-zip?path=${encodeURIComponent(ctxMenu.path)}` }} />
              : <Item icon={Download} label="Herunterladen" onClick={() => { window.location.href = `/api/fs/download?path=${encodeURIComponent(ctxMenu.path)}` }} />}
            {!isRoot && <Sep />}
            {!isRoot && <Item icon={Trash2} label="In Papierkorb" onClick={() => trashPath(ctxMenu.path, ctxMenu.label)} danger />}
            <Sep />
            <Item icon={Plus} label="Neue Datei" onClick={() => ctxNewFile(parentPath)} />
            <Item icon={FolderClosed} label="Neuer Ordner" onClick={() => ctxNewFolder(parentPath)} />
            <Sep />
            <Item icon={ChevronRight} label="Pfad kopieren" onClick={() => ctxCopyPath(ctxMenu.path)} />
            {!ctxMenu.folder && <Item icon={ChevronLeft} label="Im Tree zeigen" onClick={() => ctxRevealParent(ctxMenu.path)} />}
          </div>
        )
      })()}
      {hoverPreview && (() => {
        const W = 240, H = 240
        const margin = 16
        // Bevorzugt rechts neben Maus, kippt nach links wenn rechts kein Platz.
        let x = hoverPreview.x + margin
        if (x + W > window.innerWidth - 8) x = Math.max(8, hoverPreview.x - W - margin)
        let y = hoverPreview.y - H / 2
        if (y < 8) y = 8
        if (y + H > window.innerHeight - 8) y = window.innerHeight - H - 8
        return (
          <div
            className="fixed z-[85] pointer-events-none bg-[var(--bg-2)] border border-[var(--border)] rounded-md shadow-xl p-1.5"
            style={{ left: x, top: y, width: W }}>
            <img
              src={`/api/fs/download?path=${encodeURIComponent(hoverPreview.path)}&inline=1`}
              alt=""
              className="block w-full h-auto max-h-[220px] object-contain rounded-sm"
              draggable={false}
            />
          </div>
        )
      })()}
    </FsSelContext.Provider>
  )
}
