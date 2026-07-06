import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, ShieldAlert, X } from 'lucide-react'
import { playUISound } from '../../../uiSounds'

interface ToolApproval {
  id: number
  ts: number
  status: string
  tool_name: string
  risk: string
  sandbox: string
  reason: string
  arguments?: Record<string, unknown>
}

function shortTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function formatArgs(args: Record<string, unknown> | undefined): string {
  try {
    const text = JSON.stringify(args || {}, null, 2)
    return text.length > 420 ? `${text.slice(0, 420)}…` : text
  } catch {
    return '{}'
  }
}

export function ToolApprovalsSection({ mobile }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ToolApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tools/approvals?status=pending&limit=50', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data?.approvals) ? data.approvals : [])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 10000)
    return () => window.clearInterval(id)
  }, [load])

  useEffect(() => {
    const onSection = (e: Event) => {
      const section = String((e as CustomEvent).detail?.section || '')
      if (section === 'tool-approvals') setOpen(true)
    }
    window.addEventListener('deck:info-section', onSection)
    return () => window.removeEventListener('deck:info-section', onSection)
  }, [])

  const decide = async (id: number, decision: 'approved' | 'denied') => {
    setBusyId(id)
    try {
      const res = await fetch(`/api/tools/approvals/${id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, decided_by: 'owner', execute: decision === 'approved' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      playUISound(decision === 'approved' ? 'send' : 'section-close', 0.45)
      setItems(prev => prev.filter(item => item.id !== id))
      const failed = data?.approval?.status === 'failed'
      setError(failed ? (data?.approval?.execution_error || 'Ausführung fehlgeschlagen') : '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler')
      void load()
    } finally {
      setBusyId(null)
    }
  }

  const hasPending = items.length > 0

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Tool-Freigaben"
      >
        <ShieldAlert className={`info-icon-md mr-2 flex-shrink-0 ${hasPending ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)] group-hover:text-[var(--t2)]'}`} />
        <span className="text-[var(--t2)] font-medium flex-1">Freigaben</span>
        {loading ? (
          <Loader2 className="info-icon-sm text-[var(--t3)] animate-spin" />
        ) : hasPending ? (
          <span className="info-text-meta tabular-nums text-[var(--cc-orange)]">{items.length}</span>
        ) : null}
      </button>
      {open && (
        <div className="pb-2">
          {error && <div className="info-text-meta text-[var(--warm)] px-3 py-1.5">{error}</div>}
          {!loading && items.length === 0 && (
            <div className="info-text-meta text-[var(--t3)]/70 px-3 py-2">Keine offenen Freigaben.</div>
          )}
          {items.map(item => (
            <div key={item.id} className="px-3 py-2 border-t border-white/[0.04] first:border-t-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="info-text-body text-[var(--t1)] font-medium truncate">{item.tool_name}</span>
                <span className="info-text-meta text-[var(--t3)]/70">{item.risk}</span>
                <span className="info-text-meta text-[var(--t3)]/70 ml-auto tabular-nums">{shortTime(item.ts)}</span>
              </div>
              <div className="info-text-meta text-[var(--t3)]/80 mt-0.5">{item.reason}</div>
              <pre className="mt-1.5 max-h-28 overflow-auto rounded-md bg-black/20 px-2 py-1.5 text-[11px] leading-snug text-[var(--t3)] whitespace-pre-wrap break-words">
                {formatArgs(item.arguments)}
              </pre>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => decide(item.id, 'approved')}
                  disabled={busyId === item.id}
                  className="grid h-7 w-7 place-items-center rounded-md text-[var(--t3)] hover:bg-white/[0.06] hover:text-[var(--t1)] disabled:opacity-40"
                  aria-label="Freigeben"
                  title="Freigeben"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => decide(item.id, 'denied')}
                  disabled={busyId === item.id}
                  className="grid h-7 w-7 place-items-center rounded-md text-[var(--t3)] hover:bg-white/[0.06] hover:text-[var(--t1)] disabled:opacity-40"
                  aria-label="Ablehnen"
                  title="Ablehnen"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
