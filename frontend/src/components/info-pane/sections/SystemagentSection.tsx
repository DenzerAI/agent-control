import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, ChevronRight, CircuitBoard, ListChecks, MessageSquare, RefreshCw, Wrench } from 'lucide-react'
import { useAutomation, refreshPulses, type WorkflowRun } from '../../../pulses'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type CuratorProposal = {
  id: string
  targetKind: string
  targetSlug: string
  severity: string
  title: string
  fields?: string[]
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
  owner?: string
  purpose?: string
  enabled?: boolean
  schedule?: string
  promptPath?: string
  runsLogPath?: string
  logPath?: string
  lastRunAt?: number
  lastRunStatus?: string
  governance?: { status?: string; openCount?: number; checks?: { status?: string; message?: string }[] }
  manifest?: { status?: string; coverage?: number; missing?: string[] }
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

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
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

function workflowTone(run: WorkflowRun): string {
  const learningClass = asText(run.review?.learning?.class)
  if (learningClass === 'blocker' || run.status === 'error' || run.review_status === 'error') return 'text-[var(--cc-orange)]'
  if (learningClass === 'detour' || run.review_status === 'warning') return 'text-[var(--cc-orange)]/85'
  return 'text-[var(--t3)]'
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
  return text.replace(/\s+/g, ' ').trim().slice(0, 90)
}

function DetailLine({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="info-detail-row">
      <span className="info-detail-label">{label}</span>
      <span className="info-detail-value">{value}</span>
    </div>
  )
}

function SubFolder({ title, icon: Icon, count, attention, mobile, children }: {
  title: string
  icon: typeof BookOpen
  count?: number
  attention?: boolean
  mobile?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Icon className={`info-icon-sm mr-2 flex-shrink-0 ${attention ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'} group-hover:text-[var(--t2)]`} />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{title}</span>
        {count != null && <span className={`info-text-meta tabular-nums flex-shrink-0 ${attention ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`}>{count}</span>}
      </button>
      {open && <Guided>{children}</Guided>}
    </div>
  )
}

function WorkflowRow({ run, mobile }: { run: WorkflowRun; mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const subject = workflowSubject(run)
  const learning = run.review?.learning
  const highway = asText(learning?.highway_note)
  const suggestion = asText(run.review?.suggested_refinement)
  const learningLabel = asText(learning?.label)
  const detours = asNum(learning?.detour_count ?? run.review?.metrics?.detour_count)
  const blockers = asNum(learning?.blocker_count ?? run.review?.metrics?.blocker_count)
  const learnings = asNum(learning?.learning_count ?? run.review?.metrics?.learning_count)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${workflowTone(run).includes('orange') ? 'bg-[var(--cc-orange)]' : 'bg-emerald-500'}`} />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{workflowLabel(run.workflow_key)}{subject ? ` · ${subject}` : ''}</span>
        <span className={`info-text-meta flex-shrink-0 ${workflowTone(run)}`}>{workflowOutcome(run)}</span>
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0 tabular-nums">{fmtAge(run.created_at)}</span>
      </button>
      {open && (
        <Guided>
          <div className="info-detail-list info-text-meta">
            <DetailLine label="Prüfung" value={run.review_message || 'noch offen'} />
            <DetailLine label="Lernen" value={learningLabel ? `${learningLabel} · ${detours} Umwege · ${blockers} Blocker · ${learnings} Learnings` : ''} />
            <DetailLine label="Straße" value={highway || suggestion || 'Keine neue Regel nötig.'} />
            <DetailLine label="Run" value={run.id} />
          </div>
        </Guided>
      )}
    </div>
  )
}

function BibliothekarRow({ info, mobile }: { info: BibliothekarInfo; mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const clean = info.proposalCount === 0 && info.totalOpenCount === 0
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${clean ? 'bg-emerald-500' : 'bg-[var(--cc-orange)]'}`} />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{clean ? 'Werkzeuge sauber' : 'Werkzeuge prüfen'}</span>
        <span className={`info-text-meta flex-shrink-0 tabular-nums ${clean ? 'text-[var(--t3)]' : 'text-[var(--cc-orange)]'}`}>{info.proposalCount}</span>
      </button>
      {open && (
        <Guided>
          <div className="info-detail-list info-text-meta">
            <DetailLine label="Stand" value={clean ? 'Alle Skill- und Job-Beschreibungen sind bereit.' : `${info.proposalCount} aktive Pflegepunkte.`} />
            <DetailLine label="Bestand" value={`${info.skillsReady} Skills · ${info.jobsReady} Jobs`} />
            <DetailLine label="Ping" value={info.pingEligibleCount > 0 ? `${info.pingEligibleCount} entscheidungsreif` : 'Kein Ping nötig.'} />
          </div>
          {info.proposals.slice(0, 5).map(proposal => (
            <div key={proposal.id} className={`pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} hover:bg-white/[0.04] transition-colors`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className={`info-text-meta min-w-[48px] flex-shrink-0 ${proposal.pingEligible ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`}>
                  {proposal.pingReasons?.[0] || proposal.severity || 'Hinweis'}
                </span>
                <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">{proposal.targetKind}</span>
                <span className="info-text-meta text-[var(--t2)] truncate">{proposal.targetSlug}</span>
              </div>
              <div className="info-text-meta text-[var(--t3)]/75 truncate">{proposal.title}</div>
            </div>
          ))}
        </Guided>
      )}
    </div>
  )
}

function JobRegistryRow({ info, mobile }: { info: JobRegistryInfo; mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const clean = info.warn === 0 && info.blocked === 0 && info.looseLaunchdCount === 0 && info.unclassifiedAgentCount === 0
  const openJobs = info.jobs
    .filter(job => job.governance?.status && job.governance.status !== 'ready')
    .slice(0, 5)
  const roleSummary = info.roleCounts.length > 0
    ? info.roleCounts.map(item => `${item.count} ${item.role}`).join(' · ')
    : 'Keine Agenten/Wächter.'
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${clean ? 'bg-emerald-500' : 'bg-[var(--cc-orange)]'}`} />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{clean ? 'Jobs sauber' : 'Jobs prüfen'}</span>
        <span className={`info-text-meta flex-shrink-0 tabular-nums ${clean ? 'text-[var(--t3)]' : 'text-[var(--cc-orange)]'}`}>{info.warn + info.blocked + info.looseLaunchdCount + info.unclassifiedAgentCount}</span>
      </button>
      {open && (
        <Guided>
          <div className="info-detail-list info-text-meta">
            <DetailLine label="Bestand" value={`${info.total} Jobs · ${info.enabled} aktiv · ${info.withLastRun} mit Lauflog`} />
            <DetailLine label="Status" value={`${info.ready} bereit · ${info.warn} prüfen · ${info.blocked} blockiert`} />
            <DetailLine label="Wächter" value={`${info.agentCount} klassifiziert · ${roleSummary}`} />
            <DetailLine label="Nebenläufer" value={info.looseLaunchdCount > 0 ? `${info.looseLaunchdCount} launchd-Einträge ohne Job-Manifest` : 'Keine losen launchd-Jobs.'} />
            <DetailLine label="Agenten" value={info.unclassifiedAgentCount > 0 ? `${info.unclassifiedAgentCount} unklassifiziert` : 'Keine unklassifizierten Agenten.'} />
          </div>
          {openJobs.map(job => {
            const check = job.governance?.checks?.find(c => c.status !== 'ok' && c.message)
            return (
              <div key={job.id} className={`pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} hover:bg-white/[0.04] transition-colors`}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="info-text-meta min-w-[48px] flex-shrink-0 text-[var(--cc-orange)]">{job.governance?.status || 'offen'}</span>
                  <span className="info-text-meta text-[var(--t2)] truncate">{job.name}</span>
                </div>
                <div className="info-text-meta text-[var(--t3)]/75 truncate">{check?.message || job.purpose || 'Betriebsbeschreibung prüfen.'}</div>
              </div>
            )
          })}
          {info.looseLaunchd.slice(0, 4).map(item => (
            <div key={item.label} className={`pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} hover:bg-white/[0.04] transition-colors`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="info-text-meta min-w-[48px] flex-shrink-0 text-[var(--cc-orange)]">lose</span>
                <span className="info-text-meta text-[var(--t2)] truncate">{item.slug || item.label}</span>
              </div>
              <div className="info-text-meta text-[var(--t3)]/75 truncate">{item.path}</div>
            </div>
          ))}
          {info.unclassifiedAgents.slice(0, 4).map(item => (
            <div key={item.label} className={`pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} hover:bg-white/[0.04] transition-colors`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="info-text-meta min-w-[48px] flex-shrink-0 text-[var(--cc-orange)]">offen</span>
                <span className="info-text-meta text-[var(--t2)] truncate">{item.label}</span>
              </div>
              <div className="info-text-meta text-[var(--t3)]/75 truncate">{item.path}</div>
            </div>
          ))}
        </Guided>
      )}
    </div>
  )
}

function DecisionRow({ info, mobile }: { info: BibliothekarInfo; mobile?: boolean }) {
  const decisionProposals = info.proposals.filter(proposal => proposal.pingEligible)
  if (decisionProposals.length === 0) {
    return (
      <div className="info-detail-list info-text-meta">
        <DetailLine label="Stand" value="Keine Entscheidung für der Nutzer offen." />
        <DetailLine label="Ping" value="Der Systemagent meldet sich nur, wenn ein Lauf auffällig war oder eine echte Entscheidung offen ist." />
        <DetailLine label="Regel" value="Normale Umwege bleiben im Logbuch; Werkzeugpflege liegt in der Werkstatt." />
      </div>
    )
  }
  return (
    <>
      {decisionProposals.map(proposal => (
        <div key={proposal.id} className={`pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} hover:bg-white/[0.04] transition-colors`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="info-text-meta min-w-[68px] text-[var(--cc-orange)] flex-shrink-0">{proposal.pingReasons?.[0] || 'entscheiden'}</span>
            <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">{proposal.targetKind}</span>
            <span className="info-text-meta text-[var(--t2)] truncate">{proposal.targetSlug}</span>
          </div>
          <div className="info-text-meta text-[var(--t3)]/75 truncate">{proposal.title}</div>
        </div>
      ))}
    </>
  )
}

export function SystemagentSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <SystemagentWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <SystemagentInlineSection mobile={mobile} />
}

function SystemagentWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Systemagent im Workspace öffnen"
      >
        <CircuitBoard className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Systemagent</span>
      </button>
    </div>
  )
}

function SystemagentInlineSection({ mobile }: { mobile?: boolean }) {
  const snap = useAutomation()
  const [open, setOpen] = useState(false)
  const [bibliothekar, setBibliothekar] = useState<BibliothekarInfo>(EMPTY_BIBLIOTHEKAR)
  const [jobRegistry, setJobRegistry] = useState<JobRegistryInfo>(EMPTY_JOB_REGISTRY)
  const [loading, setLoading] = useState(false)
  const [systemagentRunning, setSystemagentRunning] = useState(false)

  const loadBibliothekar = useCallback(async () => {
    setLoading(true)
    try {
      const [res, jobsRes] = await Promise.all([
        fetch('/api/skill-bibliothekar', { cache: 'no-store' }),
        fetch('/api/job-governance', { cache: 'no-store' }),
      ])
      const data = await res.json().catch(() => ({}))
      const jobsData = await jobsRes.json().catch(() => ({}))
      const registry = data?.summary?.registry || {}
      const governance = jobsData?.summary || {}
      const statuses = governance.statuses || {}
      const launchd = jobsData?.launchd || {}
      const unclassifiedAgents = Array.isArray(launchd.unclassifiedAgents) ? launchd.unclassifiedAgents : []
      setBibliothekar({
        proposalCount: Number(data.proposalCount || 0),
        totalOpenCount: Number(data.totalOpenCount || 0),
        pingEligibleCount: Number(data.pingSummary?.eligibleCount || 0),
        skillsReady: Number(registry.skills?.statuses?.ready || 0),
        jobsReady: Number(registry.jobs?.statuses?.ready || 0),
        proposals: Array.isArray(data.proposals) ? data.proposals : [],
      })
      setJobRegistry({
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
        jobs: Array.isArray(jobsData.jobs) ? jobsData.jobs : [],
        looseLaunchd: Array.isArray(launchd.looseJobs) ? launchd.looseJobs : [],
        unclassifiedAgents,
      })
    } catch {
      setBibliothekar(EMPTY_BIBLIOTHEKAR)
      setJobRegistry(EMPTY_JOB_REGISTRY)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadBibliothekar() }, [loadBibliothekar])

  const runSystemagent = useCallback(async () => {
    setSystemagentRunning(true)
    try {
      await fetch('/api/systemagent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      refreshPulses()
      loadBibliothekar()
    } finally {
      setSystemagentRunning(false)
    }
  }, [loadBibliothekar])

  const recentRuns = useMemo(() => snap.workflows.slice(0, 8), [snap.workflows])
  const eventRuns = useMemo(() => snap.workflows.filter(run => {
    const learningClass = asText(run.review?.learning?.class)
    if (learningClass === 'blocker' || run.review_status === 'error' || run.status === 'error') return true
    if (run.workflow_key !== 'agent.turn' && (learningClass === 'detour' || run.review_status === 'warning')) return true
    return false
  }).slice(0, 6), [snap.workflows])
  const needsAttention = bibliothekar.pingEligibleCount > 0 || eventRuns.length > 0 || jobRegistry.warn > 0 || jobRegistry.blocked > 0 || jobRegistry.looseLaunchdCount > 0 || jobRegistry.unclassifiedAgentCount > 0

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
        <CircuitBoard className={`info-icon-md mr-2 flex-shrink-0 ${needsAttention ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Systemagent</span>
        <span className="flex-1" />
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); runSystemagent() }}
            className="ml-2 p-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Systemagent laufen lassen"
          >
            <RefreshCw className={`info-icon-sm ${loading || systemagentRunning ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            <div className="pl-1 pr-3 py-2 info-text-meta text-[var(--t3)]/75 leading-relaxed">
              Ich beobachte Läufe, prüfe Werkzeuge und melde mich nur, wenn etwas passiert ist oder der Nutzer wirklich handeln muss.
            </div>
            <SubFolder title="Logbuch" icon={BookOpen} count={recentRuns.length} attention={eventRuns.length > 0} mobile={mobile}>
              {recentRuns.length > 0 ? recentRuns.map(run => <WorkflowRow key={run.id} run={run} mobile={mobile} />) : (
                <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">Noch leer.</div>
              )}
            </SubFolder>
            <SubFolder title="Werkstatt" icon={Wrench} count={bibliothekar.proposalCount} attention={bibliothekar.proposalCount > 0} mobile={mobile}>
              <BibliothekarRow info={bibliothekar} mobile={mobile} />
            </SubFolder>
            <SubFolder title="Jobübersicht" icon={ListChecks} count={jobRegistry.total} attention={jobRegistry.warn > 0 || jobRegistry.blocked > 0 || jobRegistry.looseLaunchdCount > 0 || jobRegistry.unclassifiedAgentCount > 0} mobile={mobile}>
              <JobRegistryRow info={jobRegistry} mobile={mobile} />
            </SubFolder>
            <SubFolder title="Entscheidungen" icon={MessageSquare} count={bibliothekar.pingEligibleCount} attention={bibliothekar.pingEligibleCount > 0} mobile={mobile}>
              <DecisionRow info={bibliothekar} mobile={mobile} />
            </SubFolder>
          </Guided>
        </div>
      )}
    </div>
  )
}
