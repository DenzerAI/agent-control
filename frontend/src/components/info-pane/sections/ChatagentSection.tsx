import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, RefreshCw, ShieldCheck } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type ChatagentCheck = {
  id: string
  label: string
  status: 'ok' | 'warn' | 'critical'
  detail: string
  value?: string
  impact?: string
  action?: string
  attention?: boolean
}

type ChatagentReport = {
  generatedAt?: string
  score: number
  status: 'ok' | 'warn' | 'critical'
  actionRequired?: boolean
  attention?: { level: 'none' | 'agent' | 'owner'; label: string; detail: string }
  summary: { critical: number; warnings: number; maintenance?: number; ok: number; verdict: string }
  runtime: {
    connectedClients: number
    activeProcesses: number
    activeTasks: number
    streamSessions: number
    streamSubscribers: number
  }
  responsiveness?: {
    status: 'ok' | 'warn' | 'critical'
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

const EMPTY_REPORT: ChatagentReport = {
  score: 0,
  status: 'warn',
  actionRequired: false,
  attention: { level: 'none', label: 'Keine Aktion nötig', detail: 'Noch kein Check geladen.' },
  summary: { critical: 0, warnings: 0, ok: 0, verdict: 'Noch kein Check geladen.' },
  runtime: { connectedClients: 0, activeProcesses: 0, activeTasks: 0, streamSessions: 0, streamSubscribers: 0 },
  checks: [],
  nextActions: [],
}

function tone(status: ChatagentCheck['status'] | ChatagentReport['status']): string {
  if (status === 'critical') return 'text-[#ef4444]'
  if (status === 'warn') return 'text-[var(--cc-orange)]'
  return 'text-[var(--green)]'
}

function dot(status: ChatagentCheck['status'] | ChatagentReport['status']): string {
  if (status === 'critical') return 'bg-[#ef4444]'
  if (status === 'warn') return 'bg-[var(--cc-orange)]'
  return 'bg-[var(--green)]'
}

function fmtTime(value?: string): string {
  if (!value) return 'nie'
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return 'gerade'
  const age = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
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

function CheckRow({ check, mobile }: { check: ChatagentCheck; mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className={`h-2 w-2 rounded-full mr-2 flex-shrink-0 ${dot(check.status)}`} />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{check.label}</span>
        {check.value && <span className={`info-text-meta flex-shrink-0 tabular-nums ${tone(check.status)}`}>{check.value}</span>}
      </button>
      {open && (
        <Guided>
          <div className="info-detail-list info-text-meta">
            <DetailLine label="Stand" value={check.status === 'ok' ? 'sauber' : check.attention ? 'handeln' : 'Wartung'} />
            <DetailLine label="Detail" value={check.detail} />
            <DetailLine label="Bedeutung" value={check.impact || ''} />
            <DetailLine label="Aktion" value={check.action || ''} />
            <DetailLine label="Check" value={check.id} />
          </div>
        </Guided>
      )}
    </div>
  )
}

export function ChatagentSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <ChatagentWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <ChatagentInlineSection mobile={mobile} />
}

function ChatagentWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Chatagent im Workspace öffnen"
      >
        <ShieldCheck className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Chatagent</span>
      </button>
    </div>
  )
}

function ChatagentInlineSection({ mobile }: { mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<ChatagentReport>(EMPTY_REPORT)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (run = false) => {
    setLoading(true)
    try {
      const res = await fetch(run ? '/api/chatagent/run' : '/api/chatagent/status', {
        method: run ? 'POST' : 'GET',
        cache: 'no-store',
      })
      const data = await res.json().catch(() => EMPTY_REPORT)
      setReport({ ...EMPTY_REPORT, ...data })
    } catch {
      setReport(EMPTY_REPORT)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(false) }, [load])

  const topChecks = useMemo(() => {
    return [...report.checks].sort((a, b) => {
      const weight = { critical: 0, warn: 1, ok: 2 }
      return weight[a.status] - weight[b.status]
    })
  }, [report.checks])

  const needsAttention = !!report.actionRequired
  const headerTone = needsAttention ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'

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
        <ShieldCheck className={`info-icon-md mr-2 flex-shrink-0 ${headerTone} group-hover:text-[var(--t2)]`} />
        <span className="text-[var(--t2)] font-medium">Chatagent</span>
        <span className="flex-1" />
        {open && <span className={`info-text-meta tabular-nums ${headerTone}`}>{report.score}/100</span>}
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load(true) }}
            className="ml-2 p-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Chat prüfen"
          >
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            <div className="info-detail-list info-text-meta">
              <DetailLine label="Für dich" value={report.attention?.label || (needsAttention ? 'Handlung nötig' : 'Keine Aktion nötig')} />
              <DetailLine label="Urteil" value={report.summary.verdict} />
              <DetailLine label="Warum" value={report.attention?.detail || ''} />
              <DetailLine
                label="Gefühlte Trägheit"
                value={report.responsiveness ? `${report.responsiveness.label} · ${report.responsiveness.value}` : 'nicht gemessen'}
              />
              <DetailLine label="Checks" value={`${report.summary.ok} sauber · ${report.summary.warnings} Hinweise · ${report.summary.critical} kritisch`} />
              <DetailLine label="Runtime" value={`${report.runtime.connectedClients} WS · ${report.runtime.streamSessions} Streams · ${report.runtime.streamSubscribers} Subscriber`} />
              <DetailLine label="Stand" value={fmtTime(report.generatedAt)} />
            </div>
            {topChecks.map(check => <CheckRow key={check.id} check={check} mobile={mobile} />)}
            {report.nextActions.length > 0 && (
              <div className="info-detail-list info-text-meta mt-1">
                <DetailLine label="Nächster Hebel" value={report.nextActions[0]} />
              </div>
            )}
          </Guided>
        </div>
      )}
    </div>
  )
}
