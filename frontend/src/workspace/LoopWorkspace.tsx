import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Link2, Loader2, Play, RefreshCw, Square, Trash2 } from 'lucide-react'

const AGENT_CHANNEL_ID = ['kl', 'aus-channel'].join('')

type LoopStep = {
  key: string
  label: string
  status: string
  summary: string
  ts?: number
}

type LoopRun = {
  id: string
  kind: string
  status: string
  created_at: number
  updated_at: number
  parent_conversation_id?: string
  parent?: { id?: string; title?: string; agent?: string; project?: string } | null
  input: { customer: string; goal: string; notes?: string; trigger?: string }
  steps: LoopStep[]
  verifier?: { missing?: string[] }
  artifacts?: { html_path?: string; markdown_path?: string; offer_dir?: string }
  preview_html?: string
  preview_markdown?: string
}

type WerkbankTask = {
  id: string
  title: string
  status: string
  priority?: string
  created_at: number
  updated_at: number
  origin?: { conversation_id?: string; title?: string; agent?: string; project?: string; pane?: number | null }
  request?: { brief?: string; acceptance?: string; notes?: string; worker_conversation_id?: string; source?: string }
  loop?: { round?: number; max_rounds?: number; policy?: string }
  workers?: { id: string; role: string; status: string; summary?: string }[]
  verifier?: { decision?: string; findings?: string[]; summary?: string; checked_at?: number }
  artifacts?: { protocol_path?: string; html_path?: string; markdown_path?: string }
  metrics?: {
    elapsed_ms?: number
    tool_count?: number
    tool_budget?: number
    tool_budget_exceeded?: boolean
    input_tokens?: number
    output_tokens?: number
    token_budget?: number
    token_budget_exceeded?: boolean
    changed_lines?: { added?: number; removed?: number }
  }
  live?: {
    running?: boolean
    elapsed_ms?: number | null
    output_tokens?: number
    input_tokens?: number
    tool_count?: number
    added?: number
    removed?: number
    last_activity_at?: number | null
  } | null
  history?: { ts?: number; label: string; summary: string; status?: string }[]
  followups?: { id?: string; text?: string; status?: string; created_at?: number; consumed_at?: number }[]
  rate?: { limit_per_hour?: number; used?: number; remaining?: number; reset_at?: number }
  next_action?: string
}

type WerkbankRate = {
  limit_per_hour: number
  used: number
  remaining: number
  reset_at: number
  blocked: boolean
}

type ToolFeedItem = {
  index: number
  name: string
  label: string
  status: string
  result_snippet: string
  args: Record<string, unknown>
  added: number
  removed: number
}

type TaskFeed = {
  conversation_id: string
  available: boolean
  items: ToolFeedItem[]
  live: {
    running: boolean
    elapsed_ms: number | null
    output_tokens: number
    input_tokens: number
    tool_count: number
    added: number
    removed: number
    last_activity_at?: number | null
  }
  queue?: { id?: string; status?: string; created_at?: number } | null
}

type Conversation = {
  id: string
  title: string
  agent: string
  updated_at: number
}

const DRAFT_KEY = 'workspace:loops:draft'
type LoopDraft = {
  parent_conversation_id?: string
  suggested_goal?: string
  view?: 'werkbank' | 'bauhof' | 'offers'
  werkbank_task_id?: string
  werkbank_title?: string
  werkbank_brief?: string
  bauhof_title?: string
  bauhof_brief?: string
}

function readDraft(): LoopDraft {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function fmtAge(ts?: number): string {
  if (!ts) return 'gerade'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function fmtDurSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `${m}m${String(r).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function fmtTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace('.', ',')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace('.', ',')}K`
  return String(n)
}

function taskElapsedMs(task: WerkbankTask, live?: TaskFeed['live'] | null): number {
  const liveElapsed = task.status === 'running' || live?.running ? Number((live || task.live)?.elapsed_ms || 0) : 0
  if (liveElapsed > 0) return liveElapsed
  return Number(task.metrics?.elapsed_ms || 0)
}

function taskDurationSeconds(task: WerkbankTask, live?: TaskFeed['live'] | null): number {
  const elapsed = taskElapsedMs(task, live)
  if (elapsed > 0) return Math.max(0, Math.round(elapsed / 1000))
  if (task.status === 'done' && task.created_at && task.updated_at) {
    return Math.max(0, Math.round(Number(task.updated_at) - Number(task.created_at)))
  }
  const start = Number(task.created_at || task.updated_at || 0)
  if (!start) return 0
  return Math.max(0, Math.floor(Date.now() / 1000 - start))
}

function taskTimeLabel(task: WerkbankTask, live?: TaskFeed['live'] | null): string {
  return fmtDurSeconds(taskDurationSeconds(task, live))
}

function taskLive(task: WerkbankTask) {
  return task.status === 'running' ? task.live || null : null
}

function taskDiffValues(task: WerkbankTask): { added: number; removed: number; live: boolean } {
  const live = taskLive(task)
  if (live) return { added: Number(live.added || 0), removed: Number(live.removed || 0), live: true }
  const cl = task.metrics?.changed_lines
  return { added: Number(cl?.added || 0), removed: Number(cl?.removed || 0), live: false }
}

function taskToolValue(task: WerkbankTask): string {
  const live = taskLive(task)
  if (live) return `${Number(live.tool_count || 0)}`
  const count = Number(task.metrics?.tool_count || 0)
  if (!count) return ''
  return `${count}`
}

function taskToolNumber(task: WerkbankTask): number {
  const live = taskLive(task)
  return Number(live?.tool_count ?? task.metrics?.tool_count ?? 0)
}

function taskTokenValue(task: WerkbankTask): string {
  const live = taskLive(task)
  if (live) return fmtTokens(Number(live.input_tokens || 0) + Number(live.output_tokens || 0))
  const tokens = Number(task.metrics?.input_tokens || 0) + Number(task.metrics?.output_tokens || 0)
  if (!tokens) return ''
  return fmtTokens(tokens)
}

function taskRunLabel(task: WerkbankTask): string {
  const round = Number(task.loop?.round || 0)
  const followupRuns = (task.history || []).filter(item =>
    /folge-lauf|korrektur-lauf/i.test(`${item.label || ''} ${item.summary || ''}`),
  ).length
  const consumedFollowups = (task.followups || []).filter(item => item.status === 'consumed').length
  const run = Math.max(round, 1 + followupRuns, 1 + consumedFollowups)
  return run > 1 ? `${run}. Lauf` : ''
}

function taskDisplayTitle(task: WerkbankTask): string {
  const title = String(task.title || task.id || '')
    .replace(/^Arbeitsauftrag:\s*/i, '')
    .replace(/^Werkbank\s*[:·-]\s*/i, '')
    .replace(/^HTML-Artefakt:\s*/i, '')
    .trim()
  if (!title) return 'Werkbank-Auftrag'
  return title.length > 58 ? `${title.slice(0, 57).trim()}…` : title
}

function taskOriginParts(task: WerkbankTask): { pane: string; session: string } {
  const origin = task.origin || {}
  const conv = String(origin.conversation_id || '')
  const raw = String(origin.title || '').replace(/^Werkbank\s*[:·-]\s*/i, '').trim()
  const session = raw && raw !== 'Ohne Ursprungschat' ? raw : (conv ? `Chat ${conv.slice(0, 8)}` : 'ohne Chat')
  const paneNum = typeof origin.pane === 'number' ? origin.pane : null
  let pane = ''
  if (conv === AGENT_CHANNEL_ID) pane = 'Agent-Channel'
  else if (paneNum !== null && paneNum >= 0) pane = `Pane ${paneNum + 1}`
  return { pane, session }
}

function humanHistoryLabel(label: string, status?: string): string {
  const raw = `${label || ''} ${status || ''}`.toLowerCase()
  if (/blocked|needs|input|rate|fehler|error/.test(raw)) return 'Braucht Blick'
  if (/done|fertig|zurück|zurueck|completed/.test(raw)) return 'Zurückgemeldet'
  if (/prüf|pruef|verify|verifier|check/.test(raw)) return 'Geprüft'
  if (/start|running|worker|arbeitslauf|werkbank-worker|chatlauf/.test(raw)) return 'Arbeit gestartet'
  if (/angenommen|created|queued|wartet|auftrag/.test(raw)) return 'Auftrag angenommen'
  return 'Schritt aktualisiert'
}

function humanHistorySummary(summary: string): string {
  return String(summary || '')
    .replace(/\b(Arbeitslauf-Worker|Werkbank-Worker|Chatlauf|Worker)\b/gi, 'Arbeitsschritt')
    .replace(/Im Ursprungschat prüfen;?\s*bei Bedarf erneut schärfen\.?/gi, '')
    .trim()
}

function cleanNextAction(text?: string): string {
  const value = String(text || '').trim()
  if (!value) return ''
  if (/Im Ursprungschat prüfen;?\s*bei Bedarf erneut schärfen\.?/i.test(value)) return ''
  return value
}

function briefParagraphs(text?: string): string[] {
  const value = String(text || '').replace(/\r/g, '').trim()
  if (!value) return []
  return value
    .split(/\n\s*\n|\n(?=(?:Ziel|Kontext|Regeln|Plan|Kontrolle|Abnahme|Nachträge|Verdichteter Auftrag|Originalauftrag)\s*:)/i)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function taskStatusIcon(task: WerkbankTask) {
  const tone = task.status === 'done'
    ? 'is-done'
    : ['needs_input', 'needs_work', 'blocked', 'rate_limited'].includes(task.status)
      ? 'is-warn'
      : task.status === 'running'
        ? 'is-live'
        : ''
  return <span className={`werkbank-row-dot ${tone}`} aria-label={statusLabel(task.status)} />
}

function statusLabel(status: string): string {
  if (status === 'done') return 'fertig'
  if (status === 'canceled') return 'gestoppt'
  if (status === 'deleted') return 'gelöscht'
  if (status === 'needs_input') return 'offen'
  if (status === 'needs_work') return 'nacharbeiten'
  if (status === 'queued') return 'wartet'
  if (status === 'blocked') return 'braucht Blick'
  if (status === 'rate_limited') return 'gebremst'
  if (status === 'idle') return 'bereit'
  if (status === 'running') return 'läuft'
  return status || 'neu'
}

function statusTone(status: string): string {
  if (status === 'done' || status === 'ok') return 'text-[var(--green)]'
  if (status === 'canceled' || status === 'deleted') return 'text-[var(--t3)]'
  if (status === 'needs_input' || status === 'needs_work' || status === 'blocked' || status === 'rate_limited') return 'text-[var(--warm)]'
  if (status === 'running') return 'text-[var(--accent)]'
  return 'text-[var(--t3)]'
}

function activeWorker(task: WerkbankTask): { id?: string; role?: string; status?: string; summary?: string } | null {
  const workers = task.workers || []
  return workers.find(worker => worker.status === 'running')
    || workers.find(worker => worker.status === 'queued')
    || workers.find(worker => worker.status === 'done')
    || null
}

function taskRowPhase(task: WerkbankTask): string {
  if (task.status === 'done') return 'zurück'
  if (task.status === 'queued') return 'wartet'
  if (task.status === 'running') {
    const worker = activeWorker(task)
    if ((worker?.role || '').toLowerCase().includes('verifier')) return 'prüft'
    return taskToolNumber(task) > 0 ? 'arbeitet mit Tools' : 'arbeitet'
  }
  if (['blocked', 'needs_work', 'needs_input', 'rate_limited'].includes(task.status)) return 'braucht Blick'
  return statusLabel(task.status)
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { cache: 'no-store', ...init })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || res.statusText)
  return data
}

function Preview({ run }: { run: LoopRun | null }) {
  if (!run) {
    return (
      <section className="flex min-h-[360px] items-center justify-center border border-dashed border-[var(--border)] bg-[var(--bg-1)] p-6 text-center text-sm text-[var(--t3)]">
        Kein Lauf ausgewählt.
      </section>
    )
  }
  const missing = run.verifier?.missing || []
  return (
    <section className="min-h-0 border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <FileText className="h-4 w-4 text-[var(--t3)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--t1)]">{run.input.customer}</div>
          <div className="truncate text-[11px] text-[var(--t3)]">{run.artifacts?.html_path || run.artifacts?.markdown_path || run.id}</div>
        </div>
        <span className={`text-xs ${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
      </div>
      {missing.length > 0 && (
        <div className="border-b border-[var(--border)] bg-[var(--bg)] px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--warm)]">
            <AlertTriangle className="h-4 w-4" />
            Offene Punkte
          </div>
          <div className="space-y-1 text-xs leading-5 text-[var(--t2)]">
            {missing.map((item, i) => <div key={i}>- {item}</div>)}
          </div>
        </div>
      )}
      {run.preview_html ? (
        <iframe
          title={`HTML-Entwurf ${run.id}`}
          srcDoc={run.preview_html}
          className="h-[62vh] w-full bg-[var(--bg)]"
          sandbox=""
        />
      ) : (
        <pre className="max-h-[58vh] overflow-auto whitespace-pre-wrap px-4 py-4 text-[13px] leading-6 text-[var(--t2)]">{run.preview_markdown || 'Noch keine Vorschau.'}</pre>
      )}
    </section>
  )
}

function WerkbankCockpit() {
  const [tasks, setTasks] = useState<WerkbankTask[]>([])
  const [, setRate] = useState<WerkbankRate | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [filter, setFilter] = useState<'active' | 'done' | 'all'>('active')
  const [actionBusy, setActionBusy] = useState('')
  const [error, setError] = useState('')
  const [, setNowTick] = useState(0)
  const [feed, setFeed] = useState<TaskFeed | null>(null)
  const [feedLoading, setFeedLoading] = useState(false)
  const [openTool, setOpenTool] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const displayedTasks = tasks.filter(task => {
    if (filter === 'active') return ['queued', 'running', 'needs_input', 'needs_work', 'blocked', 'rate_limited'].includes(task.status)
    if (filter === 'done') return task.status === 'done'
    return true
  })
  const selected = tasks.find(t => t.id === selectedId) || null

  const load = useCallback(async () => {
    const data = await fetchJson('/api/loops/werkbank?limit=80')
    const next = Array.isArray(data.tasks) ? data.tasks : []
    setTasks(next)
    setRate(data.rate || null)
    setSelectedId(prev => next.some((task: WerkbankTask) => task.id === prev) ? prev : '')
  }, [])

  useEffect(() => {
    load().catch(() => {})
    const interval = window.setInterval(() => load().catch(() => {}), 4000)
    window.addEventListener('deck:sync', load as EventListener)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('deck:sync', load as EventListener)
    }
  }, [load])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || readDraft()
      const taskId = String(detail.werkbank_task_id || detail.task_id || '')
      if (!taskId) return
      setFilter('all')
      setSelectedId(taskId)
      load().catch(() => {})
    }
    window.addEventListener('deck:loopsDraft', handler)
    window.addEventListener('deck:startWerkbank', handler)
    window.addEventListener('deck:startBauhof', handler)
    return () => {
      window.removeEventListener('deck:loopsDraft', handler)
      window.removeEventListener('deck:startWerkbank', handler)
      window.removeEventListener('deck:startBauhof', handler)
    }
  }, [load])

  useEffect(() => {
    if (!tasks.some(task => ['queued', 'running'].includes(task.status))) return
    const interval = window.setInterval(() => setNowTick(t => t + 1), 1000)
    return () => window.clearInterval(interval)
  }, [tasks])

  const selectedStatus = selected?.status || ''
  useEffect(() => { setOpenTool(null) }, [selectedId])
  useEffect(() => {
    if (!selectedId) { setFeed(null); return }
    let alive = true
    const loadFeed = async () => {
      try {
        const data = await fetchJson(`/api/loops/werkbank/tasks/${selectedId}`)
        if (alive && data?.feed) setFeed(data.feed as TaskFeed)
      } catch { /* Feed beim naechsten Tick erneut versuchen */ }
    }
    setFeedLoading(true)
    loadFeed().finally(() => { if (alive) setFeedLoading(false) })
    if (!['queued', 'running'].includes(selectedStatus)) return () => { alive = false }
    const interval = window.setInterval(loadFeed, 1500)
    return () => { alive = false; window.clearInterval(interval) }
  }, [selectedId, selectedStatus])

  const stopTask = useCallback(async (task: WerkbankTask) => {
    setActionBusy(`stop:${task.id}`)
    setError('')
    try {
      const data = await fetchJson(`/api/loops/werkbank/tasks/${task.id}/stop`, { method: 'POST' })
      if (!data.ok) throw new Error(data.error || 'Stopp fehlgeschlagen')
      setTasks(prev => [data.task, ...prev.filter(t => t.id !== data.task.id)])
      setRate(data.rate || null)
      setSelectedId(data.task.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActionBusy('')
    }
  }, [])

  const deleteTask = useCallback(async (task: WerkbankTask) => {
    if (!window.confirm(`"${taskDisplayTitle(task)}" aus der Werkbank-Liste entfernen? Das Protokoll bleibt erhalten.`)) return
    setActionBusy(`delete:${task.id}`)
    setError('')
    try {
      const data = await fetchJson(`/api/loops/werkbank/tasks/${task.id}`, { method: 'DELETE' })
      if (!data.ok) throw new Error(data.error || 'Löschen fehlgeschlagen')
      setTasks(prev => prev.filter(t => t.id !== task.id))
      setRate(data.rate || null)
      setSelectedId(prev => prev === task.id ? '' : prev)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActionBusy('')
    }
  }, [])

  const openProtocol = useCallback((path?: string) => {
    if (!path) return
    window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path } }))
  }, [])

  return (
    <div className="werkbank-shell">
      <section className="werkbank-queue">
        <div className="werkbank-section-head">
          <div className="werkbank-filter">
            <button
              type="button"
              className="werkbank-reload"
              onClick={() => { setRefreshing(true); load().catch(() => {}).finally(() => window.setTimeout(() => setRefreshing(false), 700)) }}
              title="Aktualisieren"
              aria-label="Werkbank aktualisieren"
            >
              <RefreshCw className={`h-4 w-4${refreshing ? ' animate-spin' : ''}`} />
            </button>
            {(['active', 'done', 'all'] as const).map(item => (
              <button key={item} type="button" onClick={() => setFilter(item)} className={filter === item ? 'is-active' : ''}>
                {item === 'active' ? 'Jetzt' : item === 'done' ? 'Fertig' : 'Alle'}
              </button>
            ))}
          </div>
        </div>
        <div className="werkbank-list">
          <div className="werkbank-task-head" aria-hidden="true">
            <span />
            <span className="werkbank-task-headtitle">Auftrag</span>
            <span className="werkbank-task-headtitle">Tools</span>
            <span className="werkbank-task-headtitle">Tokens</span>
            <span className="werkbank-task-headtitle">Zeilen</span>
            <span className="werkbank-task-headtitle">Aktiv</span>
          </div>
          {displayedTasks.map(task => {
            const expanded = selected?.id === task.id
            const diff = taskDiffValues(task)
            const toolValue = taskToolValue(task)
            const tokenValue = taskTokenValue(task)
            const runLabel = filter === 'done' ? '' : taskRunLabel(task)
            const originParts = taskOriginParts(task)
            const canStop = ['queued', 'running', 'needs_work', 'needs_input', 'blocked', 'rate_limited', 'idle'].includes(task.status)
            const rowLive = !!taskLive(task)
            const rowPhase = filter === 'done' ? '' : taskRowPhase(task)
            return (
              <article key={task.id} className={expanded ? 'is-active' : ''}>
                <button type="button" onClick={() => setSelectedId(expanded ? '' : task.id)} className="werkbank-task-row">
                  {taskStatusIcon(task)}
                  <span className="werkbank-task-title">
                    <span className="werkbank-task-title-main">
                      <span className="werkbank-task-title-text">{taskDisplayTitle(task)}</span>
                      {runLabel && (
                        <span className="werkbank-task-badges">
                          <span>{runLabel}</span>
                        </span>
                      )}
                    </span>
                    {rowPhase && (
                      <span className="werkbank-row-flow" aria-label={rowPhase}>
                        <em>{rowPhase}</em>
                      </span>
                    )}
                  </span>
                  <span className={`werkbank-col werkbank-col-live ${rowLive ? 'is-live' : ''}`}>
                    <b>{toolValue || '·'}</b>
                  </span>
                  <span className={`werkbank-col werkbank-col-live ${rowLive ? 'is-live' : ''} ${task.metrics?.token_budget_exceeded ? 'is-warn' : ''}`}>
                    <b>{tokenValue || '·'}</b>
                  </span>
                  <span className={`werkbank-col werkbank-col-live werkbank-col-diff ${diff.live ? 'is-live' : ''}`}>
                    {(diff.added || diff.removed || diff.live)
                      ? <b><span className="diff-add">+{diff.added}</span><span>/</span><span className="diff-del">−{diff.removed}</span></b>
                      : <b>·</b>}
                  </span>
                  <span className="werkbank-task-state">
                    <b>{taskTimeLabel(task)}</b>
                  </span>
                </button>
                {expanded && (
                  <div className="werkbank-task-detail">
                    {(() => {
                      const live = feed?.live
                      const queueStatus = feed?.queue?.status || ''
                      const queueProcessing = queueStatus === 'processing'
                      const running = task.status === 'running' || !!live?.running || queueProcessing
                      const waiting = task.status === 'queued' && !running
                      const liveMetrics = running ? live : null
                      const dur = taskTimeLabel(task, liveMetrics)
                      const toks = liveMetrics ? (liveMetrics.input_tokens + liveMetrics.output_tokens) : (Number(task.metrics?.input_tokens || 0) + Number(task.metrics?.output_tokens || 0))
                      const toolN = liveMetrics?.tool_count || Number(task.metrics?.tool_count || 0)
                      const add = liveMetrics?.added ?? Number(task.metrics?.changed_lines?.added || 0)
                      const rem = liveMetrics?.removed ?? Number(task.metrics?.changed_lines?.removed || 0)
                      const agentLabel = !task.origin?.agent || task.origin.agent === 'main' ? 'Agent' : task.origin.agent
                      const nextAction = cleanNextAction(task.next_action)
                      const detailRunLabel = taskRunLabel(task)
                      const briefParts = briefParagraphs(task.request?.brief)
                      const noFeedReason = feedLoading
                        ? 'Aktivität wird geladen.'
                        : queueProcessing
                          ? 'Queue verarbeitet den Worker; noch kein Tool-Schritt im Feed.'
                          : feed?.available === false && task.request?.worker_conversation_id
                            ? 'Worker-Chat ist angelegt, aber noch ohne sichtbaren Output.'
                            : waiting
                              ? 'Queue wartet noch auf freien Start.'
                              : 'Für diesen Lauf gibt es keinen Tool-Feed.'
                      return (
                        <div className="werkbank-cockpit">
                          <div className="werkbank-cockpit-head">
                            <div className="werkbank-detail-title">{taskDisplayTitle(task)}</div>
                            <div className="werkbank-cockpit-chips">
                              {originParts.pane && <span className="werkbank-chip">{originParts.pane}</span>}
                              <span className="werkbank-chip">{originParts.session}</span>
                              <span className="werkbank-chip">{agentLabel}</span>
                            </div>
                            <div className={`werkbank-live ${running ? 'is-live' : ''}`}>
                              {dur}
                            </div>
                          </div>
                          <div className="werkbank-bilanz">
                            <div><span>Tokens</span><b>{toks ? fmtTokens(toks) : '·'}</b></div>
                            <div><span>Tools</span><b>{toolN ? `${toolN} T` : '·'}</b></div>
                            <div><span>Diff</span><b className="werkbank-detail-diff">{(add || rem || running) ? <><span className="diff-add">+{add}</span><span>/</span><span className="diff-del">−{rem}</span></> : '·'}</b></div>
                            {detailRunLabel && <div><span>Lauf</span><b>{detailRunLabel.replace(/\D/g, '')}</b></div>}
                          </div>
                          <details className="werkbank-detail-section">
                            <summary className="werkbank-detail-summary">
                              <span>Aktivität</span>
                              {running && <span className="werkbank-feed-live">läuft</span>}
                            </summary>
                            <div className="werkbank-feed">
                              {feed?.items?.length ? feed.items.map(item => {
                                const isOpen = openTool === item.index
                                return (
                                  <div key={item.index} className={`werkbank-feed-item ${isOpen ? 'is-open' : ''}`}>
                                    <button type="button" className="werkbank-feed-row" onClick={() => setOpenTool(isOpen ? null : item.index)}>
                                      <span className="werkbank-feed-name">{item.name}</span>
                                      <span className="werkbank-feed-label">{item.label || '—'}</span>
                                      {(item.added || item.removed)
                                        ? <span className="werkbank-feed-diff"><span className="diff-add">+{item.added}</span><span className="diff-del">−{item.removed}</span></span>
                                        : <span className="werkbank-feed-diff" />}
                                      <span className={`werkbank-feed-status ${item.status === 'error' ? 'is-err' : 'is-ok'}`}>{item.status === 'error' ? 'Fehler' : 'ok'}</span>
                                    </button>
                                    {isOpen && (
                                      <div className="werkbank-feed-detail">
                                        {Object.keys(item.args || {}).length > 0 && (
                                          <div className="werkbank-feed-args">
                                            {Object.entries(item.args).map(([k, v]) => (
                                              <div key={k}><span>{k}</span><code>{(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 400)}</code></div>
                                            ))}
                                          </div>
                                        )}
                                        {item.result_snippet && <pre className="werkbank-feed-result">{item.result_snippet}</pre>}
                                      </div>
                                    )}
                                  </div>
                                )
                              }) : (
                                <div className="werkbank-feed-empty">{noFeedReason}</div>
                              )}
                            </div>
                          </details>
                          {!!(task.history || []).length && (
                            <details className="werkbank-detail-section werkbank-history-section">
                              <summary className="werkbank-detail-summary">
                                <span>Verlauf</span>
                                <em>{(task.history || []).length}</em>
                              </summary>
                              <div className="werkbank-history">
                                {(task.history || []).slice(-9).map((item, i) => {
                                  const summary = humanHistorySummary(item.summary)
                                  return (
                                    <div key={`${item.ts || i}-${item.label}`} className="werkbank-history-item">
                                      <div>
                                        <div className="werkbank-history-line">
                                          <b>{humanHistoryLabel(item.label, item.status)}</b>
                                          {item.ts && <span>{fmtAge(item.ts)}</span>}
                                        </div>
                                        {summary && <p>{summary}</p>}
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </details>
                          )}
                          {(briefParts.length > 0 || nextAction) && (
                            <details className="werkbank-detail-section werkbank-auftrag-section" open>
                              <summary className="werkbank-detail-summary">
                                <span>Auftrag</span>
                              </summary>
                              <div className="werkbank-detail-brief">
                                {briefParts.length > 0 && (
                                  <div>
                                    <span>Brief</span>
                                    <div className="werkbank-brief-text">
                                      {briefParts.map((part, i) => <p key={i}>{part}</p>)}
                                    </div>
                                  </div>
                                )}
                                {nextAction && <p className="werkbank-next-action">{nextAction}</p>}
                              </div>
                            </details>
                          )}
                        </div>
                      )
                    })()}

                    <div className="werkbank-task-actions">
                      <button type="button" onClick={() => openProtocol(task.artifacts?.html_path || task.artifacts?.markdown_path || task.artifacts?.protocol_path)} disabled={!task.artifacts?.html_path && !task.artifacts?.markdown_path && !task.artifacts?.protocol_path}>
                        <FileText className="h-3.5 w-3.5" />
                        Öffnen
                      </button>
                      {canStop && (
                        <button type="button" onClick={() => stopTask(task)} disabled={!!actionBusy}>
                          {actionBusy === `stop:${task.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                          Stoppen
                        </button>
                      )}
                      <button type="button" onClick={() => deleteTask(task)} disabled={!!actionBusy} className="is-danger">
                        {actionBusy === `delete:${task.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        Löschen
                      </button>
                    </div>
                  </div>
                )}
              </article>
            )
          })}
          {displayedTasks.length === 0 && <div className="px-4 py-8 text-center text-sm text-[var(--t3)]">Gerade nichts in dieser Ansicht.</div>}
        </div>
      </section>

      {error && <div className="text-xs text-[var(--red)]">{error}</div>}
    </div>
  )
}

export function LoopWorkspace({ initialView, lockedView = false }: { initialView?: 'werkbank' | 'offers'; lockedView?: boolean } = {}) {
  const draft = useMemo(readDraft, [])
  const [runs, setRuns] = useState<LoopRun[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [parentId, setParentId] = useState(draft.parent_conversation_id || '')
  const [customer, setCustomer] = useState('')
  const [goal, setGoal] = useState(draft.suggested_goal || 'Angebot aus dem Chatkontext vorbereiten.')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'werkbank' | 'offers'>(initialView || (draft.view === 'offers' ? 'offers' : 'werkbank'))

  const selected = runs.find(r => r.id === selectedId) || runs[0] || null

  const load = useCallback(async () => {
    const data = await fetchJson('/api/loops/runs?limit=40')
    const next = Array.isArray(data.runs) ? data.runs : []
    setRuns(next)
    setSelectedId(prev => prev || next[0]?.id || '')
  }, [])

  useEffect(() => {
    load().catch(() => {})
    fetchJson('/api/conversations?limit=0')
      .then(data => setConversations(Array.isArray(data.conversations) ? data.conversations.filter((c: Conversation) => !c.id.startsWith('channel-')) : []))
      .catch(() => {})
  }, [load])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || readDraft()
      if (!lockedView) {
        if (detail.view === 'offers') setView('offers')
        if (detail.view === 'werkbank' || detail.view === 'bauhof') setView('werkbank')
      }
      if (detail.parent_conversation_id) setParentId(detail.parent_conversation_id)
      if (detail.suggested_goal) setGoal(detail.suggested_goal)
    }
    window.addEventListener('deck:loopsDraft', handler)
    return () => window.removeEventListener('deck:loopsDraft', handler)
  }, [lockedView])

  const start = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const data = await fetchJson('/api/loops/offer/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_conversation_id: parentId,
          customer,
          goal,
          notes,
          trigger: 'manual',
        }),
      })
      if (!data.ok) throw new Error(data.error || 'Start fehlgeschlagen')
      setRuns(prev => [data.run, ...prev.filter(r => r.id !== data.run.id)])
      setSelectedId(data.run.id)
      setNotes('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [customer, goal, notes, parentId])

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] text-[var(--t1)]">
      {!lockedView && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-1)] px-4 py-3">
          <button
            type="button"
            onClick={() => setView('werkbank')}
            className={`rounded-md px-3 py-1.5 text-sm ${view === 'werkbank' ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
          >
            Werkbank
          </button>
          <button
            type="button"
            onClick={() => setView('offers')}
            className={`rounded-md px-3 py-1.5 text-sm ${view === 'offers' ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
          >
            Angebote
          </button>
        </div>
      )}
      {view === 'werkbank' ? <WerkbankCockpit /> : (
      <div className="grid min-h-full gap-4 p-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="border border-[var(--border)] bg-[var(--bg-1)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-[var(--t1)]">Angebote</div>
                <div className="text-xs text-[var(--t3)]">Aus Gesprächen ein Angebot vorbereiten.</div>
              </div>
              <button
                type="button"
                onClick={() => load().catch(() => {})}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border)] text-[var(--t3)] hover:text-[var(--t1)]"
                title="Aktualisieren"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--t3)]">Ursprungschat</span>
                <select value={parentId} onChange={e => setParentId(e.target.value)} className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--t1)] outline-none">
                  <option value="">Ohne Chatbindung</option>
                  {conversations.map(c => <option key={c.id} value={c.id}>{c.title || c.id}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--t3)]">Kunde / Empfänger</span>
                <input value={customer} onChange={e => setCustomer(e.target.value)} className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--t1)] outline-none" placeholder="z. B. Musterfirma GmbH" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--t3)]">Ziel</span>
                <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={4} className="w-full resize-none border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm leading-5 text-[var(--t1)] outline-none" />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-[var(--t3)]">Notizen</span>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="w-full resize-none border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm leading-5 text-[var(--t1)] outline-none" placeholder="Gesprächsnotiz, Budget, Termin, Leistungsgrenzen..." />
              </label>
              {error && <div className="text-xs text-[var(--red)]">{error}</div>}
              <button
                type="button"
                onClick={start}
                disabled={busy || !customer.trim() || !goal.trim()}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-[var(--accent-fg)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Manuell starten
              </button>
            </div>
          </section>

          <section className="border border-[var(--border)] bg-[var(--bg-1)]">
            <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-medium text-[var(--t1)]">Läufe</div>
            <div className="max-h-[42vh] overflow-auto">
              {runs.map(run => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedId(run.id)}
                  className={`flex w-full items-start gap-2 border-b border-[var(--border)] px-4 py-3 text-left last:border-b-0 hover:bg-white/[0.03] ${selected?.id === run.id ? 'bg-white/[0.04]' : ''}`}
                >
                  {run.status === 'done' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--green)]" /> : <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warm)]" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--t1)]">{run.input.customer}</span>
                    <span className="block truncate text-[11px] text-[var(--t3)]">{statusLabel(run.status)} · {fmtAge(run.updated_at)}</span>
                  </span>
                </button>
              ))}
              {runs.length === 0 && <div className="px-4 py-8 text-center text-sm text-[var(--t3)]">Noch keine Läufe.</div>}
            </div>
          </section>
        </div>

        <div className="min-w-0 space-y-4">
          {selected && (
            <section className="grid gap-2 md:grid-cols-4">
              {selected.steps.map(step => (
                <div key={step.key} className="border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
                  <div className={`truncate text-xs font-medium ${statusTone(step.status)}`}>{step.label}</div>
                  <div className="mt-1 truncate text-[11px] text-[var(--t3)]">{step.summary}</div>
                </div>
              ))}
            </section>
          )}
          <Preview run={selected} />
        </div>
      </div>
      )}
    </div>
  )
}
