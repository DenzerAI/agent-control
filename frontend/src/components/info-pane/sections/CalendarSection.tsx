import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ChevronRight, Calendar, Plus, X, Trash2 } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'
import { openPersonInInfoPane } from '../utils/openPerson'

type CalEvent = {
  id: string
  source: 'ptdesk' | 'manual' | 'fokus-overdue'
  startIso: string
  durationMin: number
  title: string
  notes: string
  location?: string
  status?: string
  type?: string
  customer?: { name?: string; phone?: string; id?: string }
  remainingSessions?: number | null
  activeCardId?: number | null
  activeCardTotalSessions?: number | null
  activeCardUsedSessions?: number | null
  personId?: number
  seriesKey?: string
  cardId?: number | null
  label?: string
  rrule?: '' | 'daily' | 'weekly' | 'monthly'
  rruleUntil?: string
  recurringParentId?: string
  category?: CalCategory
  calendarName?: string
  allDay?: boolean
  overdue?: boolean
  daysOverdue?: number
  originalDate?: string
  itemKey?: string
  bucket?: 'now' | 'soon' | 'later'
}

type CalCategory = 'klaus' | 'privat' | 'fch' | 'ai-workshop' | 'ai-agent' | 'ai-beratung' | 'gecko' | 'ptdesk' | 'admin'

type DraftEvent = {
  date: string
  time: string
  title: string
  durationMin: number
  notes: string
  label: string
  rrule: '' | 'daily' | 'weekly' | 'monthly'
  rruleUntil: string
  category: CalCategory
  allDay: boolean
  endDate: string
  personId?: number | null
  personName?: string
}

type PersonSearchHit = {
  source?: string
  person_id?: number
  name: string
  company?: string
}

type PtCustomerSnapshot = {
  id: number
  name: string
  remaining_sessions?: number | null
  active_card_id?: number | null
  active_card_total_sessions?: number | null
  active_card_used_sessions?: number | null
  total_cards_purchased?: number | null
  price_eur?: number | null
  payment_method?: string
  payment_status?: string
  email?: string
  phone?: string
  whatsapp_chat_id?: string
}

const CAL_CATEGORIES: { id: CalCategory; label: string; dot: string; band: string }[] = [
  { id: 'privat',      label: 'Privat',      dot: '#9a978f',   band: 'rgba(154, 151, 143, 0.12)' },
  { id: 'fch',         label: 'FCH',         dot: '#5fc845',   band: 'rgba(95, 200, 69, 0.14)' },
  { id: 'ai-workshop', label: 'AI Workshop', dot: '#a37acf',   band: 'rgba(163, 122, 207, 0.12)' },
  { id: 'ai-agent',    label: 'AI Agent',    dot: '#d97a5a',   band: 'rgba(217, 122, 90, 0.12)' },
  { id: 'ai-beratung', label: 'AI Beratung', dot: '#e0945a',   band: 'rgba(224, 148, 90, 0.12)' },
  { id: 'gecko',       label: 'Beispielkunde',       dot: '#4abca0',   band: 'rgba(74, 188, 160, 0.14)' },
  { id: 'ptdesk',      label: 'PT',          dot: '#5a8ec8',   band: 'rgba(90, 142, 200, 0.12)' },
  { id: 'admin',       label: 'Admin',       dot: '#8a8e96',   band: 'rgba(138, 142, 150, 0.12)' },
]

type AllDaySpan = {
  event: CalEvent
  pos: 'single' | 'start' | 'middle' | 'end'
}

const LABEL_SUGGESTIONS = ['AI', 'FCH', 'OC']

const DE_WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x }
function ymd(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function sameDay(a: Date, b: Date): boolean { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
function parseStart(iso: string): Date { return new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso) }
function fmtTime(d: Date): string { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function inferPtTrainingType(title: string, label: string): 'personal_training' | 'ems' {
  const head = `${title} ${label}`.trim().toLowerCase()
  return head.startsWith('ems') || /\bems\b/.test(head) ? 'ems' : 'personal_training'
}
function isPastEvent(ev: { startIso: string; durationMin: number }, now: Date): boolean {
  const start = parseStart(ev.startIso)
  const end = new Date(start.getTime() + (ev.durationMin || 0) * 60000)
  return end.getTime() < now.getTime()
}

// Drag-Snapping in 30min-Slots — Tag laeuft von 06:00 bis 23:00.
const DAY_START_HOUR = 6
const DAY_END_HOUR = 23
const SLOTS_PER_DAY = (DAY_END_HOUR - DAY_START_HOUR) * 2

function buildIsoFromDayMinutes(dayKey: string, minutes: number): string {
  const m = Math.max(0, Math.min(SLOTS_PER_DAY * 30 - 30, minutes))
  const h = DAY_START_HOUR + Math.floor(m / 60)
  const mm = m % 60
  return `${dayKey}T${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`
}

// All-Day-Spans für einen bestimmten Tag berechnen. durationMin ist Tage * 1440.
function collectAllDaySpans(all: CalEvent[], day: Date): AllDaySpan[] {
  const out: AllDaySpan[] = []
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
  for (const ev of all) {
    if (!ev.allDay) continue
    const start = parseStart(ev.startIso); start.setHours(0, 0, 0, 0)
    const daysCount = Math.max(1, Math.round((ev.durationMin || 1440) / 1440))
    const last = addDays(start, daysCount - 1); last.setHours(0, 0, 0, 0)
    if (dayStart.getTime() < start.getTime() || dayStart.getTime() > last.getTime()) continue
    const isStart = sameDay(dayStart, start)
    const isEnd = sameDay(dayStart, last)
    const pos: AllDaySpan['pos'] = isStart && isEnd ? 'single' : isStart ? 'start' : isEnd ? 'end' : 'middle'
    out.push({ event: ev, pos })
  }
  return out
}

export function CalendarSection({ mobile, embedded }: { mobile?: boolean; embedded?: boolean }) {
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [open, setOpen] = useState<boolean>(() => {
    if (embedded) return true
    try { return localStorage.getItem('infopane:calOpen') === '1' } catch { return false }
  })
  const [weekOffset, setWeekOffset] = useState<number>(0)
  const [pastEvents, setPastEvents] = useState<CalEvent[]>([])
  const [pastOpen, setPastOpen] = useState<boolean>(false)
  const [pastDaysBack, setPastDaysBack] = useState<number>(0)
  const [draft, setDraft] = useState<DraftEvent | null>(null)
  const [editing, setEditing] = useState<CalEvent | null>(null)
  const [conflictPrompt, setConflictPrompt] = useState<{
    conflicts: CalEvent[]
    label: string
    onConfirm: () => void | Promise<void>
  } | null>(null)
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }, [])

  // Wochenstart (Montag) der aktuell gezeigten KW. Quelle der Wahrheit für den Range.
  const weekStart = useMemo(() => {
    const wd = (today.getDay() + 6) % 7 // Mo=0..So=6
    return addDays(today, -wd + weekOffset * 7)
  }, [today, weekOffset])
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])
  // Range schließt heute mit ein, auch wenn wir die laufende Woche zeigen
  const rangeFrom = useMemo(() => {
    return weekOffset === 0 ? today : weekStart
  }, [weekOffset, today, weekStart])
  const rangeTo = weekEnd

  const load = useCallback(() => {
    const f = ymd(rangeFrom)
    const t = ymd(rangeTo)
    setLoading(true)
    fetch(`/api/calendar?from=${f}&to=${t}`)
      .then(r => r.json())
      .then(d => setEvents(d.events || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [rangeFrom, rangeTo])

  useEffect(() => { if (open) load() }, [open, load])
  useEffect(() => { try { localStorage.setItem('infopane:calOpen', open ? '1' : '0') } catch {} }, [open])

  const loadPast = useCallback((daysBack: number) => {
    if (daysBack <= 0) return
    const f = ymd(addDays(rangeFrom, -daysBack))
    const t = ymd(rangeFrom)
    fetch(`/api/calendar?from=${f}&to=${t}`)
      .then(r => r.json())
      .then(d => setPastEvents(d.events || []))
      .catch(() => {})
  }, [rangeFrom])
  useEffect(() => { if (open && pastOpen) loadPast(pastDaysBack) }, [open, pastOpen, pastDaysBack, loadPast])

  // Findet Termine die mit (startIso, durationMin) überlappen. All-Day wird ignoriert.
  // Überfällige FOCUS-Slots werden mitgezählt — sie werden durch neuen Termin verdrängt.
  // exclId schließt einen bestehenden Termin aus (für Edit/Drag des Termins selbst).
  const findConflicts = useCallback((startIso: string, durationMin: number, exclId?: string): CalEvent[] => {
    const start = parseStart(startIso).getTime()
    const end = start + Math.max(1, durationMin) * 60000
    return events.filter(e => {
      if (e.allDay) return false
      if (exclId && (e.id === exclId || e.recurringParentId === exclId)) return false
      if (e.status === 'cancelled') return false
      const s = parseStart(e.startIso).getTime()
      const ee = s + Math.max(1, e.durationMin || 60) * 60000
      return s < end && ee > start
    }).sort((a, b) => a.startIso.localeCompare(b.startIso))
  }, [events])

  // Markiert ein überfälliges FOCUS-Item als erledigt und lädt neu.
  const markOverdueDone = useCallback(async (ev: CalEvent) => {
    if (ev.source !== 'fokus-overdue') return
    const body = { bucket: ev.bucket || 'later', title: ev.title }
    try {
      await fetch('/api/fokus/done', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } finally {
      setEditing(null)
      load()
    }
  }, [load])

  // PT-Termin absagen (Kunde oder Trainer)
  const cancelPt = useCallback(async (ev: CalEvent, by: 'customer' | 'trainer') => {
    if (ev.source !== 'ptdesk') return
    const ptId = ev.id.replace(/^pt-/, '')
    await fetch(`/api/pt/appointment/${encodeURIComponent(ptId)}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by }),
    })
    setEditing(null)
    load()
  }, [load])

  // PT-Termin als gelaufen markieren
  const completePt = useCallback(async (ev: CalEvent) => {
    if (ev.source !== 'ptdesk') return
    const ptId = ev.id.replace(/^pt-/, '')
    await fetch(`/api/pt/appointment/${encodeURIComponent(ptId)}/complete`, { method: 'POST' })
    setEditing(null)
    load()
  }, [load])

  const setPtRemaining = useCallback(async (ev: CalEvent, remaining: number) => {
    if (ev.source !== 'ptdesk' || !ev.personId) return
    const r = await fetch(`/api/pt/customer/${encodeURIComponent(String(ev.personId))}/remaining`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remaining }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data?.error || 'Restkarten konnten nicht gesetzt werden')
    const nextRemaining = typeof data?.remaining === 'number' ? data.remaining : remaining
    const nextCard = data?.card || {}
    setEvents(prev => prev.map(item => (
      item.source === 'ptdesk' && item.personId === ev.personId
        ? {
            ...item,
            remainingSessions: nextRemaining,
            activeCardId: nextCard.id ?? item.activeCardId ?? null,
            activeCardTotalSessions: nextCard.totalSessions ?? item.activeCardTotalSessions ?? null,
            activeCardUsedSessions: nextCard.usedSessions ?? item.activeCardUsedSessions ?? null,
          }
        : item
    )))
    setEditing(prev => prev && prev.id === ev.id ? {
      ...prev,
      remainingSessions: nextRemaining,
      activeCardId: nextCard.id ?? prev.activeCardId ?? null,
      activeCardTotalSessions: nextCard.totalSessions ?? prev.activeCardTotalSessions ?? null,
      activeCardUsedSessions: nextCard.usedSessions ?? prev.activeCardUsedSessions ?? null,
    } : prev)
    load()
  }, [load])

  const saveDraft = async () => {
    if (!draft || !draft.title.trim() || !draft.date) return
    const doSave = async () => {
      if (draft.category === 'ptdesk') {
        if (!draft.personId) return
        await fetch('/api/pt/appointment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personId: draft.personId,
            date: draft.date,
            startTime: draft.time || '09:00',
            durationMin: draft.durationMin || 60,
            notes: draft.notes,
            trainingType: inferPtTrainingType(draft.title, draft.label),
          }),
        })
      } else {
        const body = draft.allDay
          ? {
              allDay: true,
              startDate: draft.date,
              endDate: draft.endDate || draft.date,
              title: draft.title.trim(),
              notes: draft.notes,
              category: draft.category,
              personId: draft.personId ?? null,
            }
          : {
              startIso: `${draft.date}T${(draft.time || '09:00')}:00`,
              title: draft.title.trim(),
              durationMin: draft.durationMin || 60,
              notes: draft.notes,
              label: draft.label.trim(),
              rrule: draft.rrule,
              rruleUntil: draft.rruleUntil,
              category: draft.category,
              personId: draft.personId ?? null,
            }
        await fetch('/api/calendar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      setDraft(null)
      load()
    }
    if (draft.category !== 'ptdesk' && !draft.allDay) {
      const conflicts = findConflicts(`${draft.date}T${(draft.time || '09:00')}:00`, draft.durationMin || 60)
      if (conflicts.length > 0) {
        setConflictPrompt({ conflicts, label: draft.title.trim() || 'Neuer Termin', onConfirm: doSave })
        return
      }
    }
    await doSave()
  }

  const updateEvent = async (id: string, patch: Partial<CalEvent>) => {
    if (id.startsWith('pt-')) {
      const ptId = id.slice(3)
      if (patch.category && patch.category !== 'ptdesk') {
        await fetch(`/api/pt/appointment/${encodeURIComponent(ptId)}/convert-to-calendar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: patch.title,
            notes: patch.notes,
            startIso: patch.startIso,
            durationMin: patch.durationMin,
            label: patch.label,
            rrule: patch.rrule,
            rruleUntil: patch.rruleUntil,
            category: patch.category,
            personId: patch.personId,
          }),
        })
      } else {
        const d = patch.startIso ? new Date(patch.startIso) : null
        const body: Record<string, unknown> = {}
        if (d) {
          body.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          body.startTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        }
        if (typeof patch.durationMin === 'number') body.durationMin = patch.durationMin
        if (typeof patch.notes === 'string') body.notes = patch.notes
        if (typeof patch.personId === 'number' && patch.personId > 0) body.personId = patch.personId
        if (typeof patch.title === 'string' || typeof patch.label === 'string') {
          body.trainingType = inferPtTrainingType(patch.title || '', patch.label || '')
        }
        await fetch(`/api/pt/appointment/${encodeURIComponent(ptId)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
    } else {
      if (patch.category === 'ptdesk') {
        await fetch(`/api/calendar/${encodeURIComponent(id)}/convert-to-pt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: patch.title,
            notes: patch.notes,
            startIso: patch.startIso,
            durationMin: patch.durationMin,
            label: patch.label,
            personId: patch.personId,
            trainingType: inferPtTrainingType(patch.title || '', patch.label || ''),
          }),
        })
      } else {
        await fetch(`/api/calendar/${encodeURIComponent(id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
      }
    }
    setEditing(null)
    load()
  }

  const deleteEvent = async (id: string) => {
    if (id.startsWith('pt-')) {
      const ptId = id.slice(3)
      await fetch(`/api/pt/appointment/${encodeURIComponent(ptId)}?scope=single`, { method: 'DELETE' })
    } else {
      await fetch(`/api/calendar/${encodeURIComponent(id)}`, { method: 'DELETE' })
    }
    setEditing(null)
    load()
  }

  const reactivateEvent = async (id: string) => {
    await fetch(`/api/calendar/${encodeURIComponent(id)}/reactivate`, { method: 'POST' })
    setEditing(null)
    load()
  }

  const cancelManualEvent = async (id: string) => {
    await fetch(`/api/calendar/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
    setEditing(null)
    load()
  }

  type DragState = { ev: CalEvent; targetDayKey: string | null; newStartIso: string | null; x: number; y: number }
  const [dragging, setDragging] = useState<DragState | null>(null)

  // Wird auf true gesetzt sobald wir gedraggt haben — der darauffolgende synthetische click wird dann verschluckt
  const justDraggedRef = useRef(false)

  const onEventDragStart = useCallback((ev: CalEvent, e: React.MouseEvent) => {
    if (ev.source === 'fokus-overdue') return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const baseIso = ev.startIso
    const baseDuration = ev.durationMin
    const baseId = ev.recurringParentId || ev.id
    const local = { targetDayKey: null as string | null, newStartIso: null as string | null, moved: false }

    const computeForPoint = (cx: number, cy: number) => {
      const el = document.elementFromPoint(cx, cy) as HTMLElement | null
      const dayEl = el?.closest('[data-cal-day]') as HTMLElement | null
      const targetDayKey = dayEl?.getAttribute('data-cal-day') || null
      let newStartIso: string | null = null
      if (targetDayKey) {
        const old = parseStart(baseIso)
        const minutes = (old.getHours() - DAY_START_HOUR) * 60 + old.getMinutes()
        newStartIso = buildIsoFromDayMinutes(targetDayKey, Math.max(0, minutes))
      }
      return { targetDayKey, newStartIso }
    }

    // Pill sofort sichtbar, auch bevor sich die Maus bewegt — gibt klares "in der Hand"-Feedback
    {
      const r0 = computeForPoint(startX, startY)
      local.targetDayKey = r0.targetDayKey
      local.newStartIso = r0.newStartIso
      setDragging({ ev, targetDayKey: r0.targetDayKey, newStartIso: r0.newStartIso, x: startX, y: startY })
    }

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - startX
      const dy = me.clientY - startY
      if (!local.moved && Math.hypot(dx, dy) >= 3) local.moved = true
      const r = computeForPoint(me.clientX, me.clientY)
      local.targetDayKey = r.targetDayKey
      local.newStartIso = r.newStartIso
      setDragging({ ev, targetDayKey: r.targetDayKey, newStartIso: r.newStartIso, x: me.clientX, y: me.clientY })
    }

    const onUp = async () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setDragging(null)
      if (!local.moved) {
        // war ein Klick: wir lassen den onClick-Handler greifen, der öffnet den Editor
        return
      }
      // Drag passiert — kommenden synthetischen click verschlucken
      justDraggedRef.current = true
      if (local.newStartIso && local.newStartIso !== baseIso) {
        const newIso = local.newStartIso
        const doPatch = async () => {
          try {
            if (baseId.startsWith('pt-')) {
              const ptId = baseId.slice(3)
              const d = new Date(newIso)
              const body = {
                date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
                startTime: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
                durationMin: baseDuration,
              }
              await fetch(`/api/pt/appointment/${encodeURIComponent(ptId)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              })
            } else {
              await fetch(`/api/calendar/${encodeURIComponent(baseId)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ startIso: newIso, durationMin: baseDuration }),
              })
            }
          } finally {
            load()
          }
        }
        const conflicts = findConflicts(newIso, baseDuration, baseId)
        if (conflicts.length > 0) {
          setConflictPrompt({ conflicts, label: ev.title || 'Termin', onConfirm: doPatch })
        } else {
          await doPatch()
        }
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [load, findConflicts])

  const onEventClick = useCallback((ev: CalEvent) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    setEditing(ev)
  }, [])

  // Relativ zum Guide-Indent — kleine Schritte, dann sieht Mobile gleich aus wie Desktop.
  const dayPad = 4
  const eventPad = dayPad + 12

  // Vergangene Tage absteigend (heute - 1 zuerst), nur Tage mit Events.
  const pastDays = useMemo(() => {
    const out: { date: Date; events: CalEvent[]; allDaySpans: AllDaySpan[]; isToday: boolean }[] = []
    for (let i = 1; i <= pastDaysBack; i++) {
      const d = addDays(rangeFrom, -i)
      const timed = pastEvents.filter(e => !e.allDay && sameDay(parseStart(e.startIso), d))
        .sort((a, b) => a.startIso.localeCompare(b.startIso))
      const spans = collectAllDaySpans(pastEvents, d)
      if (timed.length > 0 || spans.length > 0) out.push({ date: d, events: timed, allDaySpans: spans, isToday: false })
    }
    return out
  }, [pastEvents, rangeFrom, pastDaysBack])

  // Pro Tag Events sammeln — eine Woche, vergangenes raus, abgesagtes raus.
  const now = useMemo(() => new Date(), [events])
  const days = useMemo(() => {
    const out: { date: Date; events: CalEvent[]; allDaySpans: AllDaySpan[]; isToday: boolean }[] = []
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i)
      let timed = events.filter(e => !e.allDay && sameDay(parseStart(e.startIso), d))
      timed = timed.filter(e => !isPastEvent(e, now))
      timed = timed.sort((a, b) => a.startIso.localeCompare(b.startIso))
      const spans = collectAllDaySpans(events, d)
      const isTodayCell = sameDay(d, today)
      if (timed.length > 0 || spans.length > 0 || isTodayCell) {
        out.push({ date: d, events: timed, allDaySpans: spans, isToday: isTodayCell })
      }
    }
    return out
  }, [events, weekStart, today, now])

  const kwLabel = useMemo(() => {
    const target = new Date(weekStart)
    const day = target.getDay() || 7
    target.setDate(target.getDate() + 4 - day)
    const yearStart = new Date(target.getFullYear(), 0, 1)
    const kw = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
    const sun = addDays(weekStart, 6)
    const fmt = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`
    return `KW ${kw} · ${fmt(weekStart)} – ${fmt(sun)}`
  }, [weekStart])

  const addDraft = () => setDraft({ date: ymd(today), time: '09:00', title: '', durationMin: 60, notes: '', label: '', rrule: '', rruleUntil: '', category: 'privat', allDay: false, endDate: '', personId: null, personName: '' })
  return (
    <div>
      {embedded ? (
        <div className="flex items-center px-4 py-3">
          <Calendar className="info-icon-md text-[var(--accent)] mr-2 flex-shrink-0" />
          <span className="info-text-body text-[var(--t1)] font-semibold">Kalender</span>
          <span className="flex-1" />
          <button
            onClick={(e) => { e.stopPropagation(); addDraft() }}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 info-text-meta text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] cursor-pointer flex-shrink-0 transition-colors"
            title="Termin hinzufügen">
            <Plus className="info-icon-sm" /> Termin
          </button>
        </div>
      ) : (
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Calendar className="info-icon-md text-[var(--t3)] mr-2 flex-shrink-0" />
        <span className="text-[var(--t2)] font-medium">Kalender</span>
        <button
          onClick={(e) => { e.stopPropagation(); addDraft() }}
          className="ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          title="Termin hinzufügen">
          <Plus className="info-icon-sm" />
        </button>
        <span className="flex-1" />
      </div>
      )}
      {open && (
        <div onClick={(e) => e.stopPropagation()}>
          <Guided>
          <div
            className={`flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-meta text-[var(--t2)]`}
            style={{ paddingLeft: `${dayPad}px` }}>
            <button
              onClick={(e) => { e.stopPropagation(); setWeekOffset(o => o - 1) }}
              className="cursor-pointer text-[var(--t3)] hover:text-[var(--t1)] px-2 -ml-2"
              aria-label="vorige Woche">
              ‹
            </button>
            <span className="flex-1 text-center tabular-nums">{kwLabel}</span>
            <button
              onClick={(e) => { e.stopPropagation(); setWeekOffset(o => o + 1) }}
              className="cursor-pointer text-[var(--t3)] hover:text-[var(--t1)] px-2 -mr-2"
              aria-label="naechste Woche">
              ›
            </button>
          </div>
          {loading && events.length === 0 ? (
            <div
              className={`info-text-meta text-[var(--t3)]/50 italic ${mobile ? 'py-2' : 'py-[5px]'} pr-3`}
              style={{ paddingLeft: `${dayPad}px` }}>
              lade …
            </div>
          ) : days.length === 0 ? (
            <div
              className={`info-text-meta text-[var(--t3)]/50 ${mobile ? 'py-2' : 'py-[5px]'} pr-3`}
              style={{ paddingLeft: `${dayPad}px` }}>
              keine Termine
            </div>
          ) : (
            days.map(d => (
              <CalDayGroup
                key={ymd(d.date)}
                date={d.date}
                events={d.events}
                allDaySpans={d.allDaySpans}
                isToday={d.isToday}
                mobile={mobile}
                dayPad={dayPad}
                eventPad={eventPad}
                onPickEvent={onEventClick}
                onMoveStart={onEventDragStart}
                isDropTarget={dragging?.targetDayKey === ymd(d.date)}
                draggingEventId={dragging?.ev.id || null}
              />
            ))
          )}
          <div>
            <button
              onClick={() => {
                const next = !pastOpen
                setPastOpen(next)
                if (next && pastDaysBack === 0) setPastDaysBack(14)
              }}
              className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
              <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${pastOpen ? 'rotate-90' : ''}`} />
              <span className="truncate flex-1 text-left text-[var(--t3)] group-hover:text-[var(--t1)]">Vergangen</span>
            </button>
            {pastOpen && (
              <Guided>
                {pastDays.length === 0 ? (
                  <div
                    className={`info-text-meta text-[var(--t3)]/50 ${mobile ? 'py-2' : 'py-[5px]'} pl-1 pr-3`}>
                    keine Termine
                  </div>
                ) : (
                  pastDays.map(d => (
                    <CalDayGroup
                      key={ymd(d.date)}
                      date={d.date}
                      events={d.events}
                      allDaySpans={d.allDaySpans}
                      isToday={false}
                      mobile={mobile}
                      dayPad={4}
                      eventPad={16}
                      onPickEvent={onEventClick}
                      onMoveStart={onEventDragStart}
                      isDropTarget={dragging?.targetDayKey === ymd(d.date)}
                      draggingEventId={dragging?.ev.id || null}
                    />
                  ))
                )}
                <button
                  onClick={() => setPastDaysBack(n => n + 14)}
                  className={`info-text-meta text-[var(--t3)]/50 hover:text-[var(--t2)] cursor-pointer ${mobile ? 'py-2' : 'py-[5px]'} pl-1 pr-3 block`}>
                  weitere 14 Tage zurück
                </button>
              </Guided>
            )}
          </div>
          {(draft || editing) && (
            <CalEditor
              draft={draft}
              editing={editing}
              onClose={() => { setDraft(null); setEditing(null) }}
              onSave={async () => {
                if (editing) {
                  if (editing.allDay) {
                    const start = parseStart(editing.startIso); start.setHours(0,0,0,0)
                    const days = Math.max(1, Math.round((editing.durationMin || 1440) / 1440))
                    const startDate = ymd(start)
                    const endDate = ymd(addDays(start, days - 1))
                    await fetch(`/api/calendar/${encodeURIComponent(editing.id)}`, {
                      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        allDay: true, startDate, endDate,
                        title: editing.title, notes: editing.notes, category: editing.category,
                      }),
                    })
                    setEditing(null); load()
                  } else {
                    const targetId = editing.recurringParentId || editing.id
                    const doUpdate = () => updateEvent(targetId, {
                      title: editing.title,
                      notes: editing.notes,
                      startIso: editing.startIso,
                      durationMin: editing.durationMin,
                      label: editing.label || '',
                      rrule: editing.rrule || '',
                      rruleUntil: editing.rruleUntil || '',
                      category: editing.category,
                      personId: editing.personId,
                    })
                    const conflicts = findConflicts(editing.startIso, editing.durationMin || 60, targetId)
                    if (conflicts.length > 0) {
                      setConflictPrompt({ conflicts, label: editing.title || 'Termin', onConfirm: doUpdate })
                    } else {
                      await doUpdate()
                    }
                  }
                } else {
                  await saveDraft()
                }
              }}
              onChangeDraft={setDraft}
              onChangeEditing={setEditing}
              onDelete={editing ? () => deleteEvent(editing.recurringParentId || editing.id) : undefined}
              onMarkOverdueDone={editing && editing.source === 'fokus-overdue' ? () => markOverdueDone(editing) : undefined}
              onCancelPt={editing && editing.source === 'ptdesk' ? (by) => cancelPt(editing, by) : undefined}
              onCompletePt={editing && editing.source === 'ptdesk' ? () => completePt(editing) : undefined}
              onSetPtRemaining={editing && editing.source === 'ptdesk' ? (remaining) => setPtRemaining(editing, remaining) : undefined}
              onReactivate={editing && editing.source !== 'ptdesk' && editing.status === 'cancelled' ? () => reactivateEvent(editing.recurringParentId || editing.id) : undefined}
              onManualCancel={editing && editing.source !== 'ptdesk' && editing.status !== 'cancelled' ? () => cancelManualEvent(editing.recurringParentId || editing.id) : undefined}
            />
          )}
          </Guided>
        </div>
      )}
      {dragging && (
        <div
          className="fixed pointer-events-none z-[100] info-text-meta bg-[var(--bg-1)] border border-[var(--border)] rounded px-2 py-1 shadow-xl whitespace-nowrap"
          style={{ left: `${dragging.x + 14}px`, top: `${dragging.y + 14}px` }}>
          {dragging.newStartIso ? (() => {
            const d = parseStart(dragging.newStartIso)
            return `${DE_WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()}.${d.getMonth() + 1}. · ${fmtTime(d)}`
          })() : (
            <span className="text-[var(--t3)]">über keinen Tag</span>
          )}
        </div>
      )}
      {conflictPrompt && (() => {
        const onlyOverdue = conflictPrompt.conflicts.every(c => c.source === 'fokus-overdue')
        const heading = onlyOverdue ? 'Verdrängt überfälliges Item' : 'Überlappung mit anderem Termin'
        const intro = onlyOverdue
          ? <><span className="text-[var(--t3)]">"{conflictPrompt.label}"</span> verdrängt:</>
          : <><span className="text-[var(--t3)]">"{conflictPrompt.label}"</span> kollidiert mit:</>
        const confirmLabel = onlyOverdue ? 'Trotzdem anlegen' : 'Trotzdem speichern'
        return (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40" onClick={() => setConflictPrompt(null)}>
            <div
              className="bg-[var(--bg-1)] border border-[var(--border)] rounded-lg shadow-xl max-w-md w-[min(420px,92vw)] p-4"
              onClick={(e) => e.stopPropagation()}>
              <div className="info-text-body text-[var(--t1)] font-medium mb-2">{heading}</div>
              <div className="info-text-meta text-[var(--t2)] mb-2">{intro}</div>
              <ul className="info-text-meta text-[var(--t2)] mb-4 space-y-1">
                {conflictPrompt.conflicts.map(c => {
                  const s = parseStart(c.startIso)
                  const e = new Date(s.getTime() + (c.durationMin || 60) * 60000)
                  const isOv = c.source === 'fokus-overdue'
                  return (
                    <li key={c.id} className="flex items-center gap-2">
                      <span className="text-[var(--t3)] tabular-nums">{`${s.getDate()}.${s.getMonth() + 1}. ${fmtTime(s)}–${fmtTime(e)}`}</span>
                      <span className="truncate">{c.title}</span>
                      {isOv && <span className="info-text-meta uppercase tracking-wider tabular-nums" style={{ color: '#d18a4a' }}>{c.daysOverdue ? `+${c.daysOverdue}d` : 'fällig'}</span>}
                    </li>
                  )
                })}
              </ul>
              {onlyOverdue && (
                <div className="info-text-meta text-[var(--t3)]/70 mb-3">
                  Wandert automatisch in den nächsten freien Slot.
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  className="info-text-meta px-3 py-1.5 rounded hover:bg-white/[0.06] text-[var(--t2)] cursor-pointer"
                  onClick={() => setConflictPrompt(null)}>
                  Abbrechen
                </button>
                <button
                  className="info-text-meta px-3 py-1.5 rounded bg-white/[0.10] hover:bg-white/[0.16] text-[var(--t1)] cursor-pointer"
                  onClick={async () => { const fn = conflictPrompt.onConfirm; setConflictPrompt(null); await fn() }}>
                  {confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function CalDayGroup({ date, events, allDaySpans, isToday, mobile, dayPad, eventPad, onPickEvent, onMoveStart, isDropTarget, draggingEventId }: {
  date: Date
  events: CalEvent[]
  allDaySpans: AllDaySpan[]
  isToday: boolean
  mobile?: boolean
  dayPad: number
  eventPad: number
  onPickEvent: (ev: CalEvent) => void
  onMoveStart?: (ev: CalEvent, e: React.MouseEvent) => void
  isDropTarget?: boolean
  draggingEventId?: string | null
}) {
  const dayKey = ymd(date)
  const dayDiff = Math.round((date.getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000)
  const label = dayDiff === 0
    ? 'Heute'
    : dayDiff === 1
      ? 'Morgen'
      : `${DE_WEEKDAYS[(date.getDay() + 6) % 7]} ${date.getDate()}.${date.getMonth() + 1}.`
  const now = new Date()

  return (
    <div data-cal-day={dayKey}>
      <div
        className={`flex items-center pr-3 ${mobile ? 'py-1.5' : 'py-[3px]'} transition-colors ${isDropTarget ? 'bg-white/[0.12] ring-1 ring-[var(--t3)]/40' : ''}`}
        style={{ paddingLeft: `${dayPad}px` }}>
        <span className={`info-text-meta uppercase tracking-wider tabular-nums ${isToday ? 'text-[var(--t2)] font-medium' : 'text-[var(--t3)]/70'}`}>{label}</span>
        <span className="flex-1" />
      </div>
      {allDaySpans.map((span, i) => {
        const cat = CAL_CATEGORIES.find(c => c.id === (span.event.category as CalCategory))
        const title = span.event.title || 'Ganztägig'
        const text = span.pos === 'single' ? title
          : span.pos === 'start' ? `${title} →`
          : span.pos === 'end' ? `← ${title}`
          : '·'
        return (
          <button
            key={`allday-${span.event.id}-${i}`}
            onClick={() => onPickEvent(span.event)}
            className={`group w-full flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
            style={{ paddingLeft: `${eventPad}px` }}
            title={span.event.calendarName || ''}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
              style={{ background: cat?.dot || 'var(--t3)' }}
            />
            <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 w-12 mr-3">·</span>
            <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{text}</span>
          </button>
        )
      })}
      {events.map(ev => {
        const start = parseStart(ev.startIso)
        const time = fmtTime(start)
        const isOverdue = ev.source === 'fokus-overdue'
        const cancelled = ev.status === 'cancelled'
        const done = ev.status === 'done'
        const past = isPastEvent(ev, now)
        const isPt = ev.source === 'ptdesk'
        const catDot = isOverdue
          ? '#d18a4a'
          : isPt
            ? '#7a9fa3'
            : (CAL_CATEGORIES.find(c => c.id === (ev.category as CalCategory))?.dot || 'var(--t3)')
        const titleColor = isOverdue
          ? 'text-[var(--t1)]'
          : done ? 'text-[var(--t3)]' : 'text-[var(--t2)]'
        const overdueColor = '#d18a4a'
        const isBeingDragged = draggingEventId === ev.id
        return (
          <button
            key={ev.id}
            data-cal-event={ev.id}
            onMouseDown={(e) => {
              if (e.button !== 0) return
              if (isOverdue) return
              if (onMoveStart) onMoveStart(ev, e)
            }}
            onClick={() => onPickEvent(ev)}
            className={`group w-full flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors ${isBeingDragged ? 'opacity-40' : ''} ${past && !isOverdue ? 'opacity-55' : ''} ${cancelled ? 'opacity-60' : ''}`}
            style={{ paddingLeft: `${eventPad}px` }}
            title={isOverdue ? `${ev.daysOverdue ?? 0}d überfällig (seit ${ev.originalDate || ''})` : (cancelled ? 'Abgesagt — Tap öffnet Termin' : (ev.calendarName || ''))}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
              style={{ background: catDot }}
            />
            <span className={`info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 w-12 mr-3 ${cancelled ? 'line-through' : ''}`}>{time}</span>
            <span className={`truncate flex-1 ${titleColor} group-hover:text-[var(--t1)] ${cancelled ? 'line-through' : ''}`}>{ev.title}</span>
            {cancelled && (
              <span className="info-text-meta uppercase tracking-wider flex-shrink-0 ml-2 text-[var(--t3)]">abgesagt</span>
            )}
            {isPt && ev.remainingSessions != null && (
              <span className="info-text-meta text-[var(--t3)]/75 flex-shrink-0 ml-2 tabular-nums">
                {`Rest ${ev.remainingSessions}`}
              </span>
            )}
            {isOverdue && (
              <span className="info-text-meta uppercase tracking-wider flex-shrink-0 tabular-nums ml-2" style={{ color: overdueColor }}>
                {ev.daysOverdue ? `+${ev.daysOverdue}d` : 'fällig'}
              </span>
            )}
            {ev.rrule && !isPt && !isOverdue && (
              <span className="info-text-meta text-[var(--t3)]/50 flex-shrink-0 ml-1.5">↻</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function CalEditor({ draft, editing, onClose, onSave, onChangeDraft, onChangeEditing, onDelete, onMarkOverdueDone, onCancelPt, onCompletePt, onSetPtRemaining, onReactivate, onManualCancel }: {
  draft: DraftEvent | null
  editing: CalEvent | null
  onClose: () => void
  onSave: () => Promise<void> | void
  onChangeDraft: (d: typeof draft) => void
  onChangeEditing: (e: CalEvent | null) => void
  onDelete?: () => void
  onMarkOverdueDone?: () => void
  onCancelPt?: (by: 'customer' | 'trainer') => void
  onCompletePt?: () => void
  onSetPtRemaining?: (remaining: number) => Promise<void> | void
  onReactivate?: () => void
  onManualCancel?: () => void
}) {
  const isCancelledManual = editing?.status === 'cancelled' && editing?.source !== 'ptdesk'
  const isEdit = !!editing
  const date = isEdit ? (editing!.startIso.slice(0, 10)) : (draft?.date || '')
  const time = isEdit ? (editing!.startIso.slice(11, 16) || '09:00') : (draft?.time || '09:00')
  const title = isEdit ? editing!.title : (draft?.title || '')
  const dur = isEdit ? editing!.durationMin : (draft?.durationMin || 60)
  const notes = isEdit ? (editing!.notes || '') : (draft?.notes || '')
  const label = isEdit ? (editing!.label || '') : (draft?.label || '')
  const rrule = isEdit ? (editing!.rrule || '') : (draft?.rrule || '')
  const rruleUntil = isEdit ? (editing!.rruleUntil || '') : (draft?.rruleUntil || '')
  const category: CalCategory = isEdit ? ((editing!.category as CalCategory) || 'privat') : (draft?.category || 'privat')
  const allDay = isEdit ? !!editing!.allDay : !!draft?.allDay
  const personId = isEdit ? (editing?.personId ?? null) : (draft?.personId ?? null)
  const personName = isEdit ? (editing?.customer?.name || editing?.title || '') : (draft?.personName || '')
  const endDate = isEdit
    ? (() => {
        const start = parseStart(editing!.startIso); start.setHours(0,0,0,0)
        const days = Math.max(1, Math.round((editing!.durationMin || 1440) / 1440))
        return ymd(addDays(start, days - 1))
      })()
    : (draft?.endDate || draft?.date || '')
  const isPt = isEdit && editing!.source === 'ptdesk'
  const isOverdue = isEdit && editing!.source === 'fokus-overdue'
  const isPtCategory = !isOverdue && category === 'ptdesk'
  const headerLabel = !isEdit
    ? 'Neuer Termin'
    : isOverdue
      ? 'Überfälliges Fokus-Item'
      : isPt
        ? 'PT-Termin'
        : 'Termin bearbeiten'

  const [briefing, setBriefing] = useState<{ text: string; people: Array<{ id: number; name: string; company: string; offer_eur: number; touchpoints: Array<{ kind: string; snippet: string; when: string }> }> } | null>(null)
  const [briefingLoading, setBriefingLoading] = useState(false)
  const [remainingDraft, setRemainingDraft] = useState<string>('')
  const [remainingBusy, setRemainingBusy] = useState(false)
  const [personQuery, setPersonQuery] = useState('')
  const [personResults, setPersonResults] = useState<PersonSearchHit[]>([])
  const [personSearchOpen, setPersonSearchOpen] = useState(false)
  const [ptCustomer, setPtCustomer] = useState<PtCustomerSnapshot | null>(null)
  const [cardTotalDraft, setCardTotalDraft] = useState('')
  const [cardPriceDraft, setCardPriceDraft] = useState('')
  const [cardMethodDraft, setCardMethodDraft] = useState('')
  const [cardStatusDraft, setCardStatusDraft] = useState('pending')
  useEffect(() => {
    if (!isEdit || !editing) { setBriefing(null); return }
    if (editing.source === 'fokus-overdue' || isPtCategory) { setBriefing(null); return }
    let abort = false
    setBriefingLoading(true)
    fetch(`/api/calendar/briefing/${encodeURIComponent(editing.id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!abort) setBriefing(d && (d.text || (d.people && d.people.length)) ? d : null) })
      .catch(() => {})
      .finally(() => { if (!abort) setBriefingLoading(false) })
    return () => { abort = true }
  }, [isEdit, editing?.id, editing?.source, isPtCategory])

  useEffect(() => {
    if (!isPt || !editing) {
      setRemainingDraft('')
      return
    }
    setRemainingDraft(editing.remainingSessions != null ? String(editing.remainingSessions) : '')
  }, [isPt, editing?.id, editing?.remainingSessions])

  useEffect(() => {
    if (!personSearchOpen) return
    const q = personQuery.trim()
    if (q.length < 2) {
      setPersonResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      fetch(`/api/people/search?q=${encodeURIComponent(q)}&limit=8`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(j => {
          if (!alive) return
          setPersonResults((j.results || []).filter((x: PersonSearchHit) => x.source === 'person'))
        })
        .catch(() => { if (alive) setPersonResults([]) })
    }, 180)
    return () => { alive = false; clearTimeout(t) }
  }, [personQuery, personSearchOpen])

  useEffect(() => {
    if (!isPtCategory || !personId) {
      setPtCustomer(null)
      return
    }
    let alive = true
    fetch(`/api/pt/customer?customer_id=${encodeURIComponent(String(personId))}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && d?.customer) setPtCustomer(d.customer as PtCustomerSnapshot) })
      .catch(() => { if (alive) setPtCustomer(null) })
    return () => { alive = false }
  }, [isPtCategory, personId])

  useEffect(() => {
    if (!ptCustomer) {
      setCardTotalDraft('')
      setCardPriceDraft('')
      setCardMethodDraft('')
      setCardStatusDraft('pending')
      return
    }
    setCardTotalDraft(typeof ptCustomer.active_card_total_sessions === 'number' ? String(ptCustomer.active_card_total_sessions) : '')
    setCardPriceDraft(typeof ptCustomer.price_eur === 'number' ? String(ptCustomer.price_eur) : '')
    setCardMethodDraft(ptCustomer.payment_method || '')
    setCardStatusDraft(ptCustomer.payment_status || 'pending')
  }, [ptCustomer?.id, ptCustomer?.active_card_total_sessions, ptCustomer?.price_eur, ptCustomer?.payment_method, ptCustomer?.payment_status])

  type Patch = Partial<{ date: string; time: string; title: string; durationMin: number; notes: string; label: string; rrule: '' | 'daily' | 'weekly' | 'monthly'; rruleUntil: string; category: CalCategory; allDay: boolean; endDate: string; personId: number | null; personName: string }>
  const setField = (patch: Patch) => {
    if (isEdit && editing) {
      const nextCategory = patch.category ?? ((editing.category as CalCategory) || 'privat')
      const nextAllDay = nextCategory === 'ptdesk' ? false : (patch.allDay ?? !!editing.allDay)
      if (nextAllDay) {
        const sd = patch.date ?? date
        const ed = patch.endDate ?? endDate ?? sd
        const startIso = `${sd}T00:00:00`
        const startD = parseStart(startIso); startD.setHours(0,0,0,0)
        const endD = parseStart(`${ed}T00:00:00`); endD.setHours(0,0,0,0)
        const days = Math.max(1, Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1)
        onChangeEditing({
          ...editing,
          startIso,
          durationMin: days * 1440,
          allDay: true,
          title: patch.title ?? editing.title,
          notes: patch.notes ?? editing.notes,
          category: patch.category ?? editing.category,
          personId: patch.personId ?? editing.personId,
          customer: patch.personName ? { ...(editing.customer || {}), name: patch.personName } : editing.customer,
        })
        return
      }
      const startIso = `${patch.date ?? date}T${patch.time ?? time}:00`
      onChangeEditing({
        ...editing,
        startIso,
        title: patch.title ?? editing.title,
        durationMin: patch.durationMin ?? editing.durationMin,
        notes: patch.notes ?? editing.notes,
        label: patch.label ?? editing.label ?? '',
        rrule: patch.rrule ?? editing.rrule ?? '',
        rruleUntil: patch.rruleUntil ?? editing.rruleUntil ?? '',
        category: nextCategory,
        allDay: false,
        personId: patch.personId ?? editing.personId,
        customer: patch.personName ? { ...(editing.customer || {}), name: patch.personName } : editing.customer,
      })
    } else if (draft) {
      onChangeDraft({
        date: patch.date ?? draft.date,
        time: patch.time ?? draft.time,
        title: patch.title ?? draft.title,
        durationMin: patch.durationMin ?? draft.durationMin,
        notes: patch.notes ?? draft.notes,
        label: patch.label ?? draft.label,
        rrule: patch.rrule ?? draft.rrule,
        rruleUntil: patch.rruleUntil ?? draft.rruleUntil,
        category: patch.category ?? draft.category,
        allDay: (patch.category ?? draft.category) === 'ptdesk' ? false : (patch.allDay ?? draft.allDay),
        endDate: patch.endDate ?? draft.endDate,
        personId: patch.personId ?? draft.personId ?? null,
        personName: patch.personName ?? draft.personName ?? '',
      })
    }
  }

  const saveDisabled = isPtCategory && !personId
  const hasEditablePtCard = !!ptCustomer?.active_card_id

  const savePtCardMeta = async () => {
    if (!personId || remainingBusy) return
    setRemainingBusy(true)
    try {
      await fetch(`/api/pt/customer/${personId}/card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalSessions: cardTotalDraft === '' ? null : parseInt(cardTotalDraft, 10),
          priceEur: cardPriceDraft === '' ? null : parseInt(cardPriceDraft, 10),
          paymentMethod: cardMethodDraft,
          paymentStatus: cardStatusDraft,
        }),
      })
      if (personId) {
        const r = await fetch(`/api/pt/customer?customer_id=${encodeURIComponent(String(personId))}`)
        const data = await r.json().catch(() => ({}))
        if (r.ok && data?.customer) setPtCustomer(data.customer as PtCustomerSnapshot)
      }
    } finally {
      setRemainingBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="max-w-sm w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-lg overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]/40">
          <span className="info-text-body text-[var(--t1)] font-medium">{headerLabel}</span>
          <button onClick={onClose} className="info-btn-icon"><X className="info-icon-md" /></button>
        </div>
        <div className="p-3 flex flex-col gap-2">
          {isOverdue && isEdit && editing && (
            <>
              <div className="info-text-body text-[var(--t1)] font-medium">{editing.title}</div>
              <div className="info-text-meta text-[var(--t3)]">
                {editing.daysOverdue ?? 0}d überfällig
                {editing.originalDate ? ` · ursprünglich ${editing.originalDate}` : ''}
              </div>
              <div className="info-text-meta text-[var(--t3)]/70 leading-snug">
                Wandert in den nächsten freien Slot bis du es erledigst oder das Datum im Fokus-Item bewusst änderst.
              </div>
              <div className="flex items-center gap-2 pt-2">
                <div className="flex-1" />
                <button onClick={onClose} className="info-btn-chip info-text-meta">Schließen</button>
                {onMarkOverdueDone && (
                  <button onClick={onMarkOverdueDone} className="info-btn-chip info-text-meta text-[var(--t1)]">Erledigt</button>
                )}
              </div>
            </>
          )}
          {!isOverdue && (
            <>
              <input
                type="text"
                value={title}
                onChange={e => setField({ title: e.target.value })}
                placeholder="Titel"
                autoFocus
                className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-body text-[var(--t1)] placeholder:text-[var(--t3)]/50 outline-none focus:border-[var(--t3)]"
              />
              <div className="flex flex-wrap gap-1">
                {CAL_CATEGORIES.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setField({ category: c.id })}
                    className={`info-text-meta px-2 py-1 rounded inline-flex items-center gap-1.5 transition-colors ${category === c.id ? 'bg-[var(--t2)]/15 text-[var(--t1)] ring-1 ring-[var(--t2)]/30' : 'text-[var(--t3)] hover:text-[var(--t2)] hover:bg-white/[0.04]'}`}
                    title={c.label}
                  >
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: c.dot }} />
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="info-text-meta text-[var(--t3)]/70 uppercase tracking-wider text-[12px]">Person</div>
                {personId && !personSearchOpen ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openPersonInInfoPane(personId)}
                      className="info-btn-chip info-text-meta text-[var(--t1)] cursor-pointer"
                      title="In People öffnen"
                    >
                      {personName || `#${personId}`}
                    </button>
                    <button
                      onClick={() => {
                        setPersonSearchOpen(true)
                        setPersonQuery('')
                        setPersonResults([])
                        setField({ personId: null, personName: '' })
                      }}
                      className="info-text-meta text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer"
                    >
                      entfernen
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      value={personQuery}
                      onChange={e => { setPersonQuery(e.target.value); setPersonSearchOpen(true) }}
                      onFocus={() => setPersonSearchOpen(true)}
                      placeholder="Person suchen …"
                      className="w-full bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] placeholder:text-[var(--t3)]/50 outline-none focus:border-[var(--t3)]"
                    />
                    {personSearchOpen && personResults.length > 0 && (
                      <div className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-1)] shadow-xl">
                        {personResults.map(r => (
                          <button
                            key={r.person_id}
                            onClick={() => {
                              setPersonSearchOpen(false)
                              setPersonQuery('')
                              setPersonResults([])
                              setField({
                                personId: r.person_id ?? null,
                                personName: r.name,
                                title: category === 'ptdesk' ? r.name : title,
                              })
                            }}
                            className="w-full px-2 py-1.5 text-left info-text-meta text-[var(--t2)] hover:bg-white/[0.04] cursor-pointer"
                          >
                            {r.name}
                            {r.company && <span className="text-[var(--t3)]"> · {r.company}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {!isPtCategory && (
                <label className="info-text-meta text-[var(--t3)] flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={e => setField({ allDay: e.target.checked, endDate: e.target.checked ? (endDate || date) : '' })}
                    className="accent-[var(--t2)]"
                  />
                  <span>ganztägig</span>
                </label>
              )}
              {allDay ? (
                <div className="flex gap-2 items-center">
                  <input type="date" value={date} onChange={e => setField({ date: e.target.value })}
                    className="flex-1 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)]" />
                  <span className="info-text-meta text-[var(--t3)]/60">bis</span>
                  <input type="date" value={endDate || date} onChange={e => setField({ endDate: e.target.value })}
                    className="flex-1 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)]" />
                </div>
              ) : (
                <div className="flex gap-2">
                  <input type="date" value={date} onChange={e => setField({ date: e.target.value })}
                    className="flex-1 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)]" />
                  <input type="time" value={time} onChange={e => setField({ time: e.target.value })}
                    className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)]" />
                  <input type="number" min={5} step={5} value={dur} onChange={e => setField({ durationMin: parseInt(e.target.value) || 60 })}
                    className="w-16 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)]" title="Minuten" />
                </div>
              )}
              <textarea
                value={notes}
                onChange={e => setField({ notes: e.target.value })}
                placeholder="Notizen"
                rows={3}
                className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] placeholder:text-[var(--t3)]/50 outline-none focus:border-[var(--t3)] resize-none"
              />
              {isPtCategory && (
                <div className="bg-[var(--bg-2)]/50 border border-[var(--border)]/40 rounded px-2 py-2 flex flex-col gap-2">
                  <div className="info-text-meta text-[var(--t3)] uppercase tracking-wider text-[12px]">PT-Daten</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      value={remainingDraft}
                      onChange={e => setRemainingDraft(e.target.value)}
                      placeholder="Rest-Termine"
                      className="w-28 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)] tabular-nums"
                    />
                    <input
                      type="number"
                      min={0}
                      value={cardPriceDraft}
                      onChange={e => setCardPriceDraft(e.target.value)}
                      placeholder="Preis €"
                      className="w-24 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)] tabular-nums"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={cardMethodDraft}
                      onChange={e => setCardMethodDraft(e.target.value)}
                      className="flex-1 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)] cursor-pointer"
                    >
                      <option value="">Zahlungsart</option>
                      <option value="cash">Bar</option>
                      <option value="ec">EC</option>
                      <option value="transfer">Überweisung</option>
                      <option value="invoice">Rechnung</option>
                    </select>
                    <select
                      value={cardStatusDraft}
                      onChange={e => setCardStatusDraft(e.target.value)}
                      className="flex-1 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)] cursor-pointer"
                    >
                      <option value="pending">Offen</option>
                      <option value="paid">Bezahlt</option>
                      <option value="partial">Teilweise</option>
                      <option value="cancelled">Storniert</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    {onSetPtRemaining && (
                      <button
                        onClick={async () => {
                          if (!onSetPtRemaining) return
                          const next = parseInt(remainingDraft, 10)
                          if (!Number.isFinite(next)) return
                          setRemainingBusy(true)
                          try {
                            await onSetPtRemaining(next)
                          } finally {
                            setRemainingBusy(false)
                          }
                        }}
                        disabled={!onSetPtRemaining || !hasEditablePtCard || remainingBusy || remainingDraft === '' || `${editing?.remainingSessions ?? ''}` === remainingDraft}
                        className="info-btn-chip info-text-meta text-[var(--t1)] disabled:opacity-40"
                      >
                        {remainingBusy ? 'Setzt …' : 'Rest speichern'}
                      </button>
                    )}
                    <button
                      onClick={savePtCardMeta}
                      disabled={remainingBusy || !personId}
                      className="info-btn-chip info-text-meta text-[var(--t1)] disabled:opacity-40"
                    >
                      {hasEditablePtCard ? 'Karte speichern' : 'Karte anlegen'}
                    </button>
                  </div>
                  <div className="flex flex-col gap-1 pt-1">
                    <input
                      type="text"
                      readOnly
                      value={ptCustomer?.email || ''}
                      placeholder="E-Mail"
                      className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none"
                    />
                    <input
                      type="text"
                      readOnly
                      value={ptCustomer?.phone || ''}
                      placeholder="Telefon"
                      className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none"
                    />
                    <input
                      type="text"
                      readOnly
                      value={ptCustomer?.whatsapp_chat_id || ''}
                      placeholder="WhatsApp"
                      className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none"
                    />
                  </div>
                </div>
              )}
              {isEdit && !isPtCategory && (briefingLoading || briefing) && (
                <div className="bg-[var(--bg-2)]/50 border border-[var(--border)]/40 rounded px-2 py-1.5 flex flex-col gap-1.5 max-h-40 overflow-y-auto">
                  <div className="info-text-meta text-[var(--t3)]/70 uppercase tracking-wider text-[12px]">Kontext</div>
                  {briefingLoading && !briefing && (
                    <div className="info-text-meta text-[var(--t3)]/50 italic">lade …</div>
                  )}
                  {briefing?.people?.map((p, i) => (
                    <div key={i} className="flex flex-col gap-0.5">
                      <div className="info-text-meta text-[var(--t1)]">
                        <button
                          onClick={() => openPersonInInfoPane(p.id)}
                          className="text-left cursor-pointer hover:text-white transition-colors"
                          title="In People öffnen"
                        >
                          {p.name}{p.company ? <span className="text-[var(--t3)]"> · {p.company}</span> : null}
                        </button>
                        {p.offer_eur > 0 ? <span className="text-[var(--t3)]"> · offen {p.offer_eur.toLocaleString('de-DE')} €</span> : null}
                      </div>
                      {p.touchpoints?.map((t, j) => (
                        <div key={j} className="info-text-meta text-[var(--t3)] pl-2 leading-snug">
                          <span className="text-[var(--t3)]/60 uppercase tracking-wider text-[12px] mr-1">{({whatsapp:'WA',email:'Mail',focus:'Fokus',chat:'Chat'} as Record<string,string>)[t.kind] || t.kind} · {t.when}</span>
                          {t.snippet && <span>„{t.snippet}"</span>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {!isPtCategory && (
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={label}
                    onChange={e => setField({ label: e.target.value.toUpperCase().slice(0, 6) })}
                    placeholder="Label"
                    className="w-20 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] placeholder:text-[var(--t3)]/50 outline-none focus:border-[var(--t3)] uppercase tracking-wider"
                  />
                  <div className="flex gap-1 flex-1">
                    {LABEL_SUGGESTIONS.map(s => (
                      <button key={s} onClick={() => setField({ label: s })}
                        className={`info-text-meta px-1.5 py-0.5 rounded uppercase tracking-wider cursor-pointer transition-colors ${label === s ? 'bg-[var(--t2)]/15 text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t2)] hover:bg-white/[0.04]'}`}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!isPtCategory && (
                <div className="flex gap-2 items-center">
                  <select
                    value={rrule}
                    onChange={e => setField({ rrule: e.target.value as '' | 'daily' | 'weekly' | 'monthly' })}
                    className="flex-1 bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)] cursor-pointer"
                  >
                    <option value="">Einmalig</option>
                    <option value="daily">Täglich</option>
                    <option value="weekly">Wöchentlich</option>
                    <option value="monthly">Monatlich</option>
                  </select>
                  {rrule && (
                    <input
                      type="date"
                      value={rruleUntil}
                      onChange={e => setField({ rruleUntil: e.target.value })}
                      placeholder="bis"
                      title="Bis (optional)"
                      className="bg-[var(--bg-2)] border border-[var(--border)]/60 rounded px-2 py-1.5 info-text-meta text-[var(--t2)] outline-none focus:border-[var(--t3)]"
                    />
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {isPt ? (
                  <>
                    {onCancelPt && (
                      <button onClick={() => onCancelPt('customer')} className="info-btn-chip info-text-meta text-[var(--t2)]">Kunde abgesagt</button>
                    )}
                    {onCancelPt && (
                      <button onClick={() => onCancelPt('trainer')} className="info-btn-chip info-text-meta text-[var(--t2)]">Trainer abgesagt</button>
                    )}
                    {onCompletePt && (
                      <button onClick={onCompletePt} className="info-btn-chip info-text-meta text-[var(--t1)]">Gelaufen</button>
                    )}
                    <div className="flex-1" />
                    <button onClick={onClose} className="info-btn-chip info-text-meta">Schließen</button>
                    <button onClick={() => onSave()} disabled={saveDisabled} className="info-btn-chip info-text-meta text-[var(--t1)] disabled:opacity-40">Speichern</button>
                  </>
                ) : (
                  <>
                    {isCancelledManual && onReactivate && (
                      <button onClick={onReactivate} className="info-btn-chip info-text-meta text-[var(--t1)]">Reaktivieren</button>
                    )}
                    {!isCancelledManual && onManualCancel && (
                      <button onClick={onManualCancel} className="info-btn-chip info-text-meta text-[var(--t2)]">Abgesagt</button>
                    )}
                    {onDelete && (
                      <button onClick={onDelete} className="info-btn-chip info-text-meta text-[var(--red)]/80 hover:text-[var(--red)]">
                        <Trash2 className="info-icon-sm" /> Löschen
                      </button>
                    )}
                    <div className="flex-1" />
                    <button onClick={onClose} className="info-btn-chip info-text-meta">Abbrechen</button>
                    <button onClick={() => onSave()} disabled={saveDisabled} className="info-btn-chip info-text-meta text-[var(--t1)] disabled:opacity-40">Speichern</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
