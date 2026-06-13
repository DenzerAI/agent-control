import { useState, useEffect, useRef, useCallback, type MouseEvent, type ReactNode, type TouchEvent } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown, Archive, Inbox, Mail, Loader2, Check, CheckCheck, Download, FileText, Image as ImageIcon, Plus, Search, Smile, Volume2, Square, Eye, Play, Pause } from 'lucide-react'
import { linkifyText } from './components/info-pane/utils/linkify'
import { useMainAgentName } from './agents'
import { MailThreadView } from './components/info-pane/sections/MailThreadView'
import { WhatsAppGlyph } from './components/WhatsAppGlyph'
import * as audioQueue from './audioQueue'
import { cleanForTTS } from './ttsClean'
import { renderInlinePreview } from './lib/inlinePreview'

interface WaChat {
  id: string
  name: string
  is_group: boolean
  last_ts: number
  unread: number
  preview: string
  last_from_me: boolean
  is_archived?: boolean
  triage?: string | null
  profile_pic_path?: string | null
}

interface WaMessage {
  id: string
  ts: number
  from_me: boolean
  type: string
  body: string | null
  transcript: string | null
  sender_name?: string | null
  ack?: number
  has_media?: boolean
  has_media_file?: boolean
  is_gif?: boolean
  media_mime?: string | null
  thumbnail_b64?: string | null
  summary?: string | null
  reactions?: WaReaction[]
  context?: {
    kind: 'story_reply' | string
    label: string
    preview?: string | null
  } | null
}

const MOBILE_VOICE_WAVE_BARS = [7, 11, 16, 20, 18, 13, 17, 23, 26, 21, 15, 18, 24, 20, 14, 17, 22, 19, 13, 16, 20, 15, 10, 13, 17, 12]

function formatMobileAudioTime(t: number): string {
  if (!isFinite(t) || t <= 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function MobileVoicePlayer({ src }: { src: string }) {
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

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current
    if (!a || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    a.currentTime = Math.max(0, Math.min(duration, x * duration))
    setCurrent(a.currentTime)
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0
  const activeBar = duration > 0 ? Math.floor((pct / 100) * (MOBILE_VOICE_WAVE_BARS.length - 1)) : -1
  const elapsedLabel = formatMobileAudioTime(current)
  const durationLabel = formatMobileAudioTime(duration)

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      width: '100%',
      minWidth: 0,
      padding: '9px 10px',
      borderRadius: 14,
      border: '1px solid color-mix(in srgb, var(--t1) 12%, transparent)',
      background: 'rgba(0,0,0,0.14)',
    }}>
      <audio ref={audioRef} src={src} preload="metadata" style={{ display: 'none' }} />
      <button type="button" onClick={toggle} style={{
        width: 38,
        height: 38,
        flex: '0 0 38px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        color: '#fff',
        background: 'var(--cc-orange)',
      }}>
        {playing ? <Pause size={17} /> : <Play size={17} style={{ marginLeft: 1 }} />}
      </button>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div onClick={seek} style={{ display: 'flex', alignItems: 'center', gap: 3, height: 30, overflow: 'hidden' }}>
          {MOBILE_VOICE_WAVE_BARS.map((h, i) => (
            <span key={`${h}-${i}`} style={{
              height: h,
              flex: '1 1 3px',
              maxWidth: 4,
              borderRadius: 999,
              background: i <= activeBar ? 'var(--cc-orange)' : 'var(--t2)',
              opacity: i <= activeBar ? 1 : 0.42,
            }} />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, minWidth: 0 }}>
          <span style={{ minWidth: 0, flex: 1, color: 'var(--t3)', fontSize: 12, lineHeight: 1, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {playing || current > 0 ? `${elapsedLabel} / ${durationLabel}` : durationLabel}
          </span>
          <button type="button" onClick={cycleRate} style={{
            flex: '0 0 auto',
            minWidth: 36,
            padding: '4px 8px',
            borderRadius: 999,
            color: 'var(--t2)',
            background: 'rgba(0,0,0,0.24)',
            fontSize: 12,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {rate === 1 ? '1×' : rate === 1.5 ? '1.5×' : '2×'}
          </button>
        </div>
      </div>
    </div>
  )
}

function splitMobileReadableParagraph(paragraph: string): string[] {
  const out: string[] = []
  let rest = paragraph.trim()
  while (rest.length > 520) {
    const start = 230
    const end = Math.min(rest.length, 470)
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

function mobileReadableParagraphs(text: string): string[] {
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
  if (existing.length > 1) return existing.flatMap(splitMobileReadableParagraph)

  const sentences = normalized.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g) || [normalized]
  const paragraphs: string[] = []
  let current = ''
  const startsNewThought = /^(?:Aber|Also|Bisher|Dann|Deswegen|Für|Gerade|Ob|Oder|Vielleicht|Wenn|Wir|Die Mitarbeiter|Das wäre|Das ist|So,)\b/

  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    const shouldBreak = current && (
      current.length + sentence.length > 470 ||
      (current.length > 200 && startsNewThought.test(sentence))
    )
    if (shouldBreak) {
      paragraphs.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) paragraphs.push(current)
  return paragraphs.flatMap(splitMobileReadableParagraph)
}

function renderMobileReadableInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*)/g)
  return parts.flatMap((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return [<strong key={`b-${i}`} style={{ fontWeight: 700, color: 'var(--text)' }}>{part.slice(2, -2)}</strong>]
    }
    return linkifyText(part).map((node, j) => <span key={`t-${i}-${j}`}>{node}</span>)
  })
}

function MobileReadableText({ text }: { text: string }) {
  const paragraphs = mobileReadableParagraphs(text)
  if (!paragraphs.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.82em', whiteSpace: 'normal' }}>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ margin: 0 }}>{renderMobileReadableInline(p)}</p>
      ))}
    </div>
  )
}

interface WaReaction {
  sender_jid: string
  emoji: string
  ts: number
}

interface ChatListResponse { chats: WaChat[] }
interface ThreadResponse {
  chat: { id: string; name: string; is_group: boolean; unread_count: number }
  messages: WaMessage[]
  has_more: boolean
}

interface MailInboxItem {
  uid: string
  account?: string
  from: string
  subject: string
  snippet: string
  ts: number
  unread: boolean
  replied?: boolean
  inbox_context?: {
    person_name?: string
    company?: string
    active_customer?: boolean
    projects?: Array<{ id: number; slug: string; name: string }>
  }
}

const MAIL_ARCHIVED_LOCAL_KEY = 'mail:archived-uids'

function mailItemKey(account: string | undefined, uid: string | undefined): string {
  return `${account || ''}:${uid || ''}`
}

function readArchivedMailKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MAIL_ARCHIVED_LOCAL_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

function rememberArchivedMail(account: string | undefined, uid: string | undefined) {
  const key = mailItemKey(account, uid)
  if (!key.endsWith(':') && !key.startsWith(':')) {
    const keys = readArchivedMailKeys()
    keys.add(key)
    try { localStorage.setItem(MAIL_ARCHIVED_LOCAL_KEY, JSON.stringify([...keys].slice(-1000))) } catch {}
  }
}

function mergeMailInboxItems(_prev: MailInboxItem[], next: MailInboxItem[], doneKeys: string[] = []): MailInboxItem[] {
  const archived = readArchivedMailKeys()
  const done = new Set(doneKeys)
  const byKey = new Map<string, MailInboxItem>()
  for (const item of next) {
    const key = mailItemKey(item.account, item.uid)
    if (key && !archived.has(key) && !done.has(key)) byKey.set(key, item)
  }
  return [...byKey.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

type MobileInboxItem = WaChat | {
  id: string
  source: 'mail'
  account: string
  uid: string
  name: string
  is_group: false
  last_ts: number
  unread: number
  preview: string
  last_from_me: false
  is_archived: false
  triage: string
}

function hhmm(ts: number): string {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function isToday(ts: number): boolean {
  return dayKey(ts) === dayKey(Date.now() / 1000)
}

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const key = dayKey(ts)
  if (key === dayKey(today.getTime() / 1000)) return 'Heute'
  if (key === dayKey(yesterday.getTime() / 1000)) return 'Gestern'
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(-2)}`
}

function messageMetaTime(ts: number): string {
  if (isToday(ts)) return hhmm(ts)
  return `${dayLabel(ts)} ${hhmm(ts)}`
}

function listTs(ts: number): string {
  if (!ts) return ''
  const now = Date.now() / 1000
  const diff = Math.max(0, now - ts)
  if (diff < 60) return 'gerade'
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} h`
  if (diff < 7 * 86400) return `vor ${Math.floor(diff / 86400)} d`
  if (diff < 30 * 86400) return `vor ${Math.floor(diff / (7 * 86400))} w`
  const d = new Date(ts * 1000)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(-2)}`
}

function renderInlineBold(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*\n]+\*\*)/g)
  return parts.map((p, i) => (
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} style={{ fontWeight: 650, color: 'var(--text)' }}>{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  ))
}

function renderAdviceText(text: string): ReactNode {
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
  return (
    <div style={{ display: 'grid', gap: 5 }}>
      {lines.map((line, i) => {
        const bullet = line.match(/^[-•·*]\s+(.*)$/)
        if (bullet) {
          return (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>·</span>
              <span>{renderInlineBold(bullet[1])}</span>
            </div>
          )
        }
        return <div key={i}>{renderInlineBold(line)}</div>
      })}
    </div>
  )
}

function parseVCard(text: string): { name: string; phone: string; org: string } {
  const lines = text.split(/\r?\n/)
  const value = (prefix: string) => {
    const line = lines.find(l => l.toUpperCase().startsWith(prefix))
    return (line?.split(':').slice(1).join(':') || '').trim()
  }
  return {
    name: value('FN:') || value('N:').replace(/;/g, ' ').trim() || 'Kontakt',
    phone: value('TEL'),
    org: value('ORG:'),
  }
}


type SectionKey = 'wartet' | 'chats' | 'gruppen' | 'emails' | 'archiv'
const REACTION_EMOJIS = ['👍', '👎', '❤️', '🙏', '🫶', '💪', '😂', '😢', '😅', '✅']
const WA_CHAT_LIST_POLL_MS = 60_000
const WA_THREAD_POLL_MS = 12_000
const WA_CHAT_LIST_MIN_GAP_MS = 8_000
const WA_PULL_REFRESH_TRIGGER_PX = 52
const WA_PULL_REFRESH_MAX_PX = 80
const WA_PULL_REFRESH_SLOP_PX = 8

type PullRefreshTarget = 'list' | 'thread'

export default function MobileWASlot({ composerHeight: _ch, active = true }: { composerHeight: number; active?: boolean }) {
  const agentName = useMainAgentName()
  const [view, setView] = useState<'list' | 'thread' | 'mail-thread' | 'archive' | 'newchat'>('list')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<WaChat[]>([])
  const searchTimerRef = useRef<number | null>(null)
  const [chats, setChats] = useState<WaChat[]>([])
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>(() => {
    try {
      const raw = localStorage.getItem('wa:collapsed')
      if (raw) return { wartet: false, chats: false, gruppen: false, emails: false, archiv: true, ...JSON.parse(raw) }
    } catch {}
    return { wartet: false, chats: false, gruppen: false, emails: false, archiv: true }
  })
  const toggleSection = useCallback((k: SectionKey) => {
    setCollapsed(prev => {
      const next = { ...prev, [k]: !prev[k] }
      try { localStorage.setItem('wa:collapsed', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])
  const [loadingList, setLoadingList] = useState(false)
  const [selected, setSelected] = useState<WaChat | null>(null)
  const [msgs, setMsgs] = useState<WaMessage[]>([])
  const [failedMedia, setFailedMedia] = useState<Set<string>>(new Set())
  const [loadingThread, setLoadingThread] = useState(false)
  const [mailInboxItems, setMailInboxItems] = useState<MailInboxItem[]>([])
  const [mailThread, setMailThread] = useState<{ account: string; uid: string; title?: string } | null>(null)
  const mailThreadKey = mailThread ? `${mailThread.account}:${mailThread.uid}` : ''
  const listScrollRef = useRef<HTMLDivElement | null>(null)
  const threadScrollRef = useRef<HTMLDivElement | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const msgsRef = useRef<WaMessage[]>([])
  const threadPollBusyRef = useRef(false)
  const chatListBusyRef = useRef(false)
  const chatListLastFetchRef = useRef(0)
  const activeThreadChatIdRef = useRef<string | null>(null)
  const brainAdviceRequestRef = useRef(0)
  const [pullRefresh, setPullRefresh] = useState<{ target: PullRefreshTarget | null; distance: number; refreshing: boolean }>({
    target: null,
    distance: 0,
    refreshing: false,
  })
  const pullRefreshGestureRef = useRef<{ target: PullRefreshTarget; startX: number; startY: number; active: boolean; blocked: boolean } | null>(null)
  const pullRefreshDistanceRef = useRef(0)
  const pullRefreshBlockClickRef = useRef(0)

  // Brain/Lagebild-Status: Send bleibt unabhängig davon immer draft-first.
  const [draftMode, setDraftMode] = useState(false)
  const [draftText, setDraftText] = useState<string | null>(null)
  // Gerettete Eingabe, falls ein Draft-Aufruf fehlschlaegt — wird wiederherstellbar
  // angezeigt, statt still zu verpuffen.
  const [draftError, setDraftError] = useState<string | null>(null)
  // Hinweis vom Backend, z.B. wenn Codex ausfiel und das lokale Modell eingesprungen
  // ist — kein stiller Tod, der Nutzer sieht woher der Entwurf kam.
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const [draftLoading, setDraftLoading] = useState(false)
  // Mail-Antwort unterwegs / gerade raus: der Nutzer sieht den Sendevorgang statt
  // "kein Laden, kein nichts". mailThreadRefresh signalisiert dem MailThreadView,
  // den Verlauf neu zu ziehen, damit die gesendete Antwort als Bubble auftaucht.
  const [mailSending, setMailSending] = useState(false)
  const [mailSentNotice, setMailSentNotice] = useState(false)
  const [mailThreadRefresh, setMailThreadRefresh] = useState(0)
  const [brainMessages, setBrainMessages] = useState<string[]>([])
  const [brainAdviceSaved, setBrainAdviceSaved] = useState(false)
  const [brainAdviceLoading, setBrainAdviceLoading] = useState(false)
  // Welche Stufe zeigt das Lagebild gerade: 'light' = nur das Neue, 'full' = ganzer Faden.
  const [brainLevel, setBrainLevel] = useState<'light' | 'full'>('light')
  const [reactionPickerFor, setReactionPickerFor] = useState<string>('')
  const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(null)
  // Spiegel des aktuellen Brain-Texts, damit ein erneuter Brain-Druck einen schon
  // sichtbaren Text nicht wegblitzen lässt — er steht ja, wird nur im Hintergrund
  // aufgefrischt (Backend liefert bei unverändertem Verlauf eh sofort den Cache).
  const brainMessagesRef = useRef<string[]>([])
  useEffect(() => { brainMessagesRef.current = brainMessages }, [brainMessages])

  // draftMode in Ref spiegeln, damit der Composer-Event-Handler (deps: [selected])
  // beim Toggle den aktuellen Stand kennt statt einer veralteten Closure.
  const draftModeRef = useRef(false)
  useEffect(() => { draftModeRef.current = draftMode }, [draftMode])
  // brainLevel in Ref spiegeln, damit der Composer-Toggle-Handler die aktuelle Stufe kennt.
  const brainLevelRef = useRef<'light' | 'full'>('light')
  useEffect(() => { brainLevelRef.current = brainLevel }, [brainLevel])

  // Brain-Knopf an: Agent konsolidiert den Verlauf sofort (worum geht's, was will
  // der andere, was ist offen) in die private Agent-Bubble — bevor der Nutzer diktiert.
  const requestBrainAdvice = useCallback((chatId: string, level: 'light' | 'full' = 'light') => {
    brainAdviceRequestRef.current += 1
    const reqId = brainAdviceRequestRef.current
    // Stufenwechsel zeigt frisch den Ladezustand; gleiche Stufe lässt stehenden Text stehen.
    const hasStanding = brainMessagesRef.current.length > 0 && level === 'light'
    if (!hasStanding) setBrainMessages([])
    setBrainLevel(level)
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(!hasStanding)
    fetch(`/api/whatsapp/brain-advice?chat_id=${encodeURIComponent(chatId)}&level=${level}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: any) => {
        if (brainAdviceRequestRef.current !== reqId) return
        setBrainAdviceLoading(false)
        const text = String(d?.advice || '').trim()
        setBrainAdviceSaved(!!d?.cached)
        setBrainMessages([text || 'Ich konnte den Verlauf gerade nicht sauber einschätzen.'])
      })
      .catch(() => {
        if (brainAdviceRequestRef.current !== reqId) return
        setBrainAdviceLoading(false)
        setBrainMessages(['Ich konnte den Verlauf gerade nicht sauber einschätzen.'])
      })
  }, [])

  const requestMailBrainAdvice = useCallback((account: string, uid: string) => {
    brainAdviceRequestRef.current += 1
    const reqId = brainAdviceRequestRef.current
    const hasStanding = brainMessagesRef.current.length > 0
    if (!hasStanding) setBrainMessages([])
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(!hasStanding)
    fetch(`/api/mail/brain-advice?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(uid)}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: any) => {
        if (brainAdviceRequestRef.current !== reqId) return
        setBrainAdviceLoading(false)
        const text = String(d?.advice || '').trim()
        setBrainAdviceSaved(!!d?.cached)
        setBrainMessages([text || 'Ich konnte die Mail gerade nicht sauber einschätzen.'])
      })
      .catch(() => {
        if (brainAdviceRequestRef.current !== reqId) return
        setBrainAdviceLoading(false)
        setBrainMessages(['Ich konnte die Mail gerade nicht sauber einschätzen.'])
      })
  }, [])

  useEffect(() => {
    if (!selected?.id) return
    const reqId = ++brainAdviceRequestRef.current
    setBrainMessages([])
    setBrainLevel('light')
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    fetch(`/api/whatsapp/brain-advice?chat_id=${encodeURIComponent(selected.id)}&cached=1`)
      .then(r => r.ok ? r.json() : null)
      .then((d: any) => {
        if (brainAdviceRequestRef.current !== reqId) return
        const text = String(d?.advice || '').trim()
        if (text && d?.cached) {
          setBrainAdviceSaved(true)
          setBrainMessages([text])
        }
      })
      .catch(() => {})
  }, [selected?.id])

  useEffect(() => {
    if (!mailThreadKey || !mailThread) return
    const reqId = ++brainAdviceRequestRef.current
    setBrainMessages([])
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    fetch(`/api/mail/brain-advice?account=${encodeURIComponent(mailThread.account)}&uid=${encodeURIComponent(mailThread.uid)}&cached=1`)
      .then(r => r.ok ? r.json() : null)
      .then((d: any) => {
        if (brainAdviceRequestRef.current !== reqId) return
        const text = String(d?.advice || '').trim()
        if (text && d?.cached) {
          setBrainAdviceSaved(true)
          setBrainMessages([text])
        }
      })
      .catch(() => {})
  }, [mailThreadKey, mailThread])

  // Vorlesen der Brain-Konsolidierung — nutzt dieselbe globale Audio-Queue wie der
  // Chat (Codex/ElevenLabs über /api/tts). Eine synthetische conversationId trennt
  // den Wiedergabe-State pro Chat, damit der Knopf sauber Play↔Stopp toggelt.
  const [aqState, setAqState] = useState(() => audioQueue.getState())
  useEffect(() => audioQueue.subscribe(setAqState), [])
  const brainSpeakConv = selected ? `wa-brain:${selected.id}` : (mailThreadKey ? `mail-brain:${mailThreadKey}` : 'wa-brain')
  const brainPlaying = aqState.playingConversationId === brainSpeakConv
  const speakBrain = useCallback(() => {
    if (audioQueue.getState().playingConversationId === brainSpeakConv) { audioQueue.stopAll(); return }
    const clean = cleanForTTS(brainMessages.join('\n\n'))
    if (!clean) return
    // Brain ist immer Agent: agentName 'main' lässt das Backend die Agent-Stimme
    // (main-Default, Gandalf) wählen. Kein control:voice-Override mitschicken, sonst
    // greift eine global gesetzte Fremdstimme (Toni) statt Agent' eigener.
    audioQueue.warmUp()
    audioQueue.playNow({ text: clean, agentName: 'main', ts: Date.now() / 1000, conversationId: brainSpeakConv, source: 'manual' })
  }, [brainSpeakConv, brainMessages])

  const loadChats = useCallback(async (force = false) => {
    const now = Date.now()
    if (chatListBusyRef.current) return
    if (!force && now - chatListLastFetchRef.current < WA_CHAT_LIST_MIN_GAP_MS) return
    chatListBusyRef.current = true
    chatListLastFetchRef.current = now
    setLoadingList(true)
    try {
      const r = await fetch('/api/whatsapp/chats?limit=200&include_archived=true')
      if (r.ok) {
        const d: ChatListResponse = await r.json()
        setChats(Array.isArray(d.chats) ? d.chats : [])
      }
    } catch {}
    finally {
      chatListBusyRef.current = false
      setLoadingList(false)
    }
  }, [])

  const loadMailInboxItems = useCallback(async () => {
    try {
      const r = await fetch('/api/inbox/mail-attention?limit=80')
      if (!r.ok) return
      const d = await r.json()
      const next = Array.isArray(d.items) ? d.items : []
      const doneKeys = Array.isArray(d.done_keys) ? d.done_keys : []
      setMailInboxItems(prev => mergeMailInboxItems(prev, next, doneKeys))
    } catch {}
  }, [])

  const resetThreadState = useCallback((refreshList = true) => {
    setView('list')
    setSelected(null)
    setMailThread(null)
    setDraftMode(false)
    setDraftText(null)
    setDraftError(null)
    setDraftNotice(null)
    brainAdviceRequestRef.current += 1
    setBrainMessages([])
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    if (refreshList) loadChats(true)
  }, [loadChats])

  const handleSwipeBack = useCallback(() => {
    if (view === 'thread') {
      resetThreadState(true)
      return
    }
    if (view === 'archive' || view === 'newchat') {
      setView('list')
      return
    }
    window.dispatchEvent(new CustomEvent('deck:toggleInfoPane'))
  }, [resetThreadState, view])

  const handleSwipeStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    if (e.touches.length !== 1 || target?.closest('input, textarea, button, a, [contenteditable="true"]')) {
      swipeStartRef.current = null
      return
    }
    const t = e.touches[0]
    swipeStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }, [])

  const handleSwipeEnd = useCallback((e: TouchEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current
    swipeStartRef.current = null
    const t = e.changedTouches[0]
    if (!start || !t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    const absY = Math.abs(dy)
    const fromEdge = start.x <= 96
    if (dx >= (fromEdge ? 72 : 140) && absY <= 54 && dx > absY * 1.6 && Date.now() - start.t <= 900) {
      handleSwipeBack()
    }
  }, [handleSwipeBack])

  useEffect(() => { loadChats(true); loadMailInboxItems() }, [loadChats, loadMailInboxItems])

  useEffect(() => { msgsRef.current = msgs }, [msgs])
  useEffect(() => { activeThreadChatIdRef.current = selected?.id || null }, [selected?.id])

  useEffect(() => {
    if (view !== 'list' || !active) return
    const i = setInterval(() => {
      if (!document.hidden) {
        loadChats()
        loadMailInboxItems()
      }
    }, WA_CHAT_LIST_POLL_MS)
    return () => clearInterval(i)
  }, [view, active, loadChats, loadMailInboxItems])

  // Composer-Hijack: Ziel an Composer melden. WhatsApp läuft immer draft-first;
  // previousDraft erlaubt iteratives Nachschärfen eines bestehenden Entwurfs.
  useEffect(() => {
    // Nur wenn das Overlay sichtbar ist, kapert WhatsApp den Composer. Ist es versteckt
    // (der Nutzer in einer Agent-Pane), sendet der Composer wieder an Agent — der Draft-State
    // bleibt aber erhalten, läuft im Hintergrund fertig und steht beim Zurückkommen noch da.
    if (active && view === 'thread' && selected) {
      window.dispatchEvent(new CustomEvent('deck:waSendTarget', {
        detail: { chat_id: selected.id, draft: true, previousDraft: draftText || '' },
      }))
    } else if (active && view === 'mail-thread' && mailThread) {
      window.dispatchEvent(new CustomEvent('deck:waSendTarget', {
        detail: { account: mailThread.account, uid: mailThread.uid, draft: true, previousDraft: draftText || '' },
      }))
    } else {
      window.dispatchEvent(new CustomEvent('deck:waSendTarget', { detail: { chat_id: null } }))
    }
    return () => {
      window.dispatchEvent(new CustomEvent('deck:waSendTarget', { detail: { chat_id: null } }))
    }
  }, [active, view, selected, mailThread, draftMode, draftText])

  // MobileApp.composerHeight braucht für WA-Overlay den korrekten Bottom — Draft-Status
  // dispatchen wir dauerhaft, damit der Composer weiß ob er ✓/✕ statt Plus/Send zeigt.
  useEffect(() => {
    const has = active && !!draftText && !draftLoading
    window.dispatchEvent(new CustomEvent('deck:waDraftPending', { detail: { active: has } }))
    return () => {
      window.dispatchEvent(new CustomEvent('deck:waDraftPending', { detail: { active: false } }))
    }
  }, [active, draftText, draftLoading])

  // Bei Brain-Beratung, Draft-Erzeugung und fertigem Draft ans Ende scrollen.
  useEffect(() => {
    if (brainAdviceLoading || brainMessages.length || draftLoading || draftText) {
      setTimeout(() => threadEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 30)
    }
  }, [brainAdviceLoading, brainMessages.length, draftLoading, draftText])

  // Composer-Buttons rufen Discard/Confirm/Toggle via Events
  const sendDraftRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onConfirm = () => sendDraftRef.current()
    const onDiscard = () => {
      setDraftText(null)
      setDraftError(null)
      setDraftNotice(null)
    }
    const onToggle = () => {
      if (!selected && !mailThread) return
      // Dreiklang: aus -> leicht -> ganzer Faden -> aus. Mail kennt kein 'full', springt direkt zurueck.
      const stage = !draftModeRef.current ? 'off' : brainLevelRef.current
      if (stage === 'off') {
        setDraftMode(true)
        if (selected) requestBrainAdvice(selected.id, 'light')
        else if (mailThread) requestMailBrainAdvice(mailThread.account, mailThread.uid)
      } else if (stage === 'light' && selected) {
        requestBrainAdvice(selected.id, 'full')
      } else {
        setDraftMode(false)
        brainAdviceRequestRef.current += 1
        setBrainMessages([])
        setBrainLevel('light')
        setBrainAdviceSaved(false)
        setBrainAdviceLoading(false)
      }
    }
    window.addEventListener('deck:waDraftConfirm', onConfirm)
    window.addEventListener('deck:waDraftDiscard', onDiscard)
    window.addEventListener('deck:waDraftToggle', onToggle)
    return () => {
      window.removeEventListener('deck:waDraftConfirm', onConfirm)
      window.removeEventListener('deck:waDraftDiscard', onDiscard)
      window.removeEventListener('deck:waDraftToggle', onToggle)
    }
  }, [selected, mailThread, requestBrainAdvice, requestMailBrainAdvice])

  // Brain-Stufe an Composer melden (fuer Icon-Farbe: aus=grau, leicht=weiss, ganzer Faden=terracotta)
  useEffect(() => {
    const stage = !draftMode ? 'off' : brainLevel
    window.dispatchEvent(new CustomEvent('deck:waDraftMode', { detail: { active: draftMode, stage } }))
  }, [draftMode, brainLevel])

  // Draft-Result vom Composer: wir bekommen den von Agent formulierten Text zurück
  useEffect(() => {
    const onDraft = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const isWa = !!selected && d.chat_id === selected.id
      const isMail = !!mailThreadKey && d.mail_key === mailThreadKey
      if (!isWa && !isMail) return
      setDraftLoading(false)
      const notice = typeof d.notice === 'string' ? d.notice : ''
      if (typeof d.text === 'string' && d.text) {
        setDraftText(d.text)
        setDraftError(null)
        setDraftNotice(notice || null)
      } else if (d.error) {
        if (typeof d.hint === 'string' && d.hint) setDraftError(d.hint)
        setDraftNotice(notice || ` kam grad nicht durch. Probier es gleich nochmal.`)
      }
    }
    const onDraftStart = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const isWa = !!selected && d.chat_id === selected.id
      const isMail = !!mailThreadKey && d.mail_key === mailThreadKey
      if (!isWa && !isMail) return
      setDraftLoading(true)
      setDraftError(null)
      setDraftNotice(null)
    }
    const onAdvice = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const isWa = !!selected && d.chat_id === selected.id
      const isMail = !!mailThreadKey && d.mail_key === mailThreadKey
      if (!isWa && !isMail) return
      setBrainAdviceLoading(false)
      const text = String(d.text || '').trim()
      const fallback = 'Ich konnte den Verlauf gerade nicht sauber einschätzen.'
      setBrainMessages(prev => {
        if (text) return [...prev, text].slice(-5)
        return prev.length ? prev : [fallback]
      })
    }
    const onAdviceStart = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const isWa = !!selected && d.chat_id === selected.id
      const isMail = !!mailThreadKey && d.mail_key === mailThreadKey
      if (!isWa && !isMail) return
      brainAdviceRequestRef.current += 1
      setBrainAdviceLoading(true)
    }
    window.addEventListener('deck:waDraftResult', onDraft)
    window.addEventListener('deck:waDraftStart', onDraftStart)
    window.addEventListener('deck:waBrainAdviceResult', onAdvice)
    window.addEventListener('deck:waBrainAdviceStart', onAdviceStart)
    return () => {
      window.removeEventListener('deck:waDraftResult', onDraft)
      window.removeEventListener('deck:waDraftStart', onDraftStart)
      window.removeEventListener('deck:waBrainAdviceResult', onAdvice)
      window.removeEventListener('deck:waBrainAdviceStart', onAdviceStart)
    }
  }, [selected, mailThreadKey])

  const reloadThread = useCallback(async (chatId: string) => {
    if (threadPollBusyRef.current) return
    threadPollBusyRef.current = true
    try {
      const scrollEl = threadScrollRef.current
      const wasNearBottom = !scrollEl || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 160
      const prevMsgs = msgsRef.current
      const prevLastId = prevMsgs[prevMsgs.length - 1]?.id
      const r = await fetch(`/api/whatsapp/messages?chat_id=${encodeURIComponent(chatId)}&limit=80`)
      if (r.ok) {
        const d: ThreadResponse = await r.json()
        if (activeThreadChatIdRef.current !== chatId) return
        const sorted = (d.messages || []).slice().sort((a, b) => a.ts - b.ts)
        const nextLastId = sorted[sorted.length - 1]?.id
        const prevIndex = prevLastId ? sorted.findIndex(m => m.id === prevLastId) : -1
        const fresh = prevIndex >= 0 ? sorted.slice(prevIndex + 1) : []
        setMsgs(sorted)
        if (prevLastId && nextLastId && nextLastId !== prevLastId) {
          if (wasNearBottom) setTimeout(() => threadEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 30)
          if (fresh.some(m => !m.from_me)) {
            fetch('/api/whatsapp/send-seen', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId }),
            }).catch(() => {})
            window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId } }))
          }
        }
      }
    } catch {}
    finally {
      threadPollBusyRef.current = false
    }
  }, [])

  const runPullRefresh = useCallback(async (target: PullRefreshTarget) => {
    setPullRefresh({ target, distance: WA_PULL_REFRESH_TRIGGER_PX, refreshing: true })
    try {
      if (target === 'thread' && selected?.id) {
        await reloadThread(selected.id)
      } else {
        await loadChats(true)
      }
    } finally {
      window.setTimeout(() => {
        pullRefreshDistanceRef.current = 0
        setPullRefresh({ target: null, distance: 0, refreshing: false })
      }, 180)
    }
  }, [loadChats, reloadThread, selected?.id])

  const handlePullRefreshStart = useCallback((e: TouchEvent<HTMLDivElement>, target: PullRefreshTarget) => {
    const t = e.touches[0]
    const node = e.target as HTMLElement | null
    if (!t || e.touches.length !== 1 || pullRefresh.refreshing || node?.closest('input, textarea, [contenteditable="true"]')) {
      pullRefreshGestureRef.current = null
      return
    }
    pullRefreshGestureRef.current = {
      target,
      startX: t.clientX,
      startY: t.clientY,
      active: false,
      blocked: false,
    }
  }, [pullRefresh.refreshing])

  const handlePullRefreshMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    const g = pullRefreshGestureRef.current
    const t = e.touches[0]
    if (!g || !t || g.blocked || pullRefresh.refreshing) return
    const dx = t.clientX - g.startX
    const dy = t.clientY - g.startY
    const scrollEl = g.target === 'thread' ? threadScrollRef.current : listScrollRef.current

    if (!g.active) {
      if (Math.abs(dx) > Math.max(22, Math.abs(dy) * 1.15)) {
        g.blocked = true
        return
      }
      if (dy <= WA_PULL_REFRESH_SLOP_PX) return
      if (!scrollEl || scrollEl.scrollTop > 0) {
        g.blocked = true
        return
      }
      g.active = true
    }

    if (dy <= 0 || !scrollEl || scrollEl.scrollTop > 0) {
      pullRefreshDistanceRef.current = 0
      setPullRefresh({ target: null, distance: 0, refreshing: false })
      return
    }

    e.preventDefault()
    pullRefreshBlockClickRef.current = Date.now() + 450
    const distance = Math.min(WA_PULL_REFRESH_MAX_PX, Math.round((dy - WA_PULL_REFRESH_SLOP_PX) * 0.85))
    pullRefreshDistanceRef.current = distance
    setPullRefresh({ target: g.target, distance, refreshing: false })
  }, [pullRefresh.refreshing])

  const handlePullRefreshEnd = useCallback(() => {
    const g = pullRefreshGestureRef.current
    pullRefreshGestureRef.current = null
    if (!g?.active || pullRefresh.refreshing) return
    const target = g.target
    const distance = pullRefreshDistanceRef.current
    pullRefreshDistanceRef.current = 0
    if (distance >= WA_PULL_REFRESH_TRIGGER_PX) {
      pullRefreshBlockClickRef.current = Date.now() + 700
      runPullRefresh(target)
    } else {
      setPullRefresh({ target: null, distance: 0, refreshing: false })
    }
  }, [pullRefresh.refreshing, runPullRefresh])

  const renderPullRefreshIndicator = (target: PullRefreshTarget) => {
    const active = pullRefresh.target === target
    const height = active ? (pullRefresh.refreshing ? 48 : pullRefresh.distance) : 0
    const opacity = active ? Math.min(1, Math.max(0.25, pullRefresh.distance / WA_PULL_REFRESH_TRIGGER_PX)) : 0
    return (
      <div
        aria-hidden="true"
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          transition: pullRefresh.refreshing ? 'height 140ms ease' : 'height 120ms ease, opacity 120ms ease',
          opacity,
        }}
      >
        <Loader2
          size={20}
          className={pullRefresh.refreshing ? 'spin' : ''}
          style={{
            color: pullRefresh.distance >= WA_PULL_REFRESH_TRIGGER_PX || pullRefresh.refreshing ? '#d97757' : 'var(--t3)',
            transform: pullRefresh.refreshing ? 'none' : `rotate(${Math.min(180, pullRefresh.distance * 2)}deg)`,
            transition: 'color 120ms ease',
          }}
        />
      </div>
    )
  }

  useEffect(() => {
    if (view !== 'thread' || !selected?.id || !active) return
    const tick = async () => {
      if (document.hidden) return
      await reloadThread(selected.id)
    }
    const id = window.setInterval(tick, WA_THREAD_POLL_MS)
    return () => window.clearInterval(id)
  }, [reloadThread, selected?.id, view, active])

  // Aktuelle sendDraft-Implementierung jeden Render in den Ref schreiben.
  sendDraftRef.current = () => {
    if (!draftText || (!selected && !mailThread)) return
    const text = draftText
    setDraftText(null)
    setDraftError(null)
    setDraftNotice(null)
    setDraftMode(false)
    brainAdviceRequestRef.current += 1
    setBrainMessages([])
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    if (mailThread) {
      const target = mailThread
      setMailSending(true)
      setMailSentNotice(false)
      fetch('/api/mail/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: target.account, uid: target.uid, body: text }),
      }).then(async r => {
        if (r.ok) {
          setMailSending(false)
          setMailSentNotice(true)
          // Verlauf neu ziehen: die gerade gesendete Antwort taucht (aus dem Outbox-Ledger)
          // als eigene Bubble unter der eingegangenen Mail auf, wie in einem Chat.
          setMailThreadRefresh(n => n + 1)
          // Sofort runter in "E-Mails" + weiss, ohne auf den naechsten Poll zu warten.
          setMailInboxItems(prev => prev.map(m => ((m.account || '') === target.account && m.uid === target.uid) ? { ...m, replied: true } : m))
          window.dispatchEvent(new CustomEvent('wa:sent', { detail: { mail: true, account: target.account, uid: target.uid } }))
        } else {
          // Fehler nicht mehr verschlucken: Text zurueckholen, echten Grund zeigen.
          setMailSending(false)
          const d = await r.json().catch(() => ({}))
          setDraftText(text)
          setDraftError(d.error || `Versand fehlgeschlagen (${r.status})`)
        }
      }).catch(() => {
        setMailSending(false)
        setDraftText(text)
        setDraftError('Versand fehlgeschlagen, keine Verbindung zum Server.')
      })
      return
    }
    if (!selected) return
    const chatId = selected.id
    const optimistic: WaMessage = {
      id: 'tmp-' + Date.now(),
      ts: Math.floor(Date.now() / 1000),
      from_me: true, type: 'chat',
      body: text, transcript: null,
    }
    setMsgs(prev => [...prev, optimistic])
    setTimeout(() => threadEndRef.current?.scrollIntoView({ block: 'end' }), 30)
    fetch('/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {})
    setTimeout(() => reloadThread(chatId), 800)
  }

  // Composer dispatcht deck:waMessageSent nach erfolgreichem WA-Send. Wir nehmen die
  // Nachricht optimistisch auf und holen kurz danach die echte Liste vom Backend.
  useEffect(() => {
    const onSent = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if (!selected || d.chat_id !== selected.id) return
      const optimistic: WaMessage = {
        id: 'tmp-' + Date.now(),
        ts: Math.floor(Date.now() / 1000),
        from_me: true,
        type: 'chat',
        body: String(d.text || ''),
        transcript: null,
      }
      setMsgs(prev => [...prev, optimistic])
      setTimeout(() => threadEndRef.current?.scrollIntoView({ block: 'end' }), 30)
      setTimeout(() => reloadThread(selected.id), 800)
    }
    window.addEventListener('deck:waMessageSent', onSent)
    return () => window.removeEventListener('deck:waMessageSent', onSent)
  }, [selected, reloadThread])

  const openChat = useCallback(async (chat: WaChat) => {
    setSelected(chat)
    setView('thread')
    setLoadingThread(true)
    setMsgs([])
    brainAdviceRequestRef.current += 1
    setBrainMessages([])
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
    await reloadThread(chat.id)
    fetch('/api/whatsapp/send-seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat.id }),
    }).catch(() => {})
    setLoadingThread(false)
    setTimeout(() => threadEndRef.current?.scrollIntoView({ block: 'end' }), 50)
  }, [reloadThread])

  const openMailThread = useCallback((account: string, uid: string, title?: string) => {
    if (!account || !uid) return
    setSelected(null)
    setMailThread({ account, uid, title })
    setView('mail-thread')
    setDraftMode(false)
    setDraftText(null)
    setDraftError(null)
    setDraftNotice(null)
    setMailSending(false)
    setMailSentNotice(false)
    brainAdviceRequestRef.current += 1
    setBrainMessages([])
    setBrainAdviceSaved(false)
    setBrainAdviceLoading(false)
  }, [])

  // "Gesendet"-Bestaetigung von selbst wieder ausblenden, ruhig statt klebend.
  useEffect(() => {
    if (!mailSentNotice) return
    const id = window.setTimeout(() => setMailSentNotice(false), 3200)
    return () => window.clearTimeout(id)
  }, [mailSentNotice])

  // Search-Debounce für New-Chat-Sheet
  useEffect(() => {
    if (view !== 'newchat') return
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
    const q = searchQuery.trim()
    if (q.length < 2) { setSearchResults([]); return }
    searchTimerRef.current = window.setTimeout(async () => {
      try {
        const r = await fetch(`/api/whatsapp/find-contact?name=${encodeURIComponent(q)}&limit=12`)
        if (r.ok) {
          const d = await r.json()
          // find-contact liefert chat_id (nicht id) — auf das WaChat-Shape mappen,
          // sonst öffnet openChat einen leeren Thread (reloadThread(undefined)).
          const raw = Array.isArray(d.matches) ? d.matches : (Array.isArray(d.chats) ? d.chats : [])
          setSearchResults(raw.map((m: any) => ({
            id: m.chat_id || m.id,
            name: m.name,
            is_group: !!m.is_group,
            last_ts: m.last_ts ?? 0,
            unread: m.unread ?? 0,
            preview: '',
            last_from_me: false,
            is_archived: m.is_archived,
          })))
        }
      } catch {}
    }, 250)
  }, [searchQuery, view])

  const archive = useCallback(async (chat: MobileInboxItem) => {
    try {
      if ('source' in chat && chat.source === 'mail') {
        const r = await fetch('/api/mail/archive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: chat.account, uid: chat.uid }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d.error) throw new Error(d.error || 'Archivieren fehlgeschlagen')
        rememberArchivedMail(chat.account, chat.uid)
        setMailInboxItems(prev => prev.filter(m => !((m.account || '') === chat.account && m.uid === chat.uid)))
        loadMailInboxItems()
        window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
        return
      }
      await fetch('/api/whatsapp/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat.id, archive: !chat.is_archived }),
      })
      // Feedback: aus dem Thread zurueck zur Liste, Liste frisch laden
      setView('list')
      setSelected(null)
      setDraftMode(false)
      setDraftText(null)
      setDraftError(null)
      brainAdviceRequestRef.current += 1
      setBrainMessages([])
      setBrainAdviceSaved(false)
      setBrainAdviceLoading(false)
      loadChats()
      window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
    } catch {}
  }, [loadChats, loadMailInboxItems])

  const sendReaction = useCallback(async (msgId: string, emoji: string) => {
    setReactionPickerFor('')
    try {
      await fetch('/api/whatsapp/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_id: msgId, emoji }),
      })
      if (selected?.id) {
        await fetch('/api/whatsapp/dismiss-triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: selected.id }),
        })
        window.dispatchEvent(new CustomEvent('wa:sent', { detail: { chatId: selected.id } }))
        loadChats()
        setTimeout(() => reloadThread(selected.id), 700)
      }
    } catch {}
  }, [loadChats, reloadThread, selected?.id])

  const toggleReactionPicker = useCallback((msgId: string) => {
    setReactionPickerFor(prev => {
      const next = prev === msgId ? '' : msgId
      if (next) {
        window.setTimeout(() => {
          document.getElementById(`wa-reaction-picker-${msgId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }, 40)
      }
      return next
    })
  }, [])

  const mailAssistFooter = (
    <div style={{ marginTop: 18, paddingBottom: 16 }}>
      {brainAdviceLoading && brainMessages.length === 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
          <div style={{
            padding: '8px 12px',
            borderRadius: 16,
            background: 'var(--bg-2)',
            color: 'var(--text-muted)',
            fontSize: 13,
            maxWidth: '80%',
          }}>
            <span className="quiet-presence-shimmer">{agentName} sortiert…</span>
          </div>
        </div>
      )}
      {brainMessages.map((msg, idx) => (
        <div key={`mail-brain-${idx}`} style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
          <div style={{
            maxWidth: '80%',
            padding: '9px 12px',
            borderRadius: 16,
            background: 'var(--bg-2)',
            border: '1px solid rgba(217,119,87,0.32)',
            color: 'var(--text)',
            fontSize: 14,
            lineHeight: 1.38,
            wordBreak: 'break-word',
          }}>
            <div style={{ fontSize: 11, fontWeight: 650, color: '#d97757', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              {agentName}
              {idx === 0 && brainAdviceSaved && (
                <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· gespeichert</span>
              )}
            </div>
            {renderAdviceText(msg)}
          </div>
        </div>
      ))}
      {brainMessages.length > 0 && !brainAdviceLoading && (
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 6 }}>
          <button
            type="button"
            onClick={speakBrain}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 14,
              background: brainPlaying ? 'rgba(217,119,87,0.16)' : 'var(--bg-2)',
              border: '1px solid rgba(217,119,87,0.32)',
              color: brainPlaying ? '#d97757' : 'var(--text-muted)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {brainPlaying ? <Square size={15} fill="currentColor" /> : <Volume2 size={16} />}
            {brainPlaying ? 'Stopp' : 'Vorlesen'}
          </button>
        </div>
      )}
      {draftLoading && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <div style={{
            padding: '8px 12px',
            borderRadius: 16,
            background: 'rgba(217,119,87,0.18)',
            color: '#d97757',
            fontSize: 13,
          }}>
            <span className="status-shimmer-warm">{agentName} formuliert…</span>
          </div>
        </div>
      )}
      {draftText && !draftLoading && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <div style={{
            maxWidth: '80%',
            padding: '8px 12px',
            borderRadius: 16,
            background: 'rgba(217,119,87,0.16)',
            border: '1px solid rgba(217,119,87,0.6)',
            color: 'var(--text)',
            fontSize: 14.5,
            lineHeight: 1.38,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {draftText}
          </div>
        </div>
      )}
      {draftNotice && draftText && !draftLoading && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <div style={{ maxWidth: '80%', fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'right' }}>
            {draftNotice}
          </div>
        </div>
      )}
      {draftError && !draftLoading && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <div style={{
            maxWidth: '80%',
            padding: '9px 12px',
            borderRadius: 16,
            background: 'var(--bg-2)',
            border: '1px solid rgba(217,119,87,0.32)',
            color: 'var(--text)',
            fontSize: 13,
            lineHeight: 1.35,
          }}>
            <div style={{ color: '#d97757', fontWeight: 650, marginBottom: 4 }}>Nicht gesendet</div>
            {draftNotice || draftError}
          </div>
        </div>
      )}
      {mailSending && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 12px', borderRadius: 16,
            background: 'rgba(217,119,87,0.18)', color: '#d97757', fontSize: 13,
          }}>
            <Loader2 size={16} className="animate-spin" />
            <span>wird gesendet…</span>
          </div>
        </div>
      )}
      {mailSentNotice && !mailSending && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: 'var(--text-muted)',
          }}>
            <CheckCheck size={16} style={{ color: '#5a9e6f' }} />
            <span>Gesendet</span>
          </div>
        </div>
      )}
      <div ref={threadEndRef} />
    </div>
  )

  if (view === 'mail-thread' && mailThread) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <MailThreadView
          account={mailThread.account}
          uid={mailThread.uid}
          title={mailThread.title}
          reloadSignal={mailThreadRefresh}
          mobile
          onBack={() => {
            setMailThread(null)
            setView('list')
            loadMailInboxItems()
          }}
          onAction={(uid) => {
            rememberArchivedMail(mailThread.account, uid)
            setMailInboxItems(prev => prev.filter(m => !((m.account || '') === mailThread.account && m.uid === uid)))
            loadMailInboxItems()
          }}
          footer={mailAssistFooter}
        />
      </div>
    )
  }

  // ── List, Archive, NewChat views ──
  if (view === 'list' || view === 'archive' || view === 'newchat') {
    // Inbox: triage='waiting_on_me', älteste oben
    const waWaiting = chats.filter(c => c.triage === 'waiting_on_me' && !c.is_archived)
      .sort((a, b) => (a.last_ts || 0) - (b.last_ts || 0))
    const waitingIds = new Set(waWaiting.map(c => c.id))
    const toMailRow = (m: MailInboxItem): MobileInboxItem => {
      const ctx = m.inbox_context || {}
      const project = ctx.projects?.[0]?.name || ''
      const subject = m.subject || '(ohne Betreff)'
      return {
        id: `mail:${m.account || ''}:${m.uid}`,
        source: 'mail' as const,
        account: m.account || '',
        uid: m.uid,
        name: ctx.person_name || m.from || 'Mail',
        is_group: false,
        last_ts: m.ts || 0,
        unread: m.unread ? 1 : 0,
        preview: `${project ? `${project} · ` : ''}${subject}${m.snippet ? ` · ${m.snippet}` : ''}`,
        last_from_me: false,
        is_archived: false,
        // Unbeantwortet => terracotta in "Wartet"; beantwortet => weiss in "E-Mails".
        triage: m.replied ? 'replied' : 'waiting_on_me',
      }
    }
    // Eine Mail bleibt in "Wartet", bis der Nutzer wirklich geantwortet hat.
    // Lesen allein demotet sie nicht mehr. Beantwortete Mails rutschen runter
    // in die "E-Mails"-Gruppe und werden dort neutral (weiss).
    const mailWaiting: MobileInboxItem[] = mailInboxItems.filter(m => !m.replied).map(toMailRow)
    const emailRows: MobileInboxItem[] = mailInboxItems.filter(m => !!m.replied).map(toMailRow)
    const waiting: MobileInboxItem[] = [...waWaiting, ...mailWaiting].sort((a, b) => (a.last_ts || 0) - (b.last_ts || 0))
    const dms = chats.filter(c => !c.is_group && !c.is_archived && !waitingIds.has(c.id))
      .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0))
    const groups = chats.filter(c => c.is_group && !c.is_archived && !waitingIds.has(c.id))
      .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0))
    const archived = chats.filter(c => c.is_archived)
      .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0))

    const Section = ({ k, title, items, muted, collapsible = true, rowIcons = false, headerIcon = null }: { k: SectionKey; title: string; items: MobileInboxItem[]; muted?: boolean; collapsible?: boolean; rowIcons?: boolean; headerIcon?: ReactNode }) => {
      if (items.length === 0) return null
      const isCollapsed = collapsible && collapsed[k]
      return (
        <div style={{ marginTop: 26 }}>
          <button
            type="button"
            onClick={() => collapsible && toggleSection(k)}
            disabled={!collapsible}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              textAlign: 'left',
              padding: '0 22px 8px',
              background: 'transparent',
              fontSize: 13,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'rgba(140,140,135,0.85)',
            }}
          >
            {headerIcon}
            <span>{title} <span style={{ opacity: 0.55, fontWeight: 500 }}>· {items.length}</span></span>
            {collapsible && (
              isCollapsed
                ? <ChevronRight size={18} style={{ opacity: 0.55 }} />
                : <ChevronDown size={18} style={{ opacity: 0.55 }} />
            )}
          </button>
          {!isCollapsed && (
            <div>
          {items.map((c) => {
            const isMail = 'source' in c && c.source === 'mail'
            const unread = c.unread > 0
            const isWaiting = c.triage === 'waiting_on_me'
            const nameColor = isWaiting
              ? '#d97757'
              : 'var(--text)'
            return (
              <div
                key={c.id}
                style={{
                  position: 'relative',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (pullRefreshBlockClickRef.current > Date.now()) return
                    if (isMail) {
                      openMailThread(c.account, c.uid, c.name)
                      return
                    }
                    openChat(c)
                  }}
                  className="wa-row"
	                  style={{
	                    display: 'block',
	                    width: '100%',
	                    padding: '12px 20px',
	                    background: 'transparent',
	                    textAlign: 'left',
	                    opacity: muted ? 0.7 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    {rowIcons && (isMail
                      ? <Mail size={18} style={{ color: '#d97757', flexShrink: 0 }} />
                      : <WhatsAppGlyph size={18} style={{ color: '#d97757', flexShrink: 0 }} />)}
                    <div style={{
                      fontSize: 18,
                      fontWeight: isWaiting ? 700 : 650,
                      lineHeight: 1.22,
	                      color: nameColor,
	                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
	                      flex: 1,
	                      paddingRight: 66,
	                    }}>
                      {c.name}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 3 }}>
                    <div style={{
                      fontSize: 16,
                      lineHeight: 1.28,
                      color: unread ? 'var(--t2)' : 'var(--t3)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      flex: 1,
                      paddingRight: 58,
                    }}>
                      {c.last_from_me ? 'Du: ' : ''}{renderInlinePreview(c.preview)}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (pullRefreshBlockClickRef.current > Date.now()) return
                    archive(c)
                  }}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 72,
                    padding: '14px 16px 0 6px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-start',
                    alignItems: 'flex-end',
                    gap: 5,
                    background: 'transparent',
                    color: 'var(--t3)',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                  title={c.is_archived ? 'Entarchivieren' : 'Archivieren'}
                  aria-label={`${c.name} ${c.is_archived ? 'entarchivieren' : 'archivieren'}`}
                >
                  <span style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>
                    {listTs(c.last_ts).replace('vor ', '')}
                  </span>
                  {unread && <Eye size={17} style={{ color: '#d97757', flexShrink: 0 }} />}
                </button>
              </div>
            )
          })}
            </div>
          )}
        </div>
      )
    }

    return (
      <div
        onTouchStart={handleSwipeStart}
        onTouchEnd={handleSwipeEnd}
        onTouchCancel={() => { swipeStartRef.current = null }}
        style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        background: 'var(--bg)',
      }}>
        {/* Header echt fix, exakt gleiche Höhe wie der Agent-MobileTopMarker:
            env-inset-top + 1px Padding wie dort */}
        <div className="mobile-hero-chrome" style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1px)',
          paddingBottom: 5,
          paddingLeft: 20,
          paddingRight: 12,
          background: 'var(--bg)',
          flexShrink: 0,
        }}>
          {view === 'list' ? (
            <>
              <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 13,
                lineHeight: 1.1,
                color: 'var(--t3)',
                letterSpacing: '0.02em',
              }}>
                <Inbox size={19} strokeWidth={1.75} />
                <span>Inbox</span>
              </div>
              <button
                type="button"
                onClick={() => setView('archive')}
                style={{ padding: 2, marginLeft: 8, color: 'var(--t3)', display: 'flex' }}
                title="Archiv"
              >
                <Archive size={22} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={() => { setSearchQuery(''); setSearchResults([]); setView('newchat') }}
                style={{ padding: 2, marginLeft: 8, color: 'var(--t3)', display: 'flex' }}
                title="Neuer Chat"
              >
                <Plus size={22} strokeWidth={1.75} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setView('list')}
                style={{ padding: 2, marginRight: 6, color: 'var(--t3)', display: 'flex' }}
              >
                <ChevronLeft size={22} strokeWidth={1.75} />
              </button>
              <div style={{ flex: 1, fontSize: 13, lineHeight: 1.1, color: 'var(--t3)' }}>
                {view === 'archive' ? 'Archiv' : 'Neuer Chat'}
              </div>
            </>
          )}
        </div>

        {/* Scroll-Body: nur dieser Bereich scrollt, Header bleibt fix */}
        <div
          ref={listScrollRef}
          onTouchStart={(e) => handlePullRefreshStart(e, 'list')}
          onTouchMove={handlePullRefreshMove}
          onTouchEnd={handlePullRefreshEnd}
          onTouchCancel={handlePullRefreshEnd}
          style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          touchAction: 'pan-y',
          overscrollBehavior: 'contain',
        }}>
        {renderPullRefreshIndicator('list')}
        {loadingList && chats.length === 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 size={22} className="spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}

        {view === 'list' && (
          <>
            <Section k="wartet" title="Wartet" items={waiting} rowIcons />
            <Section k="chats" title="WhatsApp" items={dms} headerIcon={<WhatsAppGlyph size={16} style={{ flexShrink: 0 }} />} />
            <Section k="gruppen" title="Gruppen" items={groups} headerIcon={<WhatsAppGlyph size={16} style={{ flexShrink: 0 }} />} />
            <Section k="emails" title="E-Mails" items={emailRows} headerIcon={<Mail size={16} style={{ flexShrink: 0 }} />} />
          </>
        )}

        {view === 'archive' && (
          <Section k="archiv" title="Archiviert" items={archived} muted collapsible={false} />
        )}

        {view === 'newchat' && (
          <div style={{ padding: '4px 16px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 14,
            }}>
              <Search size={18} style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                value={searchQuery}
                autoFocus
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Name suchen…"
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--text)',
                  fontSize: 15,
                }}
              />
            </div>
            <div style={{ marginTop: 14 }}>
              {searchResults.length === 0 && searchQuery.trim().length >= 2 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  Keine Treffer.
                </div>
              )}
              {searchResults.map(c => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    if (pullRefreshBlockClickRef.current > Date.now()) return
                    openChat(c)
                  }}
                  style={{
                    display: 'block', width: '100%',
                    padding: '12px 14px',
                    background: 'transparent', textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 18, fontWeight: 650, color: 'var(--text)' }}>{c.name}</div>
                  {c.last_ts ? (
                    <div style={{ fontSize: 15, color: 'var(--t3)', marginTop: 2 }}>
                      letzter Kontakt {listTs(c.last_ts)}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        )}

        {!loadingList && chats.length === 0 && view === 'list' && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Keine Chats.</div>
        )}
        <div style={{ height: 24 }} />
        </div>
      </div>
    )
  }

  // ── Thread view ──
  return (
    <div
      onTouchStart={handleSwipeStart}
      onTouchEnd={handleSwipeEnd}
      onTouchCancel={() => { swipeStartRef.current = null }}
      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}
    >
      <div className="mobile-hero-chrome" style={{
        display: 'flex',
        alignItems: 'center',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1px)',
        paddingBottom: 5,
        paddingLeft: 16,
        paddingRight: 12,
        flexShrink: 0,
      }}>
        <button type="button" onClick={() => resetThreadState(true)} style={{ padding: 2, marginRight: 6, color: 'var(--t3)', display: 'flex' }}>
          <ChevronLeft size={22} strokeWidth={1.75} />
        </button>
        <div style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.1, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '0.02em' }}>
          {selected?.name}
        </div>
        {selected && (
          <button type="button" onClick={() => archive(selected)} style={{ padding: 2, marginLeft: 8, color: 'var(--t3)', display: 'flex' }}>
            <Archive size={22} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div
        ref={threadScrollRef}
        onTouchStart={(e) => handlePullRefreshStart(e, 'thread')}
        onTouchMove={handlePullRefreshMove}
        onTouchEnd={handlePullRefreshEnd}
        onTouchCancel={handlePullRefreshEnd}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '10px 14px 18px',
          overscrollBehavior: 'contain',
          touchAction: 'pan-y',
        }}
      >
        {renderPullRefreshIndicator('thread')}
        {loadingThread && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 size={22} className="spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}
        {msgs.map((m, i) => {
          const text = m.body || m.transcript || ''
          const isImage = m.type === 'image' && m.has_media
          const isVideo = m.type === 'video' && m.has_media
          const isAudio = (m.type === 'audio' || m.type === 'ptt') && m.has_media
          const readableText = isAudio && m.summary ? m.summary : text
          const useReadableText = !!readableText && (isAudio || readableText.length >= 260 || mobileReadableParagraphs(readableText).length > 1)
          const isDoc = m.type === 'document' && m.has_media
          const isVCard = m.type === 'vcard' || m.type === 'multi_vcard'
          const isLocation = m.type === 'location' || m.type === 'live_location'
          const contact = isVCard ? parseVCard(text) : null
          const prev = msgs[i - 1]
          const next = msgs[i + 1]
          const isNewDay = !prev || dayKey(prev.ts) !== dayKey(m.ts)
          const sameAsPrev = !!(prev && !isNewDay && prev.from_me === m.from_me)
          const sameAsNext = !!(next && dayKey(next.ts) === dayKey(m.ts) && next.from_me === m.from_me)
          const tailRadius = 6
          const fullRadius = 16
          const radii = m.from_me
            ? `${fullRadius}px ${fullRadius}px ${sameAsNext ? fullRadius : tailRadius}px ${fullRadius}px`
            : `${fullRadius}px ${fullRadius}px ${fullRadius}px ${sameAsNext ? fullRadius : tailRadius}px`
          const hasLocalMedia = !!m.has_media_file
          const isGif = !!m.is_gif && !!m.has_media
          const mediaUrl = m.has_media ? `/api/whatsapp/media?msg_id=${encodeURIComponent(m.id)}&fetch=0` : ''
          const fetchMediaUrl = m.has_media ? `/api/whatsapp/media?msg_id=${encodeURIComponent(m.id)}` : ''
          const autoLoadMedia = (isImage || isGif) && !failedMedia.has(m.id)
            && ((Date.now() / 1000 - m.ts) < 72 * 3600 || i >= msgs.length - 20)
          const showMediaInline = hasLocalMedia || autoLoadMedia
          const inlineSrc = hasLocalMedia ? mediaUrl : fetchMediaUrl
          const downloadUrl = m.has_media ? `/api/whatsapp/media?msg_id=${encodeURIComponent(m.id)}&download=1` : ''
          const hasReactions = !!(m.reactions && m.reactions.length > 0)
          const needsReactionClearance = hasReactions && sameAsNext
          const label = dayLabel(m.ts)
          const todaySeparator = label === 'Heute'
          return (
            <div key={m.id} style={{ marginTop: sameAsPrev ? 2 : 8, marginBottom: needsReactionClearance ? 15 : 0 }}>
              {isNewDay && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  margin: '12px 4px 10px',
                  color: todaySeparator ? '#d97757' : 'color-mix(in srgb, var(--t3) 78%, var(--t1) 22%)',
                  fontSize: 12,
                  fontWeight: 650,
                  letterSpacing: '0.01em',
                }}>
                  <div style={{ flex: 1, height: 1, background: todaySeparator ? 'rgba(217,119,87,0.36)' : 'var(--mobile-chrome-border)' }} />
                  <span>{label}</span>
                  <div style={{ flex: 1, height: 1, background: todaySeparator ? 'rgba(217,119,87,0.36)' : 'var(--mobile-chrome-border)' }} />
                </div>
              )}
              <div style={{
                display: 'flex',
                justifyContent: m.from_me ? 'flex-end' : 'flex-start',
              }}>
              <div
                style={{
                  maxWidth: useReadableText ? '92%' : '80%',
                  padding: isImage || isVideo ? '4px 4px 6px' : useReadableText ? '10px 12px' : '8px 12px 7px',
                  borderRadius: radii,
                  background: m.from_me ? 'var(--hover)' : 'var(--bg-2)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 18,
                  lineHeight: 1.4,
                  whiteSpace: useReadableText ? 'normal' : 'pre-wrap',
                  wordBreak: 'break-word',
                  WebkitUserSelect: 'none',
                  WebkitTouchCallout: 'none',
                  position: 'relative',
                }}>
                {selected?.is_group && !m.from_me && m.sender_name && !sameAsPrev && (
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#d97757', marginBottom: 2, padding: isImage ? '0 6px' : 0 }}>
                    {m.sender_name}
                  </div>
                )}
                {m.context?.kind === 'story_reply' && (
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    maxWidth: '100%',
                    marginBottom: 5,
                    padding: isImage || isVideo ? '3px 7px 0' : 0,
                    color: 'color-mix(in srgb, var(--t3) 82%, var(--t1) 18%)',
                    fontSize: 12,
                    fontWeight: 650,
                    letterSpacing: '0.01em',
                    whiteSpace: 'nowrap',
                  }}>
                    <ImageIcon size={15} strokeWidth={1.8} />
                    <span>{m.context.label || 'Story-Antwort'}</span>
                  </div>
                )}
                {isImage && showMediaInline && (
                  <img
                    src={inlineSrc}
                    alt=""
                    onClick={() => window.open(inlineSrc, '_blank')}
                    onError={() => setFailedMedia(prev => { const next = new Set(prev); next.add(m.id); return next })}
                    style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, display: 'block' }}
                  />
                )}
                {isGif && showMediaInline && (
                  <video
                    src={inlineSrc}
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="metadata"
                    onError={() => setFailedMedia(prev => { const next = new Set(prev); next.add(m.id); return next })}
                    style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, display: 'block' }}
                  />
                )}
                {isVideo && !isGif && hasLocalMedia && (
                  <video src={mediaUrl} controls preload="metadata" style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, display: 'block' }} />
                )}
                {isAudio && hasLocalMedia && (
                  <MobileVoicePlayer src={mediaUrl} />
                )}
                {m.has_media && !hasLocalMedia && !((isImage || isGif) && showMediaInline) && (
                  <button
                    type="button"
                    onClick={() => window.open(isDoc ? downloadUrl : fetchMediaUrl, '_blank')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 10px',
                      background: 'rgba(255,255,255,0.06)',
                      borderRadius: 10,
                      color: 'var(--text)',
                      fontSize: 14,
                    }}
                  >
                    <Download size={17} /> Medien laden
                  </button>
                )}
                {isDoc && hasLocalMedia && (
                  <a
                    href={downloadUrl}
                    target="_blank"
                    rel="noopener"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      background: 'rgba(255,255,255,0.06)',
                      borderRadius: 10,
                      color: 'var(--text)',
                      fontSize: 14,
                    }}
                  >
                    <FileText size={18} /> Dokument öffnen
                  </a>
                )}
                {contact && (
                  <div style={{
                    display: 'grid',
                    gap: 3,
                    padding: '4px 2px',
                  }}>
                    <div style={{ fontWeight: 700 }}>{contact.name}</div>
                    {contact.org && <div style={{ color: 'var(--t3)', fontSize: 15 }}>{contact.org}</div>}
                    {contact.phone && <a href={`tel:${contact.phone.replace(/\s+/g, '')}`} style={{ color: 'var(--text)', textDecoration: 'underline', textUnderlineOffset: 3 }}>{contact.phone}</a>}
                  </div>
                )}
                {isLocation && (
                  <div style={{
                    display: 'grid',
                    gap: 3,
                    padding: '4px 2px',
                  }}>
                    <div style={{ fontWeight: 700 }}>Standort</div>
                    <div style={{ color: 'var(--t3)', fontSize: 15 }}>Koordinaten sind in der lokalen WhatsApp-Kopie nicht gespeichert.</div>
                    {text && !text.startsWith('/9j/') && <div>{linkifyText(text)}</div>}
                  </div>
                )}
                {readableText && !contact && !isLocation && (
                  <div style={{
                    marginTop: isAudio && hasLocalMedia ? 10 : (isImage || isVideo || isDoc) ? 4 : 0,
                    padding: (isImage || isVideo) ? '4px 8px 0' : useReadableText ? '9px 10px 9px 12px' : 0,
                    borderLeft: 'none',
                    borderRadius: useReadableText ? '0 8px 8px 0' : 0,
                    background: 'transparent',
                    fontSize: useReadableText ? 16 : undefined,
                    lineHeight: useReadableText ? 1.52 : undefined,
                  }}>
                    {useReadableText ? <MobileReadableText text={readableText} /> : linkifyText(readableText)}
                  </div>
                )}
                {hasReactions && (
                  <div style={{
                    position: 'absolute',
                    bottom: -13,
                    right: m.from_me ? 8 : 'auto',
                    left: m.from_me ? 'auto' : 8,
                    display: 'flex',
                    gap: 2,
                    fontSize: 22,
                    lineHeight: 1,
                  }}>
                    {m.reactions!.map(r => <span key={r.sender_jid + r.emoji}>{r.emoji}</span>)}
                  </div>
                )}
              </div>
              </div>
            {/* Meta UNTER der Bubble — Apple/iMessage-Style, dezent */}
            {!sameAsNext && (
              <div style={{
                display: 'flex',
                justifyContent: m.from_me ? 'flex-end' : 'flex-start',
                gap: 6,
                fontSize: 12,
                color: 'color-mix(in srgb, var(--t3) 78%, var(--t1) 22%)',
                marginTop: hasReactions ? 13 : 4,
                padding: m.from_me ? '0 4px 0 0' : '0 0 0 4px',
                alignItems: 'center',
              }}>
                {hasLocalMedia && (isImage || isVideo || isDoc) && (
                  <a
                    href={downloadUrl}
                    onClick={(e) => e.stopPropagation()}
                    target="_blank"
                    rel="noopener"
                    style={{ color: 'inherit', display: 'inline-flex', alignItems: 'center' }}
                    title="Download"
                  >
                    <Download size={15} />
                  </a>
                )}
                <span>{messageMetaTime(m.ts)}</span>
                {m.from_me && typeof m.ack === 'number' && (
                  (m.ack >= 3)
                    ? <CheckCheck size={17} />
                    : (m.ack === 2)
                      ? <CheckCheck size={17} />
                      : (m.ack === 1)
                        ? <Check size={17} />
                        : null
                )}
                {!m.from_me && (
                  <button
                    type="button"
                    onClick={() => toggleReactionPicker(m.id)}
                    style={{
                      color: reactionPickerFor === m.id ? '#d97757' : 'inherit',
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: 2,
                      marginLeft: 1,
                    }}
                    title="Reagieren"
                    aria-label="Reagieren"
                  >
                    <Smile size={16} strokeWidth={1.8} />
                  </button>
                )}
              </div>
            )}
            {reactionPickerFor === m.id && (
              <div id={`wa-reaction-picker-${m.id}`} style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 5, padding: 0 }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 9px',
                  borderRadius: 999,
                  background: 'var(--bg-2)',
                  border: '1px solid var(--mobile-chrome-border)',
                }}>
                  {REACTION_EMOJIS.map(e => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => sendReaction(m.id, e)}
                      style={{ fontSize: 21, lineHeight: 1, padding: 1 }}
                      aria-label={`Mit ${e} reagieren`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
        })}

        {/* Brain-Beratung: private Agent-Bubble, ohne Aktionen. */}
        {brainAdviceLoading && brainMessages.length === 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
            <div style={{
              padding: '8px 12px',
              borderRadius: 16,
              background: 'var(--bg-2)',
              color: 'var(--text-muted)',
              fontSize: 13,
              maxWidth: '80%',
            }}>
              <span className="quiet-presence-shimmer">{agentName} sortiert…</span>
            </div>
          </div>
        )}
        {brainMessages.map((msg, idx) => (
          <div key={`brain-${idx}`} style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 8 }}>
            <div style={{
              maxWidth: '80%',
              padding: '9px 12px',
              borderRadius: 16,
              background: 'var(--bg-2)',
              border: '1px solid rgba(217,119,87,0.32)',
              color: 'var(--text)',
              fontSize: 14,
              lineHeight: 1.38,
              wordBreak: 'break-word',
            }}>
              <div style={{ fontSize: 11, fontWeight: 650, color: '#d97757', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                {agentName}
                {idx === 0 && brainAdviceSaved && (
                  <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· gespeichert</span>
                )}
              </div>
              {renderAdviceText(msg)}
            </div>
          </div>
        ))}
        {brainMessages.length > 0 && !brainAdviceLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 6 }}>
            <button
              type="button"
              onClick={speakBrain}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 14,
                background: brainPlaying ? 'rgba(217,119,87,0.16)' : 'var(--bg-2)',
                border: '1px solid rgba(217,119,87,0.32)',
                color: brainPlaying ? '#d97757' : 'var(--text-muted)',
                fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {brainPlaying ? <Square size={15} fill="currentColor" /> : <Volume2 size={16} />}
              {brainPlaying ? 'Stopp' : 'Vorlesen'}
            </button>
          </div>
        )}

        {/* Draft-Bubble: orange, ohne Buttons (Senden/Verwerfen liegen im Composer) */}
        {draftLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <div style={{
              padding: '8px 12px',
              borderRadius: 16,
              background: 'rgba(217,119,87,0.18)',
              color: '#d97757',
              fontSize: 13,
            }}>
              <span className="status-shimmer-warm">{agentName} formuliert…</span>
            </div>
          </div>
        )}
        {draftText && !draftLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <div style={{
              maxWidth: '80%',
              padding: '8px 12px',
              borderRadius: 16,
              background: 'rgba(217,119,87,0.16)',
              border: '1px solid rgba(217,119,87,0.6)',
              color: 'var(--text)',
              fontSize: 14.5,
              lineHeight: 1.38,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {draftText}
            </div>
          </div>
        )}
        {draftNotice && draftText && !draftLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <div style={{ maxWidth: '80%', fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'right' }}>
              {draftNotice}
            </div>
          </div>
        )}
        {draftError && !draftLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <div style={{
              maxWidth: '80%',
              padding: '9px 12px',
              borderRadius: 16,
              background: 'var(--bg-2)',
              border: '1px solid rgba(217,119,87,0.45)',
              color: 'var(--text)',
              fontSize: 14,
              lineHeight: 1.38,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{draftNotice || 'Das ging schief, deine Eingabe ist noch da:'}</div>
              {draftError}
              <button
                type="button"
                onClick={() => {
                  if (!selected) return
                  window.dispatchEvent(new CustomEvent('deck:waDraftRetry', { detail: { chat_id: selected.id, hint: draftError } }))
                  setDraftError(null)
                }}
                style={{
                  marginTop: 8,
                  padding: '5px 12px',
                  borderRadius: 12,
                  border: '1px solid rgba(217,119,87,0.6)',
                  background: 'rgba(217,119,87,0.16)',
                  color: '#d97757',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Nochmal versuchen
              </button>
            </div>
          </div>
        )}
        <div ref={threadEndRef} />
      </div>
    </div>
  )
}
