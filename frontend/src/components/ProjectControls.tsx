import { useState, useEffect, useRef } from 'react'
import { FolderOpen } from 'lucide-react'

export interface ProjectRef {
  id: string
  name: string
}

export function InProjectButton({ currentProjectId, projects, onSelect, align = 'right' }: {
  currentProjectId?: string
  projects: ProjectRef[]
  onSelect: (projectId: string) => void
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        className="p-1.5 hover:bg-white/[0.08] text-[var(--t2)] hover:text-[var(--t1)] transition-colors cursor-pointer"
        title="In Projekt"
      >
        <FolderOpen className="w-[20px] h-[20px]" />
      </button>
      {open && (
        <div
          className={`absolute top-full mt-1 z-[70] bg-[var(--bg-2)] border border-[var(--border-f)] py-1 min-w-[180px] max-h-[320px] overflow-y-auto shadow-[0_8px_30px_rgba(0,0,0,0.5)] animate-[fadeIn_0.08s_ease] ${align === 'right' ? 'right-0' : 'left-0'}`}
          onClick={e => e.stopPropagation()}
        >
          {currentProjectId && (
            <>
              <button
                onClick={() => { onSelect(''); setOpen(false) }}
                className="w-full text-left px-3 py-1.5 text-[14px] text-[var(--t3)] hover:bg-white/[0.06] hover:text-[var(--t1)] cursor-pointer transition-colors"
              >
                Kein Projekt
              </button>
              <div className="h-px bg-[var(--border)] my-0.5" />
            </>
          )}
          {projects.length === 0 ? (
            <div className="px-3 py-1.5 text-[14px] text-[var(--t3)]/60">Keine Projekte</div>
          ) : (
            projects.map(p => (
              <button
                key={p.id}
                onClick={() => { onSelect(p.id); setOpen(false) }}
                className={`w-full text-left px-3 py-1.5 text-[14px] hover:bg-white/[0.06] cursor-pointer transition-colors truncate ${
                  currentProjectId === p.id ? 'text-[var(--t1)] bg-white/[0.04]' : 'text-[var(--t2)] hover:text-[var(--t1)]'
                }`}
              >
                {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function ProjectCreateModal({ onCreate, onClose }: {
  onCreate: (name: string) => Promise<string | null>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    await onCreate(trimmed)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-[460px] max-w-[90vw] bg-[var(--bg-2)] border border-[var(--border-f)] shadow-[0_20px_60px_rgba(0,0,0,0.6)] animate-[fadeIn_0.12s_ease]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-[var(--border)]">
          <h3 className="text-[18px] text-[var(--t1)] font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Neues Projekt</h3>
          <p className="text-[14px] text-[var(--t3)] mt-1">Gib dem Projekt einen Namen. Zugeordnete Chats erscheinen darunter.</p>
        </div>
        <div className="px-6 py-5">
          <input
            ref={inputRef}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="Projektname"
            className="w-full bg-[var(--bg-3)] border border-[var(--border)] focus:border-[var(--border-f)] outline-none text-[16px] text-[var(--t1)] placeholder:text-[var(--t3)]/50 px-3 py-2 transition-colors"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[15px] text-[var(--t2)] hover:text-[var(--t1)] cursor-pointer transition-colors"
          >
            Abbrechen
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || submitting}
            className={`px-4 py-1.5 text-[15px] transition-colors ${
              name.trim() && !submitting
                ? 'bg-[var(--warm)] text-[var(--bg)] hover:opacity-90 cursor-pointer'
                : 'bg-white/[0.06] text-[var(--t3)] cursor-not-allowed'
            }`}
          >
            Anlegen
          </button>
        </div>
      </div>
    </div>
  )
}
