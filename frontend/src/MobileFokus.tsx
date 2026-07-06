import { useEffect, useMemo, useState, useCallback, useRef, type CSSProperties, type ReactNode, type TouchEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { dayMarker } from './lib/holidays'

// Mobile-Tagesansicht für /fokus.
// Zeigt einen einzelnen Tag als Stunden-Spalte mit Event-Blöcken,
// im selben Look wie die Desktop-Wochenansicht (siehe FokusApp.tsx).
// Tab oben schaltet zwischen Heute und Morgen, darunter Inbox-Card.

const HOUR_START = 7
const HOUR_END = 22
const HOUR_PX = 56
const TIME_GUTTER = 56

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

const CAL_CATEGORIES = [
  { id: 'privat', label: 'Privat', dot: '#9a978f' },
  { id: 'fch', label: 'FCH', dot: '#5fc845' },
  { id: 'ai-workshop', label: 'AI Workshop', dot: '#a37acf' },
  { id: 'ai-agent', label: 'AI Agent', dot: '#d97a5a' },
  { id: 'ai-beratung', label: 'AI Beratung', dot: '#e0945a' },
  { id: 'gecko', label: 'Beispielkunde', dot: '#4abca0' },
  { id: 'ptdesk', label: 'PT', dot: '#5a8ec8' },
  { id: 'admin', label: 'Admin', dot: '#8a8e96' },
] as const

type CalCategory = typeof CAL_CATEGORIES[number]['id']

// Feiertage und Urlaube kommen aus lib/holidays — gleiche Quelle wie FokusApp.

type CalEvent = {
  id: string
  startIso: string
  durationMin: number
  title: string
  category?: string
  location?: string
  source?: string
  status?: string
  notes?: string
  label?: string
  personName?: string
  personId?: number
  ptId?: number
  customer?: { id?: number | string; name?: string; phone?: string }
  rrule?: '' | 'daily' | 'weekly' | 'monthly'
  rruleUntil?: string
  remainingSessions?: number | null
  activeCardTotalSessions?: number | null
  activeCardUsedSessions?: number | null
  type?: string
}

type FokusSlot = {
  id: number
  day_iso: string
  item_key: string
  item_title: string
  start_min: number
  dur_min: number
}

type PtCustomerMobile = {
  id: number
  name: string
  email?: string
  phone?: string
  whatsapp_chat_id?: string
  remaining_sessions?: number | null
  active_card_total_sessions?: number | null
  active_card_used_sessions?: number | null
  price_eur?: number | null
  payment_method?: string
  payment_status?: string
  notes?: string
}

function isoOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return isoOf(d)
}

function navLabel(iso: string, todayIso: string): string {
  const diff = Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(todayIso + 'T00:00:00').getTime()) / 86400000)
  if (diff === 0) return 'Heute'
  if (diff === 1) return 'Morgen'
  if (diff === -1) return 'Gestern'
  return new Date(iso + 'T00:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })
}

function fmtClock(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

function parseStartMin(startIso: string): number {
  try {
    const d = new Date(startIso)
    return d.getHours() * 60 + d.getMinutes()
  } catch {
    return 0
  }
}

function eventBadgeMobile(ev: CalEvent): string {
  if (ev.source === 'ptdesk') return 'PT'
  const cat = (ev.category || '').toLowerCase()
  const labelMap: Record<string, string> = {
    agent: 'LO', privat: 'PR', fch: 'FCH',
    'ai-workshop': 'AIW', 'ai-agent': 'AIA', 'ai-beratung': 'AIB',
    gecko: 'GKO', admin: 'ADM',
  }
  return labelMap[cat] || (ev.label || '').toUpperCase()
}

function EventBlock({ ev, onTap }: { ev: CalEvent; onTap?: () => void }) {
  const startMin = parseStartMin(ev.startIso)
  const dur = Math.max(15, ev.durationMin || 60)
  const top = Math.max(0, ((startMin - HOUR_START * 60) / 60) * HOUR_PX)
  const height = Math.max(28, (dur / 60) * HOUR_PX - 2)
  const cat = (ev.category || '').toLowerCase()
  const color = CAL_CATEGORY_COLORS[cat] || (ev.source === 'ptdesk' ? 'rgba(120,130,150,0.6)' : '#7a8090')
  const bg = ev.source === 'ptdesk' ? 'rgba(120,130,150,0.06)' : `${color}1f`
  const cancelled = (ev.status || '').toLowerCase() === 'cancelled'
  const badge = eventBadgeMobile(ev)
  const tight = height < 40
  return (
    <div
      onClick={onTap}
      style={{
        position: 'absolute',
        top,
        left: 4,
        right: 4,
        height,
        background: bg,
        color: 'var(--t1)',
        borderRadius: 4,
        padding: tight ? '2px 8px' : '4px 8px',
        overflow: 'hidden',
        opacity: cancelled ? 0.55 : 1,
        textDecoration: cancelled ? 'line-through' : 'none',
        display: 'flex',
        flexDirection: tight ? 'row' : 'column',
        alignItems: tight ? 'center' : 'stretch',
        gap: tight ? 6 : 2,
        zIndex: 2,
        cursor: onTap ? 'pointer' : 'default',
      }}
    >
      {tight ? (
        <>
          {badge && (
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--t3)', flexShrink: 0 }}>
              {badge}
            </span>
          )}
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, lineHeight: 1.25, letterSpacing: '-0.005em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ev.title}
          </span>
        </>
      ) : (
        <>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 4, fontVariantNumeric: 'tabular-nums' }}>
            <span>{fmtClock(startMin)}–{fmtClock(startMin + dur)}</span>
            {badge && <span style={{ opacity: 0.7 }}>· {badge}</span>}
          </div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, lineHeight: 1.25, letterSpacing: '-0.005em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ev.title}
          </div>
        </>
      )}
    </div>
  )
}

function SlotBlock({ slot }: { slot: FokusSlot }) {
  const top = Math.max(0, ((slot.start_min - HOUR_START * 60) / 60) * HOUR_PX)
  const height = Math.max(28, (slot.dur_min / 60) * HOUR_PX - 2)
  const tight = height < 40
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 4,
        right: 4,
        height,
        background: 'rgba(214,201,168,0.06)',
        color: 'var(--t1)',
        borderRadius: 4,
        padding: tight ? '2px 8px' : '4px 8px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: tight ? 'row' : 'column',
        alignItems: tight ? 'center' : 'stretch',
        gap: tight ? 6 : 2,
        zIndex: 1,
      }}
    >
      {!tight && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtClock(slot.start_min)}–{fmtClock(slot.start_min + slot.dur_min)}
        </div>
      )}
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: tight ? 12 : 13, fontWeight: 500, lineHeight: 1.25, letterSpacing: '-0.005em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {slot.item_title}
      </div>
    </div>
  )
}

function NowLine({ visible }: { visible: boolean }) {
  const [nowMin, setNowMin] = useState(() => {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  })
  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => {
      const d = new Date()
      setNowMin(d.getHours() * 60 + d.getMinutes())
    }, 60_000)
    return () => clearInterval(t)
  }, [visible])
  if (!visible) return null
  if (nowMin < HOUR_START * 60 || nowMin > HOUR_END * 60) return null
  const top = ((nowMin - HOUR_START * 60) / 60) * HOUR_PX
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top, pointerEvents: 'none', zIndex: 5 }}>
      <div style={{ position: 'absolute', left: TIME_GUTTER - 6, top: -4, width: 8, height: 8, borderRadius: '50%', background: 'var(--cc-orange)' }} />
      <div style={{ marginLeft: TIME_GUTTER, height: 2, background: 'var(--cc-orange)' }} />
    </div>
  )
}

function DayColumn({ dayIso, events, slots, isToday, onEventTap }: {
  dayIso: string
  events: CalEvent[]
  slots: FokusSlot[]
  isToday: boolean
  onEventTap?: (ev: CalEvent) => void
}) {
  const hours = Array.from({ length: HOUR_END - HOUR_START + 1 }).map((_, i) => HOUR_START + i)
  const totalHeight = (HOUR_END - HOUR_START) * HOUR_PX
  const dayEvents = useMemo(() => events.filter(e => (e.startIso || '').slice(0, 10) === dayIso), [events, dayIso])
  const daySlots = useMemo(() => slots.filter(s => s.day_iso === dayIso), [slots, dayIso])

  return (
    <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: `${TIME_GUTTER}px 1fr` }}>
      {/* Stundenrand links */}
      <div style={{ position: 'relative', height: totalHeight }}>
        {hours.map(h => (
          <div
            key={h}
            style={{
              position: 'absolute',
              right: 8,
              top: (h - HOUR_START) * HOUR_PX - 7,
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              color: 'var(--t1)',
              opacity: 0.5,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {String(h).padStart(2, '0')}:00
          </div>
        ))}
      </div>
      {/* Tag-Spalte rechts */}
      <div
        style={{
          position: 'relative',
          height: totalHeight,
          borderLeft: '1px solid color-mix(in srgb, var(--t3) 22%, transparent)',
          background: (() => {
            const m = dayMarker(dayIso)
            if (m.holiday) {
              return 'repeating-linear-gradient(135deg, transparent 0, transparent 9px, rgba(255,255,255,0.045) 9px, rgba(255,255,255,0.045) 10px), rgba(0,0,0,0.22)'
            }
            if (m.isWeekend) return 'rgba(0,0,0,0.22)'
            return 'transparent'
          })(),
        }}
      >
        {hours.slice(1, -1).map(h => (
          <div
            key={h}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: (h - HOUR_START) * HOUR_PX,
              height: 1,
              background: 'color-mix(in srgb, var(--t3) 14%, transparent)',
              pointerEvents: 'none',
            }}
          />
        ))}
        {dayEvents.map(ev => <EventBlock key={ev.id} ev={ev} onTap={onEventTap ? () => onEventTap(ev) : undefined} />)}
        {daySlots.map(s => <SlotBlock key={`slot-${s.id}`} slot={s} />)}
      </div>
      <NowLine visible={isToday} />
    </div>
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function splitLocalIso(iso: string): { date: string; time: string } {
  const v = toLocalInput(iso)
  return { date: v.slice(0, 10), time: v.slice(11, 16) }
}

function eventPersonId(ev: CalEvent): number | null {
  if (typeof ev.personId === 'number' && ev.personId > 0) return ev.personId
  const raw = ev.customer?.id
  const n = typeof raw === 'number' ? raw : parseInt(String(raw || ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function inferPtTrainingType(title: string, label: string): 'personal_training' | 'ems' {
  const head = `${title} ${label}`.trim().toLowerCase()
  return head.startsWith('ems') || /\bems\b/.test(head) ? 'ems' : 'personal_training'
}

function fieldStyle(extra?: CSSProperties): CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-2)',
    border: '1px solid var(--border-f)',
    borderRadius: 8,
    color: 'var(--t1)',
    fontFamily: 'var(--font-body)',
    fontSize: 13,
    minHeight: 44,
    padding: '9px 10px',
    outline: 'none',
    boxSizing: 'border-box',
    ...extra,
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 9.5, fontWeight: 650, color: 'var(--t3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  )
}

function EventDetailView({ ev, onClose, onChanged }: { ev: CalEvent; onClose: () => void; onChanged: () => void }) {
  const [mode, setMode] = useState<'view' | 'move'>('view')
  const [moveVal, setMoveVal] = useState(() => toLocalInput(ev.startIso))
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  const dur = Math.max(15, ev.durationMin || 60)

  const doMove = async (force = false) => {
    if (busy) return
    setBusy(true); setErr(''); setConflict(false)
    try {
      const startIso = moveVal.length === 16 ? `${moveVal}:00` : moveVal
      const r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startIso, durationMin: dur, ...(force ? { force: true } : {}) }),
      })
      if (r.status === 409) { setConflict(true); setBusy(false); return }
      if (!r.ok) { setErr('Verschieben ging nicht.'); setBusy(false); return }
      onChanged()
    } catch { setErr('Verschieben ging nicht.'); setBusy(false) }
  }

  const doCancel = async () => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}/cancel`, { method: 'POST' })
      if (!r.ok) { setErr('Absagen ging nicht.'); setBusy(false); return }
      onChanged()
    } catch { setErr('Absagen ging nicht.'); setBusy(false) }
  }

  const startMin = parseStartMin(ev.startIso)
  const cat = (ev.category || '').toLowerCase()
  const color = CAL_CATEGORY_COLORS[cat] || '#7a8090'
  const dateLabel = (() => {
    try {
      const d = new Date(ev.startIso)
      return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
    } catch { return '' }
  })()

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '18px 18px 28px',
        color: 'var(--t1)',
      }}
    >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.6 }}>
            {cat || 'termin'}
          </span>
        </div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 500, lineHeight: 1.2 }}>
          {ev.title}
        </div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, opacity: 0.7, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
          {dateLabel} · {fmtClock(startMin)}–{fmtClock(startMin + dur)}
        </div>
        {ev.location && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, opacity: 0.6, marginTop: 4 }}>
            {ev.location}
          </div>
        )}
        {ev.personName && (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, opacity: 0.6, marginTop: 4 }}>
            {ev.personName}
          </div>
        )}
        {ev.notes && (
          <div
            style={{
              marginTop: 16,
              padding: '12px 14px',
              background: 'var(--bg-2)',
              borderRadius: 10,
              fontFamily: 'var(--font-body)',
              fontSize: 14,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              color: 'var(--t1)',
            }}
          >
            {ev.notes}
          </div>
        )}

        {err && (
          <div style={{ marginTop: 14, fontFamily: 'var(--font-body)', fontSize: 13, color: '#c2554a' }}>{err}</div>
        )}

        {mode === 'view' ? (
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button
              onClick={() => { setMode('move'); setCancelArmed(false) }}
              style={{
                flex: 1, padding: '13px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                background: 'color-mix(in srgb, var(--warm) 16%, transparent)', color: 'var(--t1)',
                fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 600,
              }}
            >
              Verschieben
            </button>
            <button
              onClick={() => { if (cancelArmed) doCancel(); else setCancelArmed(true) }}
              disabled={busy}
              style={{
                flex: 1, padding: '13px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                background: cancelArmed ? '#c2554a' : 'color-mix(in srgb, #c2554a 16%, transparent)',
                color: cancelArmed ? '#fff' : '#c2554a',
                fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 600,
              }}
            >
              {cancelArmed ? 'Wirklich absagen?' : 'Absagen'}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 20 }}>
            <input
              type="datetime-local"
              value={moveVal}
              onChange={e => { setMoveVal(e.target.value); setConflict(false) }}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 12,
                background: 'var(--bg-2)', border: '1px solid var(--border-f)',
                color: 'var(--t1)', fontFamily: 'var(--font-body)', fontSize: 16,
              }}
            />
            {conflict && (
              <div style={{ marginTop: 10, fontFamily: 'var(--font-body)', fontSize: 13, color: '#c2554a' }}>
                Kollidiert mit einem anderen Termin.
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                onClick={() => { setMode('view'); setConflict(false); setErr('') }}
                style={{
                  flex: 1, padding: '13px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: 'var(--bg-2)', color: 'var(--t2)',
                  fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 600,
                }}
              >
                Zurück
              </button>
              <button
                onClick={() => doMove(conflict)}
                disabled={busy}
                style={{
                  flex: 1, padding: '13px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: conflict ? '#c2554a' : 'var(--warm)', color: '#fff',
                  fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 600, opacity: busy ? 0.5 : 1,
                }}
              >
                {conflict ? 'Trotzdem verschieben' : 'Speichern'}
              </button>
            </div>
          </div>
        )}
    </div>
  )
}

void EventDetailView

function MobileEventEditor({ ev, onClose, onChanged }: { ev: CalEvent; onClose: () => void; onChanged: () => void }) {
  const initial = splitLocalIso(ev.startIso)
  const initialPersonId = eventPersonId(ev)
  const [title, setTitle] = useState(ev.title || '')
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [durationMin, setDurationMin] = useState(Math.max(15, ev.durationMin || 60))
  const [category, setCategory] = useState<CalCategory>(((ev.category || (ev.source === 'ptdesk' ? 'ptdesk' : 'privat')).toLowerCase() === 'pt' ? 'ptdesk' : (ev.category || (ev.source === 'ptdesk' ? 'ptdesk' : 'privat')).toLowerCase()) as CalCategory)
  const [label, setLabel] = useState(ev.label || '')
  const [rrule, setRrule] = useState<'' | 'daily' | 'weekly' | 'monthly'>(ev.rrule || '')
  const [rruleUntil, setRruleUntil] = useState(ev.rruleUntil || '')
  const [notes, setNotes] = useState(ev.notes || '')
  const [location, setLocation] = useState(ev.location || '')
  const [personId, setPersonId] = useState<number | null>(initialPersonId)
  const [personName, setPersonName] = useState(ev.personName || ev.customer?.name || '')
  const [personQuery, setPersonQuery] = useState('')
  const [personResults, setPersonResults] = useState<Array<{ person_id?: number; name: string; company?: string; source?: string }>>([])
  const [personSearchOpen, setPersonSearchOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [conflicts, setConflicts] = useState<Array<{ title?: string; startIso?: string; durationMin?: number }>>([])
  const [err, setErr] = useState('')
  const [ptCustomer, setPtCustomer] = useState<PtCustomerMobile | null>(null)
  const [remainingDraft, setRemainingDraft] = useState('')
  const [cardTotalDraft, setCardTotalDraft] = useState('')
  const [cardPriceDraft, setCardPriceDraft] = useState('')
  const [cardMethodDraft, setCardMethodDraft] = useState('')
  const [cardStatusDraft, setCardStatusDraft] = useState('pending')

  const isPt = ev.source === 'ptdesk'
  const ptId = ev.ptId || (ev.id.startsWith('pt-') ? parseInt(ev.id.slice(3), 10) : 0)
  const categoryMeta = CAL_CATEGORIES.find(c => c.id === category) || CAL_CATEGORIES[0]
  const statusLabel = ev.status && ev.status !== 'scheduled' ? ev.status : ''

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  useEffect(() => {
    if (!personSearchOpen) return
    const q = personQuery.trim()
    if (q.length < 2) { setPersonResults([]); return }
    let alive = true
    const t = window.setTimeout(() => {
      fetch(`/api/people/search?q=${encodeURIComponent(q)}&limit=8`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(d => {
          if (!alive) return
          const arr = Array.isArray(d.results) ? d.results : []
          setPersonResults(arr.filter((x: any) => !x.source || x.source === 'person'))
        })
        .catch(() => { if (alive) setPersonResults([]) })
    }, 180)
    return () => { alive = false; window.clearTimeout(t) }
  }, [personQuery, personSearchOpen])

  useEffect(() => {
    if (category !== 'ptdesk' || !personId) {
      setPtCustomer(null)
      return
    }
    let alive = true
    fetch(`/api/pt/customer?customer_id=${encodeURIComponent(String(personId))}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && d?.customer) setPtCustomer(d.customer as PtCustomerMobile) })
      .catch(() => { if (alive) setPtCustomer(null) })
    return () => { alive = false }
  }, [category, personId])

  useEffect(() => {
    setRemainingDraft(typeof ptCustomer?.remaining_sessions === 'number' ? String(ptCustomer.remaining_sessions) : '')
    setCardTotalDraft(typeof ptCustomer?.active_card_total_sessions === 'number' ? String(ptCustomer.active_card_total_sessions) : '')
    setCardPriceDraft(typeof ptCustomer?.price_eur === 'number' ? String(ptCustomer.price_eur) : '')
    setCardMethodDraft(ptCustomer?.payment_method || '')
    setCardStatusDraft(ptCustomer?.payment_status || 'pending')
  }, [ptCustomer?.id, ptCustomer?.remaining_sessions, ptCustomer?.active_card_total_sessions, ptCustomer?.price_eur, ptCustomer?.payment_method, ptCustomer?.payment_status])

  const savePtCard = async () => {
    if (category !== 'ptdesk' || !personId) return true
    const cardRes = await fetch(`/api/pt/customer/${personId}/card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalSessions: cardTotalDraft === '' ? null : parseInt(cardTotalDraft, 10),
        priceEur: cardPriceDraft === '' ? null : parseInt(cardPriceDraft, 10),
        paymentMethod: cardMethodDraft,
        paymentStatus: cardStatusDraft,
      }),
    })
    if (!cardRes.ok) return false
    if (remainingDraft !== '') {
      const remainingRes = await fetch(`/api/pt/customer/${personId}/remaining`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remaining: parseInt(remainingDraft, 10) || 0 }),
      })
      if (!remainingRes.ok) return false
    }
    return true
  }

  const save = async (force = false) => {
    if (busy) return
    if (category === 'ptdesk' && !personId) {
      setErr('Für PT brauche ich eine Person.')
      return
    }
    setBusy(true); setErr(''); if (!force) setConflicts([])
    const startIso = `${date}T${time || '09:00'}:00`
    const dur = Math.max(5, durationMin || 60)
    try {
      let r: Response
      if (isPt) {
        if (category !== 'ptdesk') {
          r = await fetch(`/api/pt/appointment/${encodeURIComponent(String(ptId))}/convert-to-calendar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title.trim(), startIso, durationMin: dur, notes, location, category, label, rrule, rruleUntil, personId }),
          })
        } else {
          r = await fetch(`/api/pt/appointment/${encodeURIComponent(String(ptId))}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, startTime: time, durationMin: dur, notes, personId, trainingType: inferPtTrainingType(title.trim(), label) }),
          })
        }
      } else if (category === 'ptdesk') {
        r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}/convert-to-pt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), startIso, durationMin: dur, notes, label, personId, trainingType: inferPtTrainingType(title.trim(), label) }),
        })
      } else {
        r = await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), startIso, durationMin: dur, notes, location, category, label, rrule, rruleUntil, personId, ...(force ? { force: true } : {}) }),
        })
      }
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}))
        setConflicts(Array.isArray(d.conflicts) ? d.conflicts : [])
        setBusy(false)
        return
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setErr(String(d.error || 'Speichern ging nicht.'))
        setBusy(false)
        return
      }
      if (category === 'ptdesk') {
        const cardOk = await savePtCard()
        if (!cardOk) {
          setErr('PT-Kartendaten gingen nicht zu speichern.')
          setBusy(false)
          return
        }
      }
      onChanged()
    } catch { setErr('Speichern ging nicht.'); setBusy(false) }
  }

  const doCancel = async () => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const r = isPt
        ? await fetch(`/api/pt/appointment/${encodeURIComponent(String(ptId))}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by: 'customer', reason: '' }),
        })
        : await fetch(`/api/calendar/${encodeURIComponent(ev.id)}/cancel`, { method: 'POST' })
      if (!r.ok) { setErr('Absagen ging nicht.'); setBusy(false); return }
      onChanged()
    } catch { setErr('Absagen ging nicht.'); setBusy(false) }
  }

  const doDelete = async () => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const r = isPt
        ? await fetch(`/api/pt/appointment/${encodeURIComponent(String(ptId))}?scope=single`, { method: 'DELETE' })
        : await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, { method: 'DELETE' })
      if (!r.ok) { setErr('Löschen ging nicht.'); setBusy(false); return }
      onChanged()
    } catch { setErr('Löschen ging nicht.'); setBusy(false) }
  }

  const sectionStyle: CSSProperties = {
    padding: '12px 0',
    borderTop: '1px solid color-mix(in srgb, var(--t3) 11%, transparent)',
  }
  const grid2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }
  const grid3: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }
  const actionStyle = (tone: 'danger' | 'primary', armed = false): CSSProperties => ({
    height: 46,
    borderRadius: 10,
    border: 'none',
    cursor: busy ? 'default' : 'pointer',
    background: tone === 'primary'
      ? 'var(--warm)'
      : armed ? '#c2554a' : 'color-mix(in srgb, #c2554a 12%, transparent)',
    color: tone === 'primary' || armed ? '#fff' : '#c2554a',
    fontFamily: 'var(--font-body)',
    fontSize: 13,
    fontWeight: 700,
    opacity: busy ? 0.55 : 1,
  })

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 18px', color: 'var(--t1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, minHeight: 18, overflow: 'hidden' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: categoryMeta.dot }} />
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', whiteSpace: 'nowrap' }}>{categoryMeta.label}</span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>· {isPt ? 'PT-Termin' : 'Kalender'}</span>
        {statusLabel && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>· {statusLabel}</span>}
        {typeof ev.remainingSessions === 'number' && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap' }}>· {ev.remainingSessions} Rest</span>}
      </div>

      <Field label="Name">
        <input value={title} onChange={e => setTitle(e.target.value)} style={fieldStyle({ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 500, minHeight: 48 })} />
      </Field>

      <div style={{ ...sectionStyle, marginTop: 12 }}>
        <Field label="Kategorie">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {CAL_CATEGORIES.map(c => {
              const active = category === c.id
              return (
                <button key={c.id} type="button" onClick={() => { setCategory(c.id); if (c.id === 'ptdesk') setRrule('') }} style={{
                  height: 38, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, borderRadius: 8,
                  border: active ? '1px solid var(--border-f)' : '1px solid transparent',
                  background: active ? 'color-mix(in srgb, var(--bg-2) 82%, var(--t3) 18%)' : 'color-mix(in srgb, var(--bg-2) 55%, transparent)',
                  color: active ? 'var(--t1)' : 'var(--t2)', padding: '0 10px',
                  fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: active ? 650 : 500, cursor: 'pointer', textAlign: 'left',
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot, flexShrink: 0 }} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                </button>
              )
            })}
          </div>
        </Field>
      </div>

      <div style={{ ...sectionStyle, ...grid3 }}>
        <Field label="Datum"><input type="date" value={date} onChange={e => setDate(e.target.value)} style={fieldStyle()} /></Field>
        <Field label="Zeit"><input type="time" value={time} onChange={e => setTime(e.target.value)} style={fieldStyle()} /></Field>
        <Field label="Dauer"><input type="number" min={5} step={5} value={durationMin} onChange={e => setDurationMin(parseInt(e.target.value, 10) || 60)} style={fieldStyle({ fontVariantNumeric: 'tabular-nums' })} /></Field>
      </div>

      <div style={sectionStyle}>
        <Field label="Person">
          {personId && !personSearchOpen ? (
            <div style={{ ...fieldStyle({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 10px' }) }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{personName || `#${personId}`}</span>
              <button type="button" onClick={() => { setPersonId(null); setPersonName(''); setPersonSearchOpen(true) }} style={{ background: 'transparent', border: 'none', color: 'var(--t3)', fontSize: 12 }}>entfernen</button>
            </div>
          ) : (
            <div style={{ position: 'relative' }}>
              <input value={personQuery} onChange={e => { setPersonQuery(e.target.value); setPersonSearchOpen(true) }} onFocus={() => setPersonSearchOpen(true)} placeholder="Person suchen…" style={fieldStyle()} />
              {personSearchOpen && personResults.length > 0 && (
                <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: 'calc(100% + 4px)', background: 'var(--bg-1)', border: '1px solid var(--border-f)', borderRadius: 10, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>
                  {personResults.map(r => (
                    <button key={r.person_id || r.name} type="button" onClick={() => {
                      setPersonId(r.person_id || null); setPersonName(r.name)
                      if (category === 'ptdesk') setTitle(r.name)
                      setPersonQuery(''); setPersonSearchOpen(false); setPersonResults([])
                    }} style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--t1)', padding: '10px 11px', fontFamily: 'var(--font-body)', fontSize: 13 }}>
                      {r.name}{r.company ? <span style={{ color: 'var(--t3)' }}> · {r.company}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
      </div>

      {category === 'ptdesk' && (
        <div style={{ ...sectionStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={grid3}>
            <Field label="Rest">
              <input type="number" min={0} value={remainingDraft} onChange={e => setRemainingDraft(e.target.value)} style={fieldStyle({ fontVariantNumeric: 'tabular-nums' })} />
            </Field>
            <Field label="Karte">
              <input type="number" min={0} value={cardTotalDraft} onChange={e => setCardTotalDraft(e.target.value)} style={fieldStyle({ fontVariantNumeric: 'tabular-nums' })} />
            </Field>
            <Field label="€/Einheit">
              <input type="number" min={0} value={cardPriceDraft} onChange={e => setCardPriceDraft(e.target.value)} style={fieldStyle({ fontVariantNumeric: 'tabular-nums' })} />
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Zahlungsart">
              <select value={cardMethodDraft} onChange={e => setCardMethodDraft(e.target.value)} style={fieldStyle()}>
                <option value="">—</option>
                <option value="cash">Bar</option>
                <option value="ec">EC</option>
                <option value="transfer">Überweisung</option>
                <option value="invoice">Rechnung</option>
              </select>
            </Field>
            <Field label="Zahlungsstatus">
              <select value={cardStatusDraft} onChange={e => setCardStatusDraft(e.target.value)} style={fieldStyle()}>
                <option value="pending">Offen</option>
                <option value="paid">Bezahlt</option>
                <option value="partial">Teilweise</option>
                <option value="cancelled">Storniert</option>
              </select>
            </Field>
          </div>
          {ptCustomer && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.5, color: 'var(--t3)' }}>
              {[ptCustomer.email, ptCustomer.phone, ptCustomer.whatsapp_chat_id].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}

      {category !== 'ptdesk' && (
        <div style={{ ...sectionStyle, ...grid2 }}>
          <Field label="Wiederholung">
            <select value={rrule} onChange={e => setRrule(e.target.value as '' | 'daily' | 'weekly' | 'monthly')} style={fieldStyle()}>
              <option value="">Einmalig</option>
              <option value="daily">Täglich</option>
              <option value="weekly">Wöchentlich</option>
              <option value="monthly">Monatlich</option>
            </select>
          </Field>
          <Field label="Label"><input value={label} onChange={e => setLabel(e.target.value.toUpperCase().slice(0, 6))} style={fieldStyle({ textTransform: 'uppercase' })} /></Field>
        </div>
      )}

      {category !== 'ptdesk' && rrule && (
        <div style={sectionStyle}>
          <Field label="Wiederholen bis"><input type="date" value={rruleUntil} onChange={e => setRruleUntil(e.target.value)} style={fieldStyle()} /></Field>
        </div>
      )}

      {category !== 'ptdesk' && (
        <div style={sectionStyle}>
          <Field label="Ort"><input value={location} onChange={e => setLocation(e.target.value)} style={fieldStyle()} /></Field>
        </div>
      )}

      <div style={sectionStyle}>
        <Field label="Notiz"><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} style={fieldStyle({ resize: 'vertical', lineHeight: 1.45, minHeight: 86 })} /></Field>
      </div>

      {conflicts.length > 0 && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: '1px solid #c2554a', background: 'color-mix(in srgb, #c2554a 12%, transparent)', fontFamily: 'var(--font-body)' }}>
          <div style={{ color: '#c2554a', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Kollidiert mit:</div>
          {conflicts.map((c, i) => {
            const s = c.startIso ? parseStartMin(c.startIso) : 0
            const d = Math.max(5, c.durationMin || 60)
            return <div key={i} style={{ fontSize: 13, color: 'var(--t1)' }}>{fmtClock(s)}–{fmtClock(s + d)} · {c.title || 'Termin'}</div>
          })}
          <button type="button" onClick={() => save(true)} disabled={busy} style={{ marginTop: 10, width: '100%', padding: '11px 0', borderRadius: 10, border: 'none', background: '#c2554a', color: '#fff', fontFamily: 'var(--font-body)', fontWeight: 700 }}>Trotzdem speichern</button>
        </div>
      )}

      {err && <div style={{ marginTop: 14, fontFamily: 'var(--font-body)', fontSize: 13, color: '#c2554a' }}>{err}</div>}

      <div style={{ ...sectionStyle, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, paddingBottom: 0 }}>
        <button onClick={() => { if (deleteArmed) doDelete(); else { setDeleteArmed(true); setCancelArmed(false) } }} disabled={busy} style={actionStyle('danger', deleteArmed)}>
          {deleteArmed ? 'Wirklich?' : 'Löschen'}
        </button>
        <button onClick={() => { if (cancelArmed) doCancel(); else { setCancelArmed(true); setDeleteArmed(false) } }} disabled={busy} style={actionStyle('danger', cancelArmed)}>
          {cancelArmed ? 'Wirklich?' : 'Absagen'}
        </button>
        <button type="button" onClick={() => save(false)} disabled={busy} style={actionStyle('primary')}>
          Speichern
        </button>
      </div>

      {(ev.activeCardTotalSessions || ev.activeCardUsedSessions) && (
        <div style={{ marginTop: 14, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--t3)' }}>
          Karte: {ev.activeCardUsedSessions ?? 0}/{ev.activeCardTotalSessions ?? '?'} genutzt
        </div>
      )}
    </div>
  )
}

export default function MobileFokus({ embedded = false }: { embedded?: boolean }) {
  const [events, setEvents] = useState<CalEvent[]>([])
  const [slots, setSlots] = useState<FokusSlot[]>([])
  const [dayOffset, setDayOffset] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [activeEvent, setActiveEvent] = useState<CalEvent | null>(null)

  const todayIso = useMemo(() => isoOf(new Date()), [])
  const activeIso = useMemo(() => addDaysIso(todayIso, dayOffset), [todayIso, dayOffset])
  const nextIso = useMemo(() => addDaysIso(activeIso, 1), [activeIso])
  const dayTitle = useMemo(() => navLabel(activeIso, todayIso), [activeIso, todayIso])
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)

  const goDay = useCallback((delta: number) => {
    setActiveEvent(null)
    setDayOffset(v => v + delta)
  }, [])
  const resetDay = useCallback(() => {
    setActiveEvent(null)
    setDayOffset(0)
  }, [])

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const [calRes, slotRes] = await Promise.all([
        fetch(`/api/calendar?from=${activeIso}&to=${nextIso}`),
        fetch(`/api/fokus/slots?start=${activeIso}&end=${activeIso}`),
      ])
      if (calRes.ok) {
        const d = await calRes.json()
        const arr = Array.isArray(d.events) ? d.events : []
        setEvents(arr.filter((e: any) => e.source !== 'fokus-overdue' && !e.allDay))
      }
      if (slotRes.ok) {
        const d = await slotRes.json()
        setSlots(Array.isArray(d.slots) ? d.slots : [])
      }
    } finally {
      setRefreshing(false)
    }
  }, [activeIso, nextIso])

  useEffect(() => {
    document.title = 'Fokus'
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  // Beim Wechsel auf Heute zur aktuellen Stunde scrollen, sonst zum Tagesanfang.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!scrollRef.current) return
    if (activeIso === todayIso) {
      const d = new Date()
      const nowMin = d.getHours() * 60 + d.getMinutes()
      const targetTop = Math.max(0, ((nowMin - HOUR_START * 60) / 60) * HOUR_PX - 100)
      scrollRef.current.scrollTop = targetTop
    } else {
      scrollRef.current.scrollTop = 0
    }
  }, [activeIso, todayIso])

  const onTouchStart = useCallback((e: TouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }, [])
  const onTouchEnd = useCallback((e: TouchEvent) => {
    const s = touchStartRef.current
    touchStartRef.current = null
    const t = e.changedTouches[0]
    if (!s || !t) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.4) return
    goDay(dx < 0 ? 1 : -1)
  }, [goDay])

  return (
    <div style={{
      ...(embedded ? { position: 'absolute' as const, inset: 0 } : { height: '100dvh' }),
      background: 'var(--bg)', color: 'var(--t1)', display: 'flex', flexDirection: 'column',
    }}>
      {embedded ? (
        // Hero exakt wie der Agent-MobileTopMarker und der WA-Header: env-inset-top + 1px,
        // damit Fokus oben denselben Abstand hat wie jedes andere mobile Fenster.
        <div
          style={{
            position: 'relative',
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
          {activeEvent ? (
            <>
              <button
                type="button"
                onClick={() => setActiveEvent(null)}
                aria-label="Zurück zum Kalender"
                style={{ padding: 2, marginRight: 6, color: 'var(--t3)', display: 'flex', background: 'transparent', border: 'none' }}
              >
                <ChevronLeft size={22} strokeWidth={1.75} />
              </button>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.1, color: 'var(--t3)', letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeEvent.title}
              </div>
            </>
          ) : (
            <>
              <div style={{ flex: 1, fontSize: 13, lineHeight: 1.1, color: 'var(--t3)', letterSpacing: '0.02em' }}>Fokus</div>
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  height: 26,
                  borderRadius: 999,
                  background: 'color-mix(in srgb, var(--bg-2) 72%, transparent)',
                  border: '1px solid var(--mobile-chrome-border)',
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  onClick={() => goDay(-1)}
                  aria-label="Voriger Tag"
                  style={{ width: 30, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--t3)', padding: 0 }}
                >
                  <ChevronLeft size={19} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  onClick={resetDay}
                  aria-label="Heute anzeigen"
                  style={{ minWidth: 72, height: 26, background: 'transparent', border: 'none', padding: '0 6px', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 650, color: 'var(--t2)', whiteSpace: 'nowrap' }}
                >
                  {dayTitle}
                </button>
                <button
                  type="button"
                  onClick={() => goDay(1)}
                  aria-label="Nächster Tag"
                  style={{ width: 30, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--t3)', padding: 0 }}
                >
                  <ChevronRight size={19} strokeWidth={1.8} />
                </button>
              </div>
              <button
                onClick={load}
                disabled={refreshing}
                aria-label="Neu laden"
                style={{ background: 'transparent', border: 'none', color: 'var(--t3)', fontSize: 18, padding: '2px 8px', opacity: refreshing ? 0.3 : 0.65, cursor: refreshing ? 'default' : 'pointer' }}
              >
                ↻
              </button>
            </>
          )}
        </div>
      ) : (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '10px 8px 8px',
            position: 'sticky',
            top: 0,
            background: 'var(--bg)',
            zIndex: 20,
            borderBottom: '1px solid color-mix(in srgb, var(--t3) 14%, transparent)',
          }}
        >
          <button
            onClick={() => { activeEvent ? setActiveEvent(null) : (window.location.href = '/mobile') }}
            aria-label="Zurück"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--t1)',
              fontSize: 30,
              lineHeight: 1,
              padding: '4px 14px',
              cursor: 'pointer',
              opacity: 0.85,
            }}
          >
            {activeEvent ? <ChevronLeft size={26} strokeWidth={1.75} /> : '‹'}
          </button>
          {activeEvent ? (
            <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {activeEvent.title}
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
              }}
            >
              <button
                type="button"
                onClick={() => goDay(-1)}
                aria-label="Voriger Tag"
                style={{ width: 34, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--t3)' }}
              >
                <ChevronLeft size={20} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                onClick={resetDay}
                aria-label="Heute anzeigen"
                style={{ minWidth: 94, height: 30, borderRadius: 999, border: '1px solid var(--mobile-chrome-border)', background: 'color-mix(in srgb, var(--bg-2) 72%, transparent)', color: 'var(--t2)', fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 650 }}
              >
                {dayTitle}
              </button>
              <button
                type="button"
                onClick={() => goDay(1)}
                aria-label="Nächster Tag"
                style={{ width: 34, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--t3)' }}
              >
                <ChevronRight size={20} strokeWidth={1.8} />
              </button>
            </div>
          )}
          {!activeEvent && (
            <button
              onClick={load}
              disabled={refreshing}
              aria-label="Neu laden"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--t1)',
                fontSize: 20,
                padding: '6px 14px',
                opacity: refreshing ? 0.3 : 0.65,
                cursor: refreshing ? 'default' : 'pointer',
              }}
            >
              ↻
            </button>
          )}
        </header>
      )}

      {activeEvent && (
        <MobileEventEditor
          ev={activeEvent}
          onClose={() => setActiveEvent(null)}
          onChanged={() => { setActiveEvent(null); load() }}
        />
      )}
      {!activeEvent && (
        <>
          <div
            ref={scrollRef}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            style={{ flex: 1, overflowY: 'auto', paddingTop: 8, paddingBottom: 24 }}
          >
            <DayColumn dayIso={activeIso} events={events} slots={slots} isToday={activeIso === todayIso} onEventTap={setActiveEvent} />
          </div>
        </>
      )}
    </div>
  )
}
