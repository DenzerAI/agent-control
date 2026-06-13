import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Play, Pause, X, Sun, Moon, Maximize2, Minimize2 } from 'lucide-react'
import type { WorkspaceFile } from './types'
import { FilePathHeader } from './FilePathHeader'
import * as audioQueue from '../audioQueue'
import { getThemeMode, resolveTheme } from '../theme'
import { cleanForTTS } from '../ttsClean'
import { useMainAgentName } from '../agents'

// Liest den sichtbaren Text einer HTML-Artefakt-Datei: Script/Style raus, dann
// nur der Textinhalt. Reicht fürs Vorlesen, ohne Markup mitzusprechen.
function extractReadableText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove())
    const raw = doc.body?.textContent || ''
    return raw.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function PreviewPane({ file, onRevealPath }: {
  file: WorkspaceFile | null
  onRevealPath?: (path: string) => void
}) {
  const agentName = useMainAgentName()
  const path = file?.path || 'local-preview.html'

  // Vorlesen über dieselbe globale Audio-Queue wie der Chat (Agent-Stimme).
  // Eine eigene conversationId pro Datei toggelt Play und Stopp sauber.
  const [aqState, setAqState] = useState(() => audioQueue.getState())
  useEffect(() => audioQueue.subscribe(setAqState), [])
  const [loading, setLoading] = useState(false)
  const speakConv = file ? `preview-tts:${file.path}` : 'preview-tts'

  // Hell/Dunkel der Vorschau. Default = aktuelles App-Theme, damit eine dunkle
  // HTML im hellen UI nicht schwer lesbar ist. Der Schalter setzt data-theme am
  // <html> der geladenen Seite (same-origin), neue Artefakte reagieren darauf.
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [previewTheme, setPreviewTheme] = useState<'dark' | 'light'>(() => resolveTheme(getThemeMode()))
  const applyPreviewTheme = useCallback((theme: 'dark' | 'light') => {
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc?.documentElement) doc.documentElement.setAttribute('data-theme', theme)
    } catch { /* cross-origin o.ae.: dann greift der Schalter nicht */ }
  }, [])
  useEffect(() => { applyPreviewTheme(previewTheme) }, [previewTheme, applyPreviewTheme, file])
  const playing = aqState.playingConversationId === speakConv
  const audioTime = playing ? aqState.audioTime : 0
  const audioDuration = playing ? aqState.audioDuration : 0
  const audioPaused = playing ? aqState.audioPaused : false

  // Vollbild fuer die ganze Vorschau-Pane (Header bleibt sichtbar, Button
  // toggelt). Esc beendet wie ueblich, fullscreenchange haelt den State synchron.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}) }
    else { containerRef.current?.requestFullscreen().catch(() => {}) }
  }, [])

  const speak = useCallback(async () => {
    if (audioQueue.getState().playingConversationId === speakConv) { audioQueue.stopAll(); return }
    if (!file) return
    setLoading(true)
    try {
      const res = await fetch(`/api/fs/download?path=${encodeURIComponent(file.path)}&inline=1`)
      const html = await res.text()
      const clean = cleanForTTS(extractReadableText(html))
      if (!clean) return
      audioQueue.warmUp()
      audioQueue.playNow({ text: clean, agentName: 'main', ts: Date.now() / 1000, conversationId: speakConv, source: 'manual' })
    } catch {
      // Fehlerfall still: kein Audio, Knopf bleibt im Ausgangszustand.
    } finally {
      setLoading(false)
    }
  }, [file, speakConv])

  return (
    <div ref={containerRef} className="workspace-preview workspace-preview-desktop" style={isFullscreen ? { background: 'var(--bg, #1a1714)' } : undefined}>
      <FilePathHeader
        path={path}
        nameOnly
        onRevealPath={file ? onRevealPath : undefined}
        right={file ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="workspace-preview-play"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Vollbild beenden' : 'Vollbild'}
              aria-label={isFullscreen ? 'Vollbild beenden' : 'Vollbild'}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className="workspace-preview-play"
              onClick={() => setPreviewTheme(t => (t === 'dark' ? 'light' : 'dark'))}
              title={previewTheme === 'dark' ? 'Vorschau hell' : 'Vorschau dunkel'}
              aria-label={previewTheme === 'dark' ? 'Vorschau hell' : 'Vorschau dunkel'}
            >
              {previewTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            {!playing && (
              <button
                type="button"
                className="workspace-preview-play"
                onClick={speak}
                disabled={loading}
                title={`Von ${agentName} vorlesen lassen`}
                aria-label={`Von ${agentName} vorlesen lassen`}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              </button>
            )}
          </div>
        ) : undefined}
      />
      {playing && (
        <div className="workspace-preview-player">
          <button
            type="button"
            className="workspace-preview-player-toggle"
            onClick={() => audioQueue.togglePlayback()}
            title={audioPaused ? 'Weiter' : 'Pause'}
            aria-label={audioPaused ? 'Weiter' : 'Pause'}
          >
            {audioPaused
              ? <Play className="h-3.5 w-3.5" fill="currentColor" style={{ marginLeft: 1 }} />
              : <Pause className="h-3.5 w-3.5" fill="currentColor" />}
          </button>
          <span className="workspace-preview-player-time">{formatTime(audioTime)}</span>
          <input
            type="range"
            min={0}
            max={audioDuration || 0}
            step={0.1}
            value={Math.min(audioTime, audioDuration || audioTime || 0)}
            onChange={e => audioQueue.seek(Number(e.target.value))}
            className="audio-scrubber workspace-preview-player-scrubber"
            style={{ ['--pct' as string]: `${audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0}%` }}
            aria-label="Audio-Position"
          />
          <span className="workspace-preview-player-time">{audioDuration > 0 ? formatTime(audioDuration) : '–:––'}</span>
          <button
            type="button"
            className="workspace-preview-player-stop"
            onClick={() => audioQueue.stopAll()}
            title="Vorlesen stoppen"
            aria-label="Vorlesen stoppen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {file ? (
        <iframe
          ref={iframeRef}
          src={`/api/fs/download?path=${encodeURIComponent(file.path)}&inline=1`}
          className="workspace-html-frame"
          title={path}
          onLoad={() => applyPreviewTheme(previewTheme)}
        />
      ) : (
        <div className="workspace-empty">
          <h1 className="workspace-empty-mark">
            Agent C<span className="workspace-empty-o"><img src="/agent-thinking.svg" alt="o" /></span>ntrol
          </h1>
          <p className="workspace-empty-sub">Wähle links ein Modul oder öffne eine Datei.</p>
        </div>
      )}
    </div>
  )
}
