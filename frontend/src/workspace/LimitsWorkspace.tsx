import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, DollarSign, Gauge, RefreshCw } from 'lucide-react'

type Engine = 'claude' | 'codex'

type UsageSnapshot = {
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

type UsageHistoryEntry = {
  captured_at: string
  session_used_pct: number | null
  session_resets_at: string | null
  week_used_pct: number | null
  week_resets_at: string | null
}

type TokenSnapshot = {
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
}

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

function cacheKey(kind: 'usage' | 'history' | 'tokens', engine?: Engine): string {
  return `workspace:limits:${kind}${engine ? `:${engine}` : ''}`
}

function readCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

function writeCache(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

function fetchJsonWithTimeout(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
    .finally(() => window.clearTimeout(timer))
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '-'
  if (n >= 2000) return 'Log prüfen'
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

function paceBetween(history: UsageHistoryEntry[], hoursBack: number): number | null {
  if (history.length < 2) return null
  const target = Date.now() - hoursBack * 3600_000
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
  if (dPct < 0) return null
  return dPct / dtH
}

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
    deltas.push((d / dt) * 24)
  }
  if (deltas.length === 0) return null
  return deltas.reduce((a, b) => a + b, 0) / deltas.length
}

function pctLabel(value: number | null): string {
  return value == null ? '-' : `${value.toFixed(value % 1 ? 1 : 0)}%`
}

function barWidth(value: number | null): string {
  return `${Math.min(100, Math.max(0, value ?? 0))}%`
}

function engineLabel(engine: Engine): string {
  return engine === 'claude' ? 'Claude Code' : 'Codex'
}

function initialEngine(): Engine {
  try {
    const saved = localStorage.getItem('infopane:limitsEngine')
    if (saved === 'claude' || saved === 'codex') return saved
    return localStorage.getItem('control:engine:default') === 'codex' ? 'codex' : 'claude'
  } catch { return 'claude' }
}

export function LimitsWorkspace() {
  const [engine, setEngine] = useState<Engine>(() => initialEngine())
  const [snap, setSnap] = useState<UsageSnapshot | null>(() => readCache<UsageSnapshot | null>(cacheKey('usage', initialEngine()), null))
  const [tokens, setTokens] = useState<TokenSnapshot | null>(() => readCache<TokenSnapshot | null>(cacheKey('tokens'), null))
  const [history, setHistory] = useState<UsageHistoryEntry[]>(() => readCache<UsageHistoryEntry[]>(cacheKey('history', initialEngine()), []))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback((fresh = false) => {
    setLoading(true)
    setError('')
    const usageUrl = engine === 'claude'
      ? `/api/usage/claude?fresh=${fresh ? 'true' : 'false'}`
      : `/api/usage/codex?fresh=${fresh ? 'true' : 'false'}`
    const historyUrl = engine === 'claude'
      ? '/api/usage/history?hours=168'
      : '/api/usage/codex/history?hours=168'

    fetchJsonWithTimeout(usageUrl, fresh ? 25000 : 12000)
      .then(usage => {
        setSnap(usage as UsageSnapshot)
        writeCache(cacheKey('usage', engine), usage)
      })
      .catch(e => setError(`${engineLabel(engine)} gerade nicht erreichbar, letzter Stand bleibt: ${e.message}`))
      .finally(() => setLoading(false))

    fetchJsonWithTimeout(historyUrl, 12000)
      .then(hist => {
        const next = (((hist as { history?: UsageHistoryEntry[] })?.history || []) as UsageHistoryEntry[])
        setHistory(next)
        writeCache(cacheKey('history', engine), next)
      })
      .catch(() => {})

    fetchJsonWithTimeout('/api/limits', 12000)
      .then(tokenData => {
        if (tokenData && !(tokenData as { error?: string }).error) {
          setTokens(tokenData as TokenSnapshot)
          writeCache(cacheKey('tokens'), tokenData)
        }
      })
      .catch(() => {})
  }, [engine])

  useEffect(() => {
    try { localStorage.setItem('infopane:limitsEngine', engine) } catch {}
    setSnap(readCache<UsageSnapshot | null>(cacheKey('usage', engine), null))
    setHistory(readCache<UsageHistoryEntry[]>(cacheKey('history', engine), []))
    setTokens(readCache<TokenSnapshot | null>(cacheKey('tokens'), null))
    setError('')
    load(false)
  }, [engine, load])

  const weekPct = snap?.week_used_pct ?? null
  const sessionPct = snap?.session_used_pct ?? null

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
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    let usedToday: number | null = null
    if (weekPct != null) {
      const todayEntries = history.filter(h => h.week_used_pct != null && new Date(h.captured_at) >= todayStart)
      if (todayEntries.length > 0) {
        const min = Math.min(...todayEntries.map(h => h.week_used_pct as number))
        usedToday = Math.max(0, weekPct - min)
      }
    }
    const chatPerDay = pace24h != null && jobs != null ? Math.max(0, pace24h * 24 - jobs) : null
    return { pace1h, pace24h, jobs, chatPerDay, forecastExhaustAt, reachesReset, usedToday }
  }, [history, weekPct, snap?.week_resets_at])

  const dailyBudget = (() => {
    if (weekPct == null || !snap?.week_resets_at) return null
    const ms = new Date(snap.week_resets_at).getTime() - Date.now()
    if (!Number.isFinite(ms) || ms <= 0) return null
    const days = Math.max(1, ms / 86_400_000)
    return Math.max(0, (100 - weekPct) / days)
  })()

  const remainingToday = dailyBudget == null ? null : dailyBudget - (metrics.usedToday ?? 0)
  const weekWarn = metrics.reachesReset === false
  const sessionWarn = sessionPct != null && sessionPct >= 80

  const daily = useMemo(() => {
    const byDay = new Map<string, UsageHistoryEntry[]>()
    for (const h of history) {
      if (h.week_used_pct == null) continue
      const key = new Date(h.captured_at).toISOString().slice(0, 10)
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key)!.push(h)
    }
    const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
    return Array.from(byDay.entries())
      .map(([key, arr]) => {
        arr.sort((a, b) => a.captured_at.localeCompare(b.captured_at))
        const first = arr[0].week_used_pct as number
        const last = arr[arr.length - 1].week_used_pct as number
        const delta = last >= first ? last - first : last
        const date = new Date(`${key}T12:00:00`)
        return { key, label: days[date.getDay()], delta }
      })
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-7)
  }, [history])

  const forecastLine = (() => {
    const f = metrics.forecastExhaustAt
    const reset = snap?.week_resets_at ? new Date(snap.week_resets_at) : null
    if (metrics.pace24h == null) return 'Noch kein belastbares Tempo.'
    if (metrics.pace24h <= 0.05) return 'Aktuell kaum Verbrauch, du reichst locker.'
    if (!f || !reset) return 'Forecast offen.'
    if (f.getTime() >= reset.getTime()) return `Reicht bis zum Reset ${fmtRelFuture(snap?.week_resets_at ?? null)}.`
    const label = f.toLocaleString('de-DE', { weekday: 'long', hour: '2-digit', minute: '2-digit' })
    return `Bei dem Tempo bist du ${label} durch.`
  })()

  const headline = (() => {
    if (snap?.error === 'not_logged_in') return `${engineLabel(engine)} nicht eingeloggt`
    if (weekWarn) return 'Woche wird eng'
    if (sessionWarn) return 'Sitzung ist hoch'
    if (snap) return 'Limits im Rahmen'
    return 'Limits laden'
  })()

  const empty = !snap && !error

  return (
    <div className="workspace-limits">
      <header className="workspace-limits-hero">
        <div>
          <p>Limits · {engineLabel(engine)} · {snap?.captured_at ? fmtAge(snap.captured_at) : 'kein Stand'}</p>
          <h2>{headline}</h2>
          <span>{forecastLine}</span>
        </div>
        <div className="workspace-limits-engine" role="tablist" aria-label="Engine">
          {(['claude', 'codex'] as Engine[]).map(item => {
            return (
              <button
                key={item}
                type="button"
                className={engine === item ? 'is-active' : ''}
                onClick={() => setEngine(item)}
                role="tab"
                aria-selected={engine === item}
                title={engineLabel(item)}
              >
                {item === 'claude' ? <ClaudeCodeLogo size={16} /> : <CodexLogo size={16} />}
                <span>{engineLabel(item)}</span>
              </button>
            )
          })}
        </div>
        <button type="button" onClick={() => load(true)} disabled={loading} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </header>

      {error && <div className="workspace-limits-empty">Fehler: {error}</div>}
      {empty && <div className="workspace-limits-empty">{loading ? 'Lädt ...' : 'Keine Limits geladen.'}</div>}
      {snap?.error === 'not_logged_in' && (
        <div className="workspace-limits-empty">
          Einmalig einloggen: {engine === 'claude' ? 'python -m modules.usage.service login' : 'python -m modules.usage.codex_service login'}
        </div>
      )}

      {snap && snap.error !== 'not_logged_in' && (
        <>
          <div className="workspace-limits-strip">
            <MetricCard label="Sitzung" value={pctLabel(sessionPct)} detail={snap.session_resets_at ? fmtRelFuture(snap.session_resets_at) : 'Reset offen'} warn={sessionWarn} />
            <MetricCard label="Woche" value={pctLabel(weekPct)} detail={snap.week_resets_at ? fmtRelFuture(snap.week_resets_at) : 'Reset offen'} warn={weekWarn} />
            <MetricCard
              label="Heute noch"
              value={remainingToday == null ? '-' : remainingToday >= 0 ? `${remainingToday.toFixed(1)}%` : `${Math.abs(remainingToday).toFixed(1)}% über`}
              detail={dailyBudget == null ? 'Budget offen' : `von ${dailyBudget.toFixed(1)}%`}
              warn={remainingToday != null && remainingToday < 0}
            />
            <MetricCard label="Token-Log" value={tokens ? `${fmtTokens(tokens.totals.input_tokens + tokens.totals.output_tokens)}` : '-'} detail={tokens ? `${tokens.totals.calls} Calls` : 'Log offen'} />
          </div>

          <div className="workspace-limits-main">
            <section className="workspace-limits-panel">
              <PanelHead icon={Gauge} label="Verbrauch" value={snap.plan || engineLabel(engine)} />
              <UsageBar label="Sitzung" value={sessionPct} reset={snap.session_resets_at} warn={sessionWarn} />
              <UsageBar label="Woche" value={weekPct} reset={snap.week_resets_at} warn={weekWarn} />
              {snap.captured_at && <p>Stand {fmtAge(snap.captured_at)}</p>}
              {snap.last_attempted_at && snap.last_error && <p className="is-warning">Letzter Versuch {fmtAge(snap.last_attempted_at)} fehlgeschlagen.</p>}
            </section>

            <section className="workspace-limits-panel">
              <PanelHead icon={Clock} label="Tempo" value={metrics.pace24h != null ? `${(metrics.pace24h * 24).toFixed(1)}%/Tag` : '-'} />
              <LimitRow label="Letzte Stunde" value={metrics.pace1h != null ? `${metrics.pace1h.toFixed(1)}%/h` : '-'} />
              <LimitRow label="Jobs" value={metrics.jobs != null ? `${metrics.jobs.toFixed(1)}%/Tag` : '-'} />
              <LimitRow label="Chat" value={metrics.chatPerDay != null ? `${metrics.chatPerDay.toFixed(1)}%/Tag` : '-'} />
              <LimitRow label="Heute" value={metrics.usedToday != null ? `${metrics.usedToday.toFixed(1)}%` : '-'} />
            </section>

            <section className="workspace-limits-panel">
              <PanelHead icon={Clock} label="7 Tage" value={daily.length ? `${daily.length} Tage` : '-'} />
              <div className="workspace-limits-days">
                {daily.map(day => (
                  <div key={day.key}>
                    <span>{day.label}</span>
                    <strong>{day.delta.toFixed(1)}%</strong>
                    <em><i style={{ width: `${Math.min(100, Math.max(3, day.delta))}%` }} /></em>
                  </div>
                ))}
                {daily.length === 0 && <p>Keine History verfügbar.</p>}
              </div>
            </section>

            <section className="workspace-limits-panel">
              <PanelHead icon={DollarSign} label="Tokens & API-Schätzung" value={tokens?.month || '-'} />
              {tokens && tokens.totals.calls > 0 ? (
                <>
                  <UsageBar label="Agent-SDK" value={tokens.agent_sdk_pct} reset={null} warn={tokens.agent_sdk_pct >= 80} valueLabel={`${fmtUsd(tokens.agent_sdk_used_usd_month)} / $${tokens.agent_sdk_credit_usd}`} />
                  <div className="workspace-limits-providers">
                    {tokens.providers.slice(0, 8).map(provider => (
                      <div key={`${provider.provider}-${provider.model}`}>
                        <span>{provider.provider} · {provider.model.split('-').slice(0, 3).join('-')}</span>
                        <em>{provider.calls}x · {fmtTokens(provider.input_tokens + provider.output_tokens)}t</em>
                        <strong>{fmtUsd(provider.cost_usd_month)}</strong>
                      </div>
                    ))}
                  </div>
                  <LimitRow label="Heute" value={fmtUsd(tokens.totals.cost_usd_today)} />
                </>
              ) : (
                <p>Keine Token-Kosten verfügbar.</p>
              )}
            </section>
          </div>
        </>
      )}
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

function PanelHead({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value: string }) {
  return (
    <div className="workspace-limits-panel-head">
      <div>
        <Icon className="h-4 w-4" />
        <strong>{label}</strong>
      </div>
      <span>{value}</span>
    </div>
  )
}

function UsageBar({ label, value, reset, warn, valueLabel }: { label: string; value: number | null; reset: string | null; warn?: boolean; valueLabel?: string }) {
  return (
    <div className="workspace-limits-bar">
      <div>
        <span>{label}</span>
        <strong className={warn ? 'is-warning' : ''}>{valueLabel || pctLabel(value)}</strong>
      </div>
      <em>{reset ? fmtRelFuture(reset) : ''}</em>
      <i><b style={{ width: barWidth(value) }} /></i>
    </div>
  )
}

function LimitRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="workspace-limits-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
