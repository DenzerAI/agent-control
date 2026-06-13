/**
 * User preferences — synced across devices (Mobile + Desktop) via /api/prefs.
 *
 * Reads: localStorage (hot cache, populated by initPrefs on startup).
 * Writes: localStorage + PUT /api/prefs (fire-and-forget).
 *
 * Synced key prefixes:
 *   control:voice:*          — selected voice id per agent
 *   control:voiceSettings:*  — per-voice ElevenLabs tuning (stability etc.)
 *   control:autoplay:*       — autoplay toggle per agent
 *   control:playbackRate     — global TTS playback rate
 */

const SYNC_PREFIXES = [
  'control:voice:',
  'control:voiceSettings:',
  'control:autoplay:',
]
const SYNC_EXACT = new Set([
  'control:playbackRate',
  'control:theme',
  // Globale TTS-/Voice-Settings, die sonst nur lokal in einem Browser hingen.
  'control:autoplay',
  'control:voice',
  'control:ttsStream',
  'control:ttsMode',
  'control:engine:default',
  // Chat-Streaming-Optik (gerätegleich gefühlt)
  'control:typewriter',
  'control:quietTools',
  'control:typewriterSpeed',
  'control:typewriterAdvanced',
  'control:revealStyle',
  'control:smartBlocks',
  'control:responseMode',
  'control:verbosity',
  'control:toolMode',
  'control:toolStepMinMs',
  'infopane:section-order:core',
  'infopane:section-order:custom',
])

export function isSyncedKey(key: string): boolean {
  if (SYNC_EXACT.has(key)) return true
  return SYNC_PREFIXES.some(p => key.startsWith(p))
}

let initialized = false
let initPromise: Promise<void> | null = null

/**
 * Fetch server-side prefs and mirror them into localStorage.
 * Call once before app renders so state initializers see synced values.
 */
export function initPrefs(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = fetch('/api/prefs')
    .then(r => (r.ok ? r.json() : {}))
    .then((remote: Record<string, unknown>) => {
      if (remote && typeof remote === 'object') {
        for (const [key, value] of Object.entries(remote)) {
          if (!isSyncedKey(key)) continue
          try {
            if (value === null || value === undefined) {
              localStorage.removeItem(key)
            } else if (typeof value === 'string') {
              localStorage.setItem(key, value)
            } else {
              localStorage.setItem(key, JSON.stringify(value))
            }
          } catch { /* quota */ }
        }
      }
      initialized = true
    })
    .catch(() => { initialized = true })
  return initPromise
}

// Eindeutige Geräte-ID, damit ein Pref-Update nicht von uns selbst zurück über WS
// einen Loop verursacht. Wird einmal pro Browser generiert.
let _deviceId = ''
function deviceId(): string {
  if (_deviceId) return _deviceId
  try {
    let id = localStorage.getItem('control:_deviceId')
    if (!id) {
      id = `dev-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
      localStorage.setItem('control:_deviceId', id)
    }
    _deviceId = id
  } catch {
    _deviceId = `dev-${Math.random().toString(36).slice(2, 10)}`
  }
  return _deviceId
}

/**
 * Set a preference — writes to localStorage immediately and syncs to server.
 * Pass null/undefined to delete.
 */
export function setPref(key: string, value: string | null | undefined): void {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch { /* quota */ }

  if (!isSyncedKey(key)) return

  // Server send as JSON — stringify if the local value isn't already a string.
  const payload: Record<string, unknown> = { [key]: value ?? null, __source: deviceId() }
  fetch('/api/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { /* silent */ })
}

/**
 * Live-Update von einem anderen Gerät: localStorage spiegeln und passende
 * UI-Events dispatchen, damit React-States nachziehen, ohne dass der User
 * neu laden muss.
 */
export function applyRemotePrefs(changes: Record<string, unknown>, source?: string): void {
  if (source && source === deviceId()) return // wir selbst — schon angewandt
  if (!changes || typeof changes !== 'object') return
  for (const [key, value] of Object.entries(changes)) {
    if (!isSyncedKey(key)) continue
    try {
      if (value === null || value === undefined) {
        localStorage.removeItem(key)
      } else if (typeof value === 'string') {
        localStorage.setItem(key, value)
      } else {
        localStorage.setItem(key, JSON.stringify(value))
      }
    } catch { /* quota */ }
    // Spezial-Events für Components, die auf konkrete Toggles hören.
    const v = typeof value === 'string' ? value : (value === null || value === undefined ? null : JSON.stringify(value))
    if (key === 'control:autoplay') {
      window.dispatchEvent(new CustomEvent('deck:autoplayChanged', { detail: { enabled: v === 'true' } }))
    } else if (key.startsWith('control:autoplay:')) {
      const agent = key.slice('control:autoplay:'.length)
      window.dispatchEvent(new CustomEvent('deck:autoplayChanged', { detail: { enabled: v === 'true', agent } }))
    } else if (key === 'control:theme') {
      // Theme sofort am DOM anwenden, nicht nur in localStorage spiegeln.
      import('./theme').then(t => t.applyTheme((v as 'light' | 'dark' | 'auto') || 'auto'))
      window.dispatchEvent(new CustomEvent('deck:themeChanged', { detail: { mode: v } }))
    }
  }
  // Generisches Event — alle anderen Components können hier andocken.
  window.dispatchEvent(new CustomEvent('deck:prefsRemoteUpdate', { detail: { changes } }))
}

export function isInitialized(): boolean {
  return initialized
}
