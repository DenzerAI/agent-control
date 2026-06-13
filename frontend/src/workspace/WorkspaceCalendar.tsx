import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { HOLIDAYS_DE, VACATIONS } from '../lib/holidays'

// Kalender im Workspace, optisch 1:1 wie der Fokus-Kalender (Zeitraster), nur
// mit den Workspace-/Agent-Control-Tokens. Quelle ist dieselbe lokale Wahrheit:
// GET /api/calendar (PT aus people.db + manuelle Termine aus chat.db).
// Responsiv: schmaler Container -> ein Tag einspaltig wie auf dem Handy,
// breiter Container -> volle Woche.

type CalEvent = {
  id: string
  source?: 'ptdesk' | 'manual' | 'google' | 'fokus-overdue'
  startIso: string
  durationMin: number
  title: string
  notes?: string
  location?: string
  status?: string
  category?: string
  calendarName?: string
  label?: string
  allDay?: boolean
  customer?: { name?: string }
}

const CAL_CATEGORY_COLORS: Record<string, string> = {
  klaus: '#d97757',
  privat: '#9a978f',
  fch: '#5fc845',
  'ai-workshop': '#a37acf',
  'ai-agent': '#d97a5a',
  'ai-beratung': '#e0945a',
  gecko: '#4abca0',
  ptdesk: '#5a8ec8',
  admin: '#8a8e96',
}

const DAY_SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const DAY_LONG_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
const MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

const HOUR_START = 7
const HOUR_END = 22
const HOUR_PX = 56
const CAL_PAD_TOP = 12
const RAIL = 56
// Unter dieser Containerbreite: ein Tag einspaltig statt sieben.
const WEEK_MIN_WIDTH = 760

function isoOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d); x.setDate(x.getDate() + n); return x
}
function startOfWeekMonday(d: Date): Date {
  const x = new Date(d); x.setHours(0, 0, 0, 0)
  const dow = x.getDay(); x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow)); return x
}
function isoWeekNum(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dow = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}
function fmtMinAsClock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}
function isEventPast(dayIso: string, endMin: number, todayIso: string): boolean {
  if (dayIso < todayIso) return true
  if (dayIso > todayIso) return false
  const now = new Date()
  return endMin <= now.getHours() * 60 + now.getMinutes()
}
function eventBadge(ev: CalEvent): string {
  if (ev.source === 'ptdesk') return 'PT'
  const cat = (ev.category || '').toLowerCase()
  const map: Record<string, string> = {
    klaus: 'LO', privat: 'PR', fch: 'FCH',
    'ai-workshop': 'AIW', 'ai-agent': 'AIA', 'ai-beratung': 'AIB',
    gecko: 'GKO', admin: 'ADM',
  }
  if (map[cat]) return map[cat]
  return ev.label ? ev.label.toUpperCase() : ''
}
function eventTint(ev: CalEvent): string {
  if (ev.source === 'ptdesk') return 'rgba(120,130,150,0.06)'
  const col = CAL_CATEGORY_COLORS[(ev.category || '').toLowerCase()]
  return col ? `${col}1f` : 'rgba(120,130,150,0.06)'
}

function NowLine({ visibleDays, todayIso }: { visibleDays: string[]; todayIso: string }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => force(n => n + 1), 60000)
    return () => window.clearInterval(id)
  }, [])
  const idx = visibleDays.indexOf(todayIso)
  if (idx < 0) return null
  const now = new Date()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes < HOUR_START * 60 || minutes > HOUR_END * 60) return null
  const top = CAL_PAD_TOP + ((minutes - HOUR_START * 60) / 60) * HOUR_PX
  const n = visibleDays.length
  return (
    <div className="absolute pointer-events-none z-10 flex items-center" style={{
      top: `${top}px`,
      left: `calc((100% - ${RAIL}px) * ${idx} / ${n} + ${RAIL}px)`,
      width: `calc((100% - ${RAIL}px) / ${n})`,
      height: 0,
    }}>
      <div className="w-2 h-2 rounded-full -ml-1 flex-shrink-0" style={{ background: 'var(--warm)' }} />
      <div className="flex-1 h-[1.5px]" style={{ background: 'var(--warm)' }} />
    </div>
  )
}

function EventBlock({ ev, dayIso, todayIso }: { ev: CalEvent; dayIso: string; todayIso: string }) {
  const d = new Date(ev.startIso)
  const start = d.getHours() * 60 + d.getMinutes()
  const dur = Math.max(15, ev.durationMin || 60)
  const top = ((start - HOUR_START * 60) / 60) * HOUR_PX
  const height = Math.max(28, (dur / 60) * HOUR_PX - 2)
  const endMin = start + dur
  const isPt = ev.source === 'ptdesk'
  const name = isPt ? (ev.customer?.name || ev.title) : ev.title
  const tight = height < 40
  const isCancelled = (ev.status || '').startsWith('cancelled')
  const isDone = ev.status === 'done'
  const isPast = isEventPast(dayIso, endMin, todayIso)
  const bg = isCancelled ? 'rgba(120,120,120,0.05)' : isDone ? 'rgba(120,160,120,0.10)' : eventTint(ev)
  const opacity = isCancelled ? 0.55 : (isPast ? 0.5 : 1)
  const badge = eventBadge(ev)
  return (
    <div
      className={`absolute left-1 right-1 rounded overflow-hidden select-none ${tight ? 'px-2 py-0.5 flex items-center gap-1.5' : 'px-2 py-1 flex flex-col gap-0.5'}`}
      style={{ top: `${top}px`, height: `${height}px`, background: bg, color: 'var(--t1)', opacity, textDecoration: isCancelled ? 'line-through' : 'none', zIndex: 2 }}
      title={`${fmtMinAsClock(start)}–${fmtMinAsClock(endMin)}${badge ? ' · ' + badge : ''} · ${name}${ev.location ? ' · ' + ev.location : ''}${ev.notes ? ' · ' + ev.notes : ''}`}
    >
      {tight ? (
        <>
          {badge && <span className="text-[12px] tabular-nums flex-shrink-0" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.04em' }}>{badge}</span>}
          <span className="text-[14px] leading-[1.25] truncate" style={{ fontFamily: 'var(--font-heading)', fontWeight: 500 }}>{name}</span>
        </>
      ) : (
        <>
          <div className="text-[12px] tabular-nums flex items-center gap-1" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.04em' }}>
            <span>{fmtMinAsClock(start)}–{fmtMinAsClock(endMin)}</span>
            {badge && <span style={{ opacity: 0.7 }}>· {badge}</span>}
          </div>
          <div className="text-[15px] leading-[1.25] truncate" style={{ fontFamily: 'var(--font-heading)', fontWeight: 500 }}>{name}</div>
        </>
      )}
    </div>
  )
}

export function WorkspaceCalendar() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(7)
  const [offset, setOffset] = useState(0) // Wochen (cols=7) bzw. Tage (cols=1)
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState(false)

  const today = new Date()
  const todayIso = isoOf(today)

  // Containerbreite beobachten -> Woche oder ein Tag.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width || el.clientWidth
      setCols(prev => {
        const next = w < WEEK_MIN_WIDTH ? 1 : 7
        return next === prev ? prev : next
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Sichtbarer Tagesbereich.
  const days = useMemo(() => {
    if (cols === 1) {
      const d = addDays(today, offset)
      return [{ iso: isoOf(d), date: d }]
    }
    const ws = addDays(startOfWeekMonday(today), offset * 7)
    return Array.from({ length: 7 }).map((_, i) => {
      const d = addDays(ws, i)
      return { iso: isoOf(d), date: d }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, offset, todayIso])

  const rangeFrom = days[0]?.iso || todayIso
  const rangeTo = isoOf(addDays(new Date(days[days.length - 1]?.iso || todayIso), 1))

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`/api/calendar?from=${rangeFrom}&to=${rangeTo}`)
      .then(r => r.ok ? r.json() : { events: [] })
      .then(d => { if (alive) setEvents(Array.isArray(d.events) ? d.events : []) })
      .catch(() => { if (alive) setEvents([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [rangeFrom, rangeTo])

  const timedByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const day of days) m.set(day.iso, [])
    for (const ev of events) {
      if (ev.allDay) continue
      const arr = m.get((ev.startIso || '').slice(0, 10))
      if (arr) arr.push(ev)
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.startIso || '').localeCompare(b.startIso || ''))
    return m
  }, [events, days])

  const allDayByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>()
    for (const day of days) m.set(day.iso, [])
    for (const ev of events) {
      if (!ev.allDay) continue
      const arr = m.get((ev.startIso || '').slice(0, 10))
      if (arr) arr.push(ev)
    }
    return m
  }, [events, days])

  const hours = Array.from({ length: HOUR_END - HOUR_START + 1 }).map((_, i) => HOUR_START + i)
  const visibleDays = days.map(d => d.iso)
  const gridCols = `${RAIL}px repeat(${cols}, 1fr)`
  const hasAllDay = days.some(d => (allDayByDay.get(d.iso) || []).length > 0)

  const label = cols === 1
    ? `${DAY_LONG_DE[days[0].date.getDay()]} · ${days[0].date.getDate()}. ${MONTH_SHORT[days[0].date.getMonth()]}`
    : `KW ${isoWeekNum(days[0].date)} · ${days[0].date.getDate()}.${days[0].date.getMonth() + 1}. – ${days[6].date.getDate()}.${days[6].date.getMonth() + 1}.`

  return (
    <div ref={wrapRef} className="h-full flex flex-col min-w-0 bg-[var(--bg)]">
      {/* Kopfzeile */}
      <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border-f)' }}>
        <span className="info-text-body text-[var(--t1)] font-semibold">Kalender</span>
        <span className="flex-1" />
        <button onClick={() => setOffset(o => o - 1)} className="p-1 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer" aria-label="zurück"><ChevronLeft className="h-4 w-4" /></button>
        <button onClick={() => setOffset(0)} className="px-2 py-1 rounded info-text-meta tabular-nums text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer min-w-[180px] text-center">{label}</button>
        <button onClick={() => setOffset(o => o + 1)} className="p-1 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer" aria-label="vor"><ChevronRight className="h-4 w-4" /></button>
        {loading && <span className="info-text-meta text-[var(--t3)]/60 italic ml-1">lädt …</span>}
      </div>

      {/* Tagesköpfe (sticky) */}
      <div className="grid border-b" style={{ gridTemplateColumns: gridCols, background: 'var(--bg)', borderColor: 'var(--border-f)' }}>
        <div />
        {days.map(d => {
          const isToday = d.iso === todayIso
          const dow = d.date.getDay()
          const isWeekend = dow === 0 || dow === 6
          const holiday = HOLIDAYS_DE[d.iso] || VACATIONS[d.iso]
          return (
            <div key={d.iso} className="flex flex-col items-center gap-0.5 py-3 border-l" style={{ borderColor: 'var(--border)' }}>
              <span className="text-[12.5px] uppercase tracking-[0.18em]" style={{ color: isToday || holiday ? 'var(--warm)' : (isWeekend ? 'var(--t2)' : 'var(--t3)'), fontFamily: 'var(--font-body)', fontWeight: 600 }}>{DAY_SHORT_DE[dow]}</span>
              <span className="text-[22px] tabular-nums" style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500, letterSpacing: '-0.01em' }}>{d.date.getDate()}</span>
              {holiday && <span className="text-[11.5px] uppercase tracking-[0.12em] mt-0.5 text-center px-1 leading-tight truncate max-w-full" style={{ color: 'var(--warm)', fontFamily: 'var(--font-body)', fontWeight: 600 }} title={holiday}>{holiday}</span>}
              {isToday && !holiday && <span className="block w-1 h-1 rounded-full mt-0.5" style={{ background: 'var(--warm)' }} />}
            </div>
          )
        })}
      </div>

      {/* Ganztägig-Band */}
      {hasAllDay && (
        <div className="grid border-b" style={{ gridTemplateColumns: gridCols, borderColor: 'var(--border-f)' }}>
          <div className="flex items-center justify-end pr-2 py-1 text-[11px] uppercase tracking-[0.1em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>ganztägig</div>
          {days.map(d => (
            <div key={d.iso} className="border-l px-1 py-1 flex flex-col gap-1" style={{ borderColor: 'var(--border)' }}>
              {(allDayByDay.get(d.iso) || []).map(ev => (
                <div key={ev.id} className="rounded px-2 py-0.5 text-[13px] truncate" style={{ background: eventTint(ev), color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }} title={ev.title}>{ev.title}</div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Zeitraster */}
      <div className="relative flex-1 overflow-y-auto" style={{ paddingTop: `${CAL_PAD_TOP}px`, paddingBottom: '16px' }}>
        <div className="grid" style={{ gridTemplateColumns: gridCols }}>
          <div className="relative" style={{ height: `${(HOUR_END - HOUR_START) * HOUR_PX}px` }}>
            {hours.map(h => (
              <div key={h} className="absolute right-2 -translate-y-1/2 text-[13px] tabular-nums" style={{ top: `${(h - HOUR_START) * HOUR_PX}px`, color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>{String(h).padStart(2, '0')}:00</div>
            ))}
          </div>
          {days.map(d => {
            const isToday = d.iso === todayIso
            const dow = d.date.getDay()
            const isWeekend = dow === 0 || dow === 6
            const isHoliday = !!(HOLIDAYS_DE[d.iso] || VACATIONS[d.iso])
            return (
              <div key={d.iso} className="relative border-l" style={{
                height: `${(HOUR_END - HOUR_START) * HOUR_PX}px`,
                borderColor: 'var(--border)',
                background: isToday ? 'var(--bg-1)' : (isHoliday ? 'repeating-linear-gradient(135deg, transparent 0, transparent 9px, rgba(255,255,255,0.045) 9px, rgba(255,255,255,0.045) 10px), rgba(0,0,0,0.22)' : (isWeekend ? 'rgba(0,0,0,0.22)' : 'transparent')),
              }}>
                {hours.slice(1, -1).map(h => (
                  <div key={h} className="absolute left-0 right-0 pointer-events-none" style={{ top: `${(h - HOUR_START) * HOUR_PX}px`, height: '1px', background: 'var(--border)', opacity: 0.6 }} />
                ))}
                {(timedByDay.get(d.iso) || []).map(ev => (
                  <EventBlock key={ev.id} ev={ev} dayIso={d.iso} todayIso={todayIso} />
                ))}
              </div>
            )
          })}
        </div>
        <NowLine visibleDays={visibleDays} todayIso={todayIso} />
      </div>
    </div>
  )
}
