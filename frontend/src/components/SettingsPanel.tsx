import { useState, useEffect } from 'react'
import { Check, ChevronRight, Code2, EyeOff, Gauge, Layers, MessageSquare, Mic, Moon, Rabbit, Radio, ScrollText, Sparkles, Sun, Terminal, Turtle, Type, Volume2, Wrench, Zap } from 'lucide-react'
import * as audioQueue from '../audioQueue'
import { setPref } from '../prefs'
import { getThemeMode, setThemeMode, type ThemeMode } from '../theme'
import { getDefaultEngine, getEngineLabel, type Engine } from '../agents'
import { Guided } from './info-pane/utils/tree'
import { playUISound } from '../uiSounds'

interface VoiceSettings {
  stability: number
  similarity_boost: number
  style: number
}

interface Voice {
  id: string
  name: string
  isDefault?: boolean
  settings?: VoiceSettings
  provider?: string
}

const DEFAULT_FALLBACK: VoiceSettings = { stability: 0.45, similarity_boost: 0.8, style: 0.15 }

function readGlobalVoice(): string {
  return localStorage.getItem('control:voice')
    || localStorage.getItem('control:voice:agent')
    || localStorage.getItem('control:voice:main')
    || ''
}

function readGlobalAutoplay(): boolean {
  const g = localStorage.getItem('control:autoplay')
  if (g !== null) return g === 'true'
  return localStorage.getItem('control:autoplay:agent') === 'true'
    || localStorage.getItem('control:autoplay:main') === 'true'
}

function readResponseMode(): 'live' | 'calm' | 'final' {
  const raw = localStorage.getItem('control:responseMode')
  return raw === 'live' || raw === 'final' ? raw : 'calm'
}

function readRevealStyle(): 'cursor' | 'soft' {
  return localStorage.getItem('control:revealStyle') === 'soft' ? 'soft' : 'cursor'
}

function readVerbosity(): 'result' | 'brief' | 'full' {
  const v = localStorage.getItem('control:verbosity')
  return v === 'result' || v === 'full' ? v : 'brief'
}

function loadUserSettings(voiceId: string): VoiceSettings | null {
  try {
    const raw = localStorage.getItem(`control:voiceSettings:${voiceId}`)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<VoiceSettings>
    return {
      stability: typeof p.stability === 'number' ? p.stability : DEFAULT_FALLBACK.stability,
      similarity_boost: typeof p.similarity_boost === 'number' ? p.similarity_boost : DEFAULT_FALLBACK.similarity_boost,
      style: typeof p.style === 'number' ? p.style : DEFAULT_FALLBACK.style,
    }
  } catch { return null }
}

interface Props {
  agent: string
  mobile?: boolean
  variant?: 'list' | 'cards'
}

// ── Sub-section inside "Einstellungen": indented one level deeper ──
function Section({ label, icon, defaultOpen, children, mobile, level: _level = 1, variant = 'list', tone }: {
  label: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode; mobile?: boolean; level?: number; variant?: 'list' | 'cards'; tone?: string
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  if (variant === 'cards') {
    return (
      <section className={`settings-grp ${tone ? `settings-grp-${tone}` : ''} ${open ? 'is-open' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open', 0.4); return !v })}
          className="settings-grp-head"
        >
          <span className="settings-grp-icon">{icon}</span>
          <span className="settings-grp-title">{label}</span>
          <ChevronRight className={`settings-grp-chev ${open ? 'is-open' : ''}`} />
        </button>
        {open && <div className="settings-grp-body">{children}</div>}
      </section>
    )
  }
  return (
    <div>
      <button
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open', 0.4); return !v })}
        className={`w-full flex items-center pl-1 pr-3 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className="info-icon-md mr-2 flex items-center justify-center text-[var(--t3)] flex-shrink-0">{icon}</span>
        <span className="text-[var(--t2)] flex-1">{label}</span>
      </button>
      {open && (
        <Guided>{children}</Guided>
      )}
    </div>
  )
}

// ── Building blocks shared by all sections ──
function OptionRow({ label, active, onClick, mobile, icon, activeLabel, level: _level = 2, note, variant = 'list' }: {
  label: string; active: boolean; onClick: () => void; mobile?: boolean
  icon: React.ReactNode
  activeLabel?: string
  level?: number
  note?: string
  variant?: 'list' | 'cards'
}) {
  if (variant === 'cards') {
    return (
      <button onClick={onClick} className={`settings-row ${active ? 'is-active' : ''}`}>
        <span className="settings-row-icon">{icon}</span>
        <span className="settings-row-main">
          <strong>{label}</strong>
          {note && <em>{note}</em>}
        </span>
        {active && <Check className="settings-row-check" />}
      </button>
    )
  }
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 pl-1 pr-3 ${mobile ? 'py-2' : 'py-[5px]'} text-left cursor-pointer hover:bg-white/[0.06] transition-colors info-text-body ${active ? 'text-[var(--t1)]' : 'text-[var(--t3)]'}`}
    >
      <span className="info-icon-md mr-2 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {note && <span className="block text-[13px] text-[var(--t3)]/70">{note}</span>}
      </span>
      {active && (
        activeLabel
          ? <span className="text-[13px] uppercase tracking-wide text-[var(--t3)]">{activeLabel}</span>
          : <Check className="w-3.5 h-3.5 opacity-60" />
      )}
    </button>
  )
}

// ── Engine-Logos (offizielle Marken-Pfade, monochrom via currentColor) ──
function ClaudeCodeLogo() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true">
      <path d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
    </svg>
  )
}

function CodexLogo() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" fillRule="evenodd" clipRule="evenodd" aria-hidden="true">
      <path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" />
    </svg>
  )
}

function ToggleRow({ label, icon, on, onClick, mobile, level: _level = 2, variant = 'list' }: {
  label: string; icon: React.ReactNode; on: boolean; onClick: () => void; mobile?: boolean; level?: number
  variant?: 'list' | 'cards'
}) {
  if (variant === 'cards') {
    return (
      <button onClick={onClick} className={`settings-row ${on ? 'is-active' : ''}`}>
        <span className="settings-row-icon">{icon}</span>
        <span className="settings-row-main"><strong>{label}</strong></span>
        <Switch on={on} mobile={mobile} />
      </button>
    )
  }
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center pl-1 pr-3 ${mobile ? 'py-2' : 'py-[5px]'} text-left cursor-pointer hover:bg-white/[0.06] transition-colors info-text-body text-[var(--t2)]`}
    >
      <span className="info-icon-md mr-2 flex items-center justify-center flex-shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      <Switch on={on} mobile={mobile} />
    </button>
  )
}

function Switch({ on, mobile }: { on: boolean; mobile?: boolean }) {
  return (
    <span className={`relative ${mobile ? 'w-9 h-5' : 'w-8 h-4'} rounded-full transition-colors flex-shrink-0 ${on ? 'bg-[var(--switch-track-on)]' : 'bg-[var(--bg-3)]'}`}>
      <span className={`absolute top-0.5 rounded-full transition-all ${
        on ? 'bg-[var(--switch-thumb-on)]' : 'bg-[var(--switch-thumb-off)]'
      } ${
        mobile ? `w-4 h-4 ${on ? 'left-[18px]' : 'left-0.5'}` : `w-3 h-3 ${on ? 'left-[18px]' : 'left-0.5'}`
      }`} />
    </span>
  )
}

function SliderRow({ label, icon, value, display, min, max, step, onChange, mobile, onCommit, level: _level = 2, variant = 'list' }: {
  label: string; value: number; display: string
  icon: React.ReactNode
  min: number; max: number; step: number
  onChange: (v: number) => void
  onCommit?: () => void
  mobile?: boolean
  level?: number
  variant?: 'list' | 'cards'
}) {
  if (variant === 'cards') {
    return (
      <div className="settings-row settings-row-slider">
        <span className="settings-row-icon">{icon}</span>
        <span className="settings-row-main">
          <strong>{label}</strong>
          <em>{display}</em>
        </span>
        <input
          type="range" min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          onMouseUp={onCommit}
          onTouchEnd={onCommit}
          className="settings-row-range"
        />
      </div>
    )
  }
  return (
    <div className={`${mobile ? 'py-2' : 'py-[5px]'} pl-1 pr-3`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[var(--t2)] info-text-body flex items-center min-w-0">
          <span className="info-icon-md mr-2 flex items-center justify-center flex-shrink-0">{icon}</span>
          <span className="truncate">{label}</span>
        </span>
        <span className="text-[var(--t3)] text-[14px] tabular-nums">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        className="w-full accent-[var(--slider-accent)] cursor-pointer"
      />
    </div>
  )
}

// ── Main ──
export function SettingsPanel({ agent, mobile, variant = 'list' }: Props) {
  const [voices, setVoices] = useState<Voice[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(() => readGlobalVoice())
  const [rate, setRate] = useState(() => audioQueue.getState().playbackRate)
  const [userSettings, setUserSettings] = useState<Record<string, VoiceSettings>>({})
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode())
  const [autoplay, setAutoplay] = useState<boolean>(() => readGlobalAutoplay())
  const [responseMode, setResponseMode] = useState<'live' | 'calm' | 'final'>(() => readResponseMode())
  const [typewriter, setTypewriter] = useState<boolean>(() => (localStorage.getItem('control:typewriter') ?? 'false') === 'true')
  const [typewriterSpeed, setTypewriterSpeed] = useState<number>(() => {
    const raw = localStorage.getItem('control:typewriterSpeed')
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) && n >= 4 ? n : 18
  })
  const [speedAdvanced, setSpeedAdvanced] = useState<boolean>(() =>
    (localStorage.getItem('control:typewriterAdvanced') ?? 'false') === 'true'
  )
  const [revealStyle, setRevealStyle] = useState<'cursor' | 'soft'>(() => readRevealStyle())
  const [smartBlocks, setSmartBlocks] = useState<boolean>(() => (localStorage.getItem('control:smartBlocks') ?? 'false') === 'true')
  const [verbosity, setVerbosity] = useState<'result' | 'brief' | 'full'>(() => readVerbosity())
  const [toolMode, setToolMode] = useState<'open' | 'quiet' | 'silent'>(() => {
    const raw = localStorage.getItem('control:toolMode')
    if (raw === 'open' || raw === 'silent' || raw === 'quiet') return raw
    const legacy = localStorage.getItem('control:quietTools')
    if (legacy === 'false') return 'open'
    return 'quiet'
  })
  const [engineDefault, setEngineDefault] = useState<Engine>(() => getDefaultEngine())

  useEffect(() => {
    fetch('/api/voices').then(r => r.json()).then(d => {
      const vs: Voice[] = d.voices || []
      setVoices(vs)
      const loaded: Record<string, VoiceSettings> = {}
      for (const v of vs) {
        const u = loadUserSettings(v.id)
        if (u) loaded[v.id] = u
      }
      setUserSettings(loaded)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => audioQueue.subscribe(s => setRate(s.playbackRate)), [])

  useEffect(() => {
    setSelected(readGlobalVoice())
    setAutoplay(readGlobalAutoplay())
  }, [agent])

  // Live-Sync: anderes Gerät hat Settings geändert → States aus localStorage neu lesen.
  useEffect(() => {
    const onRemote = () => {
      setSelected(readGlobalVoice())
      setAutoplay(readGlobalAutoplay())
      setTheme(getThemeMode())
      setEngineDefault(getDefaultEngine())
      setResponseMode(readResponseMode())
      setTypewriter((localStorage.getItem('control:typewriter') ?? 'false') === 'true')
      const rawSpeed = localStorage.getItem('control:typewriterSpeed')
      const ns = rawSpeed ? parseInt(rawSpeed, 10) : NaN
      setTypewriterSpeed(Number.isFinite(ns) && ns >= 4 ? ns : 18)
      setRevealStyle(readRevealStyle())
      setSmartBlocks((localStorage.getItem('control:smartBlocks') ?? 'false') === 'true')
      setVerbosity(readVerbosity())
      const tm = localStorage.getItem('control:toolMode')
      setToolMode(tm === 'open' || tm === 'silent' || tm === 'quiet' ? tm : 'quiet')
    }
    window.addEventListener('deck:prefsRemoteUpdate', onRemote)
    return () => window.removeEventListener('deck:prefsRemoteUpdate', onRemote)
  }, [])

  const effectiveSettings = (v: Voice): VoiceSettings =>
    userSettings[v.id] || v.settings || DEFAULT_FALLBACK

  const pickVoice = (id: string) => {
    setSelected(id)
    setPref('control:voice', id || null)
    window.dispatchEvent(new CustomEvent('voice-changed', { detail: { voiceId: id } }))
  }

  const previewVoice = (v: Voice) => {
    const sample = `Hallo, ich bin ${v.name}. So klingt meine Stimme.`
    audioQueue.playNow({
      text: sample,
      agentName: agent,
      ts: Date.now() / 1000,
      conversationId: '',
      voiceId: v.id,
      voiceSettings: effectiveSettings(v),
    })
  }

  const toggleAutoplay = () => {
    const next = !autoplay
    setAutoplay(next)
    setPref('control:autoplay', String(next))
    window.dispatchEvent(new CustomEvent('deck:autoplayChanged', { detail: { enabled: next, agent } }))
  }


  return (
    <div className={variant === 'cards' ? 'settings-panel-cards' : undefined}>
      {/* ── UI-Theme ── */}
      <Section label="UI-Theme" icon={<Sun className="info-icon-md" />} mobile={mobile} variant={variant} tone="theme">
        {(['light', 'dark'] as const).map(mode => (
          <OptionRow
            key={mode}
            label={mode === 'light' ? 'Hell' : 'Dunkel'}
            active={theme === mode}
            activeLabel={theme === mode ? 'Aktiv' : undefined}
            icon={mode === 'light' ? <Sun className="info-icon-md" /> : <Moon className="info-icon-md" />}
            onClick={() => { playUISound('option-pick', 0.4); setTheme(mode); setThemeMode(mode) }}
            mobile={mobile}
            variant={variant}
          />
        ))}
      </Section>

      {/* ── Engine ── */}
      <Section label="Engine" icon={<Code2 className="info-icon-md" />} mobile={mobile} variant={variant} tone="engine">
        {(['claude', 'codex'] as const).map(e => (
          <OptionRow
            key={e}
            label={getEngineLabel(e)}
            active={engineDefault === e}
            activeLabel="Default"
            icon={e === 'claude' ? <ClaudeCodeLogo /> : <CodexLogo />}
            onClick={() => {
              playUISound('option-pick', 0.4)
              setEngineDefault(e)
              setPref('control:engine:default', e)
              window.dispatchEvent(new CustomEvent('deck:engineDefaultChanged', { detail: { engine: e } }))
            }}
            mobile={mobile}
            variant={variant}
          />
        ))}
      </Section>

      {/* ── Stimmen ── */}
      <Section label="Stimmen" icon={<Mic className="info-icon-md" />} mobile={mobile} variant={variant} tone="voices">
        {loading && <div className="info-text-body text-[var(--t3)] py-1 pl-1">Lade Stimmen…</div>}
        {!loading && voices.length === 0 && (
          <div className="info-text-body text-[var(--t3)] py-1 pl-1">Keine Stimmen verfügbar.</div>
        )}
        {!loading && voices.map(v => {
          const isActive = selected === v.id || (selected === '' && !!v.isDefault)
          return (
            <div key={v.id} className={variant === 'cards' ? `settings-row ${isActive ? 'is-active' : ''}` : ''}>
              <div className={variant === 'cards' ? 'flex min-w-0 flex-1 items-center gap-3' : 'group flex items-center hover:bg-white/[0.06] transition-colors rounded'}>
                <button
                  onClick={() => { playUISound('option-pick', 0.4); pickVoice(v.isDefault ? '' : v.id) }}
                  className={variant === 'cards'
                    ? 'flex min-w-0 flex-1 items-center gap-3 text-left'
                    : `flex-1 flex items-center pl-1 pr-2 ${mobile ? 'py-2' : 'py-[5px]'} text-left cursor-pointer info-text-body ${isActive ? 'text-[var(--t1)]' : 'text-[var(--t3)]'}`}
                >
                  <Mic className={variant === 'cards' ? 'settings-row-icon' : 'info-icon-md mr-2 flex-shrink-0'} />
                  <span className={variant === 'cards' ? 'settings-row-main' : 'flex-1 truncate flex items-center gap-1.5'}>
                    {variant === 'cards' ? <strong>{v.name}</strong> : v.name}
                  </span>
                  {isActive && (variant === 'cards' ? <Check className="settings-row-check" /> : <Check className="w-3.5 h-3.5 opacity-60" />)}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); previewVoice(v) }}
                  className={variant === 'cards' ? 'settings-row-play' : `${mobile ? 'px-3 py-2' : 'px-2 py-1.5'} text-[var(--t3)]/60 hover:text-[var(--t1)] transition-colors cursor-pointer`}
                  title="Vorhören"
                >
                  <Volume2 className="info-icon-sm" />
                </button>
              </div>
            </div>
          )
        })}
      </Section>

      {/* ── Sprachverhalten ── */}
      <Section label="Sprachverhalten" icon={<Volume2 className="info-icon-md" />} mobile={mobile} variant={variant} tone="voice">
        <ToggleRow label="Autoplay" icon={<Radio className="info-icon-md" />} on={autoplay} onClick={() => { playUISound('option-pick', 0.4); toggleAutoplay() }} mobile={mobile} variant={variant} />
        {/* Agent liest beim Autoplay nur die finale Antwort vor, nie den Arbeitsweg. */}
        <SliderRow
          label="Tempo"
          icon={<Gauge className="info-icon-md" />}
          value={rate}
          display={`${rate.toFixed(2)}×`}
          min={0.75} max={2} step={0.05}
          onChange={audioQueue.setPlaybackRate}
          mobile={mobile}
          variant={variant}
        />
      </Section>

      {/* ── Was du siehst ── (koppelt Arbeitsweg-Inhalt + Antwortmodus-Rendering) */}
      <Section label="Was du siehst" icon={<ScrollText className="info-icon-md" />} mobile={mobile} variant={variant} tone="tools">
        {(() => {
          // Eine Inhalts-Achse statt zweier Regler: jede Stufe setzt zugleich, wie
          // viel Agent schreibt (verbosity) und wie es erscheint (responseMode).
          const visibility: 'result' | 'calm' | 'open' =
            verbosity === 'result' ? 'result' : responseMode === 'calm' ? 'calm' : 'open'
          const setVisibility = (next: 'result' | 'calm' | 'open') => {
            playUISound('option-pick', 0.4)
            const map = {
              result: { v: 'result', r: 'final' },
              calm: { v: 'full', r: 'calm' },
              open: { v: 'full', r: 'live' },
            } as const
            const { v, r } = map[next]
            setVerbosity(v); setPref('control:verbosity', v)
            setResponseMode(r); setPref('control:responseMode', r)
            window.dispatchEvent(new CustomEvent('deck:chatStyleChanged'))
          }
          return ([
            ['result', 'Nur Ergebnis', 'Kein Arbeitsweg, erst die fertige Antwort', <EyeOff className="info-icon-md" />],
            ['calm', 'Ergebnis mit Weg', 'Arbeitsweg ausgegraut, Ergebnis hervorgehoben', <Layers className="info-icon-md" />],
            ['open', 'Alles offen', 'Kompletter Arbeitsweg live mit', <ScrollText className="info-icon-md" />],
          ] as const).map(([val, label, hint, icon]) => (
            <OptionRow
              key={val}
              label={label}
              note={hint}
              active={visibility === val}
              activeLabel={visibility === val ? 'Aktiv' : undefined}
              icon={icon}
              onClick={() => setVisibility(val)}
              mobile={mobile}
              variant={variant}
            />
          ))
        })()}
      </Section>

      {/* ── Darstellung ── */}
      <Section label="Darstellung" icon={<Type className="info-icon-md" />} mobile={mobile} variant={variant} tone="tools">
        {(() => {
          const flow: 'cursor' | 'soft' | 'instant' = !typewriter ? 'instant' : revealStyle === 'soft' ? 'soft' : 'cursor'
          const setFlow = (next: 'cursor' | 'soft' | 'instant') => {
            playUISound('option-pick', 0.4)
            if (next === 'instant') {
              setTypewriter(false); setPref('control:typewriter', 'false')
            } else {
              setTypewriter(true); setPref('control:typewriter', 'true')
              setRevealStyle(next); setPref('control:revealStyle', next)
            }
            window.dispatchEvent(new CustomEvent('deck:chatStyleChanged'))
          }
          return ([
            ['cursor', 'Tippen', 'Zeichen für Zeichen, mit Cursor', <Type className="info-icon-md" />],
            ['soft', 'Sanft', 'Wörter blenden weich ein, Apple-Look', <Sparkles className="info-icon-md" />],
            ['instant', 'Sofort', 'Antwort steht direkt komplett da', <Zap className="info-icon-md" />],
          ] as const).map(([val, label, hint, icon]) => (
            <OptionRow
              key={val}
              label={label}
              note={hint}
              active={flow === val}
              activeLabel={flow === val ? 'Aktiv' : undefined}
              icon={icon}
              onClick={() => setFlow(val)}
              mobile={mobile}
              variant={variant}
            />
          ))
        })()}
      </Section>

      {/* ── Tempo ── */}
      {typewriter && (
        <Section label="Tempo" icon={<Gauge className="info-icon-md" />} mobile={mobile} variant={variant} tone="tools">
          {(['ruhig', 'normal', 'schnell'] as const).map((key) => {
            const map = { ruhig: [8, 'Ruhig', <Turtle className="info-icon-md" />], normal: [18, 'Normal', <Gauge className="info-icon-md" />], schnell: [40, 'Schnell', <Rabbit className="info-icon-md" />] } as const
            const [val, label, icon] = map[key]
            return (
              <OptionRow
                key={key}
                label={label}
                icon={icon}
                active={typewriterSpeed === val && !speedAdvanced}
                activeLabel={typewriterSpeed === val && !speedAdvanced ? 'Aktiv' : undefined}
                onClick={() => {
                  playUISound('option-pick', 0.4)
                  setTypewriterSpeed(val)
                  setSpeedAdvanced(false)
                  setPref('control:typewriterSpeed', String(val))
                  setPref('control:typewriterAdvanced', 'false')
                  window.dispatchEvent(new CustomEvent('deck:chatStyleChanged'))
                }}
                mobile={mobile}
                variant={variant}
              />
            )
          })}
          <ToggleRow
            label="Eigenes Tempo"
            icon={<Gauge className="info-icon-md" />}
            on={speedAdvanced}
            onClick={() => {
              playUISound('option-pick', 0.4)
              const next = !speedAdvanced
              setSpeedAdvanced(next)
              setPref('control:typewriterAdvanced', String(next))
            }}
            mobile={mobile}
            variant={variant}
          />
          {speedAdvanced && (
            <SliderRow
              label="Zeichen pro Sekunde"
              icon={<Gauge className="info-icon-md" />}
              value={typewriterSpeed}
              display={
                typewriterSpeed <= 20 ? `${typewriterSpeed} · sehr ruhig`
                : typewriterSpeed >= 300 ? `${typewriterSpeed} · sofort`
                : `${typewriterSpeed} Z/s`
              }
              min={4} max={400} step={2}
              onChange={v => {
                setTypewriterSpeed(v)
                setPref('control:typewriterSpeed', String(v))
                window.dispatchEvent(new CustomEvent('deck:chatStyleChanged'))
              }}
              mobile={mobile}
              variant={variant}
            />
          )}
        </Section>
      )}

      {/* ── Saubere Blöcke ── */}
      <Section label="Saubere Blöcke" icon={<Code2 className="info-icon-md" />} mobile={mobile} variant={variant} tone="tools">
        <ToggleRow
          label="Code und Tabellen am Stück"
          icon={<Code2 className="info-icon-md" />}
          on={smartBlocks}
          onClick={() => {
            playUISound('option-pick', 0.4)
            const next = !smartBlocks
            setSmartBlocks(next)
            setPref('control:smartBlocks', String(next))
            window.dispatchEvent(new CustomEvent('deck:chatStyleChanged'))
          }}
          mobile={mobile}
          variant={variant}
        />
      </Section>

      {/* ── Tool-Anzeige ── */}
      <Section label="Tool-Anzeige" icon={<Wrench className="info-icon-md" />} mobile={mobile} variant={variant} tone="tools">
        {([
          ['quiet', 'Einfach', 'Laienansicht, nur das Nötige'],
          ['open', 'Roh', 'Alles offen, inklusive Output'],
          ['silent', 'Aus', 'Keine Tool-Zeilen im Chat'],
        ] as const).map(([val, label, hint]) => (
          <OptionRow
            key={val}
            label={label}
            note={hint}
            active={toolMode === val}
            activeLabel={toolMode === val ? 'Aktiv' : undefined}
            icon={val === 'quiet' ? <MessageSquare className="info-icon-md" /> : val === 'open' ? <Terminal className="info-icon-md" /> : <EyeOff className="info-icon-md" />}
            onClick={() => {
              playUISound('option-pick', 0.4)
              setToolMode(val)
              setPref('control:toolMode', val)
              window.dispatchEvent(new CustomEvent('deck:chatStyleChanged'))
            }}
            mobile={mobile}
            variant={variant}
          />
        ))}
      </Section>

    </div>
  )
}
