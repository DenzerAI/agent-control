import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { lazyWithRetry } from './info-pane/utils/lazyWithRetry'
import { DEFAULT_VOICE_STATE, VoiceStateContext, type VoiceState } from './voiceState'
import { setVoiceActive } from '../uiSounds'

// VoiceController bleibt leichtgewichtig. Die schwere Voice-Schicht wird erst
// geladen, wenn Christian Voice wirklich startet.
// Voice-Mode: reine ElevenLabs-ConvAI-Pipeline — ElevenLabs hoert, denkt (Claude
// Sonnet via Custom-LLM-Agent) UND spricht als Agent. Ein System, kein Hybrid:
// Turn-Taking und Echo-Unterdrueckung sind eingebaut, OpenAI ist komplett raus.
const VoiceActiveSession = lazyWithRetry(() => import('./VoiceActiveSession'))

interface Props {
  active: boolean
  onClose: () => void
  children: ReactNode
}

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

export function VoiceController({ active, onClose, children }: Props) {
  const [state, setState] = useState<VoiceState>(DEFAULT_VOICE_STATE)
  const [sessionKey, setSessionKey] = useState(0)
  // True sobald eine Session lief — damit der active→false-Übergang genau einmal
  // pro echter Session greift (Reconnects bumpen nur sessionKey, active bleibt).
  const wasActiveRef = useRef(false)

  useEffect(() => {
    // Chat-Klingelton aus, solange Voice laeuft: Voice-Transkripte landen als
    // Chat-Nachrichten, sonst pingt es bei jedem Satz von Agent oder Christian.
    setVoiceActive(active)
    if (active) {
      wasActiveRef.current = true
    } else {
      // Echtes Session-Ende (Auflegen/Esc), nicht bloss ein Reconnect-Remount:
      // Backend fasst die Turns seit dem Start-Marker zusammen und schreibt die
      // Notiz ins heutige Daily Log. Fire-and-forget, serverseitig idempotent.
      if (wasActiveRef.current) {
        wasActiveRef.current = false
        fetch('/api/voice/session/end', { method: 'POST' }).catch(() => {})
      }
      setState(DEFAULT_VOICE_STATE)
      setSessionKey(0)
    }
    return () => setVoiceActive(false)
  }, [active])

  const setStateStable = useCallback((updater: (prev: VoiceState) => VoiceState) => {
    setState(updater)
  }, [])

  const reconnect = useCallback(() => {
    logVoiceEvent('reconnect_trigger', {})
    setState(s => ({ ...s, phase: 'connecting', errorMsg: '' }))
    setSessionKey(k => k + 1)
  }, [])

  const value: VoiceState = { ...state, active }

  return (
    <VoiceStateContext.Provider value={value}>
      {active && (
        <Suspense fallback={null}>
          <VoiceActiveSession
            key={sessionKey}
            onClose={onClose}
            onReconnect={reconnect}
            setState={setStateStable}
          />
        </Suspense>
      )}
      {children}
    </VoiceStateContext.Provider>
  )
}
