import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Newspaper, RefreshCw, CheckCircle2, Check, X, Route, AlertTriangle, Send } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type RedStep = {
  step_key: string
  label: string
  status: string
  summary: string
  ts?: number
}

type RedDraft = {
  idx: number
  title?: string
  ref?: string
  body: string
  ping?: string
  kind?: string
  words?: number
  warnings?: string[]
  source_note?: string
  status?: string
}

type RedRun = {
  id: string
  status: string
  created_at?: number
  steps?: RedStep[]
  result?: {
    items?: RedDraft[]
    ready?: boolean
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

function DraftRow({ run, draft, posted, discarded, onPosted, onDiscard, mobile }: {
  run: RedRun
  draft: RedDraft
  posted: boolean
  discarded: boolean
  onPosted: () => void
  onDiscard: () => void
  mobile?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [approving, setApproving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState('')
  const warnings = draft.warnings || []
  const blocked = draft.status === 'blocked' || !draft.body

  const discard = useCallback(async () => {
    setDiscarding(true)
    setError('')
    try {
      const res = await fetch('/api/pioniere/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
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

  const approve = useCallback(async () => {
    setApproving(true)
    setError('')
    try {
      const res = await fetch('/api/pioniere/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || 'Veröffentlichen fehlgeschlagen')
        return
      }
      playUISound('section-open')
      onPosted()
    } catch (e) {
      setError(String(e))
    } finally {
      setApproving(false)
      setConfirming(false)
    }
  }, [run.id, draft.idx, onPosted])

  return (
    <div className="border-t border-white/[0.04] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        {posted
          ? <CheckCircle2 className="info-icon-sm mr-2 flex-shrink-0 text-emerald-500" />
          : discarded
            ? <X className="info-icon-sm mr-2 flex-shrink-0 text-[var(--t3)]" />
            : blocked
              ? <AlertTriangle className="info-icon-sm mr-2 flex-shrink-0 text-[var(--cc-orange)]" />
              : <Newspaper className="info-icon-sm mr-2 flex-shrink-0 text-[var(--cc-orange)]" />}
        <span className={`truncate flex-1 group-hover:text-[var(--t1)] ${discarded ? 'text-[var(--t3)] line-through' : 'text-[var(--t2)]'}`}>{draft.title || 'Pioniere-Post'}</span>
        {draft.ref && <span className="info-text-meta tabular-nums text-[var(--t3)]/70 flex-shrink-0 mr-2 font-mono">#{draft.ref}</span>}
        <span className="info-text-meta tabular-nums text-[var(--t3)]/70 flex-shrink-0 mr-2">{draft.words ?? 0} W</span>
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">
          {posted ? 'freigegeben' : discarded ? 'verworfen' : blocked ? 'offen' : 'wartet'}
        </span>
      </button>
      {open && (
        <Guided>
          {draft.source_note && (
            <div className="info-text-meta text-[var(--t3)]/75 pl-1 pr-3 pt-1 pb-1">{draft.source_note}</div>
          )}
          <div className="mx-1 mb-2 px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.05] info-text-body text-[var(--t2)] whitespace-pre-wrap leading-relaxed">
            {draft.body || 'Kein Entwurf'}
          </div>
          {warnings.length > 0 && (
            <div className="info-text-meta text-[var(--cc-orange)] pl-1 pr-3 pb-2 leading-relaxed">
              {warnings.map((w, i) => <div key={i}>· {w}</div>)}
            </div>
          )}
          {error && <div className="info-text-meta text-[var(--cc-orange)] pl-1 pr-3 pb-2">{error}</div>}
          {posted && (
            <div className="info-text-meta text-emerald-500/90 pl-1 pr-3 pb-2 leading-relaxed">
              Freigegeben, wartet in der Versand-Queue. Feinsteuerung im Pionierplaner-Workspace.
            </div>
          )}
          {discarded && (
            <div className="info-text-meta text-[var(--t3)]/70 pl-1 pr-3 pb-2">
              Entwurf verworfen, nichts veröffentlicht.
            </div>
          )}
          {!posted && !discarded && (
            <div className="flex items-center gap-2 pl-1 pr-3 pb-2">
              {confirming ? (
                <>
                  <span className="info-text-meta text-[var(--cc-orange)]">In die Versand-Queue legen?</span>
                  <button
                    type="button"
                    onClick={approve}
                    disabled={approving}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--cc-orange)]/15 text-[var(--cc-orange)] hover:bg-[var(--cc-orange)]/25 info-text-meta cursor-pointer transition-colors"
                  >
                    <Send className={`info-icon-sm ${approving ? 'animate-pulse' : ''}`} /> Ja, freigeben
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
                    disabled={blocked}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded info-text-meta transition-colors ${blocked ? 'text-[var(--t3)]/40 cursor-not-allowed' : 'text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer'}`}
                    title={blocked ? 'Entwurf erst nachschärfen' : 'In die Versand-Queue legen'}
                  >
                    <Check className="info-icon-sm" /> Freigeben
                  </button>
                  <button
                    type="button"
                    onClick={discard}
                    disabled={discarding}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-[var(--t3)] hover:text-[var(--t2)] hover:bg-white/[0.06] info-text-meta cursor-pointer transition-colors"
                    title="Entwurf verwerfen"
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

function RunBlock({ run, mobile }: { run: RedRun; mobile?: boolean }) {
  const items = run.result?.items || []
  const postedIdx = useMemo(() => {
    const s = new Set<number>()
    for (const st of run.steps || []) {
      if (st.status !== 'ok') continue
      // posted_ = live, queued_ = freigegeben und in der Versand-Queue.
      // Beide gelten in der Section als erledigt; Feinsteuerung im Workspace.
      if (st.step_key.startsWith('posted_')) {
        const n = Number(st.step_key.slice(7))
        if (!Number.isNaN(n)) s.add(n)
      } else if (st.step_key.startsWith('queued_')) {
        const n = Number(st.step_key.slice(7))
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
  const [localPosted, setLocalPosted] = useState<Set<number>>(new Set())
  const [localDiscarded, setLocalDiscarded] = useState<Set<number>>(new Set())
  const isPosted = (idx: number) => postedIdx.has(idx) || localPosted.has(idx)
  const isDiscarded = (idx: number) => discardedIdx.has(idx) || localDiscarded.has(idx)

  return (
    <div className="pb-1">
      <div className="info-text-meta text-[var(--t3)]/75 pl-1 pr-3 pb-1">
        {items.length} Entwurf · {fmtAge(run.created_at)}
      </div>
      {items.length > 0 ? items.map(d => (
        <DraftRow
          key={d.idx}
          run={run}
          draft={d}
          posted={isPosted(d.idx)}
          discarded={isDiscarded(d.idx)}
          onPosted={() => setLocalPosted(prev => new Set(prev).add(d.idx))}
          onDiscard={() => setLocalDiscarded(prev => new Set(prev).add(d.idx))}
          mobile={mobile}
        />
      )) : (
        <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">
          Noch kein Entwurf. Im Vorlauf lege ich den nächsten Pioniere-Post hier zur Freigabe ab.
        </div>
      )}
    </div>
  )
}

export function RedaktionSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <RedaktionWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <RedaktionInlineSection mobile={mobile} />
}

function RedaktionWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Pioniereplaner im Workspace öffnen"
      >
        <Newspaper className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Pioniereplaner</span>
      </button>
    </div>
  )
}

function RedaktionInlineSection({ mobile }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<RedRun[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/pioniere/runs?limit=8', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      setRuns(Array.isArray(data.runs) ? data.runs : [])
    } catch {
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  const latest = runs[0]
  const older = runs.slice(1, 6)
  const pending = useMemo(() => {
    if (!latest) return 0
    const done = new Set<number>()
    for (const st of latest.steps || []) {
      if ((st.step_key.startsWith('posted_') || st.step_key.startsWith('discarded_')) && st.status === 'ok') {
        const n = Number(st.step_key.split('_')[1])
        if (!Number.isNaN(n)) done.add(n)
      }
    }
    return (latest.result?.items || []).filter(d => !done.has(d.idx)).length
  }, [latest])

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
        <Newspaper className={`info-icon-md mr-2 flex-shrink-0 ${pending > 0 ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Pioniereplaner</span>
        {pending > 0 && <span className="ml-2 info-text-meta tabular-nums text-[var(--cc-orange)]">{pending}</span>}
        <span className="flex-1" />
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load() }}
            className="ml-2 p-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Aktualisieren"
          >
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            <div className="pl-1 pr-3 py-2 info-text-meta text-[var(--t3)]/75 leading-relaxed">
              Im Vorlauf recherchiere ich den nächsten Pioniere-Post aus dem Radar und lege ihn hier als Entwurf ab. Veröffentlicht wird erst auf dein Freigeben, nichts geht ungesehen raus.
            </div>
            {loading && !latest && (
              <div className="flex items-center gap-2 pl-1 pr-3 py-2 info-text-meta text-[var(--t3)]/75">
                <Route className="info-icon-sm animate-pulse text-[var(--cc-orange)]" /> Lade …
              </div>
            )}
            {latest ? (
              <RunBlock run={latest} mobile={mobile} />
            ) : !loading && (
              <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">
                Noch kein Lauf. Der nächste Vorlauf legt hier einen Entwurf ab.
              </div>
            )}
            {older.length > 0 && (
              <div className="mt-1 border-t border-white/[0.04] pt-1">
                <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-1">Frühere Läufe</div>
                {older.map(r => (
                  <div key={r.id} className="flex items-center pl-1 pr-3 py-[5px] info-text-meta">
                    <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${r.status === 'error' ? 'bg-[var(--cc-orange)]' : 'bg-emerald-500'}`} />
                    <span className="flex-1 text-[var(--t2)] truncate">{(r.result?.items || []).length} Entwurf</span>
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
