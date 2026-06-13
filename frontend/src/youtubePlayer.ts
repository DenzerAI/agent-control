/**
 * Globaler YouTube-Player-Store — eine Wiedergabe für die ganze App.
 * Das iframe lebt in GlobalYouTubePlayer (App-Root), nicht im Workspace,
 * damit Musik beim Modul-/Chatwechsel weiterläuft. Pattern wie audioQueue.ts.
 */

export interface YtPlayerVideo {
  id: string
  title: string
  channel: string
  channelId?: string | null
  thumbnail: string
}

export interface YtPlayerState {
  video: YtPlayerVideo | null
  paused: boolean
}

type Listener = (state: YtPlayerState) => void

let video: YtPlayerVideo | null = null
let paused = false
let iframeEl: HTMLIFrameElement | null = null
// Platzhalter im Workspace-Player-View; wenn gesetzt, dockt das globale
// iframe optisch dort an, sonst läuft es als Mini-Player weiter.
let anchorEl: HTMLElement | null = null

const listeners = new Set<Listener>()
const anchorListeners = new Set<(el: HTMLElement | null) => void>()

function emit() {
  const state = getState()
  listeners.forEach(l => { try { l(state) } catch {} })
}

export function getState(): YtPlayerState {
  return { video, paused }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  listener(getState())
  return () => { listeners.delete(listener) }
}

export function subscribeAnchor(listener: (el: HTMLElement | null) => void): () => void {
  anchorListeners.add(listener)
  listener(anchorEl)
  return () => { anchorListeners.delete(listener) }
}

export function setAnchor(el: HTMLElement | null) {
  anchorEl = el
  anchorListeners.forEach(l => { try { l(el) } catch {} })
}

export function registerIframe(el: HTMLIFrameElement | null) {
  iframeEl = el
}

function command(func: 'playVideo' | 'pauseVideo' | 'stopVideo') {
  try {
    iframeEl?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*')
  } catch {}
}

function pushNowPlaying(v: YtPlayerVideo | null) {
  // Server-State fürs Chat-Kontext-Tool und die automatische Dossier-Auswertung.
  try {
    fetch('/api/youtube/now-playing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video: v }),
    }).catch(() => {})
  } catch {}
}

export function play(next: YtPlayerVideo) {
  video = next
  paused = false
  emit()
  pushNowPlaying(next)
}

export function togglePause() {
  if (!video) return
  if (paused) command('playVideo')
  else command('pauseVideo')
  paused = !paused
  emit()
}

export function stop() {
  command('stopVideo')
  video = null
  paused = false
  emit()
  pushNowPlaying(null)
}

/** Vom iframe gemeldeter Playerzustand (1 = playing, 2 = paused), hält den
 *  Pause-Button synchron, auch wenn direkt im Video pausiert wird. */
export function syncPlayerState(ytState: number) {
  if (!video) return
  const next = ytState === 2
  if (ytState !== 1 && ytState !== 2) return
  if (next !== paused) { paused = next; emit() }
}
