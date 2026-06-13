import { useState, useEffect, useRef, useCallback, lazy, Suspense, type CSSProperties } from 'react'
import { ChatPane } from './components/ChatPane'
const Spotlight = lazy(() => import('./components/Spotlight').then(m => ({ default: m.Spotlight })))
import { LinkPreview } from './components/LinkPreview'
import { VoiceController } from './components/VoiceController'
import { IncomingCallOverlay, type CallBriefing } from './components/IncomingCallOverlay'
import { acquireWsHub } from './lib/wsHub'
import { WorkspaceOverlay, useWorkspaceController, type WorkspaceSpan } from './workspace'
import { GlobalYouTubePlayer } from './components/GlobalYouTubePlayer'
import { Square, MessageSquare, Presentation, Radio, Settings, Plus, X, Pencil, Archive, ArchiveRestore, Search, Maximize2, Minimize2, Check, Wrench } from 'lucide-react'
import { getAgentNames, getDefaultEngine, useMainAgentName } from './agents'
import { playUISound, preloadUISounds } from './uiSounds'
import { fuzzyIncludes } from './fuzzy'
import { useConversationSearch } from './conversationSearch'
import './index.css'

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
  { id: 'chat', label: 'Agent', description: 'Dein Agent', icon: MessageSquare, iconSrc: '/agent.svg', ready: true },
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

type Layout = '1' | '2' | '3' | '4'

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

function slotSyncSig(slots: { agent: string; convId: string }[], activeSlot: number): string {
  return JSON.stringify({ slots, activeSlot })
}

const DEFAULT_PANES: Record<Layout, PaneConfig[]> = {
  '1':  [{ tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 }],
  '2':  [{ tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 },
         { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 }],
  '3':  [{ tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 },
         { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 },
         { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 }],
  '4':  [{ tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 },
         { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 },
         { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 },
         { tabs: [{ conversationId: '', agent: 'main' }], activeIndex: 0 }],
}

function isLayout(value: string | null): value is Layout {
  return value === '1' || value === '2' || value === '3' || value === '4'
}

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
      {/* Pane title: ein Chat pro Pane, kein lokaler Tab-Browser. */}
      <div
        className="chat-pane-titlebar group relative w-full flex items-center min-h-[var(--header-row-h)]"
        style={{
          background: 'var(--bg)',
        }}
      >
        <div
          onClick={() => setOpen(true)}
          className={`relative flex-1 min-w-0 flex items-center gap-1 pl-6 pr-6 pt-[7px] pb-[4px] cursor-pointer transition-colors text-[13px] leading-[18px] text-[var(--t3)] hover:text-[var(--t1)]`}
          title={tabTitle}
        >
          <span className="truncate font-normal" style={{ fontFamily: 'var(--font-body)' }}>{tabTitle}</span>
        </div>
        {/* Header-Controls nur während echtem Hover sichtbar; kein Focus-/Active-Kleben. */}
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
                          className={`chat-picker-row-title flex-1 min-w-0 text-left truncate cursor-pointer ${isCurrent ? 'text-[var(--t1)] font-medium' : isHighlight ? 'klaus-tab-pulse font-medium' : isBusy ? 'text-[var(--t1)] group-hover:text-[var(--t1)]' : 'text-[var(--t2)] group-hover:text-[var(--t1)]'}`}
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

function loadPaneConfigs(layout: Layout): PaneConfig[] {
  try {
    const stored = localStorage.getItem(`control:panes:${layout}`)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length === DEFAULT_PANES[layout].length) {
        return parsed.map((p: any): PaneConfig => {
          // New shape: { tabs, activeIndex }
          if (Array.isArray(p?.tabs) && p.tabs.length > 0) {
            const tabs = p.tabs.map(migrateTab)
            const idx = typeof p.activeIndex === 'number' ? p.activeIndex : 0
            return { tabs, activeIndex: Math.max(0, Math.min(idx, tabs.length - 1)) }
          }
          // Old shape: single { conversationId, agent } → wrap as one tab
          return { tabs: [migrateTab(p)], activeIndex: 0 }
        })
      }
    }
  } catch {}
  return DEFAULT_PANES[layout]
}

function savePaneConfigs(layout: Layout, configs: PaneConfig[]) {
  localStorage.setItem(`control:panes:${layout}`, JSON.stringify(configs))
}

export default function App() {
  const [layout, setLayout] = useState<Layout>(() => {
    const stored = localStorage.getItem('control:layout')
    return isLayout(stored) ? stored : '1'
  })
  const [paneConfigs, setPaneConfigs] = useState<PaneConfig[]>(() => {
    const stored = localStorage.getItem('control:layout')
    const l = isLayout(stored) ? stored : '1'
    return loadPaneConfigs(l)
  })
  const [showInfo, setShowInfo] = useState(() => localStorage.getItem('control:showInfo') === 'true')
  const [activePane, setActivePane] = useState(0)
  const activeTabKey = `${activePane}:${paneConfigs[activePane]?.activeIndex ?? 0}`
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
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null)
  const [search, setSearch] = useState(false)
  const [spaceSwitcher, setSpaceSwitcher] = useState(false)
  const [imagePreview, setImagePreview] = useState<{ path: string; src: string } | null>(null)
  const workspace = useWorkspaceController()
  const [activeSpace, setActiveSpace] = useState('chat')
  const [deckFile, setDeckFile] = useState('')
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [busyConvs, setBusyConvs] = useState<Set<string>>(new Set())
  // Startzeitpunkt je laufender Conversation, damit die Switch-Leiste im
  // Kollaps-Modus zeigen kann, wie lange ein anderer Chat schon arbeitet.
  const [busyStartedAt, setBusyStartedAt] = useState<Map<string, number>>(new Map())
  // Spiegeln den Kollaps-Zustand für Event-Handler (window-Listener), die zur
  // Feuerzeit den jüngsten Wert brauchen, ohne als Dependency neu zu binden.
  const collapseRef = useRef(false)
  const visiblePaneRef = useRef(0)
  const paneCountRef = useRef(1)
  // Reale Breite des Content-Grids messen, um den Single-Pane-Kollaps nicht
  // stur an die Span-Stufe zu koppeln, sondern an den tatsachlich verbleibenden
  // Platz fur die Chat-Panes (Ultra-Wide behalt alle Panes nebeneinander).
  const contentFrameRef = useRef<HTMLDivElement | null>(null)
  const [frameW, setFrameW] = useState(0)
  const [conversations, setConversations] = useState<ConvOption[]>([])
  const [archivedChats, setArchivedChats] = useState<ConvOption[]>([])
  const [voiceReady, setVoiceReady] = useState(false)
  const [voiceSession, setVoiceSession] = useState<{ convId: string; agent: string } | null>(null)
  // "Agent ruft an": pending Anruf-Briefing, das ein pulsierendes Overlay zeigt.
  const [incomingCall, setIncomingCall] = useState<CallBriefing | null>(null)
  const voicePaneShortcutPausedRef = useRef(false)

  const toggleKlausVoice = useCallback(() => {
    if (!voiceReady) return
    voicePaneShortcutPausedRef.current = false
    setVoiceSession(s => {
      if (s) { playUISound('voice-off', 0.6); return null }
      playUISound('voice-on', 0.6)
      return { convId: 'channel-voice', agent: 'main' }
    })
  }, [voiceReady])

  // "Agent ruft an": eigener WS-Handler nur für das Anruf-Event. Der Hub bündelt
  // alle Tab-Sockets, ein zusätzlicher Handler feuert sauber genau einmal.
  useEffect(() => {
    const hub = acquireWsHub({
      onMessage: (raw) => {
        const msg = raw as { type?: string; briefing?: CallBriefing }
        if (msg?.type === 'voice.incoming_call') {
          setIncomingCall(msg.briefing || {})
          if (typeof document === 'undefined' || document.hasFocus()) playUISound('tell-message', 0.7)
        }
      },
    })
    return () => hub.release()
  }, [])

  const acceptIncomingCall = useCallback(() => {
    setIncomingCall(null)
    playUISound('voice-on', 0.6)
    voicePaneShortcutPausedRef.current = false
    // Voice-Session starten; VoiceActiveSession zieht das Anruf-Briefing per consume.
    setVoiceSession({ convId: 'channel-voice', agent: 'main' })
  }, [])

  const dismissIncomingCall = useCallback(() => {
    setIncomingCall(null)
    playUISound('voice-off', 0.6)
    fetch('/api/voice/call-briefing/dismiss', { method: 'POST' }).catch(() => {})
  }, [])

  useEffect(() => { preloadUISounds() }, [])

  // Check voice configuration on mount
  useEffect(() => {
    fetch('/api/voice/status')
      .then(r => r.json())
      .then(d => setVoiceReady(!!d.ready))
      .catch(() => setVoiceReady(false))
  }, [])

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
  // Konzept: brain/ideas/klaus-channel.md.
  useEffect(() => {
    const klaus = conversations.find(c => c.id === 'klaus-channel' && c.highlight)
    if (!klaus) return
    const pane0 = paneConfigs[0]
    if (!pane0) return
    const klausIdx = pane0.tabs.findIndex(t => t.conversationId === 'klaus-channel')
    // Schon Agent aktiv in Pane 1 → nichts tun (und /seen wird durch ChatPane gleich getriggert).
    if (klausIdx >= 0 && pane0.activeIndex === klausIdx) return
    setPaneConfigs(prev => {
      if (!prev.length) return prev
      const next = [...prev]
      const pane = next[0]
      const onlyEmpty = pane.tabs.length === 1 && !pane.tabs[0].conversationId
      if (onlyEmpty) {
        next[0] = { tabs: [{ conversationId: 'klaus-channel', agent: 'main' }], activeIndex: 0 }
      } else {
        // Agent vorne einsortieren (falls noch nicht da) und aktiv schalten.
        const existing = pane.tabs.findIndex(t => t.conversationId === 'klaus-channel')
        const tabs = existing >= 0
          ? [pane.tabs[existing], ...pane.tabs.filter((_, i) => i !== existing)]
          : [{ conversationId: 'klaus-channel', agent: 'main' }, ...pane.tabs]
        next[0] = { tabs, activeIndex: 0 }
      }
      savePaneConfigs(layout, next)
      return next
    })
  }, [conversations, paneConfigs, layout])

  const activeAgent = activeTab(paneConfigs[activePane] ?? DEFAULT_PANES['1'][0]).agent

  // ── Slot-Sync (Desktop ↔ Mobile) ──
  // Slots sind immer 4. Sichtbare Slots = paneConfigs[0..paneCount].activeTab.
  // Versteckte Slots (für paneCount < 4) leben in desktopSlots und werden trotzdem
  // ans Backend gepusht — damit Mobile immer 4 Pillen hat, egal welches Layout
  // der Desktop fährt. Bei Layout-Wechsel (z.B. 1→2) wird die neue Pane aus dem
  // dazugehörigen versteckten Slot vorbelegt, statt leer aufzumachen.
  // Agent-Channel darf nur in Slot 0 leben.
  const SLOT_COUNT = 4
  const lastSlotsSigRef = useRef<string>('')
  const slotsHydratedRef = useRef<boolean>(false)

  // Layout 1: welcher der 4 Slots ist in Pane 0 sichtbar. Default 0.
  const [activeSlot1, setActiveSlot1] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('control:activeSlot1') || '0', 10)
      return Math.max(0, Math.min(SLOT_COUNT - 1, isFinite(v) ? v : 0))
    } catch { return 0 }
  })
  useEffect(() => {
    try { localStorage.setItem('control:activeSlot1', String(activeSlot1)) } catch {}
  }, [activeSlot1])

  const [desktopSlots, setDesktopSlots] = useState<Tab[]>(() => {
    try {
      const raw = localStorage.getItem('control:desktopSlots')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          const out: Tab[] = []
          for (let i = 0; i < SLOT_COUNT; i++) {
            const s = parsed[i]
            const agent = s?.agent || 'main'
            const cid = typeof s?.conversationId === 'string' ? s.conversationId : (typeof s?.convId === 'string' ? s.convId : '')
            const convId = (cid === 'klaus-channel' && i !== 0) || cid.startsWith('channel-') ? '' : cid
            out.push({ agent, conversationId: convId })
          }
          return out
        }
      }
    } catch {}
    return Array.from({ length: SLOT_COUNT }, () => ({ agent: 'main', conversationId: '' }))
  })

  // Hilfsfunktion: aktuelle 4-Slot-Ansicht — sichtbare Panes plus versteckte Slots.
  // Layout 1 (genau 1 Pane): Pane 0's aktiver Tab liegt logisch in Slot activeSlot1,
  // die anderen 3 Slots kommen aus desktopSlots. Bei Layout >1: Slot i = Pane i.
  const buildAllSlots = useCallback((configs: PaneConfig[], hidden: Tab[], slot1Idx: number): { agent: string; convId: string }[] => {
    const out: { agent: string; convId: string }[] = []
    const single = configs.length === 1
    for (let i = 0; i < SLOT_COUNT; i++) {
      let agent = 'main'
      let convId = ''
      if (single) {
        if (i === slot1Idx) {
          const at = activeTab(configs[0])
          agent = at.agent || 'main'
          convId = at.conversationId || ''
        } else {
          const h = hidden[i] || { agent: 'main', conversationId: '' }
          agent = h.agent || 'main'
          convId = h.conversationId || ''
        }
      } else {
        const cfg = configs[i]
        if (cfg) {
          const at = activeTab(cfg)
          agent = at.agent || 'main'
          convId = at.conversationId || ''
        } else {
          const h = hidden[i] || { agent: 'main', conversationId: '' }
          agent = h.agent || 'main'
          convId = h.conversationId || ''
        }
      }
      if (convId === 'klaus-channel' && i !== 0) convId = ''
      out.push({ agent, convId })
    }
    return out
  }, [])

  // Normalize incoming server slots → genau 4, Agent-Channel raus für i>0.
  const padIncomingSlots = useCallback((raw: any[]): Tab[] => {
    const out: Tab[] = []
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = raw[i]
      const agent = (s && typeof s.agent === 'string' && s.agent) || 'main'
      const cidRaw = (s && typeof s.convId === 'string') ? s.convId : ''
      const convId = (!cidRaw || cidRaw.startsWith('channel-') || (cidRaw === 'klaus-channel' && i !== 0)) ? '' : cidRaw
      out.push({ agent, conversationId: convId })
    }
    return out
  }, [])

  // Persistiere desktopSlots (auch versteckte) lokal — überleben Reload.
  useEffect(() => {
    if (!slotsHydratedRef.current) return
    try {
      localStorage.setItem('control:desktopSlots', JSON.stringify(desktopSlots))
    } catch {}
  }, [desktopSlots])

  // Sichtbare Slots in desktopSlots spiegeln. Layout 1: pane 0's aktiver Tab geht
  // in desktopSlots[activeSlot1]. Layout >1: pane i geht in desktopSlots[i].
  useEffect(() => {
    if (!slotsHydratedRef.current) return
    setDesktopSlots(prev => {
      const next = prev.slice()
      let changed = false
      const single = paneConfigs.length === 1
      if (single) {
        const cfg = paneConfigs[0]
        if (cfg) {
          const at = activeTab(cfg)
          const cid = at.conversationId || ''
          const convId = (cid === 'klaus-channel' && activeSlot1 !== 0) ? '' : cid
          const agent = at.agent || 'main'
          if (next[activeSlot1]?.conversationId !== convId || next[activeSlot1]?.agent !== agent) {
            next[activeSlot1] = { agent, conversationId: convId }
            changed = true
          }
        }
      } else {
        for (let i = 0; i < SLOT_COUNT; i++) {
          const cfg = paneConfigs[i]
          if (!cfg) continue
          const at = activeTab(cfg)
          const cid = at.conversationId || ''
          const convId = (cid === 'klaus-channel' && i !== 0) ? '' : cid
          const agent = at.agent || 'main'
          if (next[i]?.conversationId !== convId || next[i]?.agent !== agent) {
            next[i] = { agent, conversationId: convId }
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [paneConfigs, activeSlot1])

  // Mappt Server-Slot[i] in Pane[paneIdx]'s aktiven Tab. Bei Layout 1 ist paneIdx=0
  // und i=activeSlot1. Bei Layout >1 ist paneIdx=i.
  const applySlotToPane = useCallback((cfg: PaneConfig, slot: Tab): PaneConfig => {
    const at = activeTab(cfg)
    if (at.conversationId === slot.conversationId && at.agent === slot.agent) return cfg
    const existingIdx = slot.conversationId ? cfg.tabs.findIndex(t => t.conversationId === slot.conversationId) : -1
    if (existingIdx >= 0) return { ...cfg, activeIndex: existingIdx }
    const tabs = cfg.tabs.slice()
    tabs[cfg.activeIndex] = { conversationId: slot.conversationId, agent: slot.agent }
    return { ...cfg, tabs }
  }, [])

  const applyIncomingSlots = useCallback((padded: Tab[], slot1Idx: number) => {
    setPaneConfigs(prev => {
      const single = prev.length === 1
      const next = prev.map((cfg, i) => {
        if (single) {
          if (i !== 0) return cfg
          return applySlotToPane(cfg, padded[slot1Idx])
        }
        if (i >= SLOT_COUNT) return cfg
        return applySlotToPane(cfg, padded[i])
      })
      const sig = slotSyncSig(buildAllSlots(next, padded, slot1Idx), slot1Idx)
      lastSlotsSigRef.current = sig
      savePaneConfigs(layout, next)
      return next
    })
  }, [applySlotToPane, buildAllSlots, layout])

  // Initial: vom Backend laden. Wenn lokal in localStorage schon Pane-Configs
  // stehen, gewinnen die — sonst überschreibt der Server-Stand (möglicherweise
  // älter, von Mobile gepusht) beim Hard-Reload den eigenen Desktop-State.
  // Der Outbound-Effect (unten) pusht dann den lokalen Stand zurück zum Server.
  useEffect(() => {
    const hasLocalPanes = !!localStorage.getItem(`control:panes:${layout}`)
    fetch('/api/slots').then(r => r.json()).then(d => {
      const incoming: any[] = Array.isArray(d?.slots) ? d.slots : []
      const padded = padIncomingSlots(incoming)
      const incomingActive = typeof d?.activeSlot === 'number'
        ? Math.max(0, Math.min(SLOT_COUNT - 1, d.activeSlot))
        : activeSlot1
      const effectiveActive = hasLocalPanes ? activeSlot1 : incomingActive
      lastSlotsSigRef.current = slotSyncSig(
        padded.map(t => ({ agent: t.agent, convId: t.conversationId })),
        effectiveActive,
      )
      setDesktopSlots(padded)
      if (!hasLocalPanes) {
        if (effectiveActive !== activeSlot1) setActiveSlot1(effectiveActive)
        applyIncomingSlots(padded, effectiveActive)
      }
      slotsHydratedRef.current = true
    }).catch(() => {
      slotsHydratedRef.current = true
    })
    // Beim Tab-Reopen Slots frisch ziehen — aber nur anwenden wenn ein anderer
    // Client (Mobile) den Stand geändert hat. Wenn der Server genau das zurückliefert,
    // was Desktop selbst zuletzt gepusht hat, ignorieren — sonst überschreibt Desktop
    // seine eigenen Panes mit Mobile's altem Stand.
    const pullOnVisible = () => {
      if (document.hidden || !slotsHydratedRef.current) return
      fetch('/api/slots').then(r => r.json()).then(d => {
        const incoming: any[] = Array.isArray(d?.slots) ? d.slots : []
        const padded = padIncomingSlots(incoming)
        setDesktopSlots(padded)
        const serverSig = slotSyncSig(padded.map(t => ({ agent: t.agent, convId: t.conversationId })), activeSlot1)
        if (serverSig !== lastSlotsSigRef.current) applyIncomingSlots(padded, activeSlot1)
      }).catch(() => {})
    }
    document.addEventListener('visibilitychange', pullOnVisible)
    window.addEventListener('focus', pullOnVisible)
    return () => {
      document.removeEventListener('visibilitychange', pullOnVisible)
      window.removeEventListener('focus', pullOnVisible)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Outbound: bei Änderung an Panes, versteckten Slots oder activeSlot1 immer alle 4 pushen.
  // Debounce 250ms: schnelle Tab-Wechsel/Tipps lösen sonst je einen PUT aus, der per
  // WS an alle Clients (auch Mobile) gebroadcastet wird — bei 4-5 Switches/Sekunde
  // hagelt es Re-Renders auf Mobile. Synchronität bleibt sub-second.
  const slotPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!slotsHydratedRef.current) return
    const all = buildAllSlots(paneConfigs, desktopSlots, activeSlot1)
    const sig = slotSyncSig(all, activeSlot1)
    if (sig === lastSlotsSigRef.current) return
    if (slotPushTimerRef.current) clearTimeout(slotPushTimerRef.current)
    slotPushTimerRef.current = setTimeout(() => {
      slotPushTimerRef.current = null
      lastSlotsSigRef.current = sig
      fetch('/api/slots', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: all, activeSlot: activeSlot1, source: 'desktop' }),
      }).catch(() => {})
    }, 250)
    return () => {
      if (slotPushTimerRef.current) { clearTimeout(slotPushTimerRef.current); slotPushTimerRef.current = null }
    }
  }, [paneConfigs, desktopSlots, activeSlot1, buildAllSlots])

  // Inbound: andere Clients (Mobile) ändern Slots → Panes UND versteckte Slots nachziehen.
  useEffect(() => {
    const onSlotsUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if (detail.source === 'desktop') return
      const incoming: any[] = Array.isArray(detail.slots) ? detail.slots : []
      if (incoming.length === 0) return
      const padded = padIncomingSlots(incoming)
      setDesktopSlots(padded)
      // activeSlot1 lokal lassen: ein Mobile-Slot-Wechsel darf den sichtbaren
      // Desktop-Slot bei Layout 1 nicht umschalten.
      applyIncomingSlots(padded, activeSlot1)
    }
    window.addEventListener('deck:slotsUpdate', onSlotsUpdate)
    return () => window.removeEventListener('deck:slotsUpdate', onSlotsUpdate)
  }, [activeSlot1, applyIncomingSlots, padIncomingSlots])

  // Voice-Focus + UI-State: push aktiven Chat UND Pane-Snapshot ans Backend.
  // Hidden Tabs werden nicht gepusht — Agent sieht visuell nur den aktiven Tab pro Pane.
  useEffect(() => {
    if (!voiceSession) return
    const cfg = paneConfigs[activePane]

    if (cfg) {
      const at = activeTab(cfg)
      const activeConv = conversations.find(c => c.id === at.conversationId)
      fetch('/api/voice/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: at.agent,
          convId: at.conversationId || '',
          title: activeConv?.title || '',
        }),
      }).catch(() => {})
    }

    // Voller Layout-Snapshot für get_ui_state — pro Pane der aktive Tab
    const panes = paneConfigs.map((p, idx) => {
      const at = activeTab(p)
      const conv = conversations.find(c => c.id === at.conversationId)
      return {
        id: String(idx),
        agent: at.agent,
        convId: at.conversationId || '',
        title: conv?.title || '',
      }
    })
    fetch('/api/voice/ui-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        panes,
        activePaneId: String(activePane),
        layout,
      }),
    }).catch(() => {})
  }, [voiceSession, activePane, paneConfigs, conversations, layout])

  // Esc im Fokus-Modus: Pane wieder verkleinern, aber nur wenn kein anderes Overlay offen ist
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

  // Fokus auflösen, wenn die Pane durch Layout-Wechsel wegfällt
  useEffect(() => {
    if (focusedPaneIdx !== null && focusedPaneIdx >= paneConfigs.length) {
      setFocusedPaneIdx(null)
    }
  }, [paneConfigs.length, focusedPaneIdx])

  // Layout 1: Click auf Pille i → Pane 0 zeigt desktopSlots[i], activeSlot1 = i.
  const selectSlot1 = useCallback((i: number) => {
    if (i < 0 || i >= SLOT_COUNT) return
    if (i === activeSlot1) return
    const target = desktopSlots[i] || { agent: 'main', conversationId: '' }
    const cid = target.conversationId || ''
    const agent = target.agent || 'main'
    // Erst Slot-Index umschalten, damit der paneConfigs→desktopSlots-Sync den
    // alten Pane-0-Inhalt in den richtigen Slot (Slot activeSlot1) zurückspielt.
    setActiveSlot1(i)
    setPaneConfigs(prev => {
      if (prev.length === 0) return prev
      const cfg = prev[0]
      const next = prev.slice()
      const existingIdx = cid ? cfg.tabs.findIndex(t => t.conversationId === cid) : -1
      if (existingIdx >= 0) {
        next[0] = { ...cfg, activeIndex: existingIdx }
      } else {
        const tabs = cfg.tabs.slice()
        tabs[cfg.activeIndex] = { conversationId: cid, agent }
        next[0] = { ...cfg, tabs }
      }
      savePaneConfigs(layout, next)
      return next
    })
    if (cid) {
      setUnread(prev => { const n = new Set(prev); n.delete(cid); return n })
      window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent, conversationId: cid, paneIndex: 0 } }))
    }
  }, [activeSlot1, desktopSlots, layout])

  const changeLayout = (l: Layout) => {
    if (l !== layout) playUISound('layout-switch', 0.5)
    const targetCount = DEFAULT_PANES[l].length
    setLayout(l)
    localStorage.setItem('control:layout', l)
    let configs: PaneConfig[]
    const wasSingle = paneConfigs.length === 1
    const willBeSingle = targetCount === 1
    if (targetCount <= paneConfigs.length) {
      configs = paneConfigs.slice(0, targetCount)
    } else {
      const added: PaneConfig[] = []
      for (let i = paneConfigs.length; i < targetCount; i++) {
        // Neue Panes aus dem versteckten Slot vorbelegen — kein leerer Agent-Channel-Spawn.
        const hidden = i < SLOT_COUNT ? desktopSlots[i] : null
        const cid = (hidden?.conversationId && (hidden.conversationId !== 'klaus-channel' || i === 0)) ? hidden.conversationId : ''
        const agent = hidden?.agent || 'main'
        added.push({ tabs: [{ conversationId: cid, agent }], activeIndex: 0 })
      }
      configs = [...paneConfigs, ...added]
    }
    // Layout 1 mit activeSlot1 != 0 → Layout >1: Pane 0 muss zurück auf Slot 0.
    if (wasSingle && !willBeSingle && activeSlot1 !== 0) {
      const target = desktopSlots[0] || { agent: 'main', conversationId: '' }
      const cfg = configs[0]
      if (cfg) {
        const cid = target.conversationId || ''
        const agent = target.agent || 'main'
        const existingIdx = cid ? cfg.tabs.findIndex(t => t.conversationId === cid) : -1
        if (existingIdx >= 0) {
          configs[0] = { ...cfg, activeIndex: existingIdx }
        } else {
          const tabs = cfg.tabs.slice()
          tabs[cfg.activeIndex] = { conversationId: cid, agent }
          configs[0] = { ...cfg, tabs }
        }
      }
      setActiveSlot1(0)
    }
    setPaneConfigs(configs)
    savePaneConfigs(l, configs)
    setActivePane(Math.min(activePane, targetCount - 1))
  }

  // ── Pane-Chat-Verwaltung: eine Pane hält genau einen sichtbaren Chat. ──

  const addOrSwitchTab = (paneIndex: number, convId: string, agent: string) => {
    if (convId) {
      const otherPaneIdx = paneConfigs.findIndex((p, i) => i !== paneIndex && p.tabs.some(t => t.conversationId === convId))
      if (otherPaneIdx >= 0) {
        const found = paneConfigs[otherPaneIdx].tabs.find(t => t.conversationId === convId) || { conversationId: convId, agent }
        setPaneConfigs(prev => {
          const next = [...prev]
          next[otherPaneIdx] = { tabs: [found], activeIndex: 0 }
          savePaneConfigs(layout, next)
          return next
        })
        setActivePane(otherPaneIdx)
        setUnread(prev => { const n = new Set(prev); n.delete(convId); return n })
        window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent, conversationId: convId, paneIndex: otherPaneIdx } }))
        return
      }
    }
    setPaneConfigs(prev => {
      const next = [...prev]
      const pane = next[paneIndex]
      if (!pane) return prev
      next[paneIndex] = { tabs: [{ conversationId: convId, agent }], activeIndex: 0 }
      savePaneConfigs(layout, next)
      return next
    })
    setActivePane(paneIndex)
    if (convId) {
      setUnread(prev => { const n = new Set(prev); n.delete(convId); return n })
      window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent, conversationId: convId, paneIndex } }))
    }
  }

  const replaceTabInPane = (paneIndex: number, convId: string, agent: string) => {
    if (convId) {
      const otherPaneIdx = paneConfigs.findIndex((p, i) => i !== paneIndex && p.tabs.some(t => t.conversationId === convId))
      if (otherPaneIdx >= 0) {
        const found = paneConfigs[otherPaneIdx].tabs.find(t => t.conversationId === convId) || { conversationId: convId, agent }
        setPaneConfigs(prev => {
          const next = [...prev]
          next[otherPaneIdx] = { tabs: [found], activeIndex: 0 }
          savePaneConfigs(layout, next)
          return next
        })
        setActivePane(otherPaneIdx)
        setUnread(prev => { const n = new Set(prev); n.delete(convId); return n })
        window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent, conversationId: convId, paneIndex: otherPaneIdx } }))
        return
      }
    }
    setPaneConfigs(prev => {
      const next = [...prev]
      const pane = next[paneIndex]
      if (!pane) return prev
      next[paneIndex] = { tabs: [{ conversationId: convId, agent }], activeIndex: 0 }
      savePaneConfigs(layout, next)
      return next
    })
    setActivePane(paneIndex)
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
    if (closing?.conversationId === 'klaus-channel') {
      const klaus = conversations.find(c => c.id === 'klaus-channel')
      if (klaus?.highlight) {
        fetch('/api/conversations/klaus-channel/seen', { method: 'POST' }).catch(() => {})
        setConversations(prev => prev.map(c => c.id === 'klaus-channel' ? { ...c, highlight: false } : c))
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
      savePaneConfigs(layout, next)
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
      // Nur als unread markieren, wenn der Chat in keinem aktiven Tab einer Pane sichtbar ist.
      // Im Kollaps-Modus ist nur die eine sichtbare Pane wirklich offen — die anderen
      // gelten als ungesehen, damit ihr Fertig-Haken in der Switch-Leiste erscheint.
      const visConvs = new Set<string>()
      if (collapseRef.current) {
        const vp = paneConfigs[visiblePaneRef.current]
        if (vp) { const a = activeTab(vp); if (a.conversationId) visConvs.add(a.conversationId) }
      } else {
        for (const p of paneConfigs) {
          const a = activeTab(p)
          if (a.conversationId) visConvs.add(a.conversationId)
        }
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
      const { conversationId: cid, busy, startedAt } = (e as CustomEvent).detail || {}
      if (!cid) return
      setBusyConvs(prev => {
        const next = new Set(prev)
        if (busy) next.add(cid); else next.delete(cid)
        return next
      })
      setBusyStartedAt(prev => {
        const next = new Map(prev)
        if (busy) {
          // Echten Stream-Start aus dem Event nehmen, damit die Zeit nach einem
          // Hard Refresh weiterläuft statt bei null neu anzufangen.
          const serverStart = typeof startedAt === 'number' && startedAt > 0 ? startedAt : undefined
          if (serverStart) next.set(cid, serverStart)
          else if (!next.has(cid)) next.set(cid, Date.now())
        } else next.delete(cid)
        return next
      })
    }
    window.addEventListener('deck:convBusy', handler)
    return () => window.removeEventListener('deck:convBusy', handler)
  }, [])

  // ── Voice-Layout-Kommandos ──
  // Agent kann via Sprache InfoPane togglen, Chat-Panes hinzufügen/schliessen
  // und auf Sektionen springen. Implementiert als window-Events, damit der
  // Voice-Pfad keine Props durch den Komponentenbaum braucht.
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
    const onPane = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const action = String(detail.action || '')
      const order: Layout[] = ['1', '2', '3', '4']
      const curLayout: Layout = layout
      const curIdx = order.indexOf(curLayout)
      if (action === 'add') {
        if (curIdx >= 0 && curIdx < order.length - 1) changeLayout(order[curIdx + 1])
      } else if (action === 'close-last') {
        if (curIdx > 0) changeLayout(order[curIdx - 1])
      } else if (action === 'close-index') {
        const oneBased = Number(detail.index)
        const idx = Number.isFinite(oneBased) ? oneBased - 1 : -1
        if (idx >= 0 && idx < paneConfigs.length && paneConfigs.length > 1) {
          const nextConfigs = paneConfigs.filter((_, i) => i !== idx)
          const targetLayout = (String(nextConfigs.length) as Layout)
          playUISound('layout-switch', 0.5)
          setLayout(targetLayout)
          localStorage.setItem('control:layout', targetLayout)
          setPaneConfigs(nextConfigs)
          savePaneConfigs(targetLayout, nextConfigs)
          setActivePane(prev => {
            if (prev === idx) return Math.max(0, idx - 1)
            if (prev > idx) return prev - 1
            return prev
          })
        }
      } else if (action === 'only-active') {
        const active = paneConfigs[activePane] ?? DEFAULT_PANES['1'][0]
        playUISound('layout-switch', 0.5)
        setLayout('1')
        localStorage.setItem('control:layout', '1')
        setPaneConfigs([active])
        savePaneConfigs('1', [active])
        setActivePane(0)
        setShowInfo(false)
        localStorage.setItem('control:showInfo', 'false')
      }
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
    window.addEventListener('deck:pane', onPane)
    window.addEventListener('deck:info-section', onSection)
    return () => {
      window.removeEventListener('deck:info', onInfo)
      window.removeEventListener('deck:pane', onPane)
      window.removeEventListener('deck:info-section', onSection)
    }
  }, [layout, paneConfigs, activePane, deckFile])

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
      workspace.openMode('mail')
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
      if (e.metaKey && !e.ctrlKey) {
        const map: Record<string, Layout> = { '1': '1', '2': '2', '3': '3', '4': '4' }
        if (map[e.key]) {
          e.preventDefault()
          if (voiceSession) {
            voicePaneShortcutPausedRef.current = !voicePaneShortcutPausedRef.current
            window.dispatchEvent(new CustomEvent('deck:voicePause', {
              detail: { paused: voicePaneShortcutPausedRef.current, source: 'pane-shortcut' },
            }))
          } else {
            voicePaneShortcutPausedRef.current = false
          }
          window.dispatchEvent(new CustomEvent('deck:stopAudio'))
          // Im Kollaps-Modus wechselt CMD+N nicht das Layout, sondern springt
          // direkt zu Pane N (0-basiert: CMD+1 → Pane 0), solange sie existiert.
          if (collapseRef.current) {
            const target = parseInt(e.key, 10) - 1
            if (target >= 0 && target < paneCountRef.current) setActivePane(target)
            return
          }
          changeLayout(map[e.key])
          return
        }
      }
      // Ctrl/Alt sind die browser-sicheren Zwillinge der CMD-Tasten (CMD+1-4
      // schluckt der Browser als Tab-Shortcut). Im Kollaps springt Ctrl+2-5
      // (bzw. Alt) direkt zur Pane — gleiche Versatz-Belegung wie der
      // Layout-Wechsel (Ctrl+2 = erste Pane … Ctrl+5 = vierte Pane).
      if ((e.ctrlKey && !e.metaKey) || (e.altKey && !e.metaKey && !e.ctrlKey)) {
        const map: Record<string, Layout> = { '2': '1', '3': '2', '4': '3', '5': '4' }
        if (map[e.key]) {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('deck:stopAudio'))
          if (collapseRef.current) {
            const target = parseInt(map[e.key], 10) - 1
            if (target >= 0 && target < paneCountRef.current) setActivePane(target)
            return
          }
          changeLayout(map[e.key])
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeAgent, showInfo, voiceSession])

  // Layout: Workspace ist die permanente linke Spalte (ersetzt die alte InfoPane).
  // Geschlossen zeigt sie nur die schmale Nav-Rail; offen kommt der Body dazu und
  // schiebt die Chat-Panes schmaler. Die Chats behalten ihre runden Karten-Ecken.
  const WS_RAIL_PX = 200
  // Eingeklappt zeigt die Rail nur Icons; dann darf die Chat-Fläche bis dicht an
  // die Icons heranwachsen, statt die alte Menübreite zu reservieren.
  const WS_RAIL_COLLAPSED_PX = 64
  const N = paneConfigs.length
  const workspaceMaxSpan = Math.max(1, Math.min(3, paneConfigs.length || 1)) as 1 | 2 | 3
  const effectiveWorkspaceSpan = Math.min(workspace.span, workspaceMaxSpan) as WorkspaceSpan
  const chatPanesHidden = false
  // Kollaps-Modus: Sobald der Workspace breit aufgemacht wird (Span 2/3) und mehr
  // als eine Pane offen ist, kollabieren die Panes zu einer einzigen breiten Pane.
  // Gewechselt wird dann unten über die Switch-Leiste, wie auf dem Handy. Reiner
  // View-Kollaps — paneConfigs bleiben unangetastet, beim Zumachen ist alles zurück.
  // Misst die Content-Grid-Breite live mit, damit der Kollaps platzbasiert faellt.
  useEffect(() => {
    const el = contentFrameRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w) setFrameW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Wuerden im aufgefaecherten Layout alle Panes noch breit genug stehen? Workspace
  // nimmt minmax(520, span fr), die Chats teilen sich den Rest zu je 1fr. Liegt jede
  // Pane ueber MIN_PANE_PX, bleibt aufgefaechert statt in den Single-Pane-Modus zu fallen.
  const MIN_PANE_PX = 360
  const wsWidthPx = Math.max(520, (frameW * effectiveWorkspaceSpan) / (effectiveWorkspaceSpan + N))
  const panePx = N > 0 ? (frameW - wsWidthPx) / N : frameW
  // Ohne gemessene Breite (erster Frame) am alten Span-Verhalten festhalten.
  const fitsAllPanes = frameW > 0 && panePx >= MIN_PANE_PX
  const collapseToSinglePane = workspace.open && effectiveWorkspaceSpan >= 2 && N >= 2 && !fitsAllPanes
  const visiblePaneIdx = Math.min(activePane, N - 1)
  collapseRef.current = collapseToSinglePane
  visiblePaneRef.current = visiblePaneIdx
  paneCountRef.current = N

  // Auto-Sprung im Kollaps: Sobald Text in eine Pane gepostet wird (Agent per
  // send_to_pane oder ein Backend-Command), springt die Ansicht zu dieser Pane,
  // damit man die entstehende Eingabe sofort sieht. Nur im Kollaps, sonst sind
  // ohnehin alle Panes sichtbar. Refs halten den jüngsten Wert ohne Neu-Bind.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      const target = Number(detail.paneIndex)
      if (!Number.isFinite(target) || target < 0) return
      if (!collapseRef.current || target === visiblePaneRef.current) return
      setActivePane(target)
    }
    // deck:paneFocus kommt schon beim Aufnahme-Start (erster PTT-Druck), noch
    // ohne Text — gleicher Sprung, damit das Ziel-Pane sofort sichtbar ist.
    window.addEventListener('deck:paneInput', handler)
    window.addEventListener('deck:paneFocus', handler)
    return () => {
      window.removeEventListener('deck:paneInput', handler)
      window.removeEventListener('deck:paneFocus', handler)
    }
  }, [])

  const workspaceColTrack = workspace.open
    ? `minmax(520px, ${effectiveWorkspaceSpan}fr)`
    : `${workspace.collapsed ? WS_RAIL_COLLAPSED_PX : WS_RAIL_PX}px`
  const chatColTrack = collapseToSinglePane
    ? 'minmax(0, 1fr)'
    : `repeat(${N}, minmax(0, 1fr))`
  const horizontalGridStyle: CSSProperties = {
    gridTemplateColumns: N > 0
      ? `${workspaceColTrack} ${chatColTrack}`
      : workspaceColTrack,
  }

  // Laufende Zeit für die Switch-Leiste nur dann ticken lassen, wenn im
  // Kollaps-Modus überhaupt ein Chat arbeitet — sonst kein Timer.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (!collapseToSinglePane || busyConvs.size === 0) return
    const id = setInterval(() => setNowTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [collapseToSinglePane, busyConvs.size])

  // Switch-Leiste für den Kollaps-Modus. Wird als Node an die sichtbare Pane
  // gereicht und dort im Composer-Futter über der Eingabe gerendert — nicht als
  // konkurrierendes Overlay, damit nichts mit dem Mini-Composer kollidiert.
  const paneSwitcherNode = (
    <div className="flex w-full items-center">
      {paneConfigs.map((p, i) => {
        const at = activeTab(p)
        const convId = at.conversationId
        const conv = convId ? conversations.find(c => c.id === convId) : null
        const isActive = i === visiblePaneIdx
        const isBusy = !!convId && busyConvs.has(convId)
        const isUnread = !!convId && unread.has(convId)
        const startedAt = isBusy && convId ? busyStartedAt.get(convId) : undefined
        const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setActivePane(i)
              if (convId) setUnread(prev => { const n = new Set(prev); n.delete(convId); return n })
            }}
            className="flex flex-1 items-center justify-center relative"
            style={{ height: 22, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
            aria-label={`Chat ${i + 1}${conv?.title ? ` (${conv.title})` : ''}`}
            title={conv?.title || `Chat ${i + 1}`}
          >
            {(() => {
              // Im Kollaps trägt die Leiste den ganzen Footer, also zeigt auch die
              // aktive Pane ihre laufende Zeit — sonst sieht man sie nirgends.
              const isUnreadOrange = isUnread && !isActive && !isBusy
              if (isBusy) {
                const mm = Math.floor(elapsedSec / 60)
                const ss = elapsedSec % 60
                // Aktive Pane schimmert in Terracotta, alle anderen silbern — so ist
                // bei mehreren laufenden Uhren sofort klar, wo man gerade drin ist.
                // Die m/s-Einheiten setzen KEINE eigene Farbe: so erben sie den
                // Schimmer-Gradient des Eltern-spans und ziehen synchron mit.
                const unitStyle: CSSProperties = { fontSize: '10.5px', fontWeight: 600, marginLeft: '1px' }
                const shimmer = isActive ? 'status-shimmer-warm' : 'status-shimmer'
                return (
                  <span
                    className={`tabular-nums text-[14px] font-semibold ${shimmer}`}
                    style={{ fontFamily: 'var(--font-heading)', textAlign: 'center', lineHeight: '22px', whiteSpace: 'nowrap' }}
                  >
                    {mm > 0
                      ? (<>{mm}<span style={{ ...unitStyle, marginRight: '2px' }}>m</span>{ss}<span style={unitStyle}>s</span></>)
                      : (<>{ss}<span style={unitStyle}>s</span></>)}
                  </span>
                )
              }
              if (isUnreadOrange) {
                return (
                  <span
                    className="unread-pulse"
                    style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cc-orange)' }}
                    aria-label="Fertig, ungelesen"
                  >
                    <Check size={14} strokeWidth={2.7} />
                  </span>
                )
              }
              const DOT = isActive ? 6 : 5
              return (
                <span
                  className="rounded-full"
                  style={{ width: DOT, height: DOT, background: isActive ? 'var(--t1)' : 'var(--t3)', opacity: isActive ? 1 : (convId ? 0.32 : 0.2) }}
                />
              )
            })()}
          </button>
        )
      })}
    </div>
  )

  const renderedPanes = paneConfigs.map((pane, idx) => {
    const isFocused = focusedPaneIdx === idx
    return (
    <div
      key={idx}
      data-pane-container
      className={
        isFocused
          ? 'fixed inset-0 z-40 bg-[var(--bg)] overflow-hidden'
          : collapseToSinglePane
            ? 'relative bg-[var(--bg)] min-h-0 overflow-hidden border-l border-[var(--border)] rounded-l-[14px] rounded-r-[14px]'
            : `relative bg-[var(--bg)] min-h-0 overflow-hidden${idx === 0 ? ' border-l border-[var(--border)] rounded-l-[14px]' : ''}${idx === N - 1 ? ' rounded-r-[14px]' : ''}`
      }
      style={chatPanesHidden || (collapseToSinglePane && idx !== visiblePaneIdx && !isFocused) ? { display: 'none' } : undefined}
      onClick={() => setActivePane(idx)}
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
          paneSwitcher={collapseToSinglePane && idx === visiblePaneIdx ? paneSwitcherNode : undefined}
          onOpenRef={openInInfo}
          onAgentFocus={() => setActivePane(idx)}
          onAgentSwitch={(newAgent) => createNewChat(newAgent, idx)}
          onConversationChange={(convId) => {
            // Aktiver Tab hat soeben einen neuen Chat erzeugt (z.B. erste Nachricht) — convId in Tab speichern
            setPaneConfigs(prev => {
              const next = [...prev]
              const p = next[idx]
              if (!p) return prev
              const newTabs = p.tabs.map((t, i) => i === p.activeIndex ? { ...t, conversationId: convId } : t)
              next[idx] = { ...p, tabs: newTabs }
              savePaneConfigs(layout, next)
              return next
            })
          }}
        />
      </div>
      {/* Layout 1: Slot-Pillen über dem Composer, wie Mobile-Bottom-Dots */}
      {!collapseToSinglePane && paneConfigs.length === 1 && idx === 0 && (
        <div
          className="absolute z-30 pointer-events-none flex justify-center"
          style={{ left: 0, right: 0, bottom: 6 }}
        >
          <div className="flex items-center gap-2 pointer-events-auto">
            {Array.from({ length: SLOT_COUNT }, (_, i) => {
              const slot = desktopSlots[i]
              const hasChat = !!slot?.conversationId
              const isActive = i === activeSlot1
              const conv = hasChat ? conversations.find(c => c.id === slot.conversationId) : null
              const isHighlight = !!conv?.highlight && !isActive
              const isBusy = hasChat && busyConvs.has(slot.conversationId)
              const background = isHighlight
                ? '#d97757'
                : isBusy
                  ? '#d97757'
                  : isActive
                    ? 'var(--t1)'
                    : 'var(--t3)'
              const opacity = isHighlight || isBusy ? 1 : isActive ? 1 : hasChat ? 0.5 : 0.22
              return (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); selectSlot1(i) }}
                  className={`rounded-full transition-opacity${isHighlight ? ' highlight-pulse' : ''}`}
                  style={{
                    width: 32,
                    height: 6,
                    background,
                    opacity,
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                  aria-label={`Slot ${i + 1}${hasChat ? ` (${conv?.title || ''})` : ''}`}
                  title={conv?.title || `Slot ${i + 1}`}
                />
              )
            })}
          </div>
        </div>
      )}
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
      onSpanChange={(span) => workspace.setSpan(Math.min(span, workspaceMaxSpan) as WorkspaceSpan)}
      onOpenFile={workspace.openFile}
      onRevealPath={workspace.revealPath}
      onOpenSearch={() => setSearch(true)}
      voiceReady={voiceReady}
      voiceActive={!!voiceSession}
      onToggleVoice={toggleKlausVoice}
    />
  )

  return (
    <VoiceController active={!!voiceSession} onClose={() => setVoiceSession(null)}>
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
        {renderedWorkspace}
        {renderedPanes}
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

      {incomingCall && (
        <IncomingCallOverlay
          briefing={incomingCall}
          onAccept={acceptIncomingCall}
          onDismiss={dismissIncomingCall}
        />
      )}

      {/* YouTube läuft global weiter, beim Modulwechsel als Mini-Player */}
      <GlobalYouTubePlayer onOpenModule={() => workspace.openMode('youtube')} />
    </div>
    </VoiceController>
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
