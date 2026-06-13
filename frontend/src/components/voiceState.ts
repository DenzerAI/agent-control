import { createContext, useContext } from 'react'

export type VoicePhase = 'init' | 'connecting' | 'live' | 'ending' | 'error'

export interface VoiceState {
  active: boolean
  phase: VoicePhase
  isSpeaking: boolean
  isThinking: boolean
  isMuted: boolean
  /** Manuelle Pause per Orb-Tap: Mikro aus + Agent verstummt, Session bleibt aber offen. */
  isPaused: boolean
  lastLine: { role: 'user' | 'agent'; content: string } | null
  errorMsg: string
}

export const DEFAULT_VOICE_STATE: VoiceState = {
  active: false,
  phase: 'init',
  isSpeaking: false,
  isThinking: false,
  isMuted: false,
  isPaused: false,
  lastLine: null,
  errorMsg: '',
}

export const VoiceStateContext = createContext<VoiceState>(DEFAULT_VOICE_STATE)
export const useVoiceState = () => useContext(VoiceStateContext)
