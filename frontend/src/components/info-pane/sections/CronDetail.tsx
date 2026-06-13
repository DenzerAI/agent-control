import { useState, useEffect } from 'react'
import { ChevronLeft, Check } from 'lucide-react'
import { relativeTime } from '../utils/format'
import { cronHuman } from '../utils/cronFormat'
import type { CronJob } from '../types'

function StatusDot({ status, errors }: { status: string; errors: number }) {
  const color = errors > 0 ? '#ef4444' : status === 'ok' ? 'var(--green)' : status === 'error' ? '#ef4444' : 'var(--t3)'
  return <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0" style={{ background: color }} />
}

function governanceText(status?: string): string {
  if (status === 'ready') return 'Governance bereit'
  if (status === 'blocked') return 'Governance blockiert'
  if (status === 'warn') return 'Governance prüfen'
  return 'Governance offen'
}

export function CronDetail({ cron, color, onBack }: { cron: CronJob; color: string; onBack: () => void }) {
  const isLocal = cron.source === 'local'
  const [name, setName] = useState(cron.name)
  const [draft, setDraft] = useState(isLocal ? '' : cron.message)
  const [schedule, setSchedule] = useState(cron.schedule)
  const [model, setModel] = useState(cron.model)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [showScheduleRaw, setShowScheduleRaw] = useState(false)
  const [localLoaded, setLocalLoaded] = useState(!isLocal)
  const [localOriginal, setLocalOriginal] = useState('')

  useEffect(() => {
    if (!isLocal) return
    let cancelled = false
    fetch(`/api/local-job?id=${encodeURIComponent(cron.id)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const body = typeof d.promptBody === 'string' ? d.promptBody : ''
        setDraft(body)
        setLocalOriginal(body)
        setLocalLoaded(true)
      })
      .catch(() => { if (!cancelled) setLocalLoaded(true) })
    return () => { cancelled = true }
  }, [cron.id, isLocal])

  const dirty = isLocal
    ? (localLoaded && draft !== localOriginal)
    : (draft !== cron.message || schedule !== cron.schedule || model !== cron.model || name !== cron.name)
  const openGovernanceChecks = (cron.governance?.checks || [])
    .filter(c => c.status !== 'ok' && c.message)
    .slice(0, 2)

  const save = async () => {
    setSaving(true)
    if (isLocal) {
      const r = await fetch('/api/local-job', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cron.id, promptBody: draft }),
      })
      setSaving(false)
      if (r.ok) {
        setStatus('Gespeichert')
        setLocalOriginal(draft)
      } else {
        setStatus('Fehler')
      }
      setTimeout(() => setStatus(''), 2000)
      return
    }
    const body: Record<string, string> = { id: cron.id, message: draft, schedule, model }
    if (name !== cron.name) body.name = name
    const r = await fetch('/api/cron-update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSaving(false); if (r.ok) setStatus('Gespeichert'); setTimeout(() => setStatus(''), 2000)
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 flex-shrink-0">
        <button onClick={onBack} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer"><ChevronLeft className="info-icon-md" /></button>
        <StatusDot status={cron.enabled ? cron.lastStatus : 'disabled'} errors={cron.consecutiveErrors} />
        {isLocal ? (
          <span className="info-text-body font-semibold text-[var(--t1)] truncate flex-1">{name}</span>
        ) : (
          <input value={name} onChange={e => setName(e.target.value)} className="info-text-body font-semibold text-[var(--t1)] truncate flex-1 bg-transparent outline-none" />
        )}
      </div>
      <div className="px-4 pb-2 flex items-center gap-3 info-text-meta font-mono text-[var(--t3)] flex-shrink-0">
        <span className={isLocal ? '' : 'cursor-pointer hover:text-[var(--t2)]'} onClick={() => !isLocal && setShowScheduleRaw(v => !v)}>
          {schedule ? (showScheduleRaw && !isLocal ? schedule : cronHuman(schedule)) : 'manuell'}
        </span>
        {!isLocal && <><span>·</span><span>{model}</span></>}
        {cron.lastRunAt > 0 && <><span>·</span><span>{relativeTime(cron.lastRunAt)}</span></>}
      </div>
      {cron.manifest && (
        <div className="px-4 pb-2 info-text-meta text-[var(--t3)] flex-shrink-0">
          <span className={cron.manifest.status === 'ready' ? 'text-[var(--t2)]' : 'text-[var(--cc-orange)]'}>
            Manifest {cron.manifest.status === 'ready' ? 'bereit' : 'offen'}
          </span>
          {cron.manifest.coverage != null && <span> · {cron.manifest.coverage}%</span>}
          {cron.manifest.missing && cron.manifest.missing.length > 0 && (
            <span> · fehlt: {cron.manifest.missing.slice(0, 4).join(', ')}</span>
          )}
          {cron.manifest.security && (
            <span> · Security {cron.manifest.security.status === 'safe' ? 'sauber' : cron.manifest.security.status}</span>
          )}
        </div>
      )}
      {cron.governance && (
        <div className="px-4 pb-2 info-text-meta text-[var(--t3)] flex-shrink-0">
          <span className={cron.governance.status === 'ready' ? 'text-[var(--t2)]' : 'text-[var(--cc-orange)]'}>
            {governanceText(cron.governance.status)}
          </span>
          {cron.governance.openCount ? <span> · {cron.governance.openCount} offen</span> : null}
          {openGovernanceChecks.length > 0 && (
            <span> · {openGovernanceChecks.map(c => c.message).join(' · ')}</span>
          )}
        </div>
      )}
      {showScheduleRaw && !isLocal && (
        <div className="px-4 pb-2 flex items-center gap-2 flex-shrink-0">
          <input value={schedule} onChange={e => setSchedule(e.target.value)} className="flex-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-md px-2 py-1 info-text-meta font-mono text-[var(--t2)] outline-none" />
          <input value={model} onChange={e => setModel(e.target.value)} className="w-24 bg-[var(--bg-1)] border border-[var(--border)] rounded-md px-2 py-1 info-text-meta font-mono text-[var(--t2)] outline-none" />
        </div>
      )}
      <div className="px-4 py-2 flex-1 min-h-0 flex flex-col">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={isLocal && !localLoaded}
          placeholder={isLocal && !localLoaded ? 'Lade Prompt...' : ''}
          className="w-full flex-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-lg p-2.5 info-text-meta font-mono text-[var(--t2)] outline-none resize-none disabled:opacity-50"
        />
      </div>
      <div className="px-4 pb-3 flex-shrink-0">
        {dirty && <button onClick={save} disabled={saving} className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg info-text-meta font-mono cursor-pointer transition-colors" style={{ background: `${color}20`, color }}><Check className="info-icon-sm" /> {saving ? 'Speichert...' : 'Speichern'}</button>}
        {status && <div className="info-text-meta font-mono text-center text-[var(--t3)] mt-2">{status}</div>}
      </div>
    </div>
  )
}
