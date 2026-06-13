import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, CircuitBoard, ClipboardList, MessageSquare, RefreshCw, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { refreshPulses, useAutomation, type WorkflowRun } from '../pulses'

type CuratorProposal = {
  id: string
  targetKind: string
  targetSlug: string
  severity: string
  title: string
  pingEligible?: boolean
  pingReasons?: string[]
}

type BibliothekarInfo = {
  proposalCount: number
  totalOpenCount: number
  pingEligibleCount: number
  skillsReady: number
  jobsReady: number
  proposals: CuratorProposal[]
}

type JobRegistryJob = {
  id: string
  name: string
  purpose?: string
  enabled?: boolean
  lastRunAt?: number
  lastRunStatus?: string
  governance?: { status?: string; checks?: { status?: string; message?: string }[] }
}

type JobRegistryInfo = {
  total: number
  enabled: number
  withLastRun: number
  ready: number
  warn: number
  blocked: number
  looseLaunchdCount: number
  agentCount: number
  unclassifiedAgentCount: number
  roleCounts: { role: string; count: number }[]
  jobs: JobRegistryJob[]
  looseLaunchd: { label: string; slug: string; path: string }[]
  unclassifiedAgents: { label: string; role?: string; path: string }[]
}

const EMPTY_BIBLIOTHEKAR: BibliothekarInfo = {
  proposalCount: 0,
  totalOpenCount: 0,
  pingEligibleCount: 0,
  skillsReady: 0,
  jobsReady: 0,
  proposals: [],
}

const EMPTY_JOB_REGISTRY: JobRegistryInfo = {
  total: 0,
  enabled: 0,
  withLastRun: 0,
  ready: 0,
  warn: 0,
  blocked: 0,
  looseLaunchdCount: 0,
  agentCount: 0,
  unclassifiedAgentCount: 0,
  roleCounts: [],
  jobs: [],
  looseLaunchd: [],
  unclassifiedAgents: [],
}

const BIB_CACHE_KEY = 'workspace:systemagent:bibliothekar'
const JOB_CACHE_KEY = 'workspace:systemagent:jobs'

function readCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

function writeCache(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

function fetchJsonWithTimeout(url: string, init?: RequestInit, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', ...init, signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
    .finally(() => window.clearTimeout(timer))
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function workflowLabel(key: string): string {
  if (key === 'agent.turn') return 'Agentenlauf'
  if (key === 'context.router') return 'Context Router'
  if (key === 'job.run') return 'Job Lauf'
  if (key === 'pulse.run') return 'Pulse Lauf'
  if (key === 'worker.tick') return 'Worker Lauf'
  if (key === 'hook.tick') return 'Hook Lauf'
  if (key === 'whatsapp.send') return 'WhatsApp Send'
  return key
}

function workflowOutcome(run: WorkflowRun): string {
  const learningClass = asText(run.review?.learning?.class)
  if (learningClass === 'blocker') return 'Blocker'
  if (learningClass === 'detour') return 'Umweg'
  if (run.status === 'error' || run.review_status === 'error') return 'Fehler'
  if (run.review_status === 'warning') return 'Warnung'
  return run.status === 'done' ? 'sauber' : run.status || 'läuft'
}

function workflowSubject(run: WorkflowRun): string {
  const ref = asText(run.subject_ref)
  if (ref) return ref
  const text = asText(run.input?.prompt) || asText(run.input?.query) || asText(run.input?.text)
  return text.replace(/\s+/g, ' ').trim().slice(0, 96)
}

type RowTone = 'ok' | 'warn' | 'bad' | 'neutral'

function runTone(run: WorkflowRun): RowTone {
  const learningClass = asText(run.review?.learning?.class)
  if (learningClass === 'blocker' || run.status === 'error' || run.review_status === 'error') return 'bad'
  if (learningClass === 'detour' || run.review_status === 'warning') return 'warn'
  return 'ok'
}

export function SystemagentWorkspace() {
  const snap = useAutomation()
  const [bibliothekar, setBibliothekar] = useState<BibliothekarInfo>(() => readCache(BIB_CACHE_KEY, EMPTY_BIBLIOTHEKAR))
  const [jobRegistry, setJobRegistry] = useState<JobRegistryInfo>(() => readCache(JOB_CACHE_KEY, EMPTY_JOB_REGISTRY))
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')

    fetchJsonWithTimeout('/api/skill-bibliothekar')
      .then(data => {
        const d = data as Record<string, any>
        const registry = d?.summary?.registry || {}
        const next: BibliothekarInfo = {
          proposalCount: Number(d.proposalCount || 0),
          totalOpenCount: Number(d.totalOpenCount || 0),
          pingEligibleCount: Number(d.pingSummary?.eligibleCount || 0),
          skillsReady: Number(registry.skills?.statuses?.ready || 0),
          jobsReady: Number(registry.jobs?.statuses?.ready || 0),
          proposals: Array.isArray(d.proposals) ? d.proposals : [],
        }
        setBibliothekar(next)
        writeCache(BIB_CACHE_KEY, next)
      })
      .catch(e => setError(`Werkstatt gerade nicht erreichbar, letzter Stand bleibt: ${e.message}`))

    fetchJsonWithTimeout('/api/job-governance')
      .then(data => {
        const d = data as Record<string, any>
        const governance = d?.summary || {}
        const statuses = governance.statuses || {}
        const launchd = d?.launchd || {}
        const unclassifiedAgents = Array.isArray(launchd.unclassifiedAgents) ? launchd.unclassifiedAgents : []
        const next: JobRegistryInfo = {
          total: Number(governance.total || 0),
          enabled: Number(governance.enabled || 0),
          withLastRun: Number(governance.withLastRun || 0),
          ready: Number(statuses.ready || 0),
          warn: Number(statuses.warn || 0),
          blocked: Number(statuses.blocked || 0),
          looseLaunchdCount: Number((launchd.looseJobs || []).length || 0),
          agentCount: Number(launchd.agentCount || 0),
          unclassifiedAgentCount: Number(unclassifiedAgents.length || 0),
          roleCounts: Array.isArray(launchd.roleCounts) ? launchd.roleCounts : [],
          jobs: Array.isArray(d.jobs) ? d.jobs : [],
          looseLaunchd: Array.isArray(launchd.looseJobs) ? launchd.looseJobs : [],
          unclassifiedAgents,
        }
        setJobRegistry(next)
        writeCache(JOB_CACHE_KEY, next)
      })
      .catch(e => setError(prev => prev || `Jobübersicht gerade nicht erreichbar, letzter Stand bleibt: ${e.message}`))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 180000)
    return () => window.clearInterval(id)
  }, [load])

  const runSystemagent = useCallback(async () => {
    setRunning(true)
    setError('')
    try {
      await fetchJsonWithTimeout('/api/systemagent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, 25000)
      refreshPulses()
      load()
    } catch (e) {
      setError(`Lauf nicht gestartet, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }, [load])

  const recentRuns = useMemo(() => snap.workflows.slice(0, 10), [snap.workflows])
  const eventRuns = useMemo(() => snap.workflows.filter(run => {
    const learningClass = asText(run.review?.learning?.class)
    if (learningClass === 'blocker' || run.review_status === 'error' || run.status === 'error') return true
    if (run.workflow_key !== 'agent.turn' && (learningClass === 'detour' || run.review_status === 'warning')) return true
    return false
  }).slice(0, 6), [snap.workflows])

  const jobIssues = jobRegistry.warn + jobRegistry.blocked + jobRegistry.looseLaunchdCount + jobRegistry.unclassifiedAgentCount
  const openDecisions = bibliothekar.pingEligibleCount
  const headline = openDecisions > 0
    ? 'Entscheidung offen'
    : eventRuns.length > 0 || jobIssues > 0
      ? 'System prüfen'
      : 'System ruhig'
  const detail = openDecisions > 0
    ? `${openDecisions} Punkt${openDecisions === 1 ? '' : 'e'} sind entscheidungsreif.`
    : eventRuns.length > 0 || jobIssues > 0
      ? 'Es gibt Hinweise, aber nichts wird versteckt.'
      : 'Keine akute Aktion für Christian.'

  return (
    <div className="workspace-system">
      <header className="workspace-system-hero">
        <div>
          <p>Systemagent · Logbuch · Werkstatt · Entscheidungen</p>
          <h2>{headline}</h2>
          <span>{detail}</span>
        </div>
        <button type="button" onClick={load} disabled={loading} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
        <button type="button" onClick={runSystemagent} disabled={running} title="Systemagent laufen lassen">
          <CircuitBoard className={running ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </header>

      {error && <div className="workspace-system-note">{error}</div>}

      <div className="workspace-system-strip">
        <MetricCard label="Entscheidungen" value={String(openDecisions)} detail={openDecisions ? 'für Christian' : 'keine offen'} warn={openDecisions > 0} />
        <MetricCard label="Werkzeuge" value={String(bibliothekar.proposalCount)} detail={`${bibliothekar.skillsReady} Skills · ${bibliothekar.jobsReady} Jobs`} warn={bibliothekar.proposalCount > 0} />
        <MetricCard label="Jobs" value={`${jobRegistry.ready}/${jobRegistry.total}`} detail={`${jobRegistry.enabled} aktiv`} warn={jobIssues > 0} />
        <MetricCard label="Logbuch" value={String(eventRuns.length)} detail={`${recentRuns.length} letzte Läufe`} warn={eventRuns.length > 0} />
      </div>

      <div className="workspace-system-main">
        <section className="workspace-system-panel">
          <PanelHead icon={BookOpen} label="Logbuch" value={recentRuns.length ? fmtAge(recentRuns[0].created_at) : 'leer'} />
          <div className="workspace-system-list">
            {recentRuns.map(run => (
              <StatusRow
                key={run.id}
                tone={runTone(run)}
                label={workflowLabel(run.workflow_key)}
                value={workflowOutcome(run)}
                meta={fmtAge(run.created_at)}
                detail={workflowSubject(run) || run.review_message || run.id}
              />
            ))}
            {recentRuns.length === 0 && <p>Keine Läufe im Snapshot.</p>}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={Wrench} label="Werkstatt" value={`${bibliothekar.proposalCount} offen`} />
          <div className="workspace-system-list">
            {bibliothekar.proposals.slice(0, 8).map(proposal => (
              <StatusRow
                key={proposal.id}
                tone={proposal.pingEligible ? 'warn' : 'neutral'}
                label={proposal.targetSlug || proposal.targetKind}
                value={proposal.pingReasons?.[0] || proposal.severity || 'Hinweis'}
                detail={proposal.title}
              />
            ))}
            {bibliothekar.proposals.length === 0 && <p>Werkzeuge sind sauber.</p>}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={ClipboardList} label="Jobs" value={`${jobRegistry.enabled} aktiv`} />
          <div className="workspace-system-list">
            {jobRegistry.jobs
              .filter(job => job.governance?.status && job.governance.status !== 'ready')
              .slice(0, 8)
              .map(job => {
                const check = job.governance?.checks?.find(c => c.status !== 'ok' && c.message)
                return (
                  <StatusRow
                    key={job.id}
                    tone={job.governance?.status === 'blocked' ? 'bad' : 'warn'}
                    label={job.name}
                    value={job.governance?.status || 'offen'}
                    meta={fmtAge(job.lastRunAt)}
                    detail={check?.message || job.purpose || 'Betriebsbeschreibung prüfen.'}
                  />
                )
              })}
            {jobIssues === 0 && <p>Keine offenen Job-Hinweise.</p>}
            {jobRegistry.looseLaunchd.slice(0, 4).map(item => (
              <StatusRow key={item.label} tone="warn" label={item.slug || item.label} value="lose" detail={item.path} />
            ))}
            {jobRegistry.unclassifiedAgents.slice(0, 4).map(item => (
              <StatusRow key={item.label} tone="warn" label={item.label} value="offen" detail={item.path} />
            ))}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={MessageSquare} label="Entscheidungen" value={openDecisions > 0 ? `${openDecisions} offen` : 'ruhig'} />
          <div className="workspace-system-list">
            {bibliothekar.proposals.filter(p => p.pingEligible).map(proposal => (
              <StatusRow
                key={proposal.id}
                tone="warn"
                label={proposal.targetSlug || proposal.targetKind}
                value={proposal.pingReasons?.[0] || 'entscheiden'}
                detail={proposal.title}
              />
            ))}
            {openDecisions === 0 && (
              <StatusRow
                tone="ok"
                label="Keine Aktion"
                value="sauber"
                detail="Der Systemagent meldet sich nur, wenn ein Lauf auffällig war oder eine echte Entscheidung offen ist."
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function MetricCard({ label, value, detail, warn }: { label: string; value: string; detail: string; warn?: boolean }) {
  return (
    <section className={warn ? 'is-warning' : ''}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </section>
  )
}

function PanelHead({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="workspace-system-panel-head">
      <div>
        <Icon className="h-4 w-4" />
        <strong>{label}</strong>
      </div>
      <span>{value}</span>
    </div>
  )
}

function StatusRow({ tone, label, value, meta, detail }: {
  tone: RowTone
  label: string
  value: string
  meta?: string
  detail: string
}) {
  return (
    <article className={`workspace-system-row is-${tone}`}>
      <span />
      <div>
        <strong>{label}</strong>
        <em>{detail}</em>
      </div>
      <aside>
        <b>{value}</b>
        {meta && <i>{meta}</i>}
      </aside>
    </article>
  )
}
