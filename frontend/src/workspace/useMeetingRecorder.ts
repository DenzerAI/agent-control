import { useCallback, useRef, useState } from 'react'

// Meeting-Aufnahme: segmentiertes MediaRecorder-Streaming an /api/meetings.
// 1:1 aus der alten InfoPane portiert, jetzt als wiederverwendbarer Hook für die
// Workspace-Rail. Sendet 30s-Segmente, zeigt Live-Transkript und Timer.
export type RecState = 'idle' | 'recording' | 'uploading'

export function useMeetingRecorder(onFinished?: () => void) {
  const [recState, setRecState] = useState<RecState>('idle')
  const [recSeconds, setRecSeconds] = useState(0)
  const [recLiveTranscript, setRecLiveTranscript] = useState('')

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recTimerRef = useRef<number | null>(null)
  const recSessionIdRef = useRef<string | null>(null)
  const recIsStoppingRef = useRef(false)
  const recSegmentTimerRef = useRef<number | null>(null)
  const recStreamRef = useRef<MediaStream | null>(null)

  const startRecording = useCallback(async () => {
    const res = await fetch('/api/meetings/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const { session_id } = await res.json()
    recSessionIdRef.current = session_id
    recIsStoppingRef.current = false
    setRecLiveTranscript('')

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    recStreamRef.current = stream
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'

    const sendChunk = async (blob: Blob, sid: string) => {
      if (blob.size === 0) return
      const form = new FormData()
      form.append('file', blob, `chunk.webm`)
      try {
        const r = await fetch(`/api/meetings/${sid}/chunk`, { method: 'POST', body: form })
        const d = await r.json()
        if (d.transcript) setRecLiveTranscript(d.transcript)
      } catch {}
    }

    const startSegment = () => {
      const chunks: Blob[] = []
      const mr = new MediaRecorder(stream, { mimeType })
      mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
      mr.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType })
        const sid = recSessionIdRef.current
        if (sid) await sendChunk(blob, sid)
        if (!recIsStoppingRef.current) {
          startSegment()
        } else {
          const finalSid = recSessionIdRef.current
          if (finalSid) await fetch(`/api/meetings/${finalSid}/finish`, { method: 'POST' })
          stream.getTracks().forEach(t => t.stop())
          recStreamRef.current = null
          setRecState('idle')
          onFinished?.()
        }
      }
      mr.start()
      mediaRecorderRef.current = mr
      recSegmentTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
      }, 30000)
    }

    startSegment()
    setRecState('recording')
    setRecSeconds(0)
    recTimerRef.current = window.setInterval(() => setRecSeconds(s => s + 1), 1000)
  }, [onFinished])

  const stopRecording = useCallback(() => {
    recIsStoppingRef.current = true
    if (recTimerRef.current !== null) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    if (recSegmentTimerRef.current !== null) { clearTimeout(recSegmentTimerRef.current); recSegmentTimerRef.current = null }
    setRecState('uploading')
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') mr.stop()
  }, [])

  const toggleRecording = useCallback(() => {
    if (recState === 'idle') startRecording()
    else if (recState === 'recording') stopRecording()
  }, [recState, startRecording, stopRecording])

  const recTimer = `${Math.floor(recSeconds / 60)}:${String(recSeconds % 60).padStart(2, '0')}`

  return { recState, recLiveTranscript, recTimer, toggleRecording }
}
