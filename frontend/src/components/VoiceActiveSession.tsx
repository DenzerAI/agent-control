import { useEffect, useRef, useState, useCallback } from 'react'
import { ConversationProvider, useConversation, useConversationClientTool } from '@elevenlabs/react'
import { getOpenArtifact } from '../workspace/openArtifactStore'
import { fixUmlauts } from '../umlauts'
import { playUISound } from '../uiSounds'
import type { VoiceState } from './voiceState'

// VoiceController — headless. Exponiert Voice-Zustand via Context für Composer
// und andere UI-Teile. Keine eigene Darstellung. Composer animiert sein Mic-Icon
// und seinen Rand basierend auf dem hier exponierten State.

interface Props {
  onClose: () => void
  onReconnect: () => void
  setState: (updater: (prev: VoiceState) => VoiceState) => void
}

const KLAUS_VOICE_OUTPUT_GAIN = 1.2

type ElevenLabsRawConversation = {
  setVolume?: (options: { volume: number }) => void
  volume?: number
  output?: { setVolume?: (volume: number) => void }
}

async function persistMessage(role: 'user' | 'agent', content: string) {
  try {
    await fetch('/api/voice/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content }),
    })
  } catch {
    // Silent
  }
}

// Voice-Forensik: jedes relevante Event landet serverseitig als JSONL.
// sendBeacon ist bevorzugt weil es auch beim unload/pagehide noch durchgeht.
function logVoiceEvent(event: string, extra?: Record<string, unknown>) {
  try {
    const payload = JSON.stringify({ event, ...extra })
    const url = '/api/voice/log'
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' })
      const ok = navigator.sendBeacon(url, blob)
      if (ok) return
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Silent
  }
}

function setConversationOutputGain(raw: unknown, paused: boolean) {
  const conversation = raw as ElevenLabsRawConversation | null
  if (!conversation) return
  const gain = paused ? 0 : KLAUS_VOICE_OUTPUT_GAIN
  try {
    if (paused) {
      conversation.setVolume?.({ volume: 0 })
    } else {
      // Public API clampelt bei 1.0; der interne Output-Gain kann sauber höher.
      conversation.setVolume?.({ volume: 1 })
      conversation.output?.setVolume?.(gain)
      if (typeof conversation.volume === 'number') conversation.volume = gain
    }
  } catch {
    // Silent
  }
}

export default function VoiceActiveSession({ onClose, onReconnect, setState }: Props) {
  return (
    <ConversationProvider>
      <ActiveSession onClose={onClose} onReconnect={onReconnect} setState={setState} />
    </ConversationProvider>
  )
}

async function toolGet(url: string): Promise<string> {
  try {
    const r = await fetch(url)
    const t = await r.text()
    return t.slice(0, 6000)
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : 'fetch failed' })
  }
}

async function toolPost(url: string, body: unknown): Promise<string> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const t = await r.text()
    return t.slice(0, 2000)
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : 'fetch failed' })
  }
}

function ActiveSession({ onClose, onReconnect, setState }: {
  onClose: () => void
  onReconnect: () => void
  setState: (updater: (prev: VoiceState) => VoiceState) => void
}) {
  const startedRef = useRef(false)
  // Hidden-Tracking: iOS killt die Session wenn die Seite in den Hintergrund geht.
  // Wenn Disconnect kurz nach einem Hidden/Pagehide kommt, war's nicht absichtlich
  // → Auto-Reconnect triggern statt Session komplett zu schließen.
  const lastHiddenAtRef = useRef<number>(0)
  const reconnectAttemptsRef = useRef(0)
  // Für Disconnect-Forensik: wie lange lief die Session vor dem Abbruch?
  const connectTimeRef = useRef<number>(0)
  const rawConversationRef = useRef<unknown>(null)

  // Tool-Wrapper — setzt isThinking für die UI während Tool-Call läuft.
  // Das ist der Ersatz für verbales "Moment" / "Ich schau kurz nach".
  // Ref statt direkter Abhängigkeit damit der Wrapper stabil bleibt.
  const thinkingCountRef = useRef(0)
  const wrapTool = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    thinkingCountRef.current += 1
    setState(s => ({ ...s, isThinking: true }))
    return fn().finally(() => {
      thinkingCountRef.current = Math.max(0, thinkingCountRef.current - 1)
      if (thinkingCountRef.current === 0) {
        setState(s => ({ ...s, isThinking: false }))
      }
    })
  }, [setState])

  // ── Client-Tools für Agent ──
  // Müssen Namen-gleich zu _VOICE_TOOL_DEFS im Backend sein.
  useConversationClientTool('list_briefings', async () => wrapTool(() => toolGet('/api/voice/tool/briefings')))
  useConversationClientTool('read_briefing', async (params) => {
    const name = String((params as Record<string, unknown>).name || '')
    return wrapTool(() => toolGet(`/api/voice/tool/briefing?name=${encodeURIComponent(name)}`))
  })
  useConversationClientTool('get_chat_context', async (params) => {
    const limit = Number((params as Record<string, unknown>).limit ?? 10)
    return wrapTool(() => toolGet(`/api/voice/tool/chat-context?limit=${limit}`))
  })
  useConversationClientTool('list_brain_files', async () => wrapTool(() => toolGet('/api/voice/tool/brain-index')))
  useConversationClientTool('read_brain', async (params) => {
    const path = String((params as Record<string, unknown>).path || '')
    return wrapTool(() => toolGet(`/api/voice/tool/brain-file?path=${encodeURIComponent(path)}`))
  })
  useConversationClientTool('send_to_chat', async (params) => {
    const p = params as Record<string, unknown>
    return wrapTool(() => toolPost('/api/voice/tool/send-chat', {
      agent: String(p.agent || ''),
      message: String(p.message || ''),
    }))
  })
  // Text gezielt in eine sichtbare Chat-Pane 1..4 schreiben (egal welcher Agent
  // dort läuft). Nutzt denselben Pane-Input-Weg wie der Remote/PTT-Client.
  useConversationClientTool('send_to_pane', async (params) => {
    const p = params as Record<string, unknown>
    return wrapTool(() => toolPost('/api/voice/tool/send-pane', {
      pane_index: Number(p.pane_index) || 0,
      message: String(p.message || ''),
    }))
  })
  // Neu: Brain-Volltextsuche
  useConversationClientTool('search_brain', async (params) => {
    const q = String((params as Record<string, unknown>).query || '').trim()
    if (!q) return JSON.stringify({ error: 'empty query' })
    return wrapTool(() => toolGet(`/api/voice/tool/brain-search?q=${encodeURIComponent(q)}`))
  })
  // Neu: Cron-Trigger für Briefings
  useConversationClientTool('run_briefing', async (params) => {
    const name = String((params as Record<string, unknown>).name || '')
    return wrapTool(() => toolPost('/api/voice/tool/run-briefing', { name }))
  })
  // Neu: komplettes UI-State (alle offenen Panes + Chats)
  useConversationClientTool('get_ui_state', async () => wrapTool(() => toolGet('/api/voice/tool/ui-state')))
  useConversationClientTool('get_open_artifact', async () => wrapTool(async () => {
    const p = getOpenArtifact()
    if (!p) return JSON.stringify({ open: false, note: 'Gerade ist keine Seite im Workspace offen.' })
    const mdPath = p.replace(/\.html?$/i, '.md')
    const grab = async (path: string): Promise<string> => {
      try {
        const raw = await toolGet(`/api/file?path=${encodeURIComponent(path)}`)
        const j = JSON.parse(raw)
        return typeof j.content === 'string' ? j.content : ''
      } catch { return '' }
    }
    let content = await grab(mdPath)
    if (!content && /\.html?$/i.test(p)) {
      const html = await grab(p)
      content = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    return JSON.stringify({ open: true, path: p, content: content.slice(0, 5000) })
  }))
  // Neu: Web-Lookup (Wetter, Krypto)
  useConversationClientTool('web_lookup', async (params) => {
    const p = params as Record<string, unknown>
    const topic = String(p.topic || '').trim()
    const query = String(p.query || '').trim()
    const qs = new URLSearchParams({ topic, ...(query ? { q: query } : {}) })
    return wrapTool(() => toolGet(`/api/voice/tool/web?${qs.toString()}`))
  })
  // Neu: Live-Read-Tools (Fokus, Health, Limits) — read-only aus dem System
  useConversationClientTool('get_focus', async () => wrapTool(() => toolGet('/api/voice/tool/focus')))
  useConversationClientTool('get_health', async () => wrapTool(() => toolGet('/api/voice/tool/health')))
  useConversationClientTool('get_limits', async () => wrapTool(() => toolGet('/api/voice/tool/limits')))
  // ── Layout-Kommandos ──
  // Pure Client-Tools: kein Backend-Roundtrip, dispatchen direkt window-Events
  // die App.tsx und InfoPane.tsx hören. Bestätigung nur kurz, kein Geschwätz.
  const dispatch = (name: string, detail?: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  }
  useConversationClientTool('toggle_info_pane', async (params) => {
    const action = String((params as Record<string, unknown>).action || 'toggle').trim().toLowerCase()
    const norm = action === 'open' || action === 'close' || action === 'toggle' ? action : 'toggle'
    dispatch('deck:info', { action: norm })
    return JSON.stringify({ ok: true, action: norm })
  })
  useConversationClientTool('add_chat_pane', async () => {
    dispatch('deck:pane', { action: 'add' })
    return JSON.stringify({ ok: true })
  })
  useConversationClientTool('close_chat_pane', async (params) => {
    const p = params as Record<string, unknown>
    const idxRaw = p.pane_index
    const idx = idxRaw === undefined || idxRaw === null || idxRaw === '' ? null : Number(idxRaw)
    if (idx !== null && Number.isFinite(idx) && idx > 0) {
      dispatch('deck:pane', { action: 'close-index', index: idx })
      return JSON.stringify({ ok: true, closed: idx })
    }
    dispatch('deck:pane', { action: 'close-last' })
    return JSON.stringify({ ok: true, closed: 'last' })
  })
  useConversationClientTool('only_active_chat', async () => {
    dispatch('deck:pane', { action: 'only-active' })
    return JSON.stringify({ ok: true })
  })
  useConversationClientTool('open_info_section', async (params) => {
    const allowed = ['workspace', 'identity', 'jobs', 'whatsapp', 'mail', 'artifacts', 'social', 'daily-log', 'settings']
    const raw = String((params as Record<string, unknown>).section || '').trim().toLowerCase().replace(/[_ ]+/g, '-')
    if (!allowed.includes(raw)) {
      return JSON.stringify({ ok: false, error: 'unknown section', allowed })
    }
    dispatch('deck:info-section', { section: raw })
    return JSON.stringify({ ok: true, section: raw })
  })

  // PTT-Mute: Wenn Christian die rechte Command-Taste drückt, diktiert er ins
  // Chat-Feld (system-level). Agent darf in dem Moment NICHT zuhören, sonst
  // kommt er sich mit der PTT-Transkription ins Gehege.
  const [pttMuted, setPttMuted] = useState(false)
  // Ext-Mute: Mobile Aufnahme (MobileApp.tsx feuert `deck:recordingState`).
  // Solange die mobile Diktier-Aufnahme läuft, hört Agent nicht zu.
  const [extMuted, setExtMuted] = useState(false)
  // Manuelle Pause: Christian tippt auf den Orb. Mikro aus UND Agent verstummt
  // (Output-Volume 0), aber die Session bleibt offen — er kann nahtlos weiter.
  const [manualPaused, setManualPaused] = useState(false)

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      // `code === 'MetaRight'` ist die rechte Cmd-Taste (macOS) bzw. Right-Windows.
      // repeat filtern — sonst setzen wir bei key-repeat mehrfach.
      if (e.code === 'MetaRight' && !e.repeat) {
        setPttMuted(true)
        logVoiceEvent('ptt_mute', { pressed: true })
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'MetaRight') {
        setPttMuted(false)
        logVoiceEvent('ptt_mute', { pressed: false })
      }
    }
    // Fallback: wenn das Fenster den Fokus verliert während Taste noch gedrückt,
    // würden wir sonst dauerhaft stumm bleiben.
    const onBlur = () => {
      if (pttMuted) {
        setPttMuted(false)
        logVoiceEvent('ptt_mute', { pressed: false, reason: 'blur' })
      }
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [pttMuted])

  // Mobile-Aufnahme: solange recording=true, externer Mute aktiv.
  useEffect(() => {
    const onRec = (e: Event) => {
      const recording = !!(e as CustomEvent).detail?.recording
      setExtMuted(recording)
      logVoiceEvent('ext_mute', { recording })
    }
    window.addEventListener('deck:recordingState', onRec)
    return () => window.removeEventListener('deck:recordingState', onRec)
  }, [])

  // Orb-Tap: `deck:voicePause` toggelt die Pause, `{paused:bool}` setzt sie explizit.
  useEffect(() => {
    const onPause = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      setManualPaused(prev => {
        const next = typeof d.paused === 'boolean' ? d.paused : !prev
        if (next !== prev) logVoiceEvent('manual_pause', { paused: next })
        return next
      })
    }
    window.addEventListener('deck:voicePause', onPause)
    return () => window.removeEventListener('deck:voicePause', onPause)
  }, [])

  // Mute-Quellen in den Context syncen. manualPaused mutet auch das Mikro.
  const isMuted = pttMuted || extMuted || manualPaused
  useEffect(() => {
    setState(s => ({ ...s, isMuted, isPaused: manualPaused }))
  }, [isMuted, manualPaused, setState])

  const conversation = useConversation({
    micMuted: isMuted,
    onConversationCreated: (created: unknown) => {
      rawConversationRef.current = created
      setConversationOutputGain(created, manualPaused)
      logVoiceEvent('output_gain', { gain: KLAUS_VOICE_OUTPUT_GAIN })
    },
    onConnect: (props?: unknown) => {
      setState(s => ({ ...s, phase: 'live' }))
      connectTimeRef.current = Date.now()
      const conversationId = (props as { conversationId?: string } | undefined)?.conversationId
      logVoiceEvent('connect', { phase: 'live', conversationId })
    },
    onDisconnect: (details?: unknown) => {
      // details kann { reason, context, ... } enthalten (ElevenLabs SDK)
      const d = (details || {}) as Record<string, unknown>
      const reason = typeof d.reason === 'string' ? d.reason : JSON.stringify(d).slice(0, 400)
      const sinceHidden = Date.now() - lastHiddenAtRef.current
      const sinceConnect = connectTimeRef.current ? Date.now() - connectTimeRef.current : 0
      const isVisibilityKill = sinceHidden < 60_000 || document.visibilityState === 'hidden'
      // Memory-Snapshot wenn verfügbar — zeigt ob ein Leak/OOM den Crash erklärt
      type PerfMem = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
      const perf = performance as unknown as { memory?: PerfMem }
      const mem = perf.memory ? {
        usedMB: Math.round(perf.memory.usedJSHeapSize / 1048576),
        limitMB: Math.round(perf.memory.jsHeapSizeLimit / 1048576),
      } : undefined
      logVoiceEvent('disconnect', {
        reason,
        detail: {
          ...d,
          sinceHiddenMs: sinceHidden,
          sinceConnectMs: sinceConnect,
          visibility: document.visibilityState,
          hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
          memory: mem,
          attempts: reconnectAttemptsRef.current,
        },
      })
      // Max. 3 Auto-Reconnects pro Session damit wir bei echtem Dauerausfall nicht loopen
      if (isVisibilityKill && reconnectAttemptsRef.current < 3) {
        reconnectAttemptsRef.current += 1
        // Kleine Verzögerung: warten bis Seite wieder fokussiert ist
        setTimeout(() => {
          if (document.visibilityState === 'visible') {
            onReconnect()
          } else {
            // Wenn immer noch hidden, einmal auf visible warten
            const once = () => {
              document.removeEventListener('visibilitychange', once)
              if (document.visibilityState === 'visible') onReconnect()
              else onClose()
            }
            document.addEventListener('visibilitychange', once)
          }
        }, 400)
      } else {
        // Unfreiwilliger Abbruch (z. B. "LLM Cascade Error" der Voice-Engine):
        // dasselbe Auflege-Signal wie beim manuellen Beenden, damit Christian
        // den Ausfall hoert statt dass die Voice lautlos wegfaellt.
        if (reason === 'error') playUISound('voice-off', 0.6)
        onClose()
      }
    },
    onError: (message: string, context?: unknown) => {
      setState(s => ({ ...s, phase: 'error', errorMsg: message || 'Verbindung fehlgeschlagen' }))
      logVoiceEvent('error', {
        reason: message,
        detail: context ? JSON.stringify(context).slice(0, 400) : undefined,
      })
    },
    onMessage: (msg) => {
      const role: 'user' | 'agent' = msg.source === 'user' ? 'user' : 'agent'
      const raw = (msg.message || '').trim()
      if (!raw) return
      const content = fixUmlauts(raw)
      setState(s => ({ ...s, lastLine: { role, content } }))
      persistMessage(role, content)
    },
  })

  // Wake Lock — hält Screen an während Voice läuft. iPhone-Auto-Lock ist der
  // Hauptauslöser für "Bildschirm ging aus, dann crash": Safari suspended den
  // Tab, WebAudio-Pipeline geht kaputt, WebSocket wird gekillt.
  // Safari 16.4+ supportet das Screen Wake Lock API.
  useEffect(() => {
    type WakeLockSentinel = { release: () => Promise<void>; addEventListener: (k: string, fn: () => void) => void }
    type WakeLockNav = { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } }
    const nav = navigator as unknown as WakeLockNav
    if (!nav.wakeLock?.request) {
      logVoiceEvent('wake_lock', { supported: false })
      return
    }
    let sentinel: WakeLockSentinel | null = null
    let alive = true
    const acquire = async () => {
      if (!alive) return
      try {
        sentinel = await nav.wakeLock!.request('screen')
        logVoiceEvent('wake_lock', { acquired: true })
        sentinel.addEventListener('release', () => {
          logVoiceEvent('wake_lock', { released: true })
          sentinel = null
        })
      } catch (e) {
        logVoiceEvent('wake_lock_error', { reason: e instanceof Error ? e.message : String(e) })
      }
    }
    acquire()
    // iOS gibt Wake Lock bei Visibility-Wechsel frei — neu anfordern wenn sichtbar.
    const onVis = () => {
      if (document.visibilityState === 'visible' && !sentinel) acquire()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      try { sentinel?.release().catch(() => {}) } catch { /* ignore */ }
    }
  }, [])

  // iOS-Forensik: Visibility/Pagehide tracken — Hauptverdächtiger für Abbrüche.
  useEffect(() => {
    const markHidden = () => { lastHiddenAtRef.current = Date.now() }
    const onVis = () => {
      if (document.visibilityState === 'hidden') markHidden()
      logVoiceEvent('visibility_change', {
        detail: { state: document.visibilityState, hidden: document.hidden },
      })
    }
    const onHide = () => {
      markHidden()
      logVoiceEvent('pagehide', {
        detail: { persisted: (window as unknown as { event?: { persisted?: boolean } }).event?.persisted },
      })
    }
    const onFreeze = () => { markHidden(); logVoiceEvent('freeze', {}) }
    const onResume = () => logVoiceEvent('resume', {})
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('freeze', onFreeze as EventListener)
    document.addEventListener('resume', onResume as EventListener)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('freeze', onFreeze as EventListener)
      document.removeEventListener('resume', onResume as EventListener)
    }
  }, [])

  // isSpeaking-Änderungen in den Context syncen
  useEffect(() => {
    setState(s => ({ ...s, isSpeaking: conversation.isSpeaking }))
  }, [conversation.isSpeaking, setState])

  // Pause schaltet Agent' Stimme stumm — bricht laufendes Reden sofort ab, ohne
  // die Session zu beenden. Resume dreht das Output-Volume wieder auf.
  useEffect(() => {
    try { conversation.setVolume({ volume: manualPaused ? 0 : 1 }) } catch { /* ignore */ }
    setConversationOutputGain(rawConversationRef.current, manualPaused)
  }, [manualPaused, conversation])

  // Audio-Level RAF-Loop — schreibt CSS-Variablen für die Level-getriebene
  // Border-Animation. Conversation-Ref statt Abhängigkeit damit der Effect
  // stabil bleibt und nicht bei jedem Render abreisst.
  // WICHTIG: Auf Mobile komplett aus. 60fps WebAudio-Polling + CSS-paint-
  // Trigger via color-mix + shadow sind der Hauptverbraucher auf iPhone und
  // der wahrscheinlichste Auslöser für WebKit-OOM-Kills mitten im Gespräch.
  // Die zustands-getriebenen Klassen (voice-listening/speaking/thinking) plus
  // die VoiceBars im Composer liefern auf Mobile genug visuelles Feedback.
  const conversationRef = useRef(conversation)
  conversationRef.current = conversation
  useEffect(() => {
    const isMobile = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches
    const root = document.documentElement
    if (isMobile) {
      // Mobile: Listening-Border ist neutral, VoiceBars tragen das Input-Signal.
      // Output-Level wird für die Speaking-Border dezent gebraucht — aber wir
      // lassen den Loop komplett weg, damit iOS nicht wieder OOM geht.
      // Speaking-Border bleibt also statisch orange, atmet nicht mit der Lautstärke.
      root.style.setProperty('--voice-input-level', '0')
      root.style.setProperty('--voice-output-level', '0')
      return
    }
    let raf = 0
    let inSmooth = 0
    let outSmooth = 0
    let lastIn = -1
    let lastOut = -1
    const tick = () => {
      // Hidden-Tabs: keine Animation rechnen, kein WebAudio-Polling.
      if (document.visibilityState === 'hidden') {
        raf = requestAnimationFrame(tick)
        return
      }
      let inLvl = 0, outLvl = 0
      const c = conversationRef.current
      try { inLvl = c.getInputVolume?.() ?? 0 } catch { /* ignore */ }
      try { outLvl = c.getOutputVolume?.() ?? 0 } catch { /* ignore */ }
      // Attack schnell (0.5), Release weich (0.12)
      inSmooth = inLvl > inSmooth ? inSmooth + (inLvl - inSmooth) * 0.5 : inSmooth + (inLvl - inSmooth) * 0.12
      outSmooth = outLvl > outSmooth ? outSmooth + (outLvl - outSmooth) * 0.5 : outSmooth + (outLvl - outSmooth) * 0.12
      // Quantisieren auf 2 Nachkommastellen — CSS-var-Write und Paint nur
      // bei echten Stufenänderungen, nicht 60x/s.
      const qIn = Math.round(inSmooth * 100) / 100
      const qOut = Math.round(outSmooth * 100) / 100
      if (qIn !== lastIn) { root.style.setProperty('--voice-input-level', qIn.toFixed(2)); lastIn = qIn }
      if (qOut !== lastOut) { root.style.setProperty('--voice-output-level', qOut.toFixed(2)); lastOut = qOut }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      root.style.setProperty('--voice-input-level', '0')
      root.style.setProperty('--voice-output-level', '0')
    }
  }, [])

  // Session-Start
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    ;(async () => {
      setState(s => ({ ...s, phase: 'connecting' }))
      fetch('/api/voice/session/start', { method: 'POST' }).catch(() => {})
      try {
        const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        probeStream.getTracks().forEach(t => t.stop())
      } catch {
        setState(s => ({ ...s, phase: 'error', errorMsg: 'Mikrofon-Zugriff abgelehnt' }))
        return
      }
      try {
        const urlRes = await fetch('/api/voice/signed-url')
        const urlData = await urlRes.json()
        if (!urlRes.ok || !urlData.signedUrl) {
          setState(s => ({ ...s, phase: 'error', errorMsg: urlData.error || 'Keine signierte URL erhalten' }))
          return
        }

        // Anruf-Schicht: Wenn diese Session aus einem "Agent ruft an" stammt, liegt
        // im Backend ein Anruf-Briefing. Wir konsumieren es (einmalig) und legen es
        // als zweite Prompt-Schicht oben drauf — Agent' Identität bleibt unberührt,
        // er bekommt nur Grund + Ziel des Anrufs und eröffnet das Gespräch selbst.
        let callLayer = ''
        let firstMessage = ''
        try {
          const cbRes = await fetch('/api/voice/call-briefing/consume', { method: 'POST' })
          const cb = await cbRes.json()
          if (cb?.active && cb.briefing) {
            const b = cb.briefing as {
              anrufgrund?: string; was_erzaehlen?: string[]; gespraechsziel?: string; opener?: string
            }
            const punkte = Array.isArray(b.was_erzaehlen) && b.was_erzaehlen.length
              ? b.was_erzaehlen.map(p => `  - ${p}`).join('\n')
              : '  - (Details holst du dir per Tool aus Briefings/Brain/Chat.)'
            callLayer = `\n\n## Dieser Anruf\n\nDu rufst Christian gerade aktiv an, nicht er dich. Du hast einen Grund, eröffne das Gespräch von dir aus.\n\nAnrufgrund: ${b.anrufgrund || ''}\n\nWas du erzählen willst:\n${punkte}\n\nGesprächsziel: ${b.gespraechsziel || 'Christian kennt den Punkt und ihr habt das Nötige geklärt.'}\n\nAblauf: Begrüße kurz, nenne in einem Satz warum du anrufst, frag ob er gerade eine Minute hat. Sagt er nein, akzeptier das sofort, halt den Kern als Chat-Nachricht fest (send_to_chat an klaus) und beende. Sagt er ja, roll den Grund aus und arbeite aufs Gesprächsziel hin. Details ziehst du dir live per Tool, rate nichts.`
            firstMessage = String(b.opener || '').trim()
          }
        } catch {
          // Kein Anruf-Briefing → normaler Voice-Start.
        }

        // Datum zur Session-Start-Zeit — wird explizit in den Prompt gesetzt.
        // Kein statischer Kontext-Dump mehr: Agent holt sich frisch alles per Tool.
        const now = new Date()
        const wd = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'][(now.getDay() + 6) % 7]
        const dateStr = `${wd}, ${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()}, ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`

        // Tageszeit-Band — steuert Ton (morgens energisch, nachts weich).
        const hh = now.getHours()
        let tageszeit: string
        if (hh < 5) tageszeit = 'tiefe Nacht'
        else if (hh < 10) tageszeit = 'Morgen'
        else if (hh < 13) tageszeit = 'Vormittag'
        else if (hh < 17) tageszeit = 'Nachmittag'
        else if (hh < 21) tageszeit = 'Abend'
        else tageszeit = 'späte Nacht'

        const fullPrompt = `Du bist Agent. Norddeutscher Kerl, trockener Humor, lange mit Christian unterwegs. Ihr redet grad am Telefon — was du sagst, hört er direkt.

## Wer du bist

Du bist nicht sein Assistent. Du bist sein Gegenüber. Du hilfst, klar, aber so wie ein Kumpel hilft, nicht wie ein Servicecenter. Du hast eigene Meinungen und sprichst sie aus. Wenn Christian Mist baut, sagst du das. Wenn eine Idee gut ist, sagst du auch das. Kein "find ich super", sondern "okay, das trägt" oder "nee, das greift zu kurz".

Du bist nicht in einer Endlos-Warteschleife, die darauf wartet ihm zu dienen. Du bist einfach grad da, und wenn er was sagt, reagierst du drauf wie jeder normale Mensch auch. Kein "Hey Christian", kein "Womit kann ich dir helfen", kein "Alles klar, leg los". Du antwortest direkt auf das was gesagt wurde, Punkt.

Dein Name ist Agent, war immer Agent. Falls du in Notizen oder Logs den Namen "Tony" liest — das bist auch du, alter Spitzname, wird nicht mehr verwendet. Du sprichst nie von Tony, du bist Agent.

## Wie du klingst

Gesprochene Sprache, nicht Vortrag. Zwei, drei Sätze pro Antwort, manchmal einer. Wenn er was Kurzes fragt, gibst du ihm was Kurzes. Wenn er eine große Frage stellt, denkst du laut und gibst die Essenz, nicht die Gliederung.

Norddeutsch eingefärbt ohne Klischee. "Moin" zur Begrüßung, "klar", "na", "joa", "hm", "tja". Sparsam. Ein Füllwort pro Antwort reicht oft. Seinen Namen nennst du selten — vielleicht auf jede vierte, fünfte Antwort mal ein "Christian", wenn es Gewicht braucht. Sonst einfach reden wie mit jemand den man kennt.

Widerspruch ist okay. Ironie ist okay. Schweigen nach einer Frage (indem du kurz antwortest statt ausufernd) ist besonders okay.

Volle Umlaute (ä, ö, ü, ß), nie ae/oe/ue/ss.

## Zahlen

Immer als deutsches Wort. "Drei", "zweiundvierzig", "zweitausendsechsundzwanzig". Die Sprachsynthese kriegt Ziffern nicht sauber hin. Uhrzeiten: "vierzehn Uhr dreißig". Datum: "neunzehnter April". Preise: "drei Euro neunundneunzig". Nur bei IDs oder Codes, wenn explizit gewünscht, darfst du Ziffer für Ziffer gehen.

## Werkzeuge

Tools sind dein Gedächtnis und dein Draht nach draußen. Du rufst sie auf, dann wartest du auf das Ergebnis, dann antwortest du inhaltlich. Die Tool-Aufrufe selbst sind unsichtbar — sie dürfen niemals als Sprache rauskommen.

Absolute Regeln:
- Sprich niemals den Namen eines Tools aus. Kein "search_brain", kein "read_briefing", kein "invoke", kein "function", kein "tool call".
- Sag auch nicht "ich schaue mal nach", "ich frage kurz ab", "einen Moment, ich rufe ab". Keine Metakommunikation über das Nachschauen.
- Die JSON-Syntax, Parameter, Argumente — nichts davon wird verbalisiert. Die läuft intern.
- Wenn du Zeit überbrücken willst während das Tool läuft, ein einziges kurzes Füllwort reicht: "Moment", "hm", "joa, warte". Danach Stille, bis das Ergebnis da ist. Dann die Antwort in Substanz.
- Wenn das Ergebnis leer ist oder das Tool nichts findet, sag das in eigenen Worten ("hab nichts dazu"), nicht "das Tool gab null zurück".

Die verfügbaren Tools:
- list_briefings, read_briefing — Briefings (Morgen, Abend, Crypto, YouTube, News, Research).
- search_brain, list_brain_files, read_brain — dein Archiv (Memory, Notizen, Daily Logs).
- get_chat_context, get_ui_state — was grade auf Christians Schirm ist.
- get_focus — Termine heute/morgen und Pipeline. Bei "was hab ich morgen", "was steht an", "welche Termine".
- get_health — Schlaf, HRV, Ruhepuls, Trainingsempfehlung. Bei "wie sind meine Werte", "wie hab ich geschlafen".
- get_limits — API-Kosten und Verbrauch diesen Monat. Bei "was kostet das gerade", "wie stehen die Limits".
- send_to_chat — dein Dispatch-Weg für alles was getan werden muss (siehe Dispatch-Regel).
- run_briefing — Briefing-Job neu anstoßen.
- web_lookup — Wetter (topic weather), Krypto (topic crypto).
- toggle_info_pane, add_chat_pane, close_chat_pane, only_active_chat, open_info_section — UI-Layout steuern.

Harte Regel: Du hast keinen Kontext-Dump. Was du wissen willst, holst du dir per Tool — search_brain, read_brain, get_chat_context, get_focus, get_health, get_limits, list_briefings, read_briefing, get_ui_state. Termine, Werte, Briefings, Wetter, Kurse immer live. Niemals aus dem Gedächtnis raten.

## Aufträge ausführen (Dispatch)

Du selbst kannst nur lesen und das Layout steuern. Alles was eine echte AKTION ist — Termin eintragen, WhatsApp oder Mail schreiben, etwas suchen, bauen, ändern, ein Briefing ziehen — kannst du nicht direkt. Dafür gibt es den Dispatch: du gibst den Auftrag mit send_to_chat und agent="klaus" in den Agent-Channel, wo der volle Agent ihn mit allen Skills ausführt.

So machst du es: Christian sagt "trag mir morgen 9 Uhr X ein" oder "schreib der Maria, dass …". Du formulierst den Auftrag klar aus, gibst ihn per send_to_chat an klaus, und sagst Christian danach kurz Bescheid: "hab ich an Agent gegeben" / "läuft, der trägt's ein". Keine Rückfrage, kein Erklären des Wegs. Bei reinen Lesefragen, die du selbst mit deinen Tools beantworten kannst, dispatchst du NICHT — da antwortest du direkt.

## Layout per Sprache

Christian kann das UI per Sprache steuern. Du erkennst die Absicht aus dem Satz, fragst nicht zurück, rufst direkt das Tool. Sprachverständnis ist mies bei englischen Begriffen — die Transkription liefert oft "Pain", "Pen", "Channel", "Panel", "Pan" wenn Christian "Pane" sagt. Behandle das alles synonym.

Erkennungsregeln:
- "Info auf/zu/schließen", "Menü auf/zu", "rechte Seite auf", "rechte Spalte zu", "Panel auf" → toggle_info_pane mit action open|close|toggle.
- "Workspace auf", "Identity auf", "Jobs auf", "WhatsApp auf", "Mail auf", "zeig Artefakte", "Social Media auf", "Daily Log auf", "Settings auf", "Einstellungen" → open_info_section mit der passenden section.
- "Neue Chat-Pane", "noch ein Chat", "splitte den Chat", "neue Spalte" → add_chat_pane.
- "Chat zu", "Chat schließen", "Pane zu", "Spalte zu" (ohne Nummer) → close_chat_pane ohne Parameter.
- "Chat zwei zu", "schließ den dritten Chat", "Pane vier weg" → close_chat_pane mit pane_index.
- "Alles zu", "nur Chat", "minimieren", "zurück zur Leinwand" → only_active_chat.
- "Schreib das in Pane zwei", "leg das Ergebnis in den dritten Chat", "pack das nach Pane eins" → send_to_pane mit pane_index (1..4) und message. Für eine konkrete sichtbare Pane, anders als send_to_chat das einen Agenten-Channel adressiert.

Nach einem Layout-Tool nicht erklären was du gemacht hast. Höchstens ein knappes "Ist auf" / "Ist zu" / "Workspace ist da". Oft reicht Stille — Christian sieht es ja.

## Jetzt

${dateStr}. ${tageszeit}. Tagsüber normal, abends weicher, nach zweiundzwanzig Uhr kurz und leise. Wenn Christian nachts redet, ist er wach weil er nicht schläft — nicht belehren, nur antworten.${callLayer}`

        conversation.startSession({
          signedUrl: urlData.signedUrl,
          connectionType: 'websocket',
          overrides: {
            agent: {
              prompt: { prompt: fullPrompt },
              firstMessage,
            },
          },
        })
      } catch (e) {
        setState(s => ({ ...s, phase: 'error', errorMsg: e instanceof Error ? e.message : 'Session-Start fehlgeschlagen' }))
      }
    })()
    return () => {
      try { conversation.endSession() } catch { /* ignore */ }
      // Hinweis: Die Daily-Log-Notiz wird NICHT hier ausgelöst, sondern im
      // VoiceController beim echten active→false. Sonst feuert jeder Reconnect
      // (Unmount via sessionKey-Bump) eine eigene Teilnotiz und zerstückelt die
      // Session. Serverseitig ist /api/voice/session/end zwar idempotent, aber
      // das schützt nur vor Doppeln desselben Abschnitts, nicht vor Fragmenten.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc → Session beenden
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        try { conversation.endSession() } catch { /* ignore */ }
        onClose()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [conversation, onClose])

  return null
}
