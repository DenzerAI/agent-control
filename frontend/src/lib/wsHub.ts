// Geteilter WebSocket-Hub: genau EIN /ws-Socket pro Browser-Tab.
//
// Vorher öffnete jede ChatPane ihren eigenen Socket. Bei vier Desktop-Panes
// waren das vier echte Verbindungen, jeder Server-Broadcast traf alle vier und
// jede zog daraufhin die volle Historie neu. Der Hub bündelt das auf eine
// Leitung. Jede Pane registriert ihren Message-Handler und filtert eingehende
// Events weiterhin selbst nach ihrer conversationId, die Event-Logik bleibt
// also unverändert. Das Backend adressiert Streams ohnehin per Socket-Set
// (sess["subscribers"]), ein geteilter Socket trägt also alle Conversations
// eines Tabs, sobald jede Pane ihr attach gesendet hat.

export type WsHubHandlers = {
  onMessage: (msg: unknown) => void
  onOpen?: () => void
  onClose?: () => void
}

export type WsHubHandle = {
  send: (raw: string) => void
  isOpen: () => boolean
  release: () => void
}

let socket: WebSocket | null = null
const handlers = new Set<WsHubHandlers>()
// Outbox: Payloads, die während eines Drops gesendet werden, hier puffern und
// beim nächsten onopen flushen. So geht kein Send verloren.
const outbox: string[] = []
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let intentionallyClosed = false
// Zeitpunkt, an dem der Tab zuletzt in den Hintergrund ging. iOS friert einen
// WebSocket beim Backgrounding oft lautlos ein: readyState bleibt OPEN, aber es
// kommt nichts mehr und kein onclose feuert. Beim Foreground bauen wir die
// Leitung dann hart neu auf, der frische onopen loest in jeder Pane attach +
// History-Refresh aus.
let hiddenSince = 0

// Toten/eingefrorenen Socket hart ersetzen, ohne die Pane-onClose-Handler zu
// feuern (kein Disconnect-Banner fuer einen geplanten Reconnect). ensureSocket
// oeffnet sofort neu, weil wir den Backoff zuruecksetzen.
function forceReconnect() {
  const s = socket
  socket = null
  reconnectAttempt = 0
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (s) {
    s.onopen = null
    s.onmessage = null
    s.onclose = null
    s.onerror = null
    try { s.close() } catch { /* egal, wir verwerfen ihn ohnehin */ }
  }
  ensureSocket()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenSince = Date.now(); return }
    if (handlers.size === 0) return
    const wasHiddenMs = hiddenSince ? Date.now() - hiddenSince : 0
    hiddenSince = 0
    // iOS friert einen backgroundeten WS lautlos ein (readyState bleibt OPEN,
    // kein onclose). Von aussen ist ein toter nicht von einem lebenden Socket zu
    // unterscheiden, darum behandeln wir JEDEN echten Vordergrund als unsicher und
    // bauen die Leitung hart neu auf. Der frische onopen traegt in jeder Pane
    // attach + History-Refresh nach (siehe onWsOpen). Die kleine 400ms-Schwelle
    // filtert nur versehentliche Doppel-Events; jeder reale App-Wechsel liegt
    // darueber. Das ersetzt die fruehere 1500ms-Schwelle, die genau die Luecke war,
    // in der die fertige Antwort unsichtbar blieb bis zum naechsten Reload.
    if (wasHiddenMs > 400) forceReconnect()
    else ensureSocket()
  })
}

// Wie im alten Pro-Pane-Reconnect: steigender Backoff, dann 10s für immer.
const RECONNECT_DELAYS = [2000, 3000, 3000, 5000, 5000, 10000]

// App-Level-Heartbeat: ein leichtes {"action":"ping"} als echtes Data-Frame.
// Warum nicht das WS-Protokoll-Ping (uvicorn)? Dessen Control-Frames versickern
// im Tailscale-Tunnel, der Server sah nie ein Pong und kappte die Leitung nach
// Timeout mit Code 1011 — genau die "Session abgelaufen"-Schleife bei aktivem Tab.
// Data-Frames gehen durch den Tunnel. Der Server pongt mit {"type":"pong"}, jede
// Server-Antwort frischt lastRxAt. Bleibt die Leitung DEAD_MS stumm (kein Pong),
// ist sie real tot und wir bauen sie hart neu auf.
const HEARTBEAT_MS = 25000
const DEAD_MS = 70000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastRxAt = 0

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}

function startHeartbeat() {
  stopHeartbeat()
  lastRxAt = Date.now()
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastRxAt > DEAD_MS) { forceReconnect(); return }
    try { socket.send('{"action":"ping"}') } catch { /* onclose/Reconnect uebernimmt */ }
  }, HEARTBEAT_MS)
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

function flushOutbox() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  const pending = outbox.splice(0, outbox.length)
  for (let i = 0; i < pending.length; i++) {
    try {
      socket.send(pending[i])
    } catch {
      // Rest zurück in die Outbox, beim nächsten onopen erneut versuchen.
      outbox.unshift(...pending.slice(i))
      break
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  if (handlers.size === 0) return
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureSocket()
  }, delay)
}

function ensureSocket() {
  if (handlers.size === 0) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  intentionallyClosed = false
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  socket = ws
  ws.onopen = () => {
    reconnectAttempt = 0
    flushOutbox()
    startHeartbeat()
    for (const h of Array.from(handlers)) {
      try { h.onOpen?.() } catch { /* eine Pane darf den Hub nicht reissen */ }
    }
  }
  ws.onmessage = (e) => {
    lastRxAt = Date.now()
    let msg: unknown
    try { msg = JSON.parse(e.data) } catch { return }
    // Heartbeat-Pong nur als Lebenszeichen werten, nicht an die Panes broadcasten.
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'pong') return
    for (const h of Array.from(handlers)) {
      try { h.onMessage(msg) } catch { /* Fehler in einer Pane isolieren */ }
    }
  }
  ws.onclose = () => {
    stopHeartbeat()
    if (socket === ws) socket = null
    for (const h of Array.from(handlers)) {
      try { h.onClose?.() } catch { /* ignore */ }
    }
    if (!intentionallyClosed && handlers.size > 0) scheduleReconnect()
  }
  ws.onerror = () => {
    try { ws.close() } catch { /* onclose übernimmt den Rest */ }
  }
}

export function acquireWsHub(h: WsHubHandlers): WsHubHandle {
  handlers.add(h)
  ensureSocket()
  // Pane kam dazu, während der Socket schon offen war: onOpen einmal nachziehen,
  // damit sie ihr attach/refresh fährt (sonst täte das nur das gemeinsame onopen
  // beim allerersten Connect).
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { h.onOpen?.() } catch { /* ignore */ }
  }
  return {
    send: (raw: string) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.send(raw) } catch { outbox.push(raw) }
      } else {
        outbox.push(raw)
        ensureSocket()
      }
    },
    isOpen: () => !!socket && socket.readyState === WebSocket.OPEN,
    release: () => {
      handlers.delete(h)
      if (handlers.size === 0) {
        intentionallyClosed = true
        stopHeartbeat()
        reconnectAttempt = 0
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        const s = socket
        socket = null
        if (s) {
          s.onopen = null
          s.onmessage = null
          s.onclose = null
          s.onerror = null
          try {
            if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
              s.close(1000, 'no subscribers')
            }
          } catch { /* ignore */ }
        }
      }
    },
  }
}
