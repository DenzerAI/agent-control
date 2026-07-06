import { useState, useEffect, useContext } from 'react'
import { ChevronRight, Trash2, FolderClosed, ArchiveRestore, X } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { formatBytes, formatRelTime } from '../utils/format'
import { FsBusContext, fsCall } from '../utils/fsBus'
import { Guided } from '../utils/tree'

interface TrashItem {
  trash_path: string
  name: string
  original_path: string | null
  deleted_at: number | null
  type: string
  size: number | null
  mtime: number | null
}

export function TrashSection({ mobile, indent }: { mobile?: boolean; indent?: boolean }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<TrashItem[]>([])
  const [tick, setTick] = useState(0)
  const bus = useContext(FsBusContext)

  useEffect(() => {
    if (!open) return
    fetch('/api/fs/trash').then(r => r.json()).then(d => setItems(d.items || [])).catch(() => {})
  }, [open, tick])

  const refresh = () => setTick(t => t + 1)

  const handleRestore = async (it: TrashItem) => {
    const res = await fsCall('/api/fs/trash/restore', { trash_path: it.trash_path })
    if (res.error) { alert(res.error); return }
    refresh()
    if (res.path) {
      const parent = res.path.slice(0, res.path.lastIndexOf('/'))
      bus?.bump(parent)
    }
  }
  const handleHardDelete = async (it: TrashItem) => {
    if (!window.confirm(`"${it.name}" endgültig löschen? Das ist nicht rückgängig.`)) return
    const res = await fsCall('/api/fs/trash/delete', { trash_path: it.trash_path })
    if (res.error) { alert(res.error); return }
    refresh()
  }
  const handleEmpty = async () => {
    if (!items.length) return
    if (!window.confirm(`Papierkorb leeren? ${items.length} Eintrag/Einträge werden endgültig gelöscht.`)) return
    const res = await fsCall('/api/fs/trash/empty', {})
    if (res.error) { alert(res.error); return }
    refresh()
  }

  return (
    <div>
      <div className="group relative flex items-center hover:bg-white/[0.06] transition-colors">
        <button onClick={() => { setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v }) }}
          className={`flex-1 flex items-center pr-3 pl-2 ${indent ? (mobile ? 'py-2' : 'py-[5px]') : (mobile ? 'py-3' : 'py-1.5')} info-text-body text-left cursor-pointer`}>
          <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
          <Trash2 className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
          <span className="truncate flex-1 text-left text-[var(--t2)] group-hover:text-[var(--t1)]">Papierkorb</span>
          {items.length > 0 && open && (
            <span className="text-[13px] text-[var(--t3)] tabular-nums pl-2">{items.length}</span>
          )}
        </button>
        {open && items.length > 0 && (
          <div className="absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={e => { e.stopPropagation(); handleEmpty() }}
              className="text-[var(--t3)] hover:text-[#ff8080] cursor-pointer p-0.5"
              title="Papierkorb leeren">
              <Trash2 className="info-icon-sm" />
            </button>
          </div>
        )}
      </div>
      {open && (
        <Guided>
          {items.length === 0 && (
            <div className="info-text-body text-[var(--t3)] py-2 pl-1">leer</div>
          )}
          {items.map(it => {
            const meta = [formatBytes(it.size), formatRelTime(it.deleted_at || it.mtime)].filter(Boolean).join(' · ')
            const origin = it.original_path ? it.original_path.replace(`${'/workspace/'}`, '~/workspace/') : ''
            return (
              <div key={it.trash_path} className="group relative flex items-center hover:bg-white/[0.06] transition-colors">
                <div className="flex-1 flex items-center pr-3 pl-1 py-[7px] info-text-body text-[var(--t2)] truncate">
                  {it.type === 'folder' ? <FolderClosed className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" /> : null}
                  <span className="truncate flex-1 text-left">
                    {it.name}
                    {origin && <span className="text-[12px] text-[var(--t3)] ml-2">{origin}</span>}
                  </span>
                  {meta && (
                    <span className="ml-2 text-[12px] text-[var(--t3)] tabular-nums flex-shrink-0 group-hover:hidden">{meta}</span>
                  )}
                </div>
                <div className="absolute right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={e => { e.stopPropagation(); handleRestore(it) }}
                    className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5" title="Wiederherstellen">
                    <ArchiveRestore className="info-icon-sm" />
                  </button>
                  <button onClick={e => { e.stopPropagation(); handleHardDelete(it) }}
                    className="text-[var(--t3)] hover:text-[#ff8080] cursor-pointer p-0.5" title="Endgültig löschen">
                    <X className="info-icon-sm" />
                  </button>
                </div>
              </div>
            )
          })}
        </Guided>
      )}
    </div>
  )
}
