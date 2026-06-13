const SOURCES: Record<string, string> = {
  'info-open': '/sounds/backpack-open.ogg',
  'info-close': '/sounds/backpack-close.ogg',
  'tell-message': '/sounds/tell-message.ogg',
  'section-open': '/sounds/section-open.ogg',
  'section-close': '/sounds/section-close.ogg',
  'menu-open': '/sounds/menu-open.ogg',
  'menu-close': '/sounds/menu-close.ogg',
  'level-up': '/sounds/level-up.ogg',
  'doc-open': '/sounds/doc-open.ogg',
  'tab-click': '/sounds/tab-click.ogg',
  'layout-switch': '/sounds/layout-switch.ogg',
  'deep-toggle': '/sounds/deep-toggle.ogg',
  'tab-close': '/sounds/tab-close.ogg',
  'tab-move': '/sounds/tab-move.ogg',
  'tab-pickup': '/sounds/tab-pickup.ogg',
  'view-open': '/sounds/view-open.ogg',
  'view-back': '/sounds/view-back.ogg',
  'voice-on': '/sounds/voice-on.ogg',
  'voice-off': '/sounds/voice-off.ogg',
  'message-in': '/sounds/message-in.ogg',
  'artifact-created': '/sounds/artifact-created.ogg',
  'option-pick': '/sounds/option-pick.ogg',
  'workspace-open': '/sounds/view-open.ogg',
  'workspace-close': '/sounds/view-back.ogg',
  'workspace-mode': '/sounds/tab-click.ogg',
  'workspace-span': '/sounds/layout-switch.ogg',
  'workspace-file': '/sounds/doc-open.ogg',
  'workspace-reveal': '/sounds/backpack-open.ogg',
}

const ENABLED_KEY = 'control:uiSoundEnabled'
const VOLUME_KEY = 'control:uiSoundVolume'

function readEnabled(): boolean {
  try {
    const v = localStorage.getItem(ENABLED_KEY)
    return v === null ? true : v === '1'
  } catch { return true }
}

function readVolume(): number {
  try {
    const v = localStorage.getItem(VOLUME_KEY)
    if (v === null) return 1
    const n = parseFloat(v)
    if (!isFinite(n)) return 1
    return Math.max(0, Math.min(1, n))
  } catch { return 1 }
}

export function getUISoundEnabled(): boolean { return readEnabled() }
export function getUISoundVolume(): number { return readVolume() }

type Listener = () => void
const listeners = new Set<Listener>()
export function subscribeUISound(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function notify() { for (const cb of listeners) { try { cb() } catch {} } }

export function setUISoundEnabled(on: boolean) {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0') } catch {}
  notify()
}

export function setUISoundVolume(v: number) {
  const clamped = Math.max(0, Math.min(1, v))
  try { localStorage.setItem(VOLUME_KEY, String(clamped)) } catch {}
  notify()
}

const pool: Record<string, HTMLAudioElement[]> = {}
const POOL_SIZE = 3

function getElement(name: string): HTMLAudioElement | null {
  const src = SOURCES[name]
  if (!src) return null
  let arr = pool[name]
  if (!arr) {
    arr = []
    pool[name] = arr
    for (let i = 0; i < POOL_SIZE; i++) {
      const a = new Audio(src)
      a.preload = 'auto'
      a.crossOrigin = 'anonymous'
      arr.push(a)
    }
  }
  for (const a of arr) {
    if (a.paused || a.ended) return a
  }
  return arr[0]
}

function isMobileViewport(): boolean {
  try { return window.matchMedia('(max-width: 768px)').matches } catch { return false }
}

export function preloadUISounds() {
  if (isMobileViewport()) return
  for (const k of Object.keys(SOURCES)) {
    const arr = pool[k] || (pool[k] = [])
    if (arr.length === 0) {
      const a = new Audio(SOURCES[k])
      a.preload = 'auto'
      arr.push(a)
      try { a.load() } catch {}
    }
  }
}

// Voice-Mode: solange Agent spricht/zuhoert, die Nachrichten-Pings stumm halten.
// Voice-Transkripte werden als Chat-Nachrichten persistiert und wuerden sonst
// bei jedem Satz das Klingengeraeusch ausloesen.
let voiceActive = false
const SUPPRESS_DURING_VOICE = new Set<string>(['tell-message', 'message-in'])
export function setVoiceActive(on: boolean) { voiceActive = on }

export function playUISound(name: keyof typeof SOURCES, volume = 0.4) {
  if (voiceActive && SUPPRESS_DURING_VOICE.has(name as string)) return
  if (isMobileViewport()) return
  if (!readEnabled()) return
  const master = readVolume()
  if (master <= 0) return
  const a = getElement(name as string)
  if (!a) return
  try {
    a.volume = Math.max(0, Math.min(1, volume * master))
    a.currentTime = 0
    void a.play().catch(() => {})
  } catch {}
}
