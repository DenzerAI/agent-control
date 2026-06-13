import { useEffect, useRef } from 'react'
import { fixUmlauts } from '../umlauts'
import type { VoiceState } from './voiceState'

// VoiceRealtimeSession — Voice-Mode v2.
// Gehirn: OpenAI Realtime (gpt-realtime-2), Text-Output. Stimme: ElevenLabs (Agent)
// über /api/tts. Realtime hört zu und denkt, gesprochen wird Satz fuer Satz mit
// Agent' Stimme. Headless wie VoiceActiveSession — exponiert nur VoiceState.

interface Props {
  onClose: () => void
  onReconnect: () => void
  setState: (updater: (prev: VoiceState) => VoiceState) => void
}

async function persistMessage(role: 'user' | 'agent', content: string) {
  if (!content.trim()) return
  try {
    await fetch('/api/voice/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content }),
    })
  } catch {
    // Silent
  }
}

function logVoiceEvent(event: string, extra?: Record<string, unknown>) {
  try {
    const payload = JSON.stringify({ event, src: 'realtime', ...extra })
    fetch('/api/voice/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Silent
  }
}

async function toolGet(url: string): Promise<string> {
  try {
    const r = await fetch(url)
    return (await r.text()).slice(0, 6000)
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : 'fetch failed' })
  }
}

async function toolPost(url: string, body: unknown): Promise<string> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await r.text()).slice(0, 2000)
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : 'fetch failed' })
  }
}

// Tool-Dispatch — Namen müssen zu _VOICE_REALTIME_TOOLS im Backend passen.
async function dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
  const enc = encodeURIComponent
  switch (name) {
    case 'get_chat_context':
      return toolGet(`/api/voice/tool/chat-context?limit=${Number(args.limit) || 10}`)
    case 'search_brain':
      return toolGet(`/api/voice/tool/brain-search?q=${enc(String(args.q || ''))}&mode=${enc(String(args.mode || 'hybrid'))}`)
    case 'read_brain':
      return toolGet(`/api/voice/tool/brain-file?path=${enc(String(args.path || ''))}`)
    case 'list_brain_files':
      return toolGet('/api/voice/tool/brain-index')
    case 'list_briefings':
      return toolGet('/api/voice/tool/briefings')
    case 'read_briefing':
      return toolGet(`/api/voice/tool/briefing?name=${enc(String(args.name || ''))}`)
    case 'web_lookup':
      return toolGet(`/api/voice/tool/web?topic=${enc(String(args.topic || ''))}&q=${enc(String(args.q || ''))}`)
    case 'send_to_chat':
      // Backend erwartet { agent, message } — sonst 400 "empty message" und die
      // Notiz aus dem Brainstorm landet nie im Chat (verwertbarer Output fällt aus).
      return toolPost('/api/voice/tool/send-chat', { agent: 'klaus', message: String(args.text || args.message || '') })
    default:
      return JSON.stringify({ error: `unknown tool: ${name}` })
  }
}

export default function VoiceRealtimeSession({ onClose, onReconnect, setState }: Props) {
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const startedRef = useRef(false)
  const closedRef = useRef(false)
  const reconnectedRef = useRef(false)
  // Reserviert für ein künftiges Schließ-Kommando aus der Session heraus.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // ── TTS-Warteschlange (Agent' Stimme über ElevenLabs) ──
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsQueueRef = useRef<string[]>([])
  const ttsPlayingRef = useRef(false)
  const voiceIdRef = useRef('')
  // Generation steigt bei jedem stopTTS/Barge-in. Eine pumpTTS-Schleife aus einer
  // alten Generation bricht ab, statt nach dem Stop weiterzulaufen (Doppel-Pump).
  const ttsGenRef = useRef(0)
  // Resolver des aktuell wartenden Wiedergabe-Promise, damit stopTTS es hart
  // auflösen kann — sonst hängt die Schleife ewig und Agent bleibt stumm.
  const playResolveRef = useRef<(() => void) | null>(null)
  // Streaming-Puffer für Satzweise-Sprachausgabe
  const pendingRef = useRef('')
  // Volltext der laufenden Agent-Antwort (für Persistenz)
  const responseTextRef = useRef('')

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const setSpeaking = (v: boolean) => setState(s => (s.isSpeaking === v ? s : { ...s, isSpeaking: v }))
    const setThinking = (v: boolean) => setState(s => (s.isThinking === v ? s : { ...s, isThinking: v }))

    const audio = new Audio()
    audio.autoplay = true
    audioRef.current = audio

    // ── Halb-Duplex: Mikro stumm während Agent redet ──
    // ElevenLabs spielt über diesen separaten <audio>, den die WebRTC-Echo-
    // unterdrückung nicht kennt. Ohne Gate hört das Mikro Agent, Realtime hält
    // das fuer Eingabe und bricht ab (Echo-Schleife). Gate = einzige robuste Lösung.
    let micReenableTimer: ReturnType<typeof setTimeout> | null = null
    function setMicEnabled(on: boolean) {
      const ms = micRef.current
      if (!ms) return
      ms.getAudioTracks().forEach(t => { t.enabled = on })
      logVoiceEvent('mic_gate', { on })
    }
    function muteMicForSpeech() {
      if (micReenableTimer) { clearTimeout(micReenableTimer); micReenableTimer = null }
      setMicEnabled(false)
    }
    function unmuteMicAfterSpeech() {
      // Kurzer Nachlauf, damit der letzte Laut aus dem Lautsprecher nicht reinblutet.
      if (micReenableTimer) clearTimeout(micReenableTimer)
      micReenableTimer = setTimeout(() => {
        micReenableTimer = null
        if (!closedRef.current) setMicEnabled(true)
      }, 250)
    }

    function stopTTS() {
      ttsGenRef.current += 1
      ttsQueueRef.current = []
      // Wartendes Wiedergabe-Promise hart auflösen, sonst hängt die alte Schleife.
      if (playResolveRef.current) {
        const r = playResolveRef.current
        playResolveRef.current = null
        r()
      }
      try {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      } catch {
        // Silent
      }
      ttsPlayingRef.current = false
      setSpeaking(false)
      unmuteMicAfterSpeech()
    }

    async function pumpTTS() {
      if (ttsPlayingRef.current) return
      const gen = ttsGenRef.current
      const next = ttsQueueRef.current.shift()
      if (next === undefined) {
        setSpeaking(false)
        unmuteMicAfterSpeech()
        return
      }
      ttsPlayingRef.current = true
      setSpeaking(true)
      muteMicForSpeech()
      try {
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: next, voiceId: voiceIdRef.current }),
        })
        const d = await r.json()
        if (d.url && !closedRef.current && gen === ttsGenRef.current) {
          await new Promise<void>((resolve) => {
            let settled = false
            const done = () => {
              if (settled) return
              settled = true
              audio.removeEventListener('ended', done)
              audio.removeEventListener('error', done)
              if (playResolveRef.current === done) playResolveRef.current = null
              resolve()
            }
            playResolveRef.current = done
            audio.addEventListener('ended', done)
            audio.addEventListener('error', done)
            audio.src = d.url
            const p = audio.play()
            if (p && p.catch) p.catch(() => done())
          })
        }
      } catch {
        // Silent — nächsten Chunk trotzdem versuchen
      }
      // Überholte Schleife (nach Barge-in) fasst weder Flag noch Pump an —
      // sonst clobbert sie die frische Generation.
      if (gen !== ttsGenRef.current) return
      ttsPlayingRef.current = false
      pumpTTS()
    }

    function enqueueTTS(text: string) {
      const t = fixUmlauts(text.trim())
      if (!t) return
      ttsQueueRef.current.push(t)
      pumpTTS()
    }

    // Satzgrenzen aus dem Delta-Strom ziehen, damit Agent früh anfängt zu reden.
    function flushSentences(force: boolean) {
      const marks = ['. ', '! ', '? ', '… ', '.\n', '!\n', '?\n', ': ']
      for (;;) {
        let idx = -1
        for (const m of marks) idx = Math.max(idx, pendingRef.current.indexOf(m))
        if (idx < 0) break
        const chunk = pendingRef.current.slice(0, idx + 1)
        pendingRef.current = pendingRef.current.slice(idx + 1)
        enqueueTTS(chunk)
      }
      if (force && pendingRef.current.trim()) {
        enqueueTTS(pendingRef.current)
        pendingRef.current = ''
      }
    }

    async function handleEvent(ev: Record<string, unknown>) {
      const type = String(ev.type || '')
      // Diagnose: Lifecycle-Events loggen (keine Deltas, die wären Spam).
      // Zeigt, ob nach der ersten Runde noch speech_started/response.created kommt.
      if (type !== 'response.text.delta' && type !== 'response.output_text.delta'
        && type !== 'response.audio_transcript.delta') {
        logVoiceEvent('rt_ev', { t: type })
      }
      switch (type) {
        case 'response.text.delta':
        case 'response.output_text.delta': {
          const delta = String(ev.delta || '')
          responseTextRef.current += delta
          pendingRef.current += delta
          setThinking(true)
          flushSentences(false)
          break
        }
        case 'response.text.done':
        case 'response.output_text.done': {
          flushSentences(true)
          break
        }
        case 'response.done': {
          setThinking(false)
          const full = responseTextRef.current.trim()
          responseTextRef.current = ''
          if (full) {
            setState(s => ({ ...s, lastLine: { role: 'agent', content: fixUmlauts(full) } }))
            persistMessage('agent', full)
          }
          break
        }
        case 'response.function_call_arguments.done': {
          const name = String(ev.name || '')
          const callId = String(ev.call_id || '')
          let parsed: Record<string, unknown> = {}
          try {
            parsed = JSON.parse(String(ev.arguments || '{}'))
          } catch {
            parsed = {}
          }
          setThinking(true)
          logVoiceEvent('tool_call', { name })
          const result = await dispatchTool(name, parsed)
          const dc = dcRef.current
          if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: result },
            }))
            dc.send(JSON.stringify({ type: 'response.create' }))
          }
          break
        }
        case 'input_audio_buffer.speech_started': {
          // der Nutzer redet — Barge-in: laufende Agent-Ausgabe stoppen.
          stopTTS()
          break
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = String(ev.transcript || '').trim()
          if (transcript) {
            setState(s => ({ ...s, lastLine: { role: 'user', content: fixUmlauts(transcript) } }))
            persistMessage('user', transcript)
          }
          break
        }
        case 'error': {
          logVoiceEvent('rt_error', { error: JSON.stringify(ev).slice(0, 300) })
          break
        }
        default:
          break
      }
    }

    async function connect() {
      try {
        setState(s => ({ ...s, phase: 'connecting', errorMsg: '' }))

        const tokenRes = await fetch('/api/voice/realtime/session', { method: 'POST' })
        const tok = await tokenRes.json()
        if (!tokenRes.ok || !tok.clientSecret) {
          throw new Error(tok.error || 'no client secret')
        }
        voiceIdRef.current = tok.voiceId || ''
        const model = tok.model || 'gpt-realtime-2'

        // Session-Marker im Voice-Channel setzen (für Transkript-Persistenz).
        fetch('/api/voice/session/start', { method: 'POST' }).catch(() => {})

        const pc = new RTCPeerConnection()
        pcRef.current = pc

        pc.onconnectionstatechange = () => {
          const st = pc.connectionState
          logVoiceEvent('pc_state', { state: st })
          if (st === 'connected') {
            setState(s => ({ ...s, phase: 'live' }))
          } else if ((st === 'failed' || st === 'disconnected') && !closedRef.current) {
            if (!reconnectedRef.current) {
              reconnectedRef.current = true
              onReconnect()
            }
          }
        }

        // Mic rein. Realtime gibt selbst kein Audio aus (output_modalities text).
        // iOS verweigert getUserMedia ausserhalb eines secure context (HTTPS) —
        // dann werfen wir hier einen klaren Fehler statt eines kryptischen DOMException.
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('no mediaDevices (kein HTTPS/secure context?)')
        }
        let ms: MediaStream
        try {
          ms = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (micErr) {
          const m = micErr instanceof Error ? `${micErr.name}: ${micErr.message}` : 'mic denied'
          logVoiceEvent('mic_error', { error: m })
          throw new Error(`mic: ${m}`)
        }
        micRef.current = ms
        ms.getTracks().forEach(t => pc.addTrack(t, ms))
        logVoiceEvent('mic_ok', {})

        const dc = pc.createDataChannel('oai-events')
        dcRef.current = dc
        dc.onopen = () => {
          logVoiceEvent('dc_open', {})
          // Kurze Begrüßung anstoßen, damit der Nutzer sofort hört dass es lebt.
          dc.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: 'Begrüße der Nutzer mit genau einem kurzen, lockeren Satz und frag, woran ihr denken wollt.' },
          }))
        }
        dc.onmessage = (e) => {
          let ev: Record<string, unknown>
          try {
            ev = JSON.parse(e.data)
          } catch {
            return
          }
          handleEvent(ev)
        }

        let offer: RTCSessionDescriptionInit
        try {
          offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
        } catch (offErr) {
          const m = offErr instanceof Error ? `${offErr.name}: ${offErr.message}` : 'offer failed'
          logVoiceEvent('offer_error', { error: m })
          throw new Error(`offer: ${m}`)
        }
        logVoiceEvent('offer_ok', {})

        const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${tok.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
        })
        const answerSdp = await sdpRes.text()
        if (!sdpRes.ok) {
          logVoiceEvent('sdp_error', { status: sdpRes.status, body: answerSdp.slice(0, 200) })
          throw new Error(`realtime calls ${sdpRes.status}: ${answerSdp.slice(0, 200)}`)
        }
        // OpenAI muss valides SDP liefern (beginnt mit "v="). Status-200 mit
        // Fehler-Body (z.B. JSON) liess setRemoteDescription bisher mit dem
        // kryptischen "string did not match expected pattern" abstürzen.
        if (!answerSdp.startsWith('v=')) {
          logVoiceEvent('sdp_error', { status: sdpRes.status, body: answerSdp.slice(0, 200) })
          throw new Error(`bad sdp answer: ${answerSdp.slice(0, 200)}`)
        }
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
        } catch (sdpErr) {
          const m = sdpErr instanceof Error ? `${sdpErr.name}: ${sdpErr.message}` : 'setRemote failed'
          logVoiceEvent('sdp_error', { status: sdpRes.status, body: answerSdp.slice(0, 120), set: m })
          throw new Error(`setRemote: ${m}`)
        }
        logVoiceEvent('connected', { model })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'connect failed'
        logVoiceEvent('connect_error', { error: msg })
        setState(s => ({ ...s, phase: 'error', errorMsg: msg }))
      }
    }

    connect()

    return () => {
      closedRef.current = true
      if (micReenableTimer) { clearTimeout(micReenableTimer); micReenableTimer = null }
      stopTTS()
      try {
        dcRef.current?.close()
      } catch {
        // Silent
      }
      try {
        pcRef.current?.close()
      } catch {
        // Silent
      }
      try {
        micRef.current?.getTracks().forEach(t => t.stop())
      } catch {
        // Silent
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Headless — Darstellung passiert im Composer/Button über VoiceState.
  return null
}
