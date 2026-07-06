import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ChevronLeft, Download, MessageSquare, Pause, Pencil, Play, Save, Shield, Volume2, X } from 'lucide-react'
import * as audioQueue from '../audioQueue'
import { cleanForTTS } from '../ttsClean'
import { FilePathHeader } from './FilePathHeader'
import { useMainAgentName } from '../agents'

type FileKind = 'markdown' | 'text' | 'pdf' | 'image' | 'secret' | 'binary'

function fileKind(path: string): FileKind {
  const lower = path.toLowerCase()
  if (/(^|\/)(secrets?|private)\//.test(lower) || /(^|\/)\.env(?:\.|$)|\.(p8|pem|key)$/i.test(path)) return 'secret'
  if (/\.(md|markdown|mdx)$/i.test(path)) return 'markdown'
  if (/\.(txt|json|yaml|yml|css|js|jsx|ts|tsx|py|sh|toml|ini|cfg|csv|log|xml|sql)$/i.test(path)) return 'text'
  if (/\.pdf$/i.test(path)) return 'pdf'
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path)) return 'image'
  return 'binary'
}

function basename(path: string): string {
  return path.split('/').pop() || path
}

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

export function WorkspaceFilePane({ path, onBack, onRevealPath }: {
  path: string
  onBack: () => void
  onRevealPath?: (path: string) => void
}) {
  const agentName = useMainAgentName()
  const kind = useMemo(() => fileKind(path), [path])
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ttsLoading, setTtsLoading] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [ttsCurrent, setTtsCurrent] = useState(0)
  const [ttsDuration, setTtsDuration] = useState(0)
  const ttsRef = useRef<HTMLAudioElement | null>(null)

  const canReadText = kind === 'markdown' || kind === 'text'
  const canEdit = canReadText
  const hasContent = content.trim().length > 0

  useEffect(() => {
    ttsRef.current?.pause()
    ttsRef.current = null
    setTtsPlaying(false)
    setTtsCurrent(0)
    setTtsDuration(0)
    setContent('')
    setDraft('')
    setEditing(false)
    setError('')
    if (!canReadText) return
    setLoading(true)
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => {
        const next = String(d.content || '')
        setContent(next)
        setDraft(next)
      })
      .catch(e => setError(`Laden fehlgeschlagen: ${e.message}`))
      .finally(() => setLoading(false))
    return () => {
      ttsRef.current?.pause()
      ttsRef.current = null
    }
  }, [path, canReadText])

  useEffect(() => audioQueue.subscribe(s => {
    if (ttsRef.current) ttsRef.current.playbackRate = s.playbackRate
  }), [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: draft }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || r.statusText)
      setContent(draft)
      setEditing(false)
    } catch (e: any) {
      setError(`Speichern fehlgeschlagen: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const discuss = () => {
    if (!hasContent) return
    window.dispatchEvent(new CustomEvent('deck:discussFile', { detail: { filePath: path, content } }))
  }

  const startTts = async () => {
    if (!hasContent) return
    ttsRef.current?.pause()
    ttsRef.current = null
    setTtsPlaying(false)
    setTtsCurrent(0)
    setTtsDuration(0)
    setTtsLoading(true)
    try {
      const voiceId = (localStorage.getItem('control:voice') || localStorage.getItem('control:voice:agent') || localStorage.getItem('control:voice:main') || '').trim()
      const body: Record<string, unknown> = { text: cleanForTTS(content), agent: 'agent' }
      if (voiceId) {
        body.voiceId = voiceId
        try {
          const raw = localStorage.getItem(`control:voiceSettings:${voiceId}`)
          if (raw) body.voiceSettings = JSON.parse(raw)
        } catch {}
      }
      const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await r.json().catch(() => null) as { url?: string } | null
      if (!data?.url) return
      const audio = new Audio(data.url)
      audio.playbackRate = audioQueue.getState().playbackRate
      ttsRef.current = audio
      audio.addEventListener('loadedmetadata', () => setTtsDuration(audio.duration || 0))
      audio.addEventListener('timeupdate', () => setTtsCurrent(audio.currentTime))
      audio.addEventListener('ended', () => setTtsPlaying(false))
      await audio.play()
      setTtsPlaying(true)
    } catch {
      setError('Vorlesen fehlgeschlagen.')
    } finally {
      setTtsLoading(false)
    }
  }

  const toggleTts = () => {
    if (!ttsRef.current) return
    if (ttsPlaying) {
      ttsRef.current.pause()
      setTtsPlaying(false)
    } else {
      ttsRef.current.play()
      setTtsPlaying(true)
    }
  }

  const stopTts = () => {
    if (!ttsRef.current) return
    ttsRef.current.pause()
    ttsRef.current.currentTime = 0
    ttsRef.current = null
    setTtsPlaying(false)
    setTtsCurrent(0)
    setTtsDuration(0)
  }

  const seekTts = (e: MouseEvent<HTMLDivElement>) => {
    if (!ttsRef.current || !ttsDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    ttsRef.current.currentTime = pct * ttsDuration
  }

  const ttsPct = ttsDuration ? (ttsCurrent / ttsDuration) * 100 : 0
  const downloadUrl = `/api/fs/download?path=${encodeURIComponent(path)}`
  const inlineUrl = `${downloadUrl}&inline=1`

  const actions = (
    <>
      <button type="button" className="workspace-icon-button" onClick={onBack} title="Zurück zum Dateibaum">
        <ChevronLeft className="h-4 w-4" />
      </button>
      {canReadText && (
        <button type="button" className="workspace-icon-button" onClick={discuss} disabled={!hasContent} title={`Mit ${agentName} besprechen`}>
          <MessageSquare className="h-4 w-4" />
        </button>
      )}
      {canReadText && (
        <button type="button" className="workspace-icon-button" onClick={startTts} disabled={!hasContent || ttsLoading} title={ttsLoading ? 'Lädt' : 'Vorlesen'}>
          <Volume2 className="h-4 w-4" />
        </button>
      )}
      {canEdit && !editing && (
        <button type="button" className="workspace-icon-button" onClick={() => setEditing(true)} disabled={!hasContent} title="Bearbeiten">
          <Pencil className="h-4 w-4" />
        </button>
      )}
      {editing && (
        <button type="button" className="workspace-icon-button is-primary" onClick={save} disabled={saving} title="Speichern">
          <Save className="h-4 w-4" />
        </button>
      )}
      <a className="workspace-icon-button" href={downloadUrl} title="Herunterladen">
        <Download className="h-4 w-4" />
      </a>
    </>
  )

  return (
    <div className="workspace-file-pane">
      <FilePathHeader path={path} onRevealPath={onRevealPath} right={actions} />
      {ttsRef.current && (
        <div className="workspace-audio-bar">
          <button type="button" className="workspace-icon-button is-primary" onClick={toggleTts} title={ttsPlaying ? 'Pausieren' : 'Weiter'}>
            {ttsPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <div className="workspace-audio-progress" onClick={seekTts}>
            <span style={{ width: `${ttsPct}%` }} />
          </div>
          <em>{formatTime(ttsCurrent)} / {ttsDuration ? formatTime(ttsDuration) : '--:--'}</em>
          <button type="button" className="workspace-icon-button" onClick={stopTts} title="Schließen">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="workspace-file-content">
        {error && <div className="workspace-reader-error">{error}</div>}
        {loading ? (
          <div className="workspace-reader-empty"><p>Lade Datei.</p></div>
        ) : kind === 'secret' ? (
          <div className="workspace-secret-placeholder">
            <Shield className="h-6 w-6" />
            <strong>Secret-Datei erkannt</strong>
            <p>{basename(path)} wird absichtlich nicht als Vorschau angezeigt.</p>
          </div>
        ) : kind === 'pdf' ? (
          <iframe src={inlineUrl} className="workspace-inline-frame" title={path} />
        ) : kind === 'image' ? (
          <div className="workspace-image-stage"><img src={inlineUrl} alt={basename(path)} /></div>
        ) : kind === 'binary' ? (
          <div className="workspace-secret-placeholder">
            <strong>Keine Vorschau verfügbar</strong>
            <p>{basename(path)} kann hier nicht sinnvoll gelesen werden.</p>
          </div>
        ) : editing ? (
          <textarea className="workspace-file-editor" value={draft} onChange={e => setDraft(e.target.value)} />
        ) : kind === 'markdown' ? (
          <article
            className="chat-md-agent workspace-reader-content"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content) as string) }}
          />
        ) : (
          <pre className="workspace-text-content">{content}</pre>
        )}
      </div>
    </div>
  )
}
