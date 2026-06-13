import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, FileText, Receipt, RefreshCw, X } from 'lucide-react'

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

type InvoiceCache = {
  runs: InvRun[]
  received_at: string
}

const CACHE_KEY = 'workspace:invoice:runs'
const STEP_FLOW = [
  { key: 'contact', label: 'Kontakt' },
  { key: 'positions', label: 'Positionen' },
  { key: 'await_approval', label: 'Freigabe' },
  { key: 'invoiced', label: 'Rechnung' },
]

function readCache(): InvoiceCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { runs: [], received_at: '' }
    const parsed = JSON.parse(raw) as InvoiceCache
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [], received_at: parsed.received_at || '' }
  } catch { return { runs: [], received_at: '' } }
}

function writeCache(cache: InvoiceCache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch {}
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const ms = ts > 10_000_000_000 ? ts : ts * 1000
  const age = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function fmtEur(n?: number): string {
  return (n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

function fetchJsonWithTimeout(url: string, init?: RequestInit, timeoutMs = 16000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', ...init, signal: ctrl.signal })
    .then(async res => {
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText)
      return data
    })
    .finally(() => window.clearTimeout(timer))
}

function statusMap(run: InvRun, prefix: string): Map<number, { number?: string; pdf_url?: string }> {
  const out = new Map<number, { number?: string; pdf_url?: string }>()
  for (const step of run.steps || []) {
    if (step.step_key.startsWith(prefix) && step.status === 'ok') {
      const n = Number(step.step_key.slice(prefix.length))
      if (!Number.isNaN(n)) out.set(n, {
        number: (step.data?.number as string) || '',
        pdf_url: (step.data?.pdf_url as string) || '',
      })
    }
  }
  return out
}

function statusSet(run: InvRun, prefix: string): Set<number> {
  return new Set(statusMap(run, prefix).keys())
}

function activeStepIndex(steps: InvStep[]): number {
  let idx = -1
  for (const step of steps) {
    STEP_FLOW.forEach((flow, i) => {
      if (step.step_key === flow.key || step.step_key.startsWith(`${flow.key}_`)) idx = Math.max(idx, i)
    })
  }
  return idx
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] leading-4 text-[var(--t3)]">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-[var(--t1)]">{value}</div>
    </section>
  )
}

function DraftRow({ run, draft, approved, discarded, invoiceMeta, onApproved, onDiscard }: {
  run: InvRun
  draft: InvDraft
  approved: boolean
  discarded: boolean
  invoiceMeta?: { number?: string; pdf_url?: string }
  onApproved: (meta: { number?: string; pdf_url?: string }) => void
  onDiscard: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'discard' | ''>('')
  const [error, setError] = useState('')
  const who = draft.contact_name || draft.customer || 'Unbekannt'
  const items = draft.line_items || []
  const warnings = draft.warnings || []
  const blocked = draft.status === 'blocked' || draft.needs_contact

  const discard = useCallback(async () => {
    setBusy('discard')
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/invoice/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
      })
      if (!(data as { ok?: boolean }).ok) throw new Error('Verwerfen fehlgeschlagen')
      onDiscard()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }, [draft.idx, onDiscard, run.id])

  const approve = useCallback(async () => {
    setBusy('approve')
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/invoice/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
      }, 45000)
      if (!(data as { ok?: boolean }).ok) throw new Error((data as { error?: string }).error || 'Anlegen fehlgeschlagen')
      setConfirming(false)
      onApproved({ number: (data as { number?: string }).number, pdf_url: (data as { pdf_url?: string }).pdf_url })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }, [draft.idx, onApproved, run.id])

  return (
    <article className="border-t border-[var(--border)] first:border-t-0">
      <button type="button" onClick={() => setOpen(v => !v)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04]">
        {approved ? <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--green)]" /> : discarded ? <X className="h-4 w-4 shrink-0 text-[var(--t3)]" /> : blocked ? <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--warm)]" /> : <Receipt className="h-4 w-4 shrink-0 text-[var(--warm)]" />}
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm ${discarded ? 'text-[var(--t3)] line-through' : 'text-[var(--t1)]'}`}>{who}</div>
          <div className="truncate text-[11px] text-[var(--t3)]">{draft.title || 'Rechnung'}{draft.channel ? ` · ${draft.channel}` : ''}</div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-[var(--t2)]">{fmtEur(draft.total)}</span>
        <span className="shrink-0 text-[11px] text-[var(--t3)]">{approved ? 'angelegt' : discarded ? 'verworfen' : blocked ? 'offen' : 'wartet'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <div className="border border-[var(--border)] bg-[var(--bg)] p-3">
            {items.length > 0 ? items.map((item, i) => (
              <div key={i} className="flex min-w-0 items-baseline gap-2 py-1 text-sm text-[var(--t2)]">
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{item.quantity}x</span>
                <span className="shrink-0 tabular-nums text-[var(--t1)]">{fmtEur(item.unitPrice?.netAmount)}</span>
              </div>
            )) : <div className="text-sm text-[var(--t3)]">Keine Position.</div>}
            <div className="mt-2 flex items-baseline border-t border-[var(--border)] pt-2 text-sm text-[var(--t1)]">
              <span className="flex-1 font-medium">Gesamt netto</span>
              <span className="tabular-nums font-medium">{fmtEur(draft.total)}</span>
            </div>
          </div>
          {warnings.length > 0 && <div className="mt-2 text-xs leading-5 text-[var(--warm)]">{warnings.map((warning, i) => <div key={i}>{warning}</div>)}</div>}
          {blocked && !approved && <div className="mt-2 text-xs leading-5 text-[var(--warm)]">{draft.needs_contact ? 'Kein eindeutiger Lexware-Kontakt.' : 'Entwurf noch unvollständig.'}</div>}
          {error && <div className="mt-2 text-xs text-[var(--red)]">{error}</div>}
          {approved && (
            <div className="mt-2 text-xs leading-5 text-[var(--green)]">
              Rechnung {invoiceMeta?.number ? `${invoiceMeta.number} ` : ''}angelegt.
              {invoiceMeta?.pdf_url && <> <a href={invoiceMeta.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline"><FileText className="h-3.5 w-3.5" /> PDF öffnen</a></>}
            </div>
          )}
          {!approved && !discarded && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {confirming ? (
                <>
                  <span className="text-[11px] text-[var(--warm)]">Echte Rechnung anlegen?</span>
                  <button type="button" onClick={approve} disabled={busy !== ''} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-60">
                    <Check className={busy === 'approve' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Ja, anlegen
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)]">Abbrechen</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setConfirming(true)} disabled={blocked} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t1)] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40">
                    <Check className="h-3.5 w-3.5" /> Freigeben
                  </button>
                  <button type="button" onClick={discard} disabled={busy !== ''} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-60">
                    <X className={busy === 'discard' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Verwerfen
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function RunCard({ run, latest }: { run: InvRun; latest?: boolean }) {
  const items = run.result?.items || []
  const invoicedRemote = useMemo(() => statusMap(run, 'invoiced_'), [run])
  const discardedRemote = useMemo(() => statusSet(run, 'discarded_'), [run])
  const [localApproved, setLocalApproved] = useState<Map<number, { number?: string; pdf_url?: string }>>(new Map())
  const [localDiscarded, setLocalDiscarded] = useState<Set<number>>(new Set())
  const activeStep = activeStepIndex(run.steps || [])

  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex min-w-0 items-start gap-3 border-b border-[var(--border)] px-3 py-3">
        <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${run.status === 'error' ? 'bg-[var(--red)]' : items.length > 0 ? 'bg-[var(--warm)]' : 'bg-[var(--green)]'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm font-medium text-[var(--t1)]">{latest ? 'Letzter Lauf' : 'Früherer Lauf'}</strong>
            <span className="shrink-0 text-[11px] text-[var(--t3)]">{fmtAge(run.created_at)}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--t3)]">{items.length} Entwurf{items.length === 1 ? '' : 'e'} · {fmtEur(run.result?.total)}</div>
        </div>
      </div>
      <div className="grid grid-cols-4 border-b border-[var(--border)]">
        {STEP_FLOW.map((step, i) => (
          <div key={step.key} className={`min-w-0 border-r border-[var(--border)] px-2 py-2 last:border-r-0 ${i <= activeStep ? 'text-[var(--t2)]' : 'text-[var(--t3)]/55'}`}>
            <div className={`mb-1 h-1 w-full ${i <= activeStep ? 'bg-[var(--t2)]' : 'bg-white/[0.06]'}`} />
            <div className="truncate text-[10px]">{step.label}</div>
          </div>
        ))}
      </div>
      {items.length > 0 ? items.map(draft => (
        <DraftRow key={draft.idx} run={run} draft={draft} approved={invoicedRemote.has(draft.idx) || localApproved.has(draft.idx)} discarded={discardedRemote.has(draft.idx) || localDiscarded.has(draft.idx)} invoiceMeta={localApproved.get(draft.idx) || invoicedRemote.get(draft.idx)} onApproved={meta => setLocalApproved(prev => new Map(prev).set(draft.idx, meta))} onDiscard={() => setLocalDiscarded(prev => new Set(prev).add(draft.idx))} />
      )) : <div className="px-3 py-3 text-sm text-[var(--t3)]">Noch kein Entwurf in diesem Lauf.</div>}
    </section>
  )
}

export function InvoiceWorkspace() {
  const [cache, setCache] = useState<InvoiceCache>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const runs = cache.runs
  const latest = runs[0]
  const older = runs.slice(1, 5)
  const pending = useMemo(() => {
    if (!latest) return 0
    const invoiced = statusSet(latest, 'invoiced_')
    const discarded = statusSet(latest, 'discarded_')
    return (latest.result?.items || []).filter(item => !invoiced.has(item.idx) && !discarded.has(item.idx)).length
  }, [latest])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/invoice/runs?limit=8')
      const next: InvoiceCache = { runs: Array.isArray((data as { runs?: unknown }).runs) ? (data as { runs: InvRun[] }).runs : [], received_at: new Date().toISOString() }
      setCache(next)
      writeCache(next)
    } catch (e) {
      setError(`Rechnungs-Agent gerade nicht erreichbar, letzter Stand bleibt: ${(e as Error).message}`)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 180000)
    return () => window.clearInterval(id)
  }, [load])

  const headline = pending > 0 ? `${pending} Entwurf${pending === 1 ? '' : 'e'} wartet${pending === 1 ? '' : 'n'}` : latest ? 'Keine offene Rechnung' : 'Noch kein Lauf'

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Rechnungs-Agent · Lexware · Freigaben</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{headline}</h2>
            <div className="truncate text-xs text-[var(--t3)]">Letzter Stand {cache.received_at ? fmtAge(new Date(cache.received_at).getTime()) : 'nie'}</div>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="wartend" value={pending} />
          <Stat label="Gesamt" value={fmtEur(latest?.result?.total)} />
          <Stat label="Entwürfe" value={(latest?.result?.items || []).length} />
        </div>
        {error && <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </header>
      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {latest ? (
          <div className="space-y-3">
            <RunCard run={latest} latest />
            {older.length > 0 && <div className="space-y-2"><div className="px-1 text-[11px] text-[var(--t3)]">Frühere Läufe</div>{older.map(run => <RunCard key={run.id} run={run} />)}</div>}
          </div>
        ) : (
          <div className="flex h-full min-h-[220px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-6 text-center">
            <div><Receipt className="mx-auto mb-3 h-6 w-6 text-[var(--t3)]" /><div className="text-sm font-medium text-[var(--t1)]">{loading ? 'Lade letzten Stand' : 'Keine Läufe gespeichert'}</div><div className="mt-1 text-xs leading-5 text-[var(--t3)]">Sag im Chat, wer zugesagt hat; der Workspace zeigt danach Entwurf und Freigabe.</div></div>
          </div>
        )}
      </main>
    </div>
  )
}
