/**
 * Global Audio Queue — ensures only one TTS plays at a time across all panes.
 * When multiple chats have autoplay enabled, messages are queued and played sequentially.
 */
import { setPref } from './prefs'

export interface SpeakRequest {
  text: string
  agentName: string
  ts: number
  conversationId: string
  source?: 'autoplay' | 'manual'
  /** Optional ElevenLabs voice ID override (else backend uses agent default) */
  voiceId?: string
  /** Optional per-voice settings override (0..1 each) */
  voiceSettings?: { stability?: number; similarity_boost?: number; style?: number }
}

export interface PlaybackState {
  /** Which conversation is currently playing */
  playingConversationId: string | null
  /** Timestamp of the currently playing message */
  playingTs: number
  /** Current playback position in seconds */
  audioTime: number
  /** Total duration in seconds */
  audioDuration: number
  /** Whether playback is paused */
  audioPaused: boolean
  /** Whether audio is currently being rendered/fetched */
  audioLoading: boolean
  /** Last playback/rendering error, if any */
  audioError: string
  /** Number of items waiting in queue */
  queueLength: number
  /** Current playback rate (1.0 = normal) */
  playbackRate: number
}

type StateListener = (state: PlaybackState) => void

// ── Internal state ──────────────────────────────────────────────────────────

const queue: SpeakRequest[] = []
let current: SpeakRequest | null = null
// Ein einziges persistentes Audio-Element für die Session. iOS Safari erlaubt
// audio.play() nur in einem User-Gesture; einmal auf Gesture .play()ed bekommt
// das Element dauerhaft Sound-Permission. Neue Elements zu erzeugen oder
// audio=null zu setzen würde diese Erlaubnis verlieren.
let audio: HTMLAudioElement | null = null
let audioActivated = false
let lastAutoplaySignature = ''
let _audioTime = 0
let _audioDuration = 0
let _audioPaused = false
let _audioLoading = false
let _audioError = ''
let _playbackRate = (() => {
  try {
    const v = parseFloat(localStorage.getItem('control:playbackRate') || '1')
    return v >= 0.5 && v <= 2 ? v : 1
  } catch { return 1 }
})()

const listeners = new Set<StateListener>()

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSignature(req: SpeakRequest): string {
  return `${req.agentName}::${Math.round(req.ts * 1000)}::${req.text.slice(0, 240)}`
}

function getState(): PlaybackState {
  return {
    playingConversationId: current?.conversationId ?? null,
    playingTs: current?.ts ?? 0,
    audioTime: _audioTime,
    audioDuration: _audioDuration,
    audioPaused: _audioPaused,
    audioLoading: _audioLoading,
    audioError: _audioError,
    queueLength: queue.length,
    playbackRate: _playbackRate,
  }
}

function notify() {
  const state = getState()
  listeners.forEach(l => l(state))
}

function resetPlaybackState() {
  _audioTime = 0
  _audioDuration = 0
  _audioPaused = false
  _audioLoading = false
  _audioError = ''
}

// ── Core playback ───────────────────────────────────────────────────────────

// Local TTS cache so a Pre-Render started in background is reused by the user's Play click.
// Maps "voiceId::text" -> resolved audio URL (server cache hit/miss) OR in-flight Promise.
// Backend liefert eine URL (GET /api/tts-audio/<hash>.mp3), kein Blob — auf iOS Safari
// PWA blieb der POST-Body sonst leer (size:0), GET mit FileResponse löst das.
const urlCache = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()
const CACHE_MAX = 100

function chunkKey(text: string, req: SpeakRequest): string {
  return `${req.voiceId || ''}::${text}`
}

async function fetchChunk(text: string, req: SpeakRequest): Promise<string | null> {
  const key = chunkKey(text, req)
  const cached = urlCache.get(key)
  if (cached) return cached
  const flying = inFlight.get(key)
  if (flying) return flying

  const p: Promise<string | null> = (async () => {
    let res: Response
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.slice(0, 20000),
          agent: req.agentName,
          conversationId: req.conversationId,
          ...(req.voiceId ? { voiceId: req.voiceId } : {}),
          ...(req.voiceSettings ? { voiceSettings: req.voiceSettings } : {}),
        }),
      })
    } catch {
      return null
    }
    if (!res.ok) return null
    try {
      const data = await res.json() as { url?: string }
      return data?.url || null
    } catch {
      return null
    }
  })()
    .then(url => {
      if (url) {
        urlCache.set(key, url)
        if (urlCache.size > CACHE_MAX) {
          const firstKey = urlCache.keys().next().value
          if (firstKey) urlCache.delete(firstKey)
        }
      }
      return url
    })
    .finally(() => { inFlight.delete(key) })

  inFlight.set(key, p)
  return p
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) audio = new Audio()
  return audio
}

async function doPlay(req: SpeakRequest) {
  current = req
  resetPlaybackState()
  _audioLoading = true
  notify()

  const a = ensureAudio()
  const url = await fetchChunk(req.text, req)
  if (current !== req) return
  if (!url) {
    _audioLoading = false
    _audioError = 'Audio konnte nicht geladen werden.'
    current = null
    notify()
    playNext()
    return
  }
  try {
    try { a.pause() } catch {}
    a.src = url
    a.playbackRate = _playbackRate
    a.ontimeupdate = () => { _audioTime = a.currentTime; notify() }
    a.onloadedmetadata = () => { _audioDuration = a.duration; _audioLoading = false; notify() }
    await a.play()
    _audioLoading = false
    notify()
    await new Promise<void>(resolve => {
      a.addEventListener('ended', () => { resolve() }, { once: true })
    })
  } catch {
    if (current === req) {
      _audioLoading = false
      _audioError = 'Audio konnte nicht abgespielt werden.'
    }
  } finally {
    if (current === req) {
      current = null
      const error = _audioError
      resetPlaybackState()
      _audioError = error
      playNext()
    }
  }
}

function playNext() {
  if (queue.length === 0) {
    current = null
    notify()
    return
  }
  const next = queue.shift()!
  // Set current synchronously BEFORE the async doPlay, so concurrent enqueue() calls see it
  current = next
  notify()
  doPlay(next)
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Subscribe to playback state changes. Returns unsubscribe function. */
export function subscribe(listener: StateListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Get current playback state (snapshot). */
export { getState }

/**
 * Add a speak request to the queue.
 * If nothing is playing, starts immediately. Otherwise queued.
 */
export function enqueue(req: SpeakRequest) {
  const sig = makeSignature(req)

  // Dedup autoplay: skip if same signature as last played
  if (req.source === 'autoplay') {
    if (sig === lastAutoplaySignature) return
    lastAutoplaySignature = sig
  }

  // If this exact message is already playing, treat as toggle-off
  if (current && current.ts === req.ts && current.conversationId === req.conversationId) {
    stopCurrent()
    return
  }

  queue.push(req)
  if (!current) playNext()
  else notify()
}

/**
 * Play immediately, skipping the queue. Used for manual click-to-play.
 * Clears the queue and stops current playback.
 */
export function playNow(req: SpeakRequest) {
  const sig = makeSignature(req)

  // Toggle: if same message is playing, stop
  if (current && current.ts === req.ts && current.conversationId === req.conversationId) {
    stopAll()
    return
  }

  queue.length = 0
  if (audio) { try { audio.pause() } catch {} }
  current = null
  resetPlaybackState()
  lastAutoplaySignature = sig
  warmUp()
  doPlay(req)
}

/** Stop current playback and advance to next in queue. */
export function stopCurrent() {
  if (audio) { try { audio.pause() } catch {} }
  current = null
  resetPlaybackState()
  playNext()
}

/** Stop everything — current playback and clear queue. */
export function stopAll() {
  queue.length = 0
  if (audio) { try { audio.pause() } catch {} }
  current = null
  resetPlaybackState()
  notify()
}

/** Toggle play/pause on current audio. */
export function togglePlayback() {
  if (!audio) return
  if (audio.paused) {
    audio.play().catch(() => {})
    _audioPaused = false
  } else {
    audio.pause()
    _audioPaused = true
  }
  notify()
}

/** Seek to a position in seconds. */
export function seek(time: number) {
  if (audio) audio.currentTime = time
}

/** Set playback rate (persisted). Applies to current audio and all future playback. */
export function setPlaybackRate(rate: number) {
  const clamped = Math.max(0.5, Math.min(2, rate))
  _playbackRate = clamped
  setPref('control:playbackRate', String(clamped))
  if (audio) audio.playbackRate = clamped
  notify()
}

/**
 * Pre-render TTS for a message into the server cache, so a later Play is instant.
 * Fires sentence-by-sentence sequentially. Errors silently swallowed.
 */
export async function prewarm(req: SpeakRequest) {
  try { await fetchChunk(req.text, req) } catch {}
}

/** Clear cached URLs (used by Settings → Daten → Audio-Cache leeren). */
export function clearCache() {
  urlCache.clear()
  inFlight.clear()
}

/** Warm up the audio element on user gesture (required for mobile autoplay).
 *  Spielt synchron einen kurzen Silent-Stream, um dauerhaft Sound-Permission
 *  für dieses Element zu bekommen. Muss aus einem Click-Handler aufgerufen
 *  werden — keine awaits davor. */
export function warmUp() {
  const a = ensureAudio()
  if (!audioActivated) {
    try {
      a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
      a.play().then(() => { audioActivated = true }).catch(() => {})
    } catch {}
  }
}
