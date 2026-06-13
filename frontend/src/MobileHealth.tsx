import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Battery, BedDouble, Dumbbell, HeartPulse, RefreshCw, Scale, Zap } from 'lucide-react'

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

type HealthEntry = { kind: string; time: string; text: string }

type HealthDashboard = {
  latest_snapshot_at?: string
  sleep_plan?: {
    tonight_h?: number
    schedule?: {
      wake_target: string
      wake_source: string
      bedtime: string
      wind_down: string
      possible_h: number
      is_late: boolean
    }
  }
  day_curve?: { kind: string; label: string; tone?: string; start: string; end: string; level: number; detail: string }[]
  features: {
    sleep_hours?: number
    hrv_ms?: number
    resting_hr?: number
    steps?: number
    active_kcal?: number
    workout_count?: number
    workout_min?: number
    snapshot?: string
  }
  baselines: { hrv_median?: number }
  scores: Record<string, number>
  training_context?: {
    target_mode?: { label: string }
    load_balance?: { ratio: number; status: string; detail: string; mode: string; zones?: { ideal_min?: number; ideal_max?: number } }
    rhythm?: { label: string; status: string; streak_days?: number; days_since_training?: number; trained_today?: boolean; detail: string; next_hint?: string }
  }
  lifestyle_context?: {
    pulse?: { label: string; status: string; score: number; delta_bpm?: number; detail: string }
    training_rhythm?: { label: string; status: string; streak_days?: number; days_since_training?: number; trained_today?: boolean; detail: string; next_hint?: string }
    caffeine?: { status: string; mg?: number; logged?: boolean; detail: string }
    nutrition?: { status: string; protein_g?: number; protein_goal_g?: number; detail: string }
    subjective?: { status: string; low_energy?: boolean; detail: string }
  }
  body_composition?: {
    current?: { weight_kg?: number; body_fat_pct?: number; skeletal_muscle_kg?: number }
    delta?: { weight_kg?: number; body_fat_pct?: number; fat_mass_kg?: number; skeletal_muscle_kg?: number }
    status: string
    score: number
    detail: string
  }
  coach?: { label: string; detail: string; facts?: string[] }
  data_quality?: { label: string; detail: string; confidence: number }
  compass?: { label: string; detail: string; score: number; balance?: { value: number; label: string; detail: string; zone: string } }
  cards: HealthCard[]
  decision: { label: string; detail: string }
}

type HealthState = {
  dashboard: HealthDashboard
  entries: HealthEntry[]
  received_at?: string
}

const CACHE_KEY = 'mobile:healthState'

const ICONS: Record<string, typeof Activity> = {
  readiness: Activity,
  body_battery: Battery,
  heart_rate: HeartPulse,
  recovery: HeartPulse,
  daily_strain: Dumbbell,
  training_load: Dumbbell,
  training_rhythm: Dumbbell,
  body_composition: Scale,
  activity: Activity,
  sleep_debt: BedDouble,
  stress: Zap,
}

function fmtNum(value: number | undefined, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '–'
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
}

function fmtTime(value?: string): string {
  if (!value) return '–'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '–'
  return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(d)
}

function fmtSnapshotTime(snapshot?: string): string {
  const m = (snapshot || '').match(/\/(\d{6})\.json$/)
  if (!m) return '–'
  return `${m[1].slice(0, 2)}:${m[1].slice(2, 4)}`
}

function toneColor(tone?: string): string {
  if (tone === 'good') return 'var(--green)'
  if (tone === 'attention') return 'var(--warm)'
  return 'var(--t2)'
}

function signalColor(card: HealthCard): string {
  if (card.key === 'training_load') {
    const ratio = Number(card.raw_value ?? card.value)
    if (ratio > 1.35) return 'var(--warm)'
    if (ratio >= 0.75) return 'var(--green)'
    return 'var(--t3)'
  }
  if (card.key === 'sleep_debt') {
    const hours = Number(card.raw_value ?? 0)
    if (hours > 8) return 'var(--warm)'
    return 'var(--green)'
  }
  if (card.key === 'daily_strain') {
    const points = Number(card.raw_value ?? card.value)
    if (points >= 160) return 'var(--warm)'
    if (points >= 35) return 'var(--green)'
    return 'var(--t3)'
  }
  if (card.key === 'activity') return card.score >= 55 ? 'var(--green)' : 'var(--t3)'
  if (card.key === 'body_composition') {
    if (card.score >= 80) return 'var(--green)'
    if (card.score >= 65) return 'var(--warm)'
    return 'var(--red)'
  }
  if (card.score >= 65) return 'var(--green)'
  if (card.score >= 40) return 'var(--warm)'
  return 'var(--red)'
}

function loadPosition(ratio: number | undefined): number {
  const value = Number(ratio || 1)
  return Math.max(0, Math.min(100, ((value - 0.4) / 1.2) * 100))
}

function debtPosition(hours: number | undefined): number {
  const value = Number(hours || 0)
  return Math.max(0, Math.min(100, (value / 14) * 100))
}

function scoreZones(card: HealthCard): { redEnd: number; greenStart: number; strongStart: number; midLabel: string; strongLabel: string } {
  if (card.key === 'body_battery') return { redEnd: 35, greenStart: 50, strongStart: 75, midLabel: 'brauchbar', strongLabel: 'voll' }
  return { redEnd: 35, greenStart: 60, strongStart: 75, midLabel: 'bereit', strongLabel: 'hoch' }
}

function scoreColor(score?: number): string {
  if (score === undefined || Number.isNaN(score)) return 'var(--warm)'
  if (score >= 70) return 'var(--green)'
  if (score >= 45) return 'var(--warm)'
  return 'var(--warm)'
}

function balanceColor(value?: number): string {
  if (value === undefined || Number.isNaN(value)) return 'var(--warm)'
  if (value >= 0.92 && value <= 1.15) return 'var(--green)'
  if (value >= 0.8 && value <= 1.25) return 'var(--warm)'
  return '#ef4444'
}

function balancePosition(value: number | undefined): number {
  const current = Number(value || 1)
  return Math.max(0, Math.min(100, ((current - 0.6) / 0.7) * 100))
}

function curveColor(window: { kind: string; tone?: string }): string {
  if (window.tone === 'good' || window.kind === 'focus' || window.kind === 'training') return 'var(--green)'
  if (window.tone === 'attention' || window.kind === 'dip') return 'var(--warm)'
  return 'var(--t3)'
}

function timeMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return Math.min(1440, Math.max(0, hours * 60 + minutes))
}

function currentDayWindow<T extends { start: string; end: string }>(windows: T[]): T | null {
  const now = new Date()
  const current = now.getHours() * 60 + now.getMinutes()
  return windows.find(window => {
    const start = timeMinutes(window.start)
    const end = timeMinutes(window.end)
    if (start === null || end === null) return false
    if (end <= start) return current >= start || current < end
    return current >= start && current < end
  }) || null
}

function activeWindowTip(window: { kind: string; label: string; detail: string } | null): string {
  if (!window) return ''
  if (window.kind === 'focus') return `Jetzt ist ${window.label}: guter Slot für konzentrierte Arbeit, Entscheidungen und saubere Umsetzung. Keine Nebenkriegsschauplätze stapeln.`
  if (window.kind === 'training') return `Jetzt ist ${window.label}: wenn Training passt, dann kurz, sauber und bewusst dosiert.`
  if (window.kind === 'dip') return `Jetzt ist ${window.label}: Tempo rausnehmen, essen, Wasser, kleine Aufgaben statt schwerer Entscheidungen.`
  return `Jetzt ist ${window.label}: ${window.detail}`
}

function rawValue(card: HealthCard): string {
  if (card.raw_value === undefined || card.raw_value === null || Number.isNaN(card.raw_value)) return ''
  const digits = card.key === 'training_load' ? 2 : card.key === 'sleep_debt' || card.key === 'body_composition' ? 1 : 0
  const sign = card.key === 'sleep_debt' ? '-' : ''
  return `${sign}${fmtNum(card.raw_value, digits)}${card.raw_unit ? ` ${card.raw_unit}` : ''}`
}

function cardValue(card: HealthCard): string {
  if (card.key === 'sleep_debt') return rawValue(card) || '0 h'
  if (card.key === 'training_load') return rawValue(card) || `${fmtNum(card.value, 2)}×`
  if (card.key === 'training_rhythm') {
    if (card.raw_value === undefined || card.raw_value === null || Number.isNaN(card.raw_value)) return card.status || 'unklar'
    return Number(card.raw_value) === 0 ? 'heute' : `${fmtNum(card.raw_value, 0)} Tg`
  }
  if (card.key === 'heart_rate' && (!card.value || card.status === 'fehlt')) return card.status || '–'
  if (card.key === 'body_composition') return `${fmtNum(card.value, 1)}${card.unit ? ` ${card.unit}` : ''}`
  if (card.key === 'daily_strain' || card.key === 'activity') return `${fmtNum(card.score, 0)}%`
  if (card.unit === '/100') return `${fmtNum(card.value, 0)}/100`
  return `${fmtNum(card.value, 0)}${card.unit ? ` ${card.unit}` : ''}`
}

function trainingLoadGuidance(dashboard?: HealthDashboard): { target: string; recommendation: string; detail: string } | null {
  const load = dashboard?.training_context?.load_balance
  if (!load) return null
  const idealMin = load.zones?.ideal_min ?? 0.9
  const idealMax = load.zones?.ideal_max ?? 1.15
  const mode = load.mode || dashboard?.training_context?.target_mode?.label || 'Erhalten'
  let recommendation = 'Halten und nach Tagesform dosieren.'
  if (mode === 'Reiz aufbauen') recommendation = 'Kurzen Qualitätsreiz setzen, nicht wild nachholen.'
  else if (mode === 'Schwer trainieren') recommendation = 'Schwer möglich, Volumen sauber begrenzen.'
  else if (mode === 'Last senken') recommendation = 'Last reduzieren oder Technik/Mobility wählen.'
  else if (mode === 'Überreiz erlaubt') recommendation = 'Überreiz nur bewusst und kurz setzen.'
  else if (mode === 'Aufladen') recommendation = 'Regeneration vor zusätzlicher Last.'
  return {
    target: `Ziel ${fmtNum(idealMin, 2)}–${fmtNum(idealMax, 2)}×`,
    recommendation,
    detail: load.detail,
  }
}

function cardExplanation(card: HealthCard, dashboard?: HealthDashboard): string {
  if (card.key === 'training_load') {
    const guidance = trainingLoadGuidance(dashboard)
    if (guidance) return `${guidance.target}. ${guidance.recommendation} ${guidance.detail}`
    return 'Vergleicht die aktuelle Wochenlast mit deinem normalen Trainingsniveau. Um 1,0 ist nahe an deiner Basis.'
  }
  if (card.detail) return card.detail
  if (card.key === 'body_battery') return 'Zeigt, wie viel körperlicher Puffer heute noch da ist. Schlaf, HRV, Puls und Tagesbelastung fließen zusammen.'
  if (card.key === 'daily_strain') return 'Zeigt, wie viel Reiz heute schon auf dem System liegt. Höher ist nicht automatisch besser, sondern braucht Kontext.'
  if (card.key === 'activity') return 'Grundaktivität meint Schritte und leichte Bewegung. Das ist Erholungspuffer, kein harter Trainingsreiz.'
  if (card.key === 'body_composition') return 'Körperziel liest Gewicht, KFA und Muskelmasse als Verlauf. Das ist Cut-Schutz, keine Tagesstrafe.'
  if (card.key === 'sleep_debt') return 'Zeigt angesammelte Schlafschuld. Je höher der Wert, desto mehr sollte Schlaf heute Priorität bekommen.'
  return 'Kurze Einordnung dieses Signals aus den aktuellen Health-Daten.'
}

function buildDaySignal(dashboard: HealthDashboard): { label: string; value: string; detail: string; status?: string; score?: number; balance?: number } {
  if (dashboard.compass?.balance) {
    const balance = dashboard.compass.balance
    return {
      label: 'Tagesbalance',
      value: `${fmtNum(balance.value, 2)}×`,
      status: balance.label,
      detail: balance.detail,
      score: dashboard.compass.score,
      balance: balance.value,
    }
  }
  if (dashboard.compass) {
    return {
      label: 'Tagesform',
      value: `${Math.round(dashboard.compass.score)}%`,
      status: dashboard.compass.label,
      detail: dashboard.compass.detail,
      score: dashboard.compass.score,
    }
  }
  const score = Number(dashboard.scores.performance || 0)
  return {
    label: 'Tagesform',
    value: score ? `${Math.round(score)}%` : 'okay',
    status: dashboard.decision?.label || 'Heute',
    detail: dashboard.decision?.detail || 'Normal planen und auf Körpersignale achten.',
    score: score || undefined,
  }
}

export default function MobileHealth({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<HealthState | null>(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY)
      return cached ? JSON.parse(cached) as HealthState : null
    } catch {
      return null
    }
  })
  const [loading, setLoading] = useState(false)
  const [openCardKey, setOpenCardKey] = useState<string | null>(null)
  const [swipeStart, setSwipeStart] = useState<{ x: number; y: number } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/health/state')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.dashboard) return
        const next = { ...(d as HealthState), received_at: new Date().toISOString() }
        setState(next)
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)) } catch {}
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    document.title = 'Health'
    load()
    const t = setInterval(load, 300_000)
    return () => clearInterval(t)
  }, [load])

  const dashboard = state?.dashboard
  const signal = useMemo(() => dashboard ? buildDaySignal(dashboard) : null, [dashboard])
  const activeWindow = useMemo(() => currentDayWindow(dashboard?.day_curve || []), [dashboard])
  const statusCards = useMemo(() => {
    const cards = dashboard?.cards || []
    return ['readiness', 'body_battery', 'heart_rate', 'daily_strain', 'training_rhythm', 'training_load', 'body_composition', 'activity', 'sleep_debt']
      .map(key => cards.find(c => c.key === key))
      .filter(Boolean) as HealthCard[]
  }, [dashboard])
  const facts = dashboard ? [
    { label: 'Schlaf', value: dashboard.features.sleep_hours === undefined ? '–' : `${fmtNum(dashboard.features.sleep_hours, 1)}h`, tone: (dashboard.features.sleep_hours || 0) >= 7 ? 'good' : undefined },
    { label: 'HRV', value: dashboard.features.hrv_ms === undefined ? '–' : `${fmtNum(dashboard.features.hrv_ms)} ms`, tone: (dashboard.features.hrv_ms || 0) >= (dashboard.baselines.hrv_median || 0) ? 'good' : undefined },
    ...(dashboard.features.resting_hr !== undefined ? [{ label: 'Ruhepuls', value: `${fmtNum(dashboard.features.resting_hr)} bpm`, tone: dashboard.lifestyle_context?.pulse?.status === 'ruhig' ? 'good' : dashboard.lifestyle_context?.pulse?.status === 'erhöht' || dashboard.lifestyle_context?.pulse?.status === 'hoch' ? 'attention' : undefined }] : []),
    { label: 'Schritte', value: dashboard.features.steps === undefined ? '–' : fmtNum(dashboard.features.steps), tone: (dashboard.features.steps || 0) >= 7000 ? 'good' : undefined },
    ...(dashboard.features.workout_count ? [{ label: 'Training', value: `${fmtNum(dashboard.features.workout_min, 0)} min`, tone: 'good' }] : []),
    ...(dashboard.lifestyle_context?.training_rhythm?.label ? [{ label: 'Trainingstakt', value: dashboard.lifestyle_context.training_rhythm.label, tone: dashboard.lifestyle_context.training_rhythm.status === 'wieder dran' ? 'good' : undefined }] : []),
    ...(dashboard.lifestyle_context?.nutrition?.status ? [{ label: 'Protein', value: dashboard.lifestyle_context.nutrition.protein_g ? `${fmtNum(dashboard.lifestyle_context.nutrition.protein_g)} g` : dashboard.lifestyle_context.nutrition.status, tone: dashboard.lifestyle_context.nutrition.status === 'Protein sicher' ? 'good' : undefined }] : []),
    ...(dashboard.lifestyle_context?.caffeine?.logged ? [{ label: 'Koffein', value: dashboard.lifestyle_context.caffeine.mg ? `${fmtNum(dashboard.lifestyle_context.caffeine.mg)} mg` : dashboard.lifestyle_context.caffeine.status, tone: dashboard.lifestyle_context.caffeine.status === 'hoch' ? 'attention' : undefined }] : []),
    ...(dashboard.scores.training_load_ratio ? [{ label: 'Wochenlast', value: `${fmtNum(dashboard.scores.training_load_ratio, 2)}×` }] : []),
    ...(dashboard.body_composition?.current?.body_fat_pct ? [{ label: 'Körperziel', value: `${fmtNum(dashboard.body_composition.current.body_fat_pct, 1)}%`, tone: dashboard.body_composition.status === 'Muskel gehalten' ? 'good' : undefined }] : []),
    ...(dashboard.sleep_plan?.tonight_h ? [{ label: 'Bedarf', value: `${fmtNum(dashboard.sleep_plan.tonight_h, 1)}h`, tone: dashboard.sleep_plan.tonight_h > 9 ? 'attention' : undefined }] : []),
    ...(dashboard.sleep_plan?.schedule?.bedtime ? [{ label: 'Bettziel', value: dashboard.sleep_plan.schedule.bedtime, tone: dashboard.sleep_plan.schedule.is_late ? 'attention' : 'good' }] : []),
    ...(dashboard.sleep_plan?.schedule?.wake_target ? [{ label: 'Aufstehen', value: dashboard.sleep_plan.schedule.wake_target }] : []),
  ] : []

  return (
    <div style={{
      ...(embedded ? { position: 'absolute' as const, inset: 0 } : { height: '100dvh' }),
      background: 'var(--bg)',
      color: 'var(--t1)',
      display: 'flex',
      flexDirection: 'column',
    }}
      onPointerDown={e => setSwipeStart({ x: e.clientX, y: e.clientY })}
      onPointerUp={e => {
        if (!embedded || !swipeStart) return
        const dx = e.clientX - swipeStart.x
        const dy = e.clientY - swipeStart.y
        setSwipeStart(null)
        if (dx < -70 && Math.abs(dy) < 55) window.dispatchEvent(new CustomEvent('deck:toggleHealth'))
      }}
      onPointerCancel={() => setSwipeStart(null)}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1px)',
          paddingBottom: 5,
          paddingLeft: 20,
          paddingRight: 12,
          background: 'var(--bg)',
          borderBottom: '1px solid var(--mobile-chrome-border)',
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1, fontSize: 13, lineHeight: 1.1, color: 'var(--t3)', letterSpacing: '0.02em' }}>Health</div>
        <button
          onClick={load}
          disabled={loading}
          aria-label="Health neu laden"
          style={{
            width: 34,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: loading ? 'var(--warm)' : 'var(--t3)',
            background: 'transparent',
            border: 'none',
            padding: 0,
          }}
        >
          <RefreshCw size={19} strokeWidth={1.8} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch', padding: '16px 14px 24px' }}>
        {!dashboard || !signal ? (
          <div style={{ padding: '18px 4px', fontSize: 13, color: 'var(--t3)' }}>{loading ? 'lade…' : 'keine Health Daten'}</div>
        ) : (
          <>
            <section style={{ padding: '2px 2px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Heute</div>
                  <div style={{ marginTop: 4, fontFamily: 'var(--font-heading)', fontSize: 34, lineHeight: 1, color: 'var(--t1)' }}>{signal.label}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 38, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: signal.balance !== undefined ? balanceColor(signal.balance) : scoreColor(signal.score) }}>{signal.value}</div>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.25, color: 'var(--t3)' }}>
                {dashboard.data_quality?.label || 'Export'} · {fmtTime(dashboard.latest_snapshot_at) !== '–' ? fmtTime(dashboard.latest_snapshot_at) : fmtSnapshotTime(dashboard.features.snapshot)}
                {dashboard.training_context?.target_mode?.label ? ` · ${dashboard.training_context.target_mode.label}` : ''}
                {activeWindow?.label ? ` · Jetzt: ${activeWindow.label}` : ''}
              </div>
            </section>

            {dashboard.coach?.detail && (
              <section style={{ borderRadius: 8, background: 'color-mix(in srgb, var(--bg-2) 62%, transparent)', border: '1px solid var(--mobile-chrome-border)', padding: '13px 14px', marginBottom: 14 }}>
                <div style={{ fontSize: 15, lineHeight: 1.4, color: 'var(--t1)' }}>
                  {signal.balance !== undefined ? `${signal.value} ${signal.status || ''}: ${signal.detail} ${dashboard.coach.detail}` : dashboard.coach.detail}
                </div>
                {activeWindow && (
                  <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--mobile-chrome-border)', fontSize: 13, lineHeight: 1.35, color: 'var(--t2)' }}>
                    {activeWindowTip(activeWindow)}
                  </div>
                )}
                {dashboard.coach.facts && dashboard.coach.facts.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.25, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {dashboard.coach.facts.join(' · ')}
                  </div>
                )}
              </section>
            )}

            <section style={{ borderTop: '1px solid var(--mobile-chrome-border)', borderBottom: '1px solid var(--mobile-chrome-border)', marginBottom: 17 }}>
              {facts.map((fact, idx) => (
                <div key={fact.label} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minHeight: 36, borderTop: idx === 0 ? 'none' : '1px solid var(--mobile-chrome-border)' }}>
                  <span style={{ fontSize: 14, color: 'var(--t2)' }}>{fact.label}</span>
                  <span style={{ fontSize: 14, color: toneColor(fact.tone), fontVariantNumeric: 'tabular-nums' }}>{fact.value}</span>
                </div>
              ))}
            </section>

            {statusCards.length > 0 && (
              <section style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Kernsignale</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {signal.balance !== undefined && (
                    <div style={{ borderRadius: 8, background: 'color-mix(in srgb, var(--bg-2) 52%, transparent)', border: '1px solid var(--mobile-chrome-border)', padding: '11px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
                            <span style={{ fontSize: 15, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Tagesbalance</span>
                            {signal.status && <span style={{ fontSize: 12, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{signal.status}</span>}
                          </div>
                        </div>
                        <div style={{ fontSize: 15, color: 'var(--t1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{signal.value}</div>
                      </div>
                      <div style={{ marginTop: 9 }}>
                        <div style={{ position: 'relative', height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
                          <div style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 999, background: 'color-mix(in srgb, var(--green) 24%, transparent)', left: `${balancePosition(0.92)}%`, width: `${balancePosition(1.08) - balancePosition(0.92)}%` }} />
                          <div style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 999, background: 'color-mix(in srgb, var(--warm) 18%, transparent)', left: `${balancePosition(1.08)}%`, width: `${balancePosition(1.2) - balancePosition(1.08)}%` }} />
                          <div style={{ position: 'absolute', top: -2, bottom: -2, width: 1, left: `${balancePosition(1.0)}%`, background: 'color-mix(in srgb, var(--t2) 70%, transparent)' }} />
                          <div style={{ position: 'absolute', top: '50%', width: 10, height: 10, borderRadius: 999, transform: 'translate(-50%, -50%)', border: '1px solid rgba(0,0,0,0.3)', left: `${balancePosition(signal.balance)}%`, background: balanceColor(signal.balance) }} />
                        </div>
                        <div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
                          <span>unter</span><span>1,0</span><span>über</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {statusCards.map(card => {
                    const Icon = ICONS[card.key] || Activity
                    const color = signalColor(card)
                    const bar = Math.max(4, Math.min(100, card.key === 'sleep_debt' ? (Number(card.raw_value || 0) / 14) * 100 : card.score))
                    const isOpen = openCardKey === card.key
                    const trainingGuidance = card.key === 'training_load' ? trainingLoadGuidance(dashboard) : null
                    const activityRaw = card.key === 'activity' && dashboard?.features.steps !== undefined
                      ? `${fmtNum(dashboard.features.steps)} Schritte`
                      : ''
                    return (
                      <div
                        key={card.key}
                        role="button"
                        tabIndex={0}
                        onClick={() => setOpenCardKey(prev => prev === card.key ? null : card.key)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpenCardKey(prev => prev === card.key ? null : card.key) }}
                        style={{ borderRadius: 8, background: 'color-mix(in srgb, var(--bg-2) 52%, transparent)', border: '1px solid var(--mobile-chrome-border)', padding: '11px 12px', WebkitTapHighlightColor: 'transparent' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Icon size={20} strokeWidth={1.8} style={{ color: 'var(--t3)', flexShrink: 0 }} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
                              <span style={{ fontSize: 15, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.label}</span>
                              <span style={{ fontSize: 12, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.status}</span>
                              {activityRaw && <span style={{ fontSize: 12, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activityRaw}</span>}
                            </div>
                          </div>
                          <div style={{ fontSize: 15, color: 'var(--t1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{cardValue(card)}</div>
                        </div>
                        {card.key === 'training_load' ? (
                          <div style={{ marginTop: 9 }}>
                            <div style={{ position: 'relative', height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
                              <div style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 999, background: 'color-mix(in srgb, var(--green) 25%, transparent)', left: `${loadPosition(0.9)}%`, width: `${loadPosition(1.15) - loadPosition(0.9)}%` }} />
                              <div style={{ position: 'absolute', top: -2, bottom: -2, width: 1, left: `${loadPosition(1.0)}%`, background: 'color-mix(in srgb, var(--t2) 70%, transparent)' }} />
                              <div style={{ position: 'absolute', top: '50%', width: 10, height: 10, borderRadius: 999, transform: 'translate(-50%, -50%)', border: '1px solid rgba(0,0,0,0.3)', left: `${loadPosition(card.raw_value ?? card.value)}%`, background: color }} />
                            </div>
                            <div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
                              <span>unter</span><span>1,0</span><span>über</span>
                            </div>
                            {trainingGuidance && (
                              <div style={{ marginTop: 7, display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, lineHeight: 1.2, color: 'var(--t3)' }}>
                                <span>{trainingGuidance.target}</span>
                                <span style={{ color, textAlign: 'right' }}>{trainingGuidance.recommendation}</span>
                              </div>
                            )}
                          </div>
                        ) : card.key === 'sleep_debt' ? (
                          <div style={{ marginTop: 9 }}>
                            <div style={{ position: 'relative', height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
                              <div style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 999, background: 'color-mix(in srgb, var(--green) 22%, transparent)', left: 0, width: `${debtPosition(3)}%` }} />
                              <div style={{ position: 'absolute', top: -2, bottom: -2, width: 1, left: `${debtPosition(3)}%`, background: 'color-mix(in srgb, var(--t2) 70%, transparent)' }} />
                              <div style={{ position: 'absolute', top: '50%', width: 10, height: 10, borderRadius: 999, transform: 'translate(-50%, -50%)', border: '1px solid rgba(0,0,0,0.3)', left: `${debtPosition(card.raw_value ?? card.value)}%`, background: color }} />
                            </div>
                            <div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
                              <span>0</span><span>3h</span><span>hoch</span>
                            </div>
                          </div>
                        ) : card.key === 'readiness' || card.key === 'body_battery' ? (
                          <div style={{ marginTop: 9 }}>
                            {(() => {
                              const zones = scoreZones(card)
                              const dot = Math.max(0, Math.min(100, card.score))
                              return (
                                <>
                                  <div style={{ position: 'relative', height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${zones.redEnd}%`, background: 'rgba(239,68,68,0.22)' }} />
                                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${zones.redEnd}%`, width: `${zones.greenStart - zones.redEnd}%`, background: 'color-mix(in srgb, var(--warm) 25%, transparent)' }} />
                                    <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${zones.greenStart}%`, width: `${100 - zones.greenStart}%`, background: 'color-mix(in srgb, var(--green) 22%, transparent)' }} />
                                  </div>
                                  <div style={{ position: 'relative', height: 0 }}>
                                    <div style={{ position: 'absolute', top: -7.5, width: 10, height: 10, borderRadius: 999, transform: 'translateX(-50%)', border: '1px solid rgba(0,0,0,0.3)', left: `${dot}%`, background: color }} />
                                  </div>
                                  <div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t3)' }}>
                                    <span>&lt;35</span><span>{zones.greenStart} {zones.midLabel}</span><span>{zones.strongStart} {zones.strongLabel}</span>
                                  </div>
                                </>
                              )
                            })()}
                          </div>
                        ) : (
                          <div style={{ marginTop: 9, height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                            <div style={{ width: `${bar}%`, height: '100%', borderRadius: 999, background: color }} />
                          </div>
                        )}
                        {isOpen && (
                          <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--mobile-chrome-border)', fontSize: 13, lineHeight: 1.35, color: 'var(--t2)' }}>
                            {cardExplanation(card, dashboard)}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {(dashboard.day_curve || []).length > 0 && (
              <section style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>Tagesfenster</div>
                <div style={{ borderTop: '1px solid var(--mobile-chrome-border)', borderBottom: '1px solid var(--mobile-chrome-border)' }}>
                  {(dashboard.day_curve || []).map((window, idx) => (
                    <div
                      key={`${window.kind}-${window.start}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '46px minmax(0, 1fr)',
                        columnGap: 13,
                        alignItems: 'center',
                        padding: '10px 9px 10px 0',
                        borderTop: idx === 0 ? 'none' : '1px solid var(--mobile-chrome-border)',
                        borderRight: activeWindow === window ? `2px solid ${curveColor(window)}` : '2px solid transparent',
                        background: activeWindow === window ? 'color-mix(in srgb, var(--bg-2) 34%, transparent)' : 'transparent',
                      }}
                    >
                      <div style={{ color: curveColor(window), fontSize: 12, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em' }}>
                        <div>{window.start}</div>
                        <div style={{ marginTop: 3, opacity: 0.7 }}>{window.end}</div>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 15, lineHeight: 1.2, color: activeWindow === window ? 'var(--t1)' : 'var(--t2)' }}>{window.label}</div>
                        <div style={{ marginTop: 3, fontSize: 12, lineHeight: 1.25, color: 'var(--t3)' }}>{window.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(state.entries || []).length > 0 && (
              <section>
                <div style={{ fontSize: 12, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 7 }}>Heute geloggt</div>
                <div style={{ borderTop: '1px solid var(--mobile-chrome-border)' }}>
                  {(state.entries || []).slice(-4).map((entry, idx) => (
                    <div key={`${entry.time}-${idx}`} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--mobile-chrome-border)', fontSize: 13 }}>
                      <span style={{ width: 42, flexShrink: 0, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>{entry.time}</span>
                      <span style={{ minWidth: 0, color: 'var(--t2)' }}>{entry.text}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
