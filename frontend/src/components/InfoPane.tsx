import React, { useState, useEffect, useCallback, useRef, useMemo, Suspense } from 'react'
import { Search, X, FileText, ChevronRight, FolderOpen, FolderClosed, Shield, Clock, Check, Pencil, ChevronLeft, MessageSquare, Inbox, Mail, Settings, Play, Loader2, ExternalLink, Paperclip, Trash2, History, Film, Star, FolderInput, Activity, Bot } from 'lucide-react'
import DOMPurify from 'dompurify'
import { getAllAgentsIncludingHidden, useMainAgentName } from '../agents'
import { playUISound } from '../uiSounds'
import { setPref } from '../prefs'
import { Guided } from './info-pane/utils/tree'
import { AgentFlowPane, type FlowSnapshot } from './AgentFlowPane'
import { fileIcon } from './info-pane/utils/fileIcon'
import { relativeTime } from './info-pane/utils/format'
import { SHORT_NAMES } from './info-pane/utils/constants'
import { stateColor, stateLabel, formatScheduled, type SocialState } from './info-pane/utils/social'
import { WorkspaceTree } from './info-pane/sections/WorkspaceTree'
import { FsBusProvider } from './info-pane/utils/fsBus'
import { formatWaTime } from './info-pane/utils/wa'
import { lazyWithRetry } from './info-pane/utils/lazyWithRetry'
import type { CronJob } from './info-pane/types'
import type { WorkspaceMode } from '../workspace'
import { INBOX_SEEN_CHANGED_EVENT, hasUnseenInboxWaiting, inboxMailWaitingKey, inboxWaWaitingKey, markInboxWaitingSeen } from '../inboxSeen'

// ── Lazy Sections (Code-Split: Chunks erst beim Aufklappen geladen) ──
// lazyWithRetry: bei Stale-Chunk nach Deploy einmal Page-Reload, dann frische Hashes.
const LimitsSection = lazyWithRetry(() => import('./info-pane/sections/LimitsSection').then(m => ({ default: m.LimitsSection })))
const WaChatView = lazyWithRetry(() => import('./info-pane/sections/WaChatView').then(m => ({ default: m.WaChatView })))
const CompanyAnalyticsSection = lazyWithRetry(() => import('./info-pane/sections/CompanyAnalyticsSection').then(m => ({ default: m.CompanyAnalyticsSection })))
const PeopleSection = lazyWithRetry(() => import('./info-pane/sections/PeopleSection').then(m => ({ default: m.PeopleSection })))
const FinanceSection = lazyWithRetry(() => import('./info-pane/sections/FinanceSection').then(m => ({ default: m.FinanceSection })))
const HealthSection = lazyWithRetry(() => import('./info-pane/sections/HealthSection').then(m => ({ default: m.HealthSection })))
const EnginesSection = lazyWithRetry(() => import('./info-pane/sections/EnginesSection').then(m => ({ default: m.EnginesSection })))
const SkillsSection = lazyWithRetry(() => import('./info-pane/sections/SkillsSection').then(m => ({ default: m.SkillsSection })))
const ToolApprovalsSection = lazyWithRetry(() => import('./info-pane/sections/ToolApprovalsSection').then(m => ({ default: m.ToolApprovalsSection })))
const SystemagentSection = lazyWithRetry(() => import('./info-pane/sections/SystemagentSection').then(m => ({ default: m.SystemagentSection })))
const ChatagentSection = lazyWithRetry(() => import('./info-pane/sections/ChatagentSection').then(m => ({ default: m.ChatagentSection })))
const PosteingangSection = lazyWithRetry(() => import('./info-pane/sections/PosteingangSection').then(m => ({ default: m.PosteingangSection })))
const InvoiceSection = lazyWithRetry(() => import('./info-pane/sections/InvoiceSection').then(m => ({ default: m.InvoiceSection })))
const RedaktionSection = lazyWithRetry(() => import('./info-pane/sections/RedaktionSection').then(m => ({ default: m.RedaktionSection })))
const DreamingSection = lazyWithRetry(() => import('./info-pane/sections/DreamingSection').then(m => ({ default: m.DreamingSection })))
const FokusSection = lazyWithRetry(() => import('./info-pane/sections/FokusSection').then(m => ({ default: m.FokusSection })))
const FileView = lazyWithRetry(() => import('./info-pane/sections/FileView').then(m => ({ default: m.FileView })))
const MailThreadView = lazyWithRetry(() => import('./info-pane/sections/MailThreadView').then(m => ({ default: m.MailThreadView })))
const CronDetail = lazyWithRetry(() => import('./info-pane/sections/CronDetail').then(m => ({ default: m.CronDetail })))
const PersonView = lazyWithRetry(() => import('./info-pane/sections/PersonView').then(m => ({ default: m.PersonView })))

const SectionFallback = <div className="text-[14px] text-[var(--t3)] px-3 py-2">Lädt …</div>

function readPaneCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`infopane:cache:${key}`)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed && 'data' in parsed ? parsed.data as T : fallback
  } catch {
    return fallback
  }
}

function writePaneCache(key: string, data: unknown) {
  try {
    localStorage.setItem(`infopane:cache:${key}`, JSON.stringify({ ts: Date.now(), data }))
  } catch {}
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

// Geoeffnete, aber noch nicht erledigte Mails bleiben sichtbar in "Wartet".
// Lesen markiert die Mail im Postfach zwar als gelesen, soll sie hier aber
// nicht aus dem Blick nehmen — erledigt wird erst durch Haken/Antwort.
const MAIL_KEPT_LOCAL_KEY = 'mail-kept-waiting'
function readKeptMailKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MAIL_KEPT_LOCAL_KEY) || '[]'))
  } catch {
    return new Set()
  }
}
function forgetKeptMail(account: string | undefined, uid: string | undefined) {
  const key = mailItemKey(account, uid)
  const keys = readKeptMailKeys()
  if (keys.delete(key)) {
    try { localStorage.setItem(MAIL_KEPT_LOCAL_KEY, JSON.stringify([...keys])) } catch {}
  }
}

function mergeMailInboxItems<T extends { account?: string; uid: string; ts?: number }>(prev: T[], next: T[], doneKeys: string[] = []): T[] {
  const archived = readArchivedMailKeys()
  const kept = readKeptMailKeys()
  const done = new Set(doneKeys)
  const byKey = new Map<string, T>()
  for (const item of prev) {
    const key = mailItemKey(item.account, item.uid)
    if (key && kept.has(key) && !archived.has(key) && !done.has(key)) byKey.set(key, item)
  }
  for (const item of next) {
    const key = mailItemKey(item.account, item.uid)
    if (key && !archived.has(key) && !done.has(key)) byKey.set(key, item)
  }
  return [...byKey.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

// ── Types ──

// Rule interface kept for future use
// interface Rule { source: string; label: string; color: string; name: string; path: string; category: string; protected?: boolean }
interface SearchResult { source: string; path: string; title: string; snippet: string }
interface ChatSearchResult { author: string; content: string; ts: number; agent: string; conversationId: string }

interface Reel {
  id: string
  file: string
  title: string
  url: string
  size_mb: number
  duration_sec: number | null
  rendered_at: number
  caption: string | null
  caption_path: string | null
  state?: SocialState
  approved?: boolean
  last_error?: string | null
  published: { started_at_str?: string; catbox_url?: string | null; ig_media_id?: string | null; published_at?: number | null } | null
  scheduled_for?: string | null
  scheduled_time?: string | null
  draft_title?: string | null
}

interface Karussell {
  id: string
  title: string
  slides: { n: number; url: string }[]
  slide_count: number
  rendered_at: number
  caption: string | null
  state?: SocialState
  approved?: boolean
  scheduled_for?: string | null
  last_error?: string | null
  published: { ig_media_id?: string; published_at?: number } | null
}

interface Beitrag {
  id: string
  title: string
  url: string
  rendered_at: number
  caption: string | null
  state?: SocialState
  approved?: boolean
  scheduled_for?: string | null
  last_error?: string | null
  published: { ig_media_id?: string; published_at?: number } | null
}

interface WaChat {
  id: string
  name: string
  is_group: boolean
  last_ts: number | null
  unread: number
  preview: string
  last_from_me: boolean
  triage?: 'waiting_on_me' | 'waiting_on_them' | 'done' | null
  is_archived?: boolean
  is_pinned?: boolean
  has_profile_pic?: boolean
  pinned_project_id?: string
  pinned_project_name?: string
}

// ── Shared Components ──

function Section({ label, icon: Icon, defaultOpen, count: _count, unreadCount: _unreadCount, action, children, mobile, forceOpenSignal, iconClassName }: {
  label: string; icon?: typeof Shield; color?: string; defaultOpen?: boolean; count?: number; unreadCount?: number; action?: React.ReactNode; children: React.ReactNode; mobile?: boolean; forceOpenSignal?: number; iconClassName?: string
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  // Externer Force-Open-Trigger (z.B. Voice-Kommando "Jobs auf").
  // Bei jedem Tick des Counters klappen wir die Sektion zwingend auf.
  const lastSignalRef = useRef<number | undefined>(forceOpenSignal)
  useEffect(() => {
    if (forceOpenSignal !== undefined && forceOpenSignal !== lastSignalRef.current) {
      lastSignalRef.current = forceOpenSignal
      setOpen(true)
    }
  }, [forceOpenSignal])
  return (
    <div className="info-top-section">
      <div className="flex items-center">
        <button onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
          className={`flex-1 flex items-center pr-3 ${mobile ? 'py-3' : 'py-2'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
          style={{ paddingLeft: '8px' }}>
          <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
          {Icon && <Icon className={`info-icon-md mr-2 flex-shrink-0 ${iconClassName ?? 'text-[var(--t3)]'}`} />}
          <span className="text-[var(--t2)] font-medium flex-1">{label}</span>
        </button>
        {action && <div className="pr-3">{action}</div>}
      </div>
      {open && <div className="pb-2"><Guided>{children}</Guided></div>}
    </div>
  )
}

function PaneGroupHeader({ label, mobile }: { label: string; mobile?: boolean }) {
  return (
    <div className={`${mobile ? 'px-5 pt-4 pb-2' : 'px-6 pt-3 pb-1.5'}`}>
      <div className="flex items-center gap-3">
        <span className="info-text-meta uppercase tracking-[0.18em] text-[var(--t3)]/70 flex-shrink-0">{label}</span>
        <div className="h-px flex-1 bg-[var(--border)]/40" />
      </div>
    </div>
  )
}

type SectionGroup = 'core' | 'agents' | 'custom'

const DEFAULT_SECTION_ORDER: Record<SectionGroup, string[]> = {
  core: ['agent-flow', 'workspace', 'agent', 'dreaming', 'heartbeat', 'engines', 'skills', 'tool-approvals', 'whatsapp', 'mail', 'artifacts', 'settings'],
  agents: ['rechnung', 'pionierplaner', 'posteingang', 'systemkreis', 'chatagent'],
  custom: ['health', 'limits', 'social', 'finance', 'company-analytics', 'people'],
}

const SHOW_AGENT_FLOW = false

function loadSectionOrder(group: SectionGroup): string[] {
  const defaults = DEFAULT_SECTION_ORDER[group]
  try {
    const raw = localStorage.getItem(`infopane:section-order:${group}`)
    if (!raw) return [...defaults]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...defaults]
    const valid = parsed.filter((id: string) => defaults.includes(id))
    const missing = defaults.filter(id => !valid.includes(id))
    return [...valid, ...missing]
  } catch {
    return [...defaults]
  }
}

function moveSection(list: string[], fromId: string, toId: string): string[] {
  const from = list.indexOf(fromId)
  const to = list.indexOf(toId)
  if (from === -1 || to === -1 || from === to) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function sameSectionOrder(a: Record<SectionGroup, string[]>, b: Record<SectionGroup, string[]>): boolean {
  return a.core.join('|') === b.core.join('|') && a.agents.join('|') === b.agents.join('|') && a.custom.join('|') === b.custom.join('|')
}

function SortableSection({
  sectionId,
  dataInfoSection,
  group,
  mobile,
  order,
  dragging,
  dropTarget,
  onDragStartSection,
  onDragOverSection,
  onDropSection,
  onDragEndSection,
  children,
}: {
  sectionId: string
  dataInfoSection: string
  group: SectionGroup
  mobile?: boolean
  order: number
  dragging: { group: SectionGroup; id: string } | null
  dropTarget: { group: SectionGroup; id: string } | null
  onDragStartSection: (group: SectionGroup, id: string) => void
  onDragOverSection: (group: SectionGroup, id: string, e: React.DragEvent<HTMLDivElement>) => void
  onDropSection: (group: SectionGroup, id: string) => void
  onDragEndSection: () => void
  children: React.ReactNode
}) {
  const isDragging = !mobile && dragging?.group === group && dragging.id === sectionId
  const isDropTarget = !mobile && dropTarget?.group === group && dropTarget.id === sectionId
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('input[type="range"]')) {
      e.preventDefault()
      return
    }
    onDragStartSection(group, sectionId)
  }
  return (
    <div
      data-info-section={dataInfoSection}
      draggable={!mobile}
      onDragStart={handleDragStart}
      onDragOver={e => onDragOverSection(group, sectionId, e)}
      onDrop={() => onDropSection(group, sectionId)}
      onDragEnd={onDragEndSection}
      className={`info-top-section ${!mobile ? 'cursor-grab' : ''} ${isDragging ? 'opacity-60' : ''} ${isDropTarget ? 'ring-1 ring-[var(--cc-orange)]/40 bg-white/[0.03]' : ''}`}
      style={{ order }}
      title={!mobile ? 'Zum Sortieren ziehen' : undefined}
    >
      {children}
    </div>
  )
}

// ── Personen — ausgelagert nach info-pane/sections/PeopleSection.tsx (reine People-DB-Sicht) ──


// ── Finanzen — ausgelagert nach info-pane/sections/FinanceSection.tsx ──



// ── File Viewer — ausgelagert nach info-pane/sections/FileView.tsx ──


// ── Cron Detail — ausgelagert nach info-pane/sections/CronDetail.tsx ──


// ── Mail Thread View — ausgelagert nach info-pane/sections/MailThreadView.tsx ──


// ── Main InfoPane ──

interface SysStatus {
  gateway: boolean
  gatewayLatencyMs: number
  version: string
  crons: { total: number; ok: number; errors: number }
}

export function InfoPane({ activeAgent, activeConversationId, visibleConversationIds, externalFile, onExternalFileConsumed, externalWaChat, onExternalWaChatConsumed, externalMailThread, onExternalMailThreadConsumed, sysStatus: _sysStatus, onScrollToMessage, onSwitchConversation: _onSwitchConversation, onNewChat: _onNewChat, onOpenSearch, onClose, mobile, voiceReady: _voiceReady, voiceActive: _voiceActive, onToggleVoice: _onToggleVoice, onOpenWorkspaceMode, onOpenWorkspaceFile }: {
  activeAgent: string
  activeConversationId?: string
  visibleConversationIds?: string[]
  externalFile?: string
  onExternalFileConsumed?: () => void
  externalWaChat?: string
  onExternalWaChatConsumed?: () => void
  externalMailThread?: { account: string; uid: string } | null
  onExternalMailThreadConsumed?: () => void
  sysStatus?: SysStatus | null
  onScrollToMessage?: (agent: string, conversationId: string, ts: number) => void
  onSwitchConversation?: (agent: string, conversationId: string) => void
  onNewChat?: (agent: string) => void
  onOpenSearch?: () => void
  onClose?: () => void
  mobile?: boolean
  voiceReady?: boolean
  voiceActive?: boolean
  onToggleVoice?: () => void
  onOpenWorkspaceMode?: (mode: WorkspaceMode) => void
  onOpenWorkspaceFile?: (path: string) => boolean
}) {
  const agentName = useMainAgentName()
  // All crons from all agents
  const [allCrons, setAllCrons] = useState<(CronJob & { agentId: string; agentName: string; agentColor: string })[]>(() => readPaneCache('allCrons', []))

  useEffect(() => {
    const loadAllCrons = () => {
      Promise.all(getAllAgentsIncludingHidden().filter(ag => !ag.hidden).map(ag =>
        fetch(`/api/agent-detail?agent=${encodeURIComponent(ag.id)}`)
          .then(r => r.json())
          .then(d => (d.crons || []).map((c: CronJob) => ({ ...c, agentId: ag.id, agentName: SHORT_NAMES[ag.id] || ag.name, agentColor: ag.color })))
          .catch(() => [])
      )).then(results => {
        const flat = results.flat()
        setAllCrons(flat)
        writePaneCache('allCrons', flat)
      })
    }
    const start = window.setTimeout(loadAllCrons, 80)
    const interval = setInterval(loadAllCrons, 30000)
    return () => { window.clearTimeout(start); clearInterval(interval) }
  }, [])

  const [flowSnapshots, setFlowSnapshots] = useState<FlowSnapshot[]>([])
  const [flowLoading, setFlowLoading] = useState(true)

  useEffect(() => {
    if (!SHOW_AGENT_FLOW) {
      setFlowLoading(false)
      return
    }
    // Adaptives Polling statt stur alle 2s: schnell nur, solange wirklich ein
    // Stream laeuft (fuer fluessige Flow-Anzeige), sonst traege, und im
    // Hintergrund-Tab gar nicht. So feuert die rechte Spalte im Leerlauf nicht
    // pausenlos den Server an und blockiert nichts.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const ACTIVE_MS = 2000
    const IDLE_MS = 15000
    function schedule(ms: number) {
      if (cancelled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, ms)
    }
    async function tick() {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hidden) { schedule(IDLE_MS); return }
      let hadActive = false
      try {
        const res = await fetch('/api/active-streams/snapshots')
        const data = await res.json()
        if (cancelled) return
        const snaps = Array.isArray(data?.snapshots) ? data.snapshots : []
        hadActive = snaps.length > 0
        setFlowSnapshots(snaps)
      } catch {
        if (cancelled) return
        setFlowSnapshots([])
      } finally {
        if (!cancelled) setFlowLoading(false)
      }
      schedule(hadActive ? ACTIVE_MS : IDLE_MS)
    }
    const onVis = () => { if (!document.hidden) { if (timer) clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVis)
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const selectedFlowSnapshot = useMemo(() => {
    if (!flowSnapshots.length) return null
    if (activeConversationId) {
      const active = flowSnapshots.find(s => s.conversationId === activeConversationId)
      if (active) return active
    }
    const visible = (visibleConversationIds || []).filter(Boolean)
    for (const convId of visible) {
      const hit = flowSnapshots.find(s => s.conversationId === convId)
      if (hit) return hit
    }
    return flowSnapshots[0] || null
  }, [activeConversationId, flowSnapshots, visibleConversationIds])

  // ── Navigation stack (Drill-in History) ──
  // Ersetzt die alten Einzel-States (selectedCron / openFile / waSelectedChatId).
  // Mobile-Back und onBack/onClose einer Detail-View poppen einen Schritt,
  // statt alles auf einmal zu schließen.
  type PaneView =
    | { type: 'file'; path: string }
    | { type: 'cron'; cron: CronJob & { agentColor?: string; agentId?: string; agentName?: string } }
    | { type: 'wa-chat'; chatId: string }
    | { type: 'mail-thread'; account: string; uid: string }
    | { type: 'reel'; id: string }
    | { type: 'person'; personId: number }
  const [stack, setStack] = useState<PaneView[]>(() => {
    try {
      const raw = localStorage.getItem('infopane:stack')
      if (!raw) return []
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter((v: PaneView) => v && v.type !== 'cron') : []
    } catch { return [] }
  })
  useEffect(() => {
    try {
      const safe = stack.filter(v => v.type !== 'cron')
      localStorage.setItem('infopane:stack', JSON.stringify(safe))
    } catch {}
  }, [stack])
  const top: PaneView | null = stack.length > 0 ? stack[stack.length - 1] : null
  // Scroll-Container der InfoPane plus ein Stack pro pushView gesicherter Scroll-Positionen.
  // Damit landet popView() aus FileView/WaChat/Mail wieder genau dort, wo der Klick war —
  // statt oben in der Pane (Bug: Workspace stand vorher unten, "Zurück" warf an den Anfang).
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollStack = useRef<number[]>([])
  const pushView = useCallback((v: PaneView) => {
    playUISound('view-open', 0.5)
    scrollStack.current.push(scrollRef.current?.scrollTop ?? 0)
    setStack(s => [...s, v])
  }, [])
  const openFileTarget = useCallback((path: string) => {
    if (onOpenWorkspaceFile?.(path)) return
    pushView({ type: 'file', path })
  }, [onOpenWorkspaceFile, pushView])
  const popView = useCallback(() => {
    playUISound('view-back', 0.5)
    setStack(s => s.slice(0, -1))
    const y = scrollStack.current.pop() ?? 0
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = y })
  }, [])
  const replaceTop = useCallback((v: PaneView) => setStack(s => s.length > 0 ? [...s.slice(0, -1), v] : [v]), [])
  const clearStack = useCallback(() => { scrollStack.current = []; setStack([]) }, [])
  const openFile = top?.type === 'file' ? top.path : ''
  const selectedCron = top?.type === 'cron' ? top.cron : null
  const waSelectedChatId = top?.type === 'wa-chat' ? top.chatId : ''
  const mailThread = top?.type === 'mail-thread' ? top : null
  const expandedReel = top?.type === 'reel' ? top.id : ''
  const personViewId = top?.type === 'person' ? top.personId : 0

  // Files-Vollbild-Modus: blendet alle anderen InfoPane-Sektionen aus,
  // damit der Workspace-Tree die ganze Pane übernimmt mit Breadcrumb,
  // View-Switcher und Listen-Modus oben.
  const [fsFullMode, setFsFullMode] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:fs:fullMode') === '1' } catch { return false }
  })
  const toggleFsFullMode = useCallback((next?: boolean) => {
    setFsFullMode(prev => {
      const v = typeof next === 'boolean' ? next : !prev
      try { localStorage.setItem('infopane:fs:fullMode', v ? '1' : '0') } catch {}
      return v
    })
  }, [])

  // Search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [chatResults, setChatResults] = useState<ChatSearchResult[]>([])
  const [fileResults, setFileResults] = useState<{ name: string; path: string; source: string; color: string; relative: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [searchAgent] = useState(false)
  type SearchTime = 'all' | 'today' | 'week' | 'month'
  type SearchType = 'all' | 'chat' | 'wa' | 'docs' | 'files'
  const [searchTime, setSearchTime] = useState<SearchTime>('all')
  const [searchType, setSearchType] = useState<SearchType>('all')
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('infopane:recentSearches') || '[]') } catch { return [] }
  })
  const sinceForTime = (t: SearchTime): number => {
    const now = Date.now() / 1000
    if (t === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() / 1000 }
    if (t === 'week') return now - 7 * 86400
    if (t === 'month') return now - 30 * 86400
    return 0
  }
  const pushRecentSearch = useCallback((q: string) => {
    const v = q.trim()
    if (v.length < 2) return
    setRecentSearches(prev => {
      const next = [v, ...prev.filter(x => x.toLowerCase() !== v.toLowerCase())].slice(0, 6)
      try { localStorage.setItem('infopane:recentSearches', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])
  const clearRecentSearches = useCallback(() => {
    setRecentSearches([])
    try { localStorage.removeItem('infopane:recentSearches') } catch {}
  }, [])

  // Social Media: Reels, Karussells, Beiträge
  const [reels, setReels] = useState<Reel[]>(() => readPaneCache('social:reels', []))
  const [karussells, setKarussells] = useState<Karussell[]>(() => readPaneCache('social:karussells', []))
  const [beitraege, setBeitraege] = useState<Beitrag[]>(() => readPaneCache('social:beitraege', []))

  const [expandedKarussell, setExpandedKarussell] = useState<string | null>(null)
  const [expandedBeitrag, setExpandedBeitrag] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null)
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLightbox(null); return }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        setLightbox(p => p ? { ...p, index: (p.index - 1 + p.urls.length) % p.urls.length } : p)
        e.preventDefault()
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        setLightbox(p => p ? { ...p, index: (p.index + 1) % p.urls.length } : p)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  // WhatsApp
  const [waChats, setWaChats] = useState<WaChat[]>(() => readPaneCache('wa:chats', []))
  const waActiveChats = useMemo(() => waChats.filter(c => !c.is_archived), [waChats])
  const [waSearchResults, setWaSearchResults] = useState<{ id: string; chat_id: string; chat_name: string; ts: number; from_me: boolean; type: string; snippet: string }[]>([])

  const loadWaChats = useCallback(async () => {
    try {
      const r = await fetch('/api/whatsapp/chats?limit=200')
      const d = await r.json()
      const all: WaChat[] = Array.isArray(d.chats) ? d.chats : []
      const active = all.filter(c => !c.is_archived)
      setWaChats(active)
      writePaneCache('wa:chats', active)
    } catch {}
  }, [])

  useEffect(() => {
    const onSent = (e: Event) => {
      const ce = e as CustomEvent<{ chatId: string }>
      const sentId = ce.detail?.chatId
      if (!sentId) return
      const now = Math.floor(Date.now() / 1000)
      setWaChats(prev => prev.map(c => c.id === sentId
        ? { ...c, last_ts: now, last_from_me: true, triage: c.triage === 'waiting_on_me' ? null : c.triage }
        : c))
      setTimeout(loadWaChats, 1200)
    }
    window.addEventListener('wa:sent', onSent as EventListener)
    return () => window.removeEventListener('wa:sent', onSent as EventListener)
  }, [loadWaChats])


  // Mail (IMAP)
  type MailThread = { uid: string; message_id: string; account?: string; account_name?: string; account_email?: string; from: string; from_raw: string; subject: string; snippet: string; ts: number; unread: boolean; starred?: boolean; to_me: boolean; has_attachment?: boolean; category?: string; bucket?: string; bucket_reason?: string; unsubscribe_url?: string }
  type InboxMailItem = MailThread & { replied?: boolean; inbox_context?: { person_id?: number; person_name?: string; company?: string; reason?: string; active_customer?: boolean; projects?: Array<{ id: number; slug: string; name: string }> } }
  type MailRules = { rules?: Array<{category: string; label?: string}>; tabs?: string[]; tab_labels?: Record<string,string>; folders?: string[] }
  const DEFAULT_MAIL_RULES: MailRules = {
    tabs: ['primary'],
    folders: ['attention', 'rechnung', 'rest'],
    tab_labels: {
      all: 'Alle',
      attention: 'Aufmerksamkeit',
      primary: 'Rest',
      rest: 'Rest',
      company: 'Company AI',
      fch: 'FCH',
      amazon: 'Amazon',
      rechnung: 'Rechnung',
      newsletter: 'Newsletter',
    },
  }
  const [mailAccounts, setMailAccounts] = useState<Array<{ key: string; name: string; email: string }>>(() => readPaneCache('mail:accounts', []))
  const [mailAccount, setMailAccount] = useState<string>(() => readPaneCache('mail:account', ''))
  const [mailThreads, setMailThreads] = useState<MailThread[]>([])
  const [mailInboxItems, setMailInboxItems] = useState<InboxMailItem[]>(() => readPaneCache('mail:inboxItems', []))
  const [mailLoading, setMailLoading] = useState(false)
  const [mailError, setMailError] = useState<string>('')
  const [mailCategory, setMailCategory] = useState<string>('all')
  const [mailQuery, setMailQuery] = useState<string>('')
  const [mailSearchOpen, setMailSearchOpen] = useState<boolean>(false)
  const mailSearchInputRef = useRef<HTMLInputElement | null>(null)
  const [mailRules, setMailRules] = useState<MailRules>(() => readPaneCache('mail:rules', DEFAULT_MAIL_RULES))
  const [mailBlocklist, setMailBlocklist] = useState<string[]>(() => readPaneCache('mail:blocklist', []))
  const [mailShowBlocked, setMailShowBlocked] = useState(false)
  const [mailLabels, setMailLabels] = useState<string[]>([])
  const [mailMovePicker, setMailMovePicker] = useState<string>('')
  const inboxWaitingKeys = useMemo(() => [
    ...waActiveChats.filter(c => c.triage === 'waiting_on_me').map(inboxWaWaitingKey),
    ...mailInboxItems.filter(m => !m.replied).map(inboxMailWaitingKey),
  ], [waActiveChats, mailInboxItems])
  const [inboxSeenVersion, setInboxSeenVersion] = useState(0)
  const inboxHasNotice = useMemo(() => hasUnseenInboxWaiting(inboxWaitingKeys), [inboxWaitingKeys, inboxSeenVersion])
  const markCurrentInboxSeen = useCallback(() => {
    markInboxWaitingSeen(inboxWaitingKeys)
    setInboxSeenVersion(v => v + 1)
  }, [inboxWaitingKeys])
  useEffect(() => {
    const tick = () => setInboxSeenVersion(v => v + 1)
    window.addEventListener(INBOX_SEEN_CHANGED_EVENT, tick)
    return () => window.removeEventListener(INBOX_SEEN_CHANGED_EVENT, tick)
  }, [])
  const filteredMailThreads = useMemo(() => {
    if (!mailCategory || mailCategory === 'all') return mailThreads
    const wanted = mailCategory === 'rest' ? 'primary' : mailCategory
    return mailThreads.filter(t => (t.bucket || t.category || 'primary') === mailCategory || (t.category || 'primary') === wanted)
  }, [mailCategory, mailThreads])

  const toggleMailStar = useCallback(async (uid: string, on: boolean, account?: string) => {
    const acc = account || mailAccount
    setMailThreads(prev => prev.map(x => x.uid === uid && (x.account || mailAccount) === acc ? { ...x, starred: on } : x))
    try {
      await fetch('/api/mail/star', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: acc, uid, on }),
      })
    } catch {
      setMailThreads(prev => prev.map(x => x.uid === uid && (x.account || mailAccount) === acc ? { ...x, starred: !on } : x))
    }
  }, [mailAccount])

  const loadMailLabels = useCallback(async (key?: string) => {
    const k = key || mailAccount
    if (!k) return
    try {
      const r = await fetch(`/api/mail/labels?account=${encodeURIComponent(k)}`)
      const d = await r.json()
      setMailLabels(d.labels || [])
    } catch { setMailLabels([]) }
  }, [mailAccount])

  const moveMailThread = useCallback(async (uid: string, label: string, account?: string) => {
    if (!label) return
    const acc = account || mailAccount
    const original = mailThreads
    setMailThreads(prev => prev.filter(x => !(x.uid === uid && (x.account || mailAccount) === acc)))
    setMailMovePicker('')
    try {
      const r = await fetch('/api/mail/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: acc, uid, label }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
    } catch {
      setMailThreads(original)
    }
  }, [mailAccount, mailThreads])
  const loadMailAccounts = useCallback(() => {
    fetch('/api/mail/accounts').then(r => r.json())
      .then(d => {
        const accs = d.accounts || []
        setMailAccounts(accs)
        writePaneCache('mail:accounts', accs)
        const hasUnified = accs.some((a: { key: string }) => a.key === 'all')
        const currentValid = accs.some((a: { key: string }) => a.key === mailAccount)
        const preferred = hasUnified ? 'all' : accs.find((a: { key: string }) => a.key === 'company')?.key || accs[0]?.key || ''
        const nextAccount = hasUnified ? 'all' : (currentValid ? mailAccount : preferred)
        if (nextAccount && nextAccount !== mailAccount) setMailAccount(nextAccount)
      }).catch(() => {})
  }, [mailAccount])
  const loadMailThreads = useCallback(async (account?: string, category?: string, query?: string) => {
    const key = account || mailAccount
    if (!key) return
    const cat = category ?? mailCategory
    const q = query ?? mailQuery
    setMailLoading(true); setMailError('')
    try {
      const params = new URLSearchParams({ account: key, limit: '50' })
      if (q) params.set('q', q)
      if (cat && cat !== 'all') params.set('category', cat)
      const r = await fetch(`/api/mail/threads?${params.toString()}`)
      const d = await r.json()
      if (d.error) { setMailError(d.error); setMailThreads([]) }
      else {
        setMailThreads(d.threads || [])
        if (d.rules) {
          setMailRules(d.rules)
          writePaneCache('mail:rules', d.rules)
        }
        if (category !== undefined) setMailCategory(cat)
      }
    } catch (e) {
      setMailError(String(e)); setMailThreads([])
    } finally {
      setMailLoading(false)
    }
  }, [mailAccount, mailCategory, mailQuery])
  const loadMailInboxItems = useCallback(() => {
    fetch('/api/inbox/mail-attention?limit=80').then(r => r.json())
      .then(d => {
        const next: InboxMailItem[] = Array.isArray(d.items) ? d.items : []
        const doneKeys: string[] = Array.isArray(d.done_keys) ? d.done_keys : []
        setMailInboxItems(prev => {
          const merged = mergeMailInboxItems(prev, next, doneKeys)
          writePaneCache('mail:inboxItems', merged)
          return merged
        })
      }).catch(() => {})
  }, [])
  useEffect(() => { writePaneCache('mail:account', mailAccount) }, [mailAccount])
  const loadMailBlocklist = useCallback(() => {
    fetch('/api/mail/blocklist').then(r => r.json())
      .then(d => {
        const next = d.blocked || []
        setMailBlocklist(next)
        writePaneCache('mail:blocklist', next)
      }).catch(() => {})
  }, [])
  const blockMailSender = useCallback(async (entry: string) => {
    if (!entry) return
    try {
      const r = await fetch('/api/mail/block', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry }),
      })
      const d = await r.json()
      if (d.blocked) setMailBlocklist(d.blocked)
      loadMailThreads()
    } catch {}
  }, [loadMailThreads])
  const unblockMailSender = useCallback(async (entry: string) => {
    try {
      const r = await fetch('/api/mail/unblock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry }),
      })
      const d = await r.json()
      if (d.blocked) setMailBlocklist(d.blocked)
      loadMailThreads()
    } catch {}
  }, [loadMailThreads])
  const loadReels = useCallback(() => {
    fetch('/api/reels').then(r => r.json())
      .then(d => {
        const next = d.reels || []
        setReels(next)
        writePaneCache('social:reels', next)
      })
      .catch(() => {})
  }, [])
  const loadKarussells = useCallback(() => {
    fetch('/api/karussells').then(r => r.json())
      .then(d => {
        const next = d.karussells || []
        setKarussells(next)
        writePaneCache('social:karussells', next)
      })
      .catch(() => {})
  }, [])
  const loadBeitraege = useCallback(() => {
    fetch('/api/beitraege').then(r => r.json())
      .then(d => {
        const next = d.beitraege || []
        setBeitraege(next)
        writePaneCache('social:beitraege', next)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const start = window.setTimeout(() => {
      loadReels()
      loadKarussells()
      loadBeitraege()
    }, 120)
    return () => window.clearTimeout(start)
  }, [loadReels, loadKarussells, loadBeitraege])

  // Social Media: Approve / Verwerfen
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const encSlug = (s: string) => s.split('/').map(encodeURIComponent).join('/')
  const approveKarussell = useCallback(async (slug: string) => {
    setBusyAction(`approve:k:${slug}`)
    try {
      const r = await fetch(`/api/karussells/${encSlug(slug)}/approve`, { method: 'POST' })
      if (!r.ok) { console.error(await r.text()); return }
      loadKarussells()
    } finally { setBusyAction(null) }
  }, [loadKarussells])
  const deleteKarussell = useCallback(async (slug: string) => {
    if (!confirm('Karussell verwerfen? (bleibt auf der Platte, raus aus der Pane)')) return
    setBusyAction(`del:k:${slug}`)
    try {
      const r = await fetch(`/api/karussells/${encSlug(slug)}`, { method: 'DELETE' })
      if (r.ok) { setExpandedKarussell(null); loadKarussells() }
      else console.error(await r.text())
    } finally { setBusyAction(null) }
  }, [loadKarussells])
  const approveBeitrag = useCallback(async (slug: string) => {
    setBusyAction(`approve:b:${slug}`)
    try {
      const r = await fetch(`/api/beitraege/${encodeURIComponent(slug)}/approve`, { method: 'POST' })
      if (!r.ok) { console.error(await r.text()); return }
      loadBeitraege()
    } finally { setBusyAction(null) }
  }, [loadBeitraege])
  const deleteBeitrag = useCallback(async (slug: string) => {
    if (!confirm('Beitrag verwerfen? (bleibt auf der Platte, raus aus der Pane)')) return
    setBusyAction(`del:b:${slug}`)
    try {
      const r = await fetch(`/api/beitraege/${encodeURIComponent(slug)}`, { method: 'DELETE' })
      if (r.ok) { setExpandedBeitrag(null); loadBeitraege() }
      else console.error(await r.text())
    } finally { setBusyAction(null) }
  }, [loadBeitraege])
  const approveReel = useCallback(async (stem: string) => {
    setBusyAction(`approve:r:${stem}`)
    try {
      const r = await fetch(`/api/reels/${encodeURIComponent(stem)}/approve`, { method: 'POST' })
      if (!r.ok) { console.error(await r.text()); return }
      loadReels()
    } finally { setBusyAction(null) }
  }, [loadReels])
  const deleteReel = useCallback(async (stem: string) => {
    if (!confirm('Reel verwerfen? (bleibt auf der Platte, raus aus der Pane)')) return
    setBusyAction(`del:r:${stem}`)
    try {
      const r = await fetch(`/api/reels/${encodeURIComponent(stem)}`, { method: 'DELETE' })
      if (r.ok) loadReels()
      else console.error(await r.text())
    } finally { setBusyAction(null) }
  }, [loadReels])

  // Section toggles
  const [sections] = useState<Record<string, boolean>>({
    jobs: false, crons: false, system: false, reels: false, config: false,
  })
  const [sectionOrder, setSectionOrder] = useState<Record<SectionGroup, string[]>>(() => ({
    core: loadSectionOrder('core'),
    agents: loadSectionOrder('agents'),
    custom: loadSectionOrder('custom'),
  }))
  const [draggingSection, setDraggingSection] = useState<{ group: SectionGroup; id: string } | null>(null)
  const [dropTargetSection, setDropTargetSection] = useState<{ group: SectionGroup; id: string } | null>(null)
  useEffect(() => {
    try {
      setPref('infopane:section-order:core', JSON.stringify(sectionOrder.core))
      setPref('infopane:section-order:agents', JSON.stringify(sectionOrder.agents))
      setPref('infopane:section-order:custom', JSON.stringify(sectionOrder.custom))
      window.dispatchEvent(new CustomEvent('infopane:section-order-sync', { detail: sectionOrder }))
    } catch {}
  }, [sectionOrder])
  useEffect(() => {
    const syncFromStorage = () => {
      const next = {
        core: loadSectionOrder('core'),
        agents: loadSectionOrder('agents'),
        custom: loadSectionOrder('custom'),
      }
      setSectionOrder(prev => sameSectionOrder(prev, next) ? prev : next)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key !== 'infopane:section-order:core' && e.key !== 'infopane:section-order:agents' && e.key !== 'infopane:section-order:custom') return
      syncFromStorage()
    }
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<Record<SectionGroup, string[]>>).detail
      if (!detail) {
        syncFromStorage()
        return
      }
      setSectionOrder(prev => sameSectionOrder(prev, detail) ? prev : detail)
    }
    const onRemotePrefs = () => {
      syncFromStorage()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('infopane:section-order-sync', onCustom as EventListener)
    window.addEventListener('deck:prefsRemoteUpdate', onRemotePrefs)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('infopane:section-order-sync', onCustom as EventListener)
      window.removeEventListener('deck:prefsRemoteUpdate', onRemotePrefs)
    }
  }, [])
  const getSectionOrder = useCallback((group: SectionGroup, id: string) => {
    const idx = sectionOrder[group].indexOf(id)
    return idx >= 0 ? idx : 999
  }, [sectionOrder])
  const handleSectionDragStart = useCallback((group: SectionGroup, id: string) => {
    setDraggingSection({ group, id })
    setDropTargetSection(null)
  }, [])
  const handleSectionDragOver = useCallback((group: SectionGroup, id: string, e: React.DragEvent<HTMLDivElement>) => {
    if (!draggingSection || draggingSection.group !== group || draggingSection.id === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetSection(cur => cur?.group === group && cur.id === id ? cur : { group, id })
  }, [draggingSection])
  const clearSectionDrag = useCallback(() => {
    setDraggingSection(null)
    setDropTargetSection(null)
  }, [])
  const handleSectionDrop = useCallback((group: SectionGroup, id: string) => {
    if (!draggingSection || draggingSection.group !== group || draggingSection.id === id) {
      clearSectionDrag()
      return
    }
    setSectionOrder(prev => ({
      ...prev,
      [group]: moveSection(prev[group], draggingSection.id, id),
    }))
    clearSectionDrag()
  }, [clearSectionDrag, draggingSection])
  const [subOpen, setSubOpen] = useState<Record<string, boolean>>({})
  const toggleSub = (key: string) => setSubOpen(p => {
    const next = !p[key]
    playUISound(next ? 'section-open' : 'section-close')
    return { ...p, [key]: next }
  })
  useEffect(() => {
    loadWaChats()
    const tick = () => { if (document.visibilityState === 'visible') loadWaChats() }
    const interval = window.setInterval(tick, 60000)
    window.addEventListener('wa:sent', tick)
    window.addEventListener('deck:inboxChanged', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('wa:sent', tick)
      window.removeEventListener('deck:inboxChanged', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadWaChats])
  useEffect(() => {
    if (!(subOpen['gmail'] || mailThread)) return
    loadMailAccounts()
    if (false) loadMailBlocklist()
  }, [loadMailAccounts, loadMailBlocklist, mailThread, subOpen])
  useEffect(() => {
    if (false && mailAccount && (subOpen['gmail'] || mailThread)) loadMailLabels(mailAccount)
  }, [mailAccount, loadMailLabels, mailThread, subOpen])

  useEffect(() => {
    if (!mailAccount || !subOpen['gmail'] || mailLoading || mailThreads.length > 0) return
    loadMailThreads(mailAccount)
  }, [mailAccount, mailLoading, mailThreads.length, loadMailThreads, subOpen])

  // Auto-Refresh: alle 5 Minuten im Hintergrund + beim Tab-Fokus, sobald ein Account da ist.
  // Backend-Cache (60s) federt zu dichte Aufrufe ab, IMAP wird nur einmal pro Minute echt gefragt.
  useEffect(() => {
    if (!mailAccount) return
    if (!(subOpen['gmail'] || mailThread)) return
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      loadMailThreads()
    }
    const onVis = () => { if (document.visibilityState === 'visible') loadMailThreads() }
    const id = window.setInterval(tick, 300000)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [mailAccount, loadMailThreads, mailThread, subOpen])
  useEffect(() => {
    loadMailInboxItems()
    const tick = () => { if (document.visibilityState === 'visible') loadMailInboxItems() }
    const id = window.setInterval(tick, 60000)
    window.addEventListener('wa:sent', tick)
    window.addEventListener('deck:inboxChanged', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('wa:sent', tick)
      window.removeEventListener('deck:inboxChanged', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [loadMailInboxItems])

  // Externe Trigger: Einstellungs-Sektion aufklappen, wenn z.B. der
  // mobile Composer seinen Zahnrad-Button ruft.
  useEffect(() => {
    const onOpen = () => {
      if (onOpenWorkspaceMode) onOpenWorkspaceMode('settings')
      else setSubOpen(p => ({ ...p, settings: true }))
    }
    window.addEventListener('deck:openInfoSettings', onOpen)
    return () => window.removeEventListener('deck:openInfoSettings', onOpen)
  }, [onOpenWorkspaceMode])

  // Force-Open-Signale für Sektionen mit eigenem internen `<Section>`-State
  // (Jobs, Social Media). Voice-Kommando "Jobs auf" bumpt den Counter,
  // die Section-Komponente reagiert via useEffect.
  const [socialForceSignal, setSocialForceSignal] = useState(0)
  const [skillsForceSignal, setSkillsForceSignal] = useState(0)

  // Voice-Sprung in eine Sektion: setze passende subOpen-Flags / Force-Signale
  // und scrolle den Anker in den Viewport. Workspace zwingt Full-Mode aus.
  useEffect(() => {
    const onSection = (e: Event) => {
      const section = String((e as CustomEvent).detail?.section || '').trim()
      if (!section) return
      if (section === 'workspace' && onOpenWorkspaceMode) { onOpenWorkspaceMode('filesystem'); return }
      if (section !== 'workspace' && fsFullMode) toggleFsFullMode(false)
      // Drill-in-Stack zurücksetzen, sonst blockiert er die Section-Liste
      if (stack.length > 0) clearStack()
      if (section === 'whatsapp' && onOpenWorkspaceMode) { markCurrentInboxSeen(); onOpenWorkspaceMode('inbox'); return }
      else if (section === 'whatsapp') { markCurrentInboxSeen(); setSubOpen(p => ({ ...p, whatsapp: true })) }
      else if (section === 'mail' && onOpenWorkspaceMode) { onOpenWorkspaceMode('inbox'); return }
      else if (section === 'mail') setSubOpen(p => ({ ...p, gmail: true }))
      else if (section === 'artifacts' && onOpenWorkspaceMode) { onOpenWorkspaceMode('artifacts'); return }
      else if (section === 'artifacts') setSubOpen(p => ({ ...p, recentArtifacts: true }))
      else if (section === 'automation' && onOpenWorkspaceMode) { onOpenWorkspaceMode('automation'); return }
      else if ((section === 'pionierplaner' || section === 'redaktion') && onOpenWorkspaceMode) { onOpenWorkspaceMode('pionierplaner'); return }
      else if (section === 'daily-log') setSubOpen(p => ({ ...p, dailyLogs: true }))
      else if (section === 'settings' && onOpenWorkspaceMode) { onOpenWorkspaceMode('settings'); return }
      else if (section === 'settings') setSubOpen(p => ({ ...p, settings: true }))
      else if (section === 'skills') setSkillsForceSignal(n => n + 1)
      else if (section === 'social') setSocialForceSignal(n => n + 1)
      // Scroll in den Viewport — zwei Frames warten, damit das Auf-Klappen
      // der Sektion gerendert ist und der scrollIntoView-Offset stimmt.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const root = scrollRef.current
        if (!root) return
        const target = root.querySelector(`[data-info-section="${section}"]`) as HTMLElement | null
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }))
    }
    window.addEventListener('deck:info-section', onSection)
    return () => window.removeEventListener('deck:info-section', onSection)
  }, [fsFullMode, toggleFsFullMode, stack.length, clearStack, onOpenWorkspaceMode, markCurrentInboxSeen])

  useEffect(() => {
    const onOpenPerson = (e: Event) => {
      const personId = Number((e as CustomEvent).detail?.personId || 0)
      if (!Number.isFinite(personId) || personId <= 0) return
      if (fsFullMode) toggleFsFullMode(false)
      setSubOpen(p => ({ ...p, people: true }))
      if (top?.type === 'person') {
        if (top.personId === personId) return
        replaceTop({ type: 'person', personId })
        return
      }
      pushView({ type: 'person', personId })
    }
    window.addEventListener('deck:open-person', onOpenPerson as EventListener)
    return () => window.removeEventListener('deck:open-person', onOpenPerson as EventListener)
  }, [fsFullMode, pushView, replaceTop, toggleFsFullMode, top])

  // External file
  useEffect(() => {
    if (externalFile) { openFileTarget(externalFile); onExternalFileConsumed?.() }
  }, [externalFile, onExternalFileConsumed, openFileTarget])

  // External WhatsApp chat (via Spotlight)
  useEffect(() => {
    if (externalWaChat) { pushView({ type: 'wa-chat', chatId: externalWaChat }); onExternalWaChatConsumed?.() }
  }, [externalWaChat, onExternalWaChatConsumed, pushView])

  // External Mail thread (via Spotlight)
  useEffect(() => {
    if (externalMailThread) { pushView({ type: 'mail-thread', account: externalMailThread.account, uid: externalMailThread.uid }); onExternalMailThreadConsumed?.() }
  }, [externalMailThread, onExternalMailThreadConsumed, pushView])

  // Search
  const doSearch = useCallback((q: string, agentOnly?: boolean, time?: SearchTime) => {
    if (!q.trim()) { setResults([]); setChatResults([]); setFileResults([]); setWaSearchResults([]); setSearching(false); return }
    setSearching(true)
    const agentParam = agentOnly ? `&agent=${encodeURIComponent(activeAgent)}` : ''
    const since = sinceForTime(time ?? 'all')
    const sinceParam = since ? `&since=${since}` : ''
    Promise.all([
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=50`).then(r => r.json()),
      fetch(`/api/search/chat?q=${encodeURIComponent(q)}&limit=50${agentParam}${sinceParam}`).then(r => r.json()),
      fetch(`/api/search/files?q=${encodeURIComponent(q)}&limit=50${sinceParam}`).then(r => r.json()),
      fetch(`/api/whatsapp/search?q=${encodeURIComponent(q)}&limit=50${sinceParam}`).then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    ]).then(([fileData, chatData, filesData, waData]) => {
      setResults(fileData.results || [])
      setChatResults(chatData.results || [])
      setFileResults(filesData.files || [])
      setWaSearchResults(waData.results || [])
      setSearching(false)
      pushRecentSearch(q)
    }).catch(() => { setResults([]); setChatResults([]); setFileResults([]); setWaSearchResults([]); setSearching(false) })
  }, [activeAgent, pushRecentSearch])

  // Such-Pagination: pro Sektion ein "Mehr anzeigen"-Zaehler. Reset bei neuer Query.
  const SEARCH_PAGE = 15
  const [searchShown, setSearchShown] = useState<{ wa: number; chat: number; file: number; ws: number }>({ wa: SEARCH_PAGE, chat: SEARCH_PAGE, file: SEARCH_PAGE, ws: SEARCH_PAGE })
  useEffect(() => { setSearchShown({ wa: SEARCH_PAGE, chat: SEARCH_PAGE, file: SEARCH_PAGE, ws: SEARCH_PAGE }) }, [query])
  const bumpSearch = (key: keyof typeof searchShown) => setSearchShown(p => ({ ...p, [key]: p[key] + SEARCH_PAGE }))

  const showResults = query.trim().length > 0
  const hasDrillView = !!(personViewId || waSelectedChatId || mailThread || openFile || selectedCron)

  return (
    <div className={`info-pane relative flex flex-col h-full ${onClose ? 'info-mobile' : ''}`}>
      {/* Mobile: nur Safe-Area-Spacer. Drill-in-Views bringen ihren eigenen Zurück-Pfeil mit,
          und ein Swipe nach links führt zurück zum Chat. */}
      {onClose && (
        <div style={{ paddingTop: 'max(0.25rem, env(safe-area-inset-top))' }} />
      )}
      {/* ── Zeitfilter-Chips (nur bei aktiver Suche) ── */}
      {showResults && (
        <div className={`flex items-center flex-wrap gap-1 ${mobile ? 'px-5 py-2' : 'px-3 py-1.5'} border-b border-[var(--border)]/40 flex-shrink-0`}>
          {([
            ['all', 'Alle'],
            ['today', 'Heute'],
            ['week', '7 Tage'],
            ['month', '30 Tage'],
          ] as [SearchTime, string][]).map(([key, label]) => (
            <button key={key}
              onClick={() => { setSearchTime(key); if (query.trim()) doSearch(query, searchAgent, key) }}
              className={`info-text-meta px-2 py-0.5 rounded cursor-pointer transition-colors flex-shrink-0 ${searchTime === key ? 'bg-white/[0.08] text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t2)]'}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {!showResults && onOpenSearch && !hasDrillView && (
        <>
          <div
            className="info-control-header group relative w-full flex items-center justify-between gap-2 px-6 flex-shrink-0"
            style={{ background: 'transparent', height: 'var(--header-row-h)' }}
          >
              <img
                src="/agent-control-logo.png"
                alt="Agent Control"
                className="brand-logo h-5 w-auto opacity-40 group-hover:opacity-60 transition-opacity shrink-0"
                style={{ marginLeft: -4.5 }}
                draggable={false}
              />
            <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={onOpenSearch}
                className="grid h-7 w-7 place-items-center rounded-md text-[var(--t3)] transition-colors hover:bg-white/[0.06] hover:text-[var(--t1)]"
                aria-label="InfoPane durchsuchen"
                title="Suchen"
              >
                <Search className="w-4 h-4" />
              </button>
            </div>
          </div>
          <Suspense fallback={null}>
            <FokusSection mobile={mobile} />
          </Suspense>
        </>
      )}


      {/* ── Scrollable Content ── */}
      <div ref={scrollRef} className={`flex-1 overflow-y-auto ${hasDrillView ? 'flex flex-col' : ''}`}>
        <Suspense fallback={SectionFallback}>
        {hasDrillView && (
          <div className="info-drill-surface">
            {personViewId > 0 && (
              <PersonView personId={personViewId} onBack={popView} mobile={mobile} />
            )}
            {!personViewId && waSelectedChatId && (
              <WaChatView chatId={waSelectedChatId} onBack={popView} mobile={mobile} />
            )}
            {!personViewId && !waSelectedChatId && mailThread && (
              <MailThreadView account={mailThread.account} uid={mailThread.uid} onBack={popView} mobile={mobile}
                onAction={(uid) => {
                  rememberArchivedMail(mailThread.account, uid)
                  forgetKeptMail(mailThread.account, uid)
                  setMailThreads(prev => prev.filter(x => x.uid !== uid))
                  setMailInboxItems(prev => prev.filter(x => !((x.account || mailAccount) === mailThread.account && x.uid === uid)))
                }} />
            )}
            {!personViewId && !waSelectedChatId && !mailThread && openFile && (
              <FileView path={openFile} onClose={popView} />
            )}
            {!personViewId && !waSelectedChatId && !mailThread && !openFile && selectedCron && (
              <CronDetail cron={selectedCron} color={(selectedCron as any).agentColor || '#888'} onBack={popView} />
            )}
          </div>
        )}
        </Suspense>
        <div style={{ display: hasDrillView ? 'none' : 'contents' }}>
        {showResults ? (
          <div>
            {/* ── Typ-Tabs ── */}
            {(() => {
              const totalAll = waSearchResults.length + chatResults.length + results.length + fileResults.length
              const tabs: [SearchType, string, number][] = [
                ['all', 'Alle', totalAll],
                ['chat', 'Nachrichten', chatResults.length],
                ['wa', 'WhatsApp', waSearchResults.length],
                ['docs', 'Dokumente', results.length],
                ['files', 'Dateien', fileResults.length],
              ]
              return (
                <div className={`flex items-center flex-wrap gap-1 ${mobile ? 'px-5 py-2' : 'px-3 py-1.5'} border-b border-[var(--border)]/40`}>
                  {tabs.map(([key, label, count]) => (
                    <button key={key} onClick={() => setSearchType(key)}
                      className={`info-text-meta px-2 py-0.5 rounded cursor-pointer transition-colors flex-shrink-0 ${searchType === key ? 'bg-white/[0.08] text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t2)]'}`}>
                      {label}{count > 0 && <span className="ml-1 text-[var(--t3)]/70">{count}</span>}
                    </button>
                  ))}
                </div>
              )
            })()}
            {searching && <div className="px-3 py-3 info-text-body text-[var(--t3)]">Suche...</div>}
            {!searching && results.length === 0 && chatResults.length === 0 && fileResults.length === 0 && waSearchResults.length === 0 && <div className="px-3 py-3 info-text-body text-[var(--t3)]">Keine Ergebnisse.</div>}
            {(searchType === 'all' || searchType === 'wa') && waSearchResults.length > 0 && (
              <>
                <div className={`px-3 pt-2.5 pb-1 info-text-meta font-medium text-[var(--t3)] uppercase tracking-wider`}>WhatsApp</div>
                {waSearchResults.slice(0, searchShown.wa).map((r, i) => (
                  <button key={`wa-${i}`} onClick={() => { pushView({ type: 'wa-chat', chatId: r.chat_id }); setQuery('') }}
                    className={`w-full px-3 ${mobile ? 'py-3.5' : 'py-2.5'} text-left hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors`}>
                    <div className="flex items-center gap-2 mb-0.5">
                      <MessageSquare className={`info-icon-sm text-[#25d366]/80 flex-shrink-0`} />
                      <span className={`info-text-body text-[var(--t1)] font-medium truncate`}>{r.chat_name}</span>
                      {r.from_me && <span className={`info-text-meta text-[var(--t3)]`}>Du</span>}
                      <span className={`info-text-meta text-[var(--t3)] ml-auto flex-shrink-0`}>{formatWaTime(r.ts)}</span>
                    </div>
                    <div className={`info-text-meta text-[var(--t3)] line-clamp-2 pl-[22px]`}>{r.snippet}</div>
                  </button>
                ))}
                {waSearchResults.length > searchShown.wa && (
                  <button onClick={() => bumpSearch('wa')}
                    className={`info-btn-ghost w-full text-left px-3 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-meta`}>
                    {waSearchResults.length - searchShown.wa} weitere anzeigen
                  </button>
                )}
              </>
            )}
            {(searchType === 'all' || searchType === 'chat') && chatResults.length > 0 && (
              <>
                <div className={`px-3 pt-2.5 pb-1 info-text-meta font-medium text-[var(--t3)] uppercase tracking-wider`}>Nachrichten</div>
                {chatResults.slice(0, searchShown.chat).map((r, i) => {
                  const time = new Date(r.ts * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                  const snippet = r.content.length > 120 ? r.content.slice(0, 120) + '...' : r.content
                  return (
                    <button key={`chat-${i}`} onClick={() => onScrollToMessage?.(r.agent || activeAgent, r.conversationId, r.ts)}
                      className={`w-full px-3 ${mobile ? 'py-3.5' : 'py-2.5'} text-left hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors`}>
                      <div className="flex items-center gap-2 mb-0.5">
                        <MessageSquare className={`info-icon-sm text-[var(--t3)] flex-shrink-0`} />
                        <span className={`info-text-body text-[var(--t1)] font-medium`}>{r.author}</span>
                        <span className={`info-text-meta text-[var(--t3)]`}>{r.agent}</span>
                        <span className={`info-text-meta text-[var(--t3)] ml-auto`}>{time}</span>
                      </div>
                      <div className={`info-text-meta text-[var(--t3)] line-clamp-2 pl-[22px]`}>{snippet}</div>
                    </button>
                  )
                })}
                {chatResults.length > searchShown.chat && (
                  <button onClick={() => bumpSearch('chat')}
                    className={`info-btn-ghost w-full text-left px-3 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-meta`}>
                    {chatResults.length - searchShown.chat} weitere anzeigen
                  </button>
                )}
              </>
            )}
            {(searchType === 'all' || searchType === 'docs') && results.length > 0 && (
              <>
                <div className={`px-3 pt-2.5 pb-1 info-text-meta font-medium text-[var(--t3)] uppercase tracking-wider`}>Inhalt</div>
                {results.slice(0, searchShown.file).map((r, i) => (
                  <button key={`file-${i}`} onClick={() => openFileTarget(r.path)}
                    className={`w-full px-3 ${mobile ? 'py-3.5' : 'py-2.5'} text-left hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors`}>
                    <div className="flex items-center gap-2 mb-0.5">
                      <FileText className={`info-icon-sm text-[var(--t3)] flex-shrink-0`} />
                      <span className={`info-text-title text-[var(--t1)] truncate`}>{r.title}</span>
                      <span className={`info-text-meta text-[var(--t3)]`}>{r.source}</span>
                    </div>
                    <div className={`info-text-meta text-[var(--t3)] line-clamp-2 pl-[22px]`} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(r.snippet) }} />
                  </button>
                ))}
                {results.length > searchShown.file && (
                  <button onClick={() => bumpSearch('file')}
                    className={`info-btn-ghost w-full text-left px-3 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-meta`}>
                    {results.length - searchShown.file} weitere anzeigen
                  </button>
                )}
              </>
            )}
            {(searchType === 'all' || searchType === 'files') && fileResults.length > 0 && (
              <>
                <div className={`px-3 pt-2.5 pb-1 info-text-meta font-medium text-[var(--t3)] uppercase tracking-wider`}>Dateien</div>
                {fileResults.slice(0, searchShown.ws).map((r, i) => {
                  const Icon = fileIcon(r.name)
                  return (
                    <button key={`ws-${i}`} onClick={() => openFileTarget(r.path)}
                      className={`w-full px-3 ${mobile ? 'py-3.5' : 'py-2.5'} text-left hover:bg-white/[0.04] active:bg-white/[0.08] cursor-pointer transition-colors`}>
                      <div className="flex items-center gap-2 mb-0.5">
                        <Icon className={`info-icon-sm flex-shrink-0`} style={{ color: r.color || 'var(--t3)' }} />
                        <span className={`info-text-body text-[var(--t1)] font-medium truncate`}>{r.name}</span>
                        <span className={`info-text-meta px-1.5 py-0.5 rounded-full flex-shrink-0`} style={{ backgroundColor: (r.color || '#666') + '20', color: r.color || 'var(--t3)' }}>{r.source}</span>
                      </div>
                      <div className={`info-text-meta text-[var(--t3)] truncate pl-[22px]`}>{r.relative}</div>
                    </button>
                  )
                })}
                {fileResults.length > searchShown.ws && (
                  <button onClick={() => bumpSearch('ws')}
                    className={`info-btn-ghost w-full text-left px-3 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-meta`}>
                    {fileResults.length - searchShown.ws} weitere anzeigen
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {recentSearches.length > 0 && (
              <div className={`flex items-center flex-wrap gap-1.5 ${mobile ? 'px-5 py-2.5' : 'px-3 py-2'} border-b border-[var(--border)]/40`}>
                <span className={`info-text-meta text-[var(--t3)]/60 uppercase tracking-wider flex-shrink-0`}>Zuletzt</span>
                {recentSearches.map((q, i) => (
                  <button key={i} onClick={() => { setQuery(q); doSearch(q, searchAgent, searchTime) }}
                    className="info-text-meta px-2 py-0.5 rounded cursor-pointer transition-colors text-[var(--t2)] bg-white/[0.04] hover:bg-white/[0.08] hover:text-[var(--t1)] flex-shrink-0 truncate max-w-[140px]"
                    title={q}>
                    {q}
                  </button>
                ))}
                <button onClick={clearRecentSearches}
                  className="info-text-meta px-1 py-0.5 rounded cursor-pointer text-[var(--t3)]/60 hover:text-[var(--t2)] flex-shrink-0 ml-auto"
                  title="Letzte Suchen löschen">
                  <X className="info-icon-sm" />
                </button>
              </div>
            )}

            {!selectedCron && fsFullMode && (
              <FsBusProvider>
                <WorkspaceTree
                  onOpenFile={openFileTarget}
                  mobile={mobile}
                  fullMode
                  onToggleFull={() => toggleFsFullMode(false)}
                />
              </FsBusProvider>
            )}

            {!selectedCron && !fsFullMode && (
              <>
                <PaneGroupHeader label="Kernsystem" mobile={mobile} />
                <div className="flex flex-col">

                {/* ── AgentFlow — sichtbarer Prozess-Ausschnitt als verständliche Ebene über Roh-Toolcalls ── */}
                {SHOW_AGENT_FLOW && (
                  <SortableSection
                    sectionId="agent-flow"
                    dataInfoSection="agent-flow"
                    group="core"
                    mobile={mobile}
                    order={getSectionOrder('core', 'agent-flow')}
                    dragging={draggingSection}
                    dropTarget={dropTargetSection}
                    onDragStartSection={handleSectionDragStart}
                    onDragOverSection={handleSectionDragOver}
                    onDropSection={handleSectionDrop}
                    onDragEndSection={clearSectionDrag}
                  >
                    <div className={mobile ? 'px-3 pt-3' : 'px-3 pt-2'}>
                      <AgentFlowPane mobile={mobile} snapshot={selectedFlowSnapshot} loading={flowLoading} />
                    </div>
                  </SortableSection>
                )}

                {/* ── Workspace — Dateibaum im Workspace ── */}
                <SortableSection
                  sectionId="workspace"
                  dataInfoSection="workspace"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'workspace')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                  <div>
                    <button
                      type="button"
                      onClick={() => onOpenWorkspaceMode?.('filesystem')}
                      className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                      title="File System im Workspace öffnen"
                    >
                      <FolderOpen className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
                      <span className="text-[var(--t2)] font-medium flex-1">File System</span>
                    </button>
                  </div>
                </SortableSection>

                {/* ── Agent — Agent-Übersicht, Identität und Arbeitszustand ── */}
                <SortableSection
                  sectionId="agent"
                  dataInfoSection="agent"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'agent')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                  <div>
                    <button
                      type="button"
                      onClick={() => onOpenWorkspaceMode?.('agent')}
                      className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                      title={`${agentName} im Workspace öffnen`}
                    >
                      <Bot className="info-icon-md mr-2 flex-shrink-0 text-[var(--warm)]" strokeWidth={1.75} />
                      <span className="text-[var(--t2)] font-medium flex-1">{agentName}</span>
                    </button>
                  </div>
                </SortableSection>

                {/* ── Dreaming — Nachtlauf, Nap und Review als eigenes Modul ── */}
                <SortableSection
                  sectionId="dreaming"
                  dataInfoSection="dreaming"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'dreaming')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <DreamingSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('dreaming')} />
                </Suspense>
                </SortableSection>

                {/* ── Automation — Pulses, Workers, Hooks und Tasks im Workspace ── */}
                <SortableSection
                  sectionId="heartbeat"
                  dataInfoSection="heartbeat"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'heartbeat')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                {(() => {
                  const hasError = allCrons.some(c => c.lastStatus === 'error' || c.lastRunStatus === 'error')
                  return (
                    <div>
                      <button
                        type="button"
                        onClick={() => onOpenWorkspaceMode?.('automation')}
                        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                        title="Automation im Workspace öffnen"
                      >
                        <Activity className={`info-icon-md mr-2 flex-shrink-0 ${hasError ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)] group-hover:text-[var(--t2)]'}`} />
                        <span className="text-[var(--t2)] font-medium flex-1">Automation</span>
                      </button>
                    </div>
                  )
                })()}
                </SortableSection>

                {/* ── Engines — Landkarte lokal vs cloud pro LLM-Konsument ── */}
                <SortableSection
                  sectionId="engines"
                  dataInfoSection="engines"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'engines')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <EnginesSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('engines')} />
                </Suspense>
                </SortableSection>

                {/* ── Skills — kategorisierte System-Fähigkeiten mit Kurzansicht und SKILL.md-Drill-in ── */}
                <SortableSection
                  sectionId="skills"
                  dataInfoSection="skills"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'skills')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <SkillsSection
                    mobile={mobile}
                    forceOpenSignal={skillsForceSignal}
                    onOpenFile={openFileTarget}
                    onOpenWorkspace={() => onOpenWorkspaceMode?.('skills')}
                  />
                </Suspense>
                </SortableSection>

                {/* ── Tool Broker — menschliche Freigaben für riskante lokale Aktionen ── */}
                <SortableSection
                  sectionId="tool-approvals"
                  dataInfoSection="tool-approvals"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'tool-approvals')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <ToolApprovalsSection mobile={mobile} />
                </Suspense>
                </SortableSection>

                {/* ── Jobs-Section entfernt — Inhalt lebt jetzt als tasks-Subordner im Pulses-Tab ── */}

                {/* ── Inbox — Kommunikation im Workspace ── */}
                <SortableSection
                  sectionId="whatsapp"
                  dataInfoSection="whatsapp"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'whatsapp')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                {(() => {
                  return (
                    <div>
                      <button
                        type="button"
                        onClick={() => { markCurrentInboxSeen(); onOpenWorkspaceMode?.('inbox') }}
                        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                        title="Inbox im Workspace öffnen"
                      >
                        <Inbox className={`info-icon-md mr-2 flex-shrink-0 ${inboxHasNotice ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)] group-hover:text-[var(--t2)]'}`} />
                        <span className="text-[var(--t2)] font-medium flex-1">Inbox</span>
                      </button>
                    </div>
                  )
                })()}
                </SortableSection>

                {/* ── Mail (IMAP, Multi-Account) ── */}
                <SortableSection
                  sectionId="mail"
                  dataInfoSection="mail"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'mail')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                {(() => {
                  const isExpanded = false
                  const initialsOf = (label: string): string => {
                    const s = (label || '').trim()
                    if (!s) return '?'
                    const parts = s.split(/\s+/).filter(Boolean)
                    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
                    return s.slice(0, 2).toUpperCase()
                  }
                  const colorFor = (s: string): string => {
                    let h = 0
                    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
                    const palette = ['#7a6a55', '#6a7a55', '#55706a', '#6a5a7a', '#7a5a5a', '#5a6a7a', '#7a705a']
                    return palette[h % palette.length]
                  }
                  const formatMailTime = (ts: number) => {
                    if (!ts) return ''
                    const d = new Date(ts * 1000)
                    const now = new Date()
                    const sameDay = d.toDateString() === now.toDateString()
                    if (sameDay) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
                    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
                    if (diffDays < 7) return d.toLocaleDateString('de-DE', { weekday: 'short' })
                    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
                  }
                  const mailAdminEnabled = false
                  return (
                    <div>
                      <button
                        type="button"
                        onClick={() => onOpenWorkspaceMode?.('inbox')}
                        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                        title="Inbox im Workspace öffnen"
                      >
                        <Mail className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
                        <span className="text-[var(--t2)] font-medium flex-1">Inbox</span>
                      </button>
                      {isExpanded && (
                        <div className="pb-2"><Guided>
                          {mailAccounts.length === 0 && (
                            <div className={`info-text-meta text-[var(--t3)]/70 ${mobile ? 'py-2' : 'py-1.5'} italic`}>Kein Account konfiguriert</div>
                          )}
                          {mailAccounts.length > 0 && (() => {
                            const renderMailBody = () => (
                              <div className="pl-1">
                                {mailLoading && mailThreads.length === 0 && (
                                  <div className={`info-text-meta text-[var(--t3)]/60 ${mobile ? 'py-2' : 'py-1.5'} italic`}>Lade…</div>
                                )}
                                {mailError && (
                                  <div className={`info-text-meta text-[var(--warm)]/80 ${mobile ? 'py-2' : 'py-1.5'} italic`}>{mailError}</div>
                                )}
                                {!mailLoading && !mailError && filteredMailThreads.length === 0 && (
                                  <div className={`info-text-meta text-[var(--t3)]/60 ${mobile ? 'py-2' : 'py-1.5'} italic`}>Keine Mails</div>
                                )}
                                {filteredMailThreads.map(t => (
                                  <div key={`${t.account || mailAccount}:${t.uid}`}
                                    onClick={() => {
                                      pushView({ type: 'mail-thread', account: t.account || mailAccount, uid: t.uid })
                                      if (t.unread) {
                                        setMailThreads(prev => prev.map(x => x.uid === t.uid && (x.account || mailAccount) === (t.account || mailAccount) ? { ...x, unread: false } : x))
                                      }
                                    }}
                                    className={`group flex items-start gap-2 ${mobile ? 'py-[7px]' : 'py-[5px]'} border-b border-white/[0.03] last:border-b-0 cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors`}>
                                    <div
                                      className="flex-shrink-0 rounded-full flex items-center justify-center text-[12px] font-medium text-white/90 select-none mt-0.5"
                                      style={{ width: 22, height: 22, backgroundColor: colorFor(t.from_raw || t.from || '?') }}
                                      aria-hidden="true">
                                      {initialsOf(t.from || t.from_raw || '?')}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className={`info-text-body truncate ${t.unread ? 'text-[var(--t1)] font-medium' : 'text-[var(--t2)]'}`}>
                                          {t.from || '(unbekannt)'}
                                        </span>
                                        {t.has_attachment && (
                                          <Paperclip className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                                        )}
                                        <span className="info-text-meta text-[var(--t3)] ml-auto flex-shrink-0 tabular-nums">
                                          {formatMailTime(t.ts)}
                                        </span>
                                      </div>
                                      <div className={`info-text-meta truncate mt-0.5 ${t.unread ? 'text-[var(--t2)]' : 'text-[var(--t3)]'}`}>
                                        {t.subject}
                                        {t.account_name && mailAccount === 'all' && (
                                          <span className="text-[var(--t3)]/60"> · {t.account_name}</span>
                                        )}
                                      </div>
                                    </div>
                                    {mailAdminEnabled && (
                                      <>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); toggleMailStar(t.uid, !t.starred, t.account || mailAccount) }}
                                          title={t.starred ? 'Stern entfernen' : 'Markieren'}
                                          className={`p-0.5 flex-shrink-0 self-start ${t.starred ? 'text-[#c89860]' : 'opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--t3)] hover:text-[#c89860]'}`}>
                                          <Star className="info-icon-sm" fill={t.starred ? '#c89860' : 'none'} />
                                        </button>
                                        <div className="relative flex-shrink-0 self-start opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                                          <button
                                            onClick={(e) => { e.stopPropagation(); setMailMovePicker(p => p === `${t.account || mailAccount}:${t.uid}` ? '' : `${t.account || mailAccount}:${t.uid}`) }}
                                            title="In Label verschieben"
                                            className="p-0.5 text-[var(--t3)] hover:text-[var(--t1)]">
                                            <FolderInput className="info-icon-sm" />
                                          </button>
                                          {mailMovePicker === `${t.account || mailAccount}:${t.uid}` && (
                                            <div onClick={(e) => e.stopPropagation()}
                                              className="absolute right-0 top-full mt-1 z-20 min-w-[180px] max-h-[260px] overflow-y-auto bg-[var(--bg-elev, #1c1c1c)] border border-[var(--border)] rounded shadow-lg py-1">
                                              {mailLabels.length === 0 ? (
                                                <div className="info-text-meta text-[var(--t3)] px-2 py-1 italic">Keine Labels</div>
                                              ) : mailLabels.map(l => (
                                                <button key={l}
                                                  onClick={() => moveMailThread(t.uid, l, t.account || mailAccount)}
                                                  className="block w-full text-left info-text-meta text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] px-2 py-1 truncate">
                                                  {l}
                                                </button>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            if (confirm(`Absender "${t.from_raw || t.from}" sperren?`)) {
                                              blockMailSender(t.from_raw || t.from)
                                            }
                                          }}
                                          title="Absender sperren"
                                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 text-[var(--t3)] hover:text-[var(--warm)] flex-shrink-0 self-start">
                                          <X className="info-icon-sm" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )
                            return (
                              <>
                                {mailSearchOpen && (
                                  <div className="flex items-center gap-1.5 pb-1.5">
                                    <Search className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                                    <input
                                      ref={mailSearchInputRef}
                                      type="text"
                                      placeholder="Im gesamten Postfach suchen…"
                                      value={mailQuery}
                                      onChange={e => setMailQuery(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter') loadMailThreads(undefined, undefined, mailQuery); if (e.key === 'Escape') { setMailQuery(''); setMailSearchOpen(false); loadMailThreads(undefined, undefined, '') } }}
                                      onBlur={() => loadMailThreads(undefined, undefined, mailQuery)}
                                      className="info-text-meta flex-1 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-0.5 text-[var(--t1)] placeholder:text-[var(--t3)]/60 focus:outline-none focus:border-white/[0.12]"
                                    />
                                    {mailQuery && (
                                      <button onClick={() => { setMailQuery(''); loadMailThreads(undefined, undefined, '') }}
                                        className="p-0.5 text-[var(--t3)] hover:text-[var(--t1)]">
                                        <X className="info-icon-sm" />
                                      </button>
                                    )}
                                  </div>
                                )}
                                {mailAdminEnabled ? (() => {
                                  const folders = mailRules.folders || ['rest']
                                  return folders.map(folderKey => {
                                    const label = (mailRules.tab_labels || {})[folderKey] || folderKey
                                    const isActive = !mailShowBlocked && mailCategory === folderKey
                                    const FolderIcon = isActive ? FolderOpen : FolderClosed
                                    return (
                                      <div key={folderKey}>
                                        <button onClick={() => {
                                            if (mailShowBlocked) setMailShowBlocked(false)
                                            playUISound(isActive ? 'tab-click' : 'section-open')
                                            setMailCategory(folderKey)
                                            const acc = mailAccount || mailAccounts.find(a => a.key === 'all')?.key || mailAccounts.find(a => a.key === 'company')?.key || mailAccounts[0]?.key || ''
                                            if (acc) loadMailThreads(acc, folderKey)
                                          }}
                                          className={`flex w-full items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
                                          <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isActive ? 'rotate-90' : ''}`} />
                                          <FolderIcon className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                                          <span className="text-[var(--t2)] flex-1">{label}</span>
                                          {isActive && filteredMailThreads.length > 0 && (
                                            <span className="info-text-meta text-[var(--t3)] tabular-nums">{filteredMailThreads.length}</span>
                                          )}
                                        </button>
                                        {isActive && renderMailBody()}
                                      </div>
                                    )
                                  })
                                })() : renderMailBody()}
                                {mailAdminEnabled && mailShowBlocked && (
                                  <div className="pb-2 pr-3">
                                    {mailBlocklist.length === 0 ? (
                                      <div className={`info-text-meta text-[var(--t3)]/60 ${mobile ? 'py-2' : 'py-1.5'} italic`}>Keine gesperrten Absender</div>
                                    ) : (
                                      mailBlocklist.map(b => (
                                        <div key={b} className={`flex items-center gap-2 ${mobile ? 'py-1.5' : 'py-1'} info-text-meta`}>
                                          <span className="text-[var(--t2)] truncate flex-1">{b}</span>
                                          <button onClick={() => unblockMailSender(b)}
                                            title="Entsperren"
                                            className="p-0.5 text-[var(--t3)] hover:text-[var(--t1)]">
                                            <X className="info-icon-sm" />
                                          </button>
                                        </div>
                                      ))
                                    )}
                                  </div>
                                )}
                              </>
                            )
                          })()}
                        </Guided></div>
                      )}
                    </div>
                  )
                })()}
                </SortableSection>

                {/* ── Letzte Artefakte ── */}
                <SortableSection
                  sectionId="artifacts"
                  dataInfoSection="artifacts"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'artifacts')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <div>
                  <button
                    type="button"
                    onClick={() => onOpenWorkspaceMode?.('artifacts')}
                    className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                    title="Artefakte im Workspace öffnen"
                  >
                    <History className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
                    <span className="text-[var(--t2)] font-medium flex-1">Artefakte</span>
                  </button>
                </div>
                </SortableSection>

                {/* ── Einstellungen ── */}
                <SortableSection
                  sectionId="settings"
                  dataInfoSection="settings"
                  group="core"
                  mobile={mobile}
                  order={getSectionOrder('core', 'settings')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <div>
                  <button
                    type="button"
                    onClick={() => onOpenWorkspaceMode?.('settings')}
                    className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                    title="Settings im Workspace öffnen"
                  >
                    <Settings className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
                    <span className="text-[var(--t2)] font-medium flex-1">Settings</span>
                  </button>
                </div>
                </SortableSection>
                </div>

                <PaneGroupHeader label="Agents" mobile={mobile} />
                <div className="flex flex-col">

                {/* ── Rechnungs-Agent — Zusage zur Rechnung: Kontakt, Positionen, Selbst-Check, Freigabe, Lexware-Anlage ── */}
                <SortableSection
                  sectionId="rechnung"
                  dataInfoSection="rechnung"
                  group="agents"
                  mobile={mobile}
                  order={getSectionOrder('agents', 'rechnung')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <InvoiceSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('invoice')} />
                </Suspense>
                </SortableSection>

                {/* ── Pioniereplaner — Pioniere-Post im Vorlauf: Radar, Entwurf, Freigabe ── */}
                <SortableSection
                  sectionId="pionierplaner"
                  dataInfoSection="pionierplaner"
                  group="agents"
                  mobile={mobile}
                  order={getSectionOrder('agents', 'pionierplaner')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <RedaktionSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('pionierplaner')} />
                </Suspense>
                </SortableSection>

                {/* ── Posteingang-Agent — mehrstufiger Mail-Workflow: Routing, Kontext, Entwurf, Selbst-Check, Freigabe ── */}
                <SortableSection
                  sectionId="posteingang"
                  dataInfoSection="posteingang"
                  group="agents"
                  mobile={mobile}
                  order={getSectionOrder('agents', 'posteingang')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <PosteingangSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('inbox')} />
                </Suspense>
                </SortableSection>

                {/* ── Systemagent — Logbuch, Werkstatt und Entscheidungen als eigener Regelkreis ── */}
                <SortableSection
                  sectionId="systemkreis"
                  dataInfoSection="systemkreis"
                  group="agents"
                  mobile={mobile}
                  order={getSectionOrder('agents', 'systemkreis')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <SystemagentSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('systemagent')} />
                </Suspense>
                </SortableSection>

                {/* ── Chatagent — Gesundheit, Stabilität und Leichtgewicht des Chat-Moduls ── */}
                <SortableSection
                  sectionId="chatagent"
                  dataInfoSection="chatagent"
                  group="agents"
                  mobile={mobile}
                  order={getSectionOrder('agents', 'chatagent')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <ChatagentSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('chatagent')} />
                </Suspense>
                </SortableSection>
                </div>

                <PaneGroupHeader label="Custom" mobile={mobile} />
                <div className="flex flex-col">

                {/* ── Limits — Claude-Max Sitzung/Woche on-demand ── */}
                <SortableSection
                  sectionId="limits"
                  dataInfoSection="limits"
                  group="custom"
                  mobile={mobile}
                  order={getSectionOrder('custom', 'limits')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDropSection={handleSectionDrop}
                  onDragOverSection={handleSectionDragOver}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <LimitsSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('limits')} />
                </Suspense>
                </SortableSection>

                {/* ── Social Media (Reels / Karussells / Beiträge) ── */}
                <SortableSection
                  sectionId="social"
                  dataInfoSection="social"
                  group="custom"
                  mobile={mobile}
                  order={getSectionOrder('custom', 'social')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                {onOpenWorkspaceMode && (
                  <button
                    type="button"
                    onClick={() => onOpenWorkspaceMode('social')}
                    className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
                    title="Social Media im Workspace öffnen"
                  >
                    <Film className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
                    <span className="text-[var(--t2)] font-medium flex-1">Social Media</span>
                  </button>
                )}
                {!onOpenWorkspaceMode && (reels.length > 0 || karussells.length > 0 || beitraege.length > 0) && (() => {
                  // Gepostete Karussells/Beiträge fallen aus der Liste raus,
                  // damit die Pipeline-Sicht clean bleibt. Reels filtern wir nicht,
                  // da dort die Versions-Logik die "alten" eh wegrollt.
                  const isLive = (s?: SocialState) => s === 'published'
                  const visibleKarussells = karussells.filter(k => !isLive(k.state))
                  const visibleBeitraege = beitraege.filter(b => !isLive(b.state))
                  // Sortierung: queued nach scheduled_for aufsteigend (was zuerst raus geht),
                  // dann failed (Aufmerksamkeit), dann pending (warten auf Approve), zuletzt published.
                  const sortPipeline = <T extends { state?: SocialState; scheduled_for?: string | null; rendered_at: number }>(arr: T[]): T[] => {
                    const rank = (s?: SocialState) => s === 'queued' ? 0 : s === 'failed' ? 1 : s === 'pending' ? 2 : 3
                    return [...arr].sort((a, b) => {
                      const ra = rank(a.state), rb = rank(b.state)
                      if (ra !== rb) return ra - rb
                      if (a.state === 'queued' && b.state === 'queued') {
                        const da = a.scheduled_for || '9999'
                        const db = b.scheduled_for || '9999'
                        if (da !== db) return da < db ? -1 : 1
                      }
                      return b.rendered_at - a.rendered_at
                    })
                  }
                  const sortedKarussells = sortPipeline(visibleKarussells)
                  const sortedBeitraege = sortPipeline(visibleBeitraege)
                  // Reels-Grouping: pro clipNN / opus-rankNN nur die neueste Version anzeigen
                  const groups: Record<string, { current: Reel; older: Reel[] }> = {}
                  for (const reel of reels) {
                    const m = reel.id.match(/^(clip|opus-rank)(\d+)-v(\d+)$/i)
                    if (!m) continue
                    const key = `${m[1].toLowerCase()}${m[2]}`
                    const ver = parseInt(m[3], 10)
                    if (!groups[key]) groups[key] = { current: reel, older: [] }
                    else {
                      const curM = groups[key].current.id.match(/v(\d+)/)
                      const curVer = curM ? parseInt(curM[1], 10) : 0
                      if (ver > curVer) {
                        groups[key].older.push(groups[key].current)
                        groups[key].current = reel
                      } else {
                        groups[key].older.push(reel)
                      }
                    }
                  }
                  // Reels filtern: published-Versionen raus, damit ein gepostetes Reel
                  // nicht ewig in der Pipeline-Sicht klebt.
                  // Reel-Reihenfolge: queued (nach scheduled_for asc) → failed → pending (neueste zuerst).
                  const groupKeys = Object.keys(groups)
                    .filter(k => !isLive(groups[k].current.state))
                    .sort((a, b) => {
                      const ra = groups[a].current, rb = groups[b].current
                      const rank = (s?: SocialState) => s === 'queued' ? 0 : s === 'failed' ? 1 : s === 'pending' ? 2 : 3
                      const rk = rank(ra.state) - rank(rb.state)
                      if (rk !== 0) return rk
                      if (ra.state === 'queued' && rb.state === 'queued') {
                        const da = ra.scheduled_for || '9999'
                        const db = rb.scheduled_for || '9999'
                        if (da !== db) return da < db ? -1 : 1
                      }
                      return rb.rendered_at - ra.rendered_at
                    })
                  const reelsCount = groupKeys.length
                  const totalCount = reelsCount + sortedKarussells.length + sortedBeitraege.length


                  const ReelRow = ({ reel, onOpen }: { reel: Reel; onOpen: () => void }) => {
                    const dotColor = stateColor(reel.state)
                    // Bei pending/queued mit scheduled_for: Datum + Uhrzeit statt Standard-Label.
                    const showSchedule = reel.scheduled_for && reel.state !== 'published'
                    const timeStr = reel.scheduled_time || '18:00'
                    const statusText = showSchedule
                      ? `${formatScheduled(reel.scheduled_for)} ${timeStr}`
                      : stateLabel(reel.state, reel.published?.published_at ?? null)
                    return (
                      <div onClick={onOpen}
                        className={`group flex items-center gap-2 pr-3 ${mobile ? 'py-[7px]' : 'py-[5px]'} border-b border-white/[0.03] last:border-b-0 cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors`}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                        <span className="info-text-body text-[var(--t2)] truncate flex-1 min-w-0">{reel.title}</span>
                        <span className="info-text-meta text-[var(--t3)] flex-shrink-0 tabular-nums">{statusText}</span>
                      </div>
                    )
                  }

                  // Status-Text auf der Karte: bei queued zeigt das konkrete Datum,
                  // sonst Standard-Label. Das löst des Nutzers "wartet auf Slot ist abgeschnitten"-Pain.
                  const pipelineStatus = (state?: SocialState, scheduledFor?: string | null, publishedAt?: number | null) => {
                    if (state === 'queued') return formatScheduled(scheduledFor, 'wartet auf Slot')
                    return stateLabel(state, publishedAt)
                  }

                  const KarussellRow = ({ k }: { k: Karussell }) => {
                    const dotColor = stateColor(k.state)
                    const statusText = pipelineStatus(k.state, k.scheduled_for, k.published?.published_at ?? null)
                    return (
                      <div onClick={() => setExpandedKarussell(k.id)}
                        className={`group flex items-center gap-2 pr-3 ${mobile ? 'py-[7px]' : 'py-[5px]'} border-b border-white/[0.03] last:border-b-0 cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors`}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                        <span className="info-text-body text-[var(--t2)] truncate flex-1 min-w-0">{k.title}</span>
                        <span className="info-text-meta text-[var(--t3)] flex-shrink-0 tabular-nums">{statusText}</span>
                      </div>
                    )
                  }

                  const BeitragRow = ({ b }: { b: Beitrag }) => {
                    const dotColor = stateColor(b.state)
                    const statusText = pipelineStatus(b.state, b.scheduled_for, b.published?.published_at ?? null)
                    return (
                      <div onClick={() => setExpandedBeitrag(b.id)}
                        className={`group flex items-center gap-2 pr-3 ${mobile ? 'py-[7px]' : 'py-[5px]'} border-b border-white/[0.03] last:border-b-0 cursor-pointer hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors`}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: dotColor }} />
                        <span className="info-text-body text-[var(--t2)] truncate flex-1 min-w-0">{b.title}</span>
                        <span className="info-text-meta text-[var(--t3)] flex-shrink-0 tabular-nums">{statusText}</span>
                      </div>
                    )
                  }

                  const SubHeader = ({
                    label, count, isOpen, onToggle,
                  }: {
                    label: string
                    count: number
                    isOpen: boolean
                    onToggle: () => void
                  }) => {
                    const FolderIcon = isOpen ? FolderOpen : FolderClosed
                    return (
                      <button onClick={onToggle}
                        className={`w-full flex items-center pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                        <FolderIcon className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                        <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">{label}</span>
                        <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{count}</span>
                      </button>
                    )
                  }

                  const reelsKey = 'social:reels'
                  const karussellsKey = 'social:karussells'
                  const beitraegeKey = 'social:beitraege'
                  const reelsOpen = subOpen[reelsKey] ?? false
                  const karussellsOpen = subOpen[karussellsKey] ?? false
                  const beitraegeOpen = subOpen[beitraegeKey] ?? false

                  return (
                    <Section label="Social Media" icon={Film} defaultOpen={sections.reels} count={totalCount} mobile={mobile} forceOpenSignal={socialForceSignal}>
                      {/* Sub-Akkordeons werden nur gezeigt, wenn etwas in der Pipeline ist.
                          Leere Buckets verschwinden komplett, damit die Pane übersichtlich bleibt. */}
                      {reelsCount > 0 && (
                        <>
                          <SubHeader label="Reels" count={reelsCount}
                            isOpen={reelsOpen} onToggle={() => toggleSub(reelsKey)} />
                          {reelsOpen && (
                            <Guided>
                              {groupKeys.map(k => (
                                <ReelRow key={k} reel={groups[k].current}
                                  onOpen={() => pushView({ type: 'reel', id: groups[k].current.id })} />
                              ))}
                            </Guided>
                          )}
                        </>
                      )}

                      {sortedKarussells.length > 0 && (
                        <>
                          <SubHeader label="Karussells" count={sortedKarussells.length}
                            isOpen={karussellsOpen} onToggle={() => toggleSub(karussellsKey)} />
                          {karussellsOpen && (
                            <Guided>
                              {sortedKarussells.map(k => <KarussellRow key={k.id} k={k} />)}
                            </Guided>
                          )}
                        </>
                      )}

                      {sortedBeitraege.length > 0 && (
                        <>
                          <SubHeader label="Beiträge" count={sortedBeitraege.length}
                            isOpen={beitraegeOpen} onToggle={() => toggleSub(beitraegeKey)} />
                          {beitraegeOpen && (
                            <Guided>
                              {sortedBeitraege.map(b => <BeitragRow key={b.id} b={b} />)}
                            </Guided>
                          )}
                        </>
                      )}

                      {totalCount === 0 && (
                        <div className="info-text-meta text-[var(--t3)]/60 py-2">Pipeline leer.</div>
                      )}
                    </Section>
                  )
                })()}

                {/* ── Karussell-Modal ── */}
                {expandedKarussell && (() => {
                  const k = karussells.find(x => x.id === expandedKarussell)
                  if (!k) return null
                  const isPublished = !!k.published?.ig_media_id || k.state === 'published'
                  const isQueued = k.state === 'queued'
                  const isFailed = k.state === 'failed'
                  const approveBusy = busyAction === `approve:k:${k.id}`
                  const delBusy = busyAction === `del:k:${k.id}`
                  return (
                    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
                      onClick={() => setExpandedKarussell(null)}>
                      <div className="max-w-2xl w-full max-h-[90vh] bg-[var(--bg-1)] border border-[var(--border)] rounded-lg overflow-hidden shadow-2xl flex flex-col"
                        onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]/40 flex-shrink-0">
                          <span className="info-text-body text-[var(--t1)] font-medium truncate">{k.title}</span>
                          <button onClick={() => setExpandedKarussell(null)}
                            className="text-[var(--t3)] hover:text-[var(--t1)] transition-colors px-2">×</button>
                        </div>
                        <div className="overflow-y-auto p-3 grid grid-cols-2 gap-2">
                          {k.slides.map((s, i) => (
                            <div key={s.n} className="relative">
                              <img src={s.url} alt={`Slide ${s.n}`}
                                className="w-full h-auto rounded border border-[var(--border)]/30 cursor-zoom-in"
                                onClick={() => setLightbox({ urls: k.slides.map(x => x.url), index: i })} />
                              <span className="absolute top-1 left-1 info-text-meta text-white bg-black/60 px-1.5 py-0.5 rounded tabular-nums">{s.n}</span>
                            </div>
                          ))}
                        </div>
                        {k.caption && (
                          <div className="px-3 py-2 border-t border-[var(--border)]/40 max-h-32 overflow-y-auto">
                            <pre className="info-text-meta text-[var(--t2)] whitespace-pre-wrap font-sans">{k.caption}</pre>
                          </div>
                        )}
                        <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)]/40 flex-shrink-0">
                          {isPublished ? (
                            <span className="info-text-meta text-[var(--green)] flex items-center gap-1.5">
                              <Check className="info-icon-sm" /> Live auf Instagram
                              {k.published?.ig_media_id && (
                                <a href={`https://www.instagram.com/p/${k.published.ig_media_id}`} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 underline hover:text-[var(--t1)] ml-2">
                                  <ExternalLink className="info-icon-sm" />
                                </a>
                              )}
                            </span>
                          ) : (
                            <>
                              {isQueued ? (
                                <span className="info-text-meta text-[var(--t2)] flex items-center gap-1.5">
                                  <Check className="info-icon-sm text-[var(--t1)]" />
                                  {k.scheduled_for
                                    ? <>Geplant · <span className="text-[var(--t1)] tabular-nums">{formatScheduled(k.scheduled_for)}</span> · 12:30</>
                                    : <>Approved · wartet auf nächsten 12:30-Slot</>}
                                </span>
                              ) : (
                                <button onClick={() => approveKarussell(k.id)} disabled={approveBusy || delBusy}
                                  className="info-text-meta px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5">
                                  {approveBusy ? <Loader2 className="info-icon-sm animate-spin" /> : <Check className="info-icon-sm" />}
                                  <span>Approve</span>
                                </button>
                              )}
                              {isFailed && k.last_error && (
                                <span className="info-text-meta text-[var(--red,#ef4444)] truncate" title={k.last_error}>
                                  Fehler: {k.last_error.slice(0, 80)}
                                </span>
                              )}
                              <button onClick={() => deleteKarussell(k.id)} disabled={approveBusy || delBusy}
                                className="info-text-meta px-3 py-1.5 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.06] disabled:opacity-40 flex items-center gap-1.5 ml-auto">
                                <Trash2 className="info-icon-sm" />
                                <span>Verwerfen</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* ── Beitrag-Modal ── */}
                {expandedBeitrag && (() => {
                  const b = beitraege.find(x => x.id === expandedBeitrag)
                  if (!b) return null
                  const isPublished = !!b.published?.ig_media_id || b.state === 'published'
                  const isQueued = b.state === 'queued'
                  const isFailed = b.state === 'failed'
                  const approveBusy = busyAction === `approve:b:${b.id}`
                  const delBusy = busyAction === `del:b:${b.id}`
                  return (
                    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
                      onClick={() => setExpandedBeitrag(null)}>
                      <div className="max-w-md w-full max-h-[90vh] bg-[var(--bg-1)] border border-[var(--border)] rounded-lg overflow-hidden shadow-2xl flex flex-col"
                        onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]/40 flex-shrink-0">
                          <span className="info-text-body text-[var(--t1)] font-medium truncate">{b.title}</span>
                          <button onClick={() => setExpandedBeitrag(null)}
                            className="text-[var(--t3)] hover:text-[var(--t1)] transition-colors px-2">×</button>
                        </div>
                        <div className="overflow-y-auto p-3">
                          <img src={b.url} alt={b.title}
                            className="w-full h-auto rounded border border-[var(--border)]/30 cursor-zoom-in"
                            onClick={() => setLightbox({ urls: beitraege.map(x => x.url), index: beitraege.findIndex(x => x.id === b.id) })} />
                        </div>
                        {b.caption && (
                          <div className="px-3 py-2 border-t border-[var(--border)]/40 max-h-32 overflow-y-auto">
                            <pre className="info-text-meta text-[var(--t2)] whitespace-pre-wrap font-sans">{b.caption}</pre>
                          </div>
                        )}
                        <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)]/40 flex-shrink-0">
                          {isPublished ? (
                            <span className="info-text-meta text-[var(--green)] flex items-center gap-1.5">
                              <Check className="info-icon-sm" /> Live auf Instagram
                              {b.published?.ig_media_id && (
                                <a href={`https://www.instagram.com/p/${b.published.ig_media_id}`} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 underline hover:text-[var(--t1)] ml-2">
                                  <ExternalLink className="info-icon-sm" />
                                </a>
                              )}
                            </span>
                          ) : (
                            <>
                              {isQueued ? (
                                <span className="info-text-meta text-[var(--t2)] flex items-center gap-1.5">
                                  <Check className="info-icon-sm text-[var(--t1)]" />
                                  {b.scheduled_for
                                    ? <>Geplant · <span className="text-[var(--t1)] tabular-nums">{formatScheduled(b.scheduled_for)}</span> · 12:30</>
                                    : <>Approved · wartet auf nächsten 12:30-Slot</>}
                                </span>
                              ) : (
                                <button onClick={() => approveBeitrag(b.id)} disabled={approveBusy || delBusy}
                                  className="info-text-meta px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5">
                                  {approveBusy ? <Loader2 className="info-icon-sm animate-spin" /> : <Check className="info-icon-sm" />}
                                  <span>Approve</span>
                                </button>
                              )}
                              {isFailed && b.last_error && (
                                <span className="info-text-meta text-[var(--red,#ef4444)] truncate" title={b.last_error}>
                                  Fehler: {b.last_error.slice(0, 80)}
                                </span>
                              )}
                              <button onClick={() => deleteBeitrag(b.id)} disabled={approveBusy || delBusy}
                                className="info-text-meta px-3 py-1.5 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.06] disabled:opacity-40 flex items-center gap-1.5 ml-auto">
                                <Trash2 className="info-icon-sm" />
                                <span>Verwerfen</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* ── Reel-Modal (Detail-Overlay) ── */}
                {expandedReel && (() => {
                  // Find reel + its group (for older versions)
                  const reel = reels.find(r => r.id === expandedReel)
                  if (!reel) return null
                  const m = reel.id.match(/^(clip|opus-rank)(\d+)-v(\d+)$/i)
                  const groupKey = m ? `${m[1].toLowerCase()}${m[2]}` : null
                  const versions = groupKey
                    ? reels.filter(r => r.id.startsWith(groupKey + '-v')).sort((a, b) => {
                        const av = parseInt((a.id.match(/v(\d+)/) || [, '0'])[1], 10)
                        const bv = parseInt((b.id.match(/v(\d+)/) || [, '0'])[1], 10)
                        return bv - av
                      })
                    : [reel]
                  const isPublished = !!reel.published?.ig_media_id || reel.state === 'published'
                  const isQueued = reel.state === 'queued'
                  const isFailed = reel.state === 'failed'
                  const approveBusy = busyAction === `approve:r:${reel.id}`
                  const delBusy = busyAction === `del:r:${reel.id}`
                  const showSched = reel.scheduled_for && reel.state !== 'published'
                  const schedTime = reel.scheduled_time || '18:00'
                  const statusLabel = showSched
                    ? `${formatScheduled(reel.scheduled_for)} ${schedTime}`
                    : stateLabel(reel.state, reel.published?.published_at ?? null)
                  const statusColor = stateColor(reel.state)
                  return (
                    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4"
                      onClick={() => popView()}>
                      <div className="max-w-sm w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-lg overflow-hidden shadow-2xl max-h-[90vh] flex flex-col"
                        onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]/40">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor }} />
                          <span className="info-text-body text-[var(--t1)] font-medium truncate flex-1">{reel.title}</span>
                          <span className="info-text-meta text-[var(--t3)] flex-shrink-0">{statusLabel}</span>
                          <button onClick={() => popView()} className="info-btn-icon"><X className="info-icon-md" /></button>
                        </div>
                        <video src={reel.url} controls autoPlay preload="metadata"
                          className="w-full bg-black flex-shrink-0"
                          style={{ maxHeight: '60vh', aspectRatio: '9 / 16' }} />
                        <div className="overflow-y-auto">
                          <div className="px-3 py-2 info-text-meta text-[var(--t3)] font-mono flex items-center gap-2 flex-wrap">
                            <span>{reel.size_mb.toFixed(1)} MB</span>
                            {reel.duration_sec && <><span>·</span><span>{reel.duration_sec.toFixed(1)}s</span></>}
                            <span>·</span><span>{relativeTime(reel.rendered_at)}</span>
                          </div>
                          {versions.length > 1 && (
                            <div className="px-3 pb-2 flex items-center gap-1 flex-wrap">
                              <span className="info-text-meta text-[var(--t3)]/60 uppercase tracking-wider">Versionen</span>
                              {versions.map(v => {
                                const vm = v.id.match(/v(\d+)/)
                                const label = vm ? `v${vm[1]}` : v.id
                                const active = v.id === expandedReel
                                return (
                                  <button key={v.id} onClick={() => replaceTop({ type: 'reel', id: v.id })}
                                    className={`info-text-meta font-mono px-1.5 py-0.5 rounded cursor-pointer transition-colors ${active ? 'bg-[var(--t2)]/20 text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.06]'}`}>
                                    {label}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                          {isPublished && reel.published && (
                            <div className="px-3 pb-2 info-text-meta text-[var(--green)] flex items-center gap-1.5">
                              <span>Gepostet {reel.published.published_at ? new Date(reel.published.published_at * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                              {reel.published.ig_media_id && (
                                <a href={`https://www.instagram.com/reel/${reel.published.ig_media_id}`} target="_blank" rel="noreferrer"
                                  className="inline-flex items-center gap-1 underline hover:text-[var(--t1)]">
                                  Instagram <ExternalLink className="info-icon-sm" />
                                </a>
                              )}
                            </div>
                          )}
                          {reel.caption && (
                            <div className="mx-3 mb-2 info-text-meta text-[var(--t2)] whitespace-pre-wrap bg-[var(--bg-2)] border border-[var(--border)]/40 rounded-md p-2 leading-[1.55]">
                              {reel.caption}
                            </div>
                          )}
                          <div className="flex gap-2 px-3 pb-2">
                            <a href={reel.url} target="_blank" rel="noreferrer"
                              className="info-btn-chip info-text-meta">
                              <Play className="info-icon-sm" /> Fullscreen
                            </a>
                            {reel.caption_path && (
                              <button onClick={() => openFileTarget(reel.caption_path!)}
                                className="info-btn-chip info-text-meta">
                                <Pencil className="info-icon-sm" /> Caption
                              </button>
                            )}
                          </div>
                          {!isPublished && (
                            <div className="flex items-center gap-2 px-3 pb-3 border-t border-[var(--border)]/40 pt-2">
                              {isQueued ? (
                                <span className="info-text-meta text-[var(--t2)] flex items-center gap-1.5">
                                  <Check className="info-icon-sm text-[var(--t1)]" /> Approved · wartet auf nächsten 19:30-Slot
                                </span>
                              ) : (
                                <button onClick={() => approveReel(reel.id)} disabled={approveBusy || delBusy}
                                  className="info-text-meta px-3 py-1.5 rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5">
                                  {approveBusy ? <Loader2 className="info-icon-sm animate-spin" /> : <Check className="info-icon-sm" />}
                                  <span>Approve</span>
                                </button>
                              )}
                              {isFailed && reel.last_error && (
                                <span className="info-text-meta text-[var(--red,#ef4444)] truncate" title={reel.last_error}>
                                  Fehler: {reel.last_error.slice(0, 80)}
                                </span>
                              )}
                              <button onClick={() => deleteReel(reel.id)} disabled={approveBusy || delBusy}
                                className="info-text-meta px-3 py-1.5 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.06] disabled:opacity-40 flex items-center gap-1.5 ml-auto">
                                <Trash2 className="info-icon-sm" />
                                <span>Verwerfen</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })()}
                </SortableSection>

                {/* ── Health — Schlafkonto, Erholung, Stress, Training ── */}
                <SortableSection
                  sectionId="health"
                  dataInfoSection="health"
                  group="custom"
                  mobile={mobile}
                  order={getSectionOrder('custom', 'health')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <HealthSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('health')} />
                </Suspense>
                </SortableSection>

                {/* ── Finanzen — Lexware Office (Single Source of Truth) ── */}
                <SortableSection
                  sectionId="finance"
                  dataInfoSection="finance"
                  group="custom"
                  mobile={mobile}
                  order={getSectionOrder('custom', 'finance')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <FinanceSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('finance')} />
                </Suspense>
                </SortableSection>

                {/* ── Analytics — eigenes Tracking, Pageviews/Klicks/Funnel ── */}
                <SortableSection
                  sectionId="company-analytics"
                  dataInfoSection="company-analytics"
                  group="custom"
                  mobile={mobile}
                  order={getSectionOrder('custom', 'company-analytics')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <CompanyAnalyticsSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('analytics')} />
                </Suspense>
                </SortableSection>

                {/* ── Personen — vollstaendige Sicht auf people.db ── */}
                <SortableSection
                  sectionId="people"
                  dataInfoSection="people"
                  group="custom"
                  mobile={mobile}
                  order={getSectionOrder('custom', 'people')}
                  dragging={draggingSection}
                  dropTarget={dropTargetSection}
                  onDragStartSection={handleSectionDragStart}
                  onDragOverSection={handleSectionDragOver}
                  onDropSection={handleSectionDrop}
                  onDragEndSection={clearSectionDrag}
                >
                <Suspense fallback={SectionFallback}>
                  <PeopleSection mobile={mobile} onOpenWorkspace={() => onOpenWorkspaceMode?.('people')} />
                </Suspense>
                </SortableSection>

                {/* ── Fokus — Direkt-Link zur Tagesansicht (mobile-only) ── */}
                {mobile && (
                  <button
                    onClick={() => { window.dispatchEvent(new CustomEvent('deck:toggleFokus')) }}
                    className="w-full flex items-center pr-3 py-3 info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors"
                    style={{ paddingLeft: '8px' }}
                    aria-label="Fokus oeffnen"
                  >
                    <ChevronRight className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                    <Clock className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)]" />
                    <span className="text-[var(--t2)] font-medium flex-1">Fokus</span>
                  </button>
                )}

                </div>

              </>
            )}
          </>
        )}
        </div>
      </div>

      {lightbox && (() => {
        const { urls, index } = lightbox
        const prev = () => setLightbox(p => p ? { ...p, index: (p.index - 1 + p.urls.length) % p.urls.length } : p)
        const next = () => setLightbox(p => p ? { ...p, index: (p.index + 1) % p.urls.length } : p)
        return (
          <div className="fixed inset-0 z-[80] bg-black/90 flex items-center justify-center p-4 select-none"
            onClick={() => setLightbox(null)}>
            <button onClick={(e) => { e.stopPropagation(); setLightbox(null) }}
              className="absolute top-4 right-4 text-white/70 hover:text-white p-2"
              title="Schließen (Esc)"><X className="info-icon-lg" /></button>
            {urls.length > 1 && (
              <>
                <button onClick={(e) => { e.stopPropagation(); prev() }}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-3"
                  title="Vorheriges (←)"><ChevronLeft className="info-icon-lg" /></button>
                <button onClick={(e) => { e.stopPropagation(); next() }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-3"
                  title="Nächstes (→)"><ChevronRight className="info-icon-lg" /></button>
                <span className="absolute bottom-4 left-1/2 -translate-x-1/2 info-text-meta text-white/70 tabular-nums">
                  {index + 1} / {urls.length}
                </span>
              </>
            )}
            <img src={urls[index]} alt="" className="max-w-full max-h-[90vh] object-contain"
              onClick={(e) => e.stopPropagation()} />
          </div>
        )
      })()}

    </div>
  )
}
