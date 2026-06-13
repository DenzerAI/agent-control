import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, FileText, Inbox, RefreshCw, Route, Send, X } from 'lucide-react'

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

type MailagentCache = {
  runs: IntakeRun[]
  received_at: string
}

const CACHE_KEY = 'workspace:mailagent:intakeRuns'
const STEP_FLOW: { key: string; label: string }[] = [
  { key: 'routing', label: 'Routing' },
  { key: 'context', label: 'Kontext' },
  { key: 'draft', label: 'Entwurf' },
  { key: 'review', label: 'Check' },
  { key: 'await_approval', label: 'Freigabe' },
]

function readCache(): MailagentCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { runs: [], received_at: '' }
    const parsed = JSON.parse(raw) as MailagentCache
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [], received_at: parsed.received_at || '' }
  } catch {
    return { runs: [], received_at: '' }
  }
}

function writeCache(cache: MailagentCache) {
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

function completedStepKeys(steps: IntakeStep[]): Set<string> {
  const out = new Set<string>()
  for (const step of steps) {
    for (const flow of STEP_FLOW) {
      if (step.step_key === flow.key || step.step_key.startsWith(`${flow.key}_`)) out.add(flow.key)
    }
  }
  return out
}

function stepIndex(steps: IntakeStep[]): number {
  const present = completedStepKeys(steps)
  let idx = -1
  STEP_FLOW.forEach((flow, i) => { if (present.has(flow.key)) idx = i })
  return idx
}

function statusSet(run: IntakeRun, prefix: string): Set<number> {
  const out = new Set<number>()
  for (const step of run.steps || []) {
    if (step.step_key.startsWith(prefix) && step.status === 'ok') {
      const n = Number(step.step_key.slice(prefix.length))
      if (!Number.isNaN(n)) out.add(n)
    }
  }
  return out
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] leading-4 text-[var(--t3)]">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-[var(--t1)]">{value}</div>
    </section>
  )
}

function DraftRow({ run, draft, sent, discarded, onSent, onDiscard }: {
  run: IntakeRun
  draft: IntakeDraft
  sent: boolean
  discarded: boolean
  onSent: () => void
  onDiscard: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'send' | 'discard' | ''>('')
  const [error, setError] = useState('')
  const who = draft.person || draft.from || draft.to || 'Unbekannt'

  const discard = useCallback(async () => {
    setBusy('discard')
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/mail/intake/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx, learn: true }),
      })
      if (!(data as { ok?: boolean }).ok) throw new Error('Verwerfen fehlgeschlagen')
      onDiscard()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }, [draft.idx, onDiscard, run.id])

  const send = useCallback(async () => {
    setBusy('send')
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/mail/intake/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id, idx: draft.idx }),
      })
      if (!(data as { ok?: boolean }).ok) throw new Error('Versand fehlgeschlagen')
      setConfirming(false)
      onSent()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }, [draft.idx, onSent, run.id])

  return (
    <article className="border-t border-[var(--border)] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04]"
      >
        {sent ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--green)]" />
        ) : discarded ? (
          <X className="h-4 w-4 shrink-0 text-[var(--t3)]" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-[var(--warm)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm ${discarded ? 'text-[var(--t3)] line-through' : 'text-[var(--t1)]'}`}>{who}</div>
          <div className="truncate text-[11px] text-[var(--t3)]">{draft.subject || draft.orig_subject || 'ohne Betreff'}</div>
        </div>
        <span className="shrink-0 text-[11px] text-[var(--t3)]">{sent ? 'gesendet' : discarded ? 'verworfen' : 'wartet'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <div className="mb-2 text-[11px] leading-5 text-[var(--t3)]">
            {draft.account} · an {draft.to}{draft.model ? ` · ${draft.model}` : ''}
          </div>
          <div className="max-h-[34vh] overflow-auto border border-[var(--border)] bg-[var(--bg)] p-3 text-sm leading-6 text-[var(--t2)] whitespace-pre-wrap">
            {draft.draft}
          </div>
          {error && <div className="mt-2 text-[11px] text-[var(--red)]">{error}</div>}
          {!sent && !discarded && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {confirming ? (
                <>
                  <span className="text-[11px] text-[var(--warm)]">Wirklich senden?</span>
                  <button
                    type="button"
                    onClick={send}
                    disabled={busy !== ''}
                    className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-60"
                  >
                    <Send className={busy === 'send' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
                    Senden
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)]"
                  >
                    Abbrechen
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t1)] hover:bg-white/[0.05]"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Freigeben
                  </button>
                  <button
                    type="button"
                    onClick={discard}
                    disabled={busy !== ''}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-60"
                  >
                    <X className={busy === 'discard' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
                    Verwerfen
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

function RunCard({ run, latest }: { run: IntakeRun; latest?: boolean }) {
  const items = run.result?.items || []
  const sentRemote = useMemo(() => statusSet(run, 'sent_'), [run])
  const discardedRemote = useMemo(() => statusSet(run, 'discarded_'), [run])
  const [sentLocal, setSentLocal] = useState<Set<number>>(new Set())
  const [discardedLocal, setDiscardedLocal] = useState<Set<number>>(new Set())
  const activeStep = stepIndex(run.steps || [])
  const hasError = run.status === 'error' || (run.steps || []).some(step => step.status === 'error')

  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex min-w-0 items-start gap-3 border-b border-[var(--border)] px-3 py-3">
        <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${hasError ? 'bg-[var(--red)]' : items.length > 0 ? 'bg-[var(--warm)]' : 'bg-[var(--green)]'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm font-medium text-[var(--t1)]">{latest ? 'Letzter Lauf' : 'Früherer Lauf'}</strong>
            <span className="shrink-0 text-[11px] text-[var(--t3)]">{fmtAge(run.created_at)}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--t3)]">
            {run.result?.attention ?? 0} Achtung · {run.result?.rechnung ?? 0} Rechnung · {items.length} Entwurf{items.length === 1 ? '' : 'e'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-5 border-b border-[var(--border)]">
        {STEP_FLOW.map((step, i) => (
          <div key={step.key} className={`min-w-0 border-r border-[var(--border)] px-2 py-2 last:border-r-0 ${i <= activeStep ? 'text-[var(--t2)]' : 'text-[var(--t3)]/55'}`}>
            <div className={`mb-1 h-1 w-full ${i <= activeStep ? 'bg-[var(--t2)]' : 'bg-white/[0.06]'}`} />
            <div className="truncate text-[10px]">{step.label}</div>
          </div>
        ))}
      </div>

      {items.length > 0 ? (
        <div>
          {items.map(draft => (
            <DraftRow
              key={draft.idx}
              run={run}
              draft={draft}
              sent={sentRemote.has(draft.idx) || sentLocal.has(draft.idx)}
              discarded={discardedRemote.has(draft.idx) || discardedLocal.has(draft.idx)}
              onSent={() => setSentLocal(prev => new Set(prev).add(draft.idx))}
              onDiscard={() => setDiscardedLocal(prev => new Set(prev).add(draft.idx))}
            />
          ))}
        </div>
      ) : (
        <div className="px-3 py-3 text-sm text-[var(--t3)]">Keine Antwortentwürfe in diesem Lauf.</div>
      )}
    </section>
  )
}

export function MailagentWorkspace() {
  const [cache, setCache] = useState<MailagentCache>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const runs = cache.runs
  const latest = runs[0]
  const older = runs.slice(1, 5)
  const pending = (latest?.result?.items || []).filter(item => {
    const sent = statusSet(latest, 'sent_').has(item.idx)
    const discarded = statusSet(latest, 'discarded_').has(item.idx)
    return !sent && !discarded
  }).length

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/mail/intake/runs?limit=8')
      const next: MailagentCache = {
        runs: Array.isArray((data as { runs?: unknown }).runs) ? (data as { runs: IntakeRun[] }).runs : [],
        received_at: new Date().toISOString(),
      }
      setCache(next)
      writeCache(next)
    } catch (e) {
      setError(`Mail-Agent gerade nicht erreichbar, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const runNow = useCallback(async () => {
    setRunning(true)
    setError('')
    try {
      await fetchJsonWithTimeout('/api/mail/intake/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, 45000)
      await load()
    } catch (e) {
      setError(`Lauf nicht gestartet, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }, [load])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 180000)
    return () => window.clearInterval(id)
  }, [load])

  const headline = pending > 0
    ? `${pending} Entwurf${pending === 1 ? '' : 'e'} wartet${pending === 1 ? '' : 'n'}`
    : latest
      ? 'Posteingang ruhig'
      : 'Noch kein Lauf'

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Mail-Agent · Intake · Freigaben</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{headline}</h2>
            <div className="truncate text-xs text-[var(--t3)]">
              Letzter Stand {cache.received_at ? fmtAge(new Date(cache.received_at).getTime()) : 'nie'}
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading || running}
            className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60"
            title="Neu laden"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="wartend" value={pending} />
          <Stat label="Achtung" value={latest?.result?.attention ?? 0} />
          <Stat label="Rechnung" value={latest?.result?.rechnung ?? 0} />
        </div>

        <button
          type="button"
          onClick={runNow}
          disabled={running || loading}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-sm text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-60"
        >
          <Route className={running ? 'h-4 w-4 animate-pulse text-[var(--warm)]' : 'h-4 w-4'} />
          {running ? 'Lauf läuft' : 'Posteingang prüfen'}
        </button>

        {error && (
          <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {latest ? (
          <div className="space-y-3">
            <RunCard run={latest} latest />
            {older.length > 0 && (
              <div className="space-y-2">
                <div className="px-1 text-[11px] text-[var(--t3)]">Frühere Läufe</div>
                {older.map(run => <RunCard key={run.id} run={run} />)}
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full min-h-[220px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-6 text-center">
            <div>
              <Inbox className="mx-auto mb-3 h-6 w-6 text-[var(--t3)]" />
              <div className="text-sm font-medium text-[var(--t1)]">{loading ? 'Lade letzten Stand' : 'Keine Läufe gespeichert'}</div>
              <div className="mt-1 text-xs leading-5 text-[var(--t3)]">Der Workspace zeigt Läufe, Entwürfe und Freigaben, sobald der Mail-Agent einmal gelaufen ist.</div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
