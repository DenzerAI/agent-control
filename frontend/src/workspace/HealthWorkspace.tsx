import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, BedDouble, Dumbbell, HeartPulse, RefreshCw, Scale, Zap } from 'lucide-react'

type HealthCard = {
  key: string
  label: string
  value: number
  unit: string
  score: number
  raw_value?: number
  raw_unit?: string
  status: string
  detail?: string
}

type DayWindow = { kind: string; label: string; tone?: string; start: string; end: string; level: number; detail: string }

type HealthDashboard = {
  date: string
  latest_snapshot_at?: string
  features: { sleep_hours?: number; hrv_ms?: number; resting_hr?: number; steps?: number; workout_min?: number }
  baselines?: { hrv_median?: number; rhr_median?: number }
  scores: Record<string, number>
  sleep_plan?: { tonight_h?: number; schedule?: { bedtime?: string; wake_target?: string; is_late?: boolean } }
  training_context?: { target_mode?: { label: string }; load_balance?: { ratio?: number; status?: string; detail?: string } }
  body_composition?: { current?: { weight_kg?: number; body_fat_pct?: number; skeletal_muscle_kg?: number }; status?: string; detail?: string; score?: number }
  compass?: { label: string; detail: string; score: number; balance?: { value: number; label: string; detail: string } }
  coach?: { label: string; detail: string; facts?: string[] }
  data_quality?: { label: string; detail: string; confidence: number }
  decision?: { label: string; detail: string }
  day_curve?: DayWindow[]
  cards: HealthCard[]
}

type HealthState = {
  dashboard: HealthDashboard
  received_at?: string
}

const HEALTH_CACHE_KEY = 'workspace:health:lastState'

function readCachedHealth(): HealthState | null {
  try {
    const raw = localStorage.getItem(HEALTH_CACHE_KEY)
    return raw ? JSON.parse(raw) as HealthState : null
  } catch { return null }
}

function writeCachedHealth(state: HealthState) {
  try { localStorage.setItem(HEALTH_CACHE_KEY, JSON.stringify(state)) } catch {}
}

function fetchJsonWithTimeout(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
    .finally(() => window.clearTimeout(timer))
}

const cardIcons: Record<string, typeof Activity> = {
  sleep_debt: BedDouble,
  sleep_quality: BedDouble,
  recovery: HeartPulse,
  heart_rate: HeartPulse,
  readiness: Activity,
  body_battery: Zap,
  training_load: Dumbbell,
  training_rhythm: Dumbbell,
  daily_strain: Dumbbell,
  body_composition: Scale,
  activity: Activity,
}

function fmtNum(value: number | undefined, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '–'
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
}

function fmtTime(value?: string): string {
  if (!value) return '–'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function scoreColor(score?: number): string {
  if (score === undefined || Number.isNaN(score)) return 'var(--warm)'
  if (score >= 70) return 'var(--green)'
  if (score >= 45) return 'var(--warm)'
  return '#ef4444'
}

function toneColor(tone?: string): string {
  if (tone === 'good') return 'var(--green)'
  if (tone === 'attention') return 'var(--warm)'
  return 'var(--t3)'
}

function currentWindow(windows: DayWindow[]): DayWindow | null {
  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  return windows.find(window => {
    const [sh, sm] = window.start.split(':').map(Number)
    const [eh, em] = window.end.split(':').map(Number)
    const start = sh * 60 + sm
    const end = eh * 60 + em
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    return end <= start ? current >= start || current < end : current >= start && current < end
  }) || null
}

function cardValue(card: HealthCard): string {
  if (card.raw_value !== undefined && card.raw_unit) return `${fmtNum(card.raw_value, card.key === 'training_load' ? 2 : 1)} ${card.raw_unit}`
  if (card.unit === '/100') return `${fmtNum(card.score || card.value)}/100`
  return `${fmtNum(card.value, card.key === 'body_composition' ? 1 : 0)}${card.unit ? ` ${card.unit}` : ''}`
}

export function HealthWorkspace() {
  const [state, setState] = useState<HealthState | null>(() => readCachedHealth())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    fetchJsonWithTimeout('/api/health/state')
      .then(d => {
        if ((d as HealthState)?.dashboard) {
          const next = { dashboard: (d as HealthState).dashboard, received_at: new Date().toISOString() }
          setState(next)
          writeCachedHealth(next)
        }
      })
      .catch(e => setError(`Health nicht lesbar, letzter Stand bleibt: ${e.message}`))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 300000)
    return () => window.clearInterval(id)
  }, [load])

  const dashboard = state?.dashboard
  const windows = dashboard?.day_curve || []
  const active = useMemo(() => currentWindow(windows), [windows])
  const compassScore = dashboard?.compass?.score ?? dashboard?.scores?.readiness ?? dashboard?.cards?.find(card => card.key === 'readiness')?.score
  const signalCards = ['readiness', 'body_battery', 'heart_rate', 'daily_strain', 'training_load', 'sleep_debt']
    .map(key => dashboard?.cards?.find(card => card.key === key))
    .filter(Boolean) as HealthCard[]

  if (!dashboard) {
    return (
      <div className="workspace-health workspace-health-empty">
        <button type="button" onClick={load} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span>{error || (loading ? 'lädt …' : 'Health laden')}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="workspace-health">
      <header className="workspace-health-hero">
        <div>
          <p>Health · {dashboard.data_quality?.label || 'Daten'} · {fmtTime(dashboard.latest_snapshot_at)}</p>
          <h2>{dashboard.compass?.label || dashboard.decision?.label || 'Tageslage'}</h2>
          <span>{dashboard.compass?.detail || dashboard.decision?.detail || dashboard.coach?.detail || 'Keine Empfehlung verfügbar.'}</span>
        </div>
        <div className="workspace-health-score" style={{ color: scoreColor(compassScore) }}>
          <strong>{fmtNum(compassScore)}</strong>
          <span>/100</span>
        </div>
        <button type="button" onClick={load} disabled={loading} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </header>

      <div className="workspace-health-strip">
        <section>
          <span>Schlaf</span>
          <strong>{fmtNum(dashboard.features.sleep_hours, 1)}h</strong>
          <em>Bedarf {fmtNum(dashboard.sleep_plan?.tonight_h, 1)}h</em>
        </section>
        <section>
          <span>Erholung</span>
          <strong>{fmtNum(dashboard.features.hrv_ms)} ms</strong>
          <em>HRV Basis {fmtNum(dashboard.baselines?.hrv_median)} ms</em>
        </section>
        <section>
          <span>Training</span>
          <strong>{dashboard.training_context?.target_mode?.label || 'offen'}</strong>
          <em>{dashboard.training_context?.load_balance?.status || `${fmtNum(dashboard.features.workout_min)} min`}</em>
        </section>
        <section>
          <span>Körper</span>
          <strong>{fmtNum(dashboard.body_composition?.current?.body_fat_pct, 1)}%</strong>
          <em>{dashboard.body_composition?.status || `${fmtNum(dashboard.features.steps)} Schritte`}</em>
        </section>
      </div>

      <div className="workspace-health-main">
        <section className="workspace-health-panel">
          <div className="workspace-health-panel-head">
            <strong>Tagesfenster</strong>
            {active && <span>jetzt: {active.label}</span>}
          </div>
          <div className="workspace-health-timeline">
            {windows.map(window => (
              <div key={`${window.kind}-${window.start}`} className={active === window ? 'is-active' : ''}>
                <time style={{ color: toneColor(window.tone) }}>{window.start}<span>{window.end}</span></time>
                <article>
                  <strong>{window.label}</strong>
                  <span>{window.detail}</span>
                </article>
              </div>
            ))}
            {windows.length === 0 && <p>Keine Tageskurve verfügbar.</p>}
          </div>
        </section>

        <section className="workspace-health-panel">
          <div className="workspace-health-panel-head">
            <strong>Kernsignale</strong>
            <span>{fmtTime(state.received_at)}</span>
          </div>
          <div className="workspace-health-cards">
            {signalCards.map(card => {
              const Icon = cardIcons[card.key] || Activity
              const color = scoreColor(card.score)
              return (
                <article key={card.key}>
                  <div>
                    <Icon className="h-4 w-4" />
                    <span>{card.label}</span>
                    <strong>{cardValue(card)}</strong>
                  </div>
                  <em>{card.status}</em>
                  <div className="workspace-health-bar">
                    <span style={{ width: `${Math.max(4, Math.min(100, card.score))}%`, background: color }} />
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
