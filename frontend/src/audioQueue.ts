export type SpeakRequest = {
  text: string
  agentName?: string
  ts?: number
  conversationId?: string
  source?: 'manual' | 'autoplay'
  voiceId?: string
  voiceSettings?: { stability?: number; similarity_boost?: number; style?: number }
}

type AudioState = {
  playingTs: number
  playingConversationId: string
  audioTime: number
  audioDuration: number
  audioPaused: boolean
  audioLoading: boolean
  audioError: string
  playbackRate: number
}

const state: AudioState = {
  playingTs: 0,
  playingConversationId: '',
  audioTime: 0,
  audioDuration: 0,
  audioPaused: false,
  audioLoading: false,
  audioError: '',
  playbackRate: 1,
}

export function getState(): AudioState {
  return state
}

export function subscribe(_fn: (state: AudioState) => void): () => void {
  return () => {}
}

export function warmUp() {}
export function enqueue(_req: SpeakRequest) {}
export function playNow(_req: SpeakRequest) {}
export function stopAll() {}
export function stopCurrent() {}
export function togglePlayback() {}
export function seek(_time: number) {}
export function setPlaybackRate(rate: number) {
  state.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1
}
