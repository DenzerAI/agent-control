// Pulses-Section — kollabierbarer Ordner im InfoPane-Stil.
// Vier Sub-Sections mit Backend-Code-Namen: pulses, workers, hooks, tasks.
// Heartbeat ist nur ein Tag auf zwei Pulses (server-ping, health-watchdog).
// `tasksSlot` wird von InfoPane geliefert — enthält die existierende
// Jobs-Tree-Rendering-Logik (Briefings/Radar/Social/Sync/Other/System).
import { useState, type ReactNode } from 'react'
import { ChevronRight, Activity, RefreshCw } from 'lucide-react'
import { useAutomation, refreshPulses, type Pulse, type AutomationRow, type PulseColor } from '../pulses'
import { playUISound } from '../uiSounds'
import { Guided } from './info-pane/utils/tree'

function fmtAge(sec: number | null | undefined): string {
  if (sec == null) return 'nie'
  if (sec < 60) return `vor ${sec}s`
  if (sec < 3600) return `vor ${Math.floor(sec / 60)}min`
  if (sec < 86400) return `vor ${Math.floor(sec / 3600)}h`
  return `vor ${Math.floor(sec / 86400)}d`
}

function fmtInterval(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}min`
  return `${Math.floor(sec / 3600)}h`
}

// Zwei Zustände: grün (alles ok) oder rot (Fehler). Kein Grau, kein Orange, kein Weiss.
function dotColor(c: PulseColor): string {
  return c === 'red' || c === 'orange' ? 'bg-[var(--cc-orange)]' : 'bg-emerald-500'
}

function rowSummaryColor(rows: { color: PulseColor }[]): PulseColor {
  return rows.some(r => r.color === 'red' || r.color === 'orange') ? 'red' : 'green'
}

const detailPanelClass = 'info-detail-list info-automation-detail info-text-meta'

const technicalRefLabels: Record<string, string> = {
  'radar-intraday': 'Radar Intraday',
  'mail-scanner': 'Mail Scanner',
  'lead-reconciler': 'Lead Abgleich',
  'lead-digest': 'Lead Digest',
  'denzer-leads-pull': 'Denzer Leads',
  'server-ping': 'Server Ping',
  'health-watchdog': 'Health Watchdog',
  'backup-freshness': 'Backup Frische',
  'crm-reindexer': 'Kontakte verknüpfen',
  'whatsapp-people-sync': 'WhatsApp-Kontakte',
  'people-enrich': 'Kontaktdaten ergänzen',
  'whatsapp-customer-inbound': 'Kunden-WhatsApp',
  'local-llm': 'Lokales Modell',
  'health-sleep-watcher': 'Schlaf Watcher',
}

function displayRefLabel(ref: string): string {
  const clean = ref.trim()
  if (!clean) return ''
  if (technicalRefLabels[clean]) return technicalRefLabels[clean]
  return clean
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function DetailLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-detail-row">
      <span className="info-detail-label">{label}</span>
      <span className="info-detail-value">{children}</span>
    </div>
  )
}

// Detail-Panel — gemeinsam für Pulses, Workers, Hooks, Tasks.
function RowDetail({ row, kind }: {
  row: AutomationRow & Partial<Pulse>;
  kind: 'pulse' | 'worker' | 'hook' | 'task';
}) {
  return (
    <div className={detailPanelClass}>
      {row.what && <DetailLine label="Was">{row.what}</DetailLine>}
      {row.how && <DetailLine label="Wie">{row.how}</DetailLine>}
      {row.who && <DetailLine label="Wer">{row.who}</DetailLine>}
      {(row as Pulse).llm && <DetailLine label="LLM">{(row as Pulse).llm}</DetailLine>}
      {kind === 'pulse' && (row as Pulse).interval_sec != null && (
        <DetailLine label="Takt">alle {fmtInterval((row as Pulse).interval_sec)}</DetailLine>
      )}
      <DetailLine label="Status">{row.last_status}</DetailLine>
      <DetailLine label="Lauf">{fmtAge(row.age_sec)}</DetailLine>
      <DetailLine label="Fehler">{row.fail_streak}</DetailLine>
      <DetailLine label="Code">{row.internal_name || row.name}</DetailLine>
      {row.last_message && <DetailLine label="Zuletzt">{row.last_message}</DetailLine>}
      {row.last_file && <DetailLine label="Datei">{row.last_file}</DetailLine>}
    </div>
  )
}

function Row({ row, mobile, kind, tag }: {
  row: AutomationRow & Partial<Pulse>;
  mobile?: boolean;
  kind: 'pulse' | 'worker' | 'hook' | 'task';
  tag?: string;
}) {
  const [open, setOpen] = useState(false)
  const label = row.label || displayRefLabel(row.name)
  return (
    <div>
      <button
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`w-full flex items-center gap-2 pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${dotColor(row.color)}`} />
        <span className="text-[var(--t2)] font-medium flex-1 truncate">{label}</span>
        {tag && (
          <span className="info-text-meta uppercase tracking-wide text-[var(--t3)]/70 border border-[var(--border)]/40 rounded px-1 py-0 flex-shrink-0">
            {tag}
          </span>
        )}
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">{fmtAge(row.age_sec)}</span>
      </button>
      {open && (
        <Guided>
          <RowDetail row={row} kind={kind} />
        </Guided>
      )}
    </div>
  )
}

function SubSection({ title, rows, kind, mobile, getTag, customContent, customCount, customColor }: {
  title: string;
  rows?: (AutomationRow & Partial<Pulse>)[];
  kind?: 'pulse' | 'worker' | 'hook' | 'task';
  mobile?: boolean;
  getTag?: (row: AutomationRow) => string | undefined;
  customContent?: ReactNode;
  customCount?: number;
  customColor?: PulseColor;
}) {
  const [open, setOpen] = useState(false)
  const color = customColor ?? rowSummaryColor(rows ?? [])
  const count = customCount ?? rows?.length ?? 0
  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v) } }}
        className={`flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-1.5'} info-text-body cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className={`inline-block w-2 h-2 rounded-full mr-2 flex-shrink-0 ${dotColor(color)}`} />
        <span className="text-[var(--t2)] font-medium">{title}</span>
        <span className="flex-1" />
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0">{count}</span>
      </div>
      {open && (
        <Guided>
          {customContent !== undefined ? (
            customContent
          ) : (rows && rows.length > 0) ? (
            rows.map(r => <Row key={r.name} row={r} mobile={mobile} kind={kind ?? 'pulse'} tag={getTag?.(r)} />)
          ) : (
            <div className="px-3 py-2 info-text-meta text-[var(--t3)]/60">Noch leer.</div>
          )}
        </Guided>
      )}
    </div>
  )
}

export function HeartbeatSection({ mobile, tasksSlot, tasksCount, tasksColor }: {
  mobile?: boolean;
  tasksSlot?: ReactNode;
  tasksCount?: number;
  tasksColor?: PulseColor;
}) {
  const snap = useAutomation()
  const [open, setOpen] = useState(false)

  // Backend-Tasks ignorieren — wir nutzen den existierenden Jobs-Tree von InfoPane.
  const allRows = [...snap.pulses, ...snap.workers, ...snap.hooks]
  const tasksRed = tasksColor === 'red' || tasksColor === 'orange'
  const headerColor: PulseColor = (rowSummaryColor(allRows) === 'red' || tasksRed) ? 'red' : 'green'

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Activity className={`info-icon-md mr-2 flex-shrink-0 ${
          headerColor === 'red' ? 'text-[var(--cc-orange)]'
          : 'text-[var(--t3)]'
        }`} />
        <span className="text-[var(--t2)] font-medium">Automation</span>
        <span className="flex-1" />
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); fetch('/api/pulses/run', { method: 'POST' }).finally(refreshPulses) }}
            className="ml-2 p-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Sofort einen Pulse-Tick auslösen"
          >
            <RefreshCw className="info-icon-sm" />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            <SubSection title="Pulses" rows={snap.pulses} kind="pulse" mobile={mobile} />
            <SubSection title="Workers" rows={snap.workers} kind="worker" mobile={mobile} />
            {tasksSlot !== undefined && (
              <SubSection
                title="Tasks"
                mobile={mobile}
                customContent={tasksSlot}
                customCount={tasksCount}
                customColor={tasksColor}
              />
            )}
            <SubSection title="Hooks" rows={snap.hooks} kind="hook" mobile={mobile} />
          </Guided>
        </div>
      )}
    </div>
  )
}
