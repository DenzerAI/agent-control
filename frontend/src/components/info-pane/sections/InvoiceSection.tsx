import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Receipt, RefreshCw, CheckCircle2, FileText, Check, X, Route, AlertTriangle } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type InvStep = {
  step_key: string
  label: string
  status: string
  summary: string
  data?: Record<string, unknown>
  ts?: number
}

type InvLineItem = {
  name: string
  quantity: number
  unitPrice?: { netAmount?: number }
}

type InvDraft = {
  idx: number
  customer: string
  contact_id?: string
  contact_name?: string
  title?: string
  channel?: string
  line_items?: InvLineItem[]
  total?: number
  warnings?: string[]
  needs_contact?: boolean
  status?: string
}

type InvRun = {
  id: string
  status: string
  created_at?: number
  steps?: InvStep[]
  result?: {
    items?: InvDraft[]
    ready?: boolean
    needs_contact?: boolean
    total?: number
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

function fmtEur(n?: number): string {
  return (n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

const STEP_FLOW: { key: string; label: string }[] = [
  { key: 'contact', label: 'Kontakt' },
  { key: 'positions', label: 'Positionen' },
  { key: 'await_approval', label: 'Freigabe' },
  { key: 'invoiced', label: 'Rechnung' },
]

function StepFlow({ steps }: { steps: InvStep[] }) {
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

function DraftRow({ run, draft, approved, discarded, invoiceMeta, onApproved, onDiscard, mobile }: {
  run: InvRun
  draft: InvDraft
  approved: boolean
  discarded: boolean
  invoiceMeta?: { number?: string; pdf_url?: string }
  onApproved: (meta: { number?: string; pdf_url?: string }) => void
  onDiscard: () => void
  mobile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [approving, setApproving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState('')
  const who = draft.contact_name || draft.customer || 'Unbekannt'
  const items = draft.line_items || []
  const warnings = draft.warnings || []
  const blocked = draft.status === 'blocked' || draft.needs_contact

  const discard = useCallback(async () => {
    setDiscarding(true)
    setError('')
    try {
      const res = await fetch('/api/invoice/discard', {
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
      const res = await fetch('/api/invoice/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setError(data.error || 'Anlegen fehlgeschlagen')
        return
      }
      playUISound('section-open')
      onApproved({ number: data.number, pdf_url: data.pdf_url })
    } catch (e) {
      setError(String(e))
    } finally {
      setApproving(false)
      setConfirming(false)
    }
  }, [run.id, draft.idx, onApproved])

  return (
    <div className="border-t border-white/[0.04] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        {approved
          ? <CheckCircle2 className="info-icon-sm mr-2 flex-shrink-0 text-emerald-500" />
          : discarded
            ? <X className="info-icon-sm mr-2 flex-shrink-0 text-[var(--t3)]" />
            : blocked
              ? <AlertTriangle className="info-icon-sm mr-2 flex-shrink-0 text-[var(--cc-orange)]" />
              : <Receipt className="info-icon-sm mr-2 flex-shrink-0 text-[var(--cc-orange)]" />}
        <span className={`truncate flex-1 group-hover:text-[var(--t1)] ${discarded ? 'text-[var(--t3)] line-through' : 'text-[var(--t2)]'}`}>{who}</span>
        <span className="info-text-meta tabular-nums text-[var(--t3)]/70 flex-shrink-0 mr-2">{fmtEur(draft.total)}</span>
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">
          {approved ? 'angelegt' : discarded ? 'verworfen' : blocked ? 'offen' : 'wartet'}
        </span>
      </button>
      {open && (
        <Guided>
          <div className="info-text-meta text-[var(--t3)]/75 pl-1 pr-3 pt-1 pb-2">
            {draft.title || 'Rechnung'}{draft.channel ? ` · Versand ${draft.channel}` : ''}
          </div>
          <div className="mx-1 mb-2 px-3 py-2 rounded-md bg-white/[0.03] border border-white/[0.05]">
            {items.length > 0 ? items.map((li, i) => (
              <div key={i} className="flex items-baseline info-text-body text-[var(--t2)] py-0.5">
                <span className="flex-1 truncate">{li.name}</span>
                <span className="info-text-meta text-[var(--t3)]/70 tabular-nums mx-2 flex-shrink-0">{li.quantity}×</span>
                <span className="tabular-nums flex-shrink-0">{fmtEur(li.unitPrice?.netAmount)}</span>
              </div>
            )) : (
              <div className="info-text-meta text-[var(--t3)]/60">Keine Position</div>
            )}
            <div className="flex items-baseline border-t border-white/[0.06] mt-1 pt-1 info-text-body text-[var(--t1)]">
              <span className="flex-1 font-medium">Gesamt (netto)</span>
              <span className="tabular-nums font-medium">{fmtEur(draft.total)}</span>
            </div>
          </div>
          {warnings.length > 0 && (
            <div className="info-text-meta text-[var(--cc-orange)] pl-1 pr-3 pb-2 leading-relaxed">
              {warnings.map((w, i) => <div key={i}>· {w}</div>)}
            </div>
          )}
          {blocked && !approved && (
            <div className="info-text-meta text-[var(--cc-orange)] pl-1 pr-3 pb-2 leading-relaxed">
              {draft.needs_contact
                ? 'Kein eindeutiger Lexware-Kontakt. Sag mir die Rechnungsadresse, dann baue ich fertig.'
                : 'Entwurf noch unvollständig, bitte Positionen prüfen.'}
            </div>
          )}
          {error && <div className="info-text-meta text-[var(--cc-orange)] pl-1 pr-3 pb-2">{error}</div>}
          {approved && (
            <div className="info-text-meta text-emerald-500/90 pl-1 pr-3 pb-2 leading-relaxed">
              Rechnung {invoiceMeta?.number ? `${invoiceMeta.number} ` : ''}angelegt.
              {invoiceMeta?.pdf_url && (
                <> <a href={invoiceMeta.pdf_url} target="_blank" rel="noreferrer" className="text-[var(--cc-orange)] underline inline-flex items-center gap-1">
                  <FileText className="info-icon-sm" /> PDF öffnen
                </a></>
              )}
            </div>
          )}
          {discarded && (
            <div className="info-text-meta text-[var(--t3)]/70 pl-1 pr-3 pb-2">
              Entwurf verworfen, keine Rechnungsnummer verbraucht.
            </div>
          )}
          {!approved && !discarded && (
            <div className="flex items-center gap-2 pl-1 pr-3 pb-2">
              {confirming ? (
                <>
                  <span className="info-text-meta text-[var(--cc-orange)]">Echte Rechnung anlegen?</span>
                  <button
                    type="button"
                    onClick={approve}
                    disabled={approving}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--cc-orange)]/15 text-[var(--cc-orange)] hover:bg-[var(--cc-orange)]/25 info-text-meta cursor-pointer transition-colors"
                  >
                    <Check className={`info-icon-sm ${approving ? 'animate-pulse' : ''}`} /> Ja, anlegen
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
                    title={blocked ? 'Erst Kontakt und Positionen klären' : 'Echte Lexware-Rechnung anlegen'}
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

function RunBlock({ run, mobile }: { run: InvRun; mobile?: boolean }) {
  const items = run.result?.items || []
  const invoicedIdx = useMemo(() => {
    const m = new Map<number, { number?: string; pdf_url?: string }>()
    for (const st of run.steps || []) {
      if (st.step_key.startsWith('invoiced_') && st.status === 'ok') {
        const n = Number(st.step_key.slice(9))
        if (!Number.isNaN(n)) m.set(n, {
          number: (st.data?.number as string) || '',
          pdf_url: (st.data?.pdf_url as string) || '',
        })
      }
    }
    return m
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
  const [localApproved, setLocalApproved] = useState<Map<number, { number?: string; pdf_url?: string }>>(new Map())
  const [localDiscarded, setLocalDiscarded] = useState<Set<number>>(new Set())
  const metaFor = (idx: number) => localApproved.get(idx) || invoicedIdx.get(idx)
  const isApproved = (idx: number) => invoicedIdx.has(idx) || localApproved.has(idx)
  const isDiscarded = (idx: number) => discardedIdx.has(idx) || localDiscarded.has(idx)

  return (
    <div className="pb-1">
      <StepFlow steps={run.steps || []} />
      <div className="info-text-meta text-[var(--t3)]/75 pl-1 pr-3 pb-1">
        {items.length} Entwurf{items.length === 1 ? '' : 'e'} · {fmtEur(run.result?.total)} · {fmtAge(run.created_at)}
      </div>
      {items.length > 0 ? items.map(d => (
        <DraftRow
          key={d.idx}
          run={run}
          draft={d}
          approved={isApproved(d.idx)}
          discarded={isDiscarded(d.idx)}
          invoiceMeta={metaFor(d.idx)}
          onApproved={(meta) => setLocalApproved(prev => new Map(prev).set(d.idx, meta))}
          onDiscard={() => setLocalDiscarded(prev => new Set(prev).add(d.idx))}
          mobile={mobile}
        />
      )) : (
        <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">
          Noch kein Entwurf. Sag mir, wer zugesagt hat, dann baue ich die Rechnung vor.
        </div>
      )}
    </div>
  )
}

export function InvoiceSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <InvoiceWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <InvoiceInlineSection mobile={mobile} />
}

function InvoiceWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Rechnungs-Agent im Workspace öffnen"
      >
        <Receipt className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Rechnungs-Agent</span>
      </button>
    </div>
  )
}

function InvoiceInlineSection({ mobile }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<InvRun[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/invoice/runs?limit=8', { cache: 'no-store' })
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
      if ((st.step_key.startsWith('invoiced_') || st.step_key.startsWith('discarded_')) && st.status === 'ok') {
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
        <Receipt className={`info-icon-md mr-2 flex-shrink-0 ${pending > 0 ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Rechnungs-Agent</span>
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
              Wenn jemand dein Angebot annimmt, baue ich die Rechnung als Entwurf vor: Kontakt aus Lexware, Positionen, Selbst-Check. Die echte, nummerierte Rechnung lege ich erst auf dein Freigeben an.
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
                Noch kein Lauf. Sag mir im Chat, wer zugesagt hat, dann lege ich den Entwurf an.
              </div>
            )}
            {older.length > 0 && (
              <div className="mt-1 border-t border-white/[0.04] pt-1">
                <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-1">Frühere Läufe</div>
                {older.map(r => (
                  <div key={r.id} className="flex items-center pl-1 pr-3 py-[5px] info-text-meta">
                    <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${r.status === 'error' ? 'bg-[var(--cc-orange)]' : 'bg-emerald-500'}`} />
                    <span className="flex-1 text-[var(--t2)] truncate">{(r.result?.items || []).length} Entwurf · {fmtEur(r.result?.total)}</span>
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
