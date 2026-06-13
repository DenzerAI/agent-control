import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare, RefreshCw, ShieldCheck } from 'lucide-react'
import { refreshPulses, useAutomation, type WorkflowRun } from '../pulses'

type ChatagentStatus = 'ok' | 'warn' | 'critical'

type ChatagentCheck = {
  id: string
  label: string
  status: ChatagentStatus
  detail: string
  value?: string
  impact?: string
  action?: string
  attention?: boolean
}

type ChatagentReport = {
  generatedAt?: string
  savedAt?: number
  score: number
  status: ChatagentStatus
  actionRequired?: boolean
  attention?: { level: 'none' | 'klaus' | 'christian'; label: string; detail: string }
  summary: { critical: number; warnings: number; maintenance?: number; ok: number; verdict: string }
  runtime: {
    connectedClients: number
    activeProcesses: number
    activeTasks: number
    streamSessions: number
    streamSubscribers: number
  }
  responsiveness?: {
    status: ChatagentStatus
    label: string
    detail: string
    value: string
    samples?: number
    switchToVisibleMedianMs?: number | null
    switchToVisibleP95Ms?: number | null
    emptyBeforeDb?: number
    fresh?: boolean
  }
  checks: ChatagentCheck[]
  nextActions: string[]
}

type CachedReport = {
  report: ChatagentReport
  receivedAt: string
}

const EMPTY_REPORT: ChatagentReport = {
  score: 0,
  status: 'warn',
  actionRequired: false,
  attention: { level: 'none', label: 'Keine Aktion nötig', detail: 'Noch kein Check geladen.' },
  summary: { critical: 0, warnings: 0, maintenance: 0, ok: 0, verdict: 'Noch kein Check geladen.' },
  runtime: { connectedClients: 0, activeProcesses: 0, activeTasks: 0, streamSessions: 0, streamSubscribers: 0 },
  checks: [],
  nextActions: [],
}

const CHATAGENT_CACHE_KEY = 'workspace:chatagent:lastReport'

function readCache(): CachedReport | null {
  try {
    const raw = localStorage.getItem(CHATAGENT_CACHE_KEY)
    return raw ? JSON.parse(raw) as CachedReport : null
  } catch {
    return null
  }
}

function writeCache(value: CachedReport) {
  try { localStorage.setItem(CHATAGENT_CACHE_KEY, JSON.stringify(value)) } catch {}
}

function fetchJsonWithTimeout(url: string, init?: RequestInit, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', ...init, signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error(r.statusText || `HTTP ${r.status}`); return r.json() })
    .finally(() => window.clearTimeout(timer))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unbekannter Fehler'
}

function normalizeReport(data: unknown): ChatagentReport {
  const d = (data && typeof data === 'object') ? data as Partial<ChatagentReport> : {}
  return {
    ...EMPTY_REPORT,
    ...d,
    summary: { ...EMPTY_REPORT.summary, ...(d.summary || {}) },
    runtime: { ...EMPTY_REPORT.runtime, ...(d.runtime || {}) },
    checks: Array.isArray(d.checks) ? d.checks : [],
    nextActions: Array.isArray(d.nextActions) ? d.nextActions : [],
  }
}

function fmtAge(value?: string): string {
  if (!value) return 'nie'
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return 'gerade'
  const age = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function fmtWorkflowAge(ts: number): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function statusTone(status: ChatagentStatus): 'ok' | 'warn' | 'bad' {
  if (status === 'critical') return 'bad'
  if (status === 'warn') return 'warn'
  return 'ok'
}

function statusLabel(status: ChatagentStatus): string {
  if (status === 'critical') return 'kritisch'
  if (status === 'warn') return 'Hinweis'
  return 'sauber'
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function workflowTone(run: WorkflowRun): 'ok' | 'warn' | 'bad' {
  const learningClass = asText(run.review?.learning?.class)
  if (learningClass === 'blocker' || run.status === 'error' || run.review_status === 'error') return 'bad'
  if (learningClass === 'detour' || run.review_status === 'warning') return 'warn'
  return 'ok'
}

function workflowTitle(run: WorkflowRun): string {
  return run.title || run.workflow_key || run.id
}

function workflowDetail(run: WorkflowRun): string {
  const ref = asText(run.subject_ref)
  const prompt = asText(run.input?.prompt) || asText(run.input?.query) || asText(run.input?.text)
  const message = asText(run.review_message) || asText(run.error)
  return (ref || prompt || message || run.workflow_key || 'kein Detail').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function ChatagentWorkspace() {
  const automation = useAutomation()
  const [cached, setCached] = useState<CachedReport | null>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const storeReport = useCallback((report: ChatagentReport) => {
    const next = { report, receivedAt: new Date().toISOString() }
    setCached(next)
    writeCache(next)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    fetchJsonWithTimeout('/api/chatagent/status')
      .then(data => storeReport(normalizeReport(data)))
      .catch(e => setError(`Chatagent nicht erreichbar, letzter Stand bleibt: ${errorMessage(e)}`))
      .finally(() => setLoading(false))
  }, [storeReport])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 120000)
    return () => window.clearInterval(id)
  }, [load])

  const runCheck = useCallback(async () => {
    setRunning(true)
    setError('')
    try {
      const data = await fetchJsonWithTimeout('/api/chatagent/run', { method: 'POST' }, 25000)
      storeReport(normalizeReport(data))
      refreshPulses()
    } catch (e) {
      setError(`Check nicht gestartet, letzter Stand bleibt: ${errorMessage(e)}`)
    } finally {
      setRunning(false)
    }
  }, [storeReport])

  const report = cached?.report
  const checks = useMemo(() => {
    const weight = { critical: 0, warn: 1, ok: 2 }
    return [...(report?.checks || [])].sort((a, b) => weight[a.status] - weight[b.status])
  }, [report?.checks])
  const attentionChecks = useMemo(() => checks.filter(check => check.attention || check.status === 'critical').slice(0, 6), [checks])
  const maintenanceChecks = useMemo(() => checks.filter(check => !check.attention && check.status !== 'ok').slice(0, 5), [checks])
  const recentRuns = useMemo(() => automation.workflows
    .filter(run => run.workflow_key === 'agent.turn' || run.workflow_key === 'context.router' || run.workflow_key.includes('chat'))
    .slice(0, 5), [automation.workflows])

  if (!report) {
    return (
      <div className="workspace-system">
        <div className="workspace-system-note">
          {error || (loading ? 'Chatagent lädt ...' : 'Noch kein Chatagent-Stand geladen.')}
        </div>
        <header className="workspace-system-hero">
          <div>
            <p>Chatagent · Stabilität · Responsiveness</p>
            <h2>Stand laden</h2>
            <span>Die Ansicht bleibt leer, bis der erste Status oder Cache verfügbar ist.</span>
          </div>
          <button type="button" onClick={load} disabled={loading} title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </header>
      </div>
    )
  }

  const headline = report.actionRequired ? report.attention?.label || 'Aufmerksamkeit nötig' : 'Chat ruhig'
  const detail = report.attention?.detail || report.summary.verdict
  const primaryAction = report.nextActions[0] || 'Keine Sofortmaßnahme nötig.'
  const generatedAge = fmtAge(report.generatedAt || cached?.receivedAt)

  return (
    <div className="workspace-system">
      <header className="workspace-system-hero">
        <div>
          <p>Chatagent · {statusLabel(report.status)} · {generatedAge}</p>
          <h2>{headline}</h2>
          <span>{detail}</span>
        </div>
        <button type="button" onClick={load} disabled={loading || running} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </header>

      {error && <div className="workspace-system-note">{error}</div>}

      <div className="workspace-system-strip">
        <section className={report.status !== 'ok' ? 'is-warning' : ''}>
          <span>Score</span>
          <strong>{report.score}/100</strong>
          <em>{report.summary.verdict}</em>
        </section>
        <section className={report.summary.critical > 0 ? 'is-warning' : ''}>
          <span>Checks</span>
          <strong>{report.summary.ok} ok</strong>
          <em>{report.summary.warnings} Hinweise · {report.summary.critical} kritisch</em>
        </section>
        <section>
          <span>Streams</span>
          <strong>{report.runtime.streamSessions}</strong>
          <em>{report.runtime.streamSubscribers} Subscriber · {report.runtime.connectedClients} WS</em>
        </section>
        <section className={report.responsiveness?.status !== 'ok' ? 'is-warning' : ''}>
          <span>Responsiveness</span>
          <strong>{report.responsiveness?.value || 'offen'}</strong>
          <em>{report.responsiveness?.label || 'nicht gemessen'}</em>
        </section>
      </div>

      <div className="workspace-system-main">
        <section className="workspace-system-panel">
          <PanelHead title="Aktion" meta={running ? 'läuft' : 'bereit'} />
          <div className="workspace-system-list">
            <article className={`workspace-system-row is-${statusTone(report.status)}`}>
              <span />
              <div>
                <strong>{primaryAction}</strong>
                <em>{report.attention?.level === 'christian' ? 'Christian' : report.attention?.level === 'klaus' ? 'Agent' : 'niemand'} muss aktuell handeln.</em>
              </div>
              <aside>
                <button
                  type="button"
                  onClick={runCheck}
                  disabled={running || loading}
                  className="inline-flex items-center justify-end gap-1 rounded px-2 py-1 text-[var(--t2)] hover:bg-white/[0.06] disabled:opacity-60"
                >
                  <RefreshCw className={running ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  <b>Prüfen</b>
                </button>
              </aside>
            </article>
            {report.nextActions.slice(1, 4).map(action => (
              <article key={action} className="workspace-system-row is-warn">
                <span />
                <div>
                  <strong>{action}</strong>
                  <em>nächster Hebel</em>
                </div>
                <aside><i>Wartung</i></aside>
              </article>
            ))}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead title="Signale" meta={`${attentionChecks.length || maintenanceChecks.length} offen`} />
          <div className="workspace-system-list">
            {[...attentionChecks, ...maintenanceChecks].slice(0, 7).map(check => (
              <article key={check.id} className={`workspace-system-row is-${statusTone(check.status)}`}>
                <span />
                <div>
                  <strong>{check.label}</strong>
                  <em>{check.detail}</em>
                </div>
                <aside>
                  <b>{check.value || statusLabel(check.status)}</b>
                  <i>{check.attention ? 'Handlung' : check.status === 'ok' ? 'ok' : 'Wartung'}</i>
                </aside>
              </article>
            ))}
            {checks.length === 0 && <p>Keine Checks im letzten Stand.</p>}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead title="Runtime" meta={cached ? fmtAge(cached.receivedAt) : 'Cache leer'} />
          <div className="workspace-system-list">
            <MetricRow label="Aktive Prozesse" value={String(report.runtime.activeProcesses)} detail={`${report.runtime.activeTasks} Tasks`} tone={report.runtime.activeProcesses > 0 ? 'warn' : 'ok'} />
            <MetricRow label="Stream Sessions" value={String(report.runtime.streamSessions)} detail={`${report.runtime.streamSubscribers} Subscriber`} tone={report.runtime.streamSessions > 4 ? 'warn' : 'ok'} />
            <MetricRow label="WebSocket Clients" value={String(report.runtime.connectedClients)} detail="verbundene Browser" tone="ok" />
            <MetricRow label="Letzter Stand" value={generatedAge} detail={report.generatedAt || cached?.receivedAt || 'unbekannt'} tone="ok" />
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead title="Letzte Läufe" meta="/api/automation" />
          <div className="workspace-system-list">
            {recentRuns.map(run => (
              <article key={run.id} className={`workspace-system-row is-${workflowTone(run)}`}>
                <span />
                <div>
                  <strong>{workflowTitle(run)}</strong>
                  <em>{workflowDetail(run)}</em>
                </div>
                <aside>
                  <b>{run.status}</b>
                  <i>{fmtWorkflowAge(run.created_at)}</i>
                </aside>
              </article>
            ))}
            {recentRuns.length === 0 && <p>Keine passenden Workflow-Läufe im Automation-Snapshot.</p>}
          </div>
        </section>
      </div>
    </div>
  )
}

function PanelHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="workspace-system-panel-head">
      <div>
        <MessageSquare className="h-4 w-4" />
        <strong>{title}</strong>
      </div>
      <span>{meta}</span>
    </div>
  )
}

function MetricRow({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'ok' | 'warn' | 'bad' }) {
  return (
    <article className={`workspace-system-row is-${tone}`}>
      <span />
      <div>
        <strong>{label}</strong>
        <em>{detail}</em>
      </div>
      <aside>
        <ShieldCheck className="h-4 w-4" />
        <b>{value}</b>
      </aside>
    </article>
  )
}
