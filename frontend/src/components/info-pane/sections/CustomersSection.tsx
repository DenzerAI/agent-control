import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronRight, UserRound, Users, RefreshCw, FolderOpen, FolderClosed, Building2, MessageCircle, MessageSquare, Mail, Search, Tag } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { fmtEur } from '../utils/eur'
import { openPersonInInfoPane } from '../utils/openPerson'
import { Guided } from '../utils/tree'

// ── Personen — Sicht auf people.db (Kunden-Kategorien + Alle) ──

type CustomerPerson = {
  id: number
  name: string
  email?: string
  phone?: string
  whatsapp_chat_id?: string
  company?: string
  city?: string
  notes?: string
  birthday?: string
}

type CustomerProject = { slug: string; name: string; role: string | null }

type PtInfo = {
  id: string
  billingModel?: string | null
  trainingType?: string | null
  hourlyRate?: number | null
  remainingSessions?: number | null
  totalCardsPurchased?: number | null
  paymentStatus?: string | null
  isActive?: boolean | null
  customerSince?: string | null
  nextAppointment?: string | null
  futureCount?: number
  snapshotAt?: string | null
}

type Customer = {
  id: number
  person_id: number
  categories: string[]
  status: string
  rate_eur: number | null
  active_since: string | null
  last_invoice_ts: number | null
  last_interaction_ts: number | null
  notes: string | null
  next_step_text?: string | null
  next_step_due?: string | null
  person: CustomerPerson | null
  projects: CustomerProject[]
  firm_role?: string | null
  pt?: PtInfo
  ptdesk?: PtInfo
}

type CustomerFirm = {
  id: string
  label: string
  primary_slug: string | null
  count: number
  leads: string[]
  people: Customer[]
}

type CustomerFolder = {
  id: string
  label: string
  count: number
  customers: Customer[]
  firms?: CustomerFirm[]
}

type ChatMention = { author: string; snippet: string; ts: number; agent: string; conversationId: string }
type WaMention = { id: string; chat_id: string; chat_name: string; ts: number; from_me: boolean; type: string; snippet: string }
type MailThread = { uid: string; from?: string; subject?: string; date?: string; snippet?: string }
type PersonIdentity = { id: number; kind: string; value: string; label: string | null; is_primary: number; source: string }
type CrmFocusItem = { title: string; bucket: string; date: string | null; item_key: string }
type CrmEvent = { id: string; start_iso: string; duration_min: number; title: string; category: string }
type CrmNextAction = {
  kind: 'overdue_focus' | 'today_focus' | 'upcoming_event' | 'cold_contact' | 'open_focus'
  reason: string
  title: string
  date?: string
  item_key?: string
  event_id?: number
  days_since?: number
}

type CrmStatus = {
  last_touch: { kind: string; snippet: string; ts: number; ago_human: string } | null
  open_focus: CrmFocusItem[]
  upcoming_events: CrmEvent[]
  next_action: CrmNextAction | null
  stats: { touches_30d: number; channels: string[] }
}

type BusinessAttentionItem = {
  person_id: number
  name: string
  company?: string | null
  relation: string
  bucket: 'pipeline' | 'open_loop' | 'relationship_only'
  reason: string
  next_step_text?: string | null
  next_step_due?: string | null
  last_interaction_ts?: number | null
}

type BusinessOverview = {
  total: number
  pipeline: { count: number; stale_14d: number }
  open_loops: { count: number; overdue: number; due_today: number }
  relationship_only: { count: number; cold_30d: number }
  attention: BusinessAttentionItem[]
}

const CRM_CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Mail',
  chat: 'Chat',
  calendar: 'Termin',
}

function fmtEventStart(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtMentionTs(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function filteredAlle(list: Customer[], q: string): Customer[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list
  return list.filter(c => {
    const p = c.person
    if (!p) return false
    const hay = [p.name, p.company, p.email, p.phone, p.city].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(needle)
  })
}

function fmtRelShort(ts: number): string {
  if (!ts) return ''
  const days = Math.floor((Date.now() / 1000 - ts) / 86400)
  if (days < 0) return ''
  if (days === 0) return 'heute'
  if (days === 1) return 'gestern'
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  if (days < 400) return `${Math.floor(days / 30)}m`
  return `${Math.floor(days / 365)}j`
}

function CustomerDetail({ c }: { c: Customer; detailLeftPad?: number }) {
  const [chatHits, setChatHits] = useState<ChatMention[] | null>(null)
  const [waHits, setWaHits] = useState<WaMention[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [mailHits, setMailHits] = useState<MailThread[] | null>(null)
  const [mailReason, setMailReason] = useState<string | null>(null)
  const [mailLoading, setMailLoading] = useState(false)
  const [identities, setIdentities] = useState<PersonIdentity[] | null>(null)
  const [crm, setCrm] = useState<CrmStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/customers/mentions?person_id=${c.person_id}&limit=6`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        setChatHits(Array.isArray(d.chat) ? d.chat : [])
        setWaHits(Array.isArray(d.whatsapp) ? d.whatsapp : [])
        setLoading(false)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    fetch(`/api/people/${c.person_id}/identities`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setIdentities(Array.isArray(d.identities) ? d.identities : []) })
      .catch(() => { if (!cancelled) setIdentities([]) })
    fetch(`/api/people/${c.person_id}/crm-status`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (d && !d.error) setCrm({
          last_touch: d.last_touch || null,
          open_focus: Array.isArray(d.open_focus) ? d.open_focus : [],
          upcoming_events: Array.isArray(d.upcoming_events) ? d.upcoming_events : [],
          next_action: d.next_action || null,
          stats: d.stats || { touches_30d: 0, channels: [] },
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [c.person_id])

  const extraIdentities = (identities || []).filter(it => {
    if (it.kind === 'email' && c.person?.email && it.value.toLowerCase() === c.person.email.toLowerCase()) return false
    if (it.kind === 'phone' && c.person?.phone) {
      const norm = (s: string) => s.replace(/[^0-9+]/g, '')
      if (norm(it.value) === norm(c.person.phone)) return false
    }
    return it.kind === 'email' || it.kind === 'phone'
  })

  const loadMail = useCallback(() => {
    setMailLoading(true)
    fetch(`/api/customers/mentions/mail?person_id=${c.person_id}&limit=5`)
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.threads)) setMailHits(d.threads)
        else setMailHits([])
        if (d.reason) setMailReason(d.reason)
        setMailLoading(false)
      })
      .catch(() => { setMailHits([]); setMailLoading(false) })
  }, [c.person_id])

  type TimelineItem =
    | { kind: 'chat'; ts: number; key: string; author: string; snippet: string }
    | { kind: 'wa'; ts: number; key: string; from_me: boolean; chat_name: string; snippet: string; type: string }
    | { kind: 'mail'; ts: number; key: string; subject: string; snippet: string }
  const timeline: TimelineItem[] = []
  ;(chatHits || []).forEach((h, i) => timeline.push({ kind: 'chat', ts: h.ts, key: `c${i}`, author: h.author, snippet: h.snippet }))
  ;(waHits || []).forEach((h, i) => timeline.push({ kind: 'wa', ts: h.ts, key: `w${i}`, from_me: h.from_me, chat_name: h.chat_name, snippet: h.snippet, type: h.type }))
  ;(mailHits || []).forEach((t, i) => {
    const ts = t.date ? Math.floor(new Date(t.date).getTime() / 1000) : 0
    timeline.push({ kind: 'mail', ts: Number.isFinite(ts) ? ts : 0, key: `m${i}`, subject: t.subject || '(ohne Betreff)', snippet: t.snippet || '' })
  })
  timeline.sort((a, b) => b.ts - a.ts)

  const pt = c.pt || c.ptdesk
  const ptLine = pt ? [
    pt.billingModel === 'card_based' ? 'Karten' : pt.billingModel === 'hourly' ? 'Stunden' : pt.billingModel,
    pt.remainingSessions != null ? `Rest ${pt.remainingSessions}` : null,
    pt.hourlyRate != null && pt.hourlyRate > 0 ? `${fmtEur(pt.hourlyRate)}/h` : null,
    pt.paymentStatus && pt.paymentStatus !== 'pending' ? pt.paymentStatus : null,
  ].filter(Boolean).join(' · ') : ''

  return (
    <Guided><div className="info-text-meta text-[var(--t3)]/80 pb-2 pl-1 pr-3 space-y-2">
      <div className="text-[var(--t2)]/90 space-y-0.5">
        <div>
          {c.status}
          {c.rate_eur != null && <span> · {fmtEur(c.rate_eur)}</span>}
          {c.active_since && <span> · seit {c.active_since}</span>}
          {crm?.last_touch && (
            <span className="text-[var(--t3)]/60"> · {crm.last_touch.ago_human} {CRM_CHANNEL_LABEL[crm.last_touch.kind] || crm.last_touch.kind}</span>
          )}
          {crm && crm.stats.touches_30d > 0 && (
            <span className="text-[var(--t3)]/60"> · {crm.stats.touches_30d}T/30d</span>
          )}
        </div>
        {(c.person?.email || c.person?.phone) && (
          <div>
            {c.person?.email && <a href={`mailto:${c.person.email}`} className="hover:text-[var(--t1)]">{c.person.email}</a>}
            {c.person?.email && c.person?.phone && <span className="text-[var(--t3)]/40"> · </span>}
            {c.person?.phone && <a href={`tel:${c.person.phone}`} className="hover:text-[var(--t1)]">{c.person.phone}</a>}
          </div>
        )}
        {extraIdentities.map(it => (
          <div key={it.id} className="text-[var(--t3)]/65">
            {it.kind === 'email'
              ? <a href={`mailto:${it.value}`} className="hover:text-[var(--t1)]">{it.value}</a>
              : <a href={`tel:${it.value}`} className="hover:text-[var(--t1)]">{it.value}</a>}
            {it.label && <span className="text-[var(--t3)]/50 ml-1">· {it.label}</span>}
          </div>
        ))}
        {(c.person?.city || c.person?.birthday) && (
          <div className="text-[var(--t3)]/65">
            {c.person?.city}
            {c.person?.city && c.person?.birthday && <span> · </span>}
            {c.person?.birthday && <span>* {c.person.birthday}</span>}
          </div>
        )}
        {(c.notes || c.person?.notes) && (
          <div className="text-[var(--t3)]/70 italic whitespace-pre-wrap">„{c.notes || c.person?.notes}"</div>
        )}
      </div>

      {(c.next_step_text || c.next_step_due || crm?.next_action) && (
        <div className="rounded-md border border-[var(--cc-orange)]/20 bg-[var(--cc-orange)]/8 px-2 py-1.5">
          <div className="text-[var(--t1)]/95 leading-snug">
            {c.next_step_text || crm?.next_action?.title}
          </div>
          {(c.next_step_due || (!c.next_step_text && crm?.next_action?.reason)) && (
            <div className="info-text-meta text-[var(--t3)]/55 mt-0.5">
              {c.next_step_due ? `Fällig: ${c.next_step_due}` : crm?.next_action?.reason}
            </div>
          )}
        </div>
      )}

      {crm && (crm.open_focus.length > 0 || crm.upcoming_events.length > 0) && (
        <div className="space-y-0.5">
          {crm.upcoming_events.map(e => (
            <div key={`e-${e.id}`} className="text-[var(--t2)]/90 leading-snug">
              <span className="text-[var(--t3)]/55 tabular-nums mr-1.5">{fmtEventStart(e.start_iso)}</span>
              {e.title}
            </div>
          ))}
          {crm.open_focus.slice(0, 5).map(f => (
            <div key={`f-${f.item_key}`} className="text-[var(--t2)]/90 leading-snug">
              {f.date && <span className="text-[var(--t3)]/55 tabular-nums mr-1.5">{f.date.slice(5)}</span>}
              {f.title}
            </div>
          ))}
        </div>
      )}

      {pt && (
        <div className="text-[var(--t2)]/90">
          <span className="text-[var(--t3)]/55">PT:</span> {ptLine}
          {pt.nextAppointment && (
            <span> · <span className="text-[var(--t1)]/95">{new Date(pt.nextAppointment).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              {pt.futureCount && pt.futureCount > 1 && <span className="text-[var(--t3)]/60"> (+{pt.futureCount - 1})</span>}
            </span>
          )}
        </div>
      )}

      {c.projects && c.projects.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {c.projects.map(p => (
            <span key={p.slug} className="px-1.5 py-0.5 rounded bg-white/[0.05] text-[var(--t2)]/85">
              {p.name}
              {p.role && <span className="text-[var(--t3)]/60 ml-1">·{p.role}</span>}
            </span>
          ))}
        </div>
      )}

      <div className="pt-1 border-t border-white/[0.04]">
        {loading && <div className="text-[var(--t3)]/50 pt-1">Lädt…</div>}
        {!loading && timeline.length === 0 && mailHits !== null && (
          <div className="text-[var(--t3)]/50 pt-1">Keine Aktivität.</div>
        )}
        {!loading && timeline.map(it => (
          <div key={`${it.kind}-${it.key}`} className="text-[var(--t3)]/85 leading-snug py-0.5 flex gap-1.5">
            <span className="text-[var(--t3)]/45 tabular-nums shrink-0">{fmtMentionTs(it.ts)}</span>
            <span className="text-[var(--t3)]/55 shrink-0">
              {it.kind === 'chat' && <MessageCircle className="info-icon-sm inline" />}
              {it.kind === 'wa' && <MessageSquare className="info-icon-sm inline" />}
              {it.kind === 'mail' && <Mail className="info-icon-sm inline" />}
            </span>
            <span className="min-w-0">
              {it.kind === 'chat' && (
                <><span className="text-[var(--t3)]/60 mr-1">{it.author === 'user' ? 'der Nutzer:' : 'Agent:'}</span>{it.snippet}</>
              )}
              {it.kind === 'wa' && (
                <><span className="text-[var(--t3)]/60 mr-1">{it.from_me ? 'Du:' : `${it.chat_name}:`}</span>{it.snippet || <span className="text-[var(--t3)]/40 italic">[{it.type}]</span>}</>
              )}
              {it.kind === 'mail' && (
                <><span className="text-[var(--t2)]/90">{it.subject}</span>{it.snippet && <span className="text-[var(--t3)]/65"> · {it.snippet}</span>}</>
              )}
            </span>
          </div>
        ))}
        {mailHits === null && c.person?.email && (
          <button
            onClick={(e) => { e.stopPropagation(); loadMail() }}
            disabled={mailLoading}
            className="text-[var(--t3)]/55 hover:text-[var(--t1)] cursor-pointer disabled:opacity-50 pt-1">
            {mailLoading ? 'Mail lädt…' : '+ Mail laden'}
          </button>
        )}
        {mailReason === 'no_account' && <div className="text-[var(--t3)]/45 pt-1">Kein Mail-Account konfiguriert.</div>}
      </div>
    </div></Guided>
  )
}

type UntaggedPerson = {
  id: number
  name: string
  company?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  last_interaction_ts?: number | null
}

const REL_BINDINGS: Array<{ key: string; rel: string; label: string }> = [
  { key: '1', rel: 'kunde',     label: 'Kunde' },
  { key: '2', rel: 'lead',      label: 'Lead' },
  { key: '3', rel: 'freund',    label: 'Freund' },
  { key: '4', rel: 'familie',   label: 'Familie' },
  { key: '5', rel: 'partner',   label: 'Partner' },
  { key: '6', rel: 'lieferant', label: 'Lieferant' },
  { key: '7', rel: 'kollege',   label: 'Kollege' },
  { key: '8', rel: 'kontakt',   label: 'Kontakt' },
]

function UntaggedTagger({ basePad, mobile }: { basePad: number; mobile?: boolean }) {
  const [people, setPeople] = useState<UntaggedPerson[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [focus, setFocus] = useState(0)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [done, setDone] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({})

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/people/list?relation=unklassifiziert&limit=500')
      .then(r => r.json())
      .then(d => {
        setPeople(Array.isArray(d.people) ? d.people : [])
        setFocus(0)
        setLoading(false)
      })
      .catch(() => { setPeople([]); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const setRelation = useCallback((personId: number, rel: string | null) => {
    setSavingId(personId)
    fetch(`/api/people/${personId}/relation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relation: rel }),
    })
      .then(r => r.json())
      .then(() => {
        setPeople(list => {
          if (!list) return list
          const next = list.filter(p => p.id !== personId)
          setFocus(f => Math.max(0, Math.min(f, next.length - 1)))
          return next
        })
        setDone(n => n + 1)
        setSavingId(null)
      })
      .catch(() => setSavingId(null))
  }, [])

  useEffect(() => {
    const el = rowRefs.current[focus]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focus, people])

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!people || people.length === 0) return
    const current = people[focus]
    if (e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault()
      setFocus(f => Math.min(f + 1, people.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus(f => Math.max(f - 1, 0))
      return
    }
    if (e.key === '0' || e.key === ' ') {
      e.preventDefault()
      setFocus(f => Math.min(f + 1, people.length - 1))
      return
    }
    if (e.key === 'Backspace' && current) {
      e.preventDefault()
      setRelation(current.id, null)
      return
    }
    const hit = REL_BINDINGS.find(b => b.key === e.key)
    if (hit && current) {
      e.preventDefault()
      setRelation(current.id, hit.rel)
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className="outline-none"
      style={{ paddingLeft: `${basePad}px`, paddingRight: '12px' }}>
      <div className="info-text-meta text-[var(--t3)]/65 py-2 leading-relaxed">
        Klick rein, dann Tasten <span className="text-[var(--t2)]">1–8</span> zum Taggen,{' '}
        <span className="text-[var(--t2)]">↑↓</span> navigieren,{' '}
        <span className="text-[var(--t2)]">0/Space</span> überspringen,{' '}
        <span className="text-[var(--t2)]">⌫</span> Tag löschen.
        {done > 0 && <span className="text-[var(--t3)]/50"> · {done} getaggt</span>}
      </div>
      <div className="flex flex-wrap gap-1 pb-2">
        {REL_BINDINGS.map(b => (
          <span key={b.key} className="info-text-meta px-1.5 py-0.5 rounded bg-white/[0.05] text-[var(--t2)]/80">
            <span className="text-[var(--cc-orange)] mr-1">{b.key}</span>{b.label}
          </span>
        ))}
      </div>
      {loading && <div className="info-text-meta text-[var(--t3)]/60 py-2">Lädt…</div>}
      {people && people.length === 0 && !loading && (
        <div className="info-text-meta text-[var(--t3)]/60 py-2">Alles getaggt 🎉</div>
      )}
      {people && people.map((p, i) => {
        const isFocus = i === focus
        const rel = fmtRelShort(p.last_interaction_ts || 0)
        return (
          <div
            key={p.id}
            ref={el => { rowRefs.current[i] = el }}
            onClick={() => { setFocus(i); containerRef.current?.focus() }}
            className={`flex items-center ${mobile ? 'py-2' : 'py-[5px]'} px-2 rounded info-text-body cursor-pointer transition-colors ${isFocus ? 'bg-[var(--cc-orange)]/15 ring-1 ring-[var(--cc-orange)]/40' : 'hover:bg-white/[0.05]'}`}>
            <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
            <span className="truncate flex-1 text-[var(--t2)]">
              {p.name}
              {p.company && <span className="ml-1 text-[var(--t3)]/60 info-text-meta">·{p.company}</span>}
            </span>
            {savingId === p.id && <span className="info-text-meta text-[var(--t3)]/60 ml-2">…</span>}
            {rel && savingId !== p.id && (
              <span className="info-text-meta text-[var(--t3)]/55 ml-2 tabular-nums flex-shrink-0">{rel}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

const CAT_BINDINGS: Array<{ key: string; cat: string; label: string }> = [
  { key: '1', cat: 'personal-training', label: 'PT' },
  { key: '2', cat: 'workshops',         label: 'Workshop' },
  { key: '3', cat: 'agent',             label: 'Agent' },
  { key: '4', cat: 'leads',             label: 'Lead' },
]

function UncategorizedCustomerTagger({ basePad, mobile, onDone }: { basePad: number; mobile?: boolean; onDone?: () => void }) {
  const [people, setPeople] = useState<UntaggedPerson[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [focus, setFocus] = useState(0)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [done, setDone] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({})

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/customers/uncategorized')
      .then(r => r.json())
      .then(d => {
        setPeople(Array.isArray(d.people) ? d.people : [])
        setFocus(0)
        setLoading(false)
      })
      .catch(() => { setPeople([]); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const setCategory = useCallback((personId: number, cat: string) => {
    setSavingId(personId)
    fetch('/api/customers/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_id: personId, categories: [cat] }),
    })
      .then(r => r.json())
      .then(() => {
        setPeople(list => {
          if (!list) return list
          const next = list.filter(p => p.id !== personId)
          setFocus(f => Math.max(0, Math.min(f, next.length - 1)))
          if (next.length === 0) onDone?.()
          return next
        })
        setDone(n => n + 1)
        setSavingId(null)
      })
      .catch(() => setSavingId(null))
  }, [onDone])

  useEffect(() => {
    const el = rowRefs.current[focus]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focus, people])

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!people || people.length === 0) return
    const current = people[focus]
    if (e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault()
      setFocus(f => Math.min(f + 1, people.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus(f => Math.max(f - 1, 0))
      return
    }
    if (e.key === '0' || e.key === ' ') {
      e.preventDefault()
      setFocus(f => Math.min(f + 1, people.length - 1))
      return
    }
    const hit = CAT_BINDINGS.find(b => b.key === e.key)
    if (hit && current) {
      e.preventDefault()
      setCategory(current.id, hit.cat)
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className="outline-none"
      style={{ paddingLeft: `${basePad}px`, paddingRight: '12px' }}>
      <div className="info-text-meta text-[var(--t3)]/65 py-2 leading-relaxed">
        Klick rein, dann Tasten <span className="text-[var(--t2)]">1–4</span> zum Taggen,{' '}
        <span className="text-[var(--t2)]">↑↓</span> navigieren,{' '}
        <span className="text-[var(--t2)]">0/Space</span> überspringen.
        {done > 0 && <span className="text-[var(--t3)]/50"> · {done} getaggt</span>}
      </div>
      <div className="flex flex-wrap gap-1 pb-2">
        {CAT_BINDINGS.map(b => (
          <span key={b.key} className="info-text-meta px-1.5 py-0.5 rounded bg-white/[0.05] text-[var(--t2)]/80">
            <span className="text-[var(--cc-orange)] mr-1">{b.key}</span>{b.label}
          </span>
        ))}
      </div>
      {loading && <div className="info-text-meta text-[var(--t3)]/60 py-2">Lädt…</div>}
      {people && people.length === 0 && !loading && (
        <div className="info-text-meta text-[var(--t3)]/60 py-2">Alle kategorisiert 🎉</div>
      )}
      {people && people.map((p, i) => {
        const isFocus = i === focus
        const rel = fmtRelShort(p.last_interaction_ts || 0)
        return (
          <div
            key={p.id}
            ref={el => { rowRefs.current[i] = el }}
            onClick={() => { setFocus(i); containerRef.current?.focus() }}
            className={`flex items-center ${mobile ? 'py-2' : 'py-[5px]'} px-2 rounded info-text-body cursor-pointer transition-colors ${isFocus ? 'bg-[var(--cc-orange)]/15 ring-1 ring-[var(--cc-orange)]/40' : 'hover:bg-white/[0.05]'}`}>
            <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
            <span className="truncate flex-1 text-[var(--t2)]">
              {p.name}
              {p.company && <span className="ml-1 text-[var(--t3)]/60 info-text-meta">·{p.company}</span>}
            </span>
            {savingId === p.id && <span className="info-text-meta text-[var(--t3)]/60 ml-2">…</span>}
            {rel && savingId !== p.id && (
              <span className="info-text-meta text-[var(--t3)]/55 ml-2 tabular-nums flex-shrink-0">{rel}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function CustomersSection({ mobile }: { mobile?: boolean }) {
  const [folders, setFolders] = useState<CustomerFolder[] | null>(null)
  const [businessOverview, setBusinessOverview] = useState<BusinessOverview | null>(null)
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:customersOpen') === '1' } catch { return false }
  })
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('infopane:customersFoldersOpen') || '{}') } catch { return {} }
  })
  const [openItems, setOpenItems] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('infopane:customersItemsOpen') || '{}') } catch { return {} }
  })
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [taggerOpen, setTaggerOpen] = useState(false)
  const [untaggedCount, setUntaggedCount] = useState<number | null>(null)
  const [catTaggerOpen, setCatTaggerOpen] = useState(false)
  const [uncatCount, setUncatCount] = useState<number | null>(null)
  const [jumpPersonId, setJumpPersonId] = useState<number | null>(null)
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    if (!open) return
    fetch('/api/people/list?relation=unklassifiziert&limit=1')
      .then(r => r.json())
      .then(d => {
        const rel = (d.relations || []).find((r: { value: string; count: number }) => r.value === 'unklassifiziert')
        setUntaggedCount(rel ? rel.count : 0)
      })
      .catch(() => {})
    fetch('/api/customers/uncategorized')
      .then(r => r.json())
      .then(d => setUncatCount(typeof d.total === 'number' ? d.total : 0))
      .catch(() => {})
  }, [open])

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/customers')
      .then(r => r.json())
      .then(d => {
        setFolders(d.folders || [])
        setBusinessOverview(d.business_overview || null)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { if (open && folders === null) load() }, [open, folders, load])
  useEffect(() => { try { localStorage.setItem('infopane:customersOpen', open ? '1' : '0') } catch {} }, [open])
  useEffect(() => { try { localStorage.setItem('infopane:customersFoldersOpen', JSON.stringify(openFolders)) } catch {} }, [openFolders])
  useEffect(() => { try { localStorage.setItem('infopane:customersItemsOpen', JSON.stringify(openItems)) } catch {} }, [openItems])

  useEffect(() => {
    const onOpenPerson = (e: Event) => {
      const personId = Number((e as CustomEvent).detail?.personId || 0)
      if (!personId) return
      setOpen(true)
      setQuery('')
      setOpenFolders(prev => ({ ...prev, alle: true }))
      setOpenItems(prev => ({ ...prev, [`alle:${personId}`]: true }))
      setJumpPersonId(personId)
      if (folders === null) load()
    }
    window.addEventListener('deck:open-person', onOpenPerson as EventListener)
    return () => window.removeEventListener('deck:open-person', onOpenPerson as EventListener)
  }, [folders, load])

  useEffect(() => {
    const onRelChange = (e: Event) => {
      const { oldRelation, newRelation } = (e as CustomEvent).detail || {}
      setFolders(prev => {
        if (!prev) return prev
        const oldIsLead = oldRelation === 'lead'
        const newIsLead = newRelation === 'lead'
        if (oldIsLead === newIsLead) return prev
        const delta = newIsLead ? 1 : -1
        return prev.map(f => f.id === 'leads' ? { ...f, count: Math.max(0, f.count + delta) } : f)
      })
      if (open) load()
    }
    window.addEventListener('deck:person-relation-changed', onRelChange as EventListener)
    return () => window.removeEventListener('deck:person-relation-changed', onRelChange as EventListener)
  }, [open, load])

  useEffect(() => {
    if (!jumpPersonId || !open || !folders) return
    const key = `alle:${jumpPersonId}`
    const target = rowRefs.current[key]
    if (!target) return
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.focus({ preventScroll: true })
    })
    setJumpPersonId(null)
  }, [jumpPersonId, open, folders, openItems])

  const toggleFolder = (id: string) => setOpenFolders(o => ({ ...o, [id]: !o[id] }))
  const toggleItem = (key: string) => setOpenItems(o => ({ ...o, [key]: !o[key] }))

  const itemPad = 4
  const folderPad = 4

  const statusDot = (status: string) => {
    if (status === 'aktiv') return 'var(--green)'
    if (status === 'lead') return 'var(--cc-orange)'
    if (status === 'pausiert') return 'var(--t3)'
    if (status === 'archiv') return 'var(--t3)'
    return 'var(--t3)'
  }

  const renderPersonRow = (c: Customer, keyPrefix: string, leftPad: number, detailLeftPad: number) => {
    const key = `${keyPrefix}:${c.person_id}`
    const itemOpen = !!openItems[key]
    const name = c.person?.name || '(ohne Name)'
    const inAlle = keyPrefix === 'alle'
    const catLabel = (x: string) => x === 'personal-training' ? 'PT' : x === 'workshops' ? 'WS' : x === 'agent' ? 'Agent' : 'Lead'
    const shownCats = inAlle ? c.categories : c.categories.filter(x => !keyPrefix.startsWith(x))
    const rel = inAlle && c.last_interaction_ts ? fmtRelShort(c.last_interaction_ts) : ''
    return (
      <div key={key}>
        <button
          ref={el => { rowRefs.current[key] = el }}
          onClick={() => { playUISound(itemOpen ? 'section-close' : 'section-open'); toggleItem(key) }}
          className={`w-full flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
          style={{ paddingLeft: `${leftPad}px` }}>
          <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${itemOpen ? 'rotate-90' : ''}`} />
          <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
          <span
            className="inline-block w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
            style={{ backgroundColor: statusDot(c.status), opacity: c.status === 'aktiv' ? 0.9 : 0.6 }}
            title={c.status}
          />
          <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">
            <span
              onClick={(e) => { e.stopPropagation(); openPersonInInfoPane(c.person_id) }}
              className="cursor-pointer"
              title="In People öffnen"
            >
              {name}
            </span>
            {c.firm_role && (
              <span className="ml-1.5 info-text-meta text-[var(--t3)]/70">·{c.firm_role}</span>
            )}
            {!c.firm_role && c.person?.company && (
              <span className="ml-1 text-[var(--t3)]/60 info-text-meta">·{c.person.company}</span>
            )}
          </span>
          {shownCats.length > 0 && (
            <span className="info-text-meta text-[var(--t3)]/50 ml-2 flex-shrink-0">
              {inAlle ? '' : '+'}{shownCats.map(catLabel).join(', ')}
            </span>
          )}
          {rel && (
            <span className="info-text-meta text-[var(--t3)]/60 ml-2 flex-shrink-0 tabular-nums" title="letzter Kontakt">
              {rel}
            </span>
          )}
        </button>
        {itemOpen && (
          <CustomerDetail c={c} detailLeftPad={detailLeftPad} />
        )}
      </div>
    )
  }

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Users className="info-icon-md mr-2 text-[var(--t3)] flex-shrink-0" />
        <span className="text-[var(--t2)] font-medium">Personen</span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); load() }}
            className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 transition-opacity ${loading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            title="Aktualisieren">
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
        <span className="flex-1" />
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
          {loading && folders === null && (
            <div className="text-[var(--t3)]/60 info-text-meta py-2" style={{ paddingLeft: `${folderPad}px` }}>Lädt…</div>
          )}
          {businessOverview && (
            <div className="pb-2" style={{ paddingLeft: `${folderPad}px`, paddingRight: '12px' }}>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-f)', background: 'var(--bg-2)' }}>
                  <div className="info-text-meta text-[var(--t3)]/60 uppercase tracking-wide">Pipeline</div>
                  <div className="text-[var(--t1)]">{businessOverview.pipeline.count}</div>
                  <div className="info-text-meta text-[var(--t3)]/55">{businessOverview.pipeline.stale_14d} still</div>
                </div>
                <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-f)', background: 'var(--bg-2)' }}>
                  <div className="info-text-meta text-[var(--t3)]/60 uppercase tracking-wide">Offen</div>
                  <div className="text-[var(--t1)]">{businessOverview.open_loops.count}</div>
                  <div className="info-text-meta text-[var(--t3)]/55">{businessOverview.open_loops.overdue} überfällig</div>
                </div>
                <div className="rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-f)', background: 'var(--bg-2)' }}>
                  <div className="info-text-meta text-[var(--t3)]/60 uppercase tracking-wide">Bestand</div>
                  <div className="text-[var(--t1)]">{businessOverview.relationship_only.count}</div>
                  <div className="info-text-meta text-[var(--t3)]/55">{businessOverview.relationship_only.cold_30d} kalt</div>
                </div>
              </div>
              {businessOverview.attention.length > 0 && (
                <div className="mt-2 rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-f)', background: 'var(--bg-2)' }}>
                  <div className="info-text-meta text-[var(--t3)]/60 uppercase tracking-wide mb-1">Jetzt anschauen</div>
                  <div className="space-y-1">
                    {businessOverview.attention.map(item => (
                      <button
                        key={`${item.bucket}:${item.person_id}`}
                        onClick={() => openPersonInInfoPane(item.person_id)}
                        className="w-full text-left rounded px-1.5 py-1 hover:bg-white/[0.05] cursor-pointer transition-colors"
                      >
                        <div className="text-[var(--t2)] leading-snug">
                          {item.name}
                          {item.company && <span className="text-[var(--t3)]/60 ml-1">· {item.company}</span>}
                        </div>
                        <div className="info-text-meta text-[var(--t3)]/60 leading-snug">
                          {item.next_step_text ? `${item.next_step_text} · ` : ''}{item.reason}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {folders?.map(folder => {
            const isOpen = openFolders[folder.id] ?? false
            const FolderIcon = isOpen ? FolderOpen : FolderClosed
            return (
              <div key={folder.id}>
                <button
                  onClick={() => { playUISound(isOpen ? 'section-close' : 'section-open'); toggleFolder(folder.id) }}
                  className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                  <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                  <FolderIcon className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                  <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">{folder.label}</span>
                  <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{folder.count}</span>
                </button>
                {isOpen && (
                  <Guided>
                    {folder.customers.length === 0 && (
                      <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Niemand hier.</div>
                    )}
                    {folder.id === 'agent' && folder.firms && folder.firms.map(firm => {
                      const firmKey = `firm:${folder.id}:${firm.id}`
                      const firmOpen = openFolders[firmKey] ?? false
                      return (
                        <div key={firm.id}>
                          <button
                            onClick={() => { playUISound(firmOpen ? 'section-close' : 'section-open'); toggleFolder(firmKey) }}
                            className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                            <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${firmOpen ? 'rotate-90' : ''}`} />
                            <Building2 className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                            <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">
                              {firm.label}
                              {firm.leads.length > 0 && (
                                <span className="ml-1.5 text-[var(--t3)]/60 info-text-meta">·{firm.leads.join(', ')}</span>
                              )}
                            </span>
                            <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{firm.count}</span>
                          </button>
                          {firmOpen && (
                            <Guided>
                              {firm.people.map(c => renderPersonRow(c, `${folder.id}:${firm.id}`, 4, 16))}
                            </Guided>
                          )}
                        </div>
                      )
                    })}
                    {folder.id === 'alle' && (
                      <div className="py-1.5 pl-1 pr-3">
                        <div className="flex items-center gap-1.5 rounded-md bg-white/[0.04] border border-[var(--t3)]/15 px-2 py-1">
                          <Search className="info-icon-sm text-[var(--t3)]/60 flex-shrink-0" />
                          <input
                            type="text"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Name, Firma, Telefon …"
                            className="flex-1 bg-transparent outline-none info-text-body text-[var(--t2)] placeholder:text-[var(--t3)]/40"
                          />
                          {query && (
                            <button
                              onClick={() => setQuery('')}
                              className="info-text-meta text-[var(--t3)]/60 hover:text-[var(--t1)] cursor-pointer">
                              ×
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {!(folder.id === 'agent' && folder.firms) && (
                      folder.id === 'alle' ? filteredAlle(folder.customers, query) : folder.customers
                    ).map(c => renderPersonRow(c, folder.id, 4, 16))}
                  </Guided>
                )}
              </div>
            )
          })}
          {folders && folders.every(f => f.count === 0) && (
            <div className="info-text-meta text-[var(--t3)]/50 py-2" style={{ paddingLeft: `${folderPad}px` }}>Niemand in der DB.</div>
          )}
          {untaggedCount !== null && untaggedCount > 0 && (
            <div>
              <button
                onClick={() => { playUISound(taggerOpen ? 'section-close' : 'section-open'); setTaggerOpen(v => !v) }}
                className={`w-full flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
                style={{ paddingLeft: `${folderPad}px` }}>
                <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${taggerOpen ? 'rotate-90' : ''}`} />
                <Tag className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">Ohne Tag</span>
                <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{untaggedCount}</span>
              </button>
              {taggerOpen && (
                <Guided>
                  <UntaggedTagger basePad={itemPad} mobile={mobile} />
                </Guided>
              )}
            </div>
          )}
          {uncatCount !== null && uncatCount > 0 && (
            <div>
              <button
                onClick={() => { playUISound(catTaggerOpen ? 'section-close' : 'section-open'); setCatTaggerOpen(v => !v) }}
                className={`w-full flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
                style={{ paddingLeft: `${folderPad}px` }}>
                <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${catTaggerOpen ? 'rotate-90' : ''}`} />
                <Tag className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">Kunden ohne Kategorie</span>
                <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{uncatCount}</span>
              </button>
              {catTaggerOpen && (
                <Guided>
                  <UncategorizedCustomerTagger
                    basePad={itemPad}
                    mobile={mobile}
                    onDone={() => setUncatCount(0)}
                  />
                </Guided>
              )}
            </div>
          )}
          </Guided>
        </div>
      )}
    </div>
  )
}
