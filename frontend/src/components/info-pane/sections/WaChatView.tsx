import React, { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import { ChevronLeft, FolderOpen, Archive, ArchiveRestore, FileText, Volume2, Loader2, Play, Pause, Download, X, Smile, Image as ImageIcon, Film, Video, Wand2, Brain, ArrowDown, Copy, Check, Plus, Mic, Send, User, Phone } from 'lucide-react'
import { linkifyText } from '../utils/linkify'
import { useMainAgentName } from '../../../agents'
import { formatWaTime } from '../utils/wa'
import { renderInlinePreview } from '../../../lib/inlinePreview'

// ── WhatsApp Chat View ──

interface WaReaction {
  sender_jid: string
  emoji: string
  ts: number
}

interface WaMessage {
  id: string
  ts: number
  from_me: boolean
  sender_jid: string | null
  sender_name?: string | null
  type: string
  body: string | null
  transcript: string | null
  has_media: boolean
  media_mime: string | null
  has_media_file: boolean
  is_gif?: boolean
  filename?: string | null
  quoted_msg_id: string | null
  quoted?: {
    sender_jid: string | null
    sender_name?: string | null
    from_me: boolean
    type: string
    preview: string
  } | null
  context?: {
    kind: 'story_reply' | string
    label: string
    preview?: string | null
  } | null
  reactions?: WaReaction[]
  thumbnail_b64?: string | null
  ack?: number | null
  summary?: string | null
  cls_topic?: string | null
  cls_urgency?: 'low' | 'normal' | 'high' | null
}

function formatWaDay(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Heute'
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern'
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays < 7 && diffDays > 0) return d.toLocaleDateString('de-DE', { weekday: 'long' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' })
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
}

const REACTION_EMOJIS = ['❤️', '👍', '👎', '😂', '😮', '🙏']
const VOICE_WAVE_BARS = [6, 9, 13, 16, 18, 15, 11, 14, 19, 22, 18, 13, 16, 20, 17, 12, 15, 19, 16, 11, 13, 17, 14, 10, 12, 15, 11, 7]

interface Person {
  id?: number
  name: string
  phone?: string
  whatsapp_chat_id?: string
  email?: string
  instagram?: string
  role?: string
  relation?: string
  status?: string
  company?: string
  city?: string
  anrede?: string
  offer_eur?: number | null
  tags?: string[]
  birthday?: string
  notes?: string
  source?: string
  last_interaction_ts?: number
}

const RELATION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '—' },
  { value: 'kunde', label: 'Kunde' },
  { value: 'lead', label: 'Lead' },
  { value: 'freund', label: 'Freund' },
  { value: 'familie', label: 'Familie' },
  { value: 'partner', label: 'Partner' },
  { value: 'lieferant', label: 'Lieferant' },
  { value: 'kollege', label: 'Kollege' },
  { value: 'kontakt', label: 'Kontakt' },
]

function PersonCard({ chatId, chatName, onClose }: { chatId: string; chatName: string; onClose: () => void }) {
  const [person, setPerson] = useState<Person | null>(null)
  const [waContact, setWaContact] = useState<{ phone?: string; is_business?: number; business_name?: string; business_description?: string; business_website?: string; business_email?: string; business_category?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true); setNotFound(false); setError('')
    fetch(`/api/people/get?whatsapp_chat_id=${encodeURIComponent(chatId)}`)
      .then(async r => {
        if (r.status === 404) { setNotFound(true); setLoading(false); return }
        if (!r.ok) throw new Error(await r.text())
        const d = await r.json()
        setPerson(d.person); setWaContact(d.wa_contact || null); setLoading(false)
      })
      .catch(e => { setError(String(e).slice(0, 120)); setLoading(false) })
  }, [chatId])

  const createPerson = async () => {
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/people/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: chatName, whatsapp_chat_id: chatId, source: 'whatsapp' }),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setPerson(d.person); setNotFound(false)
    } catch (e) {
      setError(String(e).slice(0, 120))
    } finally {
      setSaving(false)
    }
  }

  const saveField = async (field: keyof Person, value: unknown) => {
    if (!person?.id) return
    const cur = person[field]
    if (cur === value || (cur == null && value === '')) return
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/people/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: person.id, [field]: value }),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setPerson(d.person)
    } catch (e) {
      setError(String(e).slice(0, 120))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="max-w-md w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-lg shadow-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]/50 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="info-text-title text-[var(--t1)] font-medium truncate">{person?.name || chatName}</span>
            {saving && <Loader2 className="info-icon-sm text-[var(--t3)] animate-spin" />}
          </div>
          <button onClick={onClose} className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer"><X className="info-icon-md" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {loading && <div className="info-text-body text-[var(--t3)] text-center py-4">Lade...</div>}
          {error && <div className="info-text-meta text-red-400">{error}</div>}

          {notFound && !loading && (
            <div className="text-center py-6 space-y-3">
              <div className="info-text-body text-[var(--t2)]">Noch kein CRM-Eintrag für {chatName}.</div>
              <button onClick={createPerson} disabled={saving}
                className="info-text-body px-3 py-1.5 rounded-md bg-[var(--t1)]/10 text-[var(--t1)] hover:bg-[var(--t1)]/15 cursor-pointer disabled:opacity-50">
                Als Kontakt anlegen
              </button>
            </div>
          )}

          {person && (
            <>
              <PcField label="Name" value={person.name || ''} onSave={v => saveField('name', v)} />
              <div className="grid grid-cols-2 gap-2">
                <PcField label="Firma" value={person.company || ''} onSave={v => saveField('company', v)} />
                <PcSelect label="Beziehung" value={person.relation || ''} options={RELATION_OPTIONS} onSave={v => saveField('relation', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <PcField label="Telefon" value={person.phone || ''} onSave={v => saveField('phone', v)} />
                <PcField label="Stadt" value={person.city || ''} onSave={v => saveField('city', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <PcField label="E-Mail" value={person.email || ''} onSave={v => saveField('email', v)} />
                <PcField label="Instagram" value={person.instagram || ''} onSave={v => saveField('instagram', v)} />
              </div>
              <PcField label="Tags (komma-getrennt)" value={(person.tags || []).join(', ')}
                onSave={v => saveField('tags', v.split(',').map(s => s.trim()).filter(Boolean))} />
              <PcField label="Geburtstag (YYYY-MM-DD)" value={person.birthday || ''} onSave={v => saveField('birthday', v)} />
              <PcTextarea label="Notizen" value={person.notes || ''} onSave={v => saveField('notes', v)} />
              {waContact && (waContact.phone || waContact.business_name || waContact.business_description || waContact.business_website) && (
                <div className="pt-2 border-t border-[var(--border)]/40 space-y-1">
                  <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">Aus WhatsApp</div>
                  {waContact.phone && (
                    <div className="info-text-body text-[var(--t2)]">
                      Telefon (WA): <span className="text-[var(--t1)]">{waContact.phone}</span>
                      {!person.phone && (
                        <button onClick={() => saveField('phone', waContact.phone!)}
                          className="ml-2 info-text-meta text-[var(--t3)] hover:text-[var(--t1)] underline cursor-pointer">übernehmen</button>
                      )}
                    </div>
                  )}
                  {waContact.business_name && <div className="info-text-body text-[var(--t2)]">Business: <span className="text-[var(--t1)]">{waContact.business_name}</span></div>}
                  {waContact.business_category && <div className="info-text-meta text-[var(--t3)]">Branche: {waContact.business_category}</div>}
                  {waContact.business_website && <div className="info-text-meta text-[var(--t3)] truncate">Website: {waContact.business_website}</div>}
                  {waContact.business_email && <div className="info-text-meta text-[var(--t3)]">E-Mail: {waContact.business_email}</div>}
                  {waContact.business_description && <div className="info-text-meta text-[var(--t3)] whitespace-pre-wrap">{waContact.business_description}</div>}
                </div>
              )}
              <div className="pt-2 info-text-meta text-[var(--t3)] flex items-center gap-2 flex-wrap">
                {person.source && <span>Quelle: {person.source}</span>}
                {person.last_interaction_ts && <><span>·</span><span>Zuletzt: {formatWaTime(person.last_interaction_ts)}</span></>}
                {person.id && <><span>·</span><span>ID {person.id}</span></>}
                {chatId && <><span>·</span><span className="truncate max-w-[140px]">WA-ID {chatId}</span></>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function PcField({ label, value, onSave, type = 'text' }: { label: string; value: string; onSave: (v: string) => void; type?: string }) {
  const [val, setVal] = useState(value)
  useEffect(() => { setVal(value) }, [value])
  return (
    <label className="block">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{label}</span>
      <input type={type} value={val} onChange={e => setVal(e.target.value)} onBlur={() => onSave(val)}
        className="w-full mt-0.5 bg-[var(--bg-0)] border border-[var(--border)]/60 rounded px-2 py-1 info-text-body text-[var(--t1)] outline-none focus:border-[var(--t3)]" />
    </label>
  )
}

function PcSelect({ label, value, options, onSave }: { label: string; value: string; options: { value: string; label: string }[]; onSave: (v: string) => void }) {
  return (
    <label className="block">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{label}</span>
      <select value={value} onChange={e => onSave(e.target.value)}
        style={{ colorScheme: 'dark' }}
        className="w-full mt-0.5 bg-[var(--bg-0)] border border-[var(--border)]/60 rounded px-2 py-1 info-text-body text-[var(--t1)] outline-none focus:border-[var(--t3)] cursor-pointer">
        {options.map(o => (
          <option key={o.value} value={o.value} className="bg-[var(--bg-1)] text-[var(--t1)]">{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function PcTextarea({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [val, setVal] = useState(value)
  useEffect(() => { setVal(value) }, [value])
  return (
    <label className="block">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{label}</span>
      <textarea value={val} onChange={e => setVal(e.target.value)} onBlur={() => onSave(val)} rows={3}
        className="w-full mt-0.5 bg-[var(--bg-0)] border border-[var(--border)]/60 rounded px-2 py-1 info-text-body text-[var(--t1)] outline-none focus:border-[var(--t3)] resize-y" />
    </label>
  )
}

function VoiceMessagePlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onLoaded = () => {
      const d = a.duration
      if (isFinite(d) && d > 0) setDuration(d)
    }
    const onTime = () => setCurrent(a.currentTime)
    const onEnded = () => { setPlaying(false); setCurrent(0) }
    a.addEventListener('loadedmetadata', onLoaded)
    a.addEventListener('durationchange', onLoaded)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('ended', onEnded)
    return () => {
      a.removeEventListener('loadedmetadata', onLoaded)
      a.removeEventListener('durationchange', onLoaded)
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('ended', onEnded)
    }
  }, [])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) { a.pause(); setPlaying(false) }
    else { a.play().then(() => setPlaying(true)).catch(() => {}) }
  }

  const cycleRate = () => {
    const rates = [1, 1.5, 2]
    const next = rates[(rates.indexOf(rate) + 1) % rates.length]
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const fmt = (t: number) => {
    if (!isFinite(t) || t <= 0) return '0:00'
    const m = Math.floor(t / 60), s = Math.floor(t % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0
  const activeBar = duration > 0 ? Math.floor((pct / 100) * (VOICE_WAVE_BARS.length - 1)) : -1

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current
    if (!a || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    a.currentTime = Math.max(0, Math.min(duration, x * duration))
    setCurrent(a.currentTime)
  }

  const elapsedLabel = fmt(current)
  const durationLabel = fmt(duration)

  return (
    <div className={`wa-voice-player ${playing ? 'is-playing' : ''}`}>
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        onClick={toggle}
        className="wa-voice-play"
        title={playing ? 'Pause' : 'Abspielen'}
      >
        {playing ? <Pause className="info-icon-sm" /> : <Play className="info-icon-sm ml-[1px]" />}
      </button>
      <div className="wa-voice-main">
        <div
          onClick={seek}
          className="wa-voice-wave"
          title={duration > 0 ? `${elapsedLabel} / ${durationLabel}` : 'Sprachnachricht'}
        >
          {VOICE_WAVE_BARS.map((h, i) => (
            <span
              key={`${h}-${i}`}
              className={i <= activeBar ? 'is-active' : ''}
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
        <div className="wa-voice-meta-line">
          <span className="wa-voice-time">{playing || current > 0 ? `${elapsedLabel} / ${durationLabel}` : durationLabel}</span>
          <button
            onClick={cycleRate}
            className="wa-voice-rate"
            title="Wiedergabegeschwindigkeit"
          >
            {rate === 1 ? '1×' : rate === 1.5 ? '1.5×' : '2×'}
          </button>
        </div>
      </div>
    </div>
  )
}

function renderInlineBold(s: string): React.ReactNode {
  const parts = s.split(/(\*\*[^*\n]+\*\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={i} className="font-semibold text-[var(--t1)]">{p.slice(2, -2)}</strong>
    }
    return <span key={i}>{p}</span>
  })
}

function renderReadableInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g)
  return parts.flatMap((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return [<strong key={`b-${i}`} className="font-semibold text-[var(--t1)]">{part.slice(2, -2)}</strong>]
    }
    return linkifyText(part).map((node, j) => <Fragment key={`t-${i}-${j}`}>{node}</Fragment>)
  })
}

function renderVoiceSummary(summary: string): React.ReactNode {
  const lines = summary.split(/\n/).map(l => l.replace(/\s+$/, ''))
  const out: React.ReactNode[] = []
  let k = 0
  for (const raw of lines) {
    if (!raw.trim()) continue
    const sub = raw.match(/^(?:\s{2,}|\t)[-•·*]\s+(.*)$/)
    const bullet = raw.match(/^[-•·*]\s+(.*)$/)
    const headerBold = raw.match(/^\*\*([^*]+)\*\*\s*$/)
    if (sub) {
      out.push(
        <li key={k++} className="flex gap-1.5 pl-4 text-[var(--t2)]">
          <span className="text-[var(--t3)] flex-shrink-0 leading-snug">·</span>
          <span className="leading-snug">{renderInlineBold(sub[1])}</span>
        </li>
      )
    } else if (bullet) {
      out.push(
        <li key={k++} className="flex gap-1.5">
          <span className="text-[var(--t3)] flex-shrink-0 leading-snug">·</span>
          <span className="leading-snug">{renderInlineBold(bullet[1])}</span>
        </li>
      )
    } else if (headerBold) {
      out.push(
        <div key={k++} className="info-text-body font-semibold text-[var(--t1)] leading-snug">
          {headerBold[1]}
        </div>
      )
    } else {
      out.push(
        <div key={k++} className="info-text-body text-[var(--t1)] leading-snug">
          {renderInlineBold(raw)}
        </div>
      )
    }
  }
  return <div className="space-y-0.5">{out}</div>
}

function splitReadableParagraph(paragraph: string): string[] {
  const out: string[] = []
  let rest = paragraph.trim()
  while (rest.length > 580) {
    const start = 260
    const end = Math.min(rest.length, 520)
    const windowText = rest.slice(start, end)
    const breaks = [...windowText.matchAll(/(?:[.!?]\s+|[,;:]\s+|\s+(?:und|aber|oder|also|wenn|damit|dass)\s+)/gi)]
    const lastBreak = breaks[breaks.length - 1]
    const cut = lastBreak?.index != null ? start + lastBreak.index + lastBreak[0].length : end
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}

interface SharedContact {
  name: string
  phones: { label: string; number: string }[]
  org: string
  emails: string[]
}

function parseSharedVCards(text: string): SharedContact[] {
  const unfolded = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '')
  const blocks = unfolded.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || []
  const contacts: SharedContact[] = []
  for (const block of blocks) {
    const contact: SharedContact = { name: '', phones: [], org: '', emails: [] }
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':')
      if (idx <= 0) continue
      const key = line.slice(0, idx)
      const value = line.slice(idx + 1).trim()
      if (!value) continue
      const prop = key.replace(/^item\d+\./i, '').split(';')[0].toUpperCase()
      if (prop === 'FN') {
        contact.name = value
      } else if (prop === 'N' && !contact.name) {
        contact.name = value.split(';').filter(Boolean).reverse().join(' ').trim()
      } else if (prop === 'TEL') {
        const number = value.trim()
        const typeMatch = key.match(/TYPE=([^;:]+)/i)
        const label = typeMatch ? typeMatch[1] : ''
        if (number && !contact.phones.some(ph => ph.number === number)) {
          contact.phones.push({ label, number })
        }
      } else if (prop === 'ORG') {
        contact.org = value.replace(/;+$/, '').trim()
      } else if (prop === 'EMAIL') {
        if (!contact.emails.includes(value)) contact.emails.push(value)
      }
    }
    if (contact.name || contact.phones.length > 0) contacts.push(contact)
  }
  return contacts
}

function telLabel(raw: string): string {
  const t = raw.toLowerCase()
  if (t.includes('cell') || t.includes('mobile')) return 'Mobil'
  if (t.includes('work')) return 'Arbeit'
  if (t.includes('home')) return 'Privat'
  return ''
}

function readableWaParagraphs(text: string): string[] {
  const normalized = text
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!normalized) return []

  const existing = normalized
    .split(/\n{2,}/)
    .map(p => p.replace(/\n+/g, ' ').trim())
    .filter(Boolean)
  if (existing.length > 1) return existing.flatMap(splitReadableParagraph)

  const sentences = normalized.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) || [normalized]
  const paragraphs: string[] = []
  let current = ''
  const startsNewThought = /^(?:Aber|Also|Bisher|Dann|Deswegen|Für|Gerade|Ob|Oder|Vielleicht|Wenn|Wir|Die Mitarbeiter|Das wäre|Das ist|So,)\b/

  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    const shouldBreak = current && (
      current.length + sentence.length > 520 ||
      (current.length > 220 && startsNewThought.test(sentence))
    )
    if (shouldBreak) {
      paragraphs.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) paragraphs.push(current)
  return paragraphs.flatMap(splitReadableParagraph)
}

function renderReadableWaText(text: string): React.ReactNode {
  const paragraphs = readableWaParagraphs(text)
  if (!paragraphs.length) return null
  return (
    <div className="wa-readable-text">
      {paragraphs.map((p, i) => (
        <p key={i}>{renderReadableInline(p)}</p>
      ))}
    </div>
  )
}

export function WaChatView({ chatId, onBack, mobile }: { chatId: string; onBack: () => void; mobile?: boolean }) {
  const agentName = useMainAgentName()
  const [data, setData] = useState<{ chat: { id: string; name: string; is_group: boolean; unread: number; is_archived?: boolean; pinned_project_id?: string; pinned_project_name?: string; pinned_conversation_id?: string; pinned_conversation_title?: string; pinned_conversation_project_name?: string }; messages: WaMessage[] } | null>(null)
  const [conversations, setConversations] = useState<{ id: string; title: string; project: string; project_name: string; updated_at: number }[]>([])
  const [pinMenuOpen, setPinMenuOpen] = useState(false)
  const [pinFilter, setPinFilter] = useState('')
  const pinMenuRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [brainAdvice, setBrainAdvice] = useState('')
  const [brainAdviceSaved, setBrainAdviceSaved] = useState(false)
  const [brainAdviceLoading, setBrainAdviceLoading] = useState(false)
  const brainAdviceRequestRef = useRef(0)
  // Dreiklang am Brain-Knopf wie auf Mobile: 0 = aus, 1 = nur das Neue (light), 2 = ganzer Faden (full).
  const [brainStage, setBrainStage] = useState<0 | 1 | 2>(0)
  // Draft-first: jede Eingabe (Text oder Diktat) wird erst zu einem bestätigbaren Entwurf,
  // gesendet wird nur per Haken. draftBlock ist der fertige Entwurf, draft das Hint-Feld.
  const [draftBlock, setDraftBlock] = useState('')
  const draftBlockRef = useRef('')
  useEffect(() => { draftBlockRef.current = draftBlock }, [draftBlock])
  const draftRef = useRef('')
  useEffect(() => { draftRef.current = draft }, [draft])

  // Desktop-Eingabemodi: 'draft' (Entwurf-first, Default), 'keyboard' (Enter sendet direkt),
  // 'voice' (echte WhatsApp-Sprachnachricht). Mobile bleibt unberührt.
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceSending, setVoiceSending] = useState(false)
  const [voiceElapsed, setVoiceElapsed] = useState(0)
  const voiceRecRef = useRef<MediaRecorder | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceCancelRef = useRef(false)
  useEffect(() => {
    if (!voiceRecording) return
    setVoiceElapsed(0)
    const t = setInterval(() => setVoiceElapsed(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [voiceRecording])
  const [reactionPickerFor, setReactionPickerFor] = useState<string>('')
  const [copiedFor, setCopiedFor] = useState<string>('')
  const [speakingFor, setSpeakingFor] = useState<string>('')
  const copyMessage = useCallback((id: string, text: string) => {
    try {
      navigator.clipboard?.writeText(text)
      setCopiedFor(id)
      window.setTimeout(() => setCopiedFor(prev => prev === id ? '' : prev), 1500)
    } catch {}
  }, [])
  const speakMessage = useCallback((id: string, text: string) => {
    try {
      const synth = window.speechSynthesis
      if (!synth) return
      if (speakingFor === id) { synth.cancel(); setSpeakingFor(''); return }
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'de-DE'
      u.onend = () => setSpeakingFor(prev => prev === id ? '' : prev)
      u.onerror = () => setSpeakingFor(prev => prev === id ? '' : prev)
      setSpeakingFor(id)
      synth.speak(u)
    } catch {}
  }, [speakingFor])
  useEffect(() => () => { try { window.speechSynthesis?.cancel() } catch {} }, [])
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef<boolean>(false)
  const startLongPress = (id: string) => {
    longPressFired.current = false
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true
      setReactionPickerFor(prev => prev === id ? '' : id)
      try { (navigator as any).vibrate?.(15) } catch {}
    }, 450)
  }
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')
  const [personCardOpen, setPersonCardOpen] = useState(false)
  const [imageViewer, setImageViewer] = useState<string>('')
  const [loadedMedia, setLoadedMedia] = useState<Set<string>>(new Set())
  const [failedMedia, setFailedMedia] = useState<Set<string>>(new Set())
  const [voiceDictating, setVoiceDictating] = useState(false)
  const [voiceTranscribing, setVoiceTranscribing] = useState(false)
  const [dictateElapsed, setDictateElapsed] = useState(0)
  useEffect(() => {
    if (!voiceDictating) return
    setDictateElapsed(0)
    const t = setInterval(() => setDictateElapsed(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [voiceDictating])
  const bodyRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const initialScrollDoneRef = useRef(false)
  useEffect(() => {
    initialScrollDoneRef.current = false
    setAtBottom(true)
    brainAdviceRequestRef.current += 1
    setBrainAdvice('')
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    setBrainStage(0)
    setDraftBlock('')
  }, [chatId])
  const scrollToBottom = useCallback((smooth = false) => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAtBottom(nearBottom)
  }, [])
  const dictateRecRef = useRef<MediaRecorder | null>(null)
  const dictateChunksRef = useRef<Blob[]>([])
  const dictateCancelRef = useRef(false)
  const dictateCountRef = useRef(0)

  const resizeDraft = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    // Eine Zeile = lineHeight + vertikales Padding; darunter darf die Hoehe nie
    // fallen, sonst kappt overflow:hidden Unterlaengen und Cursor.
    const min = mobile ? 40 : 36
    el.style.height = 'auto'
    el.style.height = Math.max(min, Math.min(el.scrollHeight, 200)) + 'px'
    el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden'
  }, [mobile])

  useEffect(() => { resizeDraft() }, [draft, resizeDraft])
  // Nach dem Font-Load einmal nachmessen, sonst bleibt eine zu kleine Hoehe haengen.
  useEffect(() => { document.fonts?.ready?.then(() => resizeDraft()).catch(() => {}) }, [resizeDraft])

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}&limit=100`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [chatId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!pinMenuOpen) return
    Promise.all([
      fetch('/api/conversations?limit=0').then(r => r.json()).catch(() => ({ conversations: [] })),
      fetch('/api/projects').then(r => r.json()).catch(() => ({ projects: [] })),
    ]).then(([cd, pd]) => {
      const projMap: Record<string, string> = {}
      for (const p of (pd.projects || [])) projMap[p.id] = p.name
      const convs = (cd.conversations || []).map((c: any) => ({
        id: c.id,
        title: c.title || 'Ohne Titel',
        project: c.project || '',
        project_name: c.project ? (projMap[c.project] || '') : '',
        updated_at: c.updated_at || 0,
      }))
      setConversations(convs)
    })
  }, [pinMenuOpen])

  useEffect(() => {
    if (!pinMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (pinMenuRef.current && !pinMenuRef.current.contains(e.target as Node)) { setPinMenuOpen(false); setPinFilter('') }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinMenuOpen(false); setPinFilter('') } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pinMenuOpen])

  const setPinnedConversation = useCallback(async (conversationId: string) => {
    setPinMenuOpen(false)
    setPinFilter('')
    if (!data) return
    const prev = data.chat.pinned_conversation_id || ''
    if (prev === conversationId) return
    try {
      const r = await fetch('/api/whatsapp/pin-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, conversation_id: conversationId }),
      })
      if (!r.ok) return
      const conv = conversations.find(c => c.id === conversationId)
      setData({
        ...data,
        chat: {
          ...data.chat,
          pinned_conversation_id: conversationId,
          pinned_conversation_title: conv?.title || '',
          pinned_conversation_project_name: conv?.project_name || '',
        },
      })
    } catch {}
  }, [data, chatId, conversations])

  useEffect(() => {
    fetch('/api/whatsapp/send-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    }).catch(() => {})
  }, [chatId])

  useEffect(() => {
    const interval = setInterval(load, 8000)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    const n = data?.messages?.length || 0
    if (!n) return
    if (!initialScrollDoneRef.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom(false)
          initialScrollDoneRef.current = true
          setAtBottom(true)
        })
      })
      return
    }
    if (atBottom) requestAnimationFrame(() => scrollToBottom(false))
  }, [data?.messages?.length, atBottom, scrollToBottom])

  const loadBrainAdvice = useCallback(async (level: 'light' | 'full' = 'light') => {
    const requestId = ++brainAdviceRequestRef.current
    setBrainAdvice('')
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(true)
    setError('')
    try {
      const r = await fetch(`/api/whatsapp/brain-advice?chat_id=${encodeURIComponent(chatId)}&level=${level}`)
      const d = r.ok ? await r.json() : null
      if (brainAdviceRequestRef.current !== requestId) return
      const text = String(d?.advice || '').trim()
      setBrainAdviceSaved(!!d?.cached)
      setBrainAdvice(text || 'Ich konnte den Verlauf gerade nicht sauber einschätzen.')
      requestAnimationFrame(() => scrollToBottom(true))
    } catch {
      if (brainAdviceRequestRef.current !== requestId) return
      setBrainAdvice('Ich konnte den Verlauf gerade nicht sauber einschätzen.')
    } finally {
      if (brainAdviceRequestRef.current === requestId) setBrainAdviceLoading(false)
    }
  }, [chatId, scrollToBottom])

  useEffect(() => {
    const requestId = ++brainAdviceRequestRef.current
    setBrainAdvice('')
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    fetch(`/api/whatsapp/brain-advice?chat_id=${encodeURIComponent(chatId)}&cached=1`)
      .then(r => r.ok ? r.json() : null)
      .then((d: any) => {
        if (brainAdviceRequestRef.current !== requestId) return
        const text = String(d?.advice || '').trim()
        if (text && d?.cached) {
          setBrainAdvice(text)
          setBrainAdviceSaved(true)
          setBrainStage(1)
        }
      })
      .catch(() => {})
  }, [chatId])

  const generateDraftFromHint = useCallback(async (hintRaw: string, previousDraftRaw = '') => {
    const hint = hintRaw.trim()
    const previousDraft = previousDraftRaw.trim()
    if (!hint || drafting) return false
    setDrafting(true); setError('')
    try {
      const r = await fetch('/api/whatsapp/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, hint, previous_draft: previousDraft }),
      })
      const d = await r.json()
      if (d.draft) {
        setDraftBlock(d.draft)
        setDraft('')
        return true
      }
      else if (d.error) setError(`Draft: ${d.error}`)
    } catch (e) {
      setError(`Draft: ${String(e)}`)
    } finally {
      setDrafting(false)
    }
    return false
  }, [drafting, chatId])

  const generateDraft = useCallback(async () => {
    await generateDraftFromHint(draft, draftBlockRef.current)
  }, [draft, generateDraftFromHint])

  const sendText = useCallback(async () => {
    const text = draftBlock.trim()
    if (!text || sending) return
    setSending(true); setError('')
    try {
      const r = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      if (!r.ok) throw new Error(await r.text())
      setDraft('')
      setDraftBlock('')
      setBrainStage(0)
      brainAdviceRequestRef.current += 1
      setBrainAdvice('')
      setBrainAdviceSaved(false)
      setBrainAdviceLoading(false)
      window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
      setTimeout(load, 500)
    } catch (e) {
      setError(String(e).slice(0, 100))
    } finally {
      setSending(false)
    }
  }, [draftBlock, sending, chatId, load])

  // Tastatur-Modus: getippter Text geht direkt als WhatsApp-Nachricht raus, kein Draft dazwischen.
  const sendDirect = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true); setError('')
    try {
      const r = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      })
      if (!r.ok) throw new Error(await r.text())
      setDraft('')
      setDraftBlock('')
      setBrainStage(0)
      brainAdviceRequestRef.current += 1
      setBrainAdvice('')
      setBrainAdviceSaved(false)
      setBrainAdviceLoading(false)
      window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
      setTimeout(load, 500)
    } catch (e) {
      setError(String(e).slice(0, 100))
    } finally {
      setSending(false)
    }
  }, [draft, sending, chatId, load])

  // Sprachnachricht-Modus: echte WhatsApp-Voice-Note. Aufnahme im Browser (opus/webm),
  // Versand als rohes Audio an /api/whatsapp/send-voice (Backend transkodiert zu ogg/opus PTT).
  const startVoiceNote = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4')
      const rec = new MediaRecorder(stream, { mimeType })
      voiceChunksRef.current = []
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) voiceChunksRef.current.push(ev.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        if (voiceCancelRef.current) {
          voiceCancelRef.current = false
          voiceChunksRef.current = []
          return
        }
        const blob = new Blob(voiceChunksRef.current, { type: mimeType.split(';')[0] })
        if (!blob.size) return
        setVoiceSending(true); setError('')
        try {
          const buf = await blob.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          const b64 = btoa(bin)
          const r = await fetch('/api/whatsapp/send-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, base64: b64, mime: blob.type || 'audio/webm' }),
          })
          const d = await r.json().catch(() => ({}))
          if (!r.ok || d.error) throw new Error(d.error || (await r.text().catch(() => 'send-voice failed')))
          window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
          setTimeout(load, 800)
        } catch (e) {
          setError(String(e).slice(0, 120))
        } finally {
          setVoiceSending(false)
        }
      }
      voiceCancelRef.current = false
      voiceRecRef.current = rec
      rec.start()
      setVoiceRecording(true)
    } catch {
      setError('Mic-Zugriff verweigert')
    }
  }, [chatId, load])

  const stopVoiceNote = useCallback(() => {
    if (voiceRecRef.current && voiceRecRef.current.state === 'recording') voiceRecRef.current.stop()
    setVoiceRecording(false)
  }, [])

  const cancelVoiceNote = useCallback(() => {
    voiceCancelRef.current = true
    if (voiceRecRef.current && voiceRecRef.current.state === 'recording') voiceRecRef.current.stop()
    setVoiceRecording(false)
  }, [])

  const sendImage = useCallback(async (file: File) => {
    if (sending) return
    setSending(true); setError('')
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      const b64 = btoa(bin)
      const r = await fetch('/api/whatsapp/send-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, base64: b64, mime: file.type || 'image/jpeg', filename: file.name }),
      })
      if (!r.ok) throw new Error(await r.text())
      window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
      setTimeout(load, 800)
    } catch (e) {
      setError(String(e).slice(0, 100))
    } finally {
      setSending(false)
    }
  }, [sending, chatId, load])

  const sendFile = useCallback(async (file: File) => {
    if (sending) return
    if (file.type.startsWith('image/')) { sendImage(file); return }
    setSending(true); setError('')
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      const b64 = btoa(bin)
      const r = await fetch('/api/whatsapp/send-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, base64: b64, mime: file.type || 'application/octet-stream', filename: file.name }),
      })
      if (!r.ok) throw new Error(await r.text())
      window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
      setTimeout(load, 800)
    } catch (e) {
      setError(String(e).slice(0, 100))
    } finally {
      setSending(false)
    }
  }, [sending, chatId, load, sendImage])

  const startVoiceDictation = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      dictateChunksRef.current = []
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) dictateChunksRef.current.push(ev.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        if (dictateCancelRef.current) {
          dictateCancelRef.current = false
          dictateChunksRef.current = []
          return
        }
        const blob = new Blob(dictateChunksRef.current, { type: 'audio/webm' })
        setVoiceTranscribing(true)
        try {
          const fd = new FormData()
          fd.append('file', blob, 'dictation.webm')
          const r = await fetch('/api/transcribe', { method: 'POST', body: fd })
          const d = await r.json()
          if (!r.ok || d.error) throw new Error(d.error || 'transcribe failed')
          let text = (d.text || '').trim()
          if (text) {
            dictateCountRef.current += 1
            if (dictateCountRef.current % 3 === 0) {
              try {
                const pr = await fetch('/api/emoji-polish', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text }),
                })
                const pd = await pr.json()
                if (pr.ok && pd.text) text = pd.text.trim()
              } catch {}
            }
            const previousDraft = draftBlockRef.current.trim()
            const ok = await generateDraftFromHint(text, previousDraft)
            if (!ok) setDraft(prev => prev ? `${prev} ${text}` : text)
          }
        } catch (e) {
          setError(String(e).slice(0, 100))
        } finally {
          setVoiceTranscribing(false)
        }
      }
      dictateCancelRef.current = false
      dictateRecRef.current = rec
      rec.start()
      setVoiceDictating(true)
    } catch {
      setError('Mic-Zugriff verweigert')
    }
  }, [generateDraftFromHint])

  const stopVoiceDictation = useCallback(() => {
    if (dictateRecRef.current && dictateRecRef.current.state === 'recording') {
      dictateRecRef.current.stop()
    }
    setVoiceDictating(false)
  }, [])

  const cancelVoiceDictation = useCallback(() => {
    dictateCancelRef.current = true
    if (dictateRecRef.current && dictateRecRef.current.state === 'recording') {
      dictateRecRef.current.stop()
    }
    setVoiceDictating(false)
  }, [])

  const sendReaction = useCallback(async (msgId: string, emoji: string) => {
    setReactionPickerFor('')
    try {
      await fetch('/api/whatsapp/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_id: msgId, emoji }),
      })
      await fetch('/api/whatsapp/dismiss-triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId }),
      })
      window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
      setTimeout(load, 800)
    } catch {}
  }, [chatId, load])

  const toggleArchive = useCallback(async () => {
    if (!data) return
    const newState = !data.chat.is_archived
    try {
      await fetch('/api/whatsapp/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, archive: newState }),
      })
      setData({ ...data, chat: { ...data.chat, is_archived: newState } })
    } catch {}
  }, [data, chatId])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) sendFile(file)
  }, [sendFile])

  return (
    <div className="wa-chat-view relative flex flex-col h-full"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className={`${mobile ? 'mobile-hero-chrome px-5 pt-[1px] pb-[5px] min-h-[28px] bg-[var(--bg)]' : 'wa-chrome-b px-3 min-h-[var(--header-row-h)]'} flex items-center gap-2 flex-shrink-0`}>
        <button onClick={onBack} className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer">
          <ChevronLeft className="info-icon-sm" />
        </button>
        <button
          onClick={() => !data?.chat?.is_group && setPersonCardOpen(true)}
          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer hover:bg-white/[0.03] rounded px-1 -mx-1 py-0.5 transition-colors disabled:cursor-default disabled:hover:bg-transparent"
          disabled={!!data?.chat?.is_group}
          title={data?.chat?.is_group ? '' : 'Kontaktkarte öffnen'}
        >
          <img
            src={`/api/whatsapp/profile-pic?chat_id=${encodeURIComponent(chatId)}`}
            alt=""
            className="w-5 h-5 rounded-full object-cover flex-shrink-0 bg-[#25d366]/20"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
          <span className={`info-text-body text-[var(--t1)] font-medium truncate`}>
            {data?.chat?.name || '...'}
          </span>
          {data?.chat?.is_group && <span className="info-text-meta text-[var(--t3)] flex-shrink-0">Gruppe</span>}
          {data?.chat?.is_archived && <span className="info-text-meta text-[var(--t3)] flex-shrink-0">archiviert</span>}
          {data?.chat?.pinned_conversation_title && (
            <span
              className="info-text-meta text-[var(--warm)] flex-shrink-0 truncate"
              title={`Gepinnt an Session: ${data.chat.pinned_conversation_title}${data.chat.pinned_conversation_project_name ? ` (${data.chat.pinned_conversation_project_name})` : ''}`}
            >
              → {data.chat.pinned_conversation_title}
            </span>
          )}
        </button>
        <div ref={pinMenuRef} className="relative">
          <button
            onClick={() => setPinMenuOpen(v => !v)}
            className={`cursor-pointer p-0.5 rounded hover:bg-white/5 flex items-center justify-center ${data?.chat?.pinned_conversation_id ? 'text-[var(--warm)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
            title={data?.chat?.pinned_conversation_id ? `Gepinnt an: ${data.chat.pinned_conversation_title}` : 'An Chat-Session pinnen'}
          >
            <FolderOpen className="info-icon-sm" />
          </button>
          {pinMenuOpen && (
            <div className="absolute top-full right-0 mt-1 z-[70] bg-[var(--bg-2)] border border-[var(--border-f)] py-1 min-w-[260px] max-h-[360px] overflow-y-auto shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
              <div className="px-2 pt-1 pb-1 sticky top-0 bg-[var(--bg-2)]">
                <input
                  autoFocus
                  value={pinFilter}
                  onChange={e => setPinFilter(e.target.value)}
                  placeholder="Session suchen…"
                  className="w-full px-2 py-1 text-[14px] bg-[var(--bg-0)] border border-[var(--border)]/60 rounded text-[var(--t1)] outline-none focus:border-[var(--t3)]"
                />
              </div>
              {data?.chat?.pinned_conversation_id && (
                <>
                  <button
                    onClick={() => setPinnedConversation('')}
                    className="w-full text-left px-3 py-1.5 text-[14px] text-[var(--t3)] hover:bg-white/[0.06] hover:text-[var(--t1)] cursor-pointer"
                  >
                    Pin entfernen
                  </button>
                  <div className="h-px bg-[var(--border)] my-0.5" />
                </>
              )}
              {(() => {
                const q = pinFilter.trim().toLowerCase()
                const list = q
                  ? conversations.filter(c =>
                      c.title.toLowerCase().includes(q) ||
                      c.project_name.toLowerCase().includes(q))
                  : conversations
                if (list.length === 0) {
                  return <div className="px-3 py-1.5 text-[14px] text-[var(--t3)]/60">Keine Sessions</div>
                }
                return list.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setPinnedConversation(c.id)}
                    className={`w-full text-left px-3 py-1.5 text-[14px] hover:bg-white/[0.06] cursor-pointer ${
                      data?.chat?.pinned_conversation_id === c.id ? 'text-[var(--warm)] bg-white/[0.04]' : 'text-[var(--t2)] hover:text-[var(--t1)]'
                    }`}
                  >
                    <div className="truncate">{c.title}</div>
                    {c.project_name && (
                      <div className="text-[13px] text-[var(--t3)] truncate">{c.project_name}</div>
                    )}
                  </button>
                ))
              })()}
            </div>
          )}
        </div>
        <button
          onClick={toggleArchive}
          className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer p-0.5 rounded hover:bg-white/5 flex items-center justify-center"
          title={data?.chat?.is_archived ? 'Entarchivieren' : 'Archivieren'}
        >
          {data?.chat?.is_archived
            ? <ArchiveRestore className="info-icon-sm" />
            : <Archive className="info-icon-sm" />}
        </button>
      </div>

      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        className={`wa-message-list flex-1 overflow-y-auto ${mobile ? 'px-4 py-3' : 'px-3 py-2'} relative ${dragOver ? 'bg-[#25d366]/5' : ''}`}
      >
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="border-2 border-dashed border-[#25d366] rounded-lg px-4 py-2 info-text-body text-[#25d366] bg-[var(--bg-1)]/90">
              Datei hier ablegen
            </div>
          </div>
        )}
        {loading && !data && <div className="info-text-body text-[var(--t3)] text-center py-4">Lade...</div>}
        {!loading && data?.messages?.length === 0 && (
          <div className="info-text-body text-[var(--t3)] text-center py-4">Keine Nachrichten.</div>
        )}
        {data?.messages?.map((m, i) => {
          const prev = i > 0 ? data.messages[i - 1] : null
          const prevDay = prev ? new Date(prev.ts * 1000).toDateString() : null
          const curDay = new Date(m.ts * 1000).toDateString()
          const isNewDay = prevDay !== curDay
          const GROUP_S = 120
          const groupSenderKey = (msg: WaMessage | null) => {
            if (!msg) return ''
            if (msg.from_me) return 'me'
            if (!data?.chat?.is_group) return 'them'
            return msg.sender_jid || msg.sender_name || 'group'
          }
          const isFirstInGroup = !prev || prev.from_me !== m.from_me || groupSenderKey(prev) !== groupSenderKey(m) || (m.ts - prev.ts) > GROUP_S || isNewDay
          const nextMsg = i < (data.messages.length - 1) ? data.messages[i + 1] : null
          const nextDay = nextMsg ? new Date(nextMsg.ts * 1000).toDateString() : null
          const isLastInGroup = !nextMsg || nextMsg.from_me !== m.from_me || groupSenderKey(nextMsg) !== groupSenderKey(m) || (nextMsg.ts - m.ts) > GROUP_S || nextDay !== curDay
          const showTime = !isNewDay && prev && (m.ts - prev.ts) > 3600
          const showSender = !!data?.chat?.is_group && !m.from_me && isFirstInGroup
          const senderLabel = (m.sender_name || m.sender_jid || '').replace(/@.+$/, '')
          const isVoice = m.type === 'ptt' || m.type === 'audio'
          const isImage = m.type === 'image' || m.type === 'sticker'
          const isDocument = m.type === 'document'
          const isGif = !!m.is_gif
          const isVideo = m.type === 'video' && !isGif
          const isDownloadable = isDocument && m.has_media
          const rawContent = m.transcript || m.body || ''
          const sharedContacts = (m.type === 'vcard' || m.type === 'multi_vcard' || /^begin:vcard/i.test(rawContent.trimStart()))
            ? parseSharedVCards(rawContent) : []
          const isContactCard = sharedContacts.length > 0
          const bodyLooksLikeBase64 = isImage && rawContent.length > 200 && /^[A-Za-z0-9+/=]+$/.test(rawContent)
          const inlineB64 = bodyLooksLikeBase64 ? rawContent : (m.thumbnail_b64 || '')
          const thumbDataUrl = inlineB64 ? `data:image/jpeg;base64,${inlineB64}` : ''
          const mediaUrl = `/api/whatsapp/media?msg_id=${encodeURIComponent(m.id)}`
          const downloadUrl = `${mediaUrl}&download=1`
          const autoLoadMedia = (isImage || isGif) && m.has_media && !failedMedia.has(m.id)
            && ((Date.now() / 1000 - m.ts) < 72 * 3600 || i >= data.messages.length - 20)
          const mediaLoaded = m.has_media_file || loadedMedia.has(m.id) || autoLoadMedia
          const imgSrc = mediaLoaded && m.has_media ? mediaUrl : thumbDataUrl
          const showImagePlaceholder = isImage && m.has_media && !mediaLoaded
          const showVideoPlaceholder = (isVideo || isGif) && m.has_media && !mediaLoaded
          const docName = m.filename || (isDocument && m.body && !m.body.includes(' ') && /\.[a-z0-9]{2,5}$/i.test(m.body) ? m.body : null) || 'Datei'
          const docCaption = isDocument && m.body && m.body !== docName ? m.body : ''
          const docSubtitle = m.media_mime || 'document'
          const content = bodyLooksLikeBase64 || isContactCard ? '' : (isDocument ? docCaption : rawContent)
          const voiceReadable = isVoice ? (m.summary || '').trim() : ''
          const contactCopyText = sharedContacts.map(c => [c.name, ...c.phones.map(ph => ph.number)].filter(Boolean).join(' ')).join('\n')
          const displayContent = isContactCard ? contactCopyText : (voiceReadable || content)
          const readableParagraphs = displayContent ? readableWaParagraphs(displayContent) : []
          const useReadableContent = !!displayContent && readableParagraphs.length > 0 && (isVoice || displayContent.length >= 260 || readableParagraphs.length > 1)
          const placeholder = !content && m.has_media && !isImage && !isDownloadable && !isVideo && !isGif ? (
            isVoice ? '[Sprachnachricht]' :
            `[${m.type}]`
          ) : ''
          const bubbleBg = m.from_me ? 'var(--hover)' : 'var(--bg-2)'
          const radiusClass = m.from_me
            ? (isLastInGroup ? 'rounded-2xl rounded-br-sm' : 'rounded-2xl')
            : (isLastInGroup ? 'rounded-2xl rounded-bl-sm' : 'rounded-2xl')
          const wrapperMt = isFirstInGroup ? (isNewDay ? '' : 'mt-3') : 'mt-0.5'
          const hasReactions = !!(m.reactions && m.reactions.length > 0)
          const metaMt = hasReactions ? (mobile ? 'mt-4' : 'mt-3.5') : (mobile ? 'mt-1.5' : 'mt-1')
          return (
            <Fragment key={m.id}>
              {isNewDay && (
                <div className="flex justify-center my-3">
                  <div className="px-3 py-1 rounded-full bg-black/40 text-[var(--t2)] info-text-meta">
                    {formatWaDay(m.ts)}
                  </div>
                </div>
              )}
              <div className={`group ${wrapperMt}`}>
                {showTime && (
                  <div className="info-text-meta text-[var(--t3)] text-center py-1">{formatWaTime(m.ts)}</div>
                )}
                <div className={`flex ${m.from_me ? 'justify-end' : 'justify-start'} items-end`}>
                <div
                  className={`wa-message-bubble ${isVoice ? 'wa-voice-bubble' : ''} ${useReadableContent && !isVoice ? 'wa-readable-bubble' : ''} ${isImage && imgSrc ? 'wa-media-bubble p-0.5' : ''} relative w-fit max-w-[75%] ${radiusClass} ${isImage && imgSrc ? '' : 'px-3 py-2'} info-text-body leading-snug whitespace-pre-wrap break-words text-[var(--t1)] ${mobile ? 'select-none' : ''}`}
                  style={{ background: bubbleBg }}
                  onTouchStart={mobile ? () => startLongPress(m.id) : undefined}
                  onTouchEnd={mobile ? cancelLongPress : undefined}
                  onTouchMove={mobile ? cancelLongPress : undefined}
                  onTouchCancel={mobile ? cancelLongPress : undefined}
                  onContextMenu={mobile ? (e) => { e.preventDefault() } : undefined}
                >
                  {showSender && senderLabel && (
                    <div className="mb-1 info-text-meta text-[var(--cc-orange)] font-medium truncate">
                      {senderLabel}
                    </div>
                  )}
                  {isImage && showImagePlaceholder && (
                    <button
                      onClick={() => setLoadedMedia(prev => { const next = new Set(prev); next.add(m.id); return next })}
                      className="inline-flex items-center gap-2 py-1 pl-1 pr-3 rounded-full hover:bg-white/[0.06] transition-colors focus:outline-none"
                      title="Foto laden"
                    >
                      {thumbDataUrl ? (
                        <img src={thumbDataUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                          <ImageIcon className="info-icon-sm text-[var(--t2)]" />
                        </div>
                      )}
                      <span className="info-text-body text-[var(--t1)] whitespace-nowrap">Foto laden</span>
                      <Download className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                    </button>
                  )}
                  {isImage && !showImagePlaceholder && imgSrc && (
                    <button
                      onClick={() => setImageViewer(imgSrc)}
                      className="block cursor-zoom-in focus:outline-none"
                      title="Vollbild"
                    >
                      <img
                        src={imgSrc}
                        alt=""
                        loading="lazy"
                        onError={() => { if (mediaLoaded) setFailedMedia(prev => { const next = new Set(prev); next.add(m.id); return next }) }}
                        className="rounded max-w-[280px] max-h-[280px] object-cover hover:opacity-95 transition-opacity"
                      />
                    </button>
                  )}
                  {isDownloadable && (
                    <a
                      href={downloadUrl}
                      download={docName}
                      className="flex items-center gap-2 py-1 px-1 -mx-0.5 rounded hover:bg-white/[0.05] transition-colors group/dl"
                      title={`Download: ${docName}`}
                    >
                      <div className="flex-shrink-0 w-8 h-8 rounded bg-white/[0.08] flex items-center justify-center">
                        <FileText className="info-icon-md text-[var(--t2)]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`info-text-body text-[var(--t1)] truncate`}>{docName}</div>
                        <div className="info-text-meta text-[var(--t3)] truncate">{docSubtitle}</div>
                      </div>
                      <Download className="info-icon-md text-[var(--t3)] group-hover/dl:text-[var(--t1)] flex-shrink-0" />
                    </a>
                  )}
                  {showVideoPlaceholder && (
                    <button
                      onClick={() => setLoadedMedia(prev => { const next = new Set(prev); next.add(m.id); return next })}
                      className="inline-flex items-center gap-2 py-1 pl-1 pr-3 rounded-full hover:bg-white/[0.06] transition-colors focus:outline-none mb-1"
                      title={isGif ? 'GIF laden' : 'Video laden'}
                    >
                      {thumbDataUrl ? (
                        <img src={thumbDataUrl} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                          {isGif ? <Film className="info-icon-sm text-[var(--t2)]" /> : <Video className="info-icon-sm text-[var(--t2)]" />}
                        </div>
                      )}
                      <span className="info-text-body text-[var(--t1)] whitespace-nowrap">{isGif ? 'GIF laden' : 'Video laden'}</span>
                      <Download className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                    </button>
                  )}
                  {isGif && mediaLoaded && m.has_media && (
                    <video
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="metadata"
                      onError={() => setFailedMedia(prev => { const next = new Set(prev); next.add(m.id); return next })}
                      src={mediaUrl}
                      className="block rounded max-w-[280px] max-h-[360px] mb-1"
                    />
                  )}
                  {isVideo && mediaLoaded && m.has_media && (
                    <video
                      controls
                      preload="metadata"
                      src={mediaUrl}
                      className="block rounded max-w-[280px] max-h-[360px] mb-1"
                    />
                  )}
                  {isVoice && (
                    <div className="wa-voice-card">
                      {m.has_media ? (
                        <VoiceMessagePlayer src={mediaUrl} />
                      ) : (
                        <div className="wa-voice-missing">Sprachnachricht</div>
                      )}
                      {displayContent && (
                        <div className="wa-voice-transcript">
                          {useReadableContent ? renderReadableWaText(displayContent) : linkifyText(displayContent)}
                        </div>
                      )}
                    </div>
                  )}
                  {m.quoted && (
                    <div className={`mb-1 pl-2 info-text-meta leading-snug ${isImage && imgSrc ? 'mx-2 mt-2' : ''}`}>
                      <div className="info-text-meta text-[var(--t2)] font-medium">
                        {m.quoted.from_me ? 'Du' : (data?.chat?.is_group ? (m.quoted.sender_name || m.quoted.sender_jid || 'Antwort').replace(/@.+$/, '') : 'Antwort')}
                      </div>
                      <div className="text-[var(--t3)] truncate">{renderInlinePreview(m.quoted.preview)}</div>
                    </div>
                  )}
                  {isContactCard && (
                    <div className="flex flex-col gap-2.5 py-1 min-w-[220px] max-w-full">
                      {sharedContacts.map((c, ci) => (
                        <div key={ci} className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-9 h-9 rounded-full bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                              <User className="info-icon-md text-[var(--t1)]" />
                            </div>
                            <div className="min-w-0">
                              <div className="info-text-body font-semibold text-[var(--t1)] break-words">{c.name || 'Kontakt'}</div>
                              {c.org && <div className="info-text-meta text-[var(--t2)] break-words">{c.org}</div>}
                            </div>
                          </div>
                          {c.phones.map((ph, pi) => {
                            const copyKey = `${m.id}|vc${ci}-${pi}`
                            return (
                              <button
                                key={pi}
                                onClick={() => copyMessage(copyKey, ph.number)}
                                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] transition-colors text-left w-full"
                                title="Nummer kopieren"
                              >
                                <Phone className="info-icon-sm text-[var(--t2)] flex-shrink-0" />
                                <span className="info-text-body text-[var(--t1)] flex-1 min-w-0 break-words">{ph.number}</span>
                                {telLabel(ph.label) && <span className="info-text-meta text-[var(--t2)] flex-shrink-0">{telLabel(ph.label)}</span>}
                                {copiedFor === copyKey
                                  ? <Check className="info-icon-sm text-[var(--cc-green,var(--t1))] flex-shrink-0" />
                                  : <Copy className="info-icon-sm text-[var(--t3)] flex-shrink-0" />}
                              </button>
                            )
                          })}
                          {c.emails.map((em, ei) => (
                            <div key={`e${ei}`} className="info-text-meta text-[var(--t2)] break-words px-0.5">{em}</div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {content && !isVoice && (() => {
                    const withImage = isImage && !!imgSrc
                    return (
                      <div className={withImage ? 'px-2 py-1 w-0 min-w-full break-words' : ''}>
                        {useReadableContent ? renderReadableWaText(displayContent) : linkifyText(content)}
                      </div>
                    )
                  })()}
                  {!content && !isImage && placeholder && <span className="text-[var(--t3)] italic">{placeholder}</span>}
                  {hasReactions && (
                    <div className={`absolute -bottom-3 ${m.from_me ? 'right-2' : 'left-2'} flex gap-0.5 text-[20px] leading-none`}>
                      {m.reactions!.map(r => <span key={r.sender_jid + r.emoji}>{r.emoji}</span>)}
                    </div>
                  )}
                </div>
              </div>
              <div className={`flex ${m.from_me ? 'justify-end' : 'justify-start'} items-center ${mobile ? `gap-3 ${metaMt}` : `gap-2.5 ${metaMt} opacity-0 group-hover:opacity-100 transition-opacity`} px-0.5`}>
                <span className="info-text-meta text-[var(--t3)]/65 select-none">{formatWaTime(m.ts)}</span>
                <button
                  onClick={() => setReactionPickerFor(reactionPickerFor === m.id ? '' : m.id)}
                  className="p-1 rounded-md text-[var(--t3)] hover:text-[var(--t1)] hover:bg-[var(--hover)] transition-colors"
                  title="Reagieren"
                ><Smile className={mobile ? 'info-icon-md' : 'info-icon-sm'} /></button>
                {displayContent && (
                  <button
                    onClick={() => copyMessage(m.id, displayContent)}
                    className={`p-1 rounded-md hover:bg-[var(--hover)] transition-colors ${copiedFor === m.id ? 'text-[var(--cc-green,var(--t1))]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
                    title={copiedFor === m.id ? 'Kopiert' : 'Kopieren'}
                  >{copiedFor === m.id ? <Check className={mobile ? 'info-icon-md' : 'info-icon-sm'} /> : <Copy className={mobile ? 'info-icon-md' : 'info-icon-sm'} />}</button>
                )}
                {displayContent && (
                  <button
                    onClick={() => speakMessage(m.id, displayContent)}
                    className={`p-1 rounded-md hover:bg-[var(--hover)] transition-colors ${speakingFor === m.id ? 'text-[var(--cc-orange,var(--t1))]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
                    title={speakingFor === m.id ? 'Stopp' : 'Vorlesen'}
                  ><Volume2 className={mobile ? 'info-icon-md' : 'info-icon-sm'} /></button>
                )}
              </div>
              {reactionPickerFor === m.id && (
                <div className={`flex ${m.from_me ? 'justify-end' : 'justify-start'} mt-1.5`}>
                  <div className="flex items-center gap-1.5 bg-[var(--bg-1)] border border-[var(--border)] rounded-full px-2.5 py-1.5">
                    {REACTION_EMOJIS.map(e => (
                      <button key={e} onClick={() => sendReaction(m.id, e)} className="text-[24px] leading-none hover:scale-125 transition-transform">{e}</button>
                    ))}
                    <button onClick={() => sendReaction(m.id, '')} className="text-[var(--t3)] hover:text-[var(--t1)] p-1 flex items-center justify-center" title="Reaktion entfernen"><X className="info-icon-sm" /></button>
                  </div>
                </div>
              )}
              </div>
            </Fragment>
          )
        })}
        {brainAdviceLoading && (
          <div className="flex justify-start mt-2">
            <div className="max-w-[75%] rounded-2xl bg-[var(--bg-2)] text-[var(--t2)] px-3 py-2 info-text-body">
              <span className="quiet-presence-shimmer">{agentName} sortiert…</span>
            </div>
          </div>
        )}
        {brainAdvice && !brainAdviceLoading && (
          <div className="flex justify-start mt-2">
            <div className="max-w-[75%] rounded-2xl bg-[var(--bg-2)] border border-[rgba(217,119,87,0.32)] text-[var(--t1)] px-3 py-2 info-text-body break-words leading-snug">
              <div className="text-[13px] font-semibold text-[#d97757] mb-1">{agentName}{brainAdviceSaved ? ' · gespeichert' : ''}</div>
              {renderVoiceSummary(brainAdvice)}
            </div>
          </div>
        )}
        {!atBottom && (
          <div className="sticky bottom-1 flex justify-end pointer-events-none pr-1">
            <button
              type="button"
              onClick={() => { scrollToBottom(true); setAtBottom(true) }}
              className="pointer-events-auto rounded-full bg-[var(--bg-1)]/90 border border-[var(--border)] text-[var(--t2)] hover:text-[var(--t1)] hover:bg-[var(--bg-1)] shadow-md backdrop-blur p-2 flex items-center justify-center"
              title="Nach unten springen"
              aria-label="Nach unten springen"
            >
              <ArrowDown className="info-icon-sm" />
            </button>
          </div>
        )}
      </div>

      <div className={`wa-chrome-t wa-chrome-b bg-[var(--bg)] ${mobile ? 'px-5 py-2.5' : 'px-3 py-2'} flex-shrink-0`}>
        {error && <div className="info-text-meta text-red-400 mb-1.5 truncate">{error}</div>}
        {draftBlock && (
          <div className="mb-2 rounded-xl border border-[rgba(217,119,87,0.4)] bg-[color-mix(in_srgb,#d97757_8%,transparent)] px-3 py-2">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[13px] font-semibold text-[#d97757]">Entwurf</span>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => { setDraftBlock(''); composerRef.current?.focus() }}
                  disabled={sending}
                  className="rounded-full w-7 h-7 flex items-center justify-center text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/5 disabled:opacity-50 cursor-pointer"
                  title="Entwurf verwerfen"
                  aria-label="Entwurf verwerfen"
                ><X className="info-icon-sm" /></button>
                <button
                  onClick={sendText}
                  disabled={sending}
                  className="rounded-full w-7 h-7 flex items-center justify-center bg-[#d97757] text-white hover:bg-[#c56647] disabled:opacity-50 cursor-pointer"
                  title="Senden (Cmd+Enter)"
                  aria-label="Senden"
                >{sending ? <Loader2 className="info-icon-sm animate-spin" /> : <Check className="info-icon-sm" strokeWidth={2.75} />}</button>
              </div>
            </div>
            <div className="info-text-body text-[var(--t1)] whitespace-pre-wrap break-words leading-snug">{draftBlock}</div>
          </div>
        )}
        <div className="flex items-end gap-1.5">
          {!mobile && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              className="rounded-full w-8 h-8 flex items-center justify-center cursor-pointer disabled:opacity-50 flex-shrink-0 transition-colors text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/5"
              title="Bild oder Datei anhängen"
              aria-label="Datei anhängen"
            ><Plus className="info-icon-md" /></button>
          )}
          <div className={`flex-1 min-w-0 relative ${mobile ? '' : 'rounded-2xl bg-white/5 pl-3 pr-9'}`}>
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  // Offener Entwurf: Cmd+Enter sendet ihn; steht eine Korrektur im
                  // Feld, wird erst der Entwurf neu gebaut, nie roh gesendet.
                  if (draftBlock.trim()) { if (draft.trim()) generateDraft(); else sendText() }
                  else if (!mobile) sendDirect()
                  else generateDraft()
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (draftBlock.trim()) { if (draft.trim()) generateDraft() }
                  else if (!mobile) sendDirect()
                  else generateDraft()
                }
              }}
              placeholder={(() => {
                if (!mobile && voiceRecording) return 'Aufnahme läuft…'
                if (draftBlock) return `Korrektur sagen, ${agentName} baut neu`
                return 'Nachricht'
              })()}
              disabled={sending || (!mobile && voiceRecording)}
              rows={1}
              className="block w-full bg-transparent border-none px-0 info-text-body text-[var(--t1)] placeholder:text-[var(--t3)]/60 outline-none resize-none disabled:opacity-50"
              style={{ minHeight: mobile ? '40px' : '36px', maxHeight: '200px', padding: '7px 0', lineHeight: mobile ? '26px' : '22px' }}
            />
            {!mobile && (
              <button
                onClick={generateDraft}
                disabled={sending || drafting || voiceRecording || !draft.trim()}
                className="absolute right-1 bottom-1 rounded-full w-6 h-6 flex items-center justify-center cursor-pointer transition-colors text-[var(--t3)] hover:text-[#d97757] disabled:opacity-30 disabled:cursor-default"
                title={draftBlock ? 'Entwurf anpassen lassen' : `${agentName} baut den Text als Entwurf`}
                aria-label={draftBlock ? 'Entwurf anpassen' : 'Entwurf bauen'}
              >{drafting ? <Loader2 className="info-icon-sm animate-spin" /> : <Wand2 className="info-icon-sm" />}</button>
            )}
          </div>
          {mobile && voiceDictating && (
            <button
              onClick={cancelVoiceDictation}
              className="rounded-full w-9 h-9 flex items-center justify-center cursor-pointer flex-shrink-0 text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/5"
              title="Diktat verwerfen"
              aria-label="Diktat verwerfen"
            ><X className="info-icon-md" /></button>
          )}
          <button
            onClick={() => {
              if (mobile) {
                if (voiceDictating) stopVoiceDictation()
                else if (!voiceTranscribing) startVoiceDictation()
              } else {
                // Dreiklang: aus -> nur das Neue (light) -> ganzer Faden (full) -> aus.
                const next = ((brainStage + 1) % 3) as 0 | 1 | 2
                setBrainStage(next)
                if (next === 0) {
                  brainAdviceRequestRef.current += 1
                  setBrainAdvice(''); setBrainAdviceSaved(false); setBrainAdviceLoading(false)
                } else {
                  loadBrainAdvice(next === 1 ? 'light' : 'full')
                }
              }
            }}
            disabled={sending || voiceTranscribing || brainAdviceLoading}
            className={`rounded-full ${mobile ? 'w-9 h-9' : 'w-8 h-8'} flex items-center justify-center disabled:opacity-50 cursor-pointer flex-shrink-0 transition-colors ${
              mobile
                ? (voiceDictating ? 'bg-[var(--warm)]/15 text-[var(--warm)] animate-pulse' : 'text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/5')
                : (brainStage === 2
                    ? 'bg-[var(--warm)]/15 text-[var(--warm)]'
                    : brainStage === 1
                      ? 'bg-white/5 text-[var(--t1)]'
                      : 'text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/5')
            }`}
            title={mobile
              ? (voiceDictating ? `Diktat beenden (${dictateElapsed})` : 'Diktat starten (Whisper)')
              : (brainStage === 0 ? 'Brain: aus — tippen für das Neue'
                : brainStage === 1 ? 'Brain: nur das Neue — tippen für den ganzen Faden'
                : 'Brain: ganzer Faden — tippen zum Schließen')}
            aria-label={mobile ? 'Sprach-Diktat' : 'Brain-Lagebild'}
            aria-pressed={mobile ? voiceDictating : brainStage > 0}
          >{(voiceTranscribing || brainAdviceLoading)
              ? <Loader2 className="info-icon-md animate-spin" />
              : (mobile && voiceDictating
                  ? <span className="text-[13px] font-semibold tabular-nums leading-none">{dictateElapsed}</span>
                  : <Brain className="info-icon-md" />)}</button>
          {!mobile ? (
            voiceRecording ? (
              <>
                <button
                  onClick={cancelVoiceNote}
                  className="rounded-full w-8 h-8 flex items-center justify-center cursor-pointer flex-shrink-0 text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/5"
                  title="Aufnahme verwerfen"
                  aria-label="Aufnahme verwerfen"
                ><X className="info-icon-md" /></button>
                <button
                  onClick={stopVoiceNote}
                  className="rounded-full h-8 min-w-8 px-2.5 flex items-center justify-center gap-1.5 cursor-pointer flex-shrink-0 bg-[#d97757] text-white hover:bg-[#c56647]"
                  title="Sprachnachricht senden"
                  aria-label="Sprachnachricht senden"
                ><span className="text-[12px] font-semibold tabular-nums leading-none">{Math.floor(voiceElapsed / 60)}:{String(voiceElapsed % 60).padStart(2, '0')}</span><Send className="info-icon-sm" /></button>
              </>
            ) : (
              <button
                onClick={startVoiceNote}
                disabled={sending || voiceSending}
                className="rounded-full w-8 h-8 flex items-center justify-center cursor-pointer disabled:opacity-50 flex-shrink-0 transition-colors text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/5"
                title="Sprachnachricht aufnehmen"
                aria-label="Sprachnachricht aufnehmen"
              >{voiceSending ? <Loader2 className="info-icon-md animate-spin" /> : <Mic className="info-icon-md" />}</button>
            )
          ) : draft.trim() ? (
            <button
              onClick={generateDraft}
              disabled={sending || drafting}
              className="text-[var(--t2)] hover:text-[var(--t1)] rounded-full w-9 h-9 flex items-center justify-center disabled:opacity-50 cursor-pointer flex-shrink-0 hover:bg-white/5"
              title={draftBlock ? 'Entwurf anpassen (Enter)' : 'Entwurf bauen (Enter)'}
              aria-label={draftBlock ? 'Entwurf anpassen' : 'Entwurf bauen'}
            >{drafting ? <Loader2 className="info-icon-md animate-spin" /> : <Wand2 className="info-icon-md" />}</button>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              className="rounded-full w-9 h-9 flex items-center justify-center cursor-pointer disabled:opacity-50 flex-shrink-0 transition-colors text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/5"
              title="Bild oder Datei anhängen"
              aria-label="Datei anhängen"
            >{sending ? <Loader2 className="info-icon-md animate-spin" /> : <Plus className="info-icon-md" />}</button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) sendFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {personCardOpen && data?.chat && !data.chat.is_group && (
        <PersonCard chatId={chatId} chatName={data.chat.name} onClose={() => setPersonCardOpen(false)} />
      )}

      {imageViewer && (
        <div className="absolute inset-0 z-[60] bg-black/90 flex items-center justify-center p-4" onClick={() => setImageViewer('')}>
          <button onClick={() => setImageViewer('')}
            className="absolute top-4 right-4 text-white/70 hover:text-white cursor-pointer p-2"
            title="Schließen"><X className="info-icon-lg" /></button>
          <img src={imageViewer} alt="" className="max-w-full max-h-full object-contain" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
