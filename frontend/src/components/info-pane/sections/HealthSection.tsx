import { useCallback, useEffect, useState } from 'react'
import { Activity, Battery, BedDouble, ChevronRight, Dumbbell, HeartPulse, RefreshCw, Scale, Zap } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

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
type HealthRecommendation = { title: string; detail: string; source?: string }

type HealthDashboard = {
  date: string
  generated_at?: string
  latest_snapshot_at?: string
  latest_snapshot_file?: string
  sleep_need_h: number
  sleep_plan?: {
    base_h: number
    tonight_h: number
    debt_extra_h?: number
    strain_extra_h?: number
    recovery_extra_h?: number
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
    exercise_min?: number
    active_kcal?: number
    workout_count?: number
    workout_min?: number
    snapshot?: string
  }
  baselines: { hrv_median?: number; rhr_median?: number }
  reta: { label: string; dose?: string }
  scores: Record<string, number>
  training_context?: {
    readiness?: { score: number; status: string }
    load_balance?: { ratio: number; position: number; status: string; direction: string; detail: string; can_overreach: boolean; mode: string; zones?: { ideal_min?: number; ideal_max?: number } }
    target_mode?: { label: string; allows_overreach: boolean }
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
    previous?: { date?: string; weight_kg?: number; body_fat_pct?: number; skeletal_muscle_kg?: number }
    delta?: { weight_kg?: number; body_fat_pct?: number; fat_mass_kg?: number; skeletal_muscle_kg?: number }
    status: string
    score: number
    detail: string
  }
  coach?: { label: string; detail: string; facts?: string[]; deterministic?: boolean; llm_role?: string }
  data_quality?: { label: string; detail: string; confidence: number }
  compass?: { label: string; detail: string; score: number; balance?: { value: number; label: string; detail: string; zone: string } }
  cards: HealthCard[]
  decision: { label: string; detail: string }
  history: { date: string; sleep_hours?: number; hrv_ms?: number; resting_hr?: number }[]
}

type HealthState = {
  date: string
  dashboard: HealthDashboard
  entries: HealthEntry[]
  recommendations?: HealthRecommendation[]
  received_at?: string
  summary: { available?: boolean; stale?: boolean; recommendation?: string }
}

const ICONS: Record<string, typeof Activity> = {
  sleep_debt: BedDouble,
  sleep_quality: BedDouble,
  recovery: HeartPulse,
  heart_rate: HeartPulse,
  readiness: Activity,
  body_battery: Battery,
  stress: Zap,
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

function scoreColor(card: HealthCard): string {
  if (card.key === 'stress') {
    if (card.value <= 60) return 'var(--green)'
    if (card.value <= 80) return 'var(--warm)'
    return '#ef4444'
  }
  if (card.key === 'training_load') {
    const ratio = Number(card.raw_value ?? card.value)
    if (ratio > 1.55) return '#ef4444'
    if (ratio > 1.35) return 'var(--warm)'
    if (ratio >= 0.75) return 'var(--green)'
    return 'var(--t3)'
  }
  if (card.key === 'sleep_debt') {
    const hours = Number(card.raw_value ?? 0)
    if (hours > 10) return '#ef4444'
    if (hours > 5) return 'var(--warm)'
    return 'var(--green)'
  }
  if (card.key === 'daily_strain') {
    const points = Number(card.raw_value ?? card.value)
    if (points >= 190) return '#ef4444'
    if (points >= 160) return 'var(--warm)'
    if (points >= 35) return 'var(--green)'
    return 'var(--t3)'
  }
  if (card.key === 'activity') {
    if (card.score >= 55) return 'var(--green)'
    return 'var(--t3)'
  }
  if (card.key === 'body_composition') {
    if (card.score >= 80) return 'var(--green)'
    if (card.score >= 65) return 'var(--warm)'
    return '#ef4444'
  }
  if (card.key === 'readiness' || card.key === 'body_battery') {
    const greenStart = card.key === 'body_battery' ? 50 : 60
    if (card.score >= greenStart) return 'var(--green)'
    if (card.score >= 35) return 'var(--warm)'
    return '#ef4444'
  }
  if (card.score >= 70) return 'var(--green)'
  if (card.score >= 45) return 'var(--warm)'
  return '#ef4444'
}

function compassColor(score?: number): string {
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

function factColor(tone?: string): string {
  if (tone === 'good') return 'var(--green)'
  if (tone === 'attention') return 'var(--warm)'
  return 'var(--t2)'
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
  if (card.key === 'body_battery') {
    return { redEnd: 35, greenStart: 50, strongStart: 75, midLabel: 'brauchbar', strongLabel: 'voll' }
  }
  return { redEnd: 35, greenStart: 60, strongStart: 75, midLabel: 'tragfähig', strongLabel: 'hoch' }
}

function metricUnit(card: HealthCard): string {
  if (card.unit === '/100') return ''
  return card.unit
}

function cardValue(card: HealthCard): string {
  if (card.key === 'sleep_debt') return rawValue(card) || '0 h'
  if (card.key === 'training_load' && card.raw_value !== undefined) return rawValue(card)
  if (card.key === 'training_rhythm') {
    if (card.raw_value === undefined || card.raw_value === null || Number.isNaN(card.raw_value)) return card.status || 'unklar'
    return Number(card.raw_value) === 0 ? 'heute' : `${fmtNum(card.raw_value, 0)} Tg`
  }
  if (card.key === 'heart_rate' && (!card.value || card.status === 'fehlt')) return card.status || '–'
  if (card.key === 'body_composition') return `${fmtNum(card.value, 1)}${card.unit ? ` ${card.unit}` : ''}`
  if (card.key === 'daily_strain' || card.key === 'activity') return `${fmtNum(card.score, 0)}%`
  const value = fmtNum(card.value, 0)
  if (card.unit === '/100') return `${value}/100`
  const unit = metricUnit(card)
  return unit ? `${value} ${unit}` : value
}

function rawValue(card: HealthCard): string {
  if (card.raw_value === undefined || card.raw_value === null || Number.isNaN(card.raw_value)) return ''
  const digits = card.key === 'training_load' ? 2 : card.key === 'sleep_debt' || card.key === 'body_composition' ? 1 : 0
  const sign = card.key === 'sleep_debt' ? '-' : ''
  const unit = card.raw_unit || ''
  return `${sign}${fmtNum(card.raw_value, digits)}${unit ? ` ${unit}` : ''}`
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

function buildDaySignal(dashboard: HealthDashboard | undefined): { label: string; value: string; detail: string; status?: string; score?: number; balance?: number } {
  if (!dashboard) return { label: '', value: '', detail: '' }
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
      value: `${dashboard.compass.score}%`,
      status: dashboard.compass.label,
      detail: dashboard.compass.detail,
      score: dashboard.compass.score,
    }
  }
  const scores = dashboard.scores || {}
  const debt = Number(scores.sleep_debt_h || 0)
  const bodyBattery = Number(scores.body_battery || 0)
  const recovery = Number(scores.recovery || 0)
  const loadRatio = Number(scores.training_load_ratio || 1)
  const performance = Number(scores.performance || 0)
  if (bodyBattery < 45 && debt > 8) {
    return {
      label: 'Tagesform',
      value: performance ? `${Math.round(performance)}%` : 'knapp',
      status: 'Nicht leerziehen',
      detail: 'Kurzer Reiz ist okay, aber Hauptziel ist Akku stabilisieren und Schlafschuld zurückzahlen.',
      score: performance || undefined,
    }
  }
  if (recovery < 55) {
    return {
      label: 'Tagesform',
      value: performance ? `${Math.round(performance)}%` : 'vorsichtig',
      status: 'Regeneration',
      detail: 'Training nur wenn es dich lockert. Kein Volumen, keine Lastspitze.',
      score: performance || undefined,
    }
  }
  if (loadRatio < 0.85) {
    return {
      label: 'Tagesform',
      value: performance ? `${Math.round(performance)}%` : 'tragfähig',
      status: 'Reiz aufbauen',
      detail: 'Die Wochenlast liegt links der Mitte. Qualität setzen, aber nicht aus Müdigkeit überziehen.',
      score: performance || undefined,
    }
  }
  return {
    label: 'Tagesform',
    value: performance ? `${Math.round(performance)}%` : 'okay',
    status: dashboard.decision?.label || 'Training möglich',
    detail: dashboard.decision?.detail || 'Normal planen, solange Energie und Magen mitspielen.',
    score: performance || undefined,
  }
}

function trainingLoadGuidance(dashboard?: HealthDashboard): { target: string; recommendation: string; detail: string } | null {
  const load = dashboard?.training_context?.load_balance
  if (!load) return null
  const idealMin = load.zones?.ideal_min ?? 0.9
  const idealMax = load.zones?.ideal_max ?? 1.15
  const mode = load.mode || dashboard?.training_context?.target_mode?.label || 'Erhalten'
  let recommendation = 'Halten und nach Tagesform dosieren.'
  if (mode === 'Reiz aufbauen') recommendation = 'Kurzen Qualitätsreiz setzen.'
  else if (mode === 'Schwer trainieren') recommendation = 'Schwer möglich.'
  else if (mode === 'Last senken') recommendation = 'Last reduzieren.'
  else if (mode === 'Überreiz erlaubt') recommendation = 'Überreiz bewusst kurz.'
  else if (mode === 'Aufladen') recommendation = 'Regeneration zuerst.'
  return {
    target: `Ziel ${fmtNum(idealMin, 2)}–${fmtNum(idealMax, 2)}×`,
    recommendation,
    detail: load.detail,
  }
}

export function HealthSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <HealthWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <HealthInlineSection mobile={mobile} />
}

function HealthWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Health im Workspace öffnen">
        <HeartPulse className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Health</span>
      </button>
    </div>
  )
}

function HealthInlineSection({ mobile }: { mobile?: boolean }) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:healthOpen') !== '0' } catch { return true }
  })
  const [state, setState] = useState<HealthState | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/health/state')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.dashboard) setState({ ...(d as HealthState), received_at: new Date().toISOString() }) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { if (open) load() }, [open, load])
  useEffect(() => {
    if (!open) return
    const id = setInterval(load, 300000)
    return () => clearInterval(id)
  }, [open, load])
  useEffect(() => { try { localStorage.setItem('infopane:healthOpen', open ? '1' : '0') } catch {} }, [open])

  const dashboard = state?.dashboard
  const cards = dashboard?.cards || []
  const signalOrder = ['readiness', 'body_battery', 'heart_rate', 'daily_strain', 'training_rhythm', 'training_load', 'body_composition', 'activity', 'sleep_debt']
  const statusCards = signalOrder.map(key => cards.find(c => c.key === key)).filter(Boolean) as HealthCard[]
  const daySignal = buildDaySignal(dashboard)
  const dayCurve = dashboard?.day_curve || []
  const activeWindow = currentDayWindow(dayCurve)
  const healthFacts: { label: string; value: string; tone?: string }[] = dashboard ? [
    { label: 'Schlaf', value: `${fmtNum(dashboard.features.sleep_hours, 1)}h`, tone: (dashboard.features.sleep_hours || 0) >= 7 ? 'good' : 'neutral' },
    { label: 'HRV', value: `${fmtNum(dashboard.features.hrv_ms)} ms`, tone: (dashboard.features.hrv_ms || 0) >= (dashboard.baselines.hrv_median || 0) ? 'good' : 'neutral' },
    ...(dashboard.features.resting_hr !== undefined ? [{ label: 'Ruhepuls', value: `${fmtNum(dashboard.features.resting_hr)} bpm`, tone: dashboard.lifestyle_context?.pulse?.status === 'ruhig' ? 'good' : dashboard.lifestyle_context?.pulse?.status === 'erhöht' || dashboard.lifestyle_context?.pulse?.status === 'hoch' ? 'attention' : 'neutral' }] : []),
    ...(dashboard.features.steps !== undefined ? [{ label: 'Schritte', value: fmtNum(dashboard.features.steps), tone: dashboard.features.steps >= 7000 ? 'good' : 'neutral' }] : []),
    ...(dashboard.features.workout_count ? [{ label: 'Training', value: `${fmtNum(dashboard.features.workout_min, 0)} min`, tone: 'good' }] : []),
    ...(dashboard.lifestyle_context?.training_rhythm?.label ? [{ label: 'Trainingstakt', value: dashboard.lifestyle_context.training_rhythm.label, tone: dashboard.lifestyle_context.training_rhythm.status === 'wieder dran' ? 'good' : 'neutral' }] : []),
    ...(dashboard.lifestyle_context?.nutrition?.status ? [{ label: 'Protein', value: dashboard.lifestyle_context.nutrition.protein_g ? `${fmtNum(dashboard.lifestyle_context.nutrition.protein_g)} g` : dashboard.lifestyle_context.nutrition.status, tone: dashboard.lifestyle_context.nutrition.status === 'Protein sicher' ? 'good' : 'neutral' }] : []),
    ...(dashboard.lifestyle_context?.caffeine?.logged ? [{ label: 'Koffein', value: dashboard.lifestyle_context.caffeine.mg ? `${fmtNum(dashboard.lifestyle_context.caffeine.mg)} mg` : dashboard.lifestyle_context.caffeine.status, tone: dashboard.lifestyle_context.caffeine.status === 'hoch' ? 'attention' : 'neutral' }] : []),
    ...(dashboard.scores.training_strain_today ? [{ label: 'Reiz', value: `${fmtNum(dashboard.scores.training_strain_today, 0)} P`, tone: 'good' }] : []),
    ...(dashboard.scores.training_load_ratio ? [{ label: 'Wochenlast roh', value: `${fmtNum(dashboard.scores.training_load_ratio, 2)}×` }] : []),
    ...(dashboard.body_composition?.current?.body_fat_pct ? [{ label: 'Körperziel', value: `${fmtNum(dashboard.body_composition.current.body_fat_pct, 1)}%`, tone: dashboard.body_composition.status === 'Muskel gehalten' ? 'good' : 'neutral' }] : []),
    ...(dashboard.scores.activity_score ? [{ label: 'Aktivität', value: `${fmtNum(dashboard.scores.activity_score, 0)}/100`, tone: dashboard.scores.activity_score >= 55 ? 'good' : 'neutral' }] : []),
    ...(dashboard.scores.sleep_debt_h ? [{ label: 'Schlafschuld', value: `-${fmtNum(dashboard.scores.sleep_debt_h, 1)}h`, tone: dashboard.scores.sleep_debt_h > 8 ? 'attention' : 'neutral' }] : []),
    ...(dashboard.sleep_plan?.tonight_h ? [{ label: 'Bedarf', value: `${fmtNum(dashboard.sleep_plan.tonight_h, 1)}h`, tone: dashboard.sleep_plan.tonight_h > 9 ? 'attention' : 'neutral' }] : []),
    ...(dashboard.sleep_plan?.schedule?.bedtime ? [{ label: 'Bettziel', value: dashboard.sleep_plan.schedule.bedtime, tone: dashboard.sleep_plan.schedule.is_late ? 'attention' : 'good' }] : []),
    ...(dashboard.sleep_plan?.schedule?.wake_target ? [{ label: 'Aufstehen', value: dashboard.sleep_plan.schedule.wake_target, tone: 'neutral' }] : []),
    ...(activeWindow?.label ? [{ label: 'Jetzt', value: activeWindow.label, tone: activeWindow.tone === 'attention' ? 'attention' : 'good' }] : []),
    ...(dashboard.training_context?.target_mode?.label ? [{ label: 'Modus', value: dashboard.training_context.target_mode.label }] : []),
  ] : []

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <HeartPulse className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)]" />
        <span className="text-[var(--t2)] font-medium">Health</span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); load() }}
            disabled={loading}
            className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer disabled:opacity-40 flex-shrink-0 transition-opacity ${loading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            title="Neu laden">
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
        <span className="flex-1" />
      </div>

      {open && (
        <div className="pb-2">
          <Guided>
            {!dashboard && (
              <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">{loading ? 'lade…' : 'keine Health Daten'}</div>
            )}

            {dashboard && (
              <>
                <div className="pl-1 pr-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="info-text-meta text-[var(--t3)]/65 uppercase tracking-[0.08em]">Heute</div>
                      <div className="info-text-meta text-[var(--t3)]/65 tabular-nums flex-shrink-0">{dashboard.data_quality?.label || 'Export'} · {fmtTime(dashboard.latest_snapshot_at) !== '–' ? fmtTime(dashboard.latest_snapshot_at) : fmtSnapshotTime(dashboard.features.snapshot)}</div>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-3 min-w-0">
                      <div className="min-w-0 flex items-baseline gap-2">
                        <span className="text-[17px] leading-snug text-[var(--t1)] truncate">{daySignal.label}</span>
                        {daySignal.status && <span className="info-text-meta text-[var(--t3)]/70 truncate">{daySignal.status}</span>}
                      </div>
                      {daySignal.value && <span className="text-[17px] leading-none tabular-nums flex-shrink-0" style={{ color: daySignal.balance !== undefined ? balanceColor(daySignal.balance) : compassColor(daySignal.score) }}>{daySignal.value}</span>}
                    </div>
                    {dashboard.coach && (
                      <div className="mt-2 rounded bg-white/[0.025] px-2 py-1.5 leading-snug">
                        <div className="info-text-body text-[var(--t2)]">
                          {daySignal.balance !== undefined ? `${daySignal.value} ${daySignal.status || ''}: ${daySignal.detail} ${dashboard.coach.detail}` : dashboard.coach.detail}
                        </div>
                        {dashboard.coach.facts && dashboard.coach.facts.length > 0 && (
                          <div className="mt-1 info-text-meta text-[var(--t3)]/60 truncate">{dashboard.coach.facts.join(' · ')}</div>
                        )}
                      </div>
                    )}
                    <div className="mt-2 divide-y divide-white/[0.06] border-y border-white/[0.06] info-text-meta text-[var(--t3)]/70">
                      {healthFacts.map(fact => (
                        <div key={fact.label} className="flex items-baseline justify-between gap-3 min-w-0 py-1">
                          <span className="truncate">{fact.label}</span>
                          <span className="tabular-nums text-right min-w-0 truncate" style={{ color: factColor(fact.tone) }}>{fact.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {dayCurve.length > 0 && (
                  <div className="pl-1 pr-3 py-1.5">
                    <div className="info-text-meta text-[var(--t3)]/65 uppercase tracking-[0.08em] mb-1.5">Tagesabschnitte</div>
                    <div className="space-y-[1px]">
                      {dayCurve.map(w => (
                        <div
                          key={`${w.kind}-${w.start}`}
                          className="grid grid-cols-[46px_minmax(0,1fr)] gap-x-3 py-[5px] pr-2 min-w-0"
                          style={{
                            borderRight: activeWindow === w ? `2px solid ${curveColor(w)}` : '2px solid transparent',
                            background: activeWindow === w ? 'color-mix(in srgb, var(--bg-2) 34%, transparent)' : 'transparent',
                          }}
                        >
                          <div className="info-text-meta tabular-nums leading-[1.05]" style={{ color: curveColor(w) }}>
                            <div>{w.start}</div>
                            <div className="mt-[3px] opacity-70">{w.end}</div>
                          </div>
                          <div className="min-w-0">
                            <div className="info-text-body leading-5 truncate" style={{ color: activeWindow === w ? 'var(--t1)' : 'var(--t2)' }}>{w.label}</div>
                            <div className="info-text-meta text-[var(--t3)]/65 leading-snug">{w.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pr-3 pl-1 py-2 space-y-1">
                  <div className="info-text-meta text-[var(--t3)]/65 uppercase tracking-[0.08em] mb-1.5">Kernsignale</div>
                  {daySignal.balance !== undefined && (
                    <div className="rounded bg-white/[0.02] px-2 py-1.5 min-h-[70px] min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <Activity className="info-icon-sm flex-shrink-0 text-[var(--t3)]" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-1.5 min-w-0">
                            <span className="info-text-body text-[var(--t2)] truncate">Tagesbalance</span>
                            {daySignal.status && <span className="info-text-meta text-[var(--t3)] truncate">{daySignal.status}</span>}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-[16px] leading-none tabular-nums text-[var(--t1)] whitespace-nowrap">{daySignal.value}</div>
                        </div>
                      </div>
                      <div className="mt-2">
                        <div className="relative h-1.5 rounded-full bg-white/[0.08]">
                          <div className="absolute top-0 bottom-0 rounded-full bg-[var(--green)]/24" style={{ left: `${balancePosition(0.92)}%`, width: `${balancePosition(1.08) - balancePosition(0.92)}%` }} />
                          <div className="absolute top-0 bottom-0 rounded-full bg-[var(--warm)]/18" style={{ left: `${balancePosition(1.08)}%`, width: `${balancePosition(1.2) - balancePosition(1.08)}%` }} />
                          <div className="absolute top-[-2px] bottom-[-2px] w-px bg-[var(--t2)]/70" style={{ left: `${balancePosition(1.0)}%` }} />
                          <div className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/30" style={{ left: `${balancePosition(daySignal.balance)}%`, background: balanceColor(daySignal.balance) }} />
                        </div>
                        <div className="mt-1 flex justify-between info-text-meta text-[var(--t3)]/55 tabular-nums">
                          <span>unter</span>
                          <span>1,0</span>
                          <span>über</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {statusCards.map(card => {
                    const Icon = ICONS[card.key] || Activity
                    const color = scoreColor(card)
                    const sleepDebtDot = debtPosition(card.raw_value ?? card.value)
                    const sleepComfortEnd = debtPosition(4)
                    const loadBalance = dashboard.training_context?.load_balance
                    const loadDot = loadPosition(loadBalance?.ratio ?? card.value)
                    const trainingGuidance = card.key === 'training_load' ? trainingLoadGuidance(dashboard) : null
                    const activityRaw = card.key === 'activity' && dashboard.features.steps !== undefined ? `${fmtNum(dashboard.features.steps)} Schritte` : ''
                    return (
                      <div key={card.key} className="rounded bg-white/[0.02] px-2 py-1.5 min-h-[70px] min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon className="info-icon-sm flex-shrink-0 text-[var(--t3)]" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span className="info-text-body text-[var(--t2)] truncate">{card.label}</span>
                              <span className="info-text-meta text-[var(--t3)] truncate">{card.status}</span>
                              {activityRaw && <span className="info-text-meta text-[var(--t3)]/55 tabular-nums truncate">{activityRaw}</span>}
                              {rawValue(card) && !['sleep_debt', 'training_load'].includes(card.key) && <span className="info-text-meta text-[var(--t3)]/55 tabular-nums truncate">{rawValue(card)}</span>}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <div className="text-[16px] leading-none tabular-nums text-[var(--t1)] whitespace-nowrap">{cardValue(card)}</div>
                          </div>
                        </div>
                        {card.key === 'sleep_debt' ? (
                          <div className="mt-2">
                            <div className="relative h-1.5 rounded-full bg-white/[0.08]">
                              <div className="absolute top-0 bottom-0 rounded-full bg-[var(--green)]/22" style={{ left: '0%', width: `${sleepComfortEnd}%` }} />
                              <div className="absolute top-[-2px] bottom-[-2px] w-px bg-[var(--t2)]/70" style={{ left: `${sleepComfortEnd}%` }} />
                              <div className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/30" style={{ left: `${sleepDebtDot}%`, background: color }} />
                            </div>
                            <div className="mt-1 flex justify-between info-text-meta text-[var(--t3)]/55 tabular-nums">
                              <span>0</span>
                              <span>4h</span>
                              <span>hoch</span>
                            </div>
                          </div>
                        ) : card.key === 'training_load' ? (
                          <div className="mt-2">
                            <div className="relative h-1.5 rounded-full bg-white/[0.08]">
                              <div className="absolute top-0 bottom-0 rounded-full bg-[var(--green)]/25" style={{ left: `${loadPosition(0.9)}%`, width: `${loadPosition(1.15) - loadPosition(0.9)}%` }} />
                              <div className="absolute top-[-2px] bottom-[-2px] w-px bg-[var(--t2)]/70 left-1/2" />
                              <div className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/30" style={{ left: `${loadDot}%`, background: color }} />
                            </div>
                            <div className="mt-1 flex justify-between info-text-meta text-[var(--t3)]/55 tabular-nums">
                              <span>unter</span>
                              <span>1,0</span>
                              <span>über</span>
                            </div>
                            {trainingGuidance && (
                              <div className="mt-1.5 flex items-start justify-between gap-2 info-text-meta leading-snug">
                                <span className="text-[var(--t3)]/65">{trainingGuidance.target}</span>
                                <span className="text-right" style={{ color }}>{trainingGuidance.recommendation}</span>
                              </div>
                            )}
                          </div>
                        ) : card.key === 'readiness' || card.key === 'body_battery' ? (
                          <div className="mt-2">
                            {(() => {
                              const zones = scoreZones(card)
                              const dot = Math.max(0, Math.min(100, card.score))
                              return (
                                <>
                                  <div className="relative h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                                    <div className="absolute inset-y-0 left-0 bg-[#ef4444]/22" style={{ width: `${zones.redEnd}%` }} />
                                    <div className="absolute inset-y-0 bg-[var(--warm)]/25" style={{ left: `${zones.redEnd}%`, width: `${zones.greenStart - zones.redEnd}%` }} />
                                    <div className="absolute inset-y-0 bg-[var(--green)]/22" style={{ left: `${zones.greenStart}%`, width: `${100 - zones.greenStart}%` }} />
                                    {[zones.redEnd, zones.greenStart, zones.strongStart].map(mark => (
                                      <div key={mark} className="absolute top-[-2px] bottom-[-2px] w-px bg-[var(--t2)]/65" style={{ left: `${mark}%` }} />
                                    ))}
                                    <div className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full border border-black/30" style={{ left: `${dot}%`, background: color }} />
                                  </div>
                                  <div className="mt-1 flex justify-between info-text-meta text-[var(--t3)]/55 tabular-nums">
                                    <span>&lt;35</span>
                                    <span>{zones.greenStart} {zones.midLabel}</span>
                                    <span>{zones.strongStart} {zones.strongLabel}</span>
                                  </div>
                                </>
                              )
                            })()}
                          </div>
                        ) : (
                          <div className="mt-2">
                            <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${Math.max(4, Math.min(100, card.key === 'stress' ? 100 - card.value : card.score))}%`, background: color }} />
                            </div>
                            <div className="mt-1 h-[14px]" />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {(state?.entries || []).length > 0 && (
                  <div className="pl-1 pr-3 pt-2">
                    <div className="info-text-meta text-[var(--t3)]/60 uppercase tracking-[0.08em] mb-1">Heute geloggt</div>
                    {(state?.entries || []).slice(-3).map((entry, idx) => (
                      <div key={`${entry.time}-${idx}`} className="flex gap-2 py-[3px] info-text-body">
                        <span className="info-text-meta text-[var(--t3)] tabular-nums w-10 flex-shrink-0">{entry.time}</span>
                        <span className="text-[var(--t2)] break-words min-w-0">{entry.text}</span>
                      </div>
                    ))}
                  </div>
                  )}

              </>
            )}
          </Guided>
        </div>
      )}
    </div>
  )
}
