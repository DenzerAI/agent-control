import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Inbox, RefreshCw, Send, FileText, CheckCircle2, Route, X } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type IntakeStep = {
  step_key: string
  label: string
  status: string
  summary: string
  data?: Record<string, unknown>
  ts?: number
}

type IntakeDraft = {
  idx: number
  account: string
  to: string
  subject: string
  orig_subject?: string
  from?: string
  person?: string
  draft: string
  model?: string
}

type IntakeRun = {
  id: string
  status: string
  created_at?: number
  steps?: IntakeStep[]
  result?: {
    items?: IntakeDraft[]
    drafts?: number
    attention?: number
    rechnung?: number
  }
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

const STEP_FLOW: { key: string; label: string }[] = [
  { key: 'routing', label: 'Einsortiert' },
  { key: 'context', label: 'Kontext' },
  { key: 'draft', label: 'Entwurf' },
  { key: 'review', label: 'Selbst-Check' },
  { key: 'await_approval', label: 'Freigabe' },
]

function StepFlow({ steps }: { steps: IntakeStep[] }) {
  const present = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const s of steps) {
      for (const f of STEP_FLOW) {
        if (s.step_key === f.key || s.step_key.startsWith(f.key + '_')) out[f.key] = true
      }
    }
    return out
  }, [steps])
  return (
    <div className="flex items-center flex-wrap gap-x-1 gap-y-1 pl-1 pr-3 py-2">
      {STEP_FLOW.map((f, i) => (
        <span key={f.key} className="flex items-center">
          <span className={`info-text-meta ${present[f.key] ? 'text-[var(--t2)]' : 'text-[var(--t3)]/45'}`}>{f.label}</span>
          {i < STEP_FLOW.length - 1 && <ChevronRight className="info-icon-sm mx-0.5 text-[var(--t3)]/40" />}
        </span>
      ))}
    </div>
  )
}

function DraftRow({ run, draft, sent, discarded, onSent, onDiscard, mobile }: {
  run: IntakeRun
  draft: IntakeDraft
  sent: boolean
  discarded: boolean
  onSent: () => void
  onDiscard: () => void
  mobile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState('')
  const who = draft.person || draft.from || draft.to || 'Unbekannt'

  const discard = useCallback(async () => {
    setDiscarding(true)
    setError('')
    try {
      const res = await fetch('/api/mail/intake/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx, learn: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || 'Verwerfen fehlgeschlagen')
        return
      }
      playUISound('section-close')
      onDiscard()
    } catch (e) {
      setError(String(e))
    } finally {
      setDiscarding(false)
    }
  }, [run.id, draft.idx, onDiscard])

  const send = useCallback(async () => {
    setSending(true)
    setError('')
    try {
      const res = await fetch('/api/mail/intake/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || 'Versand fehlgeschlagen')
        return
      }
      playUISound('section-open')
      onSent()
    } catch (e) {
      setError(String(e))
    } finally {
      setSending(false)
      setConfirming(false)
    }
  }, [run.id, draft.idx, onSent])

  return (
    <div className="border-t border-white/[0.04] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        {sent
          ? <CheckCircle2 className="info-icon-sm mr-2 flex-shrink-0 text-emerald-500" />
          : discarded
            ? <X className="info-icon-sm mr-2 flex-shrink-0 text-[var(--t3)]" />
            : <FileText className="info-icon-sm mr-2 flex-shrink-0 text-[var(--cc-orange)]" />}
        <span className={`truncate flex-1 group-hover:text-[var(--t1)] ${discarded ? 'text-[var(--t3)] line-through' : 'text-[var(--t2)]'}`}>{who}</span>
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">{sent ? 'gesendet' : discarded ? 'verworfen' : 'wartet'}</span>
      </button>
      {open && (
        <Guided>
          <div className="info-text-meta text-[var(--t3)]/75 pl-1 pr-3 pt-1 pb-2">
            An {draft.to} · Betreff {draft.subject}
          </div>
          <div className="mx-1 mb-2 px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.05] info-text-body text-[var(--t2)] whitespace-pre-wrap leading-relaxed">
            {draft.draft}
          </div>
          {error && <div className="info-text-meta text-[var(--cc-orange)] pl-1 pr-3 pb-2">{error}</div>}
          {discarded && (
            <div className="info-text-meta text-[var(--t3)]/70 pl-1 pr-3 pb-2">
              Verworfen und gemerkt. Diesen Absender entwerfe ich nicht mehr.
            </div>
          )}
          {!sent && !discarded && (
            <div className="flex items-center gap-2 pl-1 pr-3 pb-2">
              {confirming ? (
                <>
                  <span className="info-text-meta text-[var(--cc-orange)]">Wirklich senden?</span>
                  <button
                    type="button"
                    onClick={send}
                    disabled={sending}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--cc-orange)]/15 text-[var(--cc-orange)] hover:bg-[var(--cc-orange)]/25 info-text-meta cursor-pointer transition-colors"
                  >
                    <Send className={`info-icon-sm ${sending ? 'animate-pulse' : ''}`} /> Ja, senden
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="px-2 py-1 rounded text-[var(--t3)] hover:text-[var(--t2)] info-text-meta cursor-pointer"
                  >
                    Abbrechen
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] info-text-meta cursor-pointer transition-colors"
                  >
                    <Send className="info-icon-sm" /> Senden
                  </button>
                  <button
                    type="button"
                    onClick={discard}
                    disabled={discarding}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[var(--t3)] hover:text-[var(--t2)] hover:bg-white/[0.06] info-text-meta cursor-pointer transition-colors"
                    title="Verwerfen und Absender merken"
                  >
                    <X className={`info-icon-sm ${discarding ? 'animate-pulse' : ''}`} /> Verwerfen
                  </button>
                </>
              )}
            </div>
          )}
        </Guided>
      )}
    </div>
  )
}

function RunBlock({ run, mobile }: { run: IntakeRun; mobile?: boolean }) {
  const items = run.result?.items || []
  const sentIdx = useMemo(() => {
    const s = new Set<number>()
    for (const st of run.steps || []) {
      if (st.step_key.startsWith('sent_') && st.status === 'ok') {
        const n = Number(st.step_key.slice(5))
        if (!Number.isNaN(n)) s.add(n)
      }
    }
    return s
  }, [run.steps])
  const discardedIdx = useMemo(() => {
    const s = new Set<number>()
    for (const st of run.steps || []) {
      if (st.step_key.startsWith('discarded_') && st.status === 'ok') {
        const n = Number(st.step_key.slice(10))
        if (!Number.isNaN(n)) s.add(n)
      }
    }
    return s
  }, [run.steps])
  const [locallySent, setLocallySent] = useState<Set<number>>(new Set())
  const [locallyDiscarded, setLocallyDiscarded] = useState<Set<number>>(new Set())
  const isSent = (idx: number) => sentIdx.has(idx) || locallySent.has(idx)
  const isDiscarded = (idx: number) => discardedIdx.has(idx) || locallyDiscarded.has(idx)
  const att = run.result?.attention ?? 0
  const rech = run.result?.rechnung ?? 0

  return (
    <div className="pb-1">
      <StepFlow steps={run.steps || []} />
      <div className="info-text-meta text-[var(--t3)]/75 pl-1 pr-3 pb-1">
        {att} Achtung · {rech} Rechnung · {items.length} Entwurf{items.length === 1 ? '' : 'e'} · {fmtAge(run.created_at)}
      </div>
      {items.length > 0 ? items.map(d => (
        <DraftRow
          key={d.idx}
          run={run}
          draft={d}
          sent={isSent(d.idx)}
          discarded={isDiscarded(d.idx)}
          onSent={() => setLocallySent(prev => new Set(prev).add(d.idx))}
          onDiscard={() => setLocallyDiscarded(prev => new Set(prev).add(d.idx))}
          mobile={mobile}
        />
      )) : (
        <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">
          Keine Mail brauchte eine Antwort. Automaten und Rechnungen werden nur gemeldet, nicht beantwortet.
        </div>
      )}
    </div>
  )
}

export function PosteingangSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <InboxWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <PosteingangInlineSection mobile={mobile} />
}

function InboxWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Inbox im Workspace öffnen"
      >
        <Inbox className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Inbox</span>
      </button>
    </div>
  )
}

function PosteingangInlineSection({ mobile }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<IntakeRun[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/mail/intake/runs?limit=8', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      setRuns(Array.isArray(data.runs) ? data.runs : [])
    } catch {
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  const runNow = useCallback(async () => {
    setRunning(true)
    try {
      await fetch('/api/mail/intake/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      await load()
    } finally {
      setRunning(false)
    }
  }, [load])

  const latest = runs[0]
  const older = runs.slice(1, 6)
  const pending = (latest?.result?.items || []).length

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Inbox className={`info-icon-md mr-2 flex-shrink-0 ${pending > 0 ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Inbox</span>
        {pending > 0 && <span className="ml-2 info-text-meta tabular-nums text-[var(--cc-orange)]">{pending}</span>}
        <span className="flex-1" />
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); runNow() }}
            className="ml-2 p-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Inbox jetzt prüfen"
          >
            <RefreshCw className={`info-icon-sm ${loading || running ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            <div className="pl-1 pr-3 py-2 info-text-meta text-[var(--t3)]/75 leading-relaxed">
              Ich gehe deinen Posteingang durch, sortiere ein, lade den Kontext, schreibe Entwürfe in deinem Ton und prüfe sie selbst. Senden tust nur du.
            </div>
            {running && (
              <div className="flex items-center gap-2 pl-1 pr-3 py-2 info-text-meta text-[var(--t3)]/75">
                <Route className="info-icon-sm animate-pulse text-[var(--cc-orange)]" /> Läuft gerade durch …
              </div>
            )}
            {latest ? (
              <RunBlock run={latest} mobile={mobile} />
            ) : !running && (
              <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">
                Noch kein Lauf. Tipp oben auf das Symbol, dann prüfe ich den Posteingang.
              </div>
            )}
            {older.length > 0 && (
              <div className="mt-1 border-t border-white/[0.04] pt-1">
                <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-1">Frühere Läufe</div>
                {older.map(r => (
                  <div key={r.id} className="flex items-center pl-1 pr-3 py-[5px] info-text-meta">
                    <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${r.status === 'error' ? 'bg-[var(--cc-orange)]' : 'bg-emerald-500'}`} />
                    <span className="flex-1 text-[var(--t2)] truncate">{(r.result?.drafts ?? 0)} Entwürfe · {(r.result?.attention ?? 0)} Achtung</span>
                    <span className="text-[var(--t3)]/70 tabular-nums">{fmtAge(r.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Guided>
        </div>
      )}
    </div>
  )
}
