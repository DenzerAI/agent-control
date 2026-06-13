import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { Activity, ClipboardList, Columns3, GitBranch, Inbox, RefreshCw, Radio, ShieldCheck, Wrench } from 'lucide-react'
import { refreshPulses, useAutomation, type AutomationRow, type Pulse, type WorkflowRun } from '../pulses'
import type { WorkspaceMode } from './types'

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function tone(row: AutomationRow): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (row.color === 'red' || row.last_status === 'error' || row.last_status === 'timeout') return 'bad'
  if (row.color === 'orange' || row.fail_streak > 0) return 'warn'
  if (row.color === 'green') return 'ok'
  return 'neutral'
}

function workflowTone(run: WorkflowRun): 'ok' | 'warn' | 'bad' | 'neutral' {
  const learning = String(run.review?.learning?.class || '')
  if (learning === 'blocker' || run.status === 'error' || run.review_status === 'error') return 'bad'
  if (learning === 'detour' || run.review_status === 'warning') return 'warn'
  return run.status === 'done' ? 'ok' : 'neutral'
}

function rowSubject(run: WorkflowRun): string {
  const ref = String(run.subject_ref || '')
  if (ref) return ref
  const input = run.input || {}
  return String(input.prompt || input.query || input.text || run.review_message || run.id).replace(/\s+/g, ' ').slice(0, 100)
}

function Metric({ label, value, detail, warn }: { label: string; value: string | number; detail: string; warn?: boolean }) {
  return (
    <section className={warn ? 'is-warning' : ''}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </section>
  )
}

function Panel({ icon: Icon, title, meta, children }: { icon: typeof Activity; title: string; meta: string; children: ReactNode }) {
  return (
    <section className="workspace-system-panel">
      <div className="workspace-system-panel-head">
        <div>
          <Icon className="h-4 w-4" />
          <strong>{title}</strong>
        </div>
        <span>{meta}</span>
      </div>
      <div className="workspace-system-list">{children}</div>
    </section>
  )
}

function AutomationItem({ row, tag }: { row: AutomationRow & Partial<Pulse>; tag?: string }) {
  return (
    <article className={`workspace-system-row is-${tone(row)}`}>
      <span />
      <div>
        <strong>{row.label || row.name}</strong>
        <em>{row.last_message || row.what || row.how || row.internal_name || 'Kein letzter Lauf.'}</em>
      </div>
      <aside>
        <b>{tag || row.last_status || 'unknown'}</b>
        <i>{fmtAge(row.last_run)}</i>
      </aside>
    </article>
  )
}

function WorkflowItem({ run }: { run: WorkflowRun }) {
  return (
    <article className={`workspace-system-row is-${workflowTone(run)}`}>
      <span />
      <div>
        <strong>{run.title || run.workflow_key}</strong>
        <em>{rowSubject(run)}</em>
      </div>
      <aside>
        <b>{run.review_status || run.status}</b>
        <i>{fmtAge(run.created_at)}</i>
      </aside>
    </article>
  )
}

function AgentShortcut({ icon: Icon, title, detail, mode, onOpenMode }: { icon: typeof Activity; title: string; detail: string; mode: WorkspaceMode; onOpenMode?: (mode: WorkspaceMode) => void }) {
  return (
    <button type="button" className="workspace-system-row workspace-system-row-button is-neutral" onClick={() => onOpenMode?.(mode)}>
      <span />
      <div>
        <strong>{title}</strong>
        <em>{detail}</em>
      </div>
      <aside>
        <Icon className="h-4 w-4" />
      </aside>
    </button>
  )
}

export function AutomationWorkspace({ onOpenMode }: { onOpenMode?: (mode: WorkspaceMode) => void }) {
  const snap = useAutomation()
  const rows = useMemo(() => [...snap.pulses, ...snap.workers, ...snap.hooks, ...snap.tasks], [snap])
  const issues = rows.filter(row => tone(row) === 'bad' || tone(row) === 'warn').length
  const lastWorkflow = snap.workflows[0]
  const headline = issues > 0 ? `${issues} Automation-Hinweis${issues === 1 ? '' : 'e'}` : 'Automation ruhig'

  return (
    <div className="workspace-system">
      <header className="workspace-system-hero">
        <div>
          <p>Automation · Pulses · Workers · Hooks · Tasks</p>
          <h2>{headline}</h2>
          <span>{lastWorkflow ? `Letzter Lauf: ${lastWorkflow.title || lastWorkflow.workflow_key}` : 'Alle Betriebslisten kommen aus /api/automation.'}</span>
        </div>
        <button type="button" onClick={refreshPulses} title="Neu laden">
          <RefreshCw className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => fetch('/api/pulses/run', { method: 'POST' }).finally(refreshPulses)} title="Pulses jetzt prüfen">
          <Radio className="h-4 w-4" />
        </button>
      </header>

      <div className="workspace-system-strip">
        <Metric label="Pulses" value={snap.pulses.length} detail="periodische Checks" warn={snap.pulses.some(row => tone(row) !== 'ok')} />
        <Metric label="Workers" value={snap.workers.length} detail="Dauerläufer" warn={snap.workers.some(row => tone(row) !== 'ok')} />
        <Metric label="Hooks" value={snap.hooks.length} detail="Ereignisse" warn={snap.hooks.some(row => tone(row) === 'bad')} />
        <Metric label="Tasks" value={snap.tasks.length} detail="Job-Outputs" warn={snap.tasks.some(row => tone(row) === 'bad')} />
      </div>

      <div className="workspace-system-main">
        <Panel icon={Activity} title="Agenten-Details" meta="bei Bedarf">
          <AgentShortcut icon={Inbox} title="Mail-Agent" detail="Posteingang, Entwürfe, Intake-Läufe" mode="mailagent" onOpenMode={onOpenMode} />
          <AgentShortcut icon={ShieldCheck} title="Chatagent" detail="Chat-Qualität und Antwortprüfung" mode="chatagent" onOpenMode={onOpenMode} />
          <AgentShortcut icon={Wrench} title="Systemagent" detail="Betrieb, Jobs, Bibliothekar" mode="systemagent" onOpenMode={onOpenMode} />
          <AgentShortcut icon={Columns3} title="Agent-Läufe" detail="alte Sammelansicht, früher Agent Board" mode="kanban" onOpenMode={onOpenMode} />
        </Panel>

        <Panel icon={Radio} title="Pulses" meta={`${snap.pulses.length} aktiv`}>
          {snap.pulses.map(row => <AutomationItem key={`pulse:${row.name}`} row={row} tag={row.interval_sec ? `${Math.round(row.interval_sec / 60)}min` : row.last_status} />)}
          {snap.pulses.length === 0 && <p>Keine Pulses im Snapshot.</p>}
        </Panel>

        <Panel icon={Wrench} title="Workers" meta={`${snap.workers.length} registriert`}>
          {snap.workers.map(row => <AutomationItem key={`worker:${row.name}`} row={row} />)}
          {snap.workers.length === 0 && <p>Keine Workers im Snapshot.</p>}
        </Panel>

        <Panel icon={GitBranch} title="Hooks" meta={`${snap.hooks.length} registriert`}>
          {snap.hooks.map(row => <AutomationItem key={`hook:${row.name}`} row={row} />)}
          {snap.hooks.length === 0 && <p>Keine Hooks im Snapshot.</p>}
        </Panel>

        <Panel icon={ClipboardList} title="Tasks" meta={`${snap.tasks.length} Jobs`}>
          {snap.tasks.slice(0, 24).map(row => <AutomationItem key={`task:${row.name}`} row={row} tag={row.last_file ? 'Output' : row.last_status} />)}
          {snap.tasks.length === 0 && <p>Keine Tasks im Snapshot.</p>}
        </Panel>

        <Panel icon={Activity} title="Letzte Läufe" meta={`${snap.workflows.length} Läufe`}>
          {snap.workflows.map(run => <WorkflowItem key={run.id} run={run} />)}
          {snap.workflows.length === 0 && <p>Keine Läufe im Snapshot.</p>}
        </Panel>
      </div>
    </div>
  )
}
