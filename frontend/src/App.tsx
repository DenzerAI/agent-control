import { useState, useEffect, useRef, useCallback, lazy, Suspense, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ChatPane } from './components/ChatPane'
const Spotlight = lazy(() => import('./components/Spotlight').then(m => ({ default: m.Spotlight })))
import { LinkPreview } from './components/LinkPreview'
import { WorkspaceOverlay, useWorkspaceController, type WorkspaceSpan } from './workspace'
import { GlobalYouTubePlayer } from './components/GlobalYouTubePlayer'
import { Square, MessageSquare, Presentation, Radio, Settings, Plus, X, Pencil, Archive, ArchiveRestore, Search, Wrench, Maximize2, Minimize2 } from 'lucide-react'
import { getAgentNames, getDefaultEngine, useMainAgentName } from './agents'
import { playUISound, preloadUISounds } from './uiSounds'
import { fuzzyIncludes } from './fuzzy'
import { useConversationSearch } from './conversationSearch'
import './index.css'

const AGENT_CHANNEL_ID = ['kl', 'aus-channel'].join('')
const LAYOUT_CHAT_FRACTION_KEY = 'control:layout:chatFraction'
const CHAT_MIN_PX = 380
const WORKSPACE_MIN_PX = 520
const SPLITTER_PX = 10
const DEFAULT_CHAT_FRACTION = 0.42

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// ── Space Switcher ──

interface Space {
  id: string
  label: string
  description: string
  icon: typeof Square
  iconSrc?: string
  ready: boolean
}

const SPACES: Space[] = [
  { id: 'chat', label: 'Agent', description: 'Chat', icon: MessageSquare, ready: true },
  { id: 'workshops', label: 'Workshops', description: 'AI Strategy Sprints', icon: Presentation, ready: false },
  { id: 'signals', label: 'Signals', description: 'Markt & Technologie', icon: Radio, ready: false },
  { id: 'settings', label: 'Settings', description: 'System & Config', icon: Settings, ready: false },
]

function SpaceSwitcher({ current, onSelect, onClose }: { current: string; onSelect: (id: string) => void; onClose: () => void }) {
  const agentName = useMainAgentName()
  const [selected, setSelected] = useState(() => {
    const idx = SPACES.findIndex(s => s.id === current)
    return idx >= 0 ? idx : 0
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Enter') { e.preventDefault(); const s = SPACES[selected]; if (s.ready) onSelect(s.id); return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => (i + 1) % SPACES.length); return }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => (i - 1 + SPACES.length) % SPACES.length); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selected, onSelect, onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xl" />
      <div className="relative flex gap-6" onClick={e => e.stopPropagation()}>
        {SPACES.map((space, i) => {
          const isActive = current === space.id
          const isSelected = selected === i
          const label = space.id === 'chat' ? agentName : space.label
          return (
            <button
              key={space.id}
              onClick={() => space.ready && onSelect(space.id)}
              onMouseEnter={() => setSelected(i)}
              className={`group flex flex-col items-center gap-3 px-8 py-6 rounded-2xl transition-all cursor-pointer ${
                isSelected ? 'bg-white/[0.08] scale-105' : 'bg-white/[0.03] hover:bg-white/[0.06]'
              } ${!space.ready ? 'opacity-30 cursor-default' : ''}`}
            >
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all overflow-hidden ${
                space.iconSrc ? '' :
                isActive ? 'bg-[var(--warm)]/20 text-[var(--warm)]' : isSelected ? 'bg-white/10 text-[var(--t1)]' : 'bg-white/[0.04] text-[var(--t3)]'
              }`}>
                {space.iconSrc ? (
                  <img src={space.iconSrc} alt={label} className="w-full h-full" />
                ) : (
                  <space.icon className="w-7 h-7" />
                )}
              </div>
              <div className="text-center">
                <div className={`text-[16px] font-medium ${isActive ? 'text-[var(--warm)]' : 'text-[var(--t1)]'}`}>{label}</div>
                <div className="text-[13px] text-[var(--t3)] mt-0.5">{space.description}</div>
              </div>
              {isActive && <div className="w-1.5 h-1.5 rounded-full bg-[var(--warm)]" />}
              {!space.ready && <span className="text-[12px] text-[var(--t3)]">bald</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Pane config: each pane holds N tabs (chats), one is active
interface Tab {
  conversationId: string  // '' = empty state, no chat loaded yet
  agent: string           // backend hint for new messages in this tab
}
interface PaneConfig {
  tabs: Tab[]
  activeIndex: number
}

// Safe getter: returns the currently visible tab, with fallback for malformed state
const activeTab = (p: PaneConfig): Tab => p.tabs[p.activeIndex] ?? p.tabs[0] ?? { conversationId: '', agent: 'main' }

const DEFAULT_PANE: PaneConfig = { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 }
const SINGLE_PANE_STORAGE_KEY = 'control:chatPane'

// All possible agents — loaded from Gateway via agents.ts
const AGENT_NAMES = getAgentNames()

// Chat list for pane header conversation picker
interface ConvOption {
  id: string
  agent: string
  title: string
  updated_at: number
  project?: string
  highlight?: boolean
}

function chatAge(ts: number): string {
  if (!ts) return ''
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'gerade'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 172800) return 'gestern'
  const d = new Date(ts * 1000)
  return `${d.getDate()}. ${d.toLocaleString('de', { month: 'short' })}`
}

function PaneHeader({ pane, paneIndex, conversations, archivedChats, busyConvs, isMaximized, onToggleMaximize, onConvChange, onNewChat, onRenameChat, onArchiveChat, onRestoreChat, onLoadArchive }: {
  pane: PaneConfig; paneIndex: number; conversations: ConvOption[]; archivedChats: ConvOption[]; busyConvs: Set<string>; isMaximized: boolean; onToggleMaximize: () => void; onConvChange: (idx: number, convId: string, agent: string) => void; onNewChat: (idx: number, agent: string) => void; onRenameChat: (convId: string, title: string) => void; onArchiveChat: (convId: string) => void; onRestoreChat: (convId: string) => void; onLoadArchive: () => void
}) {
  const [open, setOpenState] = useState(false)
  const setOpen = (v: boolean) => {
    setOpenState(prev => {
      if (prev !== v) playUISound(v ? 'menu-open' : 'menu-close')
      return v
    })
  }
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [search, setSearch] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const [showWork, setShowWork] = useState(false)
  const [workChats, setWorkChats] = useState<ConvOption[]>([])
  const loadWorkChats = useCallback(() => {
    fetch('/api/conversations?limit=0&include_work=true')
      .then(r => r.json())
      .then(d => {
        const convs = (d.conversations || [])
          .filter((c: any) => c.kind === 'work_session')
          .map((c: any) => ({ id: c.id, agent: c.agent, title: c.title, updated_at: c.updated_at || 0, project: c.project || '', highlight: !!c.highlight }))
        setWorkChats(convs)
      })
      .catch(() => {})
  }, [])
  const [ctx, setCtx] = useState<{ convId: string; x: number; y: number } | null>(null)
  const [paneRect, setPaneRect] = useState<{ top: number; left: number; width: number; height: number; tabBottom: number } | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const at = activeTab(pane)
  // Only Agent chats — legacy claude agent ids are mapped to Agent.
  const sourceChats = showArchive ? archivedChats : showWork ? workChats : conversations
  const allChats = sourceChats.filter(c =>
    (c.agent === 'main' || c.agent === 'claude' || c.agent.startsWith('claude-')) && !c.id.startsWith('channel-')
  )
  const { hits: semanticHits } = useConversationSearch(search)
  const semanticOrder = (() => {
    if (!semanticHits) return null
    const m = new Map<string, number>()
    semanticHits.forEach((h, i) => m.set(h.conversationId, i))
    return m
  })()
  const localMatches = (c: typeof allChats[number]) =>
    fuzzyIncludes(c.title || '', search)
  const filtered = search.trim()
    ? semanticOrder
      ? [...allChats]
          .filter(c => semanticOrder.has(c.id) || localMatches(c))
          .sort((a, b) => {
            const ai = semanticOrder.has(a.id) ? semanticOrder.get(a.id)! : Number.MAX_SAFE_INTEGER
            const bi = semanticOrder.has(b.id) ? semanticOrder.get(b.id)! : Number.MAX_SAFE_INTEGER
            if (ai !== bi) return ai - bi
            return b.updated_at - a.updated_at
          })
      : allChats.filter(localMatches)
    : allChats

  // Time-based groups — boundaries used inside panel IIFE
  const d = new Date()
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
  const yesterdayStart = todayStart - 86400
  const weekAgo = todayStart - 7 * 86400

  const commitRename = (convId: string) => {
    if (editTitle.trim()) onRenameChat(convId, editTitle.trim())
    setEditingId(null)
  }

  useEffect(() => {
    if (!open) return
    setSearch(''); setShowArchive(false); setShowWork(false)
    setTimeout(() => searchRef.current?.focus(), 50)
    // Measure parent pane for full-pane overlay
    const measure = () => {
      const paneEl = wrapperRef.current?.closest('[data-pane-container]') as HTMLElement | null
      if (!paneEl) return
      const r = paneEl.getBoundingClientRect()
      const wr = wrapperRef.current?.getBoundingClientRect()
      setPaneRect({ top: r.top, left: r.left, width: r.width, height: r.height, tabBottom: wr ? wr.bottom : r.top + 36 })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  useEffect(() => {
    if (!ctx) return
    const close = () => setCtx(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [ctx])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const tabConv = conversations.find(c => c.id === at.conversationId)
  const tabTitle = tabConv?.title || AGENT_NAMES[at.agent] || at.agent
  const pickerCompact = !!paneRect && paneRect.width < 340

  return (
    <div ref={wrapperRef} className="relative flex-shrink-0">
      {/* Schlanker Chat-Wechsler: eine Pane, keine Tab-Leiste. */}
      <div
        className="chat-pane-titlebar group relative w-full flex items-center min-h-[var(--header-row-h)]"
      >
        <div
          onClick={() => setOpen(true)}
          className="chat-pane-switcher"
          title={tabTitle}
        >
          <span>{tabTitle}</span>
        </div>
        <div
          id={`chat-pane-controls-${paneIndex}`}
          className={`absolute right-0 top-0 flex h-[var(--header-row-h)] items-center gap-1 pl-1 pr-6 pt-[5px] pb-[3px] transition-opacity ${isMaximized ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleMaximize() }}
            className="inline-flex h-6 w-6 items-center justify-center text-[var(--t3)] hover:text-[var(--t1)] transition-colors"
            title={isMaximized ? 'Verkleinern' : 'Maximieren'}
            aria-label={isMaximized ? 'Chat-Pane verkleinern' : 'Chat-Pane maximieren'}
          >
            {isMaximized ? <Minimize2 className="h-[14px] w-[14px]" strokeWidth={1.8} /> : <Maximize2 className="h-[14px] w-[14px]" strokeWidth={1.8} />}
          </button>
        </div>
      </div>
      {open && paneRect && (
        <>
          {/* Transparenter Backdrop nur für click-outside */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          {/* Panel dockt bündig unter Tab-Strip an, volle Pane-Breite, scharfe Ecken. Ruhiger Hintergrund (var(--bg)) wie der Rest. */}
          <div
            className="chat-picker-panel fixed z-50 flex flex-col bg-[var(--bg)] border-b border-[var(--border)] overflow-hidden animate-[fadeIn_0.12s_ease]"
            data-compact={pickerCompact ? 'true' : undefined}
            style={{
              top: paneRect.tabBottom,
              left: paneRect.left,
              width: paneRect.width,
              height: paneRect.top + paneRect.height - paneRect.tabBottom,
            }}
          >
            {/* Eine Control-Pille: Neu, Suche und Archiv bleiben auch in schmalen Panes in einer Zeile. */}
            <div className="chat-picker-toolbar">
              <div className="chat-picker-pill">
              {!showArchive && (
                <button
                  onClick={() => {
                    onNewChat(paneIndex, at.agent)
                    setOpen(false)
                  }}
                  className="chat-picker-new"
                  title="Neuer Chat"
                >
                  <Plus className="w-[18px] h-[18px]" />
                </button>
              )}
              {!showArchive && <div className="chat-picker-divider" />}
              <div className="chat-picker-search">
                <Search className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={pickerCompact ? 'Suchen' : showArchive ? 'Archiv durchsuchen' : 'Chats durchsuchen'}
                  className="flex-1 bg-transparent outline-none text-[15px] text-[var(--t1)] placeholder:text-[var(--t3)]/60 min-w-0"
                />
              </div>
              <div className="chat-picker-divider" />
              <button
                onClick={() => { const next = !showWork; setShowWork(next); if (next) { setShowArchive(false); loadWorkChats() } }}
                className={`chat-picker-archive ${showWork ? 'is-active' : ''}`}
                title={showWork ? 'Normale Chats' : 'Arbeitsläufe'}
              >
                <Wrench className="w-[18px] h-[18px]" />
              </button>
              <button
                onClick={() => { const next = !showArchive; setShowArchive(next); if (next) { setShowWork(false); onLoadArchive() } }}
                className={`chat-picker-archive ${showArchive ? 'is-active' : ''}`}
                title={showArchive ? 'Aktive Chats' : 'Archiv'}
              >
                <Archive className="w-[18px] h-[18px]" />
              </button>
              </div>
            </div>

            {/* Chat-Liste, zeit-gruppiert, einzeilig */}
            <div className="chat-picker-list overflow-y-auto overflow-x-hidden flex-1 min-h-0">
              {(() => {
                const chatList = filtered
                const localGroups: { label: string; chats: ConvOption[] }[] = [
                  { label: 'Heute', chats: [] },
                  { label: 'Gestern', chats: [] },
                  { label: 'Letzte 7 Tage', chats: [] },
                  { label: 'Älter', chats: [] },
                ]
                for (const c of [...chatList].sort((a, b) => b.updated_at - a.updated_at)) {
                  if (c.updated_at >= todayStart) localGroups[0].chats.push(c)
                  else if (c.updated_at >= yesterdayStart) localGroups[1].chats.push(c)
                  else if (c.updated_at >= weekAgo) localGroups[2].chats.push(c)
                  else localGroups[3].chats.push(c)
                }
                const renderChat = (c: ConvOption) => {
                  const isCurrent = !showArchive && c.id === at.conversationId
                  const isBusy = !showArchive && busyConvs.has(c.id)
                  const isHighlight = !showArchive && !!c.highlight && !isCurrent
                  const isEditing = editingId === c.id
                  return (
                    <div
                      key={c.id}
                      onContextMenu={e => {
                        if (showArchive || isEditing) return
                        e.preventDefault(); e.stopPropagation()
                        setCtx({ convId: c.id, x: e.clientX, y: e.clientY })
                      }}
                      className={`chat-picker-row group relative flex items-center gap-2 transition-colors ${
                        isCurrent ? 'is-current' : ''
                      }`}
                    >
                      {isEditing ? (
                        <input autoFocus value={editTitle} onChange={e => setEditTitle(e.target.value)}
                          onBlur={() => commitRename(c.id)}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingId(null) }}
                          className="chat-picker-row-title flex-1 min-w-0 bg-transparent border-b border-[var(--border)] outline-none text-[var(--t1)] py-0"
                          onClick={e => e.stopPropagation()} />
                      ) : showArchive ? (
                        <span className="chat-picker-row-title flex-1 min-w-0 truncate text-[var(--t3)]">{c.title || 'Neuer Chat'}</span>
                      ) : (
                        <button
                          onClick={() => {
                            if (c.highlight) {
                              fetch(`/api/conversations/${c.id}/seen`, { method: 'POST' }).catch(() => {})
                              setTimeout(() => window.dispatchEvent(new CustomEvent('deck:chatsChanged')), 150)
                            }
                            onConvChange(paneIndex, c.id, c.agent); setOpen(false)
                          }}
                          className={`chat-picker-row-title flex-1 min-w-0 text-left truncate cursor-pointer ${isCurrent ? 'text-[var(--t1)] font-medium' : isHighlight ? 'agent-tab-pulse font-medium' : isBusy ? 'text-[var(--t1)] group-hover:text-[var(--t1)]' : 'text-[var(--t2)] group-hover:text-[var(--t1)]'}`}
                        >
                          {c.title || 'Neuer Chat'}
                        </button>
                      )}
                      {!isEditing && !showArchive && (
                        <div className="chat-picker-row-meta relative flex items-center justify-end flex-shrink-0 h-7">
                          <div className="chat-picker-row-time flex items-center gap-1.5 text-[var(--t3)] group-hover:opacity-0 transition-opacity">
                            <span className="tabular-nums">{chatAge(c.updated_at)}</span>
                          </div>
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute inset-y-0 right-0 flex items-center gap-0.5">
                            <button className="p-1.5 hover:bg-white/[0.08] text-[var(--t2)] hover:text-[var(--t1)] transition-colors cursor-pointer"
                              onClick={e => { e.stopPropagation(); setEditingId(c.id); setEditTitle(c.title || '') }} title="Umbenennen">
                              <Pencil className="w-[18px] h-[18px]" />
                            </button>
                            <button className="p-1.5 hover:bg-white/[0.08] text-[var(--t2)] hover:text-[var(--t1)] transition-colors cursor-pointer"
                              onClick={e => { e.stopPropagation(); onArchiveChat(c.id) }} title="Archivieren">
                              <Archive className="w-[18px] h-[18px]" />
                            </button>
                          </div>
                        </div>
                      )}
                      {!isEditing && showArchive && (
                        <div className="chat-picker-row-meta relative flex items-center justify-end flex-shrink-0 h-7">
                          <span className="chat-picker-row-time text-[var(--t3)] tabular-nums group-hover:opacity-0 transition-opacity">{chatAge(c.updated_at)}</span>
                          <button className="opacity-0 group-hover:opacity-100 transition-opacity absolute inset-y-0 right-0 flex items-center p-1.5 hover:bg-white/[0.08] text-[var(--t2)] hover:text-[var(--t1)] cursor-pointer"
                            onClick={e => { e.stopPropagation(); onRestoreChat(c.id) }} title="Wiederherstellen">
                            <ArchiveRestore className="w-[18px] h-[18px]" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                }
                const nonEmpty = localGroups.filter(g => g.chats.length > 0)
                if (nonEmpty.length === 0) {
                  return (
                    <div className="px-4 py-8 text-center text-[15px] text-[var(--t3)]">
                      {search ? 'Keine Treffer' : showArchive ? 'Kein Archiv' : 'Noch keine Chats'}
                    </div>
                  )
                }
                return nonEmpty.map((g, groupIndex) => (
                  <div key={g.label} className={`chat-picker-group ${groupIndex === 0 ? 'is-first' : ''}`}>
                    <div className="chat-picker-group-label">{g.label}</div>
                    {g.chats.map(renderChat)}
                  </div>
                ))
              })()}
            </div>

          </div>
        </>
      )}

      {/* Right-click context menu */}
      {ctx && (() => {
        const c = conversations.find(x => x.id === ctx.convId)
        if (!c) return null
        return (
          <div
            className="fixed z-[60] bg-[var(--bg-2)] border border-[var(--border-f)] rounded-lg py-1 min-w-[180px] shadow-[0_8px_30px_rgba(0,0,0,0.5)] animate-[fadeIn_0.08s_ease]"
            style={{ left: ctx.x, top: ctx.y }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { setEditingId(c.id); setEditTitle(c.title || ''); setCtx(null) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-[var(--t2)] hover:bg-white/[0.06] cursor-pointer transition-colors">
              <Pencil className="w-3 h-3" /> Umbenennen
            </button>
            <div className="h-px bg-[var(--border)] my-0.5" />
            <button onClick={() => { onArchiveChat(c.id); setCtx(null) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[14px] text-[var(--t2)] hover:bg-white/[0.06] cursor-pointer transition-colors">
              <Archive className="w-3 h-3" /> Archivieren
            </button>
          </div>
        )
      })()}
    </div>
  )
}

function migrateTab(t: any): Tab {
  return {
    agent: t?.agent || 'main',
    conversationId: typeof t?.conversationId === 'string' && !t.conversationId.startsWith('channel-')
      ? t.conversationId
      : '',
  }
}

function loadPaneConfig(): PaneConfig {
  try {
    const stored = localStorage.getItem(SINGLE_PANE_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed?.tabs) && parsed.tabs.length > 0) {
        const tabs = parsed.tabs.map(migrateTab)
        const idx = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0
        return { tabs, activeIndex: Math.max(0, Math.min(idx, tabs.length - 1)) }
      }
    }
    const legacy = localStorage.getItem('control:panes:1')
    if (legacy) {
      const parsed = JSON.parse(legacy)
      const first = Array.isArray(parsed) ? parsed[0] : null
      if (Array.isArray(first?.tabs) && first.tabs.length > 0) {
        const tabs = first.tabs.map(migrateTab)
        const idx = typeof first.activeIndex === 'number' ? first.activeIndex : 0
        return { tabs, activeIndex: Math.max(0, Math.min(idx, tabs.length - 1)) }
      }
    }
  } catch {}
  return DEFAULT_PANE
}

function savePaneConfig(config: PaneConfig) {
  localStorage.setItem(SINGLE_PANE_STORAGE_KEY, JSON.stringify(config))
}

export default function App() {
  const [paneConfig, setPaneConfig] = useState<PaneConfig>(() => loadPaneConfig())
  const paneConfigs = [paneConfig]
  const setPaneConfigs = useCallback((next: PaneConfig[] | ((prev: PaneConfig[]) => PaneConfig[])) => {
    setPaneConfig(prev => {
      const resolved = typeof next === 'function' ? next([prev]) : next
      const first = resolved[0] || prev
      savePaneConfig(first)
      return first
    })
  }, [])
  const [showInfo, setShowInfo] = useState(() => localStorage.getItem('control:showInfo') === 'true')
  const activePane = 0
  const activeTabKey = `0:${paneConfig.activeIndex}`
  const lastActiveTabKeyRef = useRef<string | null>(null)
  const skipNextTabClickRef = useRef(false)
  useEffect(() => {
    if (lastActiveTabKeyRef.current !== null && lastActiveTabKeyRef.current !== activeTabKey) {
      if (skipNextTabClickRef.current) {
        skipNextTabClickRef.current = false
      } else {
        playUISound('tab-click', 0.5)
      }
    }
    lastActiveTabKeyRef.current = activeTabKey
  }, [activeTabKey])
  const [search, setSearch] = useState(false)
  const [spaceSwitcher, setSpaceSwitcher] = useState(false)
  const [imagePreview, setImagePreview] = useState<{ path: string; src: string } | null>(null)
  const workspace = useWorkspaceController()
  const [activeSpace, setActiveSpace] = useState('chat')
  const [deckFile, setDeckFile] = useState('')
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null)
  const [, setUnread] = useState<Set<string>>(new Set())
  const [busyConvs, setBusyConvs] = useState<Set<string>>(new Set())
  const contentFrameRef = useRef<HTMLDivElement | null>(null)
  const [contentFrameWidth, setContentFrameWidth] = useState(() => typeof window === 'undefined' ? 0 : window.innerWidth)
  const [chatFraction, setChatFraction] = useState(() => {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(LAYOUT_CHAT_FRACTION_KEY)
    const parsed = raw ? Number(raw) : DEFAULT_CHAT_FRACTION
    return Number.isFinite(parsed) ? clampNumber(parsed, 0.24, 0.7) : DEFAULT_CHAT_FRACTION
  })
  const [conversations, setConversations] = useState<ConvOption[]>([])
  const [archivedChats, setArchivedChats] = useState<ConvOption[]>([])

  useEffect(() => { preloadUISounds() }, [])

  useEffect(() => {
    const el = contentFrameRef.current
    if (!el) return
    const measure = () => setContentFrameWidth(el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_CHAT_FRACTION_KEY, String(chatFraction)) } catch {}
  }, [chatFraction])

  // archived chat support is used by PaneHeader
  const loadArchivedChats = useCallback(() => {
    fetch('/api/conversations?limit=0&archived=true')
      .then(r => r.json())
      .then(d => {
        const convs = (d.conversations || []).filter((c: any) => c.archived).map((c: any) => ({ id: c.id, agent: c.agent, title: c.title, updated_at: c.updated_at || 0 }))
        setArchivedChats(convs)
      })
      .catch(() => {})
  }, [])

  // Load conversation list for pane headers
  const loadConversations = useCallback(() => {
    fetch('/api/conversations?limit=0')
      .then(r => r.json())
      .then(d => {
        const convs = (d.conversations || []).map((c: any) => ({ id: c.id, agent: c.agent, title: c.title, updated_at: c.updated_at || 0, project: c.project || '', highlight: !!c.highlight }))
        // Nur setzen, wenn sich wirklich etwas geaendert hat. Sonst loest der
        // 15s-Poll im Leerlauf einen kompletten Re-Render des ganzen Baums aus.
        setConversations(prev => {
          if (prev.length === convs.length && prev.every((p, i) => {
            const n = convs[i]
            return p.id === n.id && p.title === n.title && p.agent === n.agent
              && p.updated_at === n.updated_at && p.project === n.project && p.highlight === n.highlight
          })) return prev
          return convs
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadConversations()
    const interval = setInterval(loadConversations, 45000)
    const handler = () => loadConversations()
    window.addEventListener('deck:chatsChanged', handler)
    // Live title updates from LLM title generation
    const titleHandler = (e: Event) => {
      const { conversationId, title } = (e as CustomEvent).detail
      setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, title } : c))
    }
    window.addEventListener('deck:titleUpdate', titleHandler)
    // Auto-Projekt-Zuordnung — Sidebar live updaten
    const projectHandler = (e: Event) => {
      const { conversationId, projectId } = (e as CustomEvent).detail
      setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, project: projectId || '' } : c))
    }
    window.addEventListener('deck:projectUpdate', projectHandler)
    return () => { clearInterval(interval); window.removeEventListener('deck:chatsChanged', handler); window.removeEventListener('deck:titleUpdate', titleHandler); window.removeEventListener('deck:projectUpdate', projectHandler) }
  }, [loadConversations])

  // Agent-Channel: wenn die Conv highlight=1 hat, übernimmt sie Pane 1 wie ein
  // Chatwechsel — Agent-Tab wandert an Position 0 und wird aktiv, der vorherige
  // aktive Chat rutscht als Tab nach rechts. So weiß der Nutzer sofort, dass es
  // was Neues gibt. Beim Schließen (closeTab) wird /seen gerufen, damit der
  // Auto-Spawn erst beim nächsten echten Post wieder triggert.
  // Konzept: proaktiver Agent-Channel.
  useEffect(() => {
    const agent = conversations.find(c => c.id === AGENT_CHANNEL_ID && c.highlight)
    if (!agent) return
    const pane0 = paneConfigs[0]
    if (!pane0) return
    const agentIdx = pane0.tabs.findIndex(t => t.conversationId === AGENT_CHANNEL_ID)
    // Schon Agent aktiv in Pane 1 → nichts tun (und /seen wird durch ChatPane gleich getriggert).
    if (agentIdx >= 0 && pane0.activeIndex === agentIdx) return
    setPaneConfigs(prev => {
      if (!prev.length) return prev
      const next = [...prev]
      const pane = next[0]
      const onlyEmpty = pane.tabs.length === 1 && !pane.tabs[0].conversationId
      if (onlyEmpty) {
        next[0] = { tabs: [{ conversationId: AGENT_CHANNEL_ID, agent: 'main' }], activeIndex: 0 }
      } else {
        // Agent vorne einsortieren (falls noch nicht da) und aktiv schalten.
        const existing = pane.tabs.findIndex(t => t.conversationId === AGENT_CHANNEL_ID)
        const tabs = existing >= 0
          ? [pane.tabs[existing], ...pane.tabs.filter((_, i) => i !== existing)]
          : [{ conversationId: AGENT_CHANNEL_ID, agent: 'main' }, ...pane.tabs]
        next[0] = { tabs, activeIndex: 0 }
      }
      savePaneConfig(next[0])
      return next
    })
  }, [conversations, paneConfigs])

  const activeAgent = activeTab(paneConfig).agent

  // ── Pane-Chat-Verwaltung: eine Pane hält genau einen sichtbaren Chat. ──

  const addOrSwitchTab = (paneIndex: number, convId: string, agent: string) => {
    setPaneConfigs(prev => {
      const next = [...prev]
      const pane = next[paneIndex]
      if (!pane) return prev
      next[paneIndex] = { tabs: [{ conversationId: convId, agent }], activeIndex: 0 }
      return next
    })
    if (convId) {
      setUnread(prev => { const n = new Set(prev); n.delete(convId); return n })
      window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent, conversationId: convId, paneIndex } }))
    }
  }

  const replaceTabInPane = (paneIndex: number, convId: string, agent: string) => {
    setPaneConfigs(prev => {
      const next = [...prev]
      const pane = next[paneIndex]
      if (!pane) return prev
      next[paneIndex] = { tabs: [{ conversationId: convId, agent }], activeIndex: 0 }
      return next
    })
    if (convId) {
      setUnread(prev => { const n = new Set(prev); n.delete(convId); return n })
      window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent, conversationId: convId, paneIndex } }))
    }
  }


  const closeTab = (paneIndex: number, tabIndex: number) => {
    playUISound('tab-close', 0.5)
    skipNextTabClickRef.current = true
    // Wenn der geschlossene Tab der Agent-Channel ist und noch highlight=true hat,
    // markieren wir ihn als gesehen — sonst spawnt der Auto-Spawn-Hook ihn beim
    // nächsten Polling-Tick sofort wieder rein. Re-Spawn passiert erst beim
    // nächsten echten Post (Backend setzt highlight wieder auf 1).
    const closing = paneConfigs[paneIndex]?.tabs[tabIndex]
    if (closing?.conversationId === AGENT_CHANNEL_ID) {
      const agent = conversations.find(c => c.id === AGENT_CHANNEL_ID)
      if (agent?.highlight) {
        fetch(`/api/conversations/${AGENT_CHANNEL_ID}/seen`, { method: 'POST' }).catch(() => {})
        setConversations(prev => prev.map(c => c.id === AGENT_CHANNEL_ID ? { ...c, highlight: false } : c))
      }
    }
    let needsLoad: { agent: string; convId: string } | null = null
    setPaneConfigs(prev => {
      const next = [...prev]
      const pane = next[paneIndex]
      if (!pane) return prev
      if (pane.tabs.length === 1) {
        // Letzter Tab → Empty State, aber Pane bleibt bestehen
        next[paneIndex] = { tabs: [{ conversationId: '', agent: pane.tabs[0].agent }], activeIndex: 0 }
        needsLoad = { agent: pane.tabs[0].agent, convId: '' }
      } else {
        const newTabs = pane.tabs.filter((_, i) => i !== tabIndex)
        let newActive: number
        if (pane.activeIndex < tabIndex) newActive = pane.activeIndex
        else if (pane.activeIndex === tabIndex) newActive = Math.min(tabIndex, newTabs.length - 1)
        else newActive = pane.activeIndex - 1
        next[paneIndex] = { tabs: newTabs, activeIndex: newActive }
        const target = newTabs[newActive]
        if (target.conversationId !== pane.tabs[pane.activeIndex].conversationId) {
          needsLoad = { agent: target.agent, convId: target.conversationId }
        }
      }
      return next
    })
    if (needsLoad) {
      const n = needsLoad as { agent: string; convId: string }
      // Auch leere convId triggern — ChatPane reagiert auf Prop-Änderung und geht in Empty State
      window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent: n.agent, conversationId: n.convId, paneIndex } }))
    }
  }

  const createNewChat = async (agent: string, targetPane?: number, project?: string) => {
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, engine: getDefaultEngine(), ...(project ? { project } : {}) }),
      })
      const data = await res.json()
      if (data.id) {
        addOrSwitchTab(targetPane ?? activePane, data.id, agent)
        window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
      }
    } catch {}
  }

  const dismissedArtifactRef = useRef<string>('')
  // Track unread activity — by conversation ID
  useEffect(() => {
    const handler = (e: Event) => {
      const { agent, conversationId, source } = (e as CustomEvent).detail || {}
      const convId = conversationId || (agent ? `channel-${agent}` : '')
      if (!convId) return
      const visConvs = new Set<string>()
      for (const p of paneConfigs) {
        const a = activeTab(p)
        if (a.conversationId) visConvs.add(a.conversationId)
      }
      if (!visConvs.has(convId)) {
        setUnread(prev => new Set(prev).add(convId))
        if (source !== 'mobile' && (typeof document === 'undefined' || document.hasFocus())) playUISound('tell-message', 0.6)
      }
    }
    window.addEventListener('deck:unread', handler)
    return () => window.removeEventListener('deck:unread', handler)
  }, [paneConfigs])

  // Global busy tracking — which conversations are currently streaming?
  useEffect(() => {
    const handler = (e: Event) => {
      const { conversationId: cid, busy } = (e as CustomEvent).detail || {}
      if (!cid) return
      setBusyConvs(prev => {
        const next = new Set(prev)
        if (busy) next.add(cid); else next.delete(cid)
        return next
      })
    }
    window.addEventListener('deck:convBusy', handler)
    return () => window.removeEventListener('deck:convBusy', handler)
  }, [])

  // ── Voice-Kommandos ──
  // Agent kann via Sprache die InfoPane togglen und auf Sektionen springen.
  // Pane-Layout-Kommandos werden ignoriert, weil der Desktop nur noch eine Chat-Pane hat.
  useEffect(() => {
    const onInfo = (e: Event) => {
      const action = String((e as CustomEvent).detail?.action || 'toggle')
      setShowInfo(prev => {
        const next = action === 'open' ? true : action === 'close' ? false : !prev
        if (next !== prev) playUISound(next ? 'info-open' : 'info-close')
        if (!next && deckFile) dismissedArtifactRef.current = deckFile
        if (next) dismissedArtifactRef.current = ''
        localStorage.setItem('control:showInfo', String(next))
        return next
      })
    }
    const onSection = () => {
      // Sektion-Trigger impliziert: InfoPane offen. Die InfoPane selbst
      // hört auf `deck:info-section` und kümmert sich um Auswahl/Scroll.
      setShowInfo(prev => {
        if (!prev) {
          playUISound('info-open')
          localStorage.setItem('control:showInfo', 'true')
          return true
        }
        return prev
      })
    }
    window.addEventListener('deck:info', onInfo)
    window.addEventListener('deck:info-section', onSection)
    return () => {
      window.removeEventListener('deck:info', onInfo)
      window.removeEventListener('deck:info-section', onSection)
    }
  }, [deckFile])

  const openFilePathFromDetail = (detail: unknown): string => {
    if (typeof detail === 'string') return detail
    if (detail && typeof detail === 'object' && 'path' in detail) return String((detail as { path?: unknown }).path || '')
    return ''
  }

  const openInInfo = (path: string) => {
    const filePath = String(path || '')
    if (!filePath) return
    dismissedArtifactRef.current = ''
    if (workspace.openFile(filePath)) return
    setDeckFile(filePath)
    if (!showInfo) { setShowInfo(true); localStorage.setItem('control:showInfo', 'true') }
  }

  // Datei aus InfoPane in neuen Agent-Chat übernehmen: Chat anlegen und Composer vorbefüllen.
  useEffect(() => {
    const handler = async (e: Event) => {
      const { filePath, content } = (e as CustomEvent).detail || {}
      if (!content) return
      const fileName = (filePath || '').split('/').pop() || 'Artefakt'
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: 'main', engine: getDefaultEngine() }),
        })
        const data = await res.json()
        if (!data.id) return
        addOrSwitchTab(activePane, data.id, 'main')
        window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
        const quote = `Ich möchte folgendes Artefakt mit dir besprechen — **${fileName}**:\n\n---\n\n${content}\n\n---\n\n`
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('deck:useSkill', { detail: { agentId: 'main', text: quote } }))
        }, 150)
      } catch {}
    }
    window.addEventListener('deck:discussFile', handler)
    return () => window.removeEventListener('deck:discussFile', handler)
  }, [activePane])

  // Check for unread messages on startup
  useEffect(() => {
    const checkUnread = () => {
      fetch('/api/unread')
        .then(r => r.json())
        .then(data => {
          const counts = data.unread || {}
          const newUnread = new Set<string>()
          for (const [convId, count] of Object.entries(counts)) {
            if ((count as number) > 0) newUnread.add(convId)
          }
          for (const p of paneConfigs) {
            const a = activeTab(p)
            if (a.conversationId) newUnread.delete(a.conversationId)
          }
          if (newUnread.size > 0) setUnread(prev => new Set([...prev, ...newUnread]))
        })
        .catch(() => {})
    }
    checkUnread()
    const handler = () => { if (document.visibilityState === 'visible') checkUnread() }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [paneConfigs])

  useEffect(() => {
    const wa = (e: Event) => {
      const chatId = (e as CustomEvent).detail?.chatId
      if (!chatId) return
      workspace.openMode('inbox')
    }
    const mail = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (!d?.account || !d?.uid) return
      workspace.openMode('inbox')
    }
    window.addEventListener('deck:openWaChat', wa)
    window.addEventListener('deck:openMailThread', mail)
    return () => {
      window.removeEventListener('deck:openWaChat', wa)
      window.removeEventListener('deck:openMailThread', mail)
    }
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      try { sessionStorage.setItem('workspace:loops:draft', JSON.stringify(detail)) } catch {}
      workspace.openMode('loops')
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('deck:loopsDraft', { detail })), 0)
    }
    window.addEventListener('deck:startOfferLoop', handler)
    window.addEventListener('deck:startBauhof', handler)
    window.addEventListener('deck:startWerkbank', handler)
    return () => {
      window.removeEventListener('deck:startOfferLoop', handler)
      window.removeEventListener('deck:startBauhof', handler)
      window.removeEventListener('deck:startWerkbank', handler)
    }
  }, [workspace])

  // Expliziter Klick auf einen Pfad-Link im Chat: HTML/Markdown in den Workspace,
  // sonst weiter in die InfoPane.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = openFilePathFromDetail((e as CustomEvent).detail)
      if (!path) return
      openInInfo(path)
    }
    window.addEventListener('deck:openFile', handler)
    return () => window.removeEventListener('deck:openFile', handler)
  }, [showInfo])

  // Globale Suche aus dem Workspace-File-System öffnen (gleiche Spotlight-Suche wie Cmd+S).
  useEffect(() => {
    const handler = () => setSearch(true)
    window.addEventListener('deck:openSearch', handler)
    return () => window.removeEventListener('deck:openSearch', handler)
  }, [])

  // Klick-Delegation für Pfad-Links im Chat: normaler Klick → InfoPane,
  // Modifier-Klick (cmd/ctrl/shift/alt, Mittel-Klick) → Default-Verhalten (Download / neuer Tab).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const a = target.closest('a[data-path-link="1"]') as HTMLAnchorElement | null
      if (!a) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      e.preventDefault()
      try {
        const url = new URL(a.href, window.location.origin)
        const path = url.searchParams.get('path') || ''
        if (path) window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path } }))
      } catch {}
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // Klick-Delegation für Chat-Bilder: normal → Lightbox, Modifier → Default (neuer Tab/Download).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const img = target.closest('img[data-image-preview="1"]') as HTMLImageElement | null
      if (!img) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      e.preventDefault()
      const path = img.getAttribute('data-image-path') || ''
      const src = img.getAttribute('src') || ''
      if (path || src) setImagePreview({ path, src })
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // Esc schließt Lightbox
  useEffect(() => {
    if (!imagePreview) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setImagePreview(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [imagePreview])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'Space') { e.preventDefault(); setSpaceSwitcher(v => !v); return }
      if (e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); workspace.toggle(); return }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); workspace.toggle(); return }
      if (e.ctrlKey && !e.metaKey && e.key === 'i') { e.preventDefault(); workspace.toggle(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); setSearch(v => !v); return }
      if (e.altKey && e.key === 'n') { e.preventDefault(); createNewChat(activeAgent); return }
      // CMD+E toggelt den Workspace (CMD+5 schluckt der Browser als Tab-Shortcut, bleibt aber für die PWA aktiv)
      if (e.metaKey && !e.ctrlKey && (e.key === '5' || e.key.toLowerCase() === 'e')) { e.preventDefault(); workspace.toggle(); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeAgent, showInfo])

  useEffect(() => {
    if (focusedPaneIdx === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (search || spaceSwitcher) return
      setFocusedPaneIdx(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedPaneIdx, search, spaceSwitcher])

  // Workspace links, ein Chat rechts. Der Splitter teilt nur diese beiden Hauptflächen.
  const WS_RAIL_PX = 200
  const WS_RAIL_COLLAPSED_PX = 64
  const N = paneConfigs.length
  const effectiveWorkspaceSpan = 1 as WorkspaceSpan
  const frameWidth = Math.max(contentFrameWidth, 0)
  const minSplitWidth = WORKSPACE_MIN_PX + SPLITTER_PX + CHAT_MIN_PX
  const canSplitWorkspace = workspace.open && frameWidth >= minSplitWidth
  const shouldOverlayWorkspace = workspace.open && !canSplitWorkspace
  const maxChatWidth = Math.max(CHAT_MIN_PX, frameWidth - WORKSPACE_MIN_PX - SPLITTER_PX)
  const chatWidth = canSplitWorkspace
    ? clampNumber(Math.round(frameWidth * chatFraction), CHAT_MIN_PX, maxChatWidth)
    : 0
  const workspaceWidth = canSplitWorkspace
    ? Math.max(WORKSPACE_MIN_PX, frameWidth - chatWidth - SPLITTER_PX)
    : 0

  const workspaceColTrack = workspace.open
    ? canSplitWorkspace ? `${workspaceWidth}px` : 'minmax(0, 1fr)'
    : `${workspace.collapsed ? WS_RAIL_COLLAPSED_PX : WS_RAIL_PX}px`
  const horizontalGridStyle: CSSProperties = {
    gridTemplateColumns: canSplitWorkspace
      ? `${workspaceColTrack} ${SPLITTER_PX}px ${chatWidth}px`
      : shouldOverlayWorkspace
        ? 'minmax(0, 1fr)'
        : N > 0
          ? `${workspaceColTrack} minmax(0, 1fr)`
          : workspaceColTrack,
  }

  const updateSplitFromClientX = useCallback((clientX: number, rect: DOMRect) => {
    const nextWorkspaceWidth = clampNumber(clientX - rect.left, WORKSPACE_MIN_PX, rect.width - SPLITTER_PX - CHAT_MIN_PX)
    const nextChatWidth = rect.width - nextWorkspaceWidth - SPLITTER_PX
    setChatFraction(clampNumber(nextChatWidth / rect.width, 0.24, 0.7))
  }, [])

  const startLayoutResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canSplitWorkspace || !contentFrameRef.current) return
    event.preventDefault()
    const rect = contentFrameRef.current.getBoundingClientRect()
    updateSplitFromClientX(event.clientX, rect)
    document.body.classList.add('is-resizing-main-layout')
    const onMove = (moveEvent: PointerEvent) => updateSplitFromClientX(moveEvent.clientX, rect)
    const onEnd = () => {
      document.body.classList.remove('is-resizing-main-layout')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }, [canSplitWorkspace, updateSplitFromClientX])

  const nudgeLayoutSplit = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canSplitWorkspace) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? 1 : -1
    setChatFraction(prev => clampNumber(prev + direction * 0.03, 0.24, 0.7))
  }, [canSplitWorkspace])

  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (busyConvs.size === 0) return
    const id = setInterval(() => setNowTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [busyConvs.size])

  const renderedPanes = paneConfigs.map((pane, idx) => {
    const isFocused = focusedPaneIdx === idx
    return (
    <div
      key={idx}
      data-pane-container
      className={isFocused
        ? 'fixed inset-0 z-40 bg-[var(--bg)] overflow-hidden'
        : 'relative bg-[var(--bg)] min-h-0 overflow-hidden rounded-l-[14px] rounded-r-[14px]'}
    >
      {/* Pane header overlay — sitzt absolut oben auf dem Chat, damit Messages dahinter durchscrollen können */}
      <div className="absolute top-0 left-0 right-0 z-20">
      <PaneHeader
        pane={pane}
        paneIndex={idx}
        conversations={conversations}
        archivedChats={archivedChats}
        onConvChange={(pi, convId, agent) => replaceTabInPane(pi, convId, agent)}
        onNewChat={(pi, agent) => createNewChat(agent, pi)}
        onRenameChat={(convId, title) => {
          fetch(`/api/conversations/${convId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
          }).then(() => { loadConversations(); window.dispatchEvent(new CustomEvent('deck:chatsChanged')) })
        }}
        onArchiveChat={(convId) => {
          fetch(`/api/conversations/${convId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: true }),
          }).then(() => {
            loadConversations()
            window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
            // Wenn der archivierte Chat in irgendeinem Tab dieser Pane offen ist, Tab schließen.
            const tabIdx = paneConfigs[idx]?.tabs.findIndex(t => t.conversationId === convId) ?? -1
            if (tabIdx >= 0) closeTab(idx, tabIdx)
          })
        }}
        onRestoreChat={(convId) => {
          fetch(`/api/conversations/${convId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: false }),
          }).then(() => {
            loadConversations()
            loadArchivedChats()
            window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
          })
        }}
        onLoadArchive={loadArchivedChats}
        busyConvs={busyConvs}
        isMaximized={isFocused}
        onToggleMaximize={() => setFocusedPaneIdx(prev => prev === idx ? null : idx)}
      />
      </div>
      {/* Chat füllt die gesamte Pane — scrollt unter dem Header hindurch */}
      <div className="absolute inset-0">
        <ChatPane
          defaultAgent={activeTab(pane).agent}
          conversationId={activeTab(pane).conversationId}
          paneIndex={idx}
          isActive={activePane === idx}
          onOpenRef={openInInfo}
          onAgentFocus={() => {}}
          onAgentSwitch={(newAgent) => createNewChat(newAgent, idx)}
          onConversationChange={(convId) => {
            // Aktiver Tab hat soeben einen neuen Chat erzeugt (z.B. erste Nachricht) — convId in Tab speichern
            setPaneConfigs(prev => {
              const next = [...prev]
              const p = next[idx]
              if (!p) return prev
              const newTabs = p.tabs.map((t, i) => i === p.activeIndex ? { ...t, conversationId: convId } : t)
              next[idx] = { ...p, tabs: newTabs }
              return next
            })
          }}
        />
      </div>
    </div>
  )})

  const renderedWorkspace = (
    <WorkspaceOverlay
      open={workspace.open}
      mode={workspace.mode}
      returnMode={workspace.returnMode}
      span={effectiveWorkspaceSpan}
      collapsed={workspace.collapsed}
      file={workspace.file}
      filesystemPath={workspace.filesystemPath}
      onClose={workspace.close}
      onToggleCollapsed={workspace.toggleCollapsed}
      onModeChange={(mode) => {
        if (mode === 'filesystem') workspace.setFilesystemPath(null)
        workspace.toggleMode(mode)
      }}
      onBack={() => workspace.openMode(workspace.returnMode || 'artifacts')}
      onOpenFile={workspace.openFile}
      onRevealPath={workspace.revealPath}
      onOpenSearch={() => setSearch(true)}
    />
  )

  return (
    <div className="h-screen flex flex-col">
      {/* ── Content: Workspace links (Nav + Body) + Chat-Panes ── */}
      <div
        ref={contentFrameRef}
        className="app-content-frame flex-1 grid min-h-0 min-w-0"
        style={{
          gap: 0,
          background: 'var(--info-tone)',
          '--workspace-pane-count': String(paneConfigs.length),
          '--workspace-span': String(effectiveWorkspaceSpan),
          ...horizontalGridStyle,
        } as CSSProperties}
      >
        {canSplitWorkspace ? (
          <>
            {renderedWorkspace}
            <div
              className="main-layout-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Chat und Workspace teilen"
              aria-valuemin={CHAT_MIN_PX}
              aria-valuemax={Math.round(maxChatWidth)}
              aria-valuenow={Math.round(chatWidth)}
              tabIndex={0}
              onPointerDown={startLayoutResize}
              onKeyDown={nudgeLayoutSplit}
            />
            {renderedPanes}
          </>
        ) : shouldOverlayWorkspace ? (
          <>
            {renderedPanes}
            <div className="workspace-responsive-overlay">
              {renderedWorkspace}
            </div>
          </>
        ) : (
          <>
            {renderedWorkspace}
            {renderedPanes}
          </>
        )}
      </div>

      <LinkPreview />

      {search && (
        <Suspense fallback={null}>
          <Spotlight onClose={() => setSearch(false)} />
        </Suspense>
      )}
      {spaceSwitcher && (
        <SpaceSwitcher
          current={activeSpace}
          onSelect={(id) => { setActiveSpace(id); setSpaceSwitcher(false) }}
          onClose={() => setSpaceSwitcher(false)}
        />
      )}
      {imagePreview && (
        <ImageLightbox
          path={imagePreview.path}
          src={imagePreview.src}
          onClose={() => setImagePreview(null)}
          onShowInBrowser={(p) => {
            setImagePreview(null)
            window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path: p } }))
          }}
        />
      )}

      {/* YouTube läuft global weiter, beim Modulwechsel als Mini-Player */}
      <GlobalYouTubePlayer onOpenModule={() => workspace.openMode('youtube')} />
    </div>
  )
}

function ImageLightbox({ path, src, onClose, onShowInBrowser }: { path: string; src: string; onClose: () => void; onShowInBrowser: (p: string) => void }) {
  const inlineUrl = path ? `/api/fs/download?path=${encodeURIComponent(path)}&inline=1` : src
  const downloadUrl = path ? `/api/fs/download?path=${encodeURIComponent(path)}` : src
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" />
      <div className="relative max-w-[92vw] max-h-[90vh] flex flex-col items-center gap-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 text-xs text-white/80">
          <a
            href={inlineUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
            title="In neuem Tab öffnen"
          >Neuer Tab</a>
          {path && (
            <button
              onClick={() => onShowInBrowser(path)}
              className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
              title="Im Dateibrowser zeigen"
            >Im Dateibrowser</button>
          )}
          <a
            href={downloadUrl}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors cursor-pointer"
            title="Datei herunterladen"
          >Download</a>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors cursor-pointer ml-auto"
            title="Schließen (Esc)"
          ><X className="w-4 h-4" /></button>
        </div>
        <img src={inlineUrl} alt="" className="max-w-full max-h-[80vh] rounded-xl object-contain shadow-2xl" />
      </div>
    </div>
  )
}
