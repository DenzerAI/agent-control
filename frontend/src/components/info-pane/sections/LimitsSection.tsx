import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronRight, Gauge, RefreshCw } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type Engine = 'claude' | 'codex'

function ClaudeCodeLogo({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true">
      <path d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
    </svg>
  )
}

function CodexLogo({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true">
      <path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  )
}

interface UsageSnapshot {
  captured_at: string
  plan: string | null
  session_used_pct: number | null
  session_resets_at: string | null
  session_resets_in_min: number | null
  week_used_pct: number | null
  week_resets_at: string | null
  routines_used: number | null
  routines_total: number | null
  error: string | null
  last_attempted_at?: string | null
  last_error?: string | null
}

interface UsageHistoryEntry {
  captured_at: string
  session_used_pct: number | null
  session_resets_at: string | null
  week_used_pct: number | null
  week_resets_at: string | null
}

interface TokenSnapshot {
  month: string
  today: string
  providers: {
    provider: string
    model: string
    calls: number
    calls_today: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cost_usd_month: number
    cost_usd_today: number
  }[]
  totals: {
    calls: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cost_usd_month: number
    cost_usd_today: number
  }
  agent_sdk_credit_usd: number
  agent_sdk_used_usd_month: number
  agent_sdk_remaining_usd: number
  agent_sdk_pct: number
  cutover_date: string
  elevenlabs?: ElevenUsage
}

interface ElevenUsage {
  ok: boolean
  tier?: string
  status?: string
  characters_used?: number
  characters_limit?: number
  characters_remaining?: number
  pct?: number
  reset_date?: string
  error?: string
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function fmtRelFuture(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = t - Date.now()
  if (diff <= 0) return 'jetzt'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `in ${mins} Min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`
  const d = Math.floor(h / 24)
  const hr = h % 24
  return hr ? `in ${d}d ${hr}h` : `in ${d}d`
}

function fmtAge(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60_000)
  if (mins < 1) return 'gerade eben'
  if (mins < 60) return `vor ${mins} Min`
  const h = Math.floor(mins / 60)
  if (h < 24) return `vor ${h}h`
  return `vor ${Math.floor(h / 24)}d`
}

// Naechster Zeitpunkt, an dem ein Wert hochlaeuft (Reset-Sprung filtern).
function paceBetween(history: UsageHistoryEntry[], hoursBack: number): number | null {
  if (history.length < 2) return null
  const now = Date.now()
  const target = now - hoursBack * 3600_000
  // Naechstgelegenen Snapshot zu target finden (mit week_used_pct)
  let start: UsageHistoryEntry | null = null
  let bestDiff = Infinity
  for (const h of history) {
    if (h.week_used_pct == null) continue
    const t = new Date(h.captured_at).getTime()
    const d = Math.abs(t - target)
    if (d < bestDiff) { bestDiff = d; start = h }
  }
  const end = [...history].reverse().find(h => h.week_used_pct != null) || null
  if (!start || !end) return null
  const dtH = (new Date(end.captured_at).getTime() - new Date(start.captured_at).getTime()) / 3600_000
  if (dtH <= 0.1) return null
  const dPct = (end.week_used_pct as number) - (start.week_used_pct as number)
  if (dPct < 0) return null  // Reset dazwischen → unbrauchbar
  return dPct / dtH
}

// Schlaffenster-Verbrauch: nimmt einen ganzen Block 01:00–07:00 der letzten Naechte
// (nur Naechte, die komplett vor jetzt liegen) und mittelt das Delta. Das entspricht
// dem reinen Job-Anteil, weil Christian schlaeft.
function jobsPerDay(history: UsageHistoryEntry[]): number | null {
  if (history.length < 2) return null
  const byDay = new Map<string, UsageHistoryEntry[]>()
  for (const h of history) {
    if (h.week_used_pct == null) continue
    const d = new Date(h.captured_at)
    const key = d.toISOString().slice(0, 10)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(h)
  }
  const deltas: number[] = []
  for (const entries of byDay.values()) {
    const night = entries.filter(h => {
      const hr = new Date(h.captured_at).getHours()
      return hr >= 1 && hr < 7
    }).sort((a, b) => a.captured_at.localeCompare(b.captured_at))
    if (night.length < 2) continue
    const first = night[0].week_used_pct as number
    const last = night[night.length - 1].week_used_pct as number
    const dt = (new Date(night[night.length - 1].captured_at).getTime() - new Date(night[0].captured_at).getTime()) / 3600_000
    if (dt < 1) continue
    const d = last - first
    if (d < 0) continue
    // hochgerechnet auf 24h: das was Jobs ueber den ganzen Tag verteilt ziehen
    deltas.push((d / dt) * 24)
  }
  if (deltas.length === 0) return null
  return deltas.reduce((a, b) => a + b, 0) / deltas.length
}

export function LimitsSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <LimitsWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <LimitsInlineSection mobile={mobile} />
}

function LimitsWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Limits im Workspace öffnen">
        <Gauge className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Limits</span>
      </button>
    </div>
  )
}

function LimitsInlineSection({ mobile }: { mobile?: boolean }) {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [tokens, setTokens] = useState<TokenSnapshot | null>(null)
  const [history, setHistory] = useState<UsageHistoryEntry[]>([])
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:limitsOpen') === '1' } catch { return false }
  })
  const [engine, setEngine] = useState<Engine>(() => {
    try {
      const saved = localStorage.getItem('infopane:limitsEngine')
      if (saved === 'claude' || saved === 'codex') return saved
      return localStorage.getItem('control:engine:default') === 'codex' ? 'codex' : 'claude'
    } catch { return 'claude' }
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((fresh: boolean) => {
    setLoading(true); setError(null)
    const usageUrl = engine === 'claude'
      ? `/api/usage/claude?fresh=${fresh ? 'true' : 'false'}`
      : `/api/usage/codex?fresh=${fresh ? 'true' : 'false'}`
    const historyUrl = engine === 'claude'
      ? '/api/usage/history?hours=168'
      : '/api/usage/codex/history?hours=168'
    fetch(usageUrl)
      .then(r => r.json())
      .then(d => { setSnap(d as UsageSnapshot); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
    fetch(historyUrl)
      .then(r => r.json())
      .then(d => setHistory((d?.history || []) as UsageHistoryEntry[]))
      .catch(() => {})
    fetch('/api/limits', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d && !d.error) setTokens(d as TokenSnapshot) })
      .catch(() => {})
  }, [engine])

  useEffect(() => { if (open) load(false) }, [open, load])
  useEffect(() => { try { localStorage.setItem('infopane:limitsOpen', open ? '1' : '0') } catch {} }, [open])
  useEffect(() => { try { localStorage.setItem('infopane:limitsEngine', engine) } catch {} }, [engine])

  const sessPct = snap?.session_used_pct ?? null
  const weekPct = snap?.week_used_pct ?? null

  // ── Berechnungen ────────────────────────────────────────────────
  const metrics = useMemo(() => {
    const pace1h = paceBetween(history, 1)
    const pace24h = paceBetween(history, 24)
    const jobs = jobsPerDay(history)

    let forecastExhaustAt: Date | null = null
    let reachesReset: boolean | null = null
    if (pace24h != null && pace24h > 0 && weekPct != null && snap?.week_resets_at) {
      const hToExhaust = (100 - weekPct) / pace24h
      forecastExhaustAt = new Date(Date.now() + hToExhaust * 3600_000)
      reachesReset = forecastExhaustAt.getTime() >= new Date(snap.week_resets_at).getTime()
    }

    // Heute schon verbraucht
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    let usedToday: number | null = null
    if (weekPct != null) {
      const todayEntries = history.filter(h => h.week_used_pct != null && new Date(h.captured_at) >= todayStart)
      if (todayEntries.length > 0) {
        const min = Math.min(...todayEntries.map(h => h.week_used_pct as number))
        usedToday = Math.max(0, weekPct - min)
      }
    }

    // Chat-Anteil pro Tag = letzte 24h Tempo*24 minus Job-Anteil
    let chatPerDay: number | null = null
    if (pace24h != null && jobs != null) {
      chatPerDay = Math.max(0, pace24h * 24 - jobs)
    }

    return { pace1h, pace24h, jobs, chatPerDay, forecastExhaustAt, reachesReset, usedToday }
  }, [history, weekPct, snap?.week_resets_at])

  // Tagesbudget Woche: linear verteilt auf Resttage bis Reset
  const dailyBudget = (() => {
    if (weekPct == null || !snap?.week_resets_at) return null
    const ms = new Date(snap.week_resets_at).getTime() - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return null
    const days = Math.max(1, ms / 86_400_000)
    return Math.max(0, (100 - weekPct) / days)
  })()

  // Heute noch übrig: Tagesbudget minus was heute schon weg ist
  const remainingToday = (() => {
    if (dailyBudget == null) return null
    const used = metrics.usedToday ?? 0
    return dailyBudget - used
  })()

  const isCritical =
    (sessPct != null && sessPct >= 80) ||
    (metrics.reachesReset === false)

  const renderBar = (pct: number, warn?: boolean) => (
    <div className="flex-1 h-1 rounded bg-white/[0.08] overflow-hidden">
      <div className={`h-full ${warn ? 'bg-[var(--cc-orange)]' : 'bg-[var(--t2)]'}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )

  const renderRow = (label: string, pct: number | null, reset: string | null, warn?: boolean) => (
    <div className="flex items-center gap-3 py-[5px] pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
      <span className="info-text-body text-[var(--t2)] w-14 flex-shrink-0">{label}</span>
      {pct != null ? renderBar(pct, warn) : <span className="flex-1" />}
      <span className={`info-text-body tabular-nums w-9 text-right flex-shrink-0 ${warn ? 'text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>{pct != null ? `${pct}%` : '—'}</span>
      <span className="info-text-meta tabular-nums text-[var(--t3)]/70 w-20 text-right truncate flex-shrink-0">{reset ? fmtRelFuture(reset) : ''}</span>
    </div>
  )

  // ── Tagestabelle: pro Tag den Verbrauch (Reset-Spruenge filtern) ──
  const daily = useMemo(() => {
    const byDay = new Map<string, UsageHistoryEntry[]>()
    for (const h of history) {
      if (h.week_used_pct == null) continue
      const key = new Date(h.captured_at).toISOString().slice(0, 10)
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key)!.push(h)
    }
    const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
    const days = Array.from(byDay.entries())
      .map(([key, arr]) => {
        arr.sort((a, b) => a.captured_at.localeCompare(b.captured_at))
        // Differenz zwischen letztem und erstem Wert des Tages,
        // negative Werte (Reset) ignorieren → dann letzten Wert nehmen
        const first = arr[0].week_used_pct as number
        const last = arr[arr.length - 1].week_used_pct as number
        const delta = last >= first ? last - first : last
        const d = new Date(key + 'T12:00:00')
        return { key, label: WEEKDAYS[d.getDay()], delta }
      })
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-7)
    return days
  }, [history])

  const sessWarn = sessPct != null && sessPct >= 80
  const weekWarn = metrics.reachesReset === false

  // Forecast-Prosa
  const forecastLine = (() => {
    const f = metrics.forecastExhaustAt
    const reset = snap?.week_resets_at ? new Date(snap.week_resets_at) : null
    if (metrics.pace24h == null) return null
    if (metrics.pace24h <= 0.05) return 'Aktuell kaum Verbrauch, du reichst locker.'
    if (!f || !reset) return null
    if (f.getTime() >= reset.getTime()) {
      return `Bei dem Tempo reichst du bis zum Reset (${fmtRelFuture(snap?.week_resets_at ?? null)}).`
    }
    const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
    const wd = WD[f.getDay()]
    const hh = String(f.getHours()).padStart(2, '0')
    const mm = String(f.getMinutes()).padStart(2, '0')
    const sameDay = f.toDateString() === new Date().toDateString()
    const when = sameDay ? `heute um ${hh}:${mm}` : `${wd} um ${hh}:${mm}`
    return `Bei dem Tempo bist du ${when} durch.`
  })()

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Gauge className={`info-icon-md mr-2 flex-shrink-0 ${isCritical ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Limits</span>
        <span className="flex-1" />
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); load(true) }}
            className="ml-2 p-1 rounded text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Frisch laden (Browser ploppt kurz auf)">
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
          {/* Engine-Tabs */}
          <div className="flex items-center gap-1 pb-2 pt-1 pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
            {(['claude', 'codex'] as Engine[]).map(e => (
              <button
                key={e}
                onClick={() => setEngine(e)}
                className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
                  engine === e
                    ? 'bg-white/[0.10] text-[var(--t1)]'
                    : 'text-[var(--t3)] hover:bg-white/[0.06] hover:text-[var(--t2)]'
                }`}
                title={e === 'claude' ? 'Claude Code' : 'Codex'}
              >
                {e === 'claude' ? <ClaudeCodeLogo size={16} /> : <CodexLogo size={16} />}
              </button>
            ))}
          </div>
          {error && <div className="text-[var(--t3)] info-text-meta py-2 pl-1">Fehler: {error}</div>}
          {snap?.error === 'not_logged_in' && (
            <div className="info-text-meta text-[var(--t3)] py-2 pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
              Nicht eingeloggt. Einmalig:&nbsp;
              <code className="text-[var(--t2)]">{engine === 'claude' ? 'python -m modules.usage.service login' : 'python -m modules.usage.codex_service login'}</code>
            </div>
          )}
          {loading && snap === null && (
            <div className="text-[var(--t3)]/60 info-text-meta py-2 pl-1">Lädt…</div>
          )}
          {snap && snap.error !== 'not_logged_in' && (
            <>
              {/* Status */}
              {renderRow('Sitzung', sessPct, snap.session_resets_at, sessWarn)}
              {renderRow('Woche', weekPct, snap.week_resets_at, weekWarn)}

              {/* Forecast */}
              {forecastLine && (
                <div
                  className={`info-text-meta pt-2 pl-1 ${weekWarn ? 'text-[var(--cc-orange)]' : 'text-[var(--t2)]/80'}`}
                  style={{ paddingRight: mobile ? '16px' : '12px' }}
                >
                  {forecastLine}
                </div>
              )}

              {/* Tagesbudget: was heute noch übrig ist */}
              {remainingToday != null && dailyBudget != null && (
                <div
                  className="pt-3 flex items-baseline gap-2 pl-1"
                  style={{ paddingRight: mobile ? '16px' : '12px' }}
                >
                  <span className="info-text-body text-[var(--t2)]/70">Heute noch</span>
                  <span className={`text-[17px] font-medium tabular-nums ${remainingToday < 0 ? 'text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>
                    {remainingToday >= 0 ? `${remainingToday.toFixed(1)} %` : `${Math.abs(remainingToday).toFixed(1)} % über`}
                  </span>
                  <span className="info-text-meta text-[var(--t3)]/60 tabular-nums">
                    von {dailyBudget.toFixed(1)} %
                  </span>
                </div>
              )}

              {/* 7-Tage-Mini-Tabelle */}
              {daily.length > 0 && (
                <div className="pt-3 pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
                  <div className="info-text-meta text-[var(--t3)]/60 pb-1">7 Tage</div>
                  {daily.map(d => (
                    <div key={d.key} className="flex justify-between info-text-meta tabular-nums">
                      <span className="text-[var(--t2)]/70">{d.label}</span>
                      <span className="text-[var(--t1)]">{d.delta.toFixed(1)} %</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Aufschlüsselung */}
              <div className="pt-3 pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
                <div className="info-text-meta text-[var(--t3)]/60 pb-1">Tempo</div>
                <div className="flex justify-between info-text-meta tabular-nums">
                  <span className="text-[var(--t2)]/70">Letzte Stunde</span>
                  <span className="text-[var(--t1)]">{metrics.pace1h != null ? `${metrics.pace1h.toFixed(1)} %/h` : '—'}</span>
                </div>
                <div className="flex justify-between info-text-meta tabular-nums">
                  <span className="text-[var(--t2)]/70">Letzte 24h</span>
                  <span className="text-[var(--t1)]">{metrics.pace24h != null ? `${(metrics.pace24h * 24).toFixed(1)} %/Tag` : '—'}</span>
                </div>
                {dailyBudget != null && (
                  <div className="flex justify-between info-text-meta tabular-nums">
                    <span className="text-[var(--t2)]/70">Budget linear</span>
                    <span className="text-[var(--t3)]">{dailyBudget.toFixed(1)} %/Tag</span>
                  </div>
                )}
              </div>

              <div className="pt-3 pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
                <div className="info-text-meta text-[var(--t3)]/60 pb-1">Aufschlüsselung</div>
                <div className="flex justify-between info-text-meta tabular-nums">
                  <span className="text-[var(--t2)]/70">Jobs</span>
                  <span className="text-[var(--t1)]">{metrics.jobs != null ? `${metrics.jobs.toFixed(1)} %/Tag` : '—'}</span>
                </div>
                <div className="flex justify-between info-text-meta tabular-nums">
                  <span className="text-[var(--t2)]/70">Chat</span>
                  <span className="text-[var(--t1)]">{metrics.chatPerDay != null ? `${metrics.chatPerDay.toFixed(1)} %/Tag` : '—'}</span>
                </div>
                {metrics.usedToday != null && (
                  <div className="flex justify-between info-text-meta tabular-nums">
                    <span className="text-[var(--t2)]/70">Heute</span>
                    <span className="text-[var(--t1)]">{metrics.usedToday.toFixed(1)} %</span>
                  </div>
                )}
              </div>

              {snap.captured_at && (
                <div className="info-text-meta text-[var(--t3)]/50 pt-3 pl-1 text-right tabular-nums" style={{ paddingRight: mobile ? '16px' : '12px' }}>
                  Stand {fmtAge(snap.captured_at)}
                  {snap.last_attempted_at && snap.last_error && (
                    <span className="text-[var(--cc-orange)]/80">
                      {' · '}letzter Versuch {fmtAge(snap.last_attempted_at)} fehlgeschlagen
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {tokens && tokens.totals.calls > 0 && (
            <div className="pt-4 mt-3 pl-1 border-t border-white/[0.06]" style={{ paddingRight: mobile ? '16px' : '12px' }}>
              <div className="info-text-meta text-[var(--t3)]/60 pb-1 flex items-baseline gap-2">
                <span>Tokens & Kosten · {tokens.month}</span>
                <span className="text-[var(--t3)]/40">ab {tokens.cutover_date}</span>
              </div>

              {/* Agent-SDK-Topf — $200/Monat ab 15.06. */}
              <div className="flex items-center gap-2 py-1">
                <span className="info-text-body text-[var(--t2)]/70 w-24 flex-shrink-0">Agent-SDK</span>
                <div className="flex-1 h-1 rounded bg-white/[0.08] overflow-hidden">
                  <div
                    className={`h-full ${tokens.agent_sdk_pct >= 80 ? 'bg-[var(--cc-orange)]' : 'bg-[var(--t2)]'}`}
                    style={{ width: `${Math.min(100, tokens.agent_sdk_pct)}%` }}
                  />
                </div>
                <span className={`info-text-body tabular-nums w-14 text-right flex-shrink-0 ${tokens.agent_sdk_pct >= 80 ? 'text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>
                  {fmtUsd(tokens.agent_sdk_used_usd_month)}
                </span>
                <span className="info-text-meta tabular-nums text-[var(--t3)]/70 w-12 text-right">
                  /${tokens.agent_sdk_credit_usd}
                </span>
              </div>

              {/* Provider-Aufschlüsselung */}
              <div className="pt-2 space-y-0.5">
                {tokens.providers.map(p => (
                  <div key={`${p.provider}-${p.model}`} className="flex justify-between info-text-meta tabular-nums">
                    <span className="text-[var(--t2)]/70 truncate flex-1 mr-2">
                      {p.provider} · {p.model.split('-').slice(0, 3).join('-')}
                    </span>
                    <span className="text-[var(--t3)]/60 mr-2">{p.calls}× · {fmtTokens(p.input_tokens + p.output_tokens)}t</span>
                    <span className="text-[var(--t1)] w-14 text-right">{fmtUsd(p.cost_usd_month)}</span>
                  </div>
                ))}
              </div>

              <div className="pt-2 flex justify-between info-text-meta tabular-nums">
                <span className="text-[var(--t2)]/70">Heute</span>
                <span className="text-[var(--t1)]">{fmtUsd(tokens.totals.cost_usd_today)}</span>
              </div>
              <div className="flex justify-between info-text-meta tabular-nums">
                <span className="text-[var(--t2)]/70">Monat gesamt</span>
                <span className="text-[var(--t1)]">{fmtUsd(tokens.totals.cost_usd_month)}</span>
              </div>
            </div>
          )}

          {/* ElevenLabs: TTS-Zeichenkontingent (eigenes Abo, nicht LLM-Token) */}
          {tokens?.elevenlabs?.ok && (
            <div className="pt-4 mt-3 pl-1 border-t border-white/[0.06]" style={{ paddingRight: mobile ? '16px' : '12px' }}>
              <div className="info-text-meta text-[var(--t3)]/60 pb-1 flex items-baseline gap-2">
                <span>ElevenLabs · Stimme</span>
                {tokens.elevenlabs.tier && <span className="text-[var(--t3)]/40">{tokens.elevenlabs.tier}</span>}
              </div>

              {/* Zeichen-Balken */}
              <div className="flex items-center gap-2 py-1">
                <span className="info-text-body text-[var(--t2)]/70 w-24 flex-shrink-0">Zeichen</span>
                <div className="flex-1 h-1 rounded bg-white/[0.08] overflow-hidden">
                  <div
                    className={`h-full ${(tokens.elevenlabs.pct ?? 0) >= 80 ? 'bg-[var(--cc-orange)]' : 'bg-[var(--t2)]'}`}
                    style={{ width: `${Math.min(100, tokens.elevenlabs.pct ?? 0)}%` }}
                  />
                </div>
                <span className={`info-text-body tabular-nums w-14 text-right flex-shrink-0 ${(tokens.elevenlabs.pct ?? 0) >= 80 ? 'text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>
                  {(tokens.elevenlabs.pct ?? 0).toFixed(1)}%
                </span>
              </div>

              <div className="pt-1 flex justify-between info-text-meta tabular-nums">
                <span className="text-[var(--t2)]/70">Verbraucht</span>
                <span className="text-[var(--t1)]">{fmtTokens(tokens.elevenlabs.characters_used ?? 0)} / {fmtTokens(tokens.elevenlabs.characters_limit ?? 0)}</span>
              </div>
              <div className="flex justify-between info-text-meta tabular-nums">
                <span className="text-[var(--t2)]/70">Rest</span>
                <span className="text-[var(--t1)]">{fmtTokens(tokens.elevenlabs.characters_remaining ?? 0)}</span>
              </div>
              {tokens.elevenlabs.reset_date && (
                <div className="flex justify-between info-text-meta tabular-nums">
                  <span className="text-[var(--t2)]/70">Erneuerung</span>
                  <span className="text-[var(--t1)]">{tokens.elevenlabs.reset_date}</span>
                </div>
              )}
            </div>
          )}
          </Guided>
        </div>
      )}
    </div>
  )
}
