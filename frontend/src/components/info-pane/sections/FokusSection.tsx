import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { playUISound } from '../../../uiSounds'

type FokusBriefingPayload = {
  today?: string
  tomorrow?: string
  generated_at?: string
  calendar_today?: string[]
  calendar_tomorrow?: string[]
  pt_today?: string[]
  pt_tomorrow?: string[]
  slots_today?: string[]
  slots_tomorrow?: string[]
  waiting_on_you?: string[]
  lead_pipeline?: string[]
  overdue_slots?: Array<{ title?: string; day_iso?: string; age_days?: number }>
  counts?: Record<string, number>
}

type FocusEntry = {
  day: 'today' | 'tomorrow'
  kind: 'calendar' | 'pt' | 'slot'
  startMin: number
  endMin: number
  timeLabel: string
  title: string
  detail: string
  dot: string
}

const CATEGORY_LABELS: Record<string, string> = {
  agent: 'Agent',
  privat: 'Privat',
  fch: 'FCH',
  'ai-workshop': 'AI Workshop',
  'ai-agent': 'AI Agent',
  'ai-beratung': 'AI Beratung',
  gecko: 'Beispielkunde',
  ptdesk: 'Personal Training',
  personal_training: 'Personal Training',
  ems: 'EMS',
  admin: 'Admin',
}

const CATEGORY_COLORS: Record<string, string> = {
  'ai-agent': '#d97a5a',
  'ai-beratung': '#e0945a',
  personal_training: '#7a9fa3',
  ptdesk: '#7a9fa3',
  ems: '#7a9fa3',
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function compactTimeRange(value: string): string {
  const fullHourRange = value.match(/^(\d{1,2}):00[–-](\d{1,2}):00$/)
  if (fullHourRange) return `${fullHourRange[1]}–${fullHourRange[2]} Uhr`
  const fullHourSingle = value.match(/^(\d{1,2}):00$/)
  if (fullHourSingle) return `${fullHourSingle[1]} Uhr`
  return value
}

function titleOf(line: string): string {
  return line
    .replace(/^\s*\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}\s*/, '')
    .replace(/^\s*\d{1,2}:\d{2}\s*/, '')
    .trim()
}

function splitSubject(raw: string): { main: string; detail: string } {
  const [body, ...parts] = raw.split(' · ')
  const details = parts.filter(part => !/^\d+\s*min$/i.test(part.trim()))
  const comma = body.indexOf(',')
  if (comma < 0) return { main: body.trim(), detail: details.map(displayCategory).join(' · ') }
  const main = body.slice(0, comma).trim()
  const detail = [body.slice(comma + 1).trim(), ...details.map(displayCategory)].filter(Boolean).join(' · ')
  return { main, detail }
}

function displayCategory(value: string): string {
  const trimmed = cleanLine(value)
  if (!trimmed) return ''
  const key = trimmed.toLowerCase()
  return CATEGORY_LABELS[key] || trimmed.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function categoryColor(detail: string): string {
  const lower = detail.toLowerCase()
  const key = Object.keys(CATEGORY_COLORS).find(category => lower.includes(displayCategory(category).toLowerCase()) || lower.includes(category))
  if (key) return CATEGORY_COLORS[key]
  return 'var(--t3)'
}

function nowMinutes(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function parseEntry(line: string, day: FocusEntry['day'], kind: FocusEntry['kind']): FocusEntry | null {
  const range = line.match(/\b(\d{1,2}):(\d{2})(?:[–-](\d{1,2}):(\d{2}))?\b/)
  if (!range) return null
  const startMin = Number(range[1]) * 60 + Number(range[2])
  const duration = Number(line.match(/·\s*(\d+)\s*min\b/i)?.[1] || 0)
  const endMin = range[3]
    ? Number(range[3]) * 60 + Number(range[4])
    : startMin + (duration || 60)
  const subject = splitSubject(titleOf(line))
  const fallbackDetail = kind === 'pt' ? 'Personal Training' : kind === 'slot' ? 'Fokusblock' : ''
  const detail = cleanLine(subject.detail || fallbackDetail)
  return {
    day,
    kind,
    startMin,
    endMin,
    timeLabel: compactTimeRange(range[0]),
    title: cleanLine(subject.main || titleOf(line) || line),
    detail,
    dot: kind === 'slot' ? '#d18a4a' : categoryColor(detail),
  }
}

function collectEntries(payload: FokusBriefingPayload): FocusEntry[] {
  const groups: Array<[keyof FokusBriefingPayload, FocusEntry['day'], FocusEntry['kind']]> = [
    ['calendar_today', 'today', 'calendar'],
    ['pt_today', 'today', 'pt'],
    ['slots_today', 'today', 'slot'],
    ['calendar_tomorrow', 'tomorrow', 'calendar'],
    ['pt_tomorrow', 'tomorrow', 'pt'],
    ['slots_tomorrow', 'tomorrow', 'slot'],
  ]
  return groups
    .flatMap(([key, day, kind]) => ((payload[key] as string[] | undefined) || [])
      .map(line => parseEntry(line, day, kind))
      .filter((entry): entry is FocusEntry => Boolean(entry)))
    .sort((a, b) => {
      const dayDiff = (a.day === 'today' ? 0 : 1) - (b.day === 'today' ? 0 : 1)
      return dayDiff || a.startMin - b.startMin
    })
}

function nextSentence(entry: FocusEntry): string {
  const day = entry.day === 'tomorrow' ? 'morgen ' : ''
  return cleanLine(`Danach ${day}${entry.timeLabel} ${entry.title}.`)
}

function nextCard(payload: FokusBriefingPayload | null, tick: number): { time: string; title: string; detail: string; next: string; hot: boolean; dot: string; hidden: boolean } {
  void tick
  if (!payload) return { time: '', title: 'Fokus lädt…', detail: '', next: '', hot: false, dot: 'var(--t3)', hidden: false }
  const nowMin = nowMinutes()
  const entries = collectEntries(payload)
  const todayOpen = entries.filter(entry => entry.day === 'today' && entry.endMin > nowMin)
  const upcoming = todayOpen[0] || entries.find(entry => entry.day === 'tomorrow')
  if (upcoming) {
    const next = (upcoming.day === 'today' ? todayOpen : entries.filter(entry => entry.day === 'tomorrow'))
      .find(entry => entry !== upcoming)
    const running = upcoming.day === 'today' && upcoming.startMin <= nowMin
    const startsSoon = upcoming.day === 'today' && upcoming.startMin > nowMin
    const minutes = running ? upcoming.endMin - nowMin : upcoming.startMin - nowMin
    const detail = running
      ? `läuft noch ${minutes} min`
      : startsSoon
        ? `startet in ${minutes} min`
        : cleanLine(upcoming.detail || 'Morgen')
    return {
      time: upcoming.day === 'tomorrow' ? `morgen ${upcoming.timeLabel}` : upcoming.timeLabel,
      title: upcoming.title,
      detail,
      next: next ? nextSentence(next) : '',
      hot: false,
      dot: upcoming.dot,
      hidden: false,
    }
  }
  const waiting = payload.waiting_on_you?.[0]
  if (waiting) {
    return { time: 'offen', title: cleanLine(waiting), detail: 'Nächster offener Punkt', next: '', hot: true, dot: 'var(--cc-orange)', hidden: false }
  }
  return { time: '', title: '', detail: '', next: '', hot: false, dot: 'var(--t3)', hidden: true }
}

export function FokusSection({ mobile }: { mobile?: boolean }) {
  const [payload, setPayload] = useState<FokusBriefingPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const hasPayloadRef = useRef(false)

  useEffect(() => {
    hasPayloadRef.current = Boolean(payload)
  }, [payload])

  const load = useCallback(async () => {
    if (!hasPayloadRef.current) setLoading(true)
    try {
      const res = await fetch('/api/fokus/briefing')
      if (!res.ok) return
      const data = await res.json()
      setPayload(data?.payload || null)
    } catch {
      if (!hasPayloadRef.current) setPayload(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 60000)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  useEffect(() => {
    const interval = window.setInterval(() => setTick(value => value + 1), 30000)
    return () => window.clearInterval(interval)
  }, [])

  const card = useMemo(() => nextCard(payload, tick), [payload, tick])
  if (card.hidden) return null

  const cardBackground = 'color-mix(in srgb, var(--info-tone, var(--bg)) 88%, black)'
  const accentColor = card.hot ? 'var(--cc-orange)' : card.dot

  const openFokus = () => {
    playUISound('view-open', 0.5)
    if (mobile) {
      window.location.assign('/fokus')
      return
    }
    const win = window.open('/fokus', 'agent-fokus')
    win?.focus()
  }

  return (
    <button
      type="button"
      onClick={openFokus}
      className="info-focus-card group block w-full text-left cursor-pointer transition-colors"
      title="Fokus groß öffnen"
    >
      <div
        className={`${mobile ? 'px-5 py-3.5' : 'px-3 py-2.5'} min-w-0 transition-[filter] group-hover:brightness-[1.08] group-active:brightness-[1.12]`}
        style={{
          background: cardBackground,
          boxShadow: `inset 3px 0 0 ${accentColor}, inset 0 1px 0 color-mix(in srgb, var(--t1) 5%, transparent), inset -1px 0 0 color-mix(in srgb, var(--bg) 34%, transparent)`,
        }}
      >
        {card.time && (
          <div className={`info-text-meta mb-0.5 tabular-nums ${card.hot ? 'text-[var(--cc-orange)]/90' : 'text-[var(--t3)]'}`}>
            {card.time}
          </div>
        )}
        <div
          className={`text-[17px] leading-snug break-words whitespace-pre-line ${card.hot ? 'text-[var(--cc-orange)]/95' : loading ? 'text-[var(--t2)]/60' : 'text-[var(--t1)]'}`}
          style={{ fontFamily: 'var(--font-heading)', fontWeight: 500 }}
        >
          {card.title}
        </div>
        {card.detail && (
          <div className="mt-1 info-text-meta leading-snug text-[var(--t3)]/85 break-words whitespace-pre-line">
            {card.detail}
          </div>
        )}
        {card.next && (
          <div className="mt-1 info-text-meta leading-snug text-[var(--t3)]/72 break-words tabular-nums">
            {card.next}
          </div>
        )}
      </div>
    </button>
  )
}
