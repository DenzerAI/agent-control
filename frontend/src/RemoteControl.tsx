import { useState, useEffect, useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import { X, ChevronLeft, ChevronDown, QrCode, Mic, Check, Pause, Play, Square, Volume2, Smartphone, Monitor } from 'lucide-react'
import jsQR from 'jsqr'
import * as audioQueue from './audioQueue'
import { cleanForTTS } from './ttsClean'
import './index.css'

// Agent Deck — Phone Control.
// Fernbedienung fürs Handy, gebaut wie die Mobile-App: schwarze Leinwand,
// dezente Chrome, Bedienung unten im Daumenbereich. Die vier Zielchat-Kacheln
// SIND der Aufnahme-Knopf: erster Tap aktiviert die Kachel, zweiter Tap nimmt
// auf, dritter Tap sendet. Kein separater Mic-Kreis mehr.
// Sync mit Monitor (DeckMonitor) läuft über /api/slots (slots + activeSlot,
// WS-Broadcast `slots.update`). Sprache geht über /api/transcribe und
// /api/deck/pane-input in den aktiven Zielchat.

interface Slot {
  agent: string
  convId: string
}

const MAX_SLOTS = 4
const ACCENT = '#d97757'

export default function RemoteControl() {
  const [slots, setSlots] = useState<Slot[]>(() => Array.from({ length: MAX_SLOTS }, () => ({ agent: 'main', convId: '' })))
  const [activeSlot, setActiveSlot] = useState(0)
  const [convMeta, setConvMeta] = useState<Record<string, string>>({})
  // Geordnete Chat-Liste für den Kachel-Picker (id + Titel, neueste zuerst).
  const [convList, setConvList] = useState<{ id: string; title: string }[]>([])
  // Picker offen für genau eine Kachel (Index) oder null = zu.
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
  const [recording, setRecording] = useState(false)
  const [paused, setPaused] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const [flash, setFlash] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [pairOpen, setPairOpen] = useState(false)
  const [pairCode, setPairCode] = useState<string | null>(null)
  const [pairName, setPairName] = useState('')
  const [pairState, setPairState] = useState<'idle' | 'confirming' | 'done' | 'error'>('idle')
  const [monitors, setMonitors] = useState<{ id: string; name: string; created: number; mode: string }[]>([])
  const [scanning, setScanning] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [zoomMax, setZoomMax] = useState(3)
  const [hwZoom, setHwZoom] = useState(false)
  const [manual, setManual] = useState('')
  // Arbeits-Status je Chat: busy = convId → Startzeit (epoch ms), done = convId →
  // Fertig-Zeit (Haken kurz zeigen). Quelle ist der stream.state-Broadcast übers WS.
  const [busyConvs, setBusyConvs] = useState<Record<string, number>>({})
  const [doneConvs, setDoneConvs] = useState<Record<string, number>>({})
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({})
  // TTS-Wiedergabe: welcher Chat wird gerade vorgelesen, Position/Dauer, pausiert.
  // Quelle ist der globale audioQueue (eine Stimme zur Zeit, app-weit geteilt).
  const [playback, setPlayback] = useState(() => audioQueue.getState())
  const [, setTick] = useState(0)
  // Vorlese-Ziel: TV (über den gekoppelten Monitor, Default) oder Handy. Beim TV
  // läuft die Wiedergabe auf dem Monitor; sein Status (idle/playing/paused +
  // Position) kommt über /api/deck/audio zurück und speist dieselbe Transportleiste.
  const [audioTarget, setAudioTarget] = useState<'tv' | 'phone'>(() => localStorage.getItem('deck:audioTarget') === 'phone' ? 'phone' : 'tv')
  const [tvAudio, setTvAudio] = useState<{ state: 'idle' | 'playing' | 'paused'; t: number; dur: number; convId: string }>({ state: 'idle', t: 0, dur: 0, convId: '' })
  const [seekDrag, setSeekDrag] = useState<number | null>(null)
  const speakGraceRef = useRef(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)
  const activeSlotRef = useRef(0)
  activeSlotRef.current = activeSlot
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scanStreamRef = useRef<MediaStream | null>(null)
  const scanRafRef = useRef<number | null>(null)
  const scanTrackRef = useRef<MediaStreamTrack | null>(null)
  const zoomRef = useRef(1)
  const hwZoomRef = useRef(false)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Geste auf einer Kachel: unterscheidet Tipp (aufnehmen) von Wisch (scrollen).
  const gestureRef = useRef<{ id: number; x: number; y: number; lastY: number; moved: boolean; slot: number } | null>(null)
  const scrollAccumRef = useRef(0)
  const scrollFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Kurze Status-Quittung im oberen Streifen (Gesendet / Fehler), selbst-löschend.
  const showFlash = useCallback((text: string, kind: 'ok' | 'err', ms = 2200) => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setFlash({ text, kind })
    flashTimer.current = setTimeout(() => setFlash(null), ms)
  }, [])

  // Monitor-Pairing: QR vom /tv-Screen landet als ?pair=<code> hier.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('pair')
    if (code) { setPairCode(code); setPairOpen(true) }
  }, [])

  // Liste der gekoppelten Bildschirme laden (Name + seit wann). Speist die
  // „Wo bin ich angemeldet"-Ansicht im Koppel-Sheet.
  const loadMonitors = useCallback(async () => {
    try {
      const d = await fetch('/api/deck/monitors').then(r => r.json())
      setMonitors(Array.isArray(d.monitors) ? d.monitors : [])
    } catch {}
  }, [])

  // Sobald das Koppel-Sheet ohne Code offen ist: verbundene Bildschirme zeigen.
  useEffect(() => {
    if (pairOpen && !pairCode) loadMonitors()
  }, [pairOpen, pairCode, loadMonitors])

  const confirmPair = useCallback(async () => {
    if (!pairCode) return
    setPairState('confirming')
    try {
      const r = await fetch('/api/deck/pair/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: pairCode, name: pairName }),
      })
      if (r.ok) {
        setPairState('done')
        window.history.replaceState({}, '', '/remote')
        setTimeout(() => { setPairCode(null); setPairName(''); setPairState('idle'); setPairOpen(false) }, 2200)
      } else setPairState('error')
    } catch { setPairState('error') }
  }, [pairCode, pairName])

  const dismissPair = useCallback(() => {
    setPairCode(null); setPairName(''); setPairState('idle')
    window.history.replaceState({}, '', '/remote')
  }, [])

  // Manueller Weg: Christian tippt die Zahl vom TV ein. Robuster als Scannen,
  // weil die App eingeloggt ist (anders als die native Kamera, die Safari öffnet).
  const confirmCode = useCallback(async (raw: string) => {
    const code = raw.trim()
    if (!code) return
    setPairCode(code); setPairState('confirming'); setManual('')
    try {
      const r = await fetch('/api/deck/pair/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: code, name: pairName }),
      })
      if (r.ok) {
        setPairState('done')
        setTimeout(() => { setPairCode(null); setPairName(''); setPairState('idle'); setPairOpen(false) }, 2200)
      } else setPairState('error')
    } catch { setPairState('error') }
  }, [pairName])

  // Einen Bildschirm gezielt trennen (per id aus der Liste).
  const revokeOne = useCallback(async (id: string, name: string) => {
    try {
      const r = await fetch('/api/deck/monitors/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (r.ok) { showFlash(`${name} getrennt`, 'ok', 1600); loadMonitors() }
      else showFlash('Trennen fehlgeschlagen', 'err')
    } catch { showFlash('Netzwerkfehler beim Trennen', 'err') }
  }, [showFlash, loadMonitors])

  // Modus eines Bildschirms umschalten (Chat ⇄ Fokus). Optimistisch setzen,
  // damit der Schalter sofort reagiert, der TV zieht nach beim nächsten Poll.
  const setMonitorMode = useCallback(async (id: string, mode: 'chat' | 'fokus') => {
    setMonitors(prev => prev.map(m => m.id === id ? { ...m, mode } : m))
    try {
      await fetch('/api/deck/monitors/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mode }),
      })
    } catch { showFlash('Umschalten fehlgeschlagen', 'err') }
  }, [showFlash])

  // Alle gekoppelten Bildschirme auf einmal trennen.
  const disconnectAll = useCallback(async () => {
    try {
      const r = await fetch('/api/deck/disconnect-all', { method: 'POST' })
      const d = await r.json()
      if (r.ok) { showFlash(d.disconnected ? `${d.disconnected} Bildschirm${d.disconnected > 1 ? 'e' : ''} getrennt` : 'Kein Bildschirm verbunden', 'ok'); loadMonitors() }
      else showFlash(d.error || 'Trennen fehlgeschlagen', 'err')
    } catch { showFlash('Netzwerkfehler beim Trennen', 'err') }
  }, [showFlash, loadMonitors])

  // ── QR-Scan: Kamera öffnen, Frames durch jsQR, pair-Code aus der URL ziehen ──
  const stopScan = useCallback(() => {
    if (scanRafRef.current) { cancelAnimationFrame(scanRafRef.current); scanRafRef.current = null }
    if (scanStreamRef.current) { scanStreamRef.current.getTracks().forEach(t => t.stop()); scanStreamRef.current = null }
    scanTrackRef.current = null
    hwZoomRef.current = false
    zoomRef.current = 1
    setZoom(1); setHwZoom(false)
    setScanning(false)
  }, [])

  // Zoom: echtes Hardware-Zoom wo das Gerät es kann, sonst digital (Center-Crop).
  const applyZoom = useCallback((z: number) => {
    setZoom(z); zoomRef.current = z
    if (hwZoomRef.current && scanTrackRef.current) {
      try { scanTrackRef.current.applyConstraints({ advanced: [{ zoom: z }] } as any) } catch {}
    }
  }, [])

  const startScan = useCallback(async () => {
    setScanning(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      scanStreamRef.current = stream
      const track = stream.getVideoTracks()[0]
      scanTrackRef.current = track
      const caps: any = track?.getCapabilities ? track.getCapabilities() : {}
      if (caps?.zoom && caps.zoom.max > caps.zoom.min) {
        hwZoomRef.current = true; setHwZoom(true); setZoomMax(Math.min(caps.zoom.max, 6))
      } else {
        hwZoomRef.current = false; setHwZoom(false); setZoomMax(3)
      }
      zoomRef.current = 1; setZoom(1)
      const video = videoRef.current
      if (!video) { stopScan(); return }
      video.srcObject = stream
      await video.play()
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const tick = () => {
        if (!scanStreamRef.current || !ctx) return
        if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
          let sw = video.videoWidth, sh = video.videoHeight, sx = 0, sy = 0
          if (!hwZoomRef.current && zoomRef.current > 1) {
            sw = Math.round(video.videoWidth / zoomRef.current)
            sh = Math.round(video.videoHeight / zoomRef.current)
            sx = Math.round((video.videoWidth - sw) / 2)
            sy = Math.round((video.videoHeight - sh) / 2)
          }
          canvas.width = sw
          canvas.height = sh
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
          const img = ctx.getImageData(0, 0, sw, sh)
          const code = jsQR(img.data, img.width, img.height)
          if (code?.data) {
            let pair: string | null = null
            try { pair = new URL(code.data).searchParams.get('pair') } catch {}
            if (pair) { stopScan(); setPairCode(pair); setPairState('idle'); setPairOpen(true); return }
          }
        }
        scanRafRef.current = requestAnimationFrame(tick)
      }
      scanRafRef.current = requestAnimationFrame(tick)
    } catch {
      stopScan()
      showFlash('Kamera nicht verfügbar', 'err', 2500)
    }
  }, [stopScan, showFlash])

  const titleFor = useCallback((s: Slot, i: number) => {
    if (!s.convId) return `Slot ${i + 1}`
    return convMeta[s.convId] || `Chat ${i + 1}`
  }, [convMeta])

  // ── Slots laden + live spiegeln ──
  const applyServerState = useCallback((d: any) => {
    const incoming = Array.isArray(d?.slots) ? d.slots : []
    const padded: Slot[] = Array.from({ length: MAX_SLOTS }, (_, i) => {
      const s = incoming[i]
      return { agent: String(s?.agent || 'main'), convId: String(s?.convId || '') }
    })
    setSlots(padded)
    if (typeof d?.activeSlot === 'number') setActiveSlot(Math.max(0, Math.min(d.activeSlot, MAX_SLOTS - 1)))
  }, [])

  useEffect(() => {
    fetch('/api/slots').then(r => r.json()).then(applyServerState).catch(() => {})
    fetch('/api/conversations?limit=0').then(r => r.json()).then(d => {
      const map: Record<string, string> = {}
      const list: { id: string; title: string }[] = []
      for (const c of (d.conversations || [])) {
        map[c.id] = c.title || ''
        list.push({ id: c.id, title: c.title || '' })
      }
      setConvMeta(map)
      setConvList(list)
    }).catch(() => {})
    // Schon laufende Sessions beim Öffnen übernehmen (das WS bringt nur neue Starts).
    fetch('/api/active-streams').then(r => r.json()).then(d => {
      const m: Record<string, number> = {}
      for (const s of (d.streams || [])) if (s.convId) m[s.convId] = s.startedAt || Date.now()
      setBusyConvs(m)
    }).catch(() => {})
  }, [applyServerState])

  // Queue-Counts pro Chat (wartende Nachrichten) — simpel gepollt, als Badge
  // auf der Kachel sichtbar. Ändert sich selten, alle 4s reicht.
  useEffect(() => {
    const pull = () => fetch('/api/message-queue/counts').then(r => r.json())
      .then(d => setQueueCounts(d.counts || {})).catch(() => {})
    pull()
    const t = setInterval(pull, 4000)
    return () => clearInterval(t)
  }, [])

  // Eigene leichte WS nur für slots.update — bringt activeSlot + slots live,
  // ohne geteilten Code (ChatPane/App/Mobile) anzufassen.
  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(`${proto}//${location.host}/ws`)
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'slots.update' && msg.source !== 'remote') applyServerState(msg)
          else if (msg.type === 'stream.state' && msg.conversationId) {
            const cid = msg.conversationId as string
            if (msg.phase === 'start') {
              const at = typeof msg.startedAt === 'number' ? msg.startedAt : Date.now()
              setBusyConvs(b => ({ ...b, [cid]: at }))
              setDoneConvs(d => { if (!(cid in d)) return d; const n = { ...d }; delete n[cid]; return n })
            } else {
              setBusyConvs(b => { if (!(cid in b)) return b; const n = { ...b }; delete n[cid]; return n })
              setDoneConvs(d => ({ ...d, [cid]: Date.now() }))
            }
          }
        } catch {}
      }
      ws.onclose = () => { if (!closed) setTimeout(connect, 2000) }
      ws.onerror = () => { try { ws?.close() } catch {} }
    }
    connect()
    return () => { closed = true; try { ws?.close() } catch {} }
  }, [applyServerState])

  // Wiedergabe-Status live spiegeln (Position fürs Scrubben, Pause-Zustand).
  useEffect(() => audioQueue.subscribe(setPlayback), [])

  // Ziel merken; im TV-Modus den Monitor-Wiedergabestatus pollen. Eine kurze
  // Schonfrist nach dem Start-Befehl hält die Leiste stehen, bis der TV sein
  // erstes „playing" gemeldet hat (sonst flackert sie beim optimistischen Start).
  useEffect(() => { localStorage.setItem('deck:audioTarget', audioTarget) }, [audioTarget])
  useEffect(() => {
    if (audioTarget !== 'tv') return
    const pull = () => {
      if (document.hidden) return
      fetch('/api/deck/audio').then(r => r.json()).then((d) => {
        setTvAudio((prev) => {
          const next = { state: (d.state || 'idle') as 'idle' | 'playing' | 'paused', t: d.t || 0, dur: d.dur || 0, convId: d.convId || '' }
          if (next.state === 'idle' && prev.state !== 'idle' && Date.now() < speakGraceRef.current) return prev
          return next
        })
      }).catch(() => {})
    }
    pull()
    const id = setInterval(pull, 1500)
    return () => clearInterval(id)
  }, [audioTarget])

  const selectSlot = useCallback((i: number) => {
    setActiveSlot(i)
    setSlots(cur => {
      fetch('/api/slots', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: cur, activeSlot: i, source: 'remote' }),
      }).catch(() => {})
      return cur
    })
  }, [])

  // Chat einer Kachel zuweisen (Picker). Setzt die convId des Slots, macht ihn
  // aktiv und spiegelt das wie selectSlot an den Server.
  const assignConv = useCallback((slotIdx: number, convId: string) => {
    setActiveSlot(slotIdx)
    setPickerSlot(null)
    setSlots(cur => {
      const next = cur.map((s, i) => i === slotIdx ? { ...s, convId } : s)
      fetch('/api/slots', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots: next, activeSlot: slotIdx, source: 'remote' }),
      }).catch(() => {})
      return next
    })
  }, [])

  // ── Aufnahme ──
  const sendTranscript = useCallback(async (text: string) => {
    const pane = activeSlotRef.current + 1
    try {
      await fetch('/api/deck/pane-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pane, text }),
      })
      showFlash('Gesendet', 'ok', 1600)
    } catch {}
  }, [showFlash])

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    recorderRef.current = null
    setRecording(false)
    setPaused(false)
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
  }, [])

  // Pause/Weiter während der Aufnahme. Der Recorder hält den Stream offen,
  // der Timer friert mit ein. Senden geht auch aus dem pausierten Zustand.
  const togglePause = useCallback(() => {
    const rec = recorderRef.current
    if (!rec) return
    if (rec.state === 'recording') { rec.pause(); setPaused(true) }
    else if (rec.state === 'paused') { rec.resume(); setPaused(false) }
  }, [])

  const startRecording = useCallback(async () => {
    if (transcribing) return
    cancelledRef.current = false
    setRecording(true)
    setPaused(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = async () => {
        if (cancelledRef.current) { cancelledRef.current = false; chunksRef.current = []; return }
        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []
        if (blob.size < 1000) return
        setTranscribing(true)
        const ext = mimeType.includes('webm') ? '.webm' : '.m4a'
        let text = ''
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const form = new FormData()
            form.append('file', blob, `voice${ext}`)
            const res = await fetch('/api/transcribe', { method: 'POST', body: form })
            if (res.ok) { text = ((await res.json()).text || '').trim(); break }
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
              await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt))); continue
            }
            break
          } catch { await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt))) }
        }
        setTranscribing(false)
        if (text) sendTranscript(text)
        else showFlash('Nichts erkannt', 'err', 2500)
      }
      recorderRef.current = recorder
      recorder.start()
    } catch {
      setRecording(false)
      showFlash('Mikro nicht verfügbar', 'err', 2500)
    }
  }, [transcribing, sendTranscript, showFlash])

  const cancelRecording = useCallback(() => { cancelledRef.current = true; stopRecording() }, [stopRecording])

  // Tap-Logik auf einer Kachel: inaktiv → aktivieren, aktiv → aufnehmen,
  // läuft gerade → stoppen und senden. Andere Kacheln sind während der
  // Aufnahme gesperrt, damit nichts versehentlich verlorengeht.
  const handleTile = useCallback((i: number) => {
    if (transcribing) return
    if (recording) { if (i === activeSlot) stopRecording(); return }
    if (i !== activeSlot) { selectSlot(i); return }
    startRecording()
  }, [recording, transcribing, activeSlot, stopRecording, selectSlot, startRecording])

  // ── Wisch-zum-Scrollen: relative Pixel-Deltas gebündelt an den Monitor ──
  const flushScroll = useCallback(() => {
    if (scrollFlushRef.current) { clearTimeout(scrollFlushRef.current); scrollFlushRef.current = null }
    const dy = scrollAccumRef.current
    if (!dy) return
    scrollAccumRef.current = 0
    const pane = activeSlotRef.current + 1
    fetch('/api/deck/scroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pane, dy }),
    }).catch(() => {})
  }, [])

  const queueScroll = useCallback((dy: number) => {
    scrollAccumRef.current += dy
    if (!scrollFlushRef.current) scrollFlushRef.current = setTimeout(flushScroll, 80)
  }, [flushScroll])

  // Bewegung über dieser Schwelle (px) gilt als Wisch, nicht als Tipp — so löst
  // Scrollen nie versehentlich die Aufnahme aus.
  const MOVE_THRESHOLD = 9

  const onTilePointerDown = useCallback((e: ReactPointerEvent, i: number) => {
    gestureRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, moved: false, slot: i }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
  }, [])

  const onTilePointerMove = useCallback((e: ReactPointerEvent) => {
    const g = gestureRef.current
    if (!g || g.id !== e.pointerId) return
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > MOVE_THRESHOLD) g.moved = true
    // Scrollen nur auf der aktiven Kachel, sonst tut ein Wisch nichts.
    if (g.moved && g.slot === activeSlotRef.current) {
      const dy = g.lastY - e.clientY
      g.lastY = e.clientY
      if (dy) queueScroll(dy)
    }
  }, [queueScroll])

  const onTilePointerUp = useCallback((e: ReactPointerEvent, i: number) => {
    const g = gestureRef.current
    gestureRef.current = null
    flushScroll()
    if (!g || g.id !== e.pointerId) return
    if (!g.moved) handleTile(i)  // sauberer Tipp ohne Wisch
  }, [flushScroll, handleTile])

  // Aufnahme-Zähler (mm:ss): bei Aufnahmeende zurück auf 0, beim Pausieren
  // friert er ein (kein Tick), beim Fortsetzen läuft er weiter.
  useEffect(() => { if (!recording) setRecElapsed(0) }, [recording])
  useEffect(() => {
    if (!recording || paused) return
    const t = setInterval(() => setRecElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [recording, paused])

  useEffect(() => () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop())
    if (scanStreamRef.current) scanStreamRef.current.getTracks().forEach(t => t.stop())
    if (scanRafRef.current) cancelAnimationFrame(scanRafRef.current)
    if (scrollFlushRef.current) clearTimeout(scrollFlushRef.current)
  }, [])

  // Display wach halten, solange die Remote offen ist — sonst geht der
  // Bildschirm beim Reden aus. Wird beim App-Wechsel automatisch gelöst,
  // darum bei Rückkehr neu anfordern.
  useEffect(() => {
    let lock: any = null
    let released = false
    const request = async () => {
      try { lock = await (navigator as any).wakeLock?.request('screen') } catch {}
    }
    request()
    const onVis = () => { if (document.visibilityState === 'visible' && !released) request() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVis)
      try { lock?.release() } catch {}
    }
  }, [])

  // Solange irgendein Chat arbeitet (oder ein Haken noch steht): jede Sekunde
  // neu rendern, damit der Zähler läuft. Haken nach 4s wieder ausblenden.
  useEffect(() => {
    if (!Object.keys(busyConvs).length && !Object.keys(doneConvs).length) return
    const t = setInterval(() => {
      setTick(x => x + 1)
      setDoneConvs(d => {
        const now = Date.now()
        let changed = false
        const n: Record<string, number> = {}
        for (const k in d) { if (now - d[k] < 4000) n[k] = d[k]; else changed = true }
        return changed ? n : d
      })
    }, 1000)
    return () => clearInterval(t)
  }, [busyConvs, doneConvs])

  const fmtSec = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const statusFor = (convId: string): { kind: 'busy'; sec: number } | { kind: 'done' } | null => {
    if (!convId) return null
    if (busyConvs[convId]) return { kind: 'busy', sec: Math.max(0, Math.floor((Date.now() - busyConvs[convId]) / 1000)) }
    if (doneConvs[convId]) return { kind: 'done' }
    return null
  }

  const stopConv = useCallback(async (convId: string) => {
    if (!convId) return
    try {
      await fetch('/api/deck/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convId }),
      })
      showFlash('Gestoppt', 'ok', 1600)
    } catch {}
  }, [showFlash])

  // Vorlese-Befehl an den Monitor (Befehlskanal, der TV holt sich das Audio selbst).
  const sendSpeak = useCallback((action: string, extra: Record<string, unknown> = {}) => {
    fetch('/api/deck/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    }).catch(() => {})
  }, [])

  // Letzte Agent-Nachricht des Chats vorlesen. Ziel ist TV oder Handy: beim Handy
  // spielt der lokale audioQueue (Standardstimme = leere Voice-ID), beim TV geht
  // der Befehl an den Monitor. Erneutes Tippen auf den schon laufenden Chat = Stopp.
  // warmUp() läuft synchron im Tap, damit iOS das Audio-Element freigibt.
  const speakLast = useCallback(async (convId: string, agent: string) => {
    if (!convId) return
    const tvBusy = tvAudio.state !== 'idle' && tvAudio.convId === convId
    const phoneBusy = playback.playingConversationId === convId
    if (audioTarget === 'tv' ? tvBusy : phoneBusy) {
      if (audioTarget === 'tv') { sendSpeak('stop'); setTvAudio(a => ({ ...a, state: 'idle', convId: '' })) }
      else audioQueue.stopAll()
      return
    }
    if (audioTarget === 'phone') audioQueue.warmUp()
    try {
      const r = await fetch(`/api/history?conversation_id=${encodeURIComponent(convId)}&limit=12`).then(r => r.json())
      const msgs: any[] = r.messages || []
      const last = [...msgs].reverse().find(m => m.author !== 'Du' && (m.content || '').trim())
      const clean = last ? cleanForTTS(last.content) : ''
      if (!clean) { showFlash('Nichts zum Vorlesen', 'err', 2000); return }
      const voiceId = localStorage.getItem('control:voice')
        || localStorage.getItem(`control:voice:${agent}`)
        || undefined
      if (audioTarget === 'tv') {
        speakGraceRef.current = Date.now() + 1800
        sendSpeak('play', { convId, text: clean, voiceId: voiceId || '' })
        setTvAudio({ state: 'playing', t: 0, dur: 0, convId })
        return
      }
      let voiceSettings: audioQueue.SpeakRequest['voiceSettings']
      if (voiceId) {
        try { const raw = localStorage.getItem(`control:voiceSettings:${voiceId}`); if (raw) voiceSettings = JSON.parse(raw) } catch {}
      }
      audioQueue.playNow({ text: clean, agentName: agent, ts: last.ts, conversationId: convId, source: 'manual', voiceId: voiceId || undefined, voiceSettings })
    } catch { showFlash('Vorlesen fehlgeschlagen', 'err', 2000) }
  }, [audioTarget, tvAudio.state, tvAudio.convId, playback.playingConversationId, showFlash, sendSpeak])

  const mmss = `${Math.floor(recElapsed / 60)}:${String(recElapsed % 60).padStart(2, '0')}`
  // Wiedergabe-Uhr (m:ss) für die Transportleiste.
  const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const isPlaying = !!playback.playingConversationId
  // Eine Transportleiste für beide Ziele: Werte und Befehle nach Quelle wählen.
  const tvOn = audioTarget === 'tv'
  const transportActive = tvOn ? tvAudio.state !== 'idle' : isPlaying
  const tPaused = tvOn ? tvAudio.state === 'paused' : playback.audioPaused
  const tDur = tvOn ? tvAudio.dur : (playback.audioDuration || 0)
  const tPos = seekDrag != null ? seekDrag : (tvOn ? tvAudio.t : playback.audioTime)
  const transportToggle = () => { if (tvOn) sendSpeak(tvAudio.state === 'paused' ? 'resume' : 'pause'); else audioQueue.togglePlayback() }
  const activePane = slots[activeSlot]
  const activeCanSpeak = !!activePane?.convId && !recording && !transcribing
  const activeSpeaking = !!activePane?.convId && (tvOn ? (tvAudio.state !== 'idle' && tvAudio.convId === activePane.convId) : (playback.playingConversationId === activePane.convId))

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'var(--bg)', color: 'var(--t1)',
        display: 'flex', flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top, 0px)', paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        fontFamily: 'var(--font-body, system-ui)', userSelect: 'none', WebkitUserSelect: 'none',
      }}
    >
      {/* QR-Scan-Overlay: Kamera live, sucht den Deck-Code */}
      {scanning && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50, background: '#000',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        }}>
          <video
            ref={videoRef}
            playsInline muted
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
              transform: !hwZoom && zoom > 1 ? `scale(${zoom})` : undefined, transformOrigin: 'center',
            }}
          />
          <div style={{
            position: 'relative', width: 260, height: 260, borderRadius: 24,
            border: `3px solid ${ACCENT}`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
          }} />
          <div style={{ position: 'absolute', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 40px)', textAlign: 'center', width: '100%', padding: '0 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', maxWidth: 320, margin: '0 auto 18px' }}>
              <span style={{ color: '#fff', fontSize: 22, fontWeight: 600, width: 18 }}>−</span>
              <input
                type="range" min={1} max={zoomMax} step={0.1} value={zoom}
                onChange={(e) => applyZoom(Number(e.target.value))}
                style={{ flex: 1, accentColor: ACCENT, height: 28 }}
                aria-label="Zoom"
              />
              <span style={{ color: '#fff', fontSize: 22, fontWeight: 600, width: 18 }}>+</span>
            </div>
            <div style={{ color: '#fff', fontSize: 16, marginBottom: 16 }}>Den QR auf dem Monitor anvisieren</div>
            <button
              onClick={stopScan}
              style={{
                padding: '12px 28px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.3)',
                background: 'rgba(0,0,0,0.4)', color: '#fff', fontSize: 15, fontWeight: 600,
                cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
              }}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Hero-Linie: gleiche Höhe und Logik wie die Mobile-App (MobileTopMarker) —
          dünn, dicht unter der Safe-Area, 13px in --t3. Links zurück in den Chat,
          rechts Monitor koppeln. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: '2px 20px 5px' }}>
        <button
          onClick={() => { window.location.href = '/mobile' }}
          style={{
            justifySelf: 'start',
            display: 'flex', alignItems: 'center', gap: 3, padding: '4px 6px 4px 0',
            border: 'none', background: 'transparent', color: 'var(--t3)', fontSize: 13, letterSpacing: '0.02em',
            cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
          }}
          aria-label="Zurück zum Chat"
        >
          <ChevronLeft size={18} /> Chat
        </button>
        {/* Vorlesen ist ein globaler Transport für die aktive Kachel. Nur der
            Start-Knopf lebt im Kopf, ruhig als Glas. Die Ziel-Wahl (Handy/TV)
            erscheint erst in der Transportleiste, sobald wirklich vorgelesen wird. */}
        <button
          onClick={() => activeCanSpeak && speakLast(activePane.convId, activePane.agent)}
          disabled={!activeCanSpeak}
          aria-label={activeSpeaking ? 'Vorlesen stoppen' : 'Aktiven Chat vorlesen'}
          style={{
            justifySelf: 'center',
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 30, borderRadius: 999,
            border: 'none', cursor: activeCanSpeak ? 'pointer' : 'default', WebkitTapHighlightColor: 'transparent',
            background: activeSpeaking ? 'rgba(217,119,87,0.16)' : 'rgba(255,255,255,0.06)',
            color: activeSpeaking ? ACCENT : activeCanSpeak ? 'var(--t1)' : 'var(--t3)',
            opacity: activeCanSpeak ? 1 : 0.38,
          }}
        >
          {activeSpeaking ? <Square size={15} fill="currentColor" /> : <Volume2 size={17} />}
        </button>
        <button
          onClick={() => setPairOpen(o => !o)}
          style={{
            justifySelf: 'end',
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0 4px 6px',
            border: 'none', background: 'transparent', fontSize: 13, letterSpacing: '0.02em', cursor: 'pointer',
            color: pairOpen ? ACCENT : 'var(--t3)', WebkitTapHighlightColor: 'transparent',
          }}
          aria-label="Monitor koppeln"
        >
          <QrCode size={17} /> Koppeln
        </button>
      </div>

      {/* Koppel-Sheet: zentriertes Overlay über der Leinwand. Seltener
          Setup-Schritt, darum als ruhige Karte mit Backdrop statt Inline-Zeile. */}
      {pairOpen && (
        <div
          onClick={() => { if (pairState !== 'confirming') { setPairOpen(false); dismissPair() } }}
          style={{
            position: 'fixed', inset: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '24px', background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative', width: '100%', maxWidth: 340, borderRadius: 24, padding: '28px 24px 24px',
              background: 'var(--panel, #1a1a1a)', border: '1px solid var(--line, rgba(255,255,255,0.12))',
              boxShadow: '0 24px 60px rgba(0,0,0,0.55)', textAlign: 'center',
            }}
          >
            <button
              onClick={() => { setPairOpen(false); dismissPair() }}
              style={{
                position: 'absolute', top: 12, right: 12, width: 34, height: 34, display: 'flex', alignItems: 'center',
                justifyContent: 'center', borderRadius: 999, border: 'none', background: 'transparent',
                color: 'var(--t3)', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
              }}
              aria-label="Schließen"
            >
              <X size={22} />
            </button>

            {pairCode ? (
              <>
                <div style={{
                  width: 52, height: 52, margin: '0 auto 16px', borderRadius: 999, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: pairState === 'done' ? ACCENT : 'rgba(217,119,87,0.14)',
                  color: pairState === 'done' ? '#fff' : ACCENT,
                }}>
                  {pairState === 'done' ? <Check size={30} strokeWidth={2.6} /> : <QrCode size={28} />}
                </div>
                <div style={{ fontSize: 19, fontWeight: 600, color: 'var(--t1)', marginBottom: 6 }}>
                  {pairState === 'done' ? 'Monitor freigeschaltet' : pairState === 'error' ? 'Fehlgeschlagen' : 'Monitor koppeln'}
                </div>
                <div style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.4, marginBottom: 22 }}>
                  {pairState === 'done' ? 'Du steuerst diesen Bildschirm jetzt.'
                    : pairState === 'error' ? 'Hat nicht geklappt, versuch es nochmal.'
                    : 'Code ' + pairCode + ' diesen Bildschirm freischalten?'}
                </div>
                {pairState !== 'done' && (
                  <>
                    <input
                      value={pairName}
                      onChange={(e) => setPairName(e.target.value.slice(0, 24))}
                      placeholder="Name, z. B. Wohnzimmer"
                      enterKeyHint="done"
                      style={{
                        width: '100%', minHeight: 48, borderRadius: 14, padding: '0 16px', fontSize: 16,
                        textAlign: 'center', marginBottom: 12,
                        border: '1px solid var(--line, rgba(255,255,255,0.14))',
                        background: 'var(--bg, rgba(255,255,255,0.03))', color: 'var(--t1)',
                      }}
                    />
                    <button
                      onClick={confirmPair}
                      disabled={pairState === 'confirming'}
                      style={{
                        width: '100%', minHeight: 50, borderRadius: 14, border: 'none', background: ACCENT, color: '#fff',
                        fontSize: 16, fontWeight: 600, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                        opacity: pairState === 'confirming' ? 0.6 : 1,
                      }}
                    >
                      {pairState === 'confirming' ? 'Schalte frei…' : 'Freischalten'}
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                {monitors.length > 0 && (
                  <div style={{ marginBottom: 24 }}>
                    <div style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)', textAlign: 'left', marginBottom: 12 }}>
                      Verbundene Bildschirme
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {monitors.map((m) => (
                        <div key={m.id} style={{
                          display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', borderRadius: 14,
                          background: 'var(--bg, rgba(255,255,255,0.03))',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10,
                              background: 'rgba(217,119,87,0.12)', color: ACCENT, flexShrink: 0,
                            }}>
                              <Monitor size={20} />
                            </span>
                            <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                              <div style={{ fontSize: 13, color: 'var(--t3)' }}>seit {new Date(m.created * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div>
                            </div>
                            <button
                              onClick={() => revokeOne(m.id, m.name)}
                              aria-label={`${m.name} trennen`}
                              style={{
                                flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 999,
                                border: '1px solid var(--line, rgba(255,255,255,0.14))', background: 'transparent', color: 'var(--t3)',
                                cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                              }}
                            >
                              <X size={18} />
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 11, background: 'rgba(255,255,255,0.05)' }}>
                            {(['chat', 'fokus'] as const).map((mo) => {
                              const on = (m.mode || 'chat') === mo
                              return (
                                <button key={mo} onClick={() => setMonitorMode(m.id, mo)} style={{
                                  flex: 1, padding: '7px 0', borderRadius: 9, border: 'none', cursor: 'pointer',
                                  fontSize: 13, fontWeight: 600, WebkitTapHighlightColor: 'transparent',
                                  background: on ? 'rgba(217,119,87,0.16)' : 'transparent',
                                  color: on ? ACCENT : 'var(--t3)',
                                }}>
                                  {mo === 'chat' ? 'Chat' : 'Fokus'}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    {monitors.length > 1 && (
                      <button
                        onClick={disconnectAll}
                        style={{
                          display: 'block', margin: '14px auto 0', padding: '6px 12px', border: 'none', background: 'transparent',
                          color: 'var(--t3)', fontSize: 13, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                        }}
                      >
                        Alle trennen
                      </button>
                    )}
                  </div>
                )}
                <div style={{ fontSize: 19, fontWeight: 600, color: 'var(--t1)', marginBottom: 6 }}>
                  {monitors.length > 0 ? 'Weiteren koppeln' : 'Monitor koppeln'}
                </div>
                <div style={{ fontSize: 14, color: 'var(--t3)', lineHeight: 1.4, marginBottom: 22 }}>
                  Code vom Bildschirm eintippen
                </div>
                <form onSubmit={(e) => { e.preventDefault(); confirmCode(manual) }}>
                  <input
                    value={manual}
                    onChange={(e) => setManual(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="– – – – – –"
                    autoFocus
                    style={{
                      width: '100%', minHeight: 64, borderRadius: 16, padding: '0 14px', fontSize: 30, fontWeight: 600,
                      letterSpacing: '0.4em', textIndent: '0.4em', textAlign: 'center',
                      border: '1px solid var(--line, rgba(255,255,255,0.14))',
                      background: 'var(--bg, rgba(255,255,255,0.03))', color: 'var(--t1)', marginBottom: 14,
                    }}
                  />
                  <button
                    type="submit"
                    disabled={manual.length < 6}
                    style={{
                      width: '100%', minHeight: 50, borderRadius: 14, border: 'none', background: ACCENT, color: '#fff',
                      fontSize: 16, fontWeight: 600, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                      opacity: manual.length < 6 ? 0.4 : 1,
                    }}
                  >
                    Koppeln
                  </button>
                </form>
                <button
                  type="button"
                  onClick={startScan}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7, margin: '16px auto 0', padding: '8px 14px',
                    borderRadius: 999, border: 'none', background: 'transparent', color: 'var(--t3)',
                    fontSize: 14, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  <QrCode size={19} /> Stattdessen QR scannen
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Status-Streifen: zeigt nur Aktivität, sonst still. Der Zielchat steht
          markiert in seiner Kachel — darum hier kein Name, kein Hinweis. So
          bekommen die Kacheln den ganzen Platz. */}
      <div style={{ flex: '0 0 auto', minHeight: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 24px 4px' }}>
        {recording ? (
          // Drei Spalten 1fr auto 1fr: der Timer sitzt in der auto-Mitte und ist
          // damit exakt bildschirmzentriert, egal wie breit die Buttons sind.
          // Pause klebt rechtsbündig in der linken Spalte, Abbrechen linksbündig
          // in der rechten, beide gleich groß und so perfekt symmetrisch zum Timer.
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', width: '100%', maxWidth: 420, gap: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={togglePause}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 999,
                  border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                }}
                aria-label={paused ? 'Weiter aufnehmen' : 'Pause'}
              >
                {paused ? <Play size={22} fill="currentColor" /> : <Pause size={22} fill="currentColor" />}
              </button>
            </div>
            <span className={paused ? 'tabular-nums' : 'tabular-nums status-shimmer'} style={{
              fontSize: 38, fontWeight: 600, color: paused ? 'var(--t2, var(--t3))' : 'var(--t1)',
              fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '0.01em', textAlign: 'center',
            }}>
              {mmss}
            </span>
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <button
                onClick={cancelRecording}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 999,
                  border: '1px solid var(--line, rgba(255,255,255,0.15))', background: 'transparent',
                  color: 'var(--t3)', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                }}
                aria-label="Aufnahme verwerfen"
              >
                <X size={20} />
              </button>
            </div>
          </div>
        ) : transcribing ? (
          <span className="status-shimmer" style={{ fontSize: 24, fontWeight: 500 }}>Verarbeite…</span>
        ) : transportActive ? (
          // Transportleiste fürs Vorlesen: Play/Pause links, Scrubber zum Vorspulen
          // in der Mitte, Position rechts. Speist sich aus Handy oder TV, je nach Ziel.
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', maxWidth: 460 }}>
            <button
              onClick={transportToggle}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 999, flexShrink: 0,
                border: 'none', background: 'rgba(255,255,255,0.06)', color: 'var(--t1)', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
              }}
              aria-label={tPaused ? 'Weiter vorlesen' : 'Vorlesen pausieren'}
            >
              {tPaused ? <Play size={22} fill="currentColor" /> : <Pause size={22} fill="currentColor" />}
            </button>
            <input
              type="range" min={0} max={tDur || 0} step={0.1}
              value={Math.min(tPos, tDur || tPos)}
              onChange={(e) => { const v = Number(e.target.value); setSeekDrag(v); if (!tvOn) audioQueue.seek(v) }}
              onPointerUp={() => { if (tvOn && seekDrag != null) sendSpeak('seek', { t: seekDrag }); setSeekDrag(null) }}
              onPointerCancel={() => setSeekDrag(null)}
              style={{ flex: 1, accentColor: ACCENT, height: 28 }}
              aria-label="Vorspulen"
            />
            <span className="tabular-nums" style={{ fontSize: 15, fontWeight: 600, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>
              {fmtClock(tPos)}
            </span>
            {/* Ziel-Wahl: erscheint erst hier, während vorgelesen wird. Gedämpftes
                Glas-Segment statt Vollton. Umschalten merkt sich der nächste Start. */}
            <div style={{ display: 'flex', gap: 3, padding: 2, borderRadius: 999, background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}>
              {(['phone', 'tv'] as const).map((key) => {
                const on = audioTarget === key
                const Icon = key === 'tv' ? Monitor : Smartphone
                return (
                  <button
                    key={key}
                    onClick={() => setAudioTarget(key)}
                    aria-label={key === 'tv' ? 'Vorlesen über den TV' : 'Vorlesen über das Handy'}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 26, borderRadius: 999,
                      border: 'none', cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                      background: on ? 'rgba(217,119,87,0.16)' : 'transparent', color: on ? ACCENT : 'var(--t3)',
                    }}
                  >
                    <Icon size={16} />
                  </button>
                )
              })}
            </div>
          </div>
        ) : flash ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 999, flexShrink: 0,
              background: flash.kind === 'ok' ? ACCENT : 'rgba(214,109,99,0.16)',
              color: flash.kind === 'ok' ? '#fff' : '#d66d63',
            }}>
              {flash.kind === 'ok' ? <Check size={23} strokeWidth={2.6} /> : <X size={23} strokeWidth={2.6} />}
            </span>
            <span style={{ fontSize: 24, fontWeight: 500, color: 'var(--t1)' }}>{flash.text}</span>
          </div>
        ) : null}
      </div>

      {/* Daumenzone: vier Zielchat-Kacheln = Aufnahme-Knopf in einem.
          Füllen fast die ganze Fläche, maximale Tap-Fläche für den Daumen. */}
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 12, padding: '4px 12px 14px' }}>
        {slots.map((s, i) => {
          const isActive = i === activeSlot
          const isRec = isActive && recording
          const dimmed = recording && !isActive
          const st = statusFor(s.convId)
          const qc = s.convId ? (queueCounts[s.convId] || 0) : 0
          return (
            <button
              key={i}
              onPointerDown={(e) => onTilePointerDown(e, i)}
              onPointerMove={onTilePointerMove}
              onPointerUp={(e) => onTilePointerUp(e, i)}
              onPointerCancel={() => { gestureRef.current = null }}
              disabled={dimmed}
              style={{
                height: '100%', minHeight: 0, minWidth: 0, borderRadius: 22, padding: '20px 22px', textAlign: 'left',
                border: isActive ? `1.5px solid ${ACCENT}` : '1px solid var(--line, rgba(255,255,255,0.1))',
                background: isRec ? ACCENT : isActive ? 'rgba(217,119,87,0.1)' : 'var(--panel, rgba(255,255,255,0.04))',
                color: isRec ? '#fff' : 'var(--t1)', cursor: dimmed ? 'default' : 'pointer',
                opacity: dimmed ? 0.35 : 1, WebkitTapHighlightColor: 'transparent', touchAction: 'none',
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                boxShadow: isRec ? '0 0 0 7px rgba(217,119,87,0.18)' : 'none',
                transition: 'background 0.15s, box-shadow 0.15s, opacity 0.15s',
              }}
            >
              <span style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                fontSize: 23, fontWeight: 700, color: isRec ? 'rgba(255,255,255,0.85)' : isActive ? ACCENT : 'var(--t3)',
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span>{i + 1}</span>
                  {qc > 0 && (
                    <span className="tabular-nums" style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minWidth: 26, height: 26, padding: '0 7px', borderRadius: 999, fontSize: 15, fontWeight: 600,
                      background: isRec ? '#fff' : 'var(--t1)', color: isRec ? ACCENT : 'var(--panel, #1a1a1a)',
                      opacity: isRec ? 1 : 0.55,
                    }}>{qc}</span>
                  )}
                </span>
                {/* Rechte Statusecke: arbeitet die Kachel, läuft der Timer leise
                    oben rechts. Der Stopp ist eine echte Aktion und erscheint nur
                    auf der aktiven Kachel, als ruhiger Glas-Knopf statt Terracotta.
                    Vorlesen liegt global oben. stopPropagation hält die Geste raus. */}
                {isRec ? <Mic size={30} className="unread-pulse" strokeWidth={2} />
                  : st?.kind === 'busy' ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="tabular-nums" style={{
                        fontSize: 16, fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                        color: isActive ? ACCENT : 'var(--t2)',
                      }}>{fmtSec(st.sec)}</span>
                      {isActive && (
                        <span
                          role="button"
                          aria-label="Agent stoppen"
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); stopConv(s.convId) }}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 30, height: 30, borderRadius: 999, cursor: 'pointer', flexShrink: 0,
                            background: 'var(--t1)', color: 'var(--panel, #1a1a1a)',
                            opacity: 0.55, WebkitTapHighlightColor: 'transparent',
                          }}
                        >
                          <Square size={15} fill="currentColor" />
                        </span>
                      )}
                    </span>
                  )
                  : st?.kind === 'done' ? (
                    <Check size={28} strokeWidth={2.6} style={{ color: isActive ? ACCENT : 'var(--t2)' }} />
                  ) : null}
              </span>
              {/* Unten: Titel über die volle Breite, ruhig auf zwei Zeilen
                  geklemmt und kleiner gesetzt, nie dreizeilig. Der Chat-Wechsel
                  ist eine echte Aktion und erscheint darum nur auf der aktiven
                  Kachel als dezenter Glas-Chevron, gleicher Look wie Stopp und
                  Queue. stopPropagation hält die Aufnahme-Geste raus. */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                <span style={{
                  flex: 1, minWidth: 0,
                  fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 500, lineHeight: 1.24, letterSpacing: 0,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  color: isRec ? '#fff' : s.convId ? 'var(--t1)' : 'var(--t3)',
                }}>
                  {titleFor(s, i)}
                </span>
                {isActive && !isRec && (
                  <span
                    role="button"
                    aria-label="Chat wechseln"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); setPickerSlot(i) }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 30, height: 30, borderRadius: 999, cursor: 'pointer', flexShrink: 0,
                      background: 'var(--t1)', color: 'var(--panel, #1a1a1a)',
                      opacity: 0.55, WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <ChevronDown size={17} strokeWidth={2.4} />
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Chat-Picker: Bottom-Sheet nah am Daumen, von unten. Liste aller Chats,
          der aktuell zugewiesene mit Akzent-Haken. Tap weist zu und schließt. */}
      {pickerSlot != null && (
        <div
          onClick={() => setPickerSlot(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 45, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 460, maxHeight: '72vh', borderTopLeftRadius: 26, borderTopRightRadius: 26,
              padding: '10px 14px calc(env(safe-area-inset-bottom, 0px) + 16px)',
              background: 'var(--panel, #1a1a1a)', border: '1px solid var(--line, rgba(255,255,255,0.12))',
              borderBottom: 'none', boxShadow: '0 -24px 60px rgba(0,0,0,0.55)',
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ width: 38, height: 4, borderRadius: 999, background: 'var(--t3)', opacity: 0.4, margin: '4px auto 12px' }} />
            <div style={{
              fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)',
              padding: '0 8px 10px',
            }}>
              Chat für Kachel {pickerSlot + 1}
            </div>
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, WebkitOverflowScrolling: 'touch' }}>
              {convList.map((c) => {
                const on = slots[pickerSlot]?.convId === c.id
                return (
                  <button
                    key={c.id}
                    onClick={() => assignConv(pickerSlot, c.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                      padding: '13px 14px', borderRadius: 14, border: 'none', cursor: 'pointer',
                      background: on ? 'rgba(217,119,87,0.12)' : 'transparent',
                      color: on ? ACCENT : 'var(--t1)', WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 16, fontWeight: on ? 600 : 500, lineHeight: 1.3,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>
                      {c.title || 'Ohne Titel'}
                    </span>
                    {on && <Check size={20} strokeWidth={2.6} style={{ flexShrink: 0 }} />}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
