import { useState, useEffect, useRef, useCallback, Suspense, type CSSProperties, type TouchEvent } from 'react'
import { ArrowLeft, Check, ChevronRight, Moon, Paperclip, RotateCw, Search, Sun, X } from 'lucide-react'
import { ChatPane } from './components/ChatPane'
import { WORKSPACE_NAV, MOBILE_PRIMARY, navItem, workspaceModeLabel } from './workspace/navModel'
import { workspaceDirectory, workspaceFileKind, workspacePathParts } from './workspace/fileRouting'
import { WorkspaceContent } from './workspace/WorkspaceContent'
import { LoopWorkspace } from './workspace/LoopWorkspace'
import type { WorkspaceFile, WorkspaceMode } from './workspace/types'
import { useWerkbankTasks } from './workspace/werkbankSignal'
import { lazyWithRetry } from './components/info-pane/utils/lazyWithRetry'
const MobileFokus = lazyWithRetry(() => import('./MobileFokus'))
const MobileHealth = lazyWithRetry(() => import('./MobileHealth'))
const Spotlight = lazyWithRetry(() => import('./components/Spotlight').then(m => ({ default: m.Spotlight })))
import { getDefaultEngine } from './agents'
import { getThemeMode, resolveTheme, setThemeMode } from './theme'
import { triggerSafeRestart, isRestartInFlight } from './lib/restart'
import { preloadUISounds, playUISound } from './uiSounds'
import './index.css'

interface ConvOption {
  id: string
  agent: string
  title: string
  updated_at: number
  project?: string
  highlight?: boolean
}

interface ProjectOption {
  id: string
  name: string
  chatCount: number
  updated_at: number
}

interface Slot {
  agent: string
  convId: string
}

interface RenderedSlot extends Slot {
  ephemeral?: boolean
}

const MAX_SLOTS = 4
const MOBILE_SLOT_SLEEP_MS = 30_000

interface SlotState {
  slots: Slot[]
  activeSlot: number
}

interface StreamStatusUpdate {
  conversationId?: string
  busy?: boolean
  startedAt?: number
  done?: boolean
}

function sanitizeSlots(raw: any): Slot[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s: any) => s && typeof s.agent === 'string')
    .slice(0, MAX_SLOTS)
    .map((s: any) => ({
      agent: s.agent,
      convId: typeof s.convId === 'string' && !s.convId.startsWith('channel-') ? s.convId : '',
    }))
}

function loadSlotState(): SlotState {
  try {
    const raw = localStorage.getItem('deck:mobileSlots')
    if (raw) {
      const parsed = JSON.parse(raw)
      const slots = sanitizeSlots(parsed.slots)
      if (slots.length > 0) {
        return {
          slots,
          activeSlot: Math.max(0, Math.min(parsed.activeSlot ?? 0, slots.length - 1)),
        }
      }
    }
  } catch {}
  // Migration aus altem Schlüssel
  try {
    const old = localStorage.getItem('deck:mobileLastChat')
    if (old) {
      const p = JSON.parse(old)
      if (p && p.agent && p.convId && !String(p.convId).startsWith('channel-')) {
        return { slots: [{ agent: p.agent, convId: p.convId }], activeSlot: 0 }
      }
    }
  } catch {}
  return { slots: [{ agent: localStorage.getItem('deck:activeAgent') || 'main', convId: '' }], activeSlot: 0 }
}

function saveSlotState(state: SlotState) {
  try {
    localStorage.setItem('deck:mobileSlots', JSON.stringify(state))
    const cur = state.slots[state.activeSlot]
    if (cur && cur.convId && !cur.convId.startsWith('channel-')) {
      localStorage.setItem('deck:mobileLastChat', JSON.stringify({ agent: cur.agent, convId: cur.convId }))
      localStorage.setItem('deck:activeAgent', cur.agent)
    }
  } catch {}
}

function slotStateSig(slots: Slot[], activeSlot: number): string {
  return JSON.stringify({ slots, activeSlot })
}

function openFilePathFromDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'path' in detail) return String((detail as { path?: unknown }).path || '')
  return ''
}

function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(String(path || ''))
}

function basename(path: string): string {
  return String(path || '').split('/').pop() || 'Artefakt'
}

function MobileHtmlViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const inlineUrl = `/api/fs/download?path=${encodeURIComponent(path)}&inline=1`
  const name = basename(path)

  // Erzwinge responsives Verhalten im geladenen Artefakt, egal wie die HTML
  // gebaut ist: viewport-Meta setzen und horizontales Scrollen hart kappen.
  const onFrameLoad = () => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    try {
      let meta = doc.querySelector('meta[name="viewport"]') as HTMLMetaElement | null
      if (!meta) {
        meta = doc.createElement('meta')
        meta.name = 'viewport'
        doc.head?.appendChild(meta)
      }
      meta.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover')
      if (!doc.getElementById('ac-mobile-fit')) {
        const style = doc.createElement('style')
        style.id = 'ac-mobile-fit'
        style.textContent =
          'html,body{max-width:100%!important;overflow-x:hidden!important}' +
          '*{max-width:100%;box-sizing:border-box}' +
          'img,video,svg,canvas,table,pre{max-width:100%!important;height:auto}' +
          'pre{white-space:pre-wrap;word-break:break-word}'
        doc.head?.appendChild(style)
      }
    } catch {
      /* cross-origin sollte hier nicht auftreten, aber niemals den Viewer killen */
    }
  }

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0]
    if (!t) return
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }

  const onTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current
    touchStartRef.current = null
    const t = e.changedTouches[0]
    if (!start || !t) return
    const dx = t.clientX - start.x
    const dy = Math.abs(t.clientY - start.y)
    if (start.x < 42 && dx > 72 && dy < 70) onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <section className="mobile-html-viewer" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} aria-label="HTML Vorschau">
      <header className="mobile-html-viewer-bar">
        <button type="button" onClick={onClose} aria-label="Zurück" title="Zurück">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <strong>{name}</strong>
          <span>{path}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Schließen" title="Schließen">
          <X className="h-5 w-5" />
        </button>
      </header>
      <div className="mobile-html-viewer-swipe-zone" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} aria-hidden />
      <iframe ref={frameRef} src={inlineUrl} onLoad={onFrameLoad} className="mobile-html-viewer-frame" title={name} />
    </section>
  )
}

// Push slot list to backend so Desktop can mirror the first N panes.
// Skip ungesetzte (leere) Slots am Anfang nicht — wir tracken alle 4.
// 250ms-Debounce: schnelles Pillen-Tippen löst sonst pro Tap einen PUT aus,
// der per WS an Desktop+andere Mobiles broadcastet wird. Synchronität bleibt
// sub-second, Last sinkt deutlich.
let slotPushTimer: ReturnType<typeof setTimeout> | null = null
function pushSlotsToBackend(slots: Slot[], activeSlot = 0) {
  if (slotPushTimer) clearTimeout(slotPushTimer)
  slotPushTimer = setTimeout(() => {
    slotPushTimer = null
    fetch('/api/slots', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots, activeSlot, source: 'mobile' }),
    }).catch(() => {})
  }, 250)
}

const LONG_PRESS_MS = 600

function MobileTopMarker({
  title,
  onTap,
}: {
  title: string
  onTap: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '1px 20px 5px',
        background: 'transparent',
      }}
    >
      {/* Leiser Refresh-Slot: buildGuard mountet hier (links, gegenüber den
          Modell-Controls rechts) eine dezente Pille, wenn eine neue Version
          bereitsteht. Leer nimmt der Slot keinen Platz. */}
      <div
        id="cc-update-mobile-slot"
        style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
      />
      <button
        type="button"
        onClick={onTap}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: 1,
          minWidth: 0,
          textAlign: 'left',
          fontSize: 13,
          lineHeight: 1.1,
          color: 'var(--t3)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          letterSpacing: '0.02em',
          WebkitTapHighlightColor: 'transparent',
        }}
        aria-label="Chats öffnen"
      >
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title || 'Neuer Chat'}
        </span>
      </button>
      <div
        id="mobile-hero-model-controls"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          flexShrink: 0,
          minWidth: 20,
          color: 'var(--t3)',
        }}
      />
    </div>
  )
}

const MOBILE_FILE_ACCEPT = 'image/*,.pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.json,.yaml,.yml'

function MobileWorkspaceMenuPanel({
  bottom,
  paneIndex,
  hasUnread,
  werkbankSignal,
  onClose,
  onOpenMode,
}: {
  bottom: number
  paneIndex: number
  hasUnread: boolean
  werkbankSignal: { active: number; attention: number }
  onClose: () => void
  onOpenMode: (mode: WorkspaceMode, label: string) => void
}) {
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => resolveTheme(getThemeMode()))
  const fileInputId = `mobile-workspace-quick-file-${paneIndex}`

  useEffect(() => {
    const syncTheme = () => setResolvedTheme(resolveTheme(getThemeMode()))
    window.addEventListener('theme-changed', syncTheme)
    return () => window.removeEventListener('theme-changed', syncTheme)
  }, [])

  const toggleTheme = () => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark'
    setResolvedTheme(next)
    setThemeMode(next)
    playUISound('option-pick', 0.4)
  }

  const openMode = (mode: WorkspaceMode, label = workspaceModeLabel(mode)) => {
    onOpenMode(mode, label)
    playUISound('option-pick', 0.32)
  }

  const mobileHidden = new Set<WorkspaceMode>([...MOBILE_PRIMARY, 'artifacts'])
  const settingsGroups = WORKSPACE_NAV
    .map(group => ({ ...group, items: group.items.filter(item => !mobileHidden.has(item.id)) }))
    .filter(group => group.items.length)

  const modeRow = (mode: WorkspaceMode, label?: string, detail?: string, accent = false, notify = false, badge?: string, strong = false) => {
    const item = navItem(mode)
    const Icon = item?.icon
    return (
      <button
        key={`${mode}-${label || item?.label || mode}`}
        type="button"
        className={`mobile-workspace-settings-row${accent ? ' is-accent' : ''}${notify ? ' is-notify' : ''}${strong ? ' is-strong' : ''}`}
        onClick={() => openMode(mode, label || item?.label || workspaceModeLabel(mode))}
      >
        <span className="mobile-workspace-settings-icon" aria-hidden>
          {Icon && <Icon size={19} strokeWidth={1.75} />}
        </span>
        <span className="mobile-workspace-settings-copy">
          <strong>{label || item?.label || workspaceModeLabel(mode)}</strong>
          {detail ? <em>{detail}</em> : null}
        </span>
        {badge ? (
          <span className="mobile-workspace-settings-badge" aria-label={`${badge} aktiv`}>{badge}</span>
        ) : (
          <ChevronRight className="mobile-workspace-settings-chevron" size={19} strokeWidth={2.1} aria-hidden />
        )}
      </button>
    )
  }

  const activeRuns = werkbankSignal.active
  const needsAttention = werkbankSignal.attention > 0
  const werkbankDetail = activeRuns > 0
    ? `${activeRuns} ${activeRuns === 1 ? 'Lauf aktiv' : 'Läufe aktiv'}`
    : needsAttention
      ? `${werkbankSignal.attention} wartet`
      : 'Laufende Aufträge'

  return (
    <div className="mobile-workbench-overlay mobile-workspace-menu" style={{ bottom, zIndex: 45 }}>
      <header className="mobile-workbench-bar">
        <button type="button" onClick={onClose} aria-label="Zurück" title="Zurück">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div aria-hidden />
        <button type="button" onClick={() => openMode('inbox', 'Inbox')} aria-label="Inbox" title="Inbox">
          <Search className="h-5 w-5" />
        </button>
      </header>
      <div className="mobile-workbench-body mobile-workspace-menu-body">
        <div className="mobile-workspace-settings">
          <input
            id={fileInputId}
            type="file"
            multiple
            accept={MOBILE_FILE_ACCEPT}
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) {
                window.dispatchEvent(new CustomEvent('deck:addFiles', { detail: { paneIndex, files: event.target.files } }))
                onClose()
                playUISound('doc-open', 0.35)
              }
              event.target.value = ''
            }}
          />
          <section className="mobile-workspace-settings-group">
            {modeRow('inbox', 'Inbox', 'Nachrichten und Eingang', false, hasUnread)}
            {modeRow('loops', 'Werkbank', werkbankDetail, true, needsAttention, activeRuns > 0 ? String(activeRuns) : undefined, activeRuns > 0 || needsAttention)}
            {modeRow('knowledge', 'Wissen', 'Kundenwissen und Kontext')}
            {modeRow('filesystem', 'Dateien', 'Artefakte und Projektdateien')}
          </section>

          <section className="mobile-workspace-settings-group">
            <button type="button" className="mobile-workspace-settings-row" onClick={toggleTheme}>
              <span className="mobile-workspace-settings-icon" aria-hidden>
                {resolvedTheme === 'dark' ? <Sun size={18} strokeWidth={1.85} /> : <Moon size={18} strokeWidth={1.85} />}
              </span>
              <span className="mobile-workspace-settings-copy">
                <strong>{resolvedTheme === 'dark' ? 'Helle UI' : 'Dunkle UI'}</strong>
                <em>Design automatisch mitnehmen</em>
              </span>
              <ChevronRight className="mobile-workspace-settings-chevron" size={19} strokeWidth={2.1} aria-hidden />
            </button>
          </section>

          {settingsGroups.map(group => (
            <section key={group.label} className="mobile-workspace-settings-section">
              <div className="mobile-workspace-settings-label">{group.label}</div>
              <div className="mobile-workspace-settings-group">
                {group.items.map(item => modeRow(item.id, item.label))}
              </div>
            </section>
          ))}

          <section className="mobile-workspace-settings-section">
            <div className="mobile-workspace-settings-label">Werkzeuge</div>
            <div className="mobile-workspace-settings-group">
              <button type="button" onClick={() => { if (!isRestartInFlight()) void triggerSafeRestart() }} className="mobile-workspace-settings-row" aria-label="Server neu starten">
                <span className="mobile-workspace-settings-icon" aria-hidden><RotateCw size={18} strokeWidth={1.85} /></span>
                <span className="mobile-workspace-settings-copy">
                  <strong>Neustart</strong>
                  <em>Server kontrolliert neu laden</em>
                </span>
                <ChevronRight className="mobile-workspace-settings-chevron" size={19} strokeWidth={2.1} aria-hidden />
              </button>
              <label htmlFor={fileInputId} className="mobile-workspace-settings-row is-primary-tool" aria-label="Datei anhängen">
                <span className="mobile-workspace-settings-icon" aria-hidden><Paperclip size={18} strokeWidth={1.85} /></span>
                <span className="mobile-workspace-settings-copy">
                  <strong>Datei anhängen</strong>
                  <em>Bild, PDF oder Dokument in den Chat</em>
                </span>
                <ChevronRight className="mobile-workspace-settings-chevron" size={19} strokeWidth={2.1} aria-hidden />
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function MobileWorkspacePanel({
  mode,
  file,
  filesystemPath,
  returnMode,
  bottom,
  onClose,
  onBack,
  onOpenFile,
  onRevealPath,
  onOpenMode,
}: {
  mode: WorkspaceMode
  file?: WorkspaceFile | null
  filesystemPath?: string | null
  returnMode?: WorkspaceMode | null
  bottom: number
  onClose: () => void
  onBack: () => void
  onOpenFile: (path: string) => boolean
  onRevealPath: (path: string) => void
  onOpenMode: (mode: WorkspaceMode, label: string) => void
}) {
  const title = workspaceModeLabel(mode)
  const subtitle = returnMode && mode !== returnMode ? `Zurück zu ${workspaceModeLabel(returnMode)}` : ''
  const isPreview = mode === 'preview' && !!file

  return (
    <div className="mobile-workbench-overlay mobile-workspace-overlay" style={{ bottom }}>
      <header className="mobile-workbench-bar">
        <button type="button" onClick={returnMode && mode !== returnMode ? onBack : onClose} aria-label="Zurück" title="Zurück">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <strong>{title}</strong>
          {isPreview && file ? (
            <button type="button" className="mobile-workbench-path" onClick={() => onRevealPath(file.path)} title={file.path}>
              {workspacePathParts(file.path).name}
            </button>
          ) : subtitle ? (
            <span>{subtitle}</span>
          ) : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Schließen" title="Schließen">
          <X className="h-5 w-5" />
        </button>
      </header>
      <div className="mobile-workbench-body mobile-workspace-body workspace-body">
        <Suspense fallback={null}>
          <WorkspaceContent
            mode={mode}
            file={file}
            filesystemPath={filesystemPath}
            onClose={onClose}
            onOpenFile={onOpenFile}
            onRevealPath={onRevealPath}
            onModeChange={(nextMode) => onOpenMode(nextMode, workspaceModeLabel(nextMode))}
          />
        </Suspense>
      </div>
    </div>
  )
}

function MobileBottomDots({
  slots,
  activeSlot,
  busyConvs,
  busyStartedAt,
  unread,
  onSelect,
  onRemove,
}: {
  slots: RenderedSlot[]
  activeSlot: number
  busyConvs: Set<string>
  busyStartedAt?: Map<string, number>
  unread: Set<string>
  onSelect: (i: number) => void
  onRemove: (i: number) => void
}) {
  const longPressTimer = useRef<number | null>(null)
  const longPressFiredRef = useRef(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (busyConvs.size === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busyConvs.size])

  const handleDown = (i: number, ephemeral?: boolean) => {
    longPressFiredRef.current = false
    if (ephemeral) return
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = window.setTimeout(() => {
      longPressFiredRef.current = true
      const realCount = slots.filter(s => !s.ephemeral).length
      if (realCount > 1) onRemove(i)
    }, LONG_PRESS_MS)
  }
  const handleUp = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }
  const handleClick = (i: number) => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false
      return
    }
    onSelect(i)
  }

  return (
    <div
      className="flex items-center justify-between w-full select-none"
      style={{
        background: 'transparent',
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 0,
        paddingRight: 0,
      }}
      data-slide-ignore
    >
      {slots.map((s, i) => {
        const isEphemeral = !!s.ephemeral
        const isBusy = !!s.convId && busyConvs.has(s.convId)
        const isUnread = !!s.convId && unread.has(s.convId)
        const isActive = i === activeSlot
        const start = isBusy && s.convId ? busyStartedAt?.get(s.convId) : undefined
        const elapsedSec = start ? Math.max(0, Math.floor((now - start) / 1000)) : 0
        return (
          <div
            key={i}
            role="button"
            tabIndex={-1}
            onPointerDown={(e) => { e.stopPropagation(); handleDown(i, isEphemeral) }}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
            onPointerLeave={handleUp}
            onClick={(e) => { e.stopPropagation(); handleClick(i) }}
            className="flex-shrink-0 flex items-center justify-center select-none relative"
            style={{
              width: isBusy ? 60 : 52,
              height: 24,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
              userSelect: 'none',
              outline: 'none',
              border: 'none',
              background: 'transparent',
            }}
            aria-label={isEphemeral ? 'Neuer Slot' : `Slot ${i + 1}`}
          >
            {(() => {
              const isUnreadOrange = isUnread && !isActive && !isBusy
              if (isBusy) {
                // Unter einer Minute schlicht Sekunden, darueber m und s als ruhige
                // kleine Einheiten neben den Zahlen, damit "1m 32s" lesbar bleibt statt
                // "92". Die Einheiten brauchen eine eigene Fuellfarbe, sonst schluckt
                // der status-shimmer (transparenter Text-Fill) sie komplett.
                const mm = Math.floor(elapsedSec / 60)
                const ss = elapsedSec % 60
                const unitStyle: CSSProperties = {
                  fontSize: '12.5px',
                  fontWeight: 600,
                  color: 'var(--t2)',
                  WebkitTextFillColor: 'var(--t2)',
                  marginLeft: '1px',
                }
                return (
                  <span
                    className="tabular-nums text-[18px] font-semibold status-shimmer"
                    style={{
                      fontFamily: 'var(--font-heading)',
                      minWidth: 48,
                      textAlign: 'center',
                      lineHeight: '24px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {mm > 0 ? (
                      <>{mm}<span style={{ ...unitStyle, marginRight: '2px' }}>m</span>{ss}<span style={unitStyle}>s</span></>
                    ) : (
                      <>{ss}<span style={unitStyle}>s</span></>
                    )}
                  </span>
                )
              }
              if (isUnreadOrange) {
                return (
                  <span
                    className="unread-pulse"
                    style={{
                      width: 26,
                      height: 26,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--cc-orange)',
                    }}
                    aria-label="Ungelesene Antwort"
                  >
                    <Check size={19} strokeWidth={2.7} />
                  </span>
                )
              }
              const background = isActive ? 'var(--t1)' : 'var(--t3)'
              const opacity = isActive ? 1 : (isEphemeral ? 0.2 : 0.32)
              const DOT = isActive ? 7 : 6
              return (
                <span
                  className="rounded-full"
                  style={{ width: DOT, height: DOT, opacity, background }}
                />
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}

export default function MobileApp() {
  const [slotState, setSlotState] = useState<SlotState>(loadSlotState)
  const { slots, activeSlot } = slotState

  const [page, setPage] = useState<0 | 1>(0)
  // Fokus-Overlay liegt über dem Chat, bis zum Composer.
  // Schließt sich mit WA gegenseitig aus, Toggle über das Plus-Menü.
  const [fokusOpen, setFokusOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [werkbankOpen, setWerkbankOpen] = useState(false)
  const [mobileWorkspaceMode, setMobileWorkspaceMode] = useState<WorkspaceMode | null>(null)
  const [mobileWorkspaceReturnMode, setMobileWorkspaceReturnMode] = useState<WorkspaceMode | null>(null)
  const [mobileWorkspaceFile, setMobileWorkspaceFile] = useState<WorkspaceFile | null>(null)
  const [mobileFilesystemPath, setMobileFilesystemPath] = useState<string | null>(null)
  const mobileWorkspaceModeRef = useRef<WorkspaceMode | null>(null)
  useEffect(() => { mobileWorkspaceModeRef.current = mobileWorkspaceMode }, [mobileWorkspaceMode])
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [ephemeralActive, setEphemeralActive] = useState(false)
  const [composerHeight, setComposerHeight] = useState<number>(240)

  const currentSlot = slots[activeSlot] || { agent: 'main', convId: '' }
  const agent = currentSlot.agent
  const conversationId = currentSlot.convId
  // visibleSlotIndex: zeigt entweder den aktiven realen Slot oder den ephemeralen.
  const visibleSlotIndex = ephemeralActive ? slots.length : activeSlot
  const anyMobileModuleOpen = page === 1 || fokusOpen || healthOpen || werkbankOpen || !!mobileWorkspaceMode || workspaceMenuOpen

  // Lazy-warm: nur der sichtbare Slot wird sofort gemountet. Versteckte Slots
  // schlafen nach kurzer Zeit wieder ein, damit sie keine WS/Timer/Fetches halten.
  const [warmedSlotKeys, setWarmedSlotKeys] = useState<Set<string>>(new Set())

  // ── Slot-Operationen ──

  const lastPushedRef = useRef<string>('')
  // Erst pushen, wenn der initiale Pull abgeschlossen ist — sonst kann ein
  // frisch geladener Client (leerer Default-State) die echten Server-Slots überschreiben.
  const slotsHydratedRef = useRef<boolean>(false)
  const persistSlots = useCallback((next: SlotState) => {
    saveSlotState(next)
    const sig = slotStateSig(next.slots, next.activeSlot)
    if (sig !== lastPushedRef.current) {
      lastPushedRef.current = sig
      if (slotsHydratedRef.current) pushSlotsToBackend(next.slots, next.activeSlot)
    }
    return next
  }, [])

  const updateSlot = useCallback((idx: number, partial: Partial<Slot>) => {
    setSlotState(prev => {
      if (idx < 0 || idx >= prev.slots.length) return prev
      const slots = prev.slots.map((s, i) => i === idx ? { ...s, ...partial } : s)
      return persistSlots({ ...prev, slots })
    })
  }, [persistSlots])

  const materializeEphemeral = useCallback((convId: string, slotAgent: string) => {
    setSlotState(prev => {
      if (prev.slots.length >= MAX_SLOTS) return prev
      const slots = [...prev.slots, { agent: slotAgent, convId }]
      return persistSlots({ slots, activeSlot: slots.length - 1 })
    })
    setEphemeralActive(false)
  }, [persistSlots])

  const removeSlot = useCallback((idx: number) => {
    setSlotState(prev => {
      if (prev.slots.length <= 1) return prev
      const slots = prev.slots.filter((_, i) => i !== idx)
      const activeSlot = Math.max(0, Math.min(prev.activeSlot >= idx ? prev.activeSlot - 1 : prev.activeSlot, slots.length - 1))
      return persistSlots({ slots, activeSlot })
    })
    setEphemeralActive(false)
  }, [persistSlots])

  // ── Recording / Voice / Search State ──

  const [recording, setRecording] = useState(false)
  const [recordingStarting, setRecordingStarting] = useState(false)
  const [paused, setPaused] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const cancelledRef = useRef(false)
  const startCancelledRef = useRef(false)
  const [conversations, setConversations] = useState<ConvOption[]>([])
  const [archivedChats, setArchivedChats] = useState<ConvOption[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [busyConvs, setBusyConvs] = useState<Set<string>>(new Set())
  const [busyStartedAt, setBusyStartedAt] = useState<Map<string, number>>(new Map())
  const [doneConvs, setDoneConvs] = useState<Map<string, number>>(new Map())
  const busyConvsRef = useRef<Set<string>>(new Set())
  // Wann kam zuletzt ein Busy-Push (deck:convBusy) pro Conv? Schuetzt frisch
  // gestartete Streams davor, vom langsameren active-streams-Poll ausgeknipst zu
  // werden, bevor der Server-Snapshot sie kennt.
  const lastBusyPushRef = useRef<Map<string, number>>(new Map())
  const [searchOpen, setSearchOpen] = useState(false)
  const [htmlPreviewPath, setHtmlPreviewPath] = useState<string | null>(null)

  const openDesktopWorkspaceMode = useCallback(async (mode: WorkspaceMode, label: string) => {
    setSearchOpen(false)
    setPage(0)
    setFokusOpen(false)
    setHealthOpen(false)
    setWerkbankOpen(false)
    setHtmlPreviewPath(null)
    setMobileWorkspaceMode(mode)
    setMobileWorkspaceReturnMode(null)
    setMobileWorkspaceFile(null)
    setMobileFilesystemPath(null)
    setWorkspaceMenuOpen(false)
    playUISound('workspace-open', 0.35)
    try {
      const r = await fetch('/api/ui-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'workspace', payload: { action: 'open', mode } }),
      })
      const d = await r.json().catch(() => ({}))
      void d?.delivered
    } catch {
      void label
    }
  }, [])

  const openMobileWorkspaceFile = useCallback((path: string): boolean => {
    const filePath = String(path || '')
    const kind = workspaceFileKind(filePath)
    if (!kind) return false
    const currentMode = mobileWorkspaceModeRef.current
    if (currentMode && currentMode !== 'preview' && currentMode !== 'document' && currentMode !== 'filesystem') {
      setMobileWorkspaceReturnMode(currentMode)
    }
    setSearchOpen(false)
    setPage(0)
    setFokusOpen(false)
    setHealthOpen(false)
    setWerkbankOpen(false)
    setWorkspaceMenuOpen(false)
    setHtmlPreviewPath(null)
    setMobileWorkspaceFile({ path: filePath, kind })
    setMobileFilesystemPath(kind === 'html' ? null : (workspaceDirectory(filePath) || null))
    setMobileWorkspaceMode(kind === 'html' ? 'preview' : 'filesystem')
    playUISound('doc-open', 0.45)
    return true
  }, [])

  const openMobileHtmlPreview = useCallback((path: string): boolean => {
    const filePath = String(path || '')
    if (!isHtmlPath(filePath)) return false
    setSearchOpen(false)
    setFokusOpen(false)
    setHealthOpen(false)
    setWerkbankOpen(false)
    setWorkspaceMenuOpen(false)
    setMobileWorkspaceMode(null)
    setMobileWorkspaceReturnMode(null)
    setMobileWorkspaceFile(null)
    setMobileFilesystemPath(null)
    setPage(0)
    setHtmlPreviewPath(filePath)
    playUISound('doc-open', 0.45)
    return true
  }, [])

  useEffect(() => {
    const onOpen = () => setSearchOpen(true)
    window.addEventListener('deck:openSearch', onOpen)
    return () => window.removeEventListener('deck:openSearch', onOpen)
  }, [])

  const returnToChatPane = useCallback(() => {
    setSearchOpen(false)
    setFokusOpen(false)
    setHealthOpen(false)
    setWerkbankOpen(false)
    setMobileWorkspaceMode(null)
    setMobileWorkspaceReturnMode(null)
    setMobileWorkspaceFile(null)
    setMobileFilesystemPath(null)
    setWorkspaceMenuOpen(false)
    setHtmlPreviewPath(null)
    setPage(0)
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const path = openFilePathFromDetail((e as CustomEvent).detail)
      if (!path) return
      if (mobileWorkspaceModeRef.current || !isHtmlPath(path)) {
        openMobileWorkspaceFile(path)
        return
      }
      openMobileHtmlPreview(path)
    }
    window.addEventListener('deck:openFile', handler)
    return () => window.removeEventListener('deck:openFile', handler)
  }, [openMobileHtmlPreview, openMobileWorkspaceFile])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const a = target.closest('a[data-path-link="1"]') as HTMLAnchorElement | null
      if (!a) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      try {
        const url = new URL(a.href, window.location.origin)
        const path = url.searchParams.get('path') || ''
        if (!isHtmlPath(path)) return
        e.preventDefault()
        openMobileHtmlPreview(path)
      } catch {}
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [openMobileHtmlPreview])

  useEffect(() => {
    window.addEventListener('deck:returnToChatPane', returnToChatPane)
    return () => window.removeEventListener('deck:returnToChatPane', returnToChatPane)
  }, [returnToChatPane])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:mobileMenuAreaState', {
      detail: { open: page === 1 || fokusOpen || healthOpen || werkbankOpen || !!mobileWorkspaceMode || workspaceMenuOpen || searchOpen || !!htmlPreviewPath },
    }))
  }, [page, fokusOpen, healthOpen, werkbankOpen, mobileWorkspaceMode, workspaceMenuOpen, searchOpen, htmlPreviewPath])

  useEffect(() => { preloadUISounds() }, [])

  // Backend-Sync: Beim Mount und bei jedem App-Reopen (visibilitychange) ziehen wir
  // die Slots frisch vom Server. Server ist Quelle der Wahrheit für die ersten 4
  // Slots — Desktop und Mobile spiegeln dieselbe Liste.
  useEffect(() => {
    const pull = () => {
      fetch('/api/slots').then(r => r.json()).then(d => {
        const incoming = sanitizeSlots(d?.slots)
        if (incoming.length === 0) {
          slotsHydratedRef.current = true
          return
        }
        setSlotState(prev => {
          const serverActive = typeof d?.activeSlot === 'number' ? d.activeSlot : undefined
          const activeSlot = serverActive != null
            ? Math.min(serverActive, Math.max(0, incoming.length - 1))
            : Math.min(prev.activeSlot, Math.max(0, incoming.length - 1))
          const localSig = slotStateSig(prev.slots, prev.activeSlot)
          const serverSig = slotStateSig(incoming, activeSlot)
          if (localSig === serverSig) return prev
          lastPushedRef.current = serverSig
          const next: SlotState = { slots: incoming, activeSlot }
          try { localStorage.setItem('deck:mobileSlots', JSON.stringify(next)) } catch {}
          return next
        })
        slotsHydratedRef.current = true
      }).catch(() => { slotsHydratedRef.current = true })
    }
    pull()
    const onVisible = () => { if (!document.hidden) pull() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', pull)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', pull)
    }
  }, [])

  // WebSocket-Push: andere Clients (Desktop) ändern Slots → wir spiegeln
  useEffect(() => {
    const onSlotsUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      if (detail.source === 'mobile') return
      const incoming = sanitizeSlots(detail.slots)
      if (incoming.length === 0) return
      setSlotState(prev => {
        const incomingActive = typeof detail.activeSlot === 'number' ? detail.activeSlot : undefined
        const activeSlot = incomingActive != null
          ? Math.min(incomingActive, Math.max(0, incoming.length - 1))
          : Math.min(prev.activeSlot, Math.max(0, incoming.length - 1))
        const sig = slotStateSig(incoming, activeSlot)
        if (sig === slotStateSig(prev.slots, prev.activeSlot)) return prev
        lastPushedRef.current = sig
        const next: SlotState = { slots: incoming, activeSlot }
        try { localStorage.setItem('deck:mobileSlots', JSON.stringify(next)) } catch {}
        return next
      })
    }
    window.addEventListener('deck:slotsUpdate', onSlotsUpdate)
    return () => window.removeEventListener('deck:slotsUpdate', onSlotsUpdate)
  }, [])

  useEffect(() => {
    const onUnread = (e: Event) => {
      const { conversationId: cid, agent: ag, source } = (e as CustomEvent).detail || {}
      const target = cid || (ag ? `channel-${ag}` : '')
      if (!target) return
      if (target === conversationId) return
      setUnread(prev => { const n = new Set(prev); n.add(target); return n })
      if (source !== 'mobile' && (typeof document === 'undefined' || document.hasFocus())) playUISound('tell-message', 0.6)
    }
    window.addEventListener('deck:unread', onUnread)
    return () => window.removeEventListener('deck:unread', onUnread)
  }, [conversationId])

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const levelRafRef = useRef<number>(0)
  const micIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Conversation & Project loading ──

  const postMobilePerf = useCallback((sample: Record<string, unknown>) => {
    try {
      fetch('/api/mobile-perf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: Date.now(), path: location.pathname, hidden: document.hidden, clientKind: 'mobile', ...sample }),
        keepalive: true,
      }).catch(() => {})
    } catch {}
  }, [])

  const loadConversations = useCallback(() => {
    if (recording || recordingStarting || transcribing) return
    fetch('/api/conversations?limit=0')
      .then(r => r.json())
      .then(d => {
        const convs = (d.conversations || []).map((c: any) => ({ id: c.id, agent: c.agent, title: c.title, updated_at: c.updated_at || 0, project: c.project || '', highlight: !!c.highlight }))
        setConversations(convs)
      })
      .catch(() => {})
    fetch('/api/projects')
      .then(r => r.json())
      .then(d => setProjects((d.projects || []).map((p: any) => ({ id: p.id, name: p.name, chatCount: p.chatCount || 0, updated_at: p.updated_at || 0 }))))
      .catch(() => {})
  }, [recording, recordingStarting, transcribing])

  const loadArchivedChats = useCallback(() => {
    fetch('/api/conversations?limit=0&archived=true')
      .then(r => r.json())
      .then(d => {
        const convs = (d.conversations || []).filter((c: any) => c.archived).map((c: any) => ({ id: c.id, agent: c.agent, title: c.title, updated_at: c.updated_at || 0 }))
        setArchivedChats(convs)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadConversations()
    const interval = setInterval(() => { if (!document.hidden) loadConversations() }, 45000)
    const handler = () => loadConversations()
    window.addEventListener('deck:chatsChanged', handler)
    const titleHandler = (e: Event) => {
      const { conversationId: cid, title } = (e as CustomEvent).detail
      setConversations(prev => prev.map(c => c.id === cid ? { ...c, title } : c))
    }
    window.addEventListener('deck:titleUpdate', titleHandler)
    return () => { clearInterval(interval); window.removeEventListener('deck:chatsChanged', handler); window.removeEventListener('deck:titleUpdate', titleHandler) }
  }, [loadConversations])

  const markConversationRead = useCallback((convId: string) => {
    if (!convId) return
    setUnread(prev => {
      if (!prev.has(convId)) return prev
      const next = new Set(prev)
      next.delete(convId)
      return next
    })
    fetch('/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId }),
    }).catch(() => {})
  }, [])

  // Mobile braucht einen eigenen Backend-Abgleich. Versteckte Slots sind nicht
  // dauerhaft gemountet und bekommen deshalb nicht jedes Live-Unread-Event mit.
  const refreshUnread = useCallback(() => {
    fetch('/api/unread')
      .then(r => r.json())
      .then(data => {
        const counts = data.unread || {}
        const next = new Set<string>()
        for (const [convId, count] of Object.entries(counts)) {
          if ((count as number) > 0) next.add(convId)
        }
        if (conversationId) next.delete(conversationId)
        setUnread(next)
      })
      .catch(() => {})
  }, [conversationId])

  useEffect(() => {
    refreshUnread()
    const interval = setInterval(() => { if (!document.hidden) refreshUnread() }, 30000)
    const onVisible = () => { if (!document.hidden) refreshUnread() }
    window.addEventListener('deck:chatsChanged', refreshUnread)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refreshUnread)
    return () => {
      clearInterval(interval)
      window.removeEventListener('deck:chatsChanged', refreshUnread)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refreshUnread)
    }
  }, [refreshUnread])

  // Validate saved slot conversations once conversations load
  const validatedRef = useRef(false)
  useEffect(() => {
    if (validatedRef.current || conversations.length === 0) return
    validatedRef.current = true
    setSlotState(prev => {
      let changed = false
      const slots = prev.slots.map(s => {
        if (s.convId && !conversations.find(c => c.id === s.convId)) {
          changed = true
          return { ...s, convId: '' }
        }
        return s
      })
      if (!changed) return prev
      return persistSlots({ ...prev, slots })
    })
  }, [conversations, persistSlots])

  // Unread tracking — neue Activity in nicht-aktivem Conv markiert ungelesen
  useEffect(() => {
    const handler = (e: Event) => {
      const { conversationId: cid } = (e as CustomEvent).detail || {}
      if (cid && cid !== conversationId) setUnread(prev => new Set(prev).add(cid))
    }
    window.addEventListener('deck:activity', handler)
    return () => window.removeEventListener('deck:activity', handler)
  }, [conversationId])

  const applyStreamStatus = useCallback((update: StreamStatusUpdate) => {
    const cid = update.conversationId
    if (!cid) return
    const isBusy = !!update.busy
    const wasBusy = busyConvsRef.current.has(cid)
    const now = Date.now()
    if (isBusy) lastBusyPushRef.current.set(cid, now)
    else lastBusyPushRef.current.delete(cid)
    setBusyConvs(prev => {
      const next = new Set(prev)
      if (isBusy) next.add(cid); else next.delete(cid)
      if (next.size === prev.size && next.has(cid) === prev.has(cid)) return prev
      busyConvsRef.current = next
      return next
    })
    setBusyStartedAt(prev => {
      const next = new Map(prev)
      if (isBusy) {
        const wallStart = typeof update.startedAt === 'number' && update.startedAt > 0
          ? update.startedAt
          : (prev.get(cid) ?? now)
        next.set(cid, wallStart)
      } else {
        next.delete(cid)
      }
      return next
    })
    setDoneConvs(prev => {
      const next = new Map(prev)
      if (isBusy) next.delete(cid)
      else if (update.done !== false && (wasBusy || update.done)) next.set(cid, now)
      return next
    })
  }, [])

  const applyActiveStreamsSnapshot = useCallback((streams: Array<{ convId: string; startedAt: number }>) => {
    const now = Date.now()
    const previous = busyConvsRef.current
    const running = new Set(streams.map(s => s.convId).filter(Boolean))
    // Frisch gepushte Convs (< 8s), die der Server-Snapshot noch nicht kennt,
    // bleiben busy — sonst flackert der Punkt zwischen Push- und Poll-Stand.
    const FRESH_PUSH_MS = 8000
    for (const cid of previous) {
      if (!running.has(cid) && now - (lastBusyPushRef.current.get(cid) ?? 0) < FRESH_PUSH_MS) {
        running.add(cid)
      }
    }
    const started = new Map<string, number>()
    for (const s of streams) {
      if (!s.convId) continue
      started.set(s.convId, s.startedAt && s.startedAt > 0 ? s.startedAt : now)
    }
    const ended = [...previous].filter(cid => !running.has(cid))
    setBusyConvs(prev => {
      let changed = prev.size !== running.size
      if (!changed) {
        for (const cid of running) {
          if (!prev.has(cid)) { changed = true; break }
        }
      }
      if (!changed) return prev
      const next = new Set(running)
      busyConvsRef.current = next
      return next
    })
    setBusyStartedAt(prev => {
      let changed = prev.size !== started.size
      const next = new Map<string, number>()
      for (const cid of running) {
        const value = started.get(cid) ?? prev.get(cid) ?? now
        next.set(cid, value)
        if (prev.get(cid) !== value) changed = true
      }
      return changed ? next : prev
    })
    if (ended.length > 0 || running.size > 0) {
      setDoneConvs(prev => {
        const next = new Map(prev)
        for (const cid of running) next.delete(cid)
        for (const cid of ended) next.set(cid, now)
        return next
      })
    }
  }, [])

  // Global busy tracking: MobileApp ist die eine UI-Wahrheit fuer laufende Streams.
  useEffect(() => {
    const handler = (e: Event) => applyStreamStatus(((e as CustomEvent).detail || {}) as StreamStatusUpdate)
    window.addEventListener('deck:convBusy', handler)
    return () => window.removeEventListener('deck:convBusy', handler)
  }, [applyStreamStatus])

  useEffect(() => {
    if (doneConvs.size === 0) return
    const t = setInterval(() => {
      setDoneConvs(prev => {
        const now = Date.now()
        let changed = false
        const next = new Map<string, number>()
        prev.forEach((ts, cid) => {
          if (now - ts < 4000) next.set(cid, ts)
          else changed = true
        })
        return changed ? next : prev
      })
    }, 1000)
    return () => clearInterval(t)
  }, [doneConvs.size])

  // Wenn App aus Hintergrund kommt: aktive Streams pollen, damit die Punkte
  // sofort den richtigen Status zeigen — ws.attach läuft parallel und holt
  // den vollen Snapshot in den aktiven Pane.
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      fetch('/api/active-streams').then(r => r.json()).then(d => {
        if (cancelled) return
        const streams: Array<{ convId: string; startedAt: number }> = Array.isArray(d?.streams) ? d.streams : []
        const normalized = streams.length > 0
          ? streams
          : (Array.isArray(d?.convIds) ? d.convIds.map((convId: string) => ({ convId, startedAt: 0 })) : [])
        applyActiveStreamsSnapshot(normalized)
      }).catch(() => {})
    }
    refresh()
    // Push (deck:convBusy aus stream.state ueber den WS-Hub) ist die primaere,
    // sofortige Busy-Quelle. Dieser Poll ist nur noch seltenes Sicherheitsnetz
    // gegen verpasste Events — vorher kaempfte der 15s-Poll mit dem Push und die
    // Status-Punkte flackerten zwischen Poll- und Push-Stand. visibilitychange
    // holt beim App-Wechsel weiterhin sofort den frischen Stand.
    const interval = setInterval(refresh, 60000)
    const onVisible = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(interval); document.removeEventListener('visibilitychange', onVisible) }
  }, [applyActiveStreamsSnapshot])

  // Wenn der aktive Slot eine Conv hat, "ungelesen" wegnehmen
  useEffect(() => {
    if (conversationId) markConversationRead(conversationId)
  }, [conversationId, markConversationRead])

  // ── Chat operations ──

  const switchConversationInSlot = useCallback((slotIdx: number, convId: string, convAgent: string) => {
    let resolvedIdx = slotIdx
    setSlotState(prev => {
      if (slotIdx < prev.slots.length) {
        // Existierender Slot
        const slots = prev.slots.map((s, i) => i === slotIdx ? { ...s, agent: convAgent, convId } : s)
        return persistSlots({ ...prev, slots, activeSlot: slotIdx })
      }
      // Ephemeraler Slot wird konkret
      if (prev.slots.length >= MAX_SLOTS) return prev
      const slots = [...prev.slots, { agent: convAgent, convId }]
      resolvedIdx = slots.length - 1
      return persistSlots({ slots, activeSlot: resolvedIdx })
    })
    setEphemeralActive(false)
    setPage(0)
    markConversationRead(convId)
    window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent: convAgent, conversationId: convId, paneIndex: resolvedIdx } }))
  }, [markConversationRead, persistSlots])

  const createNewChatInSlot = useCallback(async (slotIdx: number, chatAgent: string, project?: string) => {
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: chatAgent, engine: getDefaultEngine(), ...(project ? { project } : {}) }),
      })
      const data = await res.json()
      if (data.id) {
        switchConversationInSlot(slotIdx, data.id, chatAgent)
        window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
      }
    } catch {}
  }, [switchConversationInSlot])

  const renameChat = useCallback((convId: string, title: string) => {
    fetch(`/api/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(() => { loadConversations(); window.dispatchEvent(new CustomEvent('deck:chatsChanged')) })
  }, [loadConversations])

  const archiveChat = useCallback((convId: string) => {
    fetch(`/api/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    }).then(() => {
      loadConversations()
      window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
      // Aus allen Slots entfernen, die diese Conv hatten
      setSlotState(prev => {
        let changed = false
        const slots = prev.slots.map(s => {
          if (s.convId === convId) { changed = true; return { ...s, convId: '' } }
          return s
        })
        if (!changed) return prev
        return persistSlots({ ...prev, slots })
      })
    })
  }, [loadConversations, persistSlots])

  const restoreChat = useCallback((convId: string) => {
    fetch(`/api/conversations/${convId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    }).then(() => {
      loadConversations()
      loadArchivedChats()
      window.dispatchEvent(new CustomEvent('deck:chatsChanged'))
    })
  }, [loadConversations, loadArchivedChats])

  const handleAgentSwitchInSlot = useCallback((slotIdx: number, newAgent: string) => {
    createNewChatInSlot(slotIdx, newAgent)
  }, [createNewChatInSlot])

  // ── Voice recording ──

  // WA-Hijack-Mirror: MobileWASlot dispatcht deck:waSendTarget, wenn ein WA-Thread
  // offen ist. Wir cachen es hier, damit die Voice-Transkription beim Auto-Send nicht
  // an Agent geht (umgeht den Composer.send-Pfad).
  const waTargetRef = useRef<{ chat_id: string | null; account: string | null; uid: string | null; draft: boolean; previousDraft: string }>({ chat_id: null, account: null, uid: null, draft: false, previousDraft: '' })
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      waTargetRef.current = {
        chat_id: typeof d.chat_id === 'string' && d.chat_id ? d.chat_id : null,
        account: typeof d.account === 'string' && d.account ? d.account : null,
        uid: typeof d.uid === 'string' && d.uid ? d.uid : (typeof d.uid === 'number' ? String(d.uid) : null),
        draft: !!d.draft,
        previousDraft: typeof d.previousDraft === 'string' ? d.previousDraft : '',
      }
    }
    window.addEventListener('deck:waSendTarget', handler)
    return () => window.removeEventListener('deck:waSendTarget', handler)
  }, [])

  // Draft-Aufruf an einer Stelle. Bei Fehler/leerem Ergebnis geht der Hint (die
  // gesprochene/getippte Eingabe) im Result mit zurueck, damit nichts verpufft —
  // der Slot zeigt ihn dann wiederherstellbar an und kann ueber deck:waDraftRetry
  // erneut ausloesen.
  const runWaDraft = useCallback((chatId: string, hint: string, previousDraft: string) => {
    window.dispatchEvent(new CustomEvent('deck:waDraftStart', { detail: { chat_id: chatId } }))
    fetch('/api/whatsapp/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, hint, previousDraft }),
    }).then(r => r.json().catch(() => null)).then((d: any) => {
      const draftText = (d?.draft || d?.text || '').trim()
      const notice = typeof d?.notice === 'string' ? d.notice : ''
      if (draftText) {
        window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { chat_id: chatId, text: draftText, notice } }))
      } else {
        window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { chat_id: chatId, text: '', error: true, hint, notice } }))
      }
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { chat_id: chatId, text: '', error: true, hint } }))
    })
  }, [])

  // Mail-Pendant zu runWaDraft: gesprochener Input wird zum Antwort-Draft im offenen
  // Mail-Thread. Feuert exakt dieselben Draft-Events wie der Composer-Text-Pfad, nur mit
  // mail_key statt chat_id, damit MobileWASlot den Draft im richtigen Thread anzeigt.
  const runMailDraft = useCallback((account: string, uid: string, hint: string, previousDraft: string) => {
    const mailKey = `${account}:${uid}`
    window.dispatchEvent(new CustomEvent('deck:waDraftStart', { detail: { mail_key: mailKey, account, uid } }))
    fetch('/api/mail/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, uid, hint, previousDraft }),
    }).then(r => r.json().catch(() => null)).then((d: any) => {
      const draftText = (d?.draft || d?.text || '').trim()
      const notice = typeof d?.notice === 'string' ? d.notice : ''
      if (draftText) {
        window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { mail_key: mailKey, account, uid, text: draftText, notice } }))
      } else {
        window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { mail_key: mailKey, account, uid, text: '', error: true, hint, notice } }))
      }
    }).catch(() => {
      window.dispatchEvent(new CustomEvent('deck:waDraftResult', { detail: { mail_key: mailKey, account, uid, text: '', error: true, hint } }))
    })
  }, [])

  useEffect(() => {
    const onRetry = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      const chatId = typeof d.chat_id === 'string' ? d.chat_id : ''
      const hint = typeof d.hint === 'string' ? d.hint : ''
      if (!chatId || !hint) return
      runWaDraft(chatId, hint, waTargetRef.current.previousDraft)
    }
    window.addEventListener('deck:waDraftRetry', onRetry)
    return () => window.removeEventListener('deck:waDraftRetry', onRetry)
  }, [runWaDraft])

  const sendVoiceText = useCallback((text: string) => {
    const waTarget = waTargetRef.current
    if (waTarget.chat_id) {
      const chatId = waTarget.chat_id
      if (waTarget.draft) {
        // Brain-Modus: gesprochener Input ist immer der Draft-Auftrag, nie eine Frage.
        runWaDraft(chatId, text, waTarget.previousDraft)
      } else {
        fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        }).then(() => {
          window.dispatchEvent(new CustomEvent('deck:waMessageSent', { detail: { chat_id: chatId, text } }))
        }).catch(() => {})
      }
      return
    }
    // Offener Mail-Thread: Diktat wird zum Antwort-Draft, genau wie der Text-Pfad im Composer.
    if (waTarget.account && waTarget.uid) {
      runMailDraft(waTarget.account, waTarget.uid, text, waTarget.previousDraft)
      return
    }
    const targetAgent = ephemeralActive ? (slots[slots.length - 1]?.agent || 'main') : agent
    const targetIndex = ephemeralActive ? slots.length : activeSlot
    window.dispatchEvent(new CustomEvent('deck:voiceSend', { detail: { agentId: targetAgent, text, paneIndex: targetIndex } }))
  }, [agent, activeSlot, ephemeralActive, slots, runWaDraft, runMailDraft])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:recordingState', { detail: { recording: recording || recordingStarting, starting: recordingStarting } }))
  }, [recording, recordingStarting])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:pausedState', { detail: { paused } }))
  }, [paused])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:transcribingState', { detail: { transcribing } }))
  }, [transcribing])

  const releaseMicStream = useCallback(() => {
    if (micIdleTimerRef.current) { clearTimeout(micIdleTimerRef.current); micIdleTimerRef.current = null }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null }
  }, [])

  // Stream nach Aufnahme-Ende nur kurz warm halten, dann freigeben — sonst bleibt
  // der iOS-Mic-Indicator dauerhaft an, obwohl nichts mehr aufgenommen wird.
  const scheduleMicRelease = useCallback(() => {
    if (micIdleTimerRef.current) clearTimeout(micIdleTimerRef.current)
    micIdleTimerRef.current = setTimeout(() => { releaseMicStream() }, 4000)
  }, [releaseMicStream])

  const stopRecording = useCallback(() => {
    startCancelledRef.current = true
    setRecordingStarting(false)
    if (levelRafRef.current) { cancelAnimationFrame(levelRafRef.current); levelRafRef.current = 0 }
    analyserRef.current = null
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    recorderRef.current = null
    setRecording(false)
    setPaused(false)
    scheduleMicRelease()
  }, [scheduleMicRelease])

  // Mic-Stream beim Verstecken freigeben (iOS-Mic-Indicator weg).
  useEffect(() => {
    const onHidden = () => { if (document.hidden && !recording) releaseMicStream() }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [recording, releaseMicStream])

  // Stream beim Unmount freigeben — eigener Effekt damit recording-Wechsel nichts killt.
  useEffect(() => () => releaseMicStream(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true
    stopRecording()
  }, [stopRecording])

  const pauseRecording = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state !== 'recording') return
    rec.pause()
    if (levelRafRef.current) { cancelAnimationFrame(levelRafRef.current); levelRafRef.current = 0 }
    setPaused(true)
  }, [])

  const resumeRecording = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state !== 'paused') return
    rec.resume()
    setPaused(false)
    // Audio-Level-RAF deaktiviert: niemand hört auf deck:audioLevels, kostet 60fps CPU.
  }, [])

  const startRecording = useCallback(async () => {
    if (transcribing || recordingStarting) return
    const tapAt = performance.now()
    startCancelledRef.current = false
    setRecordingStarting(true)
    postMobilePerf({ event: 'recording_tap' })
    window.dispatchEvent(new CustomEvent('deck:stopAudio'))
    cancelledRef.current = false
    // Geplante Stream-Freigabe abbrechen — wir nehmen ja gerade wieder auf.
    if (micIdleTimerRef.current) { clearTimeout(micIdleTimerRef.current); micIdleTimerRef.current = null }
    try {
      // Stream zwischen Aufnahmen kurz warm halten — getUserMedia kostet auf iOS jedes Mal
      // 300–800ms (Permission + Hardware-Init). 4s nach Stop wird er freigegeben (siehe
      // scheduleMicRelease), damit der iOS-Mic-Indicator nicht dauerhaft an bleibt.
      let stream = streamRef.current
      const stillLive = stream && stream.getTracks().some(t => t.readyState === 'live')
      if (!stream || !stillLive) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
      }
      if (startCancelledRef.current) {
        setRecordingStarting(false)
        scheduleMicRelease()
        return
      }
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        if (cancelledRef.current) { cancelledRef.current = false; chunksRef.current = []; return }
        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []
        if (blob.size < 1000) return
        const transcribeAt = performance.now()
        setTranscribing(true)
        const ext = mimeType.includes('webm') ? '.webm' : '.m4a'
        let text = ''
        let lastErr = ''
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const form = new FormData()
            form.append('file', blob, `voice${ext}`)
            const res = await fetch('/api/transcribe', { method: 'POST', body: form })
            if (res.ok) {
              const data = await res.json()
              text = (data.text || '').trim()
              break
            }
            lastErr = `http ${res.status}`
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
              await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
              continue
            }
            break
          } catch (err: any) {
            lastErr = String(err?.message || err)
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
          }
        }
        setTranscribing(false)
        postMobilePerf({ event: 'recording_transcribe_done', durationMs: Math.round(performance.now() - transcribeAt), ok: !!text })
        if (text) sendVoiceText(text)
        else {
          if (lastErr) console.error('Transcribe error:', lastErr)
          alert('Nichts erkannt — bitte nochmal sprechen.')
        }
      }
      recorderRef.current = recorder
      recorder.start(5000)
      // Audio-Analyser/Levels-RAF deaktiviert: niemand hört auf deck:audioLevels,
      // kostet 60fps CPU + Allocations pro Frame. Aufnahme selbst läuft trotzdem.
      const broadcastLevels = () => {}
      levelRafRef.current = requestAnimationFrame(broadcastLevels)
      setRecording(true)
      setRecordingStarting(false)
      postMobilePerf({ event: 'recording_ready', durationMs: Math.round(performance.now() - tapAt), reusedStream: !!stillLive })
    } catch (err: any) {
      setRecordingStarting(false)
      postMobilePerf({ event: 'recording_error', durationMs: Math.round(performance.now() - tapAt), reason: String(err?.message || err).slice(0, 160) })
      console.error('Mic access error:', err)
    }
  }, [postMobilePerf, recordingStarting, scheduleMicRelease, transcribing, sendVoiceText])

  const toggleRecording = useCallback(() => {
    if (recording || recordingStarting) stopRecording(); else startRecording()
  }, [recording, recordingStarting, stopRecording, startRecording])

  // ── Layout ──
  // Slots werden nicht mehr im Carousel gerendert. Stattdessen liegen alle ChatPanes
  // übereinander (display:none für inaktive). Wechsel zwischen Slots: Tap auf Punkt.
  // InfoPane ist Overlay über dem Chat, nicht zweite Carousel-Page.
  const canEphemeral = slots.length < MAX_SLOTS
  const ephemeralAgent = slots[slots.length - 1]?.agent || 'main'
  const slotsForRender: RenderedSlot[] = canEphemeral
    ? [...slots, { agent: ephemeralAgent, convId: '', ephemeral: true }]
    : slots
  const onWA = false
  const visibleSlotKey = (() => {
    const s = slotsForRender[visibleSlotIndex]
    if (!s) return null
    return s.ephemeral ? 'slot-ephemeral' : `slot-${visibleSlotIndex}`
  })()
  useEffect(() => {
    if (!visibleSlotKey) return
    setWarmedSlotKeys(prev => {
      if (prev.has(visibleSlotKey)) return prev
      const next = new Set(prev)
      next.add(visibleSlotKey)
      return next
    })
  }, [visibleSlotKey])

  // Nach kurzer Inaktivität bleibt nur der sichtbare Slot gemountet. Beim
  // Zurückwechseln lädt der Chat neu, aber im Hintergrund arbeitet nichts weiter.
  useEffect(() => {
    if (!visibleSlotKey) return
    const id = window.setTimeout(() => {
      setWarmedSlotKeys(prev => {
        if (prev.size === 1 && prev.has(visibleSlotKey)) return prev
        return new Set([visibleSlotKey])
      })
    }, MOBILE_SLOT_SLEEP_MS)
    return () => window.clearTimeout(id)
  }, [visibleSlotKey])

  useEffect(() => {
    const closeMobileWorkspace = () => { setMobileWorkspaceMode(null); setMobileWorkspaceReturnMode(null); setMobileWorkspaceFile(null); setMobileFilesystemPath(null) }
    const open = () => { void openDesktopWorkspaceMode('inbox', workspaceModeLabel('inbox')) }
    const toggle = () => { void openDesktopWorkspaceMode('inbox', workspaceModeLabel('inbox')) }
    const toggleFokus = () => { setSearchOpen(false); setPage(0); setHealthOpen(false); setWerkbankOpen(false); setWorkspaceMenuOpen(false); closeMobileWorkspace(); setFokusOpen(o => !o) }
    const toggleHealth = () => { void openDesktopWorkspaceMode('health', workspaceModeLabel('health')) }
    const toggleWerkbank = () => { void openDesktopWorkspaceMode('loops', workspaceModeLabel('loops')) }
    const toggleWorkspaceMenu = () => {
      setSearchOpen(false)
      setPage(0)
      setFokusOpen(false)
      setHealthOpen(false)
      setWerkbankOpen(false)
      closeMobileWorkspace()
      setHtmlPreviewPath(null)
      setWorkspaceMenuOpen(open => !open)
    }
    window.addEventListener('deck:openInfoPane', open)
    window.addEventListener('deck:toggleInfoPane', toggle)
    window.addEventListener('deck:toggleWorkspaceMenu', toggleWorkspaceMenu)
    window.addEventListener('deck:toggleFokus', toggleFokus)
    window.addEventListener('deck:toggleHealth', toggleHealth)
    window.addEventListener('deck:toggleWerkbank', toggleWerkbank)
    return () => {
      window.removeEventListener('deck:openInfoPane', open)
      window.removeEventListener('deck:toggleInfoPane', toggle)
      window.removeEventListener('deck:toggleWorkspaceMenu', toggleWorkspaceMenu)
      window.removeEventListener('deck:toggleFokus', toggleFokus)
      window.removeEventListener('deck:toggleHealth', toggleHealth)
      window.removeEventListener('deck:toggleWerkbank', toggleWerkbank)
    }
  }, [openDesktopWorkspaceMode])

  // Overlay-Status an die Composer melden (Labels und Icon-Farben im Plus-Menü).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:fokusState', { detail: { open: fokusOpen } }))
  }, [fokusOpen])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:healthState', { detail: { open: healthOpen || mobileWorkspaceMode === 'health' } }))
  }, [healthOpen, mobileWorkspaceMode])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('deck:werkbankState', { detail: { open: werkbankOpen || mobileWorkspaceMode === 'tasks' || mobileWorkspaceMode === 'loops' } }))
  }, [werkbankOpen, mobileWorkspaceMode])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {}
      try { sessionStorage.setItem('workspace:loops:draft', JSON.stringify({ ...detail, view: 'werkbank' })) } catch {}
      window.dispatchEvent(new CustomEvent('deck:loopsDraft', { detail: { ...detail, view: 'werkbank' } }))
      setSearchOpen(false)
      setHtmlPreviewPath(null)
      setPage(0)
      setFokusOpen(false)
      setHealthOpen(false)
      setWerkbankOpen(false)
      setMobileWorkspaceMode('loops')
      setMobileWorkspaceReturnMode(null)
      setMobileWorkspaceFile(null)
      setMobileFilesystemPath(null)
      fetch('/api/ui-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'workspace', payload: { action: 'open', mode: 'loops' } }),
      }).catch(() => {})
    }
    window.addEventListener('deck:startBauhof', handler)
    window.addEventListener('deck:startWerkbank', handler)
    return () => {
      window.removeEventListener('deck:startBauhof', handler)
      window.removeEventListener('deck:startWerkbank', handler)
    }
  }, [])

  // Composer meldet seine Höhe via deck:composerHeight — wir cachen für das WA-Overlay.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { height?: number } | undefined
      const h = d?.height
      if (typeof h === 'number' && h > 0) setComposerHeight(prev => Math.abs(prev - h) > 1 ? h : prev)
    }
    window.addEventListener('deck:composerHeight', handler)
    return () => window.removeEventListener('deck:composerHeight', handler)
  }, [])

  // Wenn WA-Overlay geschlossen wird, WA-Send-Target zurücksetzen, damit der
  // Composer wieder an Agent sendet.
  useEffect(() => {
    if (page === 0) {
      window.dispatchEvent(new CustomEvent('deck:waSendTarget', { detail: { chat_id: null } }))
    }
  }, [page])

  useEffect(() => {
    const handler = () => toggleRecording()
    window.addEventListener('deck:toggleRecord', handler)
    return () => window.removeEventListener('deck:toggleRecord', handler)
  }, [toggleRecording])

  useEffect(() => {
    const onCancel = () => cancelRecording()
    const onPause = () => pauseRecording()
    const onResume = () => resumeRecording()
    window.addEventListener('deck:recordCancel', onCancel)
    window.addEventListener('deck:recordPause', onPause)
    window.addEventListener('deck:recordResume', onResume)
    return () => {
      window.removeEventListener('deck:recordCancel', onCancel)
      window.removeEventListener('deck:recordPause', onPause)
      window.removeEventListener('deck:recordResume', onResume)
    }
  }, [cancelRecording, pauseRecording, resumeRecording])

  const sharedWerkbankTasks = useWerkbankTasks()
  const werkbankMenuSignal = (() => {
    let active = 0
    let attention = 0
    for (const task of sharedWerkbankTasks) {
      const status = String(task.status || '')
      if (status === 'done' || status === 'ready' || status === 'canceled' || status === 'cancelled') continue
      if (status === 'failed' || status === 'error' || status === 'needs_input' || status === 'blocked' || status === 'rate_limited') attention += 1
      else active += 1
    }
    return { active, attention }
  })()

  return (
    <div className="mobile-app" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}>
        {/* Chat-Stack: bleibt im DOM, auch wenn InfoPane offen — der Composer (unten in
            ChatPane) muss in beiden Modi sichtbar/aktiv bleiben. Der Hamburger im
            Composer toggelt InfoPane via deck:toggleInfoPane. */}
        <div
          className="mobile-chat-area"
          style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
        >
          {slotsForRender.map((slot, i) => {
            const visible = i === visibleSlotIndex
            const slotKey = slot.ephemeral ? 'slot-ephemeral' : `slot-${i}`
            // Lazy-warm: nicht-besuchte Slots gar nicht mounten (kein WS, keine
            // Timer). Sobald ein Slot einmal sichtbar war, bleibt er im DOM
            // (display:none), damit der nächste Wechsel instant ist.
            const warmed = warmedSlotKeys.has(slotKey)
            if (!visible && !warmed) return null
            return (
              <div
                key={slotKey}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: visible ? undefined : 'none',
                }}
              >
                <ChatPane
                  defaultAgent={slot.agent}
                  conversationId={slot.convId}
                  paneIndex={i}
                  isActive={visible}
                  infoPaneOpen={visible && onWA}
                  onAgentFocus={(a) => { if (!slot.ephemeral) updateSlot(i, { agent: a }) }}
                  onAgentSwitch={(a) => {
                    if (slot.ephemeral) createNewChatInSlot(i, a)
                    else handleAgentSwitchInSlot(i, a)
                  }}
                  onConversationChange={(convId) => {
                    if (!convId) return
                    if (slot.ephemeral) materializeEphemeral(convId, slot.agent)
                    else updateSlot(i, { convId })
                  }}
                  mobile
                  mobileConversations={conversations}
                  mobileArchivedChats={archivedChats}
                  mobileProjects={projects}
                  mobileUnread={unread}
                  mobileBusyConvs={busyConvs}
                  mobileBusyStartedAt={busyStartedAt}
                  onMobileConvChange={(convId, convAgent) => switchConversationInSlot(i, convId, convAgent)}
                  onMobileNewChat={(chatAgent, project) => createNewChatInSlot(i, chatAgent, project)}
                  onMobileRenameChat={renameChat}
                  onMobileArchiveChat={archiveChat}
                  onMobileRestoreChat={restoreChat}
                  onMobileLoadArchive={loadArchivedChats}
                  mobileSlotIndicator={!visible ? null : (
                    <MobileBottomDots
                      slots={slotsForRender}
                      activeSlot={anyMobileModuleOpen ? -1 : visibleSlotIndex}
                      busyConvs={busyConvs}
                      busyStartedAt={busyStartedAt}
                      unread={unread}
                      onSelect={(idx) => {
                        // Overlays schließen, wenn ein Agent-Slot angewählt wird
                        if (page === 1) setPage(0)
                        if (fokusOpen) setFokusOpen(false)
                        if (healthOpen) setHealthOpen(false)
                        if (werkbankOpen) setWerkbankOpen(false)
                        if (mobileWorkspaceMode) {
                          setMobileWorkspaceMode(null)
                          setMobileWorkspaceReturnMode(null)
                          setMobileWorkspaceFile(null)
                          setMobileFilesystemPath(null)
                        }
                        if (workspaceMenuOpen) setWorkspaceMenuOpen(false)
                        const target = slotsForRender[idx]
                        if (target?.convId && conversations.find(c => c.id === target.convId)?.highlight) {
                          fetch(`/api/conversations/${target.convId}/seen`, { method: 'POST' }).catch(() => {})
                          setConversations(prev => prev.map(c => c.id === target.convId ? { ...c, highlight: false } : c))
                        }
                        if (target?.convId) markConversationRead(target.convId)
                        setSlotState(prev => {
                          if (idx < prev.slots.length && idx !== prev.activeSlot) {
                            return persistSlots({ ...prev, activeSlot: idx })
                          }
                          return prev
                        })
                        setEphemeralActive(idx >= slots.length)
                      }}
                      onRemove={removeSlot}
                    />
                  )}
                />
              </div>
            )
          })}
          {/* Mini-Marker: linksbündiger Chat-Titel über der Trennlinie. Tap öffnet
              das Conv-Sheet, der Composer unten bleibt unverändert. */}
          {(() => {
            const activeConv = conversations.find(c => c.id === conversationId)
            return (
              <div
                className="mobile-hero-chrome"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  paddingTop: 'env(safe-area-inset-top, 0px)',
                  background: 'var(--bg)',
                  zIndex: 5,
                }}
              >
                <MobileTopMarker
                  title={activeConv?.title || ''}
                  onTap={() => window.dispatchEvent(new CustomEvent('deck:openConvSheet'))}
                />
              </div>
            )
          })()}
        </div>

        {/* Fokus-Overlay: stoppt über dem Composer, eigener Hero oben, scrollt intern. */}
        {fokusOpen && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: composerHeight,
              zIndex: 20,
              background: 'var(--bg)',
            }}
          >
            <Suspense fallback={null}>
              <MobileFokus embedded />
            </Suspense>
          </div>
        )}

        {healthOpen && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: composerHeight,
              zIndex: 20,
              background: 'var(--bg)',
            }}
          >
            <Suspense fallback={null}>
              <MobileHealth embedded />
            </Suspense>
          </div>
        )}
        {werkbankOpen && (
          <div className="mobile-workbench-overlay" style={{ bottom: composerHeight }}>
            <header className="mobile-workbench-bar">
              <button type="button" onClick={() => setWerkbankOpen(false)} aria-label="Zurück" title="Zurück">
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <strong>Werkbank</strong>
                <span>Aufträge, Läufe, Ergebnisse</span>
              </div>
              <button type="button" onClick={() => setWerkbankOpen(false)} aria-label="Schließen" title="Schließen">
                <X className="h-5 w-5" />
              </button>
            </header>
            <div className="mobile-workbench-body">
              <LoopWorkspace initialView="werkbank" lockedView />
            </div>
          </div>
        )}
        {mobileWorkspaceMode && (
          <MobileWorkspacePanel
            mode={mobileWorkspaceMode}
            file={mobileWorkspaceFile}
            filesystemPath={mobileFilesystemPath}
            returnMode={mobileWorkspaceReturnMode}
            bottom={composerHeight}
            onClose={() => {
              setMobileWorkspaceMode(null)
              setMobileWorkspaceReturnMode(null)
              setMobileWorkspaceFile(null)
              setMobileFilesystemPath(null)
              playUISound('view-back', 0.4)
            }}
            onBack={() => {
              if (mobileWorkspaceReturnMode) {
                setMobileWorkspaceMode(mobileWorkspaceReturnMode)
                setMobileWorkspaceReturnMode(null)
                setMobileWorkspaceFile(null)
                setMobileFilesystemPath(null)
                playUISound('view-back', 0.4)
              } else {
                setMobileWorkspaceMode(null)
              }
            }}
            onOpenFile={(path) => {
              fetch('/api/deck/open-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, source: 'mobile' }),
              }).catch(() => {})
              return openMobileWorkspaceFile(path)
            }}
            onRevealPath={(path) => {
              setMobileWorkspaceReturnMode(mobileWorkspaceMode)
              setMobileWorkspaceFile({ path, kind: workspaceFileKind(path) || 'file' })
              setMobileFilesystemPath(workspaceDirectory(path) || null)
              setMobileWorkspaceMode('filesystem')
            }}
            onOpenMode={openDesktopWorkspaceMode}
          />
        )}
        {htmlPreviewPath && (
          <MobileHtmlViewer path={htmlPreviewPath} onClose={() => { setHtmlPreviewPath(null); playUISound('view-back', 0.4) }} />
        )}
        {workspaceMenuOpen && (
          <MobileWorkspaceMenuPanel
            bottom={0}
            paneIndex={visibleSlotIndex}
            hasUnread={unread.size > 0}
            werkbankSignal={werkbankMenuSignal}
            onClose={() => setWorkspaceMenuOpen(false)}
            onOpenMode={openDesktopWorkspaceMode}
          />
        )}
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <Spotlight onClose={() => setSearchOpen(false)} mobile />
        </Suspense>
      )}
    </div>
  )
}
