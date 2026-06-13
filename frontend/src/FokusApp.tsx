import { useState, useEffect, useCallback, useMemo, useRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import { Check, X, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { ChatPane } from './components/ChatPane'
import { HOLIDAYS_DE, VACATIONS } from './lib/holidays'
import './index.css'

type Bucket = 'now' | 'soon' | 'later'
type Triage = 'now' | 'soon' | 'later'

type FokusItem = {
  bucket: Bucket
  triage: Triage
  date: string | null
  date_end?: string | null
  title: string
  body?: string
  people: { name: string; anchor: string }[]
  projects: { name: string; anchor: string }[]
  tags: string[]
  item_key?: string
  short_title?: string
}

type FokusSlot = {
  id: number
  item_key: string
  item_title: string
  day_iso: string
  start_min: number
  dur_min: number
}

type FokusSynthesis = {
  worum: string
  stand: string
  haengt: string
  next: string
}

type FokusUpdate = {
  id: number
  text: string
  source: string
  ts: number
}

type PtEvent = {
  id: string
  ptId?: number
  personId?: number
  startIso: string
  durationMin: number
  title: string
  notes: string
  status: string
  cancelledBy?: string | null
  cancellationReason?: string | null
  customer?: { id?: string | number; name?: string }
  remainingSessions?: number | null
  seriesKey?: string | null
  cardId?: number | null
  source?: 'ptdesk' | 'manual' | 'google' | 'fokus-overdue'
  category?: string
  calendarName?: string
  label?: string
  rrule?: '' | 'daily' | 'weekly' | 'monthly'
  rruleUntil?: string
}

const CAL_CATEGORY_COLORS: Record<string, string> = {
  privat: '#9a978f',
  fch: '#5fc845',
  'ai-workshop': '#a37acf',
  'ai-agent': '#d97a5a',
  'ai-beratung': '#e0945a',
  gecko: '#4abca0',
  ptdesk: '#5a8ec8',
  admin: '#8a8e96',
}

function eventBadge(ev: PtEvent): string {
  if (ev.source === 'ptdesk') return 'PT'
  const cat = (ev.category || '').toLowerCase()
  const labelMap: Record<string, string> = {
    klaus: 'LO', privat: 'PR', fch: 'FCH',
    'ai-workshop': 'AIW', 'ai-agent': 'AIA', 'ai-beratung': 'AIB',
    gecko: 'GKO', admin: 'ADM',
  }
  if (labelMap[cat]) return labelMap[cat]
  if (ev.label) return ev.label.toUpperCase()
  return ''
}

function eventTint(ev: PtEvent): string {
  if (ev.source === 'ptdesk') return 'rgba(120,130,150,0.06)'
  const cat = (ev.category || '').toLowerCase()
  const col = CAL_CATEGORY_COLORS[cat]
  return col ? `${col}1f` : 'rgba(120,130,150,0.06)'
}

function inferPtTrainingType(title: string, label: string): 'personal_training' | 'ems' {
  const head = `${title} ${label}`.trim().toLowerCase()
  return head.startsWith('ems') || /\bems\b/.test(head) ? 'ems' : 'personal_training'
}

type DragState =
  | { kind: 'move'; slotId: number; itemKey: string; itemTitle: string; startMin: number; durMin: number; dayIso: string; pointerY: number; pointerX: number; ghostDayIso: string; ghostStartMin: number }
  | { kind: 'resize'; slotId: number; itemKey: string; itemTitle: string; dayIso: string; startMin: number; durMin: number; ghostDurMin: number }
  | { kind: 'inbox'; itemKey: string; itemTitle: string; pointerX: number; pointerY: number; ghostDayIso: string | null; ghostStartMin: number | null }
  | { kind: 'cal-move'; eventId: string; eventTitle: string; source: string; startMin: number; durMin: number; dayIso: string; pointerY: number; pointerX: number; ghostDayIso: string; ghostStartMin: number }
  | null

const DAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
const DAY_SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const MONTH_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']

const HOUR_START = 7
const HOUR_END = 22
const HOUR_PX = 56
const CAL_PAD_TOP = 12
const SLOT_MIN = 30
const DEFAULT_DUR = 30
const MIN_DUR = 30

function isoOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

function diffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00')
  const db = new Date(b + 'T00:00:00')
  return Math.round((da.getTime() - db.getTime()) / 86400000)
}

// Feiertage und Urlaube leben zentral in ./lib/holidays.ts (oben importiert),
// damit Desktop und Mobile dieselbe Quelle nutzen.

function startOfWeekMonday(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  const dow = x.getDay()
  const offset = dow === 0 ? -6 : 1 - dow
  x.setDate(x.getDate() + offset)
  return x
}

function isoWeekNum(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dow = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

function fmtRelTime(ts: number): string {
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'gerade'
  if (diff < 3600) return `vor ${Math.round(diff / 60)}m`
  if (diff < 86400) return `vor ${Math.round(diff / 3600)}h`
  const d = new Date(ts * 1000)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function isOverdue(it: FokusItem, todayIso: string): boolean {
  return !!(it.date && it.date < todayIso)
}

function isEventPast(dayIso: string, endMin: number, todayIso: string): boolean {
  if (dayIso < todayIso) return true
  if (dayIso > todayIso) return false
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return endMin <= nowMin
}

function triageColor(it: FokusItem, overdue: boolean): { bg: string; border: string; text: string } {
  if (overdue) return { bg: 'rgba(224,122,79,0.18)', border: 'var(--purple)', text: 'var(--t1)' }
  if (it.triage === 'now') return { bg: 'rgba(214,201,168,0.16)', border: 'var(--warm)', text: 'var(--t1)' }
  if (it.triage === 'soon') return { bg: 'rgba(161,161,160,0.12)', border: 'var(--t2)', text: 'var(--t1)' }
  return { bg: 'rgba(138,130,120,0.10)', border: 'var(--t3)', text: 'var(--t1)' }
}

function fmtMinAsClock(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function snapMin(min: number): number {
  return Math.round(min / SLOT_MIN) * SLOT_MIN
}

function MetaLine({ item, muted = false, compact = false }: { item: FokusItem; muted?: boolean; compact?: boolean }) {
  const c2 = muted ? 'var(--t3)' : 'var(--t2)'
  if (item.people.length + item.projects.length === 0) return null
  const sz = compact ? '11.5px' : '13.5px'
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5" style={{ fontFamily: 'var(--font-body)', fontSize: sz }}>
      {item.people.map(p => (
        <span key={`p-${p.anchor}`} style={{ color: c2, fontWeight: 600 }}>{p.name}</span>
      ))}
      {item.projects.map(p => (
        <span key={`pr-${p.anchor}`} className="italic" style={{ color: c2, fontFamily: 'var(--font-heading)' }}>{p.name}</span>
      ))}
    </div>
  )
}

function ScheduledBlock({ item, slot, todayIso, onOpen, onMoveStart, onResizeStart, drag }: {
  item: FokusItem
  slot: FokusSlot
  todayIso: string
  onOpen: () => void
  onMoveStart: (e: React.PointerEvent) => void
  onResizeStart: (e: React.PointerEvent) => void
  drag: DragState
}) {
  const overdue = isOverdue(item, todayIso)
  const c = triageColor(item, overdue)
  const isMoving = drag?.kind === 'move' && drag.slotId === slot.id
  const isResizing = drag?.kind === 'resize' && drag.slotId === slot.id
  const effStart = isMoving ? (drag as any).ghostStartMin : slot.start_min
  const effDur = isResizing ? (drag as any).ghostDurMin : slot.dur_min
  const top = ((effStart - HOUR_START * 60) / 60) * HOUR_PX
  const height = Math.max(28, (effDur / 60) * HOUR_PX - 2)
  const endMin = effStart + effDur
  const dimmed = isMoving && (drag as any).ghostDayIso !== slot.day_iso
  const tight = height < 40
  const isPast = isEventPast(slot.day_iso, endMin, todayIso)
  return (
    <div
      data-focus-item={slot.item_key}
      data-focus-title={item.title}
      onPointerDown={onMoveStart}
      onClick={e => {
        if ((e as any).detail === 0) return
        onOpen()
      }}
      className={`absolute left-1 right-1 cursor-grab active:cursor-grabbing text-left rounded transition-shadow overflow-hidden select-none ${tight ? 'px-2 py-0.5 flex items-center' : 'px-2 py-1 flex flex-col gap-0.5'}`}
      style={{
        top: `${top}px`,
        height: `${height}px`,
        background: overdue ? 'rgba(224,122,79,0.08)' : 'rgba(214,201,168,0.06)',
        color: c.text,
        opacity: dimmed ? 0.35 : (isPast ? 0.5 : 1),
        boxShadow: (isMoving || isResizing) ? '0 6px 20px rgba(0,0,0,0.35)' : 'none',
        zIndex: (isMoving || isResizing) ? 30 : 1,
      }}
      title={`${fmtMinAsClock(effStart)}–${fmtMinAsClock(endMin)} · ${item.title}`}
    >
      {!tight && (
        <div
          className="text-[12px] tabular-nums"
          style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.04em' }}
        >{fmtMinAsClock(effStart)}–{fmtMinAsClock(endMin)}</div>
      )}
      <div
        className={`leading-[1.25] truncate ${tight ? 'text-[14px]' : 'text-[15px]'}`}
        style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500, letterSpacing: '-0.005em' }}
      >{item.short_title || item.title}</div>
      {height > 60 && item.projects.length + item.people.length > 0 && (
        <div className="mt-auto"><MetaLine item={item} compact muted /></div>
      )}
      <div
        onPointerDown={onResizeStart}
        className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize"
        style={{ touchAction: 'none' }}
      />
    </div>
  )
}

function GhostInboxBlock({ drag }: { drag: Extract<DragState, { kind: 'inbox' }> }) {
  if (!drag.ghostDayIso || drag.ghostStartMin == null) return null
  const top = ((drag.ghostStartMin - HOUR_START * 60) / 60) * HOUR_PX
  const height = Math.max(28, (DEFAULT_DUR / 60) * HOUR_PX - 2)
  return (
    <div
      className="absolute left-1 right-1 rounded-md pointer-events-none"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        background: 'rgba(214,201,168,0.22)',
        borderLeft: '3px dashed var(--warm)',
        zIndex: 20,
      }}
    >
      <div
        className="px-2 py-1 text-[14px] truncate"
        style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}
      >{drag.itemTitle}</div>
    </div>
  )
}

function GhostCalMoveBlock({ drag }: { drag: Extract<DragState, { kind: 'cal-move' }> }) {
  const top = ((drag.ghostStartMin - HOUR_START * 60) / 60) * HOUR_PX
  const height = Math.max(28, (drag.durMin / 60) * HOUR_PX - 2)
  const endMin = drag.ghostStartMin + drag.durMin
  return (
    <div
      className="absolute left-1 right-1 rounded-md pointer-events-none"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        background: 'rgba(214,201,168,0.22)',
        borderLeft: '3px dashed var(--warm)',
        zIndex: 20,
      }}
    >
      <div
        className="px-2 py-0.5 text-[12px] tabular-nums"
        style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.04em' }}
      >{fmtMinAsClock(drag.ghostStartMin)}–{fmtMinAsClock(endMin)}</div>
      <div
        className="px-2 text-[14px] truncate"
        style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}
      >{drag.eventTitle}</div>
    </div>
  )
}

function NowLine({ todayIso, weekStart }: { todayIso: string; weekStart: Date }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  const dayIdx = diffDays(todayIso, isoOf(weekStart))
  if (dayIdx < 0 || dayIdx > 6) return null
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (minutes < HOUR_START * 60 || minutes > HOUR_END * 60) return null
  const top = CAL_PAD_TOP + ((minutes - HOUR_START * 60) / 60) * HOUR_PX
  return (
    <div
      className="absolute pointer-events-none z-10 flex items-center"
      style={{
        top: `${top}px`,
        left: `calc((100% - 56px) * ${dayIdx} / 7 + 56px)`,
        width: `calc((100% - 56px) / 7)`,
        height: '0',
      }}
    >
      <div className="w-2 h-2 rounded-full -ml-1 flex-shrink-0" style={{ background: 'var(--purple)' }} />
      <div className="flex-1 h-[1.5px]" style={{ background: 'var(--purple)' }} />
    </div>
  )
}

function PtEventBlock({ ev, dayIso, todayIso, drag, onOpen, onCalMoveStart }: { ev: PtEvent; dayIso: string; todayIso: string; drag: DragState; onOpen: (ev: PtEvent) => void; onCalMoveStart: (ev: PtEvent, dayIso: string, e: React.PointerEvent) => void }) {
  const d = new Date(ev.startIso)
  const rawStart = d.getHours() * 60 + d.getMinutes()
  const dur = Math.max(15, ev.durationMin || 60)
  const isMoving = drag?.kind === 'cal-move' && drag.eventId === ev.id
  const effStart = isMoving ? (drag as any).ghostStartMin : rawStart
  const top = ((effStart - HOUR_START * 60) / 60) * HOUR_PX
  const height = Math.max(28, (dur / 60) * HOUR_PX - 2)
  const endMin = effStart + dur
  const dimmed = isMoving && (drag as any).ghostDayIso !== dayIso
  const isPt = ev.source === 'ptdesk'
  const name = isPt ? (ev.customer?.name || ev.title) : ev.title
  const tight = height < 40
  const isCancelled = ev.status === 'cancelled_by_customer' || ev.status === 'cancelled_by_trainer' || ev.status === 'cancelled'
  const isDone = ev.status === 'done'
  const isPast = !isMoving && isEventPast(dayIso, endMin, todayIso)
  const bg = isCancelled ? 'rgba(120,120,120,0.05)' : isDone ? 'rgba(120,160,120,0.10)' : eventTint(ev)
  const textDeco = isCancelled ? 'line-through' : 'none'
  const opacity = isCancelled ? 0.55 : (isPast ? 0.5 : 1)
  const badge = eventBadge(ev)
  const statusBadge = ev.status === 'cancelled_by_customer' ? 'Kunde abges.' : ev.status === 'cancelled_by_trainer' ? 'Abgesagt' : isDone ? 'Lief' : null
  const draggable = ev.source === 'manual' || ev.source === 'google'
  return (
    <div
      onPointerDown={draggable ? (e) => {
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
        onCalMoveStart(ev, dayIso, e)
      } : undefined}
      onClick={(e) => {
        if ((e as any).detail === 0) return
        e.stopPropagation(); onOpen(ev)
      }}
      className={`absolute left-1 right-1 rounded overflow-hidden select-none pointer-events-auto ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${tight ? 'px-2 py-0.5 flex items-center gap-1.5' : 'px-2 py-1 flex flex-col gap-0.5'}`}
      style={{
        top: `${top}px`,
        height: `${height}px`,
        background: bg,
        color: 'var(--t1)',
        opacity: dimmed ? 0.35 : opacity,
        textDecoration: textDeco,
        zIndex: isMoving ? 30 : 2,
        boxShadow: isMoving ? '0 6px 20px rgba(0,0,0,0.35)' : 'none',
        touchAction: draggable ? 'none' : 'auto',
      }}
      title={`${fmtMinAsClock(effStart)}–${fmtMinAsClock(endMin)}${badge ? ' · ' + badge : ''} · ${name}${statusBadge ? ' · ' + statusBadge : ''}${ev.notes ? ' · ' + ev.notes : ''}`}
    >
      {tight ? (
        <>
          {badge && (
            <span
              className="text-[12px] tabular-nums flex-shrink-0"
              style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.04em' }}
            >{badge}</span>
          )}
          <span
            className="text-[14px] leading-[1.25] truncate"
            style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, letterSpacing: '-0.005em' }}
          >{name}</span>
        </>
      ) : (
        <>
          <div
            className="text-[12px] tabular-nums flex items-center gap-1"
            style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.04em' }}
          >
            <span>{fmtMinAsClock(effStart)}–{fmtMinAsClock(endMin)}</span>
            {badge && <span style={{ opacity: 0.7 }}>· {badge}</span>}
          </div>
          <div
            className="text-[15px] leading-[1.25] truncate"
            style={{ fontFamily: 'var(--font-heading)', fontWeight: 500, letterSpacing: '-0.005em' }}
          >{name}</div>
        </>
      )}
    </div>
  )
}

function WeekGrid({
  weekStart, todayIso, items, slots, ptEvents, onOpen, onOpenPt, onScheduleEmpty, onMoveStart, onResizeStart, onCalMoveStart, drag,
}: {
  weekStart: Date
  todayIso: string
  items: FokusItem[]
  slots: FokusSlot[]
  ptEvents: PtEvent[]
  onOpen: (it: FokusItem) => void
  onOpenPt: (ev: PtEvent) => void
  onScheduleEmpty: (dayIso: string, startMin: number) => void
  onMoveStart: (slot: FokusSlot, e: React.PointerEvent) => void
  onResizeStart: (slot: FokusSlot, e: React.PointerEvent) => void
  onCalMoveStart: (ev: PtEvent, dayIso: string, e: React.PointerEvent) => void
  drag: DragState
}) {
  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = addDays(weekStart, i)
    return { iso: isoOf(d), date: d }
  })

  const itemByKey = useMemo(() => {
    const m = new Map<string, FokusItem>()
    for (const it of items) if (it.item_key) m.set(it.item_key, it)
    return m
  }, [items])

  const scheduledByDay = useMemo(() => {
    const m = new Map<string, { item: FokusItem; slot: FokusSlot }[]>()
    for (const day of days) m.set(day.iso, [])
    for (const s of slots) {
      const it = itemByKey.get(s.item_key)
      if (!it) continue
      const arr = m.get(s.day_iso)
      if (!arr) continue
      arr.push({ item: it, slot: s })
    }
    for (const arr of m.values()) arr.sort((a, b) => a.slot.start_min - b.slot.start_min)
    return m
  }, [slots, itemByKey, days])

  const ptByDay = useMemo(() => {
    const m = new Map<string, PtEvent[]>()
    for (const day of days) m.set(day.iso, [])
    for (const ev of ptEvents) {
      const dayIso = (ev.startIso || '').slice(0, 10)
      const arr = m.get(dayIso)
      if (!arr) continue
      arr.push(ev)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.startIso.localeCompare(b.startIso))
    return m
  }, [ptEvents, days])

  const hours = Array.from({ length: HOUR_END - HOUR_START + 1 }).map((_, i) => HOUR_START + i)

  const handleGridClick = (dayIso: string, e: React.MouseEvent<HTMLDivElement>) => {
    if (drag) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const min = HOUR_START * 60 + Math.round((y / HOUR_PX) * 60 / SLOT_MIN) * SLOT_MIN
    onScheduleEmpty(dayIso, Math.max(HOUR_START * 60, Math.min(HOUR_END * 60 - DEFAULT_DUR, min)))
  }

  return (
    <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--bg)' }}>
      <div className="grid sticky top-0 z-20 border-b" style={{
        gridTemplateColumns: `56px repeat(7, 1fr)`,
        background: 'var(--bg)',
        borderColor: 'var(--border-f)',
      }}>
        <div />
        {days.map(d => {
          const isToday = d.iso === todayIso
          const dow = d.date.getDay()
          const isWeekend = dow === 0 || dow === 6
          const holiday = HOLIDAYS_DE[d.iso] || VACATIONS[d.iso]
          return (
            <div key={d.iso} className="flex flex-col items-center gap-0.5 py-3 border-l" style={{ borderColor: 'var(--border)' }}>
              <span
                className="text-[12.5px] uppercase tracking-[0.18em]"
                style={{ color: isToday ? 'var(--warm)' : (holiday ? 'var(--warm)' : (isWeekend ? 'var(--t2)' : 'var(--t3)')), fontFamily: 'var(--font-body)', fontWeight: 600 }}
              >{DAY_SHORT_DE[d.date.getDay()]}</span>
              <span
                className="text-[22px] tabular-nums"
                style={{
                  color: 'var(--t1)',
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 500,
                  letterSpacing: '-0.01em',
                }}
              >{d.date.getDate()}</span>
              {holiday && (
                <span
                  className="text-[11.5px] uppercase tracking-[0.12em] mt-0.5 text-center px-1 leading-tight truncate max-w-full"
                  style={{ color: 'var(--warm)', fontFamily: 'var(--font-body)', fontWeight: 600 }}
                  title={holiday}
                >{holiday}</span>
              )}
              {isToday && !holiday && (
                <span className="block w-1 h-1 rounded-full mt-0.5" style={{ background: 'var(--warm)' }} />
              )}
            </div>
          )
        })}
      </div>

      <div className="relative flex-1 flex flex-col min-h-0" style={{ paddingTop: `${CAL_PAD_TOP}px`, paddingBottom: '16px' }}>
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
          <div className="relative" style={{ height: `${(HOUR_END - HOUR_START) * HOUR_PX}px` }}>
            {hours.map(h => (
              <div
                key={h}
                className="absolute right-2 -translate-y-1/2 text-[13px] tabular-nums"
                style={{ top: `${(h - HOUR_START) * HOUR_PX}px`, color: 'var(--t3)', fontFamily: 'var(--font-body)' }}
              >{String(h).padStart(2, '0')}:00</div>
            ))}
          </div>
          {days.map(d => {
            const isToday = d.iso === todayIso
            const dow = d.date.getDay()
            const isWeekend = dow === 0 || dow === 6
            const isHoliday = !!(HOLIDAYS_DE[d.iso] || VACATIONS[d.iso])
            const items = scheduledByDay.get(d.iso) || []
            const isMoveTarget = drag?.kind === 'move' && (drag as any).ghostDayIso === d.iso
            const isInboxTarget = drag?.kind === 'inbox' && (drag as any).ghostDayIso === d.iso
            const isCalMoveTarget = drag?.kind === 'cal-move' && (drag as any).ghostDayIso === d.iso
            return (
              <div
                key={d.iso}
                data-day-iso={d.iso}
                onClick={e => handleGridClick(d.iso, e)}
                className="relative border-l cursor-cell"
                style={{
                  height: `${(HOUR_END - HOUR_START) * HOUR_PX}px`,
                  borderColor: 'var(--border)',
                  background: isToday
                    ? 'var(--bg-1)'
                    : (isHoliday
                        ? 'repeating-linear-gradient(135deg, transparent 0, transparent 9px, rgba(255,255,255,0.045) 9px, rgba(255,255,255,0.045) 10px), rgba(0,0,0,0.22)'
                        : (isWeekend ? 'rgba(0,0,0,0.22)' : 'transparent')),
                  outline: (isMoveTarget || isInboxTarget || isCalMoveTarget) ? '1px solid var(--warm)' : 'none',
                  outlineOffset: '-1px',
                }}
              >
                {hours.slice(1, -1).map(h => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 pointer-events-none"
                    style={{
                      top: `${(h - HOUR_START) * HOUR_PX}px`,
                      height: '1px',
                      background: 'var(--border)',
                      opacity: 0.6,
                    }}
                  />
                ))}
                {items.map(({ item, slot }) => (
                  <ScheduledBlock
                    key={`s-${slot.id}`}
                    item={item}
                    slot={slot}
                    todayIso={todayIso}
                    onOpen={() => onOpen(item)}
                    onMoveStart={e => onMoveStart(slot, e)}
                    onResizeStart={e => onResizeStart(slot, e)}
                    drag={drag}
                  />
                ))}
                {(ptByDay.get(d.iso) || []).map(ev => (
                  <PtEventBlock key={`pt-${ev.id}`} ev={ev} dayIso={d.iso} todayIso={todayIso} drag={drag} onOpen={onOpenPt} onCalMoveStart={onCalMoveStart} />
                ))}
                {isInboxTarget && drag?.kind === 'inbox' && <GhostInboxBlock drag={drag as any} />}
                {isCalMoveTarget && drag?.kind === 'cal-move' && <GhostCalMoveBlock drag={drag as any} />}
              </div>
            )
          })}
        </div>
        <div className="grid flex-1 min-h-0" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
          <div />
          {days.map(d => {
            const dow = d.date.getDay()
            const isWeekend = dow === 0 || dow === 6
            const isHoliday = !!(HOLIDAYS_DE[d.iso] || VACATIONS[d.iso])
            const isToday = d.iso === todayIso
            return (
              <div
                key={`fill-${d.iso}`}
                className="border-l"
                style={{
                  borderColor: 'var(--border)',
                  background: isToday
                    ? 'var(--bg-1)'
                    : (isHoliday
                        ? 'repeating-linear-gradient(135deg, transparent 0, transparent 9px, rgba(255,255,255,0.045) 9px, rgba(255,255,255,0.045) 10px), rgba(0,0,0,0.22)'
                        : (isWeekend ? 'rgba(0,0,0,0.22)' : 'transparent')),
                }}
              />
            )
          })}
        </div>
        <NowLine todayIso={todayIso} weekStart={weekStart} />
      </div>
    </div>
  )
}


function SidePanel({ item, todayIso, slot, onClose, onDone, busy }: {
  item: FokusItem
  todayIso: string
  slot: FokusSlot | null
  onClose: () => void
  onDone: () => void
  onRefined?: (action: 'updated' | 'deleted' | 'noop') => void
  busy: boolean
}) {
  const [synthesis, setSynthesis] = useState<FokusSynthesis | null>(null)
  const [synthLoading, setSynthLoading] = useState(true)
  const [updates, setUpdates] = useState<FokusUpdate[]>([])
  const [convId, setConvId] = useState('')
  const itemKey = item.item_key || ''
  const updatesEndRef = useRef<HTMLDivElement>(null)
  const overdue = isOverdue(item, todayIso)

  useEffect(() => {
    let alive = true
    setSynthLoading(true)
    setSynthesis(null)
    setUpdates([])
    setConvId('')
    fetch(`/api/fokus/detail?title=${encodeURIComponent(item.title)}&synthesize=1`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && d?.synthesis) setSynthesis(d.synthesis as FokusSynthesis) })
      .catch(() => {})
      .finally(() => { if (alive) setSynthLoading(false) })
    fetch(`/api/fokus/updates?item_key=${encodeURIComponent(itemKey)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && Array.isArray(d.updates)) setUpdates(d.updates) })
      .catch(() => {})
    fetch('/api/fokus/item-conversation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_title: item.title }),
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && d?.conv_id) setConvId(d.conv_id) })
      .catch(() => {})
    return () => { alive = false }
  }, [item.title, itemKey])

  useEffect(() => {
    updatesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [updates.length])

  // PTT-Catcher: Cmd+V+Enter vom externen Diktat-Tool landet im Item-Chat,
  // wenn kein anderes Eingabefeld Fokus hat. ChatPane lauscht auf paneIndex=-1.
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
      const text = (e.clipboardData?.getData('text/plain') || '').trim()
      if (!text) return
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('deck:paneInput', { detail: { paneIndex: -1, text } }))
    }
    document.addEventListener('paste', handler)
    return () => document.removeEventListener('paste', handler)
  }, [])

  const synthFields: { label: string; text: string }[] = synthesis
    ? ([
        { label: 'Worum', text: synthesis.worum || '' },
        { label: 'Stand', text: synthesis.stand || '' },
        { label: 'Hängt an', text: synthesis.haengt || '' },
        { label: 'Next', text: synthesis.next || '' },
      ] as { label: string; text: string }[]).filter(f => f.text && f.text.trim())
    : []

  const paneW = 'min(540px, 50vw)'
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }}
        onClick={onClose}
      />

      <aside
        className="fixed top-0 bottom-0 z-50 flex flex-col"
        style={{
          right: paneW,
          width: paneW,
          background: 'var(--bg)',
          borderLeft: '1px solid var(--border)',
        }}
      >
        {convId ? (
          <ChatPane defaultAgent="main" conversationId={convId} paneIndex={-1} composerStorageKey="deck:fokusItemComposerCollapsed" />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[15.5px] italic" style={{ color: 'var(--t3)', fontFamily: 'var(--font-heading)' }}>
            Chat wird geladen…
          </div>
        )}
      </aside>

      <aside
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col"
        data-focus-item={itemKey}
        data-focus-title={item.title}
        style={{
          width: paneW,
          background: 'var(--bg-1)',
          borderLeft: '1px solid var(--border-f)',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.4)',
        }}
      >
        <header className="flex items-start justify-between gap-4 px-9 pt-8 pb-6 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex-1 min-w-0">
            {(slot || item.date) && (
              <div
                className="text-[13px] uppercase tracking-[0.18em] mb-3"
                style={{ color: overdue ? 'var(--purple)' : 'var(--warm)', fontFamily: 'var(--font-body)', fontWeight: 600 }}
              >
                {slot ? (
                  `${slot.day_iso} · ${fmtMinAsClock(slot.start_min)}–${fmtMinAsClock(slot.start_min + slot.dur_min)}`
                ) : overdue && item.date ? (
                  `Überfällig · ${-diffDays(item.date, todayIso)} Tage`
                ) : item.date === todayIso ? 'Heute' : item.date}
                {!slot && item.date_end && item.date_end !== item.date && !overdue ? ` … ${item.date_end}` : ''}
              </div>
            )}
            <h2
              className="m-0 italic"
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '31px',
                lineHeight: '1.2',
                letterSpacing: '-0.02em',
                color: 'var(--t1)',
                fontWeight: 500,
              }}
            >{item.title}</h2>
            <div className="mt-3">
              <MetaLine item={item} />
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 -m-2 cursor-pointer flex-shrink-0"
            style={{ color: 'var(--t3)' }}
            title="Schließen (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-9 py-7 flex flex-col gap-7">
          {item.body && item.body.trim() && (
            <div
              className="whitespace-pre-wrap text-[17px] leading-[1.65]"
              style={{ color: 'var(--t-body)', fontFamily: 'var(--font-body)' }}
            >{item.body.trim()}</div>
          )}

          {synthFields.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {synthFields.map(f => (
                <div
                  key={f.label}
                  className="text-[17px] leading-[1.55]"
                  style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
                >
                  <span style={{ color: 'var(--t3)', fontWeight: 600, marginRight: '0.5em' }}>{f.label}</span>
                  {f.text}
                </div>
              ))}
            </div>
          )}
          {synthFields.length === 0 && synthLoading && (
            <div className="text-[15.5px] italic" style={{ color: 'var(--t3)', fontFamily: 'var(--font-heading)' }}>Verdichte den Kontext…</div>
          )}

          {updates.length > 0 && (
            <div className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--border)' }}>
              {updates.map(u => (
                <div key={u.id} className="flex flex-col gap-1">
                  <div
                    className="flex items-baseline gap-2 text-[13px] tabular-nums"
                    style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}
                  >
                    <span>{fmtRelTime(u.ts)}</span>
                    {u.source === 'voice' && <span style={{ color: 'var(--warm)' }}>· Voice</span>}
                  </div>
                  <div
                    className="text-[17px] leading-[1.6] whitespace-pre-wrap"
                    style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
                  >{u.text}</div>
                </div>
              ))}
              <div ref={updatesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t flex items-center gap-4 px-9 py-3.5" style={{ borderColor: 'var(--border)' }}>
          <button
            onClick={onDone}
            disabled={busy}
            className="flex items-center gap-2 text-[15px] cursor-pointer transition-colors"
            style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--t1)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--t2)' }}
          >
            <Check className="w-4 h-4" />
            Erledigt markieren
          </button>
        </div>
      </aside>
    </>
  )
}

type PtCustomer = {
  id: string
  name: string
  email?: string
  phone?: string
  whatsapp_chat_id?: string
  birthday?: string | null
  customer_since?: string
  training_type?: string
  billing_model?: string
  hourly_rate?: number
  remaining_sessions?: number
  active_card_total_sessions?: number
  active_card_used_sessions?: number
  total_cards_purchased?: number
  price_eur?: number
  payment_method?: string
  payment_status?: string
  is_active?: boolean
  notes?: string
}

function ActionBtn({ children, onClick, disabled, variant }: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'danger'
}) {
  const base: React.CSSProperties = {
    fontFamily: 'var(--font-body)',
    fontSize: '12.5px',
    fontWeight: 550,
    padding: '9px 15px',
    borderRadius: '999px',
    border: '1px solid color-mix(in srgb, var(--border-f) 72%, transparent)',
    background: 'color-mix(in srgb, var(--bg-2) 54%, var(--bg) 46%)',
    color: 'var(--t1)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.035)',
    transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease',
  }
  if (variant === 'primary') {
    base.background = 'var(--t1)'
    base.color = 'var(--bg)'
    base.borderColor = 'color-mix(in srgb, var(--t1) 84%, var(--border-f) 16%)'
    base.fontWeight = 600
    base.boxShadow = '0 8px 18px rgba(0,0,0,0.18)'
  }
  if (variant === 'danger') {
    base.background = 'color-mix(in srgb, var(--bg) 74%, var(--bg-2) 26%)'
    base.color = 'color-mix(in srgb, var(--red) 76%, var(--t1) 24%)'
    base.borderColor = 'color-mix(in srgb, var(--red) 34%, var(--border-f) 66%)'
  }
  return <button onClick={onClick} disabled={disabled} style={base}>{children}</button>
}

function SheetSection({ title, children, tone = 'default' }: {
  title: string
  children: ReactNode
  tone?: 'default' | 'soft'
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-[22px] border px-4 py-4"
      style={{
        borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)',
        background: tone === 'soft'
          ? 'color-mix(in srgb, var(--bg-2) 46%, var(--bg) 54%)'
          : 'color-mix(in srgb, var(--bg-2) 58%, var(--bg) 42%)',
      }}
    >
      <div className="text-[12px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>
        {title}
      </div>
      {children}
    </section>
  )
}

function SheetField({ label, children, className = '' }: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[12px] uppercase tracking-[0.12em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function SheetInput({ className = '', style, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-3 py-2.5 rounded-[16px] border bg-transparent text-[15px] outline-none ${className}`}
      style={{
        borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)',
        color: 'var(--t1)',
        fontFamily: 'var(--font-body)',
        ...style,
      }}
    />
  )
}

function SheetSelect({ className = '', style, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full px-3 py-2.5 rounded-[16px] border bg-transparent text-[15px] outline-none cursor-pointer ${className}`}
      style={{
        borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)',
        color: 'var(--t1)',
        fontFamily: 'var(--font-body)',
        ...style,
      }}
    >
      {children}
    </select>
  )
}

function SheetTextarea({ className = '', style, value, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  // Wächst mit dem Inhalt mit, bis max 60vh, dann interne (unsichtbare) Scrollleiste.
  const ref = useRef<HTMLTextAreaElement>(null)
  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  useEffect(() => { resize() }, [value])
  useEffect(() => { resize() }, [])
  return (
    <textarea
      {...props}
      ref={ref}
      value={value}
      onChange={(e) => { onChange?.(e); resize() }}
      className={`w-full px-3 py-2.5 rounded-[16px] border bg-transparent text-[16px] outline-none resize-none leading-[1.55] ${className}`}
      style={{
        borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)',
        color: 'var(--t1)',
        fontFamily: 'var(--font-body)',
        minHeight: '6.5em',
        maxHeight: '60vh',
        overflowY: 'auto',
        ...style,
      }}
    />
  )
}

function CancelReasonInput({ onSubmit, onCancel, label }: {
  onSubmit: (reason: string) => void
  onCancel: () => void
  label: string
}) {
  const [val, setVal] = useState('')
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border p-4" style={{ borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)', background: 'color-mix(in srgb, var(--bg-2) 76%, var(--bg) 24%)' }}>
      <div className="text-[12px] uppercase tracking-[0.14em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>{label}</div>
      <input
        autoFocus
        type="text"
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSubmit(val.trim()); if (e.key === 'Escape') onCancel() }}
        placeholder="optional"
        className="px-3 py-2 rounded-[14px] border bg-transparent text-[15px] outline-none"
        style={{ borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
      />
      <div className="flex gap-2">
        <ActionBtn onClick={() => onSubmit(val.trim())} variant="primary">Absage speichern</ActionBtn>
        <ActionBtn onClick={onCancel}>Abbrechen</ActionBtn>
      </div>
    </div>
  )
}

function RescheduleInput({ initialDate, initialTime, onSubmit, onCancel }: {
  initialDate: string
  initialTime: string
  onSubmit: (date: string, time: string) => void
  onCancel: () => void
}) {
  const [date, setDate] = useState(initialDate)
  const [time, setTime] = useState(initialTime)
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border p-4" style={{ borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)', background: 'color-mix(in srgb, var(--bg-2) 76%, var(--bg) 24%)' }}>
      <div className="text-[12px] uppercase tracking-[0.14em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Neuer Slot</div>
      <div className="flex gap-2">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="naked-date-time px-3 py-2 rounded-[14px] border bg-transparent text-[15px] outline-none" style={{ borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }} />
        <input type="time" value={time} onChange={e => setTime(e.target.value)} className="naked-date-time px-3 py-2 rounded-[14px] border bg-transparent text-[15px] outline-none" style={{ borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }} />
      </div>
      <div className="flex gap-2">
        <ActionBtn onClick={() => onSubmit(date, time)} variant="primary">Verschieben</ActionBtn>
        <ActionBtn onClick={onCancel}>Abbrechen</ActionBtn>
      </div>
    </div>
  )
}

function findEventConflicts(events: PtEvent[], startIso: string, durMin: number, excludeId: string): { title: string; startIso: string; durationMin: number }[] {
  const start = new Date(startIso).getTime()
  const end = start + durMin * 60000
  if (!isFinite(start) || durMin <= 0) return []
  const hits: { title: string; startIso: string; durationMin: number }[] = []
  for (const e of events) {
    if (!e || e.id === excludeId) continue
    if (e.source === 'fokus-overdue') continue
    const isCancelled = e.status === 'cancelled_by_customer' || e.status === 'cancelled_by_trainer' || e.status === 'cancelled'
    if (isCancelled) continue
    const s2 = new Date(e.startIso).getTime()
    const d2 = Math.max(1, e.durationMin || 60)
    const e2 = s2 + d2 * 60000
    if (!isFinite(s2)) continue
    if (start < e2 && end > s2) hits.push({ title: e.customer?.name || e.title, startIso: e.startIso, durationMin: d2 })
  }
  return hits
}

function EventSheet({ ev, onClose, onMutated, allEvents }: { ev: PtEvent; onClose: () => void; onMutated: () => void; allEvents: PtEvent[] }) {
  const isPt = ev.source === 'ptdesk'
  const isOverdue = ev.source === 'fokus-overdue'
  const isEditable = !isOverdue

  const [customer, setCustomer] = useState<PtCustomer | null>(null)
  const [status, setStatus] = useState(ev.status)
  const [busy, setBusy] = useState(false)
  const [showReschedule, setShowReschedule] = useState(false)
  const [showCancelReason, setShowCancelReason] = useState<null | 'customer' | 'trainer'>(null)
  const [confirmDelete, setConfirmDelete] = useState<null | 'single' | 'series'>(null)
  const [conflictPending, setConflictPending] = useState<null | { conflicts: { title: string; startIso: string; durationMin: number }[]; confirm: () => void }>(null)

  const d = new Date(ev.startIso)
  const startMin = d.getHours() * 60 + d.getMinutes()
  const dur = Math.max(15, ev.durationMin || 60)
  const endMin = startMin + dur
  const dayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const timeStr = `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`

  const cname = ev.customer?.name || ev.title

  const [editTitle, setEditTitle] = useState(ev.title)
  const [editDate, setEditDate] = useState(dayIso)
  const [editTime, setEditTime] = useState(timeStr)
  const [editNotes, setEditNotes] = useState(ev.notes || '')
  const [editDur, setEditDur] = useState<number>(dur)
  const [editCategory, setEditCategory] = useState<string>((ev.category || 'privat').toLowerCase())
  const [editLabel, setEditLabel] = useState<string>(ev.label || '')
  const [editRrule, setEditRrule] = useState<'' | 'daily' | 'weekly' | 'monthly'>((ev as any).rrule || '')
  const [editRruleUntil, setEditRruleUntil] = useState<string>((ev as any).rruleUntil || '')
  const [editPersonId, setEditPersonId] = useState<number | null>((ev as any).personId ?? null)
  const [editPersonName, setEditPersonName] = useState<string>((ev as any).personName || '')
  const [personQuery, setPersonQuery] = useState('')
  const [personResults, setPersonResults] = useState<Array<{ person_id?: number; name: string; company?: string }>>([])
  const [personSearchOpen, setPersonSearchOpen] = useState(false)
  const [editDirty, setEditDirty] = useState(false)
  const isPtCategory = editCategory === 'ptdesk'
  const [cardTotalDraft, setCardTotalDraft] = useState('')
  const [cardPriceDraft, setCardPriceDraft] = useState('')
  const [cardMethodDraft, setCardMethodDraft] = useState('')
  const [cardStatusDraft, setCardStatusDraft] = useState('pending')
  const [remainingDraft, setRemainingDraft] = useState('')

  useEffect(() => { setStatus(ev.status) }, [ev.id, ev.status])

  useEffect(() => {
    setEditTitle(ev.title)
    setEditDate(dayIso)
    setEditTime(timeStr)
    setEditNotes(ev.notes || '')
    setEditDur(dur)
    setEditCategory((ev.category || 'privat').toLowerCase())
    setEditLabel(ev.label || '')
    setEditRrule(((ev as any).rrule || '') as '' | 'daily' | 'weekly' | 'monthly')
    setEditRruleUntil((ev as any).rruleUntil || '')
    setEditPersonId((ev as any).personId ?? null)
    setEditPersonName((ev as any).personName || '')
    setPersonQuery('')
    setPersonResults([])
    setPersonSearchOpen(false)
    setEditDirty(false)
  }, [ev.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!personSearchOpen) return
    const q = personQuery.trim()
    if (q.length < 2) { setPersonResults([]); return }
    let alive = true
    const t = setTimeout(() => {
      fetch(`/api/people/search?q=${encodeURIComponent(q)}&limit=8`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(j => { if (alive) setPersonResults((j.results || []).filter((x: any) => x.source === 'person')) })
        .catch(() => { if (alive) setPersonResults([]) })
    }, 180)
    return () => { alive = false; clearTimeout(t) }
  }, [personQuery, personSearchOpen])

  useEffect(() => {
    if (!isPtCategory || !editPersonId) { setCustomer(null); return }
    let alive = true
    fetch(`/api/pt/customer?customer_id=${encodeURIComponent(String(editPersonId))}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && d?.customer) setCustomer(d.customer as PtCustomer) })
      .catch(() => { if (alive) setCustomer(null) })
    return () => { alive = false }
  }, [isPtCategory, editPersonId])

  useEffect(() => {
    if (!customer) {
      setCardTotalDraft('')
      setCardPriceDraft('')
      setCardMethodDraft('')
      setCardStatusDraft('pending')
      setRemainingDraft('')
      return
    }
    setCardTotalDraft(typeof customer.active_card_total_sessions === 'number' ? String(customer.active_card_total_sessions) : '')
    setCardPriceDraft(typeof customer.price_eur === 'number' ? String(customer.price_eur) : '')
    setCardMethodDraft(customer.payment_method || '')
    setCardStatusDraft(customer.payment_status || 'pending')
    setRemainingDraft(typeof customer.remaining_sessions === 'number' ? String(customer.remaining_sessions) : '')
  }, [customer?.id, customer?.active_card_total_sessions, customer?.price_eur, customer?.payment_method, customer?.payment_status, customer?.remaining_sessions])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const ptId = ev.ptId
  const callPtAction = async (path: string, init?: RequestInit) => {
    if (!ptId || busy) return
    setBusy(true)
    try {
      const r = await fetch(`/api/pt/appointment/${ptId}${path}`, { method: 'POST', ...(init || {}) })
      if (r.ok) {
        const data = await r.json()
        if (data?.appointment?.status) setStatus(data.appointment.status)
        if (typeof data?.remaining === 'number' && customer) setCustomer({ ...customer, remaining_sessions: data.remaining })
        onMutated()
      }
    } finally { setBusy(false) }
  }
  const doComplete = () => callPtAction('/complete')
  const doUncomplete = () => callPtAction('/uncomplete')
  const doCancel = (by: 'customer' | 'trainer', reason: string) => callPtAction('/cancel', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by, reason }),
  }).then(() => setShowCancelReason(null))
  const doUncancel = () => callPtAction('/uncancel')
  const doDeletePt = async (scope: 'single' | 'series') => {
    if (!ptId || busy) return
    setBusy(true)
    try {
      const r = await fetch(`/api/pt/appointment/${ptId}?scope=${scope}`, { method: 'DELETE' })
      if (r.ok) { onMutated(); onClose() }
    } finally { setBusy(false) }
  }
  const doReschedule = async (newDate: string, newTime: string) => {
    if (!ptId || busy || !newDate || !newTime) return
    const newIso = `${newDate}T${newTime}:00`
    const run = async () => {
      setBusy(true)
      try {
        const r = await fetch(`/api/pt/appointment/${ptId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: newDate, startTime: newTime }),
        })
        if (r.ok) { onMutated(); setShowReschedule(false) }
      } finally { setBusy(false) }
    }
    const conflicts = findEventConflicts(allEvents, newIso, dur, ev.id)
    if (conflicts.length > 0) { setConflictPending({ conflicts, confirm: run }); return }
    await run()
  }

  const saveEvent = async () => {
    if (busy || !hasSaveChanges) return
    const newIso = `${editDate}T${editTime}:00`
    const newDur = Math.max(5, editDur || 60)
    const run = async () => {
      setBusy(true)
      try {
        let mutated = false
        let shouldClose = false
        if (isPtCategory && ptProfileDirty) {
          const ptResult = await persistPtProfile()
          mutated = mutated || ptResult.mutated
          if (!ptResult.ok) {
            if (mutated) onMutated()
            return
          }
        }
        if (!editDirty) {
          if (mutated) onMutated()
          return
        }
        let r: Response
        if (isPt) {
          if (editCategory !== 'ptdesk') {
            r = await fetch(`/api/pt/appointment/${ptId}/convert-to-calendar`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: editTitle.trim(),
                startIso: newIso,
                durationMin: newDur,
                notes: editNotes,
                category: editCategory,
                label: editLabel,
                rrule: editRrule,
                rruleUntil: editRruleUntil,
                personId: editPersonId,
              }),
            })
            if (r.ok) { mutated = true; shouldClose = true }
          } else {
            r = await fetch(`/api/pt/appointment/${ptId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                date: editDate,
                startTime: editTime,
                durationMin: newDur,
                notes: editNotes,
                personId: editPersonId,
                trainingType: inferPtTrainingType(editTitle.trim(), editLabel),
              }),
            })
            if (r.ok) { mutated = true; setEditDirty(false) }
          }
        } else {
          if (editCategory === 'ptdesk') {
            r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}/convert-to-pt`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: editTitle.trim(),
                startIso: newIso,
                durationMin: newDur,
                notes: editNotes,
                label: editLabel,
                personId: editPersonId,
                trainingType: inferPtTrainingType(editTitle.trim(), editLabel),
              }),
            })
            if (r.ok) { mutated = true; shouldClose = true }
          } else {
            r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: editTitle.trim(),
                startIso: newIso,
                durationMin: newDur,
                notes: editNotes,
                category: editCategory,
                label: editLabel,
                rrule: editRrule,
                rruleUntil: editRruleUntil,
                personId: editPersonId,
              }),
            })
            if (r.ok) { mutated = true; setEditDirty(false) }
          }
        }
        if (mutated) onMutated()
        if (shouldClose) onClose()
      } finally { setBusy(false) }
    }
    if (!editDirty) { await run(); return }
    const conflicts = findEventConflicts(allEvents, newIso, newDur, ev.id)
    if (conflicts.length > 0) { setConflictPending({ conflicts, confirm: run }); return }
    await run()
  }
  const deleteManual = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, { method: 'DELETE' })
      if (r.ok) { onMutated(); onClose() }
    } finally { setBusy(false) }
  }

  const badge = eventBadge(ev)
  const categoryColor = CAL_CATEGORY_COLORS[(ev.category || '').toLowerCase()] || (isPt ? '#7a9fa3' : isOverdue ? '#c87a4a' : '#7a8090')
  const isCancelled = status === 'cancelled_by_customer' || status === 'cancelled_by_trainer' || status === 'cancelled'
  const ptStatusText = status === 'done'
    ? 'Termin lief, Einheit gezogen.'
    : status === 'cancelled_by_customer'
      ? 'Kunde hat abgesagt.'
      : status === 'cancelled_by_trainer'
        ? 'Du hast abgesagt.'
        : ''
  const customerRemainingValue = typeof customer?.remaining_sessions === 'number' ? String(customer.remaining_sessions) : ''
  const customerCardTotalValue = typeof customer?.active_card_total_sessions === 'number' ? String(customer.active_card_total_sessions) : ''
  const customerPriceValue = typeof customer?.price_eur === 'number' ? String(customer.price_eur) : ''
  const customerMethodValue = customer?.payment_method || ''
  const customerStatusValue = customer?.payment_status || 'pending'
  const ptProfileDirty = !!customer && (
    remainingDraft !== customerRemainingValue ||
    cardTotalDraft !== customerCardTotalValue ||
    cardPriceDraft !== customerPriceValue ||
    cardMethodDraft !== customerMethodValue ||
    cardStatusDraft !== customerStatusValue
  )
  const hasSaveChanges = editDirty || ptProfileDirty
  const saveDisabled = busy || !hasSaveChanges || (isPtCategory && !editPersonId)
  const saveVariant = hasSaveChanges ? 'primary' : undefined

  const sheetW = 'min(420px, 92vw)'

  const persistPtProfile = async (): Promise<{ ok: boolean; mutated: boolean }> => {
    if (!editPersonId || !customer) return { ok: false, mutated: false }
    const nextRemaining = parseInt(remainingDraft, 10)
    const remainingChanged = remainingDraft !== customerRemainingValue
    const cardChanged = (
      cardTotalDraft !== customerCardTotalValue ||
      cardPriceDraft !== customerPriceValue ||
      cardMethodDraft !== customerMethodValue ||
      cardStatusDraft !== customerStatusValue
    )
    if (!remainingChanged && !cardChanged) return { ok: true, mutated: false }
    if (remainingChanged && !Number.isFinite(nextRemaining)) return { ok: false, mutated: false }

    let nextCustomer: PtCustomer | null = customer
    let mutated = false
    const finish = (ok: boolean) => {
      if (nextCustomer) setCustomer(nextCustomer)
      return { ok, mutated }
    }

    if (cardChanged) {
      const r = await fetch(`/api/pt/customer/${editPersonId}/card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalSessions: cardTotalDraft === '' ? null : parseInt(cardTotalDraft, 10),
          priceEur: cardPriceDraft === '' ? null : parseInt(cardPriceDraft, 10),
          paymentMethod: cardMethodDraft,
          paymentStatus: cardStatusDraft,
        }),
      })
      if (!r.ok) return finish(false)
      const data = await r.json()
      if (data?.customer) nextCustomer = data.customer as PtCustomer
      mutated = true
    }

    if (remainingChanged) {
      const r = await fetch(`/api/pt/customer/${editPersonId}/remaining`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remaining: nextRemaining }),
      })
      if (!r.ok) return finish(false)
      const data = await r.json()
      if (typeof data?.remaining === 'number') {
        nextCustomer = nextCustomer ? {
          ...nextCustomer,
          remaining_sessions: data.remaining,
          active_card_total_sessions: data.card?.totalSessions ?? nextCustomer.active_card_total_sessions,
          active_card_used_sessions: data.card?.usedSessions ?? nextCustomer.active_card_used_sessions,
        } : nextCustomer
      }
      mutated = true
    }

    return finish(true)
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }}
        onClick={onClose}
      />

      <aside
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col"
        style={{
          width: sheetW,
          background: 'var(--bg-1)',
          borderLeft: '1px solid var(--border-f)',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.4)',
        }}
      >
        <header className="flex items-start justify-between gap-3 px-6 pt-6 pb-5 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-3">
              {badge && (
                <span
                  className="text-[12px] px-1.5 py-0.5 rounded tabular-nums"
                  style={{ color: 'var(--bg)', background: categoryColor, fontFamily: 'var(--font-body)', fontWeight: 700, letterSpacing: '0.04em' }}
                >{badge}</span>
              )}
              <div
                className="text-[13px] tabular-nums"
                style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 500, letterSpacing: '0.04em' }}
              >
                {dayIso} · {fmtMinAsClock(startMin)}–{fmtMinAsClock(endMin)}
              </div>
            </div>
            {isEditable ? (
              <input
                type="text"
                value={editTitle}
                onChange={e => { setEditTitle(e.target.value); setEditDirty(true) }}
                className="w-full bg-transparent border-none outline-none m-0 italic"
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: '25px',
                  lineHeight: '1.2',
                  letterSpacing: '-0.02em',
                  color: 'var(--t1)',
                  fontWeight: 500,
                  padding: 0,
                }}
              />
            ) : (
              <h2
                className="m-0 italic"
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: '25px',
                  lineHeight: '1.2',
                  letterSpacing: '-0.02em',
                  color: 'var(--t1)',
                  fontWeight: 500,
                  textDecoration: isCancelled ? 'line-through' : 'none',
                  opacity: isCancelled ? 0.6 : 1,
                }}
              >{isPt ? cname : ev.title}</h2>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 -m-1.5 cursor-pointer flex-shrink-0"
            style={{ color: 'var(--t3)' }}
            title="Schließen (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {isEditable && (
            <SheetSection title="Termin">
              <div className="flex flex-col gap-3">
                <div>
                  <span className="text-[12px] uppercase tracking-[0.12em] block mb-1.5" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Kategorie</span>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { id: 'privat',      label: 'Privat',      dot: '#9a978f' },
                      { id: 'fch',         label: 'FCH',         dot: '#5fc845' },
                      { id: 'ai-workshop', label: 'AI Workshop', dot: '#a37acf' },
                      { id: 'ai-agent',    label: 'AI Agent',    dot: '#d97a5a' },
                      { id: 'ai-beratung', label: 'AI Beratung', dot: '#e0945a' },
                      { id: 'gecko',       label: 'Beispielkunde',       dot: '#4abca0' },
                      { id: 'ptdesk',      label: 'PT',          dot: '#5a8ec8' },
                      { id: 'admin',       label: 'Admin',       dot: '#8a8e96' },
                    ].map(c => {
                      const active = editCategory === c.id
                      return (
                        <button
                          key={c.id}
                          onClick={() => {
                            setEditCategory(c.id)
                            if (c.id === 'ptdesk') setEditRrule('')
                            setEditDirty(true)
                          }}
                          className="text-[13.5px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                          style={{
                            fontFamily: 'var(--font-body)',
                            fontWeight: 500,
                            color: active ? 'var(--t1)' : 'var(--t2)',
                            background: active
                              ? 'color-mix(in srgb, var(--bg) 30%, var(--bg-2) 70%)'
                              : 'color-mix(in srgb, var(--bg-2) 42%, transparent)',
                            border: active
                              ? '1px solid color-mix(in srgb, var(--border-f) 92%, transparent)'
                              : '1px solid transparent',
                          }}
                        >
                          <span className="inline-block w-2 h-2 rounded-full" style={{ background: c.dot }} />
                          {c.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <SheetField label="Person">
                  {editPersonId && !personSearchOpen ? (
                    <div
                      className="w-full px-3 py-2.5 rounded-[16px] border bg-transparent text-[15px] flex items-center justify-between gap-2"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)',
                        color: 'var(--t1)',
                        fontFamily: 'var(--font-body)',
                      }}
                    >
                      <span className="truncate">{editPersonName || `#${editPersonId}`}</span>
                      <button
                        onClick={() => { setEditPersonId(null); setEditPersonName(''); setPersonSearchOpen(true); setEditDirty(true) }}
                        className="text-[13px] cursor-pointer flex-shrink-0"
                        style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}
                      >entfernen</button>
                    </div>
                  ) : (
                    <div className="relative">
                      <SheetInput
                        type="text"
                        value={personQuery}
                        onChange={e => { setPersonQuery(e.target.value); setPersonSearchOpen(true) }}
                        onFocus={() => setPersonSearchOpen(true)}
                        placeholder="Person suchen…"
                      />
                      {personSearchOpen && personResults.length > 0 && (
                        <div
                          className="absolute z-10 left-0 right-0 mt-1 rounded-[16px] border overflow-hidden"
                          style={{ background: 'var(--bg-1)', borderColor: 'var(--border-f)', boxShadow: '0 6px 18px rgba(0,0,0,0.35)' }}
                        >
                          {personResults.map(r => (
                            <button
                              key={r.person_id}
                              onClick={() => {
                                setEditPersonId(r.person_id as number)
                                setEditPersonName(r.name)
                                if ((editCategory || '').toLowerCase() === 'ptdesk') setEditTitle(r.name)
                                setPersonSearchOpen(false)
                                setPersonQuery('')
                                setEditDirty(true)
                              }}
                              className="w-full text-left px-3 py-2 text-[14.5px] cursor-pointer hover:opacity-80"
                              style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
                            >
                              {r.name}
                              {r.company && <span style={{ color: 'var(--t3)' }}> · {r.company}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </SheetField>

                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_110px_110px] gap-3">
                  <SheetField label="Datum">
                    <SheetInput type="date" value={editDate} onChange={e => { setEditDate(e.target.value); setEditDirty(true) }} className="naked-date-time" />
                  </SheetField>
                  <SheetField label="Zeit">
                    <SheetInput type="time" value={editTime} onChange={e => { setEditTime(e.target.value); setEditDirty(true) }} className="naked-date-time" />
                  </SheetField>
                  <SheetField label="Dauer">
                    <SheetInput type="number" min={5} step={5} value={editDur} onChange={e => { setEditDur(parseInt(e.target.value) || 60); setEditDirty(true) }} className="tabular-nums" />
                  </SheetField>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_110px] gap-3 items-end">
                  <SheetField label="Wiederholung">
                    <SheetSelect value={editRrule} onChange={e => { setEditRrule(e.target.value as '' | 'daily' | 'weekly' | 'monthly'); setEditDirty(true) }} disabled={isPtCategory}>
                      <option value="">Einmalig</option>
                      <option value="daily">Täglich</option>
                      <option value="weekly">Wöchentlich</option>
                      <option value="monthly">Monatlich</option>
                    </SheetSelect>
                  </SheetField>
                  <SheetField label="Label">
                    <SheetInput type="text" value={editLabel} onChange={e => { setEditLabel(e.target.value.toUpperCase().slice(0, 6)); setEditDirty(true) }} className="uppercase tracking-wider" />
                  </SheetField>
                </div>

                {editRrule && !isPtCategory && (
                  <div className="grid grid-cols-1 sm:grid-cols-[160px_minmax(0,1fr)] gap-3">
                    <SheetField label="bis">
                      <SheetInput type="date" value={editRruleUntil} onChange={e => { setEditRruleUntil(e.target.value); setEditDirty(true) }} />
                    </SheetField>
                  </div>
                )}

                <SheetField label="Notiz">
                  <SheetTextarea value={editNotes} onChange={e => { setEditNotes(e.target.value); setEditDirty(true) }} rows={4} placeholder="…" />
                </SheetField>
              </div>
            </SheetSection>
          )}

          {conflictPending && (
            <div className="flex flex-col gap-2.5 p-4 rounded border" style={{ borderColor: 'var(--purple, #c25450)', background: 'rgba(194,84,80,0.06)' }}>
              <div className="text-[13px] uppercase tracking-[0.18em]" style={{ color: 'var(--purple, #c25450)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Konflikt — überschneidet sich mit:</div>
              <ul className="text-[15.5px] leading-[1.5] flex flex-col gap-1" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)' }}>
                {conflictPending.conflicts.map((c, i) => {
                  const d2 = new Date(c.startIso)
                  const s = d2.getHours() * 60 + d2.getMinutes()
                  return (
                    <li key={i}>
                      <span className="tabular-nums" style={{ color: 'var(--t3)', marginRight: '0.5em' }}>{fmtMinAsClock(s)}–{fmtMinAsClock(s + c.durationMin)}</span>
                      {c.title}
                    </li>
                  )
                })}
              </ul>
              <div className="flex gap-2 mt-1">
                <ActionBtn onClick={() => { const c = conflictPending; setConflictPending(null); c.confirm() }} variant="danger">Trotzdem speichern</ActionBtn>
                <ActionBtn onClick={() => setConflictPending(null)}>Abbrechen</ActionBtn>
              </div>
            </div>
          )}

          {isOverdue && (
            <div className="flex flex-col gap-2.5 p-4 rounded border" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
              <div className="text-[12px] uppercase tracking-[0.18em]" style={{ color: 'var(--purple, #c25450)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Fokus-Slot · überfällig</div>
              <div className="text-[16px] leading-[1.6]" style={{ color: 'var(--t-body)', fontFamily: 'var(--font-body)' }}>
                Das ist ein Eintrag aus deinem Fokus, automatisch in eine Lücke gestellt. Plan ihn in der Fokus-Liste neu oder markier ihn dort als erledigt.
              </div>
              {ev.notes && ev.notes.trim() && (
                <div className="whitespace-pre-wrap text-[16px] leading-[1.6]" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)' }}>{ev.notes.trim()}</div>
              )}
            </div>
          )}

          {isPtCategory && customer && (
            <SheetSection title="PT-Daten" tone="soft">
              {ptStatusText && (
                <div
                  className="inline-flex w-fit items-center rounded-full px-3 py-1.5 text-[14px]"
                  style={{
                    color: status === 'done' ? 'var(--green)' : 'var(--t2)',
                    background: 'color-mix(in srgb, var(--bg) 34%, var(--bg-2) 66%)',
                    border: '1px solid color-mix(in srgb, var(--border-f) 72%, transparent)',
                    fontFamily: 'var(--font-body)',
                    fontWeight: 600,
                  }}
                >
                  {ptStatusText}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SheetField label="Rest-Termine">
                  <SheetInput type="number" min={0} value={remainingDraft} onChange={e => setRemainingDraft(e.target.value)} className="tabular-nums" />
                </SheetField>
                <SheetField label="Preis €/Einheit">
                  <SheetInput type="number" min={0} value={cardPriceDraft} onChange={e => setCardPriceDraft(e.target.value)} className="tabular-nums" />
                </SheetField>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SheetField label="Zahlungsart">
                  <PillGroup
                    value={cardMethodDraft}
                    onChange={setCardMethodDraft}
                    allowClear
                    options={[
                      { value: 'cash', label: 'Bar' },
                      { value: 'ec', label: 'EC' },
                      { value: 'transfer', label: 'Überweisung' },
                      { value: 'invoice', label: 'Rechnung' },
                    ]}
                  />
                </SheetField>
                <SheetField label="Zahlungsstatus">
                  <PillGroup
                    value={cardStatusDraft}
                    onChange={setCardStatusDraft}
                    options={[
                      { value: 'pending', label: 'Offen' },
                      { value: 'paid', label: 'Bezahlt' },
                      { value: 'partial', label: 'Teilweise' },
                      { value: 'cancelled', label: 'Storniert' },
                    ]}
                  />
                </SheetField>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <SheetField label="E Mail" className="sm:col-span-2">
                  <SheetInput type="text" readOnly value={customer.email || ''} placeholder="—" />
                </SheetField>
                <SheetField label="Telefon">
                  <SheetInput type="text" readOnly value={customer.phone || ''} placeholder="—" />
                </SheetField>
                <SheetField label="WhatsApp">
                  <SheetInput type="text" readOnly value={customer.whatsapp_chat_id || ''} placeholder="—" />
                </SheetField>
              </div>

              {isPt && (
                <div className="flex flex-col gap-3 pt-1">
                  <div className="text-[12px] uppercase tracking-[0.12em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>
                    Aktionen
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {status === 'scheduled' && (
                      <>
                        <ActionBtn onClick={doComplete} disabled={busy} variant="primary">Termin lief</ActionBtn>
                        <ActionBtn onClick={() => setShowCancelReason('customer')} disabled={busy}>Kunde abgesagt</ActionBtn>
                        <ActionBtn onClick={() => setShowCancelReason('trainer')} disabled={busy}>Ich sage ab</ActionBtn>
                        <ActionBtn onClick={() => setShowReschedule(s => !s)} disabled={busy}>Verschieben</ActionBtn>
                      </>
                    )}
                    {status === 'done' && (
                      <ActionBtn onClick={doUncomplete} disabled={busy} variant="primary">Rückgängig</ActionBtn>
                    )}
                    {(status === 'cancelled_by_customer' || status === 'cancelled_by_trainer') && (
                      <ActionBtn onClick={doUncancel} disabled={busy} variant="primary">Wieder aktivieren</ActionBtn>
                    )}
                  </div>

                  {showCancelReason && (
                    <CancelReasonInput
                      onSubmit={reason => doCancel(showCancelReason, reason)}
                      onCancel={() => setShowCancelReason(null)}
                      label={showCancelReason === 'customer' ? 'Grund (Kunde):' : 'Grund (du):'}
                    />
                  )}
                  {showReschedule && (
                    <RescheduleInput
                      initialDate={dayIso}
                      initialTime={timeStr}
                      onSubmit={doReschedule}
                      onCancel={() => setShowReschedule(false)}
                    />
                  )}
                </div>
              )}
            </SheetSection>
          )}

          {isPt && customer?.notes && customer.notes.trim() && (
            <div className="rounded-[18px] border px-4 py-4" style={{ borderColor: 'color-mix(in srgb, var(--border-f) 72%, transparent)', background: 'color-mix(in srgb, var(--bg-2) 42%, var(--bg) 58%)' }}>
              <div className="text-[12px] uppercase tracking-[0.18em] mb-2" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Kundenhinweis</div>
              <div className="whitespace-pre-wrap text-[16px] leading-[1.6]" style={{ color: 'var(--t-body)', fontFamily: 'var(--font-body)' }}>{customer.notes.trim()}</div>
            </div>
          )}
        </div>

        {isEditable && (
          <div className="border-t flex items-center gap-2 flex-wrap px-6 py-3.5" style={{ borderColor: 'var(--border)' }}>
            {isPt ? (
              <>
                <ActionBtn
                  onClick={() => {
                    if (confirmDelete === 'single') { setConfirmDelete(null); doDeletePt('single') }
                    else { setConfirmDelete('single'); setTimeout(() => setConfirmDelete(c => c === 'single' ? null : c), 4000) }
                  }}
                  disabled={busy}
                  variant="danger"
                >{confirmDelete === 'single' ? 'Wirklich löschen?' : 'Löschen'}</ActionBtn>
                {ev.seriesKey && (
                  <ActionBtn
                    onClick={() => {
                      if (confirmDelete === 'series') { setConfirmDelete(null); doDeletePt('series') }
                      else { setConfirmDelete('series'); setTimeout(() => setConfirmDelete(c => c === 'series' ? null : c), 4000) }
                    }}
                    disabled={busy}
                    variant="danger"
                  >{confirmDelete === 'series' ? 'Serie wirklich löschen?' : 'Serie ab hier löschen'}</ActionBtn>
                )}
              </>
            ) : (
              <ActionBtn
                onClick={() => {
                  if (confirmDelete === 'single') { setConfirmDelete(null); deleteManual() }
                  else { setConfirmDelete('single'); setTimeout(() => setConfirmDelete(c => c === 'single' ? null : c), 4000) }
                }}
                disabled={busy}
                variant="danger"
              >{confirmDelete === 'single' ? 'Wirklich löschen?' : 'Löschen'}</ActionBtn>
            )}
            <div className="flex-1" />
            <ActionBtn onClick={saveEvent} disabled={saveDisabled} variant={saveVariant}>Speichern</ActionBtn>
          </div>
        )}
      </aside>
    </>
  )
}

type PipelineCustomer = {
  id: number
  person_id: number
  status: string
  rate_eur: number | null
  value_eur?: number | null
  notes: string | null
  next_step_text: string | null
  next_step_due: string | null
  categories: string[]
  last_interaction_ts: number | null
  pipeline_stream: string | null
  pipeline_stage: string | null
  workshop_kind: string | null
  lead_source: string | null
  stage_progress?: Record<string, boolean>
  person: {
    id: number
    name: string
    company?: string | null
    email?: string | null
    phone?: string | null
    company_cluster?: string | null
    relation?: string | null
    agent_enabled?: number
    agent_name?: string | null
    agent_system?: string | null
    agent_model?: string | null
    agent_status?: string | null
    agent_notes?: string | null
  } | null
}

type PipelineOffer = {
  token: string
  slug: string
  package?: string | null
  status: string
  sent_at: number | null
  opened_count: number
  last_opened_at: number | null
  accepted_at: number | null
  amount_eur: number | null
  url: string
}
type PipelineCard = {
  kind: 'person' | 'firm'
  id: string
  label: string
  subtitle: string | null
  person_ids: number[]
  members: PipelineCustomer[]
  workshop_kind: string | null
  lead_source: string | null
  value_eur?: number
  next_step_text?: string | null
  missing_next_step?: boolean
  betreuung_done: number
  stage_progress?: Record<string, boolean>
  last_interaction_ts: number | null
  last_real_contact_ts?: number | null
  last_real_contact_dir?: 'in' | 'out' | null
  last_real_contact_kind?: 'whatsapp' | 'email' | null
  ball?: 'me' | 'them' | 'idle'
  days_since_real_contact?: number | null
  attention?: boolean
  attention_days_limit?: number | null
  offer?: PipelineOffer
  archived?: boolean
  terminal?: boolean
  lost?: boolean
  lost_reason?: string | null
  lost_reason_label?: string | null
  lost_at?: number | null
}
type PipelineStage = { id: string; label: string; count: number; fresh_count?: number; terminal?: boolean; value_eur?: number; probability?: number; forecast_eur?: number; cards: PipelineCard[] }
type PipelineStream = { id: string; label: string; stages: PipelineStage[]; count: number; value_eur?: number; forecast_eur?: number; dropped?: PipelineCard[] }
type ChecklistItem = { key: string; label: string }
type PipelineMeta = {
  streams: { id: string; label: string }[]
  stages: Record<string, { id: string; label: string; terminal?: boolean }[]>
  end_stages?: Record<string, string[]>
  end_stage_fresh_days?: number
  workshop_kinds: string[]
  lead_sources: string[]
  lead_source_labels?: Record<string, string>
  stage_probability?: Record<string, Record<string, number>>
  betreuung_total: number
  stage_checklists?: Record<string, Record<string, ChecklistItem[]>>
}

function fmtEur(n: number | null | undefined): string {
  if (!n || n <= 0) return ''
  return n.toLocaleString('de-DE') + ' €'
}
function fmtEurShort(n: number | null | undefined): string {
  if (!n || n <= 0) return ''
  if (n >= 1000) {
    const k = n / 1000
    return (k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace('.', ',')) + 'k'
  }
  return String(n)
}

function relativeDays(ts: number | null): string {
  if (!ts) return '—'
  const d = Math.floor((Date.now() - ts * 1000) / 86400000)
  if (d <= 0) return 'heute'
  if (d === 1) return 'gestern'
  if (d < 14) return `vor ${d} T`
  if (d < 60) return `vor ${Math.floor(d / 7)} W`
  return `vor ${Math.floor(d / 30)} Mo`
}

type FocusView = 'week' | 'pipeline' | 'projects' | 'marketing' | 'atlas'

type PersonAgent = {
  id?: number
  person_id?: number | null
  company_cluster?: string | null
  project_slug?: string | null
  name: string
  system?: string | null
  model?: string | null
  status?: string | null
  workspace?: string | null
  notes?: string | null
  stage_progress?: Record<string, boolean>
  next_step_text?: string | null
  next_step_due?: string | null
  scope_start_date?: string | null
  scope_weeks?: number | null
  scope_done_date?: string | null
  created_at?: number | null
  updated_at?: number | null
  last_activity?: { summary?: string | null; source?: string | null; created_at?: number | null } | null
  is_primary?: number
}

type AgentWorkflowGroup = {
  stage: { id: string; label: string; terminal?: boolean }
  items: ChecklistItem[]
}

type AgentSuggestion = {
  id: number
  agent_id: number
  person_id: number
  kind: string
  title: string
  body: string
  source_kind: string
  source_ref: string
  source_label?: string | null
  source_ts?: number | null
  confidence: number
  status: 'new' | 'reviewed' | 'dismissed' | 'applied'
  created_at: number
  updated_at: number
}

type AgentProject = {
  id: string
  customer: string
  agent: string
  system?: string
  model?: string
  status: string
  phase: string
  health: 'gut' | 'klaeren' | 'wartet' | 'abgeschlossen'
  next: string
  nextDue?: string | null
  scopeStart?: string | null
  scopeWeeks?: number | null
  scopeDone?: string | null
  scopeBonus?: string | null
  nextAppointment?: { id: number | string; start_iso: string; title: string } | null
  kpi: string
  signal: string
  owner: string
  updated: string
  done: string[]
  personIds: number[]
  agentId?: number | null
  streamId: string
  stageId: string
  stageLabel: string
  card?: PipelineCard
  offer?: PipelineOffer
  stageProgress: Record<string, boolean>
  workflow: AgentWorkflowGroup[]
  nextWorkflowStep?: { stage: { id: string; label: string; terminal?: boolean }; item: ChecklistItem } | null
  progressDone: number
  progressTotal: number
  missing: string[]
  lastActivity?: { summary?: string | null; source?: string | null; created_at?: number | null } | null
  ball?: 'me' | 'them' | 'idle'
  lastRealContactTs?: number | null
  attention?: boolean
  priorityScore?: number
}

const PROJECT_PHASES = ['Angebot', 'Zahlung', 'Kick-off', 'Setup', 'KPIs', 'Betrieb', 'Ausbau']
const PROJECT_COMPLETE_COLOR = 'var(--cc-green, #7f9f6a)'
const AGENT_PHASE_LABELS: Record<string, string> = {
  angebot: 'Angebot',
  onboarding: 'Kickoff',
  aufbau: 'Aufbau',
  golive: 'Go-Live',
  betreuung: 'Betreuung',
  abgeschlossen: 'Abgeschlossen',
}
const FALLBACK_AGENT_WORKFLOW: AgentWorkflowGroup[] = PROJECT_PHASES.map(label => ({
  stage: { id: label.toLowerCase(), label },
  items: [{ key: 'done', label }],
}))

const AGENT_PROJECTS: AgentProject[] = []

function projectHealthStyle(health: AgentProject['health']): { label: string; color: string; bg: string; border: string } {
  if (health === 'abgeschlossen') return { label: 'abgeschlossen', color: 'var(--cc-green, #7f9f6a)', bg: 'rgba(127,159,106,0.14)', border: 'rgba(127,159,106,0.34)' }
  if (health === 'gut') return { label: 'läuft', color: 'var(--cc-green, #7f9f6a)', bg: 'rgba(127,159,106,0.10)', border: 'rgba(127,159,106,0.24)' }
  if (health === 'klaeren') return { label: 'klären', color: 'var(--cc-orange)', bg: 'rgba(217,122,90,0.10)', border: 'rgba(217,122,90,0.24)' }
  return { label: 'wartet', color: 'var(--t3)', bg: 'var(--bg-2)', border: 'var(--border-f)' }
}

function agentSystemLabel(system?: string): string {
  if (system === 'openclaw') return 'OpenClaw'
  if (system === 'agent-control') return 'Agent Control'
  if (system === 'hermes-agent') return 'Hermes Agent'
  if (system === 'custom') return 'Custom'
  return system || ''
}

function phaseFromAgentStage(stage?: string | null): string {
  if (stage === 'angebot') return 'Angebot'
  if (stage === 'onboarding') return 'Kick-off'
  if (stage === 'aufbau' || stage === 'einrichtung' || stage === 'integrationen' || stage === 'test') return 'Setup'
  if (stage === 'golive' || stage === 'betreuung' || stage === 'abgeschlossen') return 'Betrieb'
  return 'Setup'
}

function agentOfferText(offer?: PipelineOffer): string {
  if (!offer) return 'Kein Angebot verknüpft'
  const amount = offer.amount_eur ? `${offer.amount_eur.toLocaleString('de-DE')} €` : 'Betrag offen'
  const source = (offer.package || '').toLowerCase().includes('pdf') ? ' · PDF' : ''
  if (offer.status === 'accepted') return `Bestätigt · ${amount}${source}`
  if (offer.status === 'declined' || offer.status === 'lost') return `Abgelehnt · ${amount}${source}`
  if (offer.status === 'archived') return `Archiv · ${amount}${source}`
  if (offer.sent_at) return `Gesendet · ${amount} · ${offer.opened_count || 0} Views`
  return `Angebot angelegt · ${amount}`
}

function agentOfferHref(offer?: PipelineOffer): string {
  const url = (offer?.url || '').trim()
  if (!url) return ''
  if (/^https?:\/\//i.test(url) || url.startsWith('/')) return url
  return `/api/fs/download?path=${encodeURIComponent(url)}&inline=1`
}

function AgentOfferValue({ offer }: { offer?: PipelineOffer }) {
  const href = agentOfferHref(offer)
  return (
    <>
      <span>{agentOfferText(offer)}</span>
      {href ? (
        <>
          <br />
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cc-orange)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
            Angebot öffnen
          </a>
        </>
      ) : null}
    </>
  )
}

function projectWorkflowProgress(workflow: AgentWorkflowGroup[], sp: Record<string, boolean>) {
  const rows = workflow.flatMap(g => g.items.map(item => ({ stage: g.stage, item })))
  const done = rows.filter(row => sp[`${row.stage.id}:${row.item.key}`]).length
  const next = rows.find(row => !sp[`${row.stage.id}:${row.item.key}`]) || null
  return { done, total: rows.length, next }
}

function doneProjectPhases(phase: string): string[] {
  const idx = PROJECT_PHASES.indexOf(phase)
  return idx > 0 ? PROJECT_PHASES.slice(0, idx) : []
}

function projectProgressSegments(done: number, total: number): number {
  if (!total || done <= 0) return 0
  return Math.min(PROJECT_PHASES.length, Math.max(1, Math.ceil((done / total) * PROJECT_PHASES.length)))
}

function parseIsoDay(value?: string | null): number | null {
  if (!value) return null
  const t = new Date(`${value.slice(0, 10)}T00:00:00`).getTime()
  return Number.isNaN(t) ? null : t
}

function daysUntilIsoDay(value?: string | null): number | null {
  const t = parseIsoDay(value)
  if (t == null) return null
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  return Math.round((t - start) / 86400000)
}

function isoDayFromUnix(ts?: number | null): string | null {
  if (!ts) return null
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addIsoDays(value?: string | null, days = 0): string | null {
  const t = parseIsoDay(value)
  if (t == null) return null
  const d = new Date(t + days * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isoWeekLabel(value?: string | null): string {
  const t = parseIsoDay(value)
  if (t == null) return 'KW —'
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const week1 = new Date(d.getFullYear(), 0, 4)
  return `KW ${String(1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)).padStart(2, '0')}`
}

function projectDueLabel(value?: string | null): string {
  const days = daysUntilIsoDay(value)
  if (days == null) return 'kein Datum'
  if (days < 0) return `${Math.abs(days)} T überfällig`
  if (days === 0) return 'heute fällig'
  if (days === 1) return 'morgen fällig'
  return `fällig in ${days} T`
}

function scopeLabel(start?: string | null, done?: string | null, bonus?: string | null, weeks?: number | null): string {
  if (!start || !done) return 'Scope offen'
  return `${start.slice(8, 10)}.${start.slice(5, 7)} ${isoWeekLabel(start)} · ${weeks || 4}W · Ziel ${done.slice(8, 10)}.${done.slice(5, 7)} · Bonus ab ${bonus ? `${bonus.slice(8, 10)}.${bonus.slice(5, 7)}` : '—'}`
}

function projectEventLabel(event?: AgentProject['nextAppointment']): string {
  if (!event?.start_iso) return 'kein Termin'
  const d = new Date(event.start_iso)
  if (Number.isNaN(d.getTime())) return event.title || 'Termin geplant'
  return `${d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${event.title ? ` · ${event.title}` : ''}`
}

function projectPriority(project: AgentProject): number {
  if (project.health === 'abgeschlossen') return -10000
  const dueDays = daysUntilIsoDay(project.nextDue)
  const contactAge = project.lastRealContactTs ? Math.floor((Date.now() - project.lastRealContactTs * 1000) / 86400000) : 45
  let score = 0
  if (project.attention) score += 120
  if (project.ball === 'me') score += 80
  if (project.ball === 'them') score -= 25
  if (dueDays != null) score += dueDays < 0 ? 90 : Math.max(0, 35 - dueDays * 5)
  if (!project.nextAppointment) score += 18
  score += Math.min(40, Math.max(0, contactAge))
  score += project.missing.length * 8
  return score
}

function AgentKpiValue({ text }: { text: string }) {
  const raw = (text || '').trim()
  if (!raw) return <span>KPIs noch festlegen.</span>
  const marker = raw.match(/\bKPIs?:\s*/i)
  const intro = marker?.index != null ? raw.slice(0, marker.index).trim() : ''
  const kpiRaw = marker?.index != null ? raw.slice(marker.index + marker[0].length).trim() : raw
  const numbered = kpiRaw
    .split(/\s+(?=\d+\)\s+)/)
    .map(s => s.replace(/^\d+\)\s*/, '').trim())
    .filter(Boolean)
  const items = numbered.length > 1
    ? numbered
    : kpiRaw.split(/\n+|;\s+|\s·\s/).map(s => s.trim()).filter(Boolean)
  if (items.length <= 1 && !intro) return <span>{raw}</span>
  return (
    <div className="flex flex-col gap-3">
      {intro ? (
        <div style={{ color: 'var(--t2)', fontSize: '13.5px', lineHeight: 1.5 }}>{intro}</div>
      ) : null}
      <div className="flex flex-col gap-2">
        {items.map((item, idx) => {
          const [head, ...rest] = item.split(':')
          const hasBody = rest.length > 0
          return (
            <div key={`${idx}-${item.slice(0, 24)}`} className="flex gap-2.5">
              <span className="shrink-0 inline-flex items-center justify-center rounded-full tabular-nums"
                    style={{ width: 22, height: 22, color: 'var(--cc-orange)', background: 'rgba(217,122,90,0.10)', border: '1px solid rgba(217,122,90,0.24)', fontSize: '11px', fontWeight: 700 }}>
                {idx + 1}
              </span>
              <div className="min-w-0" style={{ lineHeight: 1.45 }}>
                <div style={{ color: 'var(--t1)', fontSize: '14px', fontWeight: 650 }}>{hasBody ? head.trim() : item}</div>
                {hasBody ? <div style={{ color: 'var(--t2)', fontSize: '13px', marginTop: 2 }}>{rest.join(':').trim()}</div> : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ProjectOverviewView() {
  const [projects, setProjects] = useState<AgentProject[]>(AGENT_PROJECTS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([])

  const reload = useCallback(async () => {
    const r = await fetch('/api/customers')
    const d = await r.json()
    const pipelineMeta = d.pipeline_meta || null
    const agentStages = pipelineMeta?.stages?.agent || []
    const workflow: AgentWorkflowGroup[] = agentStages
      .map((stage: { id: string; label: string; terminal?: boolean }) => ({
        stage,
        items: pipelineMeta?.stage_checklists?.agent?.[stage.id] || [],
      }))
      .filter((g: AgentWorkflowGroup) => g.items.length > 0)
    const agentStream = (d.pipeline || []).find((s: PipelineStream) => s.id === 'agent')
    const personIds = new Set<number>()
    for (const stage of agentStream?.stages || []) {
      for (const card of stage.cards || []) {
        for (const member of card.members || []) {
          if (member.person_id) personIds.add(member.person_id)
        }
      }
    }
    const agentLists = new Map<number, PersonAgent[]>()
    await Promise.all(Array.from(personIds).map(async pid => {
      try {
        const detail = await fetch(`/api/people/get?id=${pid}`).then(res => res.json())
        if (Array.isArray(detail.agents)) agentLists.set(pid, detail.agents)
      } catch {}
    }))
    const crmByPid = new Map<number, Pick<PersonCrmStatus, 'upcoming_events' | 'last_touch'>>()
    await Promise.all(Array.from(personIds).map(async pid => {
      try {
        const status = await fetch(`/api/people/${pid}/crm-status`).then(res => res.json())
        crmByPid.set(pid, {
          upcoming_events: Array.isArray(status.upcoming_events) ? status.upcoming_events : [],
          last_touch: status.last_touch || null,
        })
      } catch {}
    }))
    const cards: AgentProject[] = []
    for (const stage of agentStream?.stages || []) {
      for (const card of stage.cards || []) {
        const members = card.members || []
        const candidates: { member: PipelineCustomer; agent: PersonAgent }[] = []
        for (const member of members) {
          const person = member.person
          const agents = agentLists.get(member.person_id) || []
          if (agents.length) {
            for (const agent of agents) candidates.push({ member, agent })
          } else if (person?.agent_enabled || person?.agent_name) {
            candidates.push({
              member,
              agent: {
                person_id: member.person_id,
                company_cluster: person.company_cluster || null,
                name: person.agent_name || 'Agent',
                system: person.agent_system || '',
                model: person.agent_model || '',
                status: person.agent_status || '',
                notes: person.agent_notes || '',
                is_primary: 1,
              },
            })
          }
        }
        const deduped = new Map<string, { member: PipelineCustomer; agent: PersonAgent }>()
        for (const row of candidates) {
          const cluster = row.agent.company_cluster || row.member.person?.company_cluster || String(row.member.person_id)
          const key = `${cluster}:${(row.agent.name || '').toLowerCase()}`
          if (!deduped.has(key) || row.agent.is_primary) deduped.set(key, row)
        }
        for (const { member, agent } of deduped.values()) {
	          const person = member.person
	          const sp = agent.stage_progress || card.stage_progress || {}
	          const progress = projectWorkflowProgress(workflow, sp)
	          const workflowComplete = progress.total > 0 && progress.done >= progress.total
	          const agentStageId = workflowComplete ? 'abgeschlossen' : (progress.next?.stage.id || stage.id)
	          const agentStageMeta = agentStages.find((s: { id: string; label: string; terminal?: boolean }) => s.id === agentStageId)
	          const agentStageLabel = agentStageMeta?.label || (workflowComplete ? 'Abgeschlossen' : stage.label)
	          const phase = phaseFromAgentStage(agentStageId)
	          const noOpenStepNeeded = workflowComplete
	          const agentNextText = agent.next_step_text && !agent.next_step_text.includes('nächster Agent-Schritt prüfen') ? agent.next_step_text : null
	          const nextText = noOpenStepNeeded
	            ? 'Projekt abgeschlossen; nur bei neuem Kundenwunsch wieder öffnen.'
	            : agentNextText || progress.next?.item.label || member.next_step_text || 'Nächsten prüfbaren Schritt festlegen.'
	          const nextDue = agent.next_step_due || member.next_step_due || null
	          const scopeWeeks = Math.max(1, Math.min(52, Number(agent.scope_weeks || 4)))
	          const scopeStart = agent.scope_start_date || isoDayFromUnix(agent.created_at) || null
	          const scopeDone = agent.scope_done_date || addIsoDays(scopeStart, scopeWeeks * 7)
	          const scopeBonus = scopeDone ? addIsoDays(scopeDone, 1) : null
	          const relevantPersonIds = Array.from(new Set([agent.person_id || member.person_id, ...card.person_ids].filter(Boolean) as number[]))
	          const nextAppointment = relevantPersonIds
	            .flatMap(pid => crmByPid.get(pid)?.upcoming_events || [])
	            .sort((a, b) => (a.start_iso || '').localeCompare(b.start_iso || ''))[0] || null
	          const missing = [
	            !card.offer && !noOpenStepNeeded ? 'Angebot' : '',
	            !(agent.notes || person?.agent_notes || member.notes) ? 'KPIs' : '',
	            !(agentNextText || progress.next?.item || member.next_step_text) && !noOpenStepNeeded ? 'Nächster Schritt' : '',
	          ].filter(Boolean)
	          const project: AgentProject = {
            id: `${card.id}:${(agent.name || 'agent').toLowerCase().replace(/\s+/g, '-')}`,
            customer: card.label,
            agent: agent.name || person?.agent_name || 'Agent',
            system: agentSystemLabel(agent.system || person?.agent_system || ''),
            model: agent.model || person?.agent_model || '',
            status: workflowComplete ? 'Abgeschlossen' : agent.status || person?.agent_status || agentStageLabel,
            phase,
	            health: noOpenStepNeeded ? 'abgeschlossen' : card.attention ? 'klaeren' : progress.next ? 'wartet' : 'gut',
	            next: nextText,
            nextDue,
            scopeStart,
            scopeWeeks,
            scopeDone,
            scopeBonus,
            nextAppointment,
            kpi: agent.notes || person?.agent_notes || member.notes || 'KPIs noch festlegen und hier speichern.',
            signal: `${stage.label}${card.ball === 'me' ? ' · Ball bei Christian' : card.ball === 'them' ? ' · wartet auf Kunde' : ''}`,
            owner: 'Christian',
            updated: relativeDays(card.last_interaction_ts),
            done: workflowComplete ? PROJECT_PHASES : doneProjectPhases(phase),
            personIds: card.person_ids,
            agentId: agent.id || null,
            streamId: 'agent',
            stageId: agentStageId,
            stageLabel: agentStageLabel,
            card,
            offer: card.offer,
            stageProgress: sp,
            workflow,
            nextWorkflowStep: progress.next,
            progressDone: progress.done,
            progressTotal: progress.total,
            missing,
            lastActivity: agent.last_activity || null,
            ball: card.ball || 'idle',
            lastRealContactTs: card.last_real_contact_ts || null,
            attention: !!card.attention,
          }
          project.priorityScore = projectPriority(project)
	          cards.push(project)
        }
      }
    }
    cards.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0) || (b.lastRealContactTs || 0) - (a.lastRealContactTs || 0) || a.customer.localeCompare(b.customer, 'de'))
    if (cards.length > 0) setProjects(cards)
    setSelectedId(prev => prev && cards.some(p => p.id === prev) ? prev : null)
  }, [])

  useEffect(() => {
    reload()
      .catch(() => {})
  }, [reload])

  const activeAgents = projects.length
  const openNext = projects.filter(p => p.nextWorkflowStep || p.missing.length > 0).length
  const inCustomerHands = projects.filter(p => p.stageId === 'golive' || p.stageId === 'betreuung' || p.phase === 'Betrieb').length
  const selected = projects.find(p => p.id === selectedId) || null
  const [scopeStartDraft, setScopeStartDraft] = useState('')
  const [scopeWeeksDraft, setScopeWeeksDraft] = useState('4')
  const [scopeSaved, setScopeSaved] = useState(false)

  useEffect(() => {
    if (!selected || !selected.personIds.length) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const pid = selected.personIds[0]
    const qs = selected.agentId ? `?agent_id=${selected.agentId}` : ''
    fetch(`/api/people/${pid}/agent-suggestions${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!cancelled) setSuggestions(Array.isArray(d?.suggestions) ? d.suggestions : [])
      })
      .catch(() => { if (!cancelled) setSuggestions([]) })
    return () => { cancelled = true }
  }, [selected?.id, selected?.agentId, selected?.personIds])

  const toggleStep = useCallback(async (project: AgentProject, stageId: string, itemKey: string, done: boolean) => {
    if (!project.personIds.length) return
    await fetch('/api/customers/check-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_ids: project.personIds, agent_id: project.agentId || null, stage_id: stageId, item_key: itemKey, done, stream: 'agent' }),
    })
    await reload()
  }, [reload])

	  const updateSuggestionStatus = useCallback(async (id: number, status: AgentSuggestion['status']) => {
	    await fetch(`/api/people/agent-suggestions/${id}/status`, {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ status }),
	    })
	    setSuggestions(prev => prev.filter(s => s.id !== id))
	  }, [])

	  useEffect(() => {
	    setScopeStartDraft(selected?.scopeStart || '')
	    setScopeWeeksDraft(String(selected?.scopeWeeks || 4))
	    setScopeSaved(false)
	  }, [selected?.id, selected?.scopeStart, selected?.scopeWeeks])

	  const saveScope = useCallback(async () => {
	    if (!selected?.agentId || !selected.personIds.length) return
	    const weeks = Math.max(1, Math.min(52, parseInt(scopeWeeksDraft || '4', 10) || 4))
	    await fetch(`/api/people/${selected.personIds[0]}/agents/${selected.agentId}/scope`, {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ scope_start_date: scopeStartDraft || null, scope_weeks: weeks }),
	    })
	    setScopeSaved(true)
	    setTimeout(() => setScopeSaved(false), 1400)
	    await reload()
	  }, [reload, scopeStartDraft, scopeWeeksDraft, selected?.agentId, selected?.personIds])

		  if (selected) {
		    const health = projectHealthStyle(selected.health)
		    const scopeDoneDraft = scopeStartDraft ? addIsoDays(scopeStartDraft, (parseInt(scopeWeeksDraft || '4', 10) || 4) * 7) : null
		    const scopeBonusDraft = scopeDoneDraft ? addIsoDays(scopeDoneDraft, 1) : null
		    const detailRows: { label: string; value: ReactNode }[] = [
		      { label: 'Nächster Schritt', value: selected.next },
		      { label: 'Scope', value: scopeLabel(selected.scopeStart, selected.scopeDone, selected.scopeBonus, selected.scopeWeeks) },
		      { label: 'KPIs / Zielbild', value: <AgentKpiValue text={selected.kpi} /> },
	      { label: 'Signal', value: selected.signal },
      {
        label: 'Letzte Änderung',
        value: selected.lastActivity?.summary
          ? `${selected.lastActivity.summary}${selected.lastActivity.source ? ` · ${selected.lastActivity.source}` : ''}${selected.lastActivity.created_at ? ` · ${relativeDays(selected.lastActivity.created_at)}` : ''}`
          : 'Noch kein Log-Eintrag',
      },
      { label: 'Angebotsdaten', value: <AgentOfferValue offer={selected.offer} /> },
    ]
    return (
      <div className="flex-1 overflow-y-auto" style={{ background: 'var(--bg)' }}>
        <div className="px-10 py-8 max-w-[1500px] mx-auto flex flex-col gap-5">
          <div className="flex items-start gap-4 pb-4" style={{ borderBottom: '1px solid var(--border-f)' }}>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="text-[14px] px-3 py-1.5 rounded-full cursor-pointer"
              style={{ color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)', fontFamily: 'var(--font-body)' }}
            >Zurück</button>
            <div className="min-w-0">
              <div className="text-[13px] uppercase tracking-[0.16em] mb-2" style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Projektakte</div>
              <h2 className="m-0 italic" style={{ fontFamily: 'var(--font-heading)', fontSize: '34px', fontWeight: 500, color: 'var(--t1)', lineHeight: 1 }}>{selected.customer}</h2>
              <div className="mt-2 text-[15px]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)' }}>
                {selected.agent} · {selected.system || 'System offen'}{selected.model ? ` · ${selected.model}` : ''} · Quelle: PeopleDB + Agent-Pipeline
              </div>
            </div>
            <span className="ml-auto text-[12.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-full"
                  style={{ color: health.color, background: health.bg, border: `1px solid ${health.border}`, fontFamily: 'var(--font-body)', fontWeight: 700 }}>{health.label}</span>
          </div>

	          <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)] gap-5 items-start">
	            <section className="rounded-[10px] overflow-hidden" style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)' }}>
	              <div className="px-6 py-5" style={{ borderBottom: '1px solid var(--border-f)' }}>
	                <div className="text-[13px] uppercase tracking-[0.16em] mb-4" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Projektstand</div>
	                <div className="grid grid-cols-3 gap-6">
	                  {[
	                    ['Stand', selected.stageLabel || selected.phase],
	                    ['Nächster Haken', selected.nextWorkflowStep?.item.label || 'Ablauf komplett'],
	                    ['Angebot', agentOfferText(selected.offer)],
	                  ].map(([label, value]) => (
	                    <div key={label} className="min-w-0">
	                      <div className="text-[12px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>{label}</div>
	                      <div className="truncate" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', fontSize: '15.5px', lineHeight: 1.35 }}>{value}</div>
	                    </div>
	                  ))}
	                </div>
	              </div>
	              <div className="px-6 pt-5 pb-1">
	                <div className="text-[13px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Fester Ablauf</div>
	              </div>
	              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-6 pb-5 pt-3">
	                {(selected.workflow.length ? selected.workflow : FALLBACK_AGENT_WORKFLOW).map(group => {
	                  const doneCount = group.items.filter(it => selected.stageProgress[`${group.stage.id}:${it.key}`]).length
	                  const active = group.stage.id === selected.stageId
	                  return (
	                    <div key={group.stage.id} className="py-3"
	                         style={{ borderTop: '1px solid var(--border-f)', background: 'transparent' }}>
	                      <div className="flex items-baseline gap-2 mb-2">
	                        <span className="text-[13px] uppercase tracking-[0.14em]" style={{ color: active ? 'var(--cc-orange)' : 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>
	                          {AGENT_PHASE_LABELS[group.stage.id] || group.stage.label}
	                        </span>
	                        <span className="ml-auto text-[13.5px] tabular-nums" style={{ color: doneCount === group.items.length ? 'var(--cc-orange)' : 'var(--t3)', fontFamily: 'var(--font-body)' }}>
	                          {doneCount}/{group.items.length}
	                        </span>
	                      </div>
                      <div className="flex flex-col">
                        {group.items.map(it => {
                          const done = !!selected.stageProgress[`${group.stage.id}:${it.key}`]
                          const isNext = selected.nextWorkflowStep?.stage.id === group.stage.id && selected.nextWorkflowStep?.item.key === it.key
                          return (
                            <button
	                              key={it.key}
	                              type="button"
	                              onClick={() => toggleStep(selected, group.stage.id, it.key, !done)}
	                              className="flex items-center gap-3 py-1.5 text-left text-[16px] transition-colors cursor-pointer rounded-[6px]"
	                              style={{ background: 'transparent', color: done ? 'var(--t3)' : 'var(--t1)', fontFamily: 'var(--font-body)', width: '100%' }}
	                              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-2)' }}
	                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
	                            >
	                              <span className="inline-flex items-center justify-center rounded-full shrink-0"
	                                    style={{ width: 18, height: 18, border: done ? '1px solid var(--accent)' : `1.5px solid ${isNext ? 'var(--cc-orange)' : 'var(--t3)'}`, background: done ? 'var(--accent)' : 'transparent', color: 'var(--accent-fg)', fontSize: 10, fontWeight: 700 }}>{done ? '✓' : ''}</span>
	                              <span className={done ? 'line-through' : ''}>{it.label}</span>
	                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
	            </section>

	            <aside className="rounded-[10px] overflow-hidden" style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)' }}>
		              <div className="p-5" style={{ borderBottom: '1px solid var(--border-f)' }}>
		                <div className="text-[12px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Fortschritt</div>
		                <div style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontSize: '32px', lineHeight: 1, fontWeight: 500 }}>
		                  {selected.progressDone}/{selected.progressTotal || '—'}
		                </div>
		              </div>
		              <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-f)' }}>
		                <div className="flex items-baseline gap-2 mb-3">
		                  <div className="text-[12px] uppercase tracking-[0.15em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Scope-Zeit</div>
		                  {scopeSaved ? <span className="text-[12.5px]" style={{ color: 'var(--cc-orange)' }}>gesichert</span> : null}
		                </div>
		                <div className="grid grid-cols-[minmax(0,1fr)_82px] gap-2">
		                  <input
		                    type="date"
		                    value={scopeStartDraft}
		                    disabled={!selected.agentId}
		                    onChange={e => setScopeStartDraft(e.target.value)}
		                    onBlur={saveScope}
		                    className="text-[14.5px] rounded px-2 py-1.5"
		                    style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)' }}
		                    title="Projektstart"
		                  />
		                  <input
		                    type="number"
		                    min={1}
		                    max={52}
		                    value={scopeWeeksDraft}
		                    disabled={!selected.agentId}
		                    onChange={e => setScopeWeeksDraft(e.target.value)}
		                    onBlur={saveScope}
		                    className="text-[14.5px] rounded px-2 py-1.5 tabular-nums"
		                    style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)' }}
		                    title="Wochen"
		                  />
		                </div>
		                <div className="mt-2 text-[13.5px] leading-relaxed" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)' }}>
		                  Ziel {scopeDoneDraft || selected.scopeDone || '—'} · Bonus ab {scopeBonusDraft || selected.scopeBonus || '—'}
		                </div>
		              </div>
		              {suggestions.length ? (
	                <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-f)', background: 'rgba(217,122,90,0.06)' }}>
	                  <div className="flex items-baseline gap-2 mb-3">
	                    <div className="text-[12px] uppercase tracking-[0.15em]" style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Automatik-Hinweise</div>
	                    <span className="text-[12.5px] tabular-nums px-1.5 rounded-full" style={{ color: 'var(--cc-orange)', background: 'var(--bg-2)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>{suggestions.length} neu</span>
	                  </div>
	                  <div className="flex flex-col gap-2.5">
	                    {suggestions.slice(0, 4).map(s => (
	                      <div key={s.id} className="rounded-[8px] p-3" style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)' }}>
	                        <div className="flex items-baseline gap-2 min-w-0">
	                          <span className="text-[15px] truncate" style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}>{s.title}</span>
	                          <span className="ml-auto text-[12px] uppercase shrink-0" style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 700, letterSpacing: '0.12em' }}>neu</span>
	                        </div>
	                        <div className="mt-1 text-[14.5px]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', lineHeight: 1.45 }}>{s.body}</div>
	                        <div className="mt-2 flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>
	                          <span className="truncate">Quelle: {s.source_label || s.source_kind}</span>
	                          <span className="ml-auto tabular-nums">{relativeDays(s.source_ts || s.updated_at)}</span>
	                          <button
	                            type="button"
	                            onClick={() => updateSuggestionStatus(s.id, 'reviewed')}
	                            className="px-2 py-1 rounded-full cursor-pointer"
	                            style={{ color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)', fontFamily: 'var(--font-body)' }}
	                          >gesehen</button>
	                          <button
	                            type="button"
	                            onClick={() => updateSuggestionStatus(s.id, 'dismissed')}
	                            className="px-2 py-1 rounded-full cursor-pointer"
	                            style={{ color: 'var(--t3)', background: 'transparent', border: '1px solid var(--border-f)', fontFamily: 'var(--font-body)' }}
	                          >weg</button>
	                        </div>
	                      </div>
	                    ))}
	                  </div>
	                </div>
	              ) : null}
	              {detailRows.map(({ label, value }) => (
	                <div key={label} className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-f)' }}>
	                  <div className="text-[12px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>{label}</div>
	                  <div style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', fontSize: '15px', lineHeight: 1.5 }}>{value}</div>
	                </div>
	              ))}
	              {selected.missing.length ? (
	                <div className="px-5 py-4" style={{ background: 'rgba(217,122,90,0.08)' }}>
	                  <div className="text-[12px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Fehlt noch</div>
	                  <div style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', fontSize: '15px', lineHeight: 1.45 }}>{selected.missing.join(' · ')}</div>
	                </div>
	              ) : null}
	            </aside>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: 'var(--bg)' }}>
      <div className="px-10 py-8 flex flex-col gap-6 max-w-[1500px] mx-auto">
        <div className="flex items-end gap-5 pb-4" style={{ borderBottom: '1px solid var(--border-f)' }}>
          <div className="min-w-0">
            <div
              className="uppercase mb-2"
              style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.18em' }}
            >Agent-Projekte</div>
            <h2
              className="m-0 italic"
              style={{ fontFamily: 'var(--font-heading)', fontSize: '31px', fontWeight: 500, color: 'var(--t1)', letterSpacing: '-0.025em', lineHeight: 1 }}
            >Kunden im Aufbau</h2>
          </div>
          <div className="grid grid-cols-3 gap-2 ml-auto w-[420px] max-w-[45vw]">
            {[
              ['Projekte', activeAgents],
              ['Klärungen', openNext],
              ['Beim Kunden', inCustomerHands],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[8px] px-3 py-2" style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)' }}>
                <div className="text-[12px] uppercase tracking-[0.15em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>{label}</div>
                <div className="text-[22px] tabular-nums mt-1" style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {projects.map(project => {
            const health = projectHealthStyle(project.health)
            const ballLabel = project.health === 'abgeschlossen'
              ? 'abgeschlossen'
              : project.ball === 'me'
                ? 'du bist dran'
                : project.ball === 'them'
                  ? 'wartet auf Kunde'
                  : 'kein klares Signal'
            const ballColor = project.ball === 'me' || project.attention ? 'var(--cc-orange)' : project.ball === 'them' ? 'var(--t2)' : 'var(--t3)'
            return (
              <article
                key={project.id}
                onClick={() => setSelectedId(project.id)}
                className="min-w-0 rounded-[10px] flex flex-col cursor-pointer transition-colors"
                style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)', minHeight: 276 }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-active)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-f)' }}
              >
                <div className="p-4 pb-3" style={{ borderBottom: '1px solid var(--border-f)' }}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0">
                      <div
                        className="truncate"
                        style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontSize: '22px', fontWeight: 500, letterSpacing: '-0.01em' }}
                      >{project.customer}</div>
                      <div className="mt-1 flex items-baseline gap-2 min-w-0">
                        <span className="text-[14px] uppercase tracking-[0.14em]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Agent</span>
                        <span className="truncate" style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-heading)', fontSize: '18px', fontWeight: 500 }}>{project.agent}</span>
                      </div>
                      {(project.system || project.model) && (
                        <div className="mt-1 text-[13px] truncate" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>
                          {[project.system, project.model].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                    <span
                      className="ml-auto text-[12.5px] uppercase tracking-[0.14em] px-2 py-1 rounded-full"
                      style={{ color: health.color, background: health.bg, border: `1px solid ${health.border}`, fontFamily: 'var(--font-body)', fontWeight: 700 }}
                    >{health.label}</span>
                  </div>

                  <div className="mt-4 flex items-center gap-1">
                    {PROJECT_PHASES.map((phase, idx) => {
                      const complete = project.progressTotal > 0 && project.progressDone >= project.progressTotal
                      const segments = projectProgressSegments(project.progressDone, project.progressTotal)
                      const done = idx < segments - 1
                      const current = !complete && idx === segments - 1
                      return (
                        <div
                          key={phase}
                          className="h-1.5 rounded-full"
                          title={phase}
                          style={{
                            flex: 1,
                            background: complete ? PROJECT_COMPLETE_COLOR : current ? 'var(--cc-orange)' : done ? 'rgba(217,122,90,0.42)' : 'var(--bg-3)',
                          }}
                        />
                      )
                    })}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[13px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>
                    <span>{project.phase}</span>
                    <span>{project.progressTotal ? `${project.progressDone}/${project.progressTotal}` : project.status}</span>
                  </div>
                </div>

                <div className="p-4 flex flex-col gap-3 flex-1">
                  <div>
                    <div className="text-[12.5px] uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Nächster Schritt</div>
                    <p
                      className="m-0"
                      style={{
                        color: 'var(--t1)',
                        fontFamily: 'var(--font-body)',
                        fontSize: '14px',
                        lineHeight: 1.42,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                      title={project.next}
                    >{project.next}</p>
                  </div>
                  <div className="flex flex-col gap-1.5 text-[14.5px]" style={{ fontFamily: 'var(--font-body)' }}>
	                    <div className="flex items-baseline gap-2 min-w-0">
	                      <span className="w-[64px] shrink-0" style={{ color: 'var(--t3)' }}>Status</span>
	                      <span className="truncate" style={{ color: ballColor, fontWeight: project.ball === 'me' || project.attention ? 600 : 400 }}>{ballLabel}</span>
	                      <span className="ml-auto shrink-0 tabular-nums" style={{ color: 'var(--t3)' }}>{project.nextDue ? projectDueLabel(project.nextDue) : project.missing.length ? `${project.missing.length} offen` : ''}</span>
	                    </div>
	                    <div className="flex items-baseline gap-2 min-w-0">
	                      <span className="w-[64px] shrink-0" style={{ color: 'var(--t3)' }}>Scope</span>
	                      <span className="truncate" style={{ color: project.scopeDone ? 'var(--t2)' : 'var(--t3)' }} title={scopeLabel(project.scopeStart, project.scopeDone, project.scopeBonus, project.scopeWeeks)}>
	                        {project.scopeDone ? `Ziel ${project.scopeDone.slice(8, 10)}.${project.scopeDone.slice(5, 7)} · Bonus ${project.scopeBonus ? `${project.scopeBonus.slice(8, 10)}.${project.scopeBonus.slice(5, 7)}` : '—'}` : 'offen'}
	                      </span>
	                    </div>
	                    <div className="flex items-baseline gap-2 min-w-0">
	                      <span className="w-[64px] shrink-0" style={{ color: 'var(--t3)' }}>Kontakt</span>
                      <span className="truncate" style={{ color: project.attention ? 'var(--cc-orange)' : 'var(--t2)', fontWeight: project.attention ? 600 : 400 }}>
                        {project.lastRealContactTs ? relativeDays(project.lastRealContactTs) : project.updated ? `Update ${project.updated}` : 'kein Kontakt'}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="w-[64px] shrink-0" style={{ color: 'var(--t3)' }}>Termin</span>
                      <span className="truncate" style={{ color: project.nextAppointment ? 'var(--t2)' : 'var(--t3)' }} title={projectEventLabel(project.nextAppointment)}>
                        {projectEventLabel(project.nextAppointment)}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="w-[64px] shrink-0" style={{ color: 'var(--t3)' }}>Angebot</span>
                      <span className="truncate" style={{ color: 'var(--t2)' }} title={agentOfferText(project.offer)}>{agentOfferText(project.offer)}</span>
                    </div>
                  </div>
                </div>

                <div className="px-4 py-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--border-f)', color: 'var(--t3)', fontFamily: 'var(--font-body)', fontSize: '12px' }}>
                  <span>{project.owner}</span>
                  <span className="ml-auto">Update {project.updated}</span>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}

type MarketingCampaign = {
  id: number
  name: string
  stage: string
  channel: string | null
  goal: string | null
  notes: string | null
  started_at: number | null
  ended_at: number | null
  created_at: number
  updated_at: number
  lead_count: number
}
type MarketingStage = { id: string; label: string; count: number; campaigns: MarketingCampaign[] }
type MarketingMeta = { stages: { id: string; label: string }[]; channels: string[] }

function MarketingView() {
  const [stages, setStages] = useState<MarketingStage[] | null>(null)
  const [meta, setMeta] = useState<MarketingMeta | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dragging, setDragging] = useState<{ id: number; fromStage: string } | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [edit, setEdit] = useState<MarketingCampaign | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/marketing-campaigns')
      const d = await r.json()
      if (Array.isArray(d.stages)) setStages(d.stages)
      if (d.meta) setMeta(d.meta)
    } catch (e) { setErr(String(e)) }
  }, [])

  useEffect(() => { reload() }, [reload])

  const moveCampaign = useCallback(async (id: number, stage: string) => {
    try {
      await fetch(`/api/marketing-campaigns/${id}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      })
      await reload()
    } catch (e) { console.error(e) }
  }, [reload])

  if (err) return <div className="flex-1 flex items-center justify-center text-[16px] italic" style={{ color: 'var(--t3)' }}>Fehler: {err}</div>
  if (!stages) return <div className="flex-1 flex items-center justify-center text-[16px] italic" style={{ color: 'var(--t3)' }}>Lade Marketing…</div>

  return (
    <div className="flex-1 flex overflow-hidden" style={{ background: 'var(--bg)' }}>
      <div className="flex-1 overflow-y-auto">
        <div className="px-10 py-8 flex flex-col gap-6 max-w-[1600px] mx-auto">
          <div
            className="flex items-baseline gap-3 pb-3"
            style={{ borderBottom: '1px solid var(--border-f)' }}
          >
            <h2
              className="m-0 italic"
              style={{ fontFamily: 'var(--font-heading)', fontSize: '29px', fontWeight: 500, color: 'var(--t1)', letterSpacing: '-0.025em' }}
            >Kampagnen</h2>
            <span className="text-[15px] tabular-nums" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>{stages.reduce((s, x) => s + x.count, 0)}</span>
            <button
              onClick={() => setNewOpen(true)}
              className="ml-auto flex items-center justify-center rounded-full transition-all cursor-pointer"
              style={{ width: '28px', height: '28px', color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-3)'; e.currentTarget.style.color = 'var(--t1)'; e.currentTarget.style.borderColor = 'var(--border)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.color = 'var(--t2)'; e.currentTarget.style.borderColor = 'var(--border-f)' }}
              title="Neue Kampagne"
              aria-label="Neue Kampagne"
            ><Plus className="w-4 h-4" strokeWidth={2} /></button>
          </div>
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
            {stages.map(stage => {
              const isDrop = dragOver === stage.id
              return (
                <div
                  key={stage.id}
                  className="flex flex-col transition-colors"
                  style={{
                    background: isDrop ? 'var(--bg-2)' : 'var(--bg-1)',
                    border: `1px solid ${isDrop ? 'var(--border-active)' : 'var(--border-f)'}`,
                    borderRadius: '10px',
                    minHeight: '220px',
                  }}
                  onDragOver={e => { if (dragging) { e.preventDefault(); setDragOver(stage.id) } }}
                  onDragLeave={() => setDragOver(prev => (prev === stage.id ? null : prev))}
                  onDrop={e => {
                    e.preventDefault()
                    if (dragging && dragging.fromStage !== stage.id) moveCampaign(dragging.id, stage.id)
                    setDragging(null); setDragOver(null)
                  }}
                >
                  <div
                    className="px-3 py-2.5 flex items-baseline gap-2"
                    style={{ borderBottom: '1px solid var(--border-f)' }}
                  >
                    <span
                      className="uppercase"
                      style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontSize: '10.5px', fontWeight: 600, letterSpacing: '0.16em' }}
                    >{stage.label}</span>
                    <span
                      className="text-[12.5px] tabular-nums ml-auto px-1.5 rounded-full"
                      style={{
                        color: stage.count > 0 ? 'var(--cc-orange)' : 'var(--t3)',
                        fontFamily: 'var(--font-body)',
                        fontWeight: stage.count > 0 ? 600 : 400,
                      }}
                    >{stage.count}</span>
                  </div>
                  <div className="flex flex-col gap-2 p-2">
                    {(stage.campaigns || []).map(c => (
                      <button
                        key={c.id}
                        onClick={() => setEdit(c)}
                        className="text-left transition-all min-w-0 flex flex-col cursor-pointer"
                        style={{
                          background: 'var(--bg-2)',
                          border: '1px solid var(--border-f)',
                          borderRadius: '8px',
                          padding: '10px 12px',
                          opacity: dragging?.id === c.id ? 0.4 : 1,
                        }}
                        draggable
                        onDragStart={() => setDragging({ id: c.id, fromStage: stage.id })}
                        onDragEnd={() => { setDragging(null); setDragOver(null) }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-f)' }}
                      >
                        <span
                          className="truncate"
                          style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontSize: '15px', fontWeight: 500 }}
                        >{c.name}</span>
                        <div className="flex items-baseline gap-2 mt-1">
                          {c.channel && (
                            <span
                              className="uppercase"
                              style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.14em' }}
                            >{c.channel}</span>
                          )}
                          {c.lead_count > 0 && (
                            <span
                              className="tabular-nums ml-auto"
                              style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontSize: '12px', fontWeight: 600 }}
                              title={`${c.lead_count} Leads aus dieser Kampagne`}
                            >{c.lead_count} Lead{c.lead_count !== 1 ? 's' : ''}</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {(newOpen || edit) && meta && (
        <CampaignDialog
          campaign={edit}
          meta={meta}
          onClose={() => { setEdit(null); setNewOpen(false) }}
          onSaved={() => { setEdit(null); setNewOpen(false); reload() }}
        />
      )}
    </div>
  )
}

function CampaignDialog({ campaign, meta, onClose, onSaved }: {
  campaign: MarketingCampaign | null
  meta: MarketingMeta
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !campaign
  const [name, setName] = useState(campaign?.name || '')
  const [stage, setStage] = useState(campaign?.stage || 'idee')
  const [channel, setChannel] = useState(campaign?.channel || '')
  const [goal, setGoal] = useState(campaign?.goal || '')
  const [notes, setNotes] = useState(campaign?.notes || '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = useCallback(async () => {
    if (!name.trim()) { setErr('Name fehlt'); return }
    setSaving(true); setErr(null)
    try {
      if (isNew) {
        const r = await fetch('/api/marketing-campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), stage, channel: channel || null, goal: goal || null, notes: notes || null }),
        })
        if (!r.ok) throw new Error(await r.text())
      } else {
        const updates: any = { name: name.trim(), channel: channel || null, goal: goal || null, notes: notes || null }
        const r = await fetch(`/api/marketing-campaigns/${campaign!.id}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        })
        if (!r.ok) throw new Error(await r.text())
        if (stage !== campaign!.stage) {
          await fetch(`/api/marketing-campaigns/${campaign!.id}/stage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage }),
          })
        }
      }
      onSaved()
    } catch (e) { setErr(String(e)) } finally { setSaving(false) }
  }, [isNew, name, stage, channel, goal, notes, campaign, onSaved])

  const remove = useCallback(async () => {
    if (!campaign) return
    if (!confirm(`Kampagne "${campaign.name}" löschen?`)) return
    try {
      await fetch(`/api/marketing-campaigns/${campaign.id}`, { method: 'DELETE' })
      onSaved()
    } catch (e) { setErr(String(e)) }
  }, [campaign, onSaved])

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col gap-4"
        style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          padding: '24px',
          width: '480px',
          maxWidth: '90vw',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-baseline gap-3">
          <h3
            className="m-0 italic"
            style={{ fontFamily: 'var(--font-heading)', fontSize: '23px', fontWeight: 500, color: 'var(--t1)' }}
          >{isNew ? 'Neue Kampagne' : 'Kampagne bearbeiten'}</h3>
          <button
            onClick={onClose}
            className="ml-auto cursor-pointer p-1 rounded"
            style={{ color: 'var(--t3)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          ><X className="w-4 h-4" /></button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] uppercase tracking-[0.14em]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Was ist das für eine Kampagne?"
            className="px-3 py-2 text-[16px] rounded"
            style={{ background: 'var(--bg-2)', border: '1px solid var(--border-f)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
            autoFocus
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[13px] uppercase tracking-[0.14em]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Stage</span>
            <select
              value={stage}
              onChange={e => setStage(e.target.value)}
              className="px-3 py-2 text-[16px] rounded"
              style={{ background: 'var(--bg-2)', border: '1px solid var(--border-f)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
            >
              {meta.stages.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] uppercase tracking-[0.14em]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Kanal</span>
            <select
              value={channel}
              onChange={e => setChannel(e.target.value)}
              className="px-3 py-2 text-[16px] rounded"
              style={{ background: 'var(--bg-2)', border: '1px solid var(--border-f)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
            >
              <option value="">—</option>
              {meta.channels.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] uppercase tracking-[0.14em]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Ziel</span>
          <input
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="z. B. 10 Leads für AI-Sprint im Juni"
            className="px-3 py-2 text-[16px] rounded"
            style={{ background: 'var(--bg-2)', border: '1px solid var(--border-f)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[13px] uppercase tracking-[0.14em]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Notizen</span>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            className="px-3 py-2 text-[16px] rounded resize-none"
            style={{ background: 'var(--bg-2)', border: '1px solid var(--border-f)', color: 'var(--t1)', fontFamily: 'var(--font-body)' }}
          />
        </label>
        {err && <div className="text-[14px]" style={{ color: 'var(--cc-orange)' }}>{err}</div>}
        <div className="flex items-center gap-2">
          {!isNew && (
            <button
              onClick={remove}
              className="text-[14px] uppercase tracking-[0.14em] cursor-pointer px-3 py-1.5 rounded"
              style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600 }}
              onMouseEnter={e => { e.currentTarget.style.color = '#d76060' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--t3)' }}
            >Löschen</button>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="ml-auto text-[15px] cursor-pointer px-4 py-2 rounded transition-colors"
            style={{ color: '#fff', background: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 600, opacity: saving ? 0.5 : 1 }}
          >{saving ? 'Speichere…' : 'Speichern'}</button>
        </div>
      </div>
    </div>
  )
}

export function PipelineView({ todayIso: _todayIso, onOpenItem: _onOpenItem }: { todayIso: string; onOpenItem: (it: FokusItem) => void }) {
  const [streams, setStreams] = useState<PipelineStream[] | null>(null)
  const [meta, setMeta] = useState<PipelineMeta | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openCard, setOpenCard] = useState<{ card: PipelineCard; streamId: string } | null>(null)
  const [dragging, setDragging] = useState<{ cardId: string; personIds: number[]; fromStream: string } | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [newLeadStream, setNewLeadStream] = useState<string | null>(null)
  const [stepsOpen, setStepsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('pipeline:stepsOpen') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('pipeline:stepsOpen', stepsOpen ? '1' : '0') } catch {} }, [stepsOpen])
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({})
  const toggleArchived = useCallback((streamId: string, stageId: string) => {
    setShowArchived(prev => ({ ...prev, [`${streamId}:${stageId}`]: !prev[`${streamId}:${stageId}`] }))
  }, [])

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/customers')
      const d = await r.json()
      if (Array.isArray(d.pipeline)) setStreams(d.pipeline)
      if (d.pipeline_meta) setMeta(d.pipeline_meta)
      else if (!Array.isArray(d.pipeline)) setErr('Keine Daten')
    } catch (e) { setErr(String(e)) }
  }, [])

  useEffect(() => { reload() }, [reload])

  const moveCard = useCallback(async (personIds: number[], stream: string, stage: string, fromStream?: string) => {
    try {
      await Promise.all(personIds.map(pid =>
        fetch('/api/customers/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream, stage, from_stream: fromStream || null }),
        })
      ))
      await reload()
    } catch (e) { console.error(e) }
  }, [reload])


  const toggleStep = useCallback(async (personIds: number[], stageId: string, itemKey: string, done: boolean, streamId?: string) => {
    try {
      await fetch('/api/customers/check-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_ids: personIds, stage_id: stageId, item_key: itemKey, done, stream: streamId || null }),
      })
      await reload()
    } catch (e) { console.error(e) }
  }, [reload])

  const nextSteps = useMemo(() => {
    if (!streams || !meta) return [] as { cardId: string; cardLabel: string; streamId: string; streamLabel: string; stageId: string; stageLabel: string; stepKey: string; stepLabel: string; personIds: number[]; openCount: number }[]
    const out: { cardId: string; cardLabel: string; streamId: string; streamLabel: string; stageId: string; stageLabel: string; stepKey: string; stepLabel: string; personIds: number[]; openCount: number }[] = []
    for (const stream of streams) {
      for (const stage of stream.stages) {
        const items = meta.stage_checklists?.[stream.id]?.[stage.id] || []
        if (!items.length) continue
        for (const card of stage.cards || []) {
          if (card.archived) continue
          const sp = card.stage_progress || {}
          const remaining = items.filter(it => !sp[`${stage.id}:${it.key}`])
          if (!remaining.length) continue
          const open = remaining[0]
          out.push({
            cardId: card.id,
            cardLabel: card.label,
            streamId: stream.id,
            streamLabel: stream.label,
            stageId: stage.id,
            stageLabel: stage.label,
            stepKey: open.key,
            stepLabel: open.label,
            personIds: card.person_ids,
            openCount: remaining.length,
          })
        }
      }
    }
    return out
  }, [streams, meta])

  if (err) return <div className="flex-1 flex items-center justify-center text-[16px] italic" style={{ color: 'var(--t3)' }}>Fehler: {err}</div>
  if (!streams) return <div className="flex-1 flex items-center justify-center text-[16px] italic" style={{ color: 'var(--t3)' }}>Lade Pipeline…</div>

  return (
    <div className="flex-1 flex overflow-hidden" style={{ background: 'var(--bg)' }}>
      <div className="flex-1 overflow-y-auto">
        <div className="px-10 py-8 flex flex-col gap-10 max-w-[1600px] mx-auto pipeline-view-inner">
          {nextSteps.length > 0 && (
            <section
              className="flex flex-col"
              style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)', borderRadius: '10px' }}
            >
              <button
                onClick={() => setStepsOpen(o => !o)}
                className="flex items-baseline gap-3 px-5 py-3.5 cursor-pointer text-left transition-colors"
                style={{ background: 'transparent' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span
                  className="uppercase"
                  style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.18em' }}
                >Nächste Schritte</span>
                <span
                  className="text-[13.5px] tabular-nums px-2 rounded-full"
                  style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 600, background: 'var(--bg-2)' }}
                >{nextSteps.length}</span>
                <span
                  className="ml-auto text-[13px]"
                  style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}
                >{stepsOpen ? 'einklappen' : 'aufklappen'}</span>
              </button>
              {stepsOpen && (
                <div
                  className="flex flex-col"
                  style={{ borderTop: '1px solid var(--border-f)' }}
                >
                  {nextSteps.map((s, i) => (
                    <div
                      key={`${s.cardId}:${s.stageId}:${s.stepKey}`}
                      className="flex items-center gap-3 px-5 py-2.5"
                      style={{ borderBottom: i < nextSteps.length - 1 ? '1px solid var(--border-f)' : 'none' }}
                    >
                      <button
                        onClick={() => toggleStep(s.personIds, s.stageId, s.stepKey, true, s.streamId)}
                        className="flex items-center justify-center rounded-full cursor-pointer transition-all flex-shrink-0"
                        style={{ width: '20px', height: '20px', border: '1.5px solid var(--border)', background: 'var(--bg-2)', color: 'var(--t3)' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--cc-orange)'; e.currentTarget.style.borderColor = 'var(--cc-orange)'; e.currentTarget.style.color = '#fff' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--t3)' }}
                        title="Schritt erledigt markieren"
                      ><Check className="w-3 h-3" strokeWidth={2.5} /></button>
                      <span
                        className="text-[15.5px] truncate min-w-0"
                        style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500, flexShrink: 0, maxWidth: '32%' }}
                        title={s.cardLabel}
                      >{s.cardLabel}</span>
                      <span
                        className="text-[15px] flex-1 min-w-0 truncate"
                        style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)' }}
                        title={s.stepLabel}
                      >{s.stepLabel}</span>
                      <span
                        className="text-[12.5px] uppercase flex-shrink-0"
                        style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 600, letterSpacing: '0.14em' }}
                      >{s.streamLabel} · {s.stageLabel}</span>
                      {s.openCount > 1 && (
                        <span
                          className="text-[12.5px] tabular-nums flex-shrink-0"
                          style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}
                          title={`${s.openCount} offene Schritte auf dieser Karte`}
                        >+{s.openCount - 1}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {streams.map(stream => (
            <section key={stream.id} className="flex flex-col gap-5">
              <div
                className="flex items-baseline gap-3 pb-3"
                style={{ borderBottom: '1px solid var(--border-f)' }}
              >
                <h2
                  className="m-0 italic"
                  style={{ fontFamily: 'var(--font-heading)', fontSize: '29px', fontWeight: 500, color: 'var(--t1)', letterSpacing: '-0.025em' }}
                >{stream.label}</h2>
                <span className="text-[15px] tabular-nums" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>{stream.count}</span>
                {stream.forecast_eur && stream.forecast_eur > 0 ? (
                  <span
                    className="text-[14.5px] tabular-nums"
                    style={{ color: 'var(--cc-orange)', fontFamily: 'var(--font-body)', fontWeight: 600 }}
                    title={`Gewichteter Forecast: ${fmtEur(stream.forecast_eur)} (aus ${fmtEur(stream.value_eur)} offenem Volumen)`}
                  >≈ {fmtEur(stream.forecast_eur)}</span>
                ) : null}
                <button
                  onClick={() => setNewLeadStream(stream.id)}
                  className="ml-auto flex items-center justify-center rounded-full transition-all cursor-pointer"
                  style={{ width: '28px', height: '28px', color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-3)'; e.currentTarget.style.color = 'var(--t1)'; e.currentTarget.style.borderColor = 'var(--border)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.color = 'var(--t2)'; e.currentTarget.style.borderColor = 'var(--border-f)' }}
                  title={`Neuer Eintrag in ${stream.label}`}
                  aria-label={`Neuer Eintrag in ${stream.label}`}
                ><Plus className="w-4 h-4" strokeWidth={2} /></button>
              </div>
              <div className="grid gap-2 pipeline-stage-grid" style={{ gridTemplateColumns: `repeat(${stream.stages.length}, minmax(0, 1fr))` }}>
                {stream.stages.map(stage => {
                  const isDropTarget = dragOver === `${stream.id}:${stage.id}`
                  const archivedKey = `${stream.id}:${stage.id}`
                  const showArch = !!showArchived[archivedKey]
                  const archivedCount = (stage.cards || []).filter(c => c.archived).length
                  const visibleCards = (stage.cards || []).filter(c => showArch || !c.archived)
                  return (
                    <div
                      key={stage.id}
                      className="flex flex-col transition-colors"
                      style={{
                        background: isDropTarget ? 'var(--bg-2)' : (stage.terminal ? 'var(--bg-0, var(--bg-1))' : 'var(--bg-1)'),
                        border: `1px solid ${isDropTarget ? 'var(--border-active)' : 'var(--border-f)'}`,
                        borderRadius: '8px',
                        minHeight: '150px',
                        opacity: stage.terminal ? 0.92 : 1,
                      }}
                      onDragOver={e => {
                        if (dragging) {
                          e.preventDefault()
                          setDragOver(`${stream.id}:${stage.id}`)
                        }
                      }}
                      onDragLeave={() => setDragOver(prev => (prev === `${stream.id}:${stage.id}` ? null : prev))}
                      onDrop={e => {
                        e.preventDefault()
                        if (dragging) {
                          moveCard(dragging.personIds, stream.id, stage.id, dragging.fromStream)
                        }
                        setDragging(null)
                        setDragOver(null)
                      }}
                    >
                      <div
                        className="px-2 py-1.5 flex items-baseline gap-1.5"
                        style={{ borderBottom: '1px solid var(--border-f)' }}
                      >
                        <span
                          className="uppercase truncate"
                          style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontSize: '9.5px', fontWeight: 600, letterSpacing: '0.14em', minWidth: 0 }}
                          title={stage.label}
                        >{stage.label}</span>
                        <span
                          className="text-[11.5px] tabular-nums ml-auto shrink-0"
                          style={{
                            color: visibleCards.length > 0 ? 'var(--cc-orange)' : 'var(--t3)',
                            fontFamily: 'var(--font-body)',
                            fontWeight: visibleCards.length > 0 ? 600 : 400,
                          }}
                        >{stage.terminal ? visibleCards.length : stage.count}</span>
                        {stage.terminal && archivedCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleArchived(stream.id, stage.id)}
                            className="text-[11px] tabular-nums shrink-0 cursor-pointer"
                            style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', letterSpacing: '0.08em' }}
                            title={showArch ? 'Archiv verbergen' : `${archivedCount} archivierte einblenden`}
                          >{showArch ? '−' : `+${archivedCount}`}</button>
                        ) : null}
                      </div>
                      <div className="flex flex-col gap-1.5 p-1.5">
                        {visibleCards.map(card => {
                          const items = meta?.stage_checklists?.[stream.id]?.[stage.id] || []
                          const sp = card.stage_progress || {}
                          const totalChecks = items.length
                          const doneChecks = items.filter(it => sp[`${stage.id}:${it.key}`]).length
                          const nextStep = items.find(it => !sp[`${stage.id}:${it.key}`]) || null
                          const noteFirstLine = (card.members[0]?.notes || '').trim().split('\n')[0].trim()
                          return (
                          <div
                            key={card.id}
                            className="text-left transition-all min-w-0 flex flex-col"
                            style={{
                              background: 'var(--bg-2)',
                              border: '1px solid var(--border-f)',
                              borderLeft: card.attention ? '3px solid var(--cc-orange)' : '1px solid var(--border-f)',
                              borderRadius: '6px',
                              opacity: dragging?.cardId === card.id ? 0.4 : (card.archived ? 0.55 : 1),
                              height: '76px',
                            }}
                            draggable
                            onDragStart={() => setDragging({ cardId: card.id, personIds: card.person_ids, fromStream: stream.id })}
                            onDragEnd={() => { setDragging(null); setDragOver(null) }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-3)'; e.currentTarget.style.borderColor = 'var(--border-active)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.borderColor = 'var(--border-f)' }}
                          >
                            <button
                              type="button"
                              className="w-full text-left cursor-pointer px-2.5 py-2 flex flex-col"
                              onClick={() => setOpenCard({ card, streamId: stream.id })}
                              title={[card.subtitle, card.members[0]?.notes?.trim()].filter(Boolean).join('\n\n') || undefined}
                              style={{ height: '76px' }}
                            >
                              <div
                                className="uppercase truncate"
                                style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontSize: '9px', fontWeight: 600, letterSpacing: '0.14em', height: '12px', lineHeight: '12px' }}
                              >{card.subtitle || '—'}</div>
                              <div
                                className="italic truncate flex items-baseline gap-1 mt-0.5"
                                style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontSize: '15px', fontWeight: 500, letterSpacing: '-0.01em', lineHeight: '19px' }}
                              >
                                <span className="truncate">{card.label}</span>
                                {card.kind === 'firm' && card.members.length > 1 ? (
                                  <span className="text-[12px] tabular-nums shrink-0 not-italic" style={{ color: 'var(--t3)' }}>·{card.members.length}</span>
                                ) : null}
                                {card.value_eur && card.value_eur > 0 ? (
                                  <span
                                    className="text-[12.5px] tabular-nums shrink-0 not-italic ml-auto"
                                    style={{ color: 'var(--t2)', fontWeight: 600 }}
                                    title={fmtEur(card.value_eur)}
                                  >{fmtEurShort(card.value_eur)}</span>
                                ) : null}
                              </div>
                              <div className="mt-auto flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>
                                {nextStep ? (
                                  <span className="truncate flex items-baseline gap-1" style={{ color: 'var(--t2)', minWidth: 0 }} title={`Nächster Schritt: ${nextStep.label}`}>
                                    <span style={{ color: 'var(--cc-orange)', fontWeight: 600 }}>→</span>
                                    <span className="truncate">{nextStep.label}</span>
                                  </span>
                                ) : card.next_step_text ? (
                                  <span className="truncate flex items-baseline gap-1" style={{ color: 'var(--t2)', minWidth: 0 }} title={`Nächster Schritt: ${card.next_step_text}`}>
                                    <span style={{ color: 'var(--cc-orange)', fontWeight: 600 }}>→</span>
                                    <span className="truncate">{card.next_step_text}</span>
                                  </span>
                                ) : (stream.id === 'leads' && card.missing_next_step) ? (
                                  <span className="truncate flex items-baseline gap-1" style={{ color: 'var(--cc-orange)', fontWeight: 600, minWidth: 0 }} title="Kein nächster Schritt gesetzt — die Karte verrottet">
                                    <span>○</span><span className="truncate">Schritt fehlt</span>
                                  </span>
                                ) : noteFirstLine ? (
                                  <span className="truncate" style={{ color: 'var(--t2)', fontStyle: 'italic', minWidth: 0 }}>{noteFirstLine}</span>
                                ) : stream.id === 'workshops' && card.workshop_kind ? (
                                  <span className="truncate" style={{ color: 'var(--t2)' }}>{card.workshop_kind}</span>
                                ) : stream.id === 'leads' && card.lead_source ? (
                                  <span className="truncate" style={{ color: 'var(--t2)' }}>{meta?.lead_source_labels?.[card.lead_source] || card.lead_source}</span>
                                ) : null}
                                {stream.id === 'agent' && stage.id === 'betreuung' ? (
                                  <span
                                    className="tabular-nums"
                                    style={{ color: 'var(--cc-orange)', fontWeight: 600 }}
                                    title="Vor-Ort-Termine"
                                  >{card.betreuung_done}/{meta?.betreuung_total ?? 4}</span>
                                ) : null}
                                {card.offer ? (() => {
                                  const o = card.offer
                                  const views = o.opened_count || 0
                                  const sentAt = o.sent_at || 0
                                  const stale = views === 0 && sentAt > 0 && (Date.now()/1000 - sentAt) > 86400
                                  const accepted = o.status === 'accepted'
                                  const color = accepted ? 'var(--cc-orange)' : stale ? '#d97757' : views > 0 ? 'var(--t2)' : 'var(--t3)'
                                  const lastOpenedLabel = o.last_opened_at ? relativeDays(o.last_opened_at) : (sentAt ? 'noch nie geöffnet' : '—')
                                  const title = accepted
                                    ? `Angebot angenommen ${o.accepted_at ? '· ' + relativeDays(o.accepted_at) : ''}`
                                    : `Angebot raus${sentAt ? ' · ' + relativeDays(sentAt) : ''} · ${views} View${views === 1 ? '' : 's'}${o.last_opened_at ? ' · zuletzt ' + lastOpenedLabel : ''}`
                                  return (
                                    <span
                                      className="tabular-nums flex items-center gap-0.5 shrink-0"
                                      style={{ color, fontWeight: stale || accepted ? 600 : 400 }}
                                      title={title}
                                    >
                                      {accepted ? (
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3,8.5 6.5,12 13,4.5" /></svg>
                                      ) : (
                                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
                                      )}
                                      <span>{accepted ? '' : views}</span>
                                    </span>
                                  )
                                })() : null}
                                {totalChecks > 0 ? (
                                  <span
                                    className="tabular-nums"
                                    style={{ color: doneChecks === totalChecks ? 'var(--cc-orange)' : 'var(--t3)', fontWeight: doneChecks === totalChecks ? 600 : 400 }}
                                    title="Stage-Schritte erledigt"
                                  >{doneChecks}/{totalChecks}</span>
                                ) : null}
                                {(() => {
                                  const realTs = card.last_real_contact_ts ?? null
                                  const seenTs = card.last_interaction_ts ?? null
                                  const ball = card.ball
                                  const limit = card.attention_days_limit ?? null
                                  const days = card.days_since_real_contact ?? null
                                  const dir = card.last_real_contact_dir ?? null
                                  const arrow = dir === 'out' ? '→' : dir === 'in' ? '←' : ''
                                  let tip: string | undefined
                                  if (realTs && ball === 'them') {
                                    tip = `Antwort offen seit ${days ?? 0} T${limit ? ` (Schwelle ${limit} T)` : ''}`
                                  } else if (realTs && ball === 'me') {
                                    tip = `Du dran seit ${days ?? 0} T${limit ? ` (Schwelle ${limit} T)` : ''}`
                                  } else if (!realTs && ball === 'me') {
                                    tip = 'Noch kein echter Kontakt'
                                  } else if (seenTs && !realTs) {
                                    tip = 'Nur System-Touch (Kalender/Chat), kein WA/Mail'
                                  }
                                  return (
                                    <span
                                      className="ml-auto tabular-nums shrink-0 flex items-baseline gap-1"
                                      title={tip}
                                    >
                                      {realTs ? (
                                        <>
                                          {arrow ? <span style={{ color: 'var(--t3)' }}>{arrow}</span> : null}
                                          <span style={{ color: card.attention ? 'var(--cc-orange)' : 'inherit', fontWeight: card.attention ? 600 : 400 }}>
                                            {relativeDays(realTs)}
                                          </span>
                                        </>
                                      ) : seenTs ? (
                                        <span style={{ color: 'var(--t3)', fontStyle: 'italic' }} title="zuletzt gesehen (Kalender/Chat)">{relativeDays(seenTs)}</span>
                                      ) : (
                                        <span style={{ color: 'var(--t3)' }}>—</span>
                                      )}
                                    </span>
                                  )
                                })()}
                              </div>
                            </button>
                          </div>
                          )
                        })}
                        {visibleCards.length === 0 && (
                          <div style={{ minHeight: '20px' }} />
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              {stream.dropped && stream.dropped.length > 0 ? (
                <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border-f)' }}>
                  <div
                    className="uppercase mb-1.5"
                    style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontSize: '9.5px', fontWeight: 600, letterSpacing: '0.14em' }}
                  >Abgelegt · {stream.dropped.length}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {stream.dropped.map(card => (
                      <button
                        key={`dropped-${card.id}`}
                        type="button"
                        onClick={() => setOpenCard({ card, streamId: stream.id })}
                        className="text-left cursor-pointer flex items-baseline gap-1.5 px-2.5 py-1.5 rounded-md transition-colors"
                        style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)', opacity: 0.7, maxWidth: '100%' }}
                        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--border-active)' }}
                        onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; e.currentTarget.style.borderColor = 'var(--border-f)' }}
                        title={`${card.subtitle || card.label} · ${card.lost_reason_label || 'Abgelegt'}`}
                      >
                        <span className="italic truncate" style={{ color: 'var(--t2)', fontFamily: 'var(--font-heading)', fontSize: '12.5px', fontWeight: 500, maxWidth: '160px' }}>{card.label}</span>
                        <span className="shrink-0" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)', fontSize: '9.5px' }}>{card.lost_reason_label || 'Abgelegt'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
      {openCard ? (
        <CustomerDossier
          card={openCard.card}
          streamContext={openCard.streamId}
          meta={meta}
          onClose={() => setOpenCard(null)}
          onChanged={async () => { await reload() }}
        />
      ) : null}
      {newLeadStream && meta ? (
        <NewLeadSheet
          streamId={newLeadStream}
          meta={meta}
          onClose={() => setNewLeadStream(null)}
          onCreated={async () => { setNewLeadStream(null); await reload() }}
        />
      ) : null}
    </div>
  )
}

type SearchResult =
  | { source: 'person'; person_id: number; name: string; company: string | null; email: string | null; phone: string | null }
  | { source: 'whatsapp'; chat_id: string; name: string; is_group: boolean; last_ts: number | null }

function NewLeadSheet({
  streamId,
  meta,
  onClose,
  onCreated,
}: {
  streamId: string
  meta: PipelineMeta
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const stages = meta.stages[streamId] || []
  const defaultStage = stages[0]?.id || 'new'
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [picked, setPicked] = useState<SearchResult | null>(null)
  const [showSugg, setShowSugg] = useState(false)
  const [company, setCompany] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [waChatId, setWaChatId] = useState<string | null>(null)
  const [stage, setStage] = useState(defaultStage)
  const [leadSource, setLeadSource] = useState<string>('')
  const [workshopKind, setWorkshopKind] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (picked) { setResults([]); return }
    const q = query.trim()
    if (q.length < 2) { setResults([]); return }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/people/search?q=${encodeURIComponent(q)}&limit=8`, { signal: ctrl.signal })
        const d = await r.json()
        if (Array.isArray(d.results)) setResults(d.results)
      } catch {}
    }, 180)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [query, picked])

  const pickResult = (p: SearchResult) => {
    setPicked(p)
    setQuery(p.name)
    if (p.source === 'person') {
      setCompany(p.company || '')
      setEmail(p.email || '')
      setPhone(p.phone || '')
      setWaChatId(null)
    } else {
      setCompany('')
      setEmail('')
      setPhone('')
      setWaChatId(p.chat_id)
    }
    setShowSugg(false)
  }

  const clearPick = () => {
    setPicked(null)
    setQuery('')
    setCompany(''); setEmail(''); setPhone(''); setWaChatId(null)
  }

  const submit = async () => {
    const name = query.trim()
    if (!picked && !name) { setErr('Name fehlt'); return }
    if (streamId === 'leads' && !leadSource) { setErr('Quelle wählen — Herkunft ist Pflicht'); return }
    setBusy(true); setErr(null)
    try {
      const useExistingPerson = picked && picked.source === 'person'
      const body = useExistingPerson
        ? {
            person_id: (picked as { source: 'person'; person_id: number }).person_id,
            stream: streamId, stage,
            lead_source: leadSource || null,
            workshop_kind: workshopKind || null,
            notes: notes.trim() || null,
          }
        : {
            name,
            company: company.trim() || null,
            email: email.trim() || null,
            phone: phone.trim() || null,
            whatsapp_chat_id: waChatId,
            stream: streamId, stage,
            lead_source: leadSource || null,
            workshop_kind: workshopKind || null,
            notes: notes.trim() || null,
          }
      const r = await fetch('/api/people/create-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!r.ok) { setErr(d.error || 'Fehler'); return }
      await onCreated()
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div
        className="rounded-md flex flex-col w-[440px] max-h-[85vh]"
        style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border-f)' }}>
          <div className="text-[16px] italic" style={{ fontFamily: 'var(--font-heading)', color: 'var(--t1)' }}>Neuer Eintrag · {meta.streams.find(s => s.id === streamId)?.label}</div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1 relative">
            <label className="text-[12.5px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontWeight: 600 }}>Person *</label>
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={e => { setQuery(e.target.value); setPicked(null); setShowSugg(true) }}
                onFocus={() => setShowSugg(true)}
                placeholder="Name suchen oder neu eintippen…"
                className="flex-1 rounded px-2 py-1.5 text-[15px]"
                style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)' }}
              />
              {picked ? (
                <button
                  type="button"
                  onClick={clearPick}
                  className="text-[13px] px-2 py-1.5 rounded"
                  style={{ color: 'var(--t3)', background: 'transparent', border: '1px solid var(--border-f)' }}
                  title="Auswahl aufheben"
                >✕</button>
              ) : null}
            </div>
            {picked ? (
              <div className="text-[13px] mt-0.5" style={{ color: 'var(--t3)' }}>
                {picked.source === 'person'
                  ? `Aus DB: ${picked.company ? `${picked.company} · ` : ''}${picked.email || picked.phone || '—'}`
                  : `Aus WhatsApp · wird neu in DB angelegt${picked.is_group ? ' (Gruppe)' : ''}`}
              </div>
            ) : null}
            {!picked && showSugg && results.length > 0 ? (
              <div
                className="absolute left-0 right-0 top-full mt-1 z-10 rounded overflow-hidden flex flex-col"
                style={{ background: 'var(--bg-1)', border: '1px solid var(--border-f)' }}
              >
                {results.map(p => {
                  const key = p.source === 'person' ? `p-${p.person_id}` : `w-${p.chat_id}`
                  return (
                  <button
                    type="button"
                    key={key}
                    onClick={() => pickResult(p)}
                    className="text-left px-3 py-2 text-[15px]"
                    style={{ color: 'var(--t1)', background: 'var(--bg-1)', borderBottom: '1px solid var(--border-f)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-2)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-1)' }}
                  >
                    <div className="truncate flex items-center gap-2" style={{ fontFamily: 'var(--font-heading)', fontWeight: 500 }}>
                      <span className="truncate">{p.name}</span>
                      <span
                        className="text-[11px] uppercase tracking-[0.14em] ml-auto shrink-0"
                        style={{ color: p.source === 'person' ? 'var(--t3)' : 'var(--accent)', fontWeight: 600 }}
                      >{p.source === 'person' ? 'DB' : 'WA'}</span>
                    </div>
                    {p.source === 'person' && (p.company || p.email || p.phone) ? (
                      <div className="text-[13px] truncate mt-0.5" style={{ color: 'var(--t3)' }}>
                        {[p.company, p.email, p.phone].filter(Boolean).join(' · ')}
                      </div>
                    ) : null}
                    {p.source === 'whatsapp' ? (
                      <div className="text-[13px] truncate mt-0.5" style={{ color: 'var(--t3)' }}>
                        {p.is_group ? 'Gruppe · ' : ''}neu in DB anlegen
                      </div>
                    ) : null}
                  </button>
                  )
                })}
              </div>
            ) : null}
          </div>
          {!picked || picked.source === 'whatsapp' ? (
            <>
              {[
                { v: company, set: setCompany, label: 'Firma', ph: '' },
                { v: email, set: setEmail, label: 'E-Mail', ph: '' },
                { v: phone, set: setPhone, label: 'Telefon', ph: '' },
              ].map(f => (
                <div key={f.label} className="flex flex-col gap-1">
                  <label className="text-[12.5px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontWeight: 600 }}>{f.label}</label>
                  <input
                    value={f.v}
                    onChange={e => f.set(e.target.value)}
                    placeholder={f.ph}
                    className="rounded px-2 py-1.5 text-[15px]"
                    style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)' }}
                  />
                </div>
              ))}
            </>
          ) : null}
          <div className="flex flex-col gap-2">
            <label className="text-[12.5px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontWeight: 600 }}>Stage</label>
            <PillGroup
              value={stage}
              onChange={setStage}
              options={stages.map(s => ({ value: s.id, label: s.label }))}
            />
          </div>
          {streamId === 'leads' ? (
            <div className="flex flex-col gap-2">
              <label className="text-[12.5px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontWeight: 600 }}>Quelle *</label>
              <PillGroup
                value={leadSource}
                onChange={setLeadSource}
                options={meta.lead_sources.map(s => ({ value: s, label: meta.lead_source_labels?.[s] || s }))}
              />
            </div>
          ) : null}
          {streamId === 'workshops' ? (
            <div className="flex flex-col gap-2">
              <label className="text-[12.5px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontWeight: 600 }}>Workshop-Art</label>
              <PillGroup
                value={workshopKind}
                onChange={setWorkshopKind}
                options={meta.workshop_kinds.map(s => ({ value: s, label: s }))}
                allowClear
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label className="text-[12.5px] uppercase tracking-[0.16em]" style={{ color: 'var(--t3)', fontWeight: 600 }}>Notiz</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="rounded px-2 py-1.5 text-[15px] resize-none"
              style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)', fontFamily: 'var(--font-body)' }}
            />
          </div>
          {err ? <div className="text-[14px]" style={{ color: '#c44' }}>{err}</div> : null}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-end gap-2" style={{ borderColor: 'var(--border-f)' }}>
          <button
            onClick={onClose}
            className="text-[14.5px] px-4 py-1.5 rounded-full transition-colors cursor-pointer"
            style={{ color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)', fontFamily: 'var(--font-body)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-3)'; e.currentTarget.style.color = 'var(--t1)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.color = 'var(--t2)' }}
          >Abbrechen</button>
          <button
            onClick={submit}
            disabled={busy}
            className="text-[14.5px] px-4 py-1.5 rounded-full transition-colors cursor-pointer"
            style={{
              background: 'var(--bg-2)',
              color: 'var(--t1)',
              fontWeight: 600,
              fontFamily: 'var(--font-body)',
              border: '1px solid var(--t1)',
              opacity: busy ? 0.5 : 1,
            }}
            onMouseEnter={e => { if (!busy) e.currentTarget.style.background = 'var(--bg-3)' }}
            onMouseLeave={e => { if (!busy) e.currentTarget.style.background = 'var(--bg-2)' }}
          >{busy ? 'Lege an…' : 'Anlegen'}</button>
        </div>
      </div>
    </div>
  )
}

function PillGroup({
  value,
  onChange,
  options,
  allowClear,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  allowClear?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(active && allowClear ? '' : o.value)}
            className="text-[13.5px] px-3 py-1.5 rounded-full inline-flex items-center transition-colors cursor-pointer"
            style={{
              fontFamily: 'var(--font-body)',
              fontWeight: 500,
              color: active ? 'var(--t1)' : 'var(--t2)',
              background: active
                ? 'color-mix(in srgb, var(--bg) 30%, var(--bg-2) 70%)'
                : 'color-mix(in srgb, var(--bg-2) 42%, transparent)',
              border: active
                ? '1px solid color-mix(in srgb, var(--border-f) 92%, transparent)'
                : '1px solid transparent',
            }}
          >{o.label}</button>
        )
      })}
    </div>
  )
}

type PersonSynthesis = { stand: string; verblieben: string; next: string }
type PersonJournalEntry = { date: string; title: string; summary: string; actions: { text: string; done: boolean }[] }
type PersonCrmStatus = {
  last_touch: { kind: string; snippet: string; ts: number; ago_human: string } | null
  upcoming_events: { id: number; start_iso: string; duration_min: number; title: string; category: string }[]
  recent_timeline: { source_kind: string; source_id: string; snippet: string; ts: number }[]
  open_focus: { title: string; bucket: string; date?: string | null; item_key: string }[]
  stats: { touches_30d: number; channels: string[] }
}

function CustomerDossier({
  card,
  streamContext,
  meta,
  onClose,
  onChanged,
}: {
  card: PipelineCard
  streamContext: string
  meta: PipelineMeta | null
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const primary = card.members[0]
  const personId = primary?.person_id || 0
  const [identities, setIdentities] = useState<{ id: number; kind: string; value: string; label?: string | null }[]>([])
  const [memberships, setMemberships] = useState<{ stream: string; stream_label: string; stage: string; stage_label: string; terminal: boolean; next_step_text: string | null; next_step_due: string | null; created_at: number; updated_at: number }[]>([])
  const [crm, setCrm] = useState<PersonCrmStatus | null>(null)
  const [synth, setSynth] = useState<PersonSynthesis | null>(null)
  const [journal, setJournal] = useState<PersonJournalEntry[]>([])
  const [actionBusy, setActionBusy] = useState(false)
  const [showLostReasons, setShowLostReasons] = useState(false)
  const [valueInput, setValueInput] = useState<string>(card.members[0]?.value_eur ? String(card.members[0].value_eur) : '')
  const [nextStepText, setNextStepText] = useState<string>(card.members[0]?.next_step_text || '')
  const [nextStepDue, setNextStepDue] = useState<string>(card.members[0]?.next_step_due || '')
  const [metaSaved, setMetaSaved] = useState(false)
  const saveMeta = useCallback(async () => {
    const pid = card.members[0]?.person_id
    if (!pid) return
    const vRaw = valueInput.replace(/[^0-9]/g, '')
    try {
      await fetch('/api/customers/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          person_id: pid,
          stream: streamContext,
          value_eur: vRaw === '' ? null : parseInt(vRaw, 10),
          next_step_text: nextStepText.trim() || null,
          next_step_due: nextStepDue.trim() || null,
        }),
      })
      setMetaSaved(true)
      setTimeout(() => setMetaSaved(false), 1400)
      await onChanged()
    } catch (e) { console.error(e) }
  }, [card.members, streamContext, valueInput, nextStepText, nextStepDue, onChanged])

  useEffect(() => {
    if (!personId) { setCrm(null); setIdentities([]); setMemberships([]); setSynth(null); setJournal([]); return }
    let cancelled = false
    fetch(`/api/people/${personId}/crm-status`).then(r => r.json()).then(d => {
      if (cancelled || !d || d.error) return
      setCrm({
        last_touch: d.last_touch || null,
        upcoming_events: Array.isArray(d.upcoming_events) ? d.upcoming_events : [],
        recent_timeline: Array.isArray(d.recent_timeline) ? d.recent_timeline : [],
        open_focus: Array.isArray(d.open_focus) ? d.open_focus : [],
        stats: d.stats || { touches_30d: 0, channels: [] },
      })
    }).catch(() => {})
    fetch(`/api/people/${personId}/identities`).then(r => r.json()).then(d => {
      if (!cancelled && Array.isArray(d.identities)) setIdentities(d.identities)
    }).catch(() => {})
    fetch(`/api/people/${personId}/memberships`).then(r => r.json()).then(d => {
      if (!cancelled && Array.isArray(d.memberships)) setMemberships(d.memberships)
    }).catch(() => {})
    fetch(`/api/people/${personId}/journal?limit=2`).then(r => r.json()).then(d => {
      if (!cancelled && Array.isArray(d.entries)) setJournal(d.entries)
    }).catch(() => {})
    fetch(`/api/people/${personId}/synthesis`).then(r => r.json()).then(d => {
      if (!cancelled && d?.synthesis) setSynth(d.synthesis as PersonSynthesis)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [personId])

  const fmtEventStart = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }
  const fmtMentionDate = (ts: number) => {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
  }
  const kindLabel = (k: string) => ({ whatsapp: 'WA', email: 'Mail', calendar: 'Termin', chat: 'Chat' } as Record<string, string>)[k] || k
  const kindLabelLong = (k: string) => ({ whatsapp: 'WhatsApp', email: 'Mail', calendar: 'Termin', chat: 'Chat' } as Record<string, string>)[k] || k

  const stageLabel = (meta?.stages?.[streamContext] || []).find(s => s.id === primary?.pipeline_stage)?.label || primary?.pipeline_stage || ''
  const streamLabel = (meta?.streams || []).find(s => s.id === streamContext)?.label || streamContext

  const ball = card.ball
  const daysReal = card.days_since_real_contact
  const ballText = ball === 'me' && daysReal != null ? `Du dran seit ${daysReal} T`
    : ball === 'them' && daysReal != null ? `Antwort offen seit ${daysReal} T`
    : ''

  const checklist = (streamContext && primary?.pipeline_stage)
    ? (meta?.stage_checklists?.[streamContext]?.[primary.pipeline_stage] || [])
    : []
  const sp = card.stage_progress || {}
  const offer = card.offer
  const agentPhaseLabels: Record<string, string> = {
    angebot: 'Angebot',
    onboarding: 'Kickoff',
    aufbau: 'Aufbau',
    golive: 'Go-Live',
    betreuung: 'Betreuung',
    abgeschlossen: 'Abgeschlossen',
  }
  const agentWorkflow = streamContext === 'agent'
    ? (meta?.stages?.agent || [])
        .map(stage => ({
          stage,
          items: meta?.stage_checklists?.agent?.[stage.id] || [],
        }))
        .filter(g => g.items.length > 0)
    : []
  const nextAgentStep = agentWorkflow
    .flatMap(g => g.items.map(it => ({ stage: g.stage, item: it })))
    .find(row => !sp[`${row.stage.id}:${row.item.key}`]) || null
  const toggleWorkflowStep = useCallback(async (stageId: string, itemKey: string, done: boolean) => {
    await fetch('/api/customers/check-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_ids: card.person_ids, stage_id: stageId, item_key: itemKey, done, stream: streamContext || null }),
    })
    await onChanged()
  }, [card.person_ids, onChanged, streamContext])
  const markOfferStatus = useCallback(async (status: 'lost' | 'archived') => {
    if (!offer?.token) return
    await fetch('/api/offers/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: offer.token, status }),
    })
    await onChanged()
  }, [offer?.token, onChanged])

  // Kette: aus Leads kann man an Workshop oder direkt an Agent übergeben,
  // aus einem Workshop weiter an Agent. Agent ist das Ende der Kette.
  const handoffTargets = streamContext === 'leads'
    ? ['workshops', 'agent']
    : streamContext === 'workshops'
      ? ['agent']
      : []
  const streamLabelOf = (sid: string) => (meta?.streams || []).find(s => s.id === sid)?.label || sid
  const firstStageOf = (sid: string) => (meta?.stages?.[sid] || [])[0]?.id || null
  const handoffTo = useCallback(async (target: string) => {
    if (!card.person_ids.length) return
    setActionBusy(true)
    try {
      if (streamContext === 'leads') {
        // Bedarf-Weiche: Lead verlässt den Trichter, landet im Zielstream.
        await Promise.all(card.person_ids.map(pid =>
          fetch('/api/customers/handoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: pid, target }),
          })
        ))
      } else {
        // Workshop -> Agent o.ä.: Quelle bleibt parallel bestehen.
        const firstStage = firstStageOf(target)
        if (!firstStage) { setActionBusy(false); return }
        await Promise.all(card.person_ids.map(pid =>
          fetch('/api/customers/stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: pid, stream: target, stage: firstStage, from_stream: streamContext }),
          })
        ))
      }
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, streamContext, meta, onChanged, onClose])
  const removeFromBoard = useCallback(async () => {
    if (!card.person_ids.length) return
    const who = card.subtitle || card.label
    if (!confirm(`${who} aus „${streamLabelOf(streamContext)}" entfernen? Die Person bleibt in der Datenbank.`)) return
    setActionBusy(true)
    try {
      await Promise.all(card.person_ids.map(pid =>
        fetch('/api/customers/membership/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream: streamContext }),
        })
      ))
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, card.subtitle, card.label, streamContext, meta, onChanged, onClose])
  const markLost = useCallback(async (reason: string) => {
    if (!card.person_ids.length) return
    setActionBusy(true)
    try {
      await Promise.all(card.person_ids.map(pid =>
        fetch('/api/customers/membership/lost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream: streamContext, reason }),
        })
      ))
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, streamContext, onChanged, onClose])
  const reactivate = useCallback(async () => {
    if (!card.person_ids.length) return
    setActionBusy(true)
    try {
      await Promise.all(card.person_ids.map(pid =>
        fetch('/api/customers/membership/reactivate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream: streamContext }),
        })
      ))
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, streamContext, onChanged, onClose])
  const LOST_REASON_OPTS: { key: string; label: string }[] = [
    { key: 'nicht_gemeldet', label: 'Nicht gemeldet' },
    { key: 'abgesagt', label: 'Abgesagt' },
    { key: 'kein_bedarf', label: 'Kein Bedarf' },
  ]

  const waHref = primary?.person?.phone
    ? `https://wa.me/${primary.person.phone.replace(/[^0-9]/g, '')}`
    : null
  const mailHref = primary?.person?.email ? `mailto:${primary.person.email}` : null
  const extraIdentities = identities.filter(it => {
    if (it.kind === 'email' && primary?.person?.email && it.value.toLowerCase() === primary.person.email.toLowerCase()) return false
    if (it.kind === 'phone' && primary?.person?.phone) {
      const norm = (s: string) => s.replace(/[^0-9+]/g, '')
      if (norm(it.value) === norm(primary.person.phone)) return false
    }
    return it.kind === 'email' || it.kind === 'phone'
  })

  return (
    <aside
      className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{ width: '440px', background: 'var(--bg-1)', borderLeft: '1px solid var(--border-f)' }}
    >
      <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--border-f)' }}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[24px] italic truncate" style={{ fontFamily: 'var(--font-heading)', color: 'var(--t1)', fontWeight: 500, lineHeight: 1.2 }}>{card.label}</div>
            {card.subtitle ? (
              <div className="text-[15px] mt-1 truncate" style={{ color: 'var(--t2)' }}>{card.subtitle}</div>
            ) : null}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mt-2.5 text-[14px]" style={{ color: 'var(--t3)' }}>
              <span style={{ color: 'var(--t2)' }}>{streamLabel}</span>
              {stageLabel ? <><span>·</span><span style={{ color: 'var(--t2)' }}>{stageLabel}</span></> : null}
              {ballText ? <><span>·</span><span style={{ color: card.attention ? 'var(--cc-orange)' : 'var(--t3)', fontWeight: card.attention ? 600 : 400 }}>{ballText}</span></> : null}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[13px] px-2.5 py-1 rounded-full cursor-pointer transition-colors flex-shrink-0"
            style={{ color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-3)'; e.currentTarget.style.color = 'var(--t1)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-2)'; e.currentTarget.style.color = 'var(--t2)' }}
          >ESC</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
        {!card.lost ? (
          <section className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Wert & nächster Schritt</span>
              {metaSaved ? <span className="text-[12.5px]" style={{ color: 'var(--cc-orange)' }}>gesichert</span> : null}
              {streamContext === 'leads' && card.missing_next_step && !nextStepText.trim() ? (
                <span className="text-[12.5px] ml-auto" style={{ color: 'var(--cc-orange)', fontWeight: 600 }} title="Aktive Karte ohne nächsten Schritt — sie verrottet still">○ Schritt fehlt</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded px-2.5 py-1.5" style={{ background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}>
                <input
                  value={valueInput ? Number(valueInput).toLocaleString('de-DE') : ''}
                  onChange={e => setValueInput(e.target.value.replace(/[^0-9]/g, ''))}
                  onBlur={saveMeta}
                  inputMode="numeric"
                  placeholder="0"
                  className="text-[15px] tabular-nums text-right bg-transparent outline-none"
                  style={{ color: 'var(--t1)', width: '90px' }}
                  title="Erwarteter Auftragswert"
                />
                <span className="text-[14px]" style={{ color: 'var(--t3)' }}>€</span>
              </div>
              <input
                type="date"
                value={nextStepDue}
                onChange={e => setNextStepDue(e.target.value)}
                onBlur={saveMeta}
                className="text-[14.5px] rounded px-2 py-1.5"
                style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)' }}
                title="Fällig am"
              />
            </div>
            <input
              value={nextStepText}
              onChange={e => setNextStepText(e.target.value)}
              onBlur={saveMeta}
              placeholder="Nächster Schritt…"
              className="text-[15px] rounded px-2.5 py-1.5"
              style={{ background: 'var(--bg-2)', color: 'var(--t1)', border: '1px solid var(--border-f)', fontFamily: 'var(--font-body)' }}
            />
          </section>
        ) : null}
        {synth && (synth.stand || synth.verblieben || synth.next) ? (
          <section className="flex flex-col gap-2">
            {synth.stand ? <div className="text-[17px]" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', lineHeight: 1.55 }}>{synth.stand}</div> : null}
            {synth.verblieben ? <div className="text-[15px]" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', lineHeight: 1.55 }}>{synth.verblieben}</div> : null}
            {synth.next ? <div className="text-[15px]" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', lineHeight: 1.55 }}><span style={{ color: 'var(--t3)' }}>→ </span>{synth.next}</div> : null}
          </section>
        ) : null}

        {(crm?.upcoming_events?.length || offer) ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Nächstes</div>
            <div className="flex flex-col gap-1.5">
              {(crm?.upcoming_events || []).map(e => (
                <div key={`ev-${e.id}`} className="flex items-baseline gap-2.5 text-[15px]">
                  <span className="tabular-nums flex-shrink-0" style={{ color: 'var(--t3)' }}>{fmtEventStart(e.start_iso)}</span>
                  <span className="truncate" style={{ color: 'var(--t1)' }}>{e.title}</span>
                </div>
              ))}
              {offer ? (() => {
                const sentAt = offer.sent_at || 0
                const accepted = offer.status === 'accepted'
                const views = offer.opened_count || 0
                return (
                  <>
                    <div className="flex items-baseline gap-2 text-[14.5px]">
                      <span style={{ color: accepted ? 'var(--cc-orange)' : 'var(--t3)' }}>{accepted ? '✓' : '○'}</span>
                      <span style={{ color: 'var(--t1)' }}>Angebot</span>
                      {accepted ? (
                        <span className="text-[13px]" style={{ color: 'var(--t3)' }}>angenommen{offer.accepted_at ? ` · ${relativeDays(offer.accepted_at)}` : ''}</span>
                      ) : (
                        <span className="text-[13px]" style={{ color: 'var(--t3)' }}>
                          {sentAt ? `raus ${relativeDays(sentAt)}` : 'noch nicht raus'} · {views} View{views === 1 ? '' : 's'}
                          {offer.last_opened_at ? ` · zuletzt ${relativeDays(offer.last_opened_at)}` : ''}
                        </span>
                      )}
                      {offer.amount_eur ? <span className="text-[13px] tabular-nums ml-auto" style={{ color: 'var(--t2)' }}>{offer.amount_eur.toLocaleString('de-DE')} €</span> : null}
                    </div>
                    {!accepted && streamContext === 'agent' ? (
                      <div className="flex items-center gap-2 pl-5">
                        <button
                          type="button"
                          onClick={() => markOfferStatus('lost')}
                          className="text-[13px] rounded px-2 py-1"
                          style={{ color: 'var(--t3)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
                        >Verloren</button>
                        <button
                          type="button"
                          onClick={() => markOfferStatus('archived')}
                          className="text-[13px] rounded px-2 py-1"
                          style={{ color: 'var(--t3)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
                        >Archiv</button>
                      </div>
                    ) : null}
                  </>
                )
              })() : null}
            </div>
          </section>
        ) : null}

        {crm?.last_touch ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Letzter Kontakt</div>
            <div className="text-[15px]" style={{ color: 'var(--t1)', lineHeight: 1.55 }}>
              <span style={{ color: 'var(--t3)' }}>{kindLabelLong(crm.last_touch.kind)} · {crm.last_touch.ago_human}</span>
              {crm.last_touch.snippet ? <span> · {crm.last_touch.snippet}</span> : null}
            </div>
          </section>
        ) : null}

        {crm?.open_focus?.length ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Offen</div>
            <div className="flex flex-col gap-1.5">
              {crm.open_focus.map(f => (
                <div key={`of-${f.item_key}`} className="flex items-baseline gap-2 text-[15px]" style={{ color: 'var(--t1)', lineHeight: 1.5 }}>
                  <span style={{ color: 'var(--cc-orange)' }}>→</span>
                  <span className="flex-1">{f.title}</span>
                  {f.date ? <span className="text-[13.5px] tabular-nums flex-shrink-0" style={{ color: 'var(--t3)' }}>{f.date}</span> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {crm?.recent_timeline?.length ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Verlauf</div>
            <div className="flex flex-col gap-1">
              {crm.recent_timeline.slice(0, 6).map((t, i) => (
                <div key={`tl-${i}`} className="flex items-baseline gap-2.5 text-[14.5px] leading-[1.55]">
                  <span className="tabular-nums flex-shrink-0" style={{ color: 'var(--t3)' }}>{fmtMentionDate(t.ts)}</span>
                  <span className="flex-shrink-0 text-[13px]" style={{ color: 'var(--t3)', minWidth: 38 }}>{kindLabel(t.source_kind)}</span>
                  <span className="truncate" style={{ color: 'var(--t1)' }}>{t.snippet}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Kontakt</div>
          {card.kind === 'firm' ? (
            <div className="flex flex-col gap-1.5">
              {card.members.map(m => (
                <div key={m.id} className="flex flex-col text-[14.5px]" style={{ color: 'var(--t2)' }}>
                  <div className="flex items-baseline gap-2">
                    <span style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}>{m.person?.name || '—'}</span>
                    {(m as PipelineCustomer & { firm_role?: string | null }).firm_role ? (
                      <span className="text-[12px] uppercase tracking-wide" style={{ color: 'var(--t3)' }}>{(m as PipelineCustomer & { firm_role?: string | null }).firm_role}</span>
                    ) : null}
                  </div>
                  {m.person?.email ? <a href={`mailto:${m.person.email}`} className="hover:text-[var(--t1)]">{m.person.email}</a> : null}
                  {m.person?.phone ? <a href={`tel:${m.person.phone}`} className="tabular-nums hover:text-[var(--t1)]">{m.person.phone}</a> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 text-[14.5px]" style={{ color: 'var(--t2)' }}>
              {primary?.person?.email ? <a href={`mailto:${primary.person.email}`} className="hover:text-[var(--t1)]">{primary.person.email}</a> : null}
              {primary?.person?.phone ? <a href={`tel:${primary.person.phone}`} className="tabular-nums hover:text-[var(--t1)]">{primary.person.phone}</a> : null}
              {extraIdentities.map(it => (
                <a key={it.id}
                   href={it.kind === 'email' ? `mailto:${it.value}` : `tel:${it.value}`}
                   className="hover:text-[var(--t1)]"
                   style={{ color: 'var(--t3)' }}
                >{it.value}{it.label ? ` · ${it.label}` : ''}</a>
              ))}
              {primary?.person?.company_cluster ? (
                <div className="text-[13px] mt-1" style={{ color: 'var(--t3)' }}>Cluster <span style={{ color: 'var(--t2)' }}>{primary.person.company_cluster}</span></div>
              ) : null}
            </div>
          )}
        </section>

        {memberships.length > 1 ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>In Pipelines</div>
            <div className="flex flex-col gap-1">
              {memberships.map(m => {
                const isCurrent = m.stream === streamContext
                return (
                  <div key={`${m.stream}:${m.stage}`} className="flex items-baseline gap-2.5 text-[14.5px]"
                       style={{ color: isCurrent ? 'var(--t1)' : 'var(--t2)', opacity: m.terminal ? 0.65 : 1 }}>
                    <span className="flex-shrink-0" style={{ color: 'var(--t3)', minWidth: 84 }}>{m.stream_label}</span>
                    <span className="italic truncate" style={{ fontFamily: 'var(--font-heading)' }}>{m.stage_label}</span>
                    {m.terminal ? <span className="text-[12.5px] flex-shrink-0" style={{ color: 'var(--t3)' }}>fertig</span> : null}
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        {agentWorkflow.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Agent Ablauf</div>
              {nextAgentStep ? (
                <div className="text-[13.5px] truncate" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)' }}>
                  <span style={{ color: 'var(--cc-orange)' }}>→</span> {nextAgentStep.item.label}
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              {agentWorkflow.map(group => {
                const doneCount = group.items.filter(it => sp[`${group.stage.id}:${it.key}`]).length
                const active = group.stage.id === primary?.pipeline_stage
                return (
                  <div
                    key={group.stage.id}
                    className="rounded overflow-hidden"
                    style={{ border: `1px solid ${active ? 'var(--border-active)' : 'var(--border-f)'}`, background: active ? 'var(--bg-2)' : 'transparent' }}
                  >
                    <div className="px-3 py-2 flex items-baseline gap-2" style={{ borderBottom: '1px solid var(--border-f)' }}>
                      <span className="text-[12px] uppercase tracking-[0.14em]" style={{ color: active ? 'var(--cc-orange)' : 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: 700 }}>
                        {agentPhaseLabels[group.stage.id] || group.stage.label}
                      </span>
                      <span className="text-[14px] truncate" style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}>
                        {group.stage.label}
                      </span>
                      <span className="ml-auto text-[12.5px] tabular-nums" style={{ color: doneCount === group.items.length ? 'var(--cc-orange)' : 'var(--t3)', fontFamily: 'var(--font-body)', fontWeight: doneCount === group.items.length ? 600 : 400 }}>
                        {doneCount}/{group.items.length}
                      </span>
                    </div>
                    <div className="flex flex-col">
                      {group.items.map(it => {
                        const done = !!sp[`${group.stage.id}:${it.key}`]
                        const isNext = nextAgentStep?.stage.id === group.stage.id && nextAgentStep?.item.key === it.key
                        return (
                          <button
                            key={it.key}
                            type="button"
                            onClick={() => toggleWorkflowStep(group.stage.id, it.key, !done)}
                            className="flex items-center gap-2.5 px-3 py-1.5 text-left text-[14.5px] transition-colors"
                            style={{ background: 'transparent', color: done ? 'var(--t3)' : 'var(--t1)', fontFamily: 'var(--font-body)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-1)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <span className="inline-flex items-center justify-center rounded-full shrink-0"
                                  style={{ width: 16, height: 16, border: done ? '1px solid var(--accent)' : `1.5px solid ${isNext ? 'var(--cc-orange)' : 'var(--t3)'}`, background: done ? 'var(--accent)' : 'transparent', color: 'var(--accent-fg)', fontSize: 10, fontWeight: 700 }}>{done ? '✓' : ''}</span>
                            <span className={done ? 'line-through' : ''}>{it.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ) : checklist.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Schritte · {stageLabel}</div>
            <div className="flex flex-col overflow-hidden rounded" style={{ border: '1px solid var(--border-f)' }}>
              {checklist.map(it => {
                const done = !!sp[`${primary?.pipeline_stage}:${it.key}`]
                return (
                  <button
                    key={it.key}
                    type="button"
                    onClick={async () => {
                      await fetch('/api/customers/check-toggle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ person_ids: card.person_ids, stage_id: primary?.pipeline_stage, item_key: it.key, done: !done, stream: streamContext || null }),
                      })
                      await onChanged()
                    }}
                    className="flex items-center gap-2.5 px-3 py-1.5 text-left text-[14.5px] transition-colors"
                    style={{ background: 'transparent', color: done ? 'var(--t3)' : 'var(--t1)', fontFamily: 'var(--font-body)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-1)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span className="inline-flex items-center justify-center rounded-full shrink-0"
                          style={{ width: 16, height: 16, border: done ? '1px solid var(--accent)' : '1.5px solid var(--t3)', background: done ? 'var(--accent)' : 'transparent', color: 'var(--accent-fg)', fontSize: 10, fontWeight: 700 }}>{done ? '✓' : ''}</span>
                    <span className={done ? 'line-through' : ''}>{it.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}

        {streamContext === 'agent' && primary?.pipeline_stage === 'betreuung' ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Vor-Ort-Termine</div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  await fetch('/api/customers/betreuung-tick', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ person_ids: card.person_ids, delta: -1 }),
                  })
                  await onChanged()
                }}
                disabled={card.betreuung_done <= 0}
                className="w-7 h-7 rounded text-[16px]"
                style={{ background: 'var(--bg-2)', color: 'var(--t2)', border: '1px solid var(--border-f)', opacity: card.betreuung_done <= 0 ? 0.4 : 1 }}
              >−</button>
              <span className="text-[16px] tabular-nums" style={{ color: 'var(--t1)', fontFamily: 'var(--font-heading)', fontWeight: 500 }}>
                {card.betreuung_done} / {meta?.betreuung_total ?? 4}
              </span>
              <button
                onClick={async () => {
                  await fetch('/api/customers/betreuung-tick', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ person_ids: card.person_ids, delta: 1 }),
                  })
                  await onChanged()
                }}
                disabled={card.betreuung_done >= (meta?.betreuung_total ?? 4)}
                className="w-7 h-7 rounded text-[16px]"
                style={{ background: 'var(--bg-2)', color: 'var(--t2)', border: '1px solid var(--border-f)', opacity: card.betreuung_done >= (meta?.betreuung_total ?? 4) ? 0.4 : 1 }}
              >+</button>
            </div>
          </section>
        ) : null}

        {journal.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="text-[13.5px]" style={{ color: 'var(--t3)', fontFamily: 'var(--font-body)' }}>Journal</div>
            <div className="flex flex-col gap-3">
              {journal.map((j, i) => (
                <div key={`j-${i}`} className="flex flex-col gap-1">
                  <div className="flex items-baseline gap-2 text-[13.5px]">
                    <span className="tabular-nums flex-shrink-0" style={{ color: 'var(--t3)' }}>{j.date}</span>
                    <span className="truncate italic" style={{ color: 'var(--t2)', fontFamily: 'var(--font-heading)' }}>{j.title}</span>
                  </div>
                  {j.summary ? <div className="text-[14.5px] whitespace-pre-wrap" style={{ color: 'var(--t1)', lineHeight: 1.55 }}>{j.summary}</div> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="px-5 py-3 border-t flex flex-wrap items-center gap-2" style={{ borderColor: 'var(--border-f)' }}>
        {waHref ? (
          <a href={waHref} target="_blank" rel="noreferrer"
             className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer"
             style={{ color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
             title="WhatsApp öffnen">WhatsApp</a>
        ) : null}
        {mailHref ? (
          <a href={mailHref}
             className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer"
             style={{ color: 'var(--t2)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
             title="Mail schreiben">Mail</a>
        ) : null}
        {handoffTargets.map(target => (
          <button
            key={`handoff-${target}`}
            type="button"
            disabled={actionBusy}
            onClick={() => handoffTo(target)}
            className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-50"
            style={{ color: 'var(--accent)', background: 'var(--bg-2)', border: '1px solid var(--accent)' }}
            title={`An ${streamLabelOf(target)} übergeben`}
          >→ {streamLabelOf(target)}</button>
        ))}
        {card.lost ? (
          <button
            type="button"
            disabled={actionBusy}
            onClick={reactivate}
            className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-50 ml-auto"
            style={{ color: 'var(--accent)', background: 'var(--bg-2)', border: '1px solid var(--accent)' }}
            title="Zurück in die aktive Pipeline holen"
          >↩ Zurück in Pipeline</button>
        ) : showLostReasons ? (
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <span className="text-[13px]" style={{ color: 'var(--t3)' }}>Grund:</span>
            {LOST_REASON_OPTS.map(opt => (
              <button
                key={`lost-${opt.key}`}
                type="button"
                disabled={actionBusy}
                onClick={() => markLost(opt.key)}
                className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-50"
                style={{ color: 'var(--cc-orange)', background: 'var(--bg-2)', border: '1px solid var(--border-f)' }}
              >{opt.label}</button>
            ))}
            <button
              type="button"
              onClick={() => setShowLostReasons(false)}
              className="text-[13px] px-2 py-1.5 rounded-full cursor-pointer"
              style={{ color: 'var(--t3)', background: 'transparent', border: 'none' }}
            >Abbrechen</button>
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => setShowLostReasons(true)}
              className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-50 ml-auto"
              style={{ color: 'var(--cc-orange)', background: 'transparent', border: '1px solid var(--border-f)' }}
              title="Als verloren ablegen, bleibt mit Grund in der Abgelegt-Spur"
            >Verloren</button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={removeFromBoard}
              className="text-[14px] px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-50"
              style={{ color: 'var(--t3)', background: 'transparent', border: '1px solid var(--border-f)' }}
              title="Ganz aus dieser Pipeline entfernen (bleibt in der Datenbank)"
            >Entfernen</button>
          </>
        )}
      </div>
    </aside>
  )
}

export default function FokusApp() {
  const [items, setItems] = useState<FokusItem[]>([])
  const [slots, setSlots] = useState<FokusSlot[]>([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [openItem, setOpenItem] = useState<FokusItem | null>(null)
  const [openPt, setOpenPt] = useState<PtEvent | null>(null)
  const [ptEvents, setPtEvents] = useState<PtEvent[]>([])
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()))
  const [view, setView] = useState<FocusView>(() => {
    try {
      const v = localStorage.getItem('fokus:view')
      if (v === 'week' || v === 'pipeline' || v === 'projects' || v === 'atlas') return v
      if (v === 'marketing') return 'projects'
      if (v === 'agent') return 'pipeline'
    } catch {}
    return 'week'
  })
  useEffect(() => { try { localStorage.setItem('fokus:view', view) } catch {} }, [view])
  useEffect(() => { document.title = 'Fokus' }, [])
  const [drag, setDrag] = useState<DragState>(null)
  const dragRef = useRef<DragState>(null)
  dragRef.current = drag

  const today = useMemo(() => new Date(), [])
  const todayIso = useMemo(() => isoOf(today), [today])
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])
  const itemsByKeyRef = useRef<Map<string, FokusItem>>(new Map())
  itemsByKeyRef.current = useMemo(() => {
    const m = new Map<string, FokusItem>()
    for (const it of items) if (it.item_key) m.set(it.item_key, it)
    return m
  }, [items])

  const loadItems = useCallback(async (): Promise<FokusItem[] | null> => {
    try {
      const r = await fetch('/api/fokus')
      if (r.ok) {
        const d = await r.json()
        if (Array.isArray(d.items)) {
          setItems(d.items)
          return d.items as FokusItem[]
        }
      }
    } catch {}
    return null
  }, [])

  const loadSlots = useCallback(async (start: Date, end: Date) => {
    try {
      const r = await fetch(`/api/fokus/slots?start=${isoOf(start)}&end=${isoOf(end)}`)
      if (r.ok) {
        const d = await r.json()
        if (Array.isArray(d.slots)) setSlots(d.slots)
      }
    } catch {}
  }, [])

  const loadPtEvents = useCallback(async (start: Date, end: Date) => {
    try {
      const toIso = isoOf(addDays(end, 1))
      const r = await fetch(`/api/calendar?from=${isoOf(start)}&to=${toIso}`)
      if (r.ok) {
        const d = await r.json()
        const arr = Array.isArray(d.events) ? d.events : []
        setPtEvents(arr.filter((e: any) => e.source !== 'fokus-overdue' && !e.allDay) as PtEvent[])
      }
    } catch {}
  }, [])

  useEffect(() => { loadItems().finally(() => setLoaded(true)) }, [loadItems])
  useEffect(() => { loadSlots(weekStart, weekEnd) }, [loadSlots, weekStart, weekEnd])
  useEffect(() => { loadPtEvents(weekStart, weekEnd) }, [loadPtEvents, weekStart, weekEnd])
  // SSE: bei jeder Änderung im Fokus-Store sofort neu laden und ggf. offenes Item refreshen
  useEffect(() => {
    const es = new EventSource('/api/fokus/watch')
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data)
        if (d?.type === 'change') {
          loadItems().then(fresh => {
            if (!fresh) return
            setOpenItem(prev => {
              if (!prev) return prev
              const key = prev.item_key
              if (!key) return prev
              const match = fresh.find(it => it.item_key === key)
              return match || null
            })
          })
          loadSlots(weekStart, weekEnd)
        }
      } catch { /* ignore */ }
    }
    es.onerror = () => { /* Browser reconnectet von selbst */ }
    return () => es.close()
  }, [loadItems, loadSlots, weekStart, weekEnd])
  // Sicherheitsnetz: alle 2 Min trotzdem mal frisch ziehen, falls SSE hakt
  useEffect(() => {
    const id = setInterval(() => {
      loadItems()
      loadSlots(weekStart, weekEnd)
      loadPtEvents(weekStart, weekEnd)
    }, 120000)
    return () => clearInterval(id)
  }, [loadItems, loadSlots, loadPtEvents, weekStart, weekEnd])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenItem(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const markDone = async (it: FokusItem) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/fokus/done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: it.bucket, title: it.title }),
      })
      if (res.ok) {
        if (openItem && openItem.title === it.title) setOpenItem(null)
        await loadItems()
        await loadSlots(weekStart, weekEnd)
      }
    } finally { setBusy(false) }
  }

  const setSlot = useCallback(async (title: string, day_iso: string, start_min: number, dur_min: number) => {
    await fetch('/api/fokus/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, day_iso, start_min, dur_min }),
    })
    await loadSlots(weekStart, weekEnd)
  }, [loadSlots, weekStart, weekEnd])

  const onScheduleEmpty = (dayIso: string, startMin: number) => {
    if (!openItem) return
    setSlot(openItem.title, dayIso, startMin, DEFAULT_DUR)
  }

  const openSlot = openItem
    ? slots.find(s => s.item_key === openItem.item_key) || null
    : null

  const findDayUnderPointer = (clientX: number, clientY: number): { dayIso: string; startMin: number } | null => {
    const dayEls = Array.from(document.querySelectorAll<HTMLElement>('[data-day-iso]'))
    for (const el of dayEls) {
      const r = el.getBoundingClientRect()
      if (clientX < r.left || clientX > r.right) continue
      if (clientY < r.top || clientY > r.bottom) continue
      const y = clientY - r.top
      const min = HOUR_START * 60 + snapMin((y / HOUR_PX) * 60)
      const clamped = Math.max(HOUR_START * 60, Math.min(HOUR_END * 60 - DEFAULT_DUR, min))
      const iso = el.getAttribute('data-day-iso') || ''
      if (iso) return { dayIso: iso, startMin: clamped }
    }
    return null
  }

  // Pointer-Move + Up: globaler Drag-Handler
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (d.kind === 'move') {
        const found = findDayUnderPointer(e.clientX, e.clientY)
        if (found) {
          setDrag({ ...d, pointerX: e.clientX, pointerY: e.clientY, ghostDayIso: found.dayIso, ghostStartMin: found.startMin })
        } else {
          setDrag({ ...d, pointerX: e.clientX, pointerY: e.clientY })
        }
      } else if (d.kind === 'resize') {
        const dayEl = document.querySelector<HTMLElement>(`[data-day-iso="${d.dayIso}"]`)
        if (!dayEl) return
        const r = dayEl.getBoundingClientRect()
        const startTop = r.top + ((d.startMin - HOUR_START * 60) / 60) * HOUR_PX
        const dy = e.clientY - startTop
        const dur = Math.max(MIN_DUR, snapMin((dy / HOUR_PX) * 60))
        const maxDur = HOUR_END * 60 - d.startMin
        setDrag({ ...d, ghostDurMin: Math.min(maxDur, dur) })
      } else if (d.kind === 'inbox') {
        const found = findDayUnderPointer(e.clientX, e.clientY)
        setDrag({ ...d, pointerX: e.clientX, pointerY: e.clientY, ghostDayIso: found?.dayIso || null, ghostStartMin: found?.startMin ?? null })
      } else if (d.kind === 'cal-move') {
        const found = findDayUnderPointer(e.clientX, e.clientY)
        if (found) {
          setDrag({ ...d, pointerX: e.clientX, pointerY: e.clientY, ghostDayIso: found.dayIso, ghostStartMin: found.startMin })
        } else {
          setDrag({ ...d, pointerX: e.clientX, pointerY: e.clientY })
        }
      }
    }
    const onUp = async () => {
      const d = dragRef.current
      if (!d) return
      setDrag(null)
      if (d.kind === 'move') {
        if (d.ghostDayIso === d.dayIso && d.ghostStartMin === d.startMin) return
        await setSlot(d.itemTitle, d.ghostDayIso, d.ghostStartMin, d.durMin)
        if (d.ghostDayIso !== d.dayIso) {
          await fetch(`/api/fokus/slots?title=${encodeURIComponent(d.itemTitle)}&day_iso=${encodeURIComponent(d.dayIso)}`, { method: 'DELETE' })
          await loadSlots(weekStart, weekEnd)
        }
      } else if (d.kind === 'resize') {
        if (d.ghostDurMin === d.durMin) return
        await setSlot(d.itemTitle, d.dayIso, d.startMin, d.ghostDurMin)
      } else if (d.kind === 'inbox') {
        if (!d.ghostDayIso || d.ghostStartMin == null) return
        await setSlot(d.itemTitle, d.ghostDayIso, d.ghostStartMin, DEFAULT_DUR)
      } else if (d.kind === 'cal-move') {
        if (d.ghostDayIso === d.dayIso && d.ghostStartMin === d.startMin) return
        const hh = String(Math.floor(d.ghostStartMin / 60)).padStart(2, '0')
        const mm = String(d.ghostStartMin % 60).padStart(2, '0')
        const startIso = `${d.ghostDayIso}T${hh}:${mm}:00`
        setPtEvents(prev => prev.map(p => p.id === d.eventId ? { ...p, startIso } : p))
        const doPatch = async (force: boolean) => fetch(`/api/calendar/${encodeURIComponent(d.eventId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startIso, durationMin: d.durMin, force }),
        })
        try {
          let res = await doPatch(false)
          if (res.status === 409) {
            const data = await res.json().catch(() => ({}))
            const list = (data.conflicts || []).map((c: any) => `${(c.startIso || '').slice(11, 16)} ${c.title || ''}`).join(', ')
            if (confirm(`Konflikt mit: ${list}\nTrotzdem verschieben?`)) {
              res = await doPatch(true)
            } else {
              await loadPtEvents(weekStart, weekEnd)
              return
            }
          }
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            alert(`Verschieben fehlgeschlagen: ${err.error || res.status}`)
            await loadPtEvents(weekStart, weekEnd)
          }
        } catch {
          await loadPtEvents(weekStart, weekEnd)
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [setSlot, loadSlots, loadPtEvents, weekStart, weekEnd])

  const onMoveStart = (slot: FokusSlot, e: React.PointerEvent) => {
    e.preventDefault()
    setDrag({
      kind: 'move',
      slotId: slot.id,
      itemKey: slot.item_key,
      itemTitle: slot.item_title,
      startMin: slot.start_min,
      durMin: slot.dur_min,
      dayIso: slot.day_iso,
      pointerX: e.clientX,
      pointerY: e.clientY,
      ghostDayIso: slot.day_iso,
      ghostStartMin: slot.start_min,
    })
  }

  const onResizeStart = (slot: FokusSlot, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag({
      kind: 'resize',
      slotId: slot.id,
      itemKey: slot.item_key,
      itemTitle: slot.item_title,
      dayIso: slot.day_iso,
      startMin: slot.start_min,
      durMin: slot.dur_min,
      ghostDurMin: slot.dur_min,
    })
  }

  const onCalMoveStart = (ev: PtEvent, dayIso: string, e: React.PointerEvent) => {
    e.preventDefault()
    const d = new Date(ev.startIso)
    const startMin = d.getHours() * 60 + d.getMinutes()
    setDrag({
      kind: 'cal-move',
      eventId: ev.id,
      eventTitle: ev.title,
      source: ev.source || 'manual',
      startMin,
      durMin: ev.durationMin || 60,
      dayIso,
      pointerX: e.clientX,
      pointerY: e.clientY,
      ghostDayIso: dayIso,
      ghostStartMin: startMin,
    })
  }


  const wkNum = isoWeekNum(weekStart)
  const monthLabel = `${MONTH_SHORT[weekStart.getMonth()]}${weekEnd.getMonth() !== weekStart.getMonth() ? ' / ' + MONTH_SHORT[weekEnd.getMonth()] : ''} ${weekStart.getFullYear()}`
  const fmtToday = `${DAY_NAMES[today.getDay()]}, ${today.getDate()}. ${MONTH_SHORT[today.getMonth()]}`

  return (
    <div className="h-screen w-full flex flex-col" style={{ background: 'var(--bg)', color: 'var(--t1)' }}>
      <header className="flex items-baseline gap-6 px-8 py-5 border-b flex-shrink-0" style={{ borderColor: 'var(--border-f)' }}>
        <h1
          className="m-0 italic"
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: '35px',
            fontWeight: 500,
            color: 'var(--t1)',
            letterSpacing: '-0.025em',
            lineHeight: 1,
          }}
        >Fokus</h1>
        <span className="text-[15px] tabular-nums" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)' }}>{fmtToday}</span>

        <div className="flex items-baseline gap-4 ml-6">
          {(['week', 'pipeline', 'projects', 'atlas'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="text-[14px] uppercase tracking-[0.16em] cursor-pointer transition-colors"
              style={{
                color: view === v ? 'var(--warm)' : 'var(--t3)',
                background: 'transparent',
                padding: 0,
                fontFamily: 'var(--font-body)',
                fontWeight: 600,
              }}
              onMouseEnter={e => { if (view !== v) e.currentTarget.style.color = 'var(--t2)' }}
              onMouseLeave={e => { if (view !== v) e.currentTarget.style.color = 'var(--t3)' }}
            >{v === 'week' ? 'Kalender' : v === 'pipeline' ? 'Pipeline' : v === 'projects' ? 'Projekte' : 'Atlas'}</button>
          ))}
        </div>

        <div className="flex items-baseline gap-3 ml-4" style={{ visibility: view === 'week' ? 'visible' : 'hidden' }}>
          <button
            onClick={() => setWeekStart(addDays(weekStart, -7))}
            className="p-1 cursor-pointer rounded transition-colors self-center"
            style={{ color: 'var(--t2)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            title="Vorige Woche"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
            className="px-2 py-0.5 text-[14px] uppercase tracking-[0.16em] cursor-pointer rounded transition-colors"
            style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)', fontWeight: 600 }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--t1)' }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--t2)' }}
          >Heute</button>
          <button
            onClick={() => setWeekStart(addDays(weekStart, 7))}
            className="p-1 cursor-pointer rounded transition-colors self-center"
            style={{ color: 'var(--t2)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            title="Nächste Woche"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="text-[15px] tabular-nums" style={{ color: 'var(--t1)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>
            KW {wkNum}
          </span>
          <span className="text-[15px] tabular-nums" style={{ color: 'var(--t2)', fontFamily: 'var(--font-body)' }}>{monthLabel}</span>
        </div>

        <div className="flex-1" />
      </header>

      {!loaded ? (
        <div className="flex-1 flex items-center justify-center text-[17px] italic" style={{ color: 'var(--t3)', fontFamily: 'var(--font-heading)' }}>Lade…</div>
      ) : view === 'pipeline' ? (
        <PipelineView todayIso={todayIso} onOpenItem={setOpenItem} />
      ) : view === 'projects' ? (
        <ProjectOverviewView />
      ) : view === 'marketing' ? (
        <MarketingView />
      ) : view === 'atlas' ? (
        <iframe
          src="/agent-control-atlas.html"
          title="Agent Control Atlas"
          className="flex-1 w-full border-0"
          style={{ background: 'var(--bg)' }}
        />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto flex flex-col">
            <WeekGrid
              weekStart={weekStart}
              todayIso={todayIso}
              items={items}
              slots={slots}
              ptEvents={ptEvents}
              onOpen={setOpenItem}
              onOpenPt={setOpenPt}
              onScheduleEmpty={onScheduleEmpty}
              onMoveStart={onMoveStart}
              onResizeStart={onResizeStart}
              onCalMoveStart={onCalMoveStart}
              drag={drag}
            />
          </div>
        </div>
      )}

      {openPt && (
        <EventSheet
          ev={openPt}
          allEvents={ptEvents}
          onClose={() => setOpenPt(null)}
          onMutated={() => loadPtEvents(weekStart, weekEnd)}
        />
      )}

      {openItem && (
        <SidePanel
          item={openItem}
          slot={openSlot}
          todayIso={todayIso}
          onClose={() => setOpenItem(null)}
          onDone={() => markDone(openItem)}
          onRefined={action => {
            loadItems()
            if (action === 'deleted') setOpenItem(null)
          }}
          busy={busy}
        />
      )}

      {drag?.kind === 'inbox' && drag.ghostDayIso == null && (
        <div
          className="fixed pointer-events-none z-50 px-3 py-1.5 rounded-md"
          style={{
            left: `${(drag as any).pointerX + 12}px`,
            top: `${(drag as any).pointerY + 12}px`,
            background: 'var(--bg-2)',
            border: '1px solid var(--border-f)',
            color: 'var(--t1)',
            fontFamily: 'var(--font-heading)',
            fontSize: '14px',
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          }}
        >{drag.itemTitle}</div>
      )}
    </div>
  )
}
