import { useState, useEffect, useCallback, useRef } from 'react'
import './index.css'

// Agent Deck — Monitor View (read-only, TV-tauglich).
// Reine Anzeige der vier Zielchats auf dem großen Bildschirm. Bewusst KEIN
// Import der vollen ChatPane: die zieht Markdown- + Diagramm-Engines (mermaid,
// katex, > 2 MB), an denen ältere Smart-TV-Browser (Samsung Tizen) still
// aussteigen. Hier nur Slots aus /api/slots + Verlauf aus /api/history per
// fetch, schlicht als Text gerendert, Eingabe läuft komplett übers Handy
// (/remote). Live über kurzes Polling statt WS-Stream — robust auf alter Engine.

interface Slot {
  agent: string
  convId: string
}

interface Msg {
  id: number
  author: string
  content: string
  ts: number
  tools?: string
  elapsedMs?: number
}

interface DeckToolCall {
  name?: string
  status?: string
  diffStats?: { added?: number; removed?: number } | null
}

const MAX_SLOTS = 4
const ACCENT = '#d97757'
const POLL_MS = 2500
const SCROLL_POLL_MS = 500   // Remote-Scroll reaktiv halten, ohne Dauerfeuer
const SCROLL_GAIN = 2.4      // großer Monitor: wenig Wischen, viel Weg

function parseTools(raw?: string): DeckToolCall[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function deckToolStats(tools: DeckToolCall[]) {
  const done = tools.filter(t => (t.status || 'completed') === 'completed')
  let added = 0
  let removed = 0
  for (const t of done) {
    added += Number(t.diffStats?.added || 0)
    removed += Number(t.diffStats?.removed || 0)
  }
  const checks = done.filter(t => ['Bash', 'exec'].includes(String(t.name || ''))).length
  const edits = done.filter(t => ['Edit', 'edit', 'Write', 'write'].includes(String(t.name || ''))).length
  return { count: done.length, checks, edits, added, removed }
}

function DeckAnimatedNumber({ value }: { value: number }) {
  const [shown, setShown] = useState(0)
  const targetRef = useRef(value)
  targetRef.current = value

  useEffect(() => {
    const from = shown
    const startTime = performance.now()
    let raf = 0
    const tick = () => {
      const t = Math.min(1, (performance.now() - startTime) / 520)
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(from + (targetRef.current - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return <>{shown}</>
}

function DeckToolTally({ msg }: { msg: Msg }) {
  const tools = parseTools(msg.tools)
  const stats = deckToolStats(tools)
  const seconds = msg.elapsedMs ? Math.round(msg.elapsedMs / 1000) : 0
  if (!stats.count && !seconds) return null
  return (
    <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.35, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
      {seconds > 0 && <span><DeckAnimatedNumber value={seconds} /> s</span>}
      {seconds > 0 && stats.count > 0 && <span> · </span>}
      {stats.count > 0 && <span><DeckAnimatedNumber value={stats.count} /> Tools</span>}
      {stats.edits > 0 && <span> · <DeckAnimatedNumber value={stats.edits} /> Änderungen</span>}
      {stats.checks > 0 && <span> · <DeckAnimatedNumber value={stats.checks} /> Checks</span>}
      {(stats.added > 0 || stats.removed > 0) && (
        <span>
          {' '}· Zeilen: {' '}
          {stats.added > 0 && <span style={{ color: 'var(--diff-add-soft)' }}>+<DeckAnimatedNumber value={stats.added} /></span>}
          {stats.added > 0 && stats.removed > 0 && <span> / </span>}
          {stats.removed > 0 && <span style={{ color: 'var(--diff-del-soft)' }}>-<DeckAnimatedNumber value={stats.removed} /></span>}
        </span>
      )}
    </div>
  )
}

function ChatFeed({ convId, title, active, scrollCmd }: { convId: string; title: string; active: boolean; scrollCmd: { seq: number; dy: number } }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)

  // Remote-Scroll vom Handy: das relative Delta auf diesen Pane anwenden, aber
  // nur wenn er aktiv ist. Danach Bottom-Status neu bestimmen, damit Autoscroll
  // nicht gegen das manuelle Hochscrollen kämpft.
  useEffect(() => {
    if (!active || !scrollCmd.dy) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop += scrollCmd.dy
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [scrollCmd])

  // Verlauf laden + kurz pollen. Nur Text, keine Tools/Markdown.
  useEffect(() => {
    if (!convId) { setMsgs([]); return }
    let cancelled = false
    const load = () => {
      fetch('/api/history?conversation_id=' + encodeURIComponent(convId) + '&limit=40')
        .then(r => r.json())
        .then(d => {
          if (cancelled) return
          const list: Msg[] = Array.isArray(d && d.messages) ? d.messages.map((m: any) => ({
            id: m.id,
            author: String(m.author || ''),
            content: String(m.content || ''),
            ts: m.ts || 0,
            tools: String(m.tools || '[]'),
            elapsedMs: Number(m.elapsed_ms ?? m.elapsedMs ?? 0) || 0,
          })) : []
          setMsgs(prev => {
            const lastPrev = prev.length ? prev[prev.length - 1].id : 0
            const lastNew = list.length ? list[list.length - 1].id : 0
            return lastPrev === lastNew && prev.length === list.length ? prev : list
          })
        })
        .catch(() => {})
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [convId])

  // Autoscroll nach unten, solange der Nutzer nicht selbst hochgescrollt hat.
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [msgs])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        flexShrink: 0, padding: '12px 18px 8px', fontSize: 19, fontWeight: 600,
        color: active ? ACCENT : 'var(--t2, var(--t3))',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        borderBottom: '1px solid var(--line, rgba(255,255,255,0.07))',
      }}>
        {title}
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px 18px' }}
      >
        {msgs.length === 0 ? (
          <div style={{ color: 'var(--t3)', fontSize: 18, marginTop: 8 }}>
            {convId ? 'Noch keine Nachrichten' : 'Kein Chat zugewiesen'}
          </div>
        ) : msgs.map(m => {
          const mine = m.author === 'Du'
          return (
            <div key={m.id} style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '88%', fontSize: 20, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: 'var(--t1)', background: mine ? 'rgba(217,119,87,0.12)' : 'var(--panel, rgba(255,255,255,0.04))',
                borderRadius: 14, padding: '10px 14px',
              }}>
                {m.content}
                {!mine && <DeckToolTally msg={m} />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Fokus-Modus: ruhige Tageswand statt Chat. Zieht /api/fokus/briefing (schon
// fertig formatierte Strings) und rendert sie groß und schlicht — bewusst kein
// Markdown/Diagramm, damit es auf alter TV-Engine läuft wie der Chat-Feed.
interface FocusPayload {
  today: string
  calendar_today: string[]
  pt_today: string[]
  slots_today: string[]
  waiting_on_you: string[]
  lead_pipeline: string[]
  overdue_slots: { title: string; age_days: number }[]
}

function FocusColumn({ title, items, empty, accent }: { title: string; items: string[]; empty: string; accent?: boolean }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 15, letterSpacing: '.12em', textTransform: 'uppercase',
        color: accent ? ACCENT : 'var(--t3)', marginBottom: 12, fontWeight: 600,
      }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 19, color: 'var(--t3)' }}>{empty}</div>
      ) : items.map((it, i) => (
        <div key={i} style={{
          fontSize: 22, lineHeight: 1.5, color: 'var(--t1)', marginBottom: 8,
          paddingLeft: 14, borderLeft: '2px solid ' + (accent ? ACCENT : 'var(--line, rgba(255,255,255,0.12))'),
        }}>{it}</div>
      ))}
    </div>
  )
}

function FocusDeck() {
  const [p, setP] = useState<FocusPayload | null>(null)

  useEffect(() => {
    const load = () => {
      fetch('/api/fokus/briefing').then(r => r.json()).then(d => {
        if (d && d.payload) setP(d.payload)
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  const dateLabel = (() => {
    try {
      return new Date((p?.today || '') + 'T12:00:00').toLocaleDateString('de-DE', {
        weekday: 'long', day: 'numeric', month: 'long',
      })
    } catch { return p?.today || '' }
  })()
  const overdue = (p?.overdue_slots || []).map(o => o.title).filter(Boolean)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--t1)',
      fontFamily: 'var(--font-body, system-ui)', padding: '48px 64px', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flexShrink: 0, marginBottom: 36 }}>
        <div style={{ fontSize: 15, letterSpacing: '.14em', textTransform: 'uppercase', color: ACCENT, marginBottom: 6 }}>Fokus</div>
        <div style={{ fontSize: 40, fontWeight: 600, textTransform: 'capitalize' }}>{dateLabel}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 56, overflow: 'hidden' }}>
        <div style={{ overflowY: 'auto' }}>
          {overdue.length > 0 && <FocusColumn title="Überfällig" items={overdue} empty="" accent />}
          <FocusColumn title="Termine heute" items={[...(p?.calendar_today || []), ...(p?.pt_today || [])]} empty="nichts terminiert" />
          <FocusColumn title="Fokus heute" items={p?.slots_today || []} empty="keine geblockten Slots" />
        </div>
        <div style={{ overflowY: 'auto' }}>
          <FocusColumn title="Wartet auf dich" items={p?.waiting_on_you || []} empty="nichts offen" />
          <FocusColumn title="Pipeline" items={p?.lead_pipeline || []} empty="keine neuen Leads" />
        </div>
      </div>
    </div>
  )
}

export default function DeckMonitor() {
  const [mode, setMode] = useState<'chat' | 'fokus'>('chat')
  const [slots, setSlots] = useState<Slot[]>(() => Array.from({ length: MAX_SLOTS }, () => ({ agent: 'main', convId: '' })))
  const [activeSlot, setActiveSlot] = useState(0)
  const [convMeta, setConvMeta] = useState<Record<string, string>>({})
  const [scrollCmd, setScrollCmd] = useState({ seq: 0, dy: 0 })

  // Eigenen Modus vom Server holen (chat|fokus), gesetzt übers Handy. Gleicher
  // ruhiger Takt wie der Slot-Poll, damit ein Umschalten in Sekunden ankommt.
  useEffect(() => {
    const pull = () => { fetch('/api/deck/me').then(r => r.json()).then(d => {
      if (d && (d.mode === 'chat' || d.mode === 'fokus')) setMode(d.mode)
    }).catch(() => {}) }
    pull()
    const t = setInterval(pull, 3000)
    return () => clearInterval(t)
  }, [])

  const applyServerState = useCallback((d: any) => {
    const incoming = Array.isArray(d && d.slots) ? d.slots : []
    const padded: Slot[] = Array.from({ length: MAX_SLOTS }, (_, i) => {
      const s = incoming[i]
      return { agent: String((s && s.agent) || 'main'), convId: String((s && s.convId) || '') }
    })
    setSlots(prev => JSON.stringify(prev) === JSON.stringify(padded) ? prev : padded)
    if (typeof (d && d.activeSlot) === 'number') setActiveSlot(Math.max(0, Math.min(d.activeSlot, MAX_SLOTS - 1)))
  }, [])

  // Slots laden + kurz pollen (WS-frei, robust auf alter Engine).
  useEffect(() => {
    const pull = () => { fetch('/api/slots').then(r => r.json()).then(applyServerState).catch(() => {}) }
    pull()
    const t = setInterval(pull, 3000)
    return () => clearInterval(t)
  }, [applyServerState])

  // Remote-Scroll vom Handy abholen (eigenes, schnelleres Polling). Der Server
  // akkumuliert die Wisch-Deltas, wir leeren sie hier ab und reichen sie an den
  // aktiven Feed weiter.
  useEffect(() => {
    let cancelled = false
    let seq = 0
    const pull = () => {
      if (document.hidden) return
      fetch('/api/deck/scroll').then(r => r.json()).then(d => {
        if (cancelled) return
        const dy = (Number(d && d.dy) || 0) * SCROLL_GAIN
        if (dy) { seq += 1; setScrollCmd({ seq, dy }) }
      }).catch(() => {})
    }
    const t = setInterval(pull, SCROLL_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Chat-Titel für die Slot-Köpfe.
  useEffect(() => {
    const load = () => {
      fetch('/api/conversations?limit=0').then(r => r.json()).then(d => {
        const map: Record<string, string> = {}
        for (const c of ((d && d.conversations) || [])) map[c.id] = c.title || ''
        setConvMeta(map)
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, [])

  const titleFor = (s: Slot, i: number) => {
    if (!s.convId) return 'Slot ' + (i + 1)
    return convMeta[s.convId] || 'Chat ' + (i + 1)
  }

  if (mode === 'fokus') return <FocusDeck />

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--t1)',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr',
        gap: 2, padding: 2, fontFamily: 'var(--font-body, system-ui)',
      }}
    >
      {slots.map((slot, i) => {
        const isActive = i === activeSlot
        return (
          <div
            key={i}
            style={{
              position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden', borderRadius: 12,
              outline: isActive ? '2px solid ' + ACCENT : '1px solid var(--line, rgba(255,255,255,0.08))',
              outlineOffset: -1,
              boxShadow: isActive ? '0 0 0 3px rgba(217,119,87,0.14)' : 'none',
              background: 'var(--bg)',
            }}
          >
            <ChatFeed convId={slot.convId} title={titleFor(slot, i)} active={isActive} scrollCmd={scrollCmd} />
          </div>
        )
      })}
    </div>
  )
}
