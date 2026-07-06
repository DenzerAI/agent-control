export type VoiceState = {
  active: boolean
  phase: 'idle' | 'init' | 'connecting' | 'live' | 'listening' | 'thinking' | 'speaking'
  isMuted: boolean
  isThinking: boolean
  isSpeaking: boolean
  isPaused: boolean
}

const idle: VoiceState = {
  active: false,
  phase: 'idle',
  isMuted: false,
  isThinking: false,
  isSpeaking: false,
  isPaused: false,
}

export function useVoiceState(): VoiceState {
  return idle
}
