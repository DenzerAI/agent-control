import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle, ArrowLeft, CheckCircle2, CircleDashed, Clock3, Inbox,
  MessageSquare, Play, RefreshCw, Receipt, Settings2, XCircle,
} from 'lucide-react'

type RunStep = {
  step_key: string
  label: string
  status: string
  summary?: string
  data?: Record<string, unknown>
  ts?: number
}

type Run = {
  id: string
  workflow_key: string
  title: string
  status: string
  trigger?: string
  subject_type?: string
  subject_ref?: string
  conversation_id?: string
  created_at?: number
  finished_at?: number | null
  review_status?: string
  review_message?: string
  result?: Record<string, unknown>
  steps?: RunStep[]
}

type Trigger = { url: string; label: string; timeout?: number }

type AgentDef = {
  key: string
  label: string
  desc: string
  icon: typeof MessageSquare
  match: (run: Run) => boolean
  trigger?: Trigger
}

// Christians vier Agents, gemappt auf die echten workflow_runs.
// Reihenfolge = Klassifikations-Vorrang: Mail/Rechnung vor dem generischen System-Agent.
const AGENTS: AgentDef[] = [
  {
    key: 'chat',
    label: 'Chat-Agent',
    desc: 'Beantwortet Nachrichten in den Chats',
    icon: MessageSquare,
    match: r => r.workflow_key === 'agent.turn',
  },
  {
    key: 'mail',
    label: 'Mail-Agent',
    desc: 'Scannt Posteingang, baut Entwürfe',
    icon: Inbox,
    match: r => /mail/i.test(r.subject_ref || '') || /mail/i.test(r.title || ''),
    trigger: { url: '/api/eingang/scan-mail', label: 'Posteingang prüfen', timeout: 45000 },
  },
  {
    key: 'rechnung',
    label: 'Rechnungs-Agent',
    desc: 'Belege, Firmenfitness, Finanzen',
    icon: Receipt,
    match: r => /(rechnung|invoice|finance|firmenfitness|receipt)/i.test(`${r.subject_ref || ''} ${r.title || ''}`),
  },
  {
    key: 'system',
    label: 'System-Agent',
    desc: 'Jobs, Pulses und Betrieb',
    icon: Settings2,
    match: () => true, // Auffangbecken für alles Übrige
    trigger: { url: '/api/systemagent/run', label: 'Systemlauf starten', timeout: 30000 },
  },
]

const RUN_KEYS = ['agent.turn', 'pulse.run', 'job.run'] as const
const PER_AGENT = 6
const CACHE_KEY = 'workspace:agent-kanban:runs'

function readCache(): Run[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Run[]) : []
  } catch { return [] }
}

function writeCache(runs: Run[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(runs)) } catch {}
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

function fmtDuration(run: Run): string {
  if (!run.created_at || !run.finished_at) return ''
  const sec = Math.max(0, Math.round(run.finished_at - run.created_at))
  if (sec < 1) return '<1s'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}min ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}min`
}

function fetchJson(url: string, init?: RequestInit, timeoutMs = 16000): Promise<any> {
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

function classify(run: Run): string {
  for (const agent of AGENTS) if (agent.match(run)) return agent.key
  return 'system'
}

function runTitle(run: Run): string {
  const subj = (run.subject_ref || '').trim()
  if (run.workflow_key === 'agent.turn') {
    return run.subject_ref === 'klaus-channel' ? 'Agent-Channel' : (run.title || `Chat ${run.conversation_id || ''}`).trim()
  }
  return subj || run.title || run.workflow_key
}

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'running' ? 'bg-[var(--warm)] animate-pulse'
    : status === 'error' ? 'bg-[var(--red)]'
    : status === 'cancelled' ? 'bg-[var(--t3)]'
    : 'bg-[var(--green)]'
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${cls}`} />
}

function StepIcon({ status }: { status: string }) {
  if (status === 'ok' || status === 'done') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--green)]" />
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 shrink-0 text-[var(--red)]" />
  if (status === 'running') return <Clock3 className="h-3.5 w-3.5 shrink-0 text-[var(--warm)]" />
  return <CircleDashed className="h-3.5 w-3.5 shrink-0 text-[var(--t3)]" />
}

function prettyPane(id?: string): string {
  if (!id) return '—'
  if (id === 'klaus-channel') return 'Agent-Channel'
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const mm = Math.floor(s / 60), ss = s % 60
  if (s < 3600) return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  const hh = Math.floor(s / 3600)
  return `${hh}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace('.', ',')}k`
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'plus' | 'minus' }) {
  const color = tone === 'plus' ? 'text-[var(--green)]' : tone === 'minus' ? 'text-[var(--red)]' : 'text-[var(--t1)]'
  return (
    <div className="min-w-[84px] flex-1 border-l border-[var(--border-soft)] px-4 first:border-l-0 first:pl-0">
      <div className="mb-1.5 whitespace-nowrap text-[10.5px] uppercase tracking-wider text-[var(--t3)]">{label}</div>
      <div className={`text-[21px] font-bold leading-none tracking-tight tabular-nums ${color}`}>{value}</div>
    </div>
  )
}

const SURFACED_KEYS = new Set([
  'prompt', 'auftrag', 'task', 'instruction', 'session', 'session_title', 'session_name',
  'tokens', 'tokens_total', 'token_count', 'usage_tokens', 'files_read', 'reads', 'read_count',
  'files_edited', 'edits', 'edit_count', 'lines_added', 'added', 'lines_removed', 'removed', 'verifier',
])

function RunDetail({ run, agent, onBack }: { run: Run; agent: AgentDef; onBack: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (run.status !== 'running') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [run.status])

  const r = (run.result || {}) as Record<string, unknown>
  const pick = (keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] != null) return r[k]
      const direct = (run as unknown as Record<string, unknown>)[k]
      if (direct != null) return direct
    }
    return undefined
  }
  const asNum = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN
    return Number.isFinite(n) ? n : undefined
  }

  const running = run.status === 'running'
  const baseMs = run.created_at ? (run.created_at > 1e10 ? run.created_at : run.created_at * 1000) : now
  const liveSec = Math.max(0, Math.round((now - baseMs) / 1000))
  const duration = running ? fmtClock(liveSec) : (fmtDuration(run) || fmtClock(0))

  const tokens = asNum(pick(['tokens', 'tokens_total', 'token_count', 'usage_tokens']))
  const filesRead = asNum(pick(['files_read', 'reads', 'read_count']))
  const filesEdited = asNum(pick(['files_edited', 'edits', 'edit_count']))
  const linesAdded = asNum(pick(['lines_added', 'added']))
  const linesRemoved = asNum(pick(['lines_removed', 'removed']))
  const prompt = (pick(['prompt', 'auftrag', 'task', 'instruction']) as string) || ''
  const sessionLabel = (pick(['session', 'session_title', 'session_name']) as string) || run.title || '—'

  const verifier = pick(['verifier']) as
    | { round?: number; max_rounds?: number; actors?: Array<{ role?: string; name?: string; status?: string; doing?: string; step?: number; total?: number }> }
    | undefined
  const actors = verifier?.actors || []

  const steps = run.steps || []
  const resultEntries = Object.entries(run.result || {})
    .filter(([k, v]) => v != null && typeof v !== 'object' && !SURFACED_KEYS.has(k))
    .slice(0, 8)

  const statusLine = running
    ? `Bauauftrag läuft · ${duration}`
    : run.status === 'error' ? 'Fehlgeschlagen'
    : run.status === 'cancelled' ? 'Abgebrochen'
    : `Abgeschlossen · ${fmtAge(run.finished_at || run.created_at)}`

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border-soft)] px-5 py-4">
        <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-[var(--t3)] hover:text-[var(--t1)]">
          <ArrowLeft className="h-3.5 w-3.5" /> Agent-Läufe
        </button>
        <div className="mb-2.5 flex items-center gap-2 text-[12px] font-semibold text-[var(--accent)]">
          {running && (
            <span className="relative h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--accent)]">
              <span className="absolute -inset-1 animate-ping rounded-full border border-[var(--accent)]" />
            </span>
          )}
          <span>{statusLine}</span>
        </div>
        <h2 className="mb-3 text-[clamp(20px,3vw,26px)] font-bold leading-tight tracking-tight">{runTitle(run)}</h2>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-[var(--t2)]">
          <span className="inline-flex items-baseline gap-1.5"><span className="text-[11px] uppercase tracking-wider text-[var(--t3)]">Pane</span> <b className="font-semibold text-[var(--t1)]">{prettyPane(run.conversation_id || run.subject_ref)}</b></span>
          <span className="inline-flex items-baseline gap-1.5"><span className="text-[11px] uppercase tracking-wider text-[var(--t3)]">Session</span> <b className="font-semibold text-[var(--t1)]">{sessionLabel}</b></span>
          <span className="inline-flex items-baseline gap-1.5"><span className="text-[11px] uppercase tracking-wider text-[var(--t3)]">Agent</span> <b className="font-semibold text-[var(--t1)]">{agent.label}</b></span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <div className="flex flex-wrap gap-y-3 border-y border-[var(--border-soft)] py-4">
          <Metric label="Dauer" value={duration} />
          {tokens != null && <Metric label="Tokens" value={fmtTokens(tokens)} />}
          {filesRead != null && <Metric label="Gelesen" value={String(filesRead)} />}
          {filesEdited != null && <Metric label="Editiert" value={String(filesEdited)} />}
          {linesAdded != null && <Metric label="Zeilen +" value={`+${linesAdded}`} tone="plus" />}
          {linesRemoved != null && <Metric label="Zeilen −" value={`−${linesRemoved}`} tone="minus" />}
        </div>

        {prompt && (
          <section className="mt-8">
            <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--t3)]">Auftrag</div>
            <div className="border-l-2 border-[var(--accent)] pl-4 text-[14px] leading-relaxed text-[var(--t2)]">{prompt}</div>
          </section>
        )}

        {run.review_status && run.review_status !== 'pending' && (
          <section className="mt-8">
            <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--t3)]">Review</div>
            <div className="flex items-start gap-2 text-[14px]">
              <span className="mt-0.5"><StepIcon status={run.review_status === 'ok' ? 'ok' : run.review_status === 'warning' ? 'running' : 'error'} /></span>
              <span className="text-[var(--t2)]">{run.review_message || run.review_status}</span>
            </div>
          </section>
        )}

        {actors.length > 0 && (
          <section className="mt-8">
            <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--t3)]">Wer arbeitet gerade</div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {actors.map((a, i) => {
                const active = a.status === 'running' || a.status === 'active'
                const role = (a.role || '').toLowerCase()
                const isBuilder = role.startsWith('build') || role.includes('bau')
                const name = a.name || (isBuilder ? 'Bauer' : 'Prüfer')
                return (
                  <div key={i} className={active ? '' : 'opacity-50'}>
                    <div className="mb-2 flex items-center gap-2.5">
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11.5px] font-bold ${isBuilder ? 'bg-[var(--accent)] text-white' : 'border border-[var(--border)] bg-[var(--bg-2)] text-[var(--t1)]'}`}>{name.slice(0, 1)}</span>
                      <span className="text-[15px] font-semibold">{name}</span>
                      <span className={`ml-auto text-[11px] font-semibold ${active ? 'text-[var(--accent)]' : 'text-[var(--t3)]'}`}>{(a.status || (active ? 'arbeitet' : 'wartet'))}{a.step && a.total ? ` · Schritt ${a.step}/${a.total}` : ''}</span>
                    </div>
                    {a.doing && <div className="text-[14px] leading-snug text-[var(--t2)]">{a.doing}</div>}
                  </div>
                )
              })}
            </div>
            {verifier?.round != null && (
              <div className="mt-5 flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--t3)]">
                <span className="inline-flex gap-1">
                  {Array.from({ length: verifier.max_rounds || 3 }).map((_, i) => (
                    <span key={i} className={`h-[3px] w-[22px] rounded-sm ${i < (verifier?.round || 0) ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`} />
                  ))}
                </span>
                <span>Runde <span className="font-medium text-[var(--t1)]">{verifier.round}</span> von <span className="font-medium text-[var(--t1)]">{verifier.max_rounds || 3}</span></span>
              </div>
            )}
          </section>
        )}

        <section className="mt-8">
          <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--t3)]">{actors.length > 0 ? 'Was er anfasst' : 'Verlauf'}</div>
          {steps.length > 0 ? (
            <div className="flex flex-col">
              {steps.map((step, i) => (
                <div key={`${step.step_key}-${i}`} className="flex items-center gap-3 border-b border-[var(--border-soft)] py-2 last:border-b-0">
                  <span className="shrink-0"><StepIcon status={step.status} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] text-[var(--t1)]">{step.label || step.step_key}</div>
                    {step.summary && <div className="truncate text-[12px] text-[var(--t3)]">{step.summary}</div>}
                  </div>
                  {step.ts && <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtAge(step.ts)}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-[var(--t3)]">Noch nichts protokolliert.</div>
          )}
        </section>

        {resultEntries.length > 0 && (
          <section className="mt-8">
            <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--t3)]">Ergebnis</div>
            <div className="flex flex-col">
              {resultEntries.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 border-b border-[var(--border-soft)] py-1.5 last:border-b-0">
                  <span className="shrink-0 text-[12px] text-[var(--t3)]">{k}</span>
                  <span className="truncate text-[14px] tabular-nums text-[var(--t2)]">{String(v)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function AgentCard({ agent, runs, onRun, busy, onSelect }: {
  agent: AgentDef
  runs: Run[]
  onRun: (agent: AgentDef) => void
  busy: boolean
  onSelect: (run: Run) => void
}) {
  const Icon = agent.icon
  const latest = runs[0]
  const errors = runs.filter(r => r.status === 'error').length
  return (
    <section className="flex min-w-0 flex-col rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border)] px-3 py-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t3)]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm font-medium text-[var(--t1)]">{agent.label}</strong>
            {latest && <StatusDot status={latest.status} />}
          </div>
          <div className="truncate text-[11px] text-[var(--t3)]">{agent.desc}</div>
        </div>
        {agent.trigger && (
          <button
            type="button"
            onClick={() => onRun(agent)}
            disabled={busy}
            title={agent.trigger.label}
            className="shrink-0 border border-[var(--border)] p-1.5 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60"
          >
            <Play className={busy ? 'h-3.5 w-3.5 animate-pulse text-[var(--warm)]' : 'h-3.5 w-3.5'} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--t3)]">
        <span>{runs.length} Läufe</span>
        {errors > 0 && <span className="text-[var(--red)]">{errors} Fehler</span>}
        {latest && <span className="ml-auto">zuletzt {fmtAge(latest.created_at)}</span>}
      </div>

      {runs.length > 0 ? (
        <div className="min-w-0">
          {runs.map(run => (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelect(run)}
              className="flex w-full min-w-0 items-start gap-2 border-t border-[var(--border)] px-3 py-2 text-left first:border-t-0 hover:bg-white/[0.04]"
            >
              <StatusDot status={run.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--t1)]">{runTitle(run)}</div>
                <div className="truncate text-[11px] text-[var(--t3)]">
                  {fmtAge(run.created_at)}{fmtDuration(run) ? ` · ${fmtDuration(run)}` : ''}{(run.steps || []).length ? ` · ${(run.steps || []).length} Schritte` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="px-3 py-4 text-[11px] text-[var(--t3)]">Noch keine Läufe.</div>
      )}
    </section>
  )
}

export function AgentKanbanWorkspace() {
  const [runs, setRuns] = useState<Run[]>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyAgent, setBusyAgent] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const batches = await Promise.all(
        RUN_KEYS.map(key =>
          fetchJson(`/api/workflows/runs?workflow_key=${key}&limit=25`)
            .then(d => (Array.isArray(d?.runs) ? (d.runs as Run[]) : []))
            .catch(() => [] as Run[]),
        ),
      )
      const merged = batches.flat().sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      setRuns(merged)
      writeCache(merged)
      setSelectedId(prev => (prev && merged.some(r => r.id === prev) ? prev : null))
    } catch (e) {
      setError(`Läufe gerade nicht lesbar, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const runAgent = useCallback(async (agent: AgentDef) => {
    if (!agent.trigger) return
    setBusyAgent(agent.key)
    setError('')
    try {
      await fetchJson(agent.trigger.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, agent.trigger.timeout || 30000)
      await load()
    } catch (e) {
      setError(`${agent.label} nicht gestartet: ${(e as Error).message}`)
    } finally {
      setBusyAgent('')
    }
  }, [load])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 60000)
    return () => window.clearInterval(id)
  }, [load])

  const grouped = useMemo(() => {
    const map = new Map<string, Run[]>(AGENTS.map(a => [a.key, []]))
    for (const run of runs) {
      const key = classify(run)
      const list = map.get(key)
      if (list && list.length < PER_AGENT) list.push(run)
    }
    return map
  }, [runs])

  const selected = selectedId ? runs.find(r => r.id === selectedId) || null : null

  if (selected) {
    const agent = AGENTS.find(a => a.key === classify(selected)) || AGENTS[AGENTS.length - 1]
    return <RunDetail run={selected} agent={agent} onBack={() => setSelectedId(null)} />
  }

  const activeRunning = runs.filter(r => r.status === 'running').length
  const errorCount = runs.filter(r => r.status === 'error').length

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Agent-Läufe · interne Historie</div>
            <h2 className="truncate text-base font-medium leading-6">
              {activeRunning > 0 ? `${activeRunning} Lauf${activeRunning === 1 ? '' : 'e'} aktiv` : 'Alle Agents ruhig'}
            </h2>
            <div className="truncate text-xs text-[var(--t3)]">
              {runs.length} Läufe{errorCount > 0 ? ` · ${errorCount} mit Fehler` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="Neu laden"
            className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>

        {error && (
          <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {AGENTS.map(agent => (
            <AgentCard
              key={agent.key}
              agent={agent}
              runs={grouped.get(agent.key) || []}
              onRun={runAgent}
              busy={busyAgent === agent.key}
              onSelect={run => setSelectedId(run.id)}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
