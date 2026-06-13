import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, FileText, Loader2, Moon, Newspaper, Pause, Play, Quote, Radar, RefreshCw, Sun, X,
} from 'lucide-react'
import { getThemeMode, resolveTheme } from '../theme'
import * as audioQueue from '../audioQueue'
import { cleanForTTS } from '../ttsClean'

type RadarItem = {
  title: string; url: string; kind: 'video' | 'tweet' | 'paper' | 'article'
  domain: string; body: string; implication: string; sources: string
}
type RadarSection = { label: string; items: RadarItem[] }
type RadarReport = { intro: string; sections: RadarSection[]; top: string[] }
type RadarTweet = { url: string; handle: string; status_id: string; title: string }
type RadarDoc = { markdown: string; date: string; path: string }
type RadarVideo = { id: string; title: string; url: string }
type RadarData = {
  konsolidiert: RadarDoc; youtube: RadarDoc; videos: RadarVideo[]
  report?: RadarReport; tweets?: RadarTweet[]
}

const CACHE_KEY = 'workspace:radar:today'
const RADAR_NARRATOR_VOICE_ID = 'MU3b3cEHcofUOdPQJEVC'
const RADAR_NARRATOR_VOICE_SETTINGS: audioQueue.SpeakRequest['voiceSettings'] = {
  stability: 0.64,
  similarity_boost: 0.76,
  style: 0.2,
}

// Eigene Theme-Paletten nach DESIGN.md, lokal am Radar-Wrapper gesetzt. So kann
// der Radar-Room unabhängig vom App-Chrome zwischen hell und dunkel wechseln.
const PALETTE: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--r-bg': '#FAF9F5', '--r-bg1': '#F5F3EC', '--r-bg2': '#F0EEE6', '--r-border': '#E4E0D2',
    '--r-t1': '#1F1F1E', '--r-t2': '#5C5B57', '--r-t3': '#8A8983',
    '--r-accent': '#E07A4F', '--r-accent-soft': 'rgba(224,122,79,0.10)',
  },
  dark: {
    '--r-bg': '#1A1917', '--r-bg1': '#211F1C', '--r-bg2': '#2A2723', '--r-border': '#2E2C28',
    '--r-t1': '#F0EDE5', '--r-t2': '#B8B4AA', '--r-t3': '#8A8983',
    '--r-accent': '#E07A4F', '--r-accent-soft': 'rgba(224,122,79,0.14)',
  },
}

function readCache(): RadarData | null {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? JSON.parse(raw) as RadarData : null } catch { return null }
}
function writeCache(data: RadarData) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)) } catch {} }

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'heute'
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return 'gestern'
  return d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' })
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function buildRadarSpeech(data: RadarData | null): string {
  if (!data) return ''
  const report = data.report
  const parts: string[] = []
  if (report?.intro) parts.push(`Radar. ${report.intro}`)
  if (report?.top?.length) {
    parts.push(`Top ${report.top.length} für heute.`)
    report.top.forEach((item, index) => parts.push(`${index + 1}. ${item}`))
  }
  report?.sections?.forEach(section => {
    if (section.label) parts.push(section.label)
    section.items.forEach(item => {
      parts.push(item.title)
      if (item.body) parts.push(item.body)
      if (item.implication) parts.push(`Für Christian: ${item.implication}`)
    })
  })
  if (data.tweets?.length) {
    parts.push('Stimmen aus X.')
    data.tweets.forEach(tweet => parts.push(tweet.title))
  }
  if (data.videos?.length) {
    parts.push('Videos zum Anschauen.')
    data.videos.forEach(video => parts.push(video.title || 'YouTube-Video'))
  }
  if (!parts.length) parts.push(data.konsolidiert?.markdown || data.youtube?.markdown || '')
  return cleanForTTS(parts.filter(Boolean).join('\n\n'))
}

const KIND_ICON = { video: Play, tweet: Quote, paper: FileText, article: Newspaper } as const
const KIND_LABEL = { video: 'Video', tweet: 'Tweet', paper: 'Paper', article: 'Artikel' } as const

// Eine Beitragskarte: Quelle als Badge, Titel als Link, Fliesstext, und die
// Implikation für Christian als abgesetzter Terracotta-Block.
function ItemCard({ item }: { item: RadarItem }) {
  const Icon = KIND_ICON[item.kind] || Newspaper
  return (
    <article className="radar-card rounded-lg border border-[var(--r-border)] bg-[var(--r-bg1)] p-5 transition-colors hover:border-[var(--r-accent)]/40">
      <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--r-accent)]">
        <Icon className="h-3.5 w-3.5" />
        <span>{KIND_LABEL[item.kind]}</span>
        <span className="text-[var(--r-t3)] normal-case font-normal tracking-normal">· {item.domain}</span>
      </div>
      <a href={item.url} target="_blank" rel="noreferrer"
         className="block text-[19px] font-bold leading-snug text-[var(--r-t1)] hover:text-[var(--r-accent)]">
        {item.title}
      </a>
      {item.body && <p className="mt-2 text-[15px] leading-relaxed text-[var(--r-t2)]">{item.body}</p>}
      {item.implication && (
        <div className="radar-implication mt-3.5 rounded-lg bg-[var(--r-accent-soft)] px-4 py-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--r-accent)]">Für Christian</div>
          <p className="text-[14px] leading-relaxed text-[var(--r-t1)]">{item.implication}</p>
        </div>
      )}
    </article>
  )
}

// Echtes X-Embed über das offizielle widgets.js. Theme folgt dem Radar-Theme;
// der key erzwingt ein Remount beim Umschalten, damit X neu rendert.
function TweetEmbed({ tweet, theme }: { tweet: RadarTweet; theme: 'light' | 'dark' }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const w = (window as unknown as { twttr?: { widgets?: { load: (el?: HTMLElement) => void } } }).twttr
    if (w?.widgets && ref.current) w.widgets.load(ref.current)
  }, [theme])
  return (
    <div ref={ref}>
      <blockquote className="twitter-tweet" data-theme={theme} data-dnt="true" data-conversation="none">
        <a href={tweet.url.replace('x.com', 'twitter.com')}>{tweet.title}</a>
      </blockquote>
    </div>
  )
}

function VideoCard({ video }: { video: RadarVideo }) {
  const [playing, setPlaying] = useState(false)
  const thumb = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
  return (
    <div className="radar-card overflow-hidden rounded-lg border border-[var(--r-border)] bg-[var(--r-bg1)]">
      <div className="relative aspect-video w-full bg-black">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`}
            title={video.title || video.id}
            allow="accelerated-encoding; autoplay; encrypted-media; picture-in-picture"
            allowFullScreen className="absolute inset-0 h-full w-full border-0" />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} className="group absolute inset-0 h-full w-full" title="Abspielen">
            <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" draggable={false} />
            <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/35">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--r-accent)] shadow-lg">
                <Play className="ml-0.5 h-6 w-6 fill-white text-white" />
              </span>
            </span>
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        <a href={video.url} target="_blank" rel="noreferrer"
           className="block text-[14px] font-medium leading-snug text-[var(--r-t1)] hover:text-[var(--r-accent)]"
           title={video.title || video.url}>
          {video.title || 'YouTube-Video'}
        </a>
      </div>
    </div>
  )
}

// X widgets.js einmal global nachladen.
function ensureTwitterScript() {
  if (document.getElementById('twitter-wjs')) return
  const s = document.createElement('script')
  s.id = 'twitter-wjs'; s.async = true; s.src = 'https://platform.twitter.com/widgets.js'
  document.body.appendChild(s)
}

export function RadarWorkspace() {
  const [data, setData] = useState<RadarData | null>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ttsError, setTtsError] = useState('')
  const [aqState, setAqState] = useState(() => audioQueue.getState())
  const lastRadarPlayRef = useRef(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme(getThemeMode()))

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/radar/today', { cache: 'no-store' })
      if (!res.ok) throw new Error(res.statusText)
      const next = await res.json() as RadarData
      setData(next); writeCache(next)
    } catch (e) {
      setError(`Radar gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const report = data?.report
  const tweets = useMemo(() => data?.tweets || [], [data])
  const videos = data?.videos || []
  const date = data?.konsolidiert.date || data?.youtube.date || ''
  const hasReport = Boolean(report?.sections?.length)
  const speakConv = `radar-tts:${date || 'today'}`
  const speechText = useMemo(() => buildRadarSpeech(data), [data])
  const speaking = aqState.playingConversationId === speakConv
  const audioLoading = speaking && aqState.audioLoading
  const audioTime = speaking ? aqState.audioTime : 0
  const audioDuration = speaking ? aqState.audioDuration : 0
  const audioPaused = speaking ? aqState.audioPaused : false

  useEffect(() => { if (tweets.length) ensureTwitterScript() }, [tweets])
  useEffect(() => audioQueue.subscribe(setAqState), [])
  useEffect(() => {
    if (speaking) setTtsError('')
    if (lastRadarPlayRef.current && aqState.audioError) setTtsError(aqState.audioError)
  }, [aqState.audioError, speaking])

  const speakRadar = useCallback(() => {
    if (speaking) {
      audioQueue.togglePlayback()
      return
    }
    setTtsError('')
    if (!speechText) {
      setTtsError('Kein Radar-Text zum Vorlesen.')
      return
    }
    lastRadarPlayRef.current = true
    audioQueue.warmUp()
    audioQueue.playNow({
      text: speechText,
      agentName: 'main',
      ts: Date.now() / 1000,
      conversationId: speakConv,
      source: 'manual',
      voiceId: RADAR_NARRATOR_VOICE_ID,
      voiceSettings: RADAR_NARRATOR_VOICE_SETTINGS,
    })
  }, [speakConv, speaking, speechText])

  const stopRadar = useCallback(() => {
    lastRadarPlayRef.current = false
    setTtsError('')
    audioQueue.stopAll()
  }, [])

  const pal = PALETTE[theme]

  return (
    <div className="workspace-radar flex h-full min-h-0 flex-col" style={{ ...pal, background: 'var(--r-bg)', color: 'var(--r-t1)' } as React.CSSProperties}>
      <header className="shrink-0 border-b border-[var(--r-border)] px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--r-accent)]">
            <Radar className="h-4 w-4" /> Radar{date ? ` · ${fmtDate(date)}` : ''}
          </div>
          <button type="button" onClick={speakRadar} disabled={!speechText || audioLoading}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--r-border)] text-[var(--r-t2)] hover:text-[var(--r-accent)] disabled:opacity-60"
                  title={speaking ? (audioPaused ? 'Weiter' : 'Pause') : 'Radar vorlesen'}>
            {audioLoading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : speaking && !audioPaused
                ? <Pause className="h-4 w-4" fill="currentColor" />
                : <Play className="h-4 w-4" fill="currentColor" />}
          </button>
          <button type="button" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--r-border)] text-[var(--r-t2)] hover:text-[var(--r-accent)]"
                  title={theme === 'dark' ? 'Hell' : 'Dunkel'}>
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button type="button" onClick={load} disabled={loading}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--r-border)] text-[var(--r-t2)] hover:text-[var(--r-accent)] disabled:opacity-60"
                  title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        {(speaking || audioLoading || ttsError) && (
        <div className="radar-player" aria-label="Radar vorlesen">
          <button type="button" className="radar-player-toggle" onClick={speakRadar} disabled={!speechText || audioLoading}
                  title={speaking ? (audioPaused ? 'Weiter' : 'Pause') : 'Radar vorlesen'}>
            {audioLoading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : speaking && !audioPaused
                ? <Pause className="h-4 w-4" fill="currentColor" />
                : <Play className="h-4 w-4" fill="currentColor" />}
          </button>
          <div className="radar-player-copy">
            <strong>Radar vorlesen</strong>
            <span>{audioLoading ? 'Stimme wird vorbereitet' : speaking ? (audioPaused ? 'Pausiert' : 'Läuft') : ttsError || 'Tiefe Erzählerstimme'}</span>
          </div>
          <span className="radar-player-time radar-player-time-current">{formatTime(audioTime)}</span>
          <input
            type="range"
            min={0}
            max={audioDuration || 0}
            step={0.1}
            value={Math.min(audioTime, audioDuration || audioTime || 0)}
            onChange={e => audioQueue.seek(Number(e.target.value))}
            className="audio-scrubber radar-player-scrubber"
            style={{ ['--pct' as string]: `${audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0}%` }}
            aria-label="Audio-Position"
            disabled={!speaking || !audioDuration}
          />
          <span className="radar-player-time radar-player-time-duration">{audioDuration > 0 ? formatTime(audioDuration) : '--:--'}</span>
          <button type="button" className="radar-player-stop" onClick={stopRadar} disabled={!speaking && !ttsError}
                  title="Vorlesen stoppen" aria-label="Vorlesen stoppen">
            <X className="h-4 w-4" />
          </button>
        </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[860px] px-6 py-8">
          {error && (
            <div className="mb-5 flex gap-2 rounded-lg border border-[var(--r-border)] bg-[var(--r-bg1)] px-4 py-3 text-[13px] leading-5 text-[var(--r-t2)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--r-accent)]" /><span>{error}</span>
            </div>
          )}

          {!data && loading && <div className="text-[15px] text-[var(--r-t3)]">Lade Radar</div>}

          {data && !hasReport && videos.length === 0 && tweets.length === 0 && (
            <div className="rounded-lg border border-[var(--r-border)] bg-[var(--r-bg1)] px-4 py-5 text-[15px] text-[var(--r-t3)]">
              Heute Nacht nichts Belastbares im Radar. Das ist ein ruhiger Tag, kein Fehler.
            </div>
          )}

          {/* Hero */}
          {report?.intro && (
            <section className="mb-10">
              <h1 className="radar-hero-title mb-4 text-[34px] font-semibold leading-tight tracking-normal text-[var(--r-t1)]">
                Was die Nacht <span className="text-[var(--r-accent)]">gebracht</span> hat
              </h1>
              <p className="max-w-[680px] text-[19px] leading-[1.5] text-[var(--r-t2)]">{report.intro}</p>
            </section>
          )}

          {/* Top-3 */}
          {report?.top?.length ? (
            <section className="mb-12">
              <div className="mb-4 text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--r-accent)]">Top {report.top.length} für heute</div>
              <div className="grid gap-3">
                {report.top.map((t, i) => (
                  <div key={i} className="radar-card flex gap-4 rounded-lg border border-[var(--r-border)] bg-[var(--r-bg1)] p-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--r-accent)] text-[16px] font-bold text-white">{i + 1}</div>
                    <p className="self-center text-[15px] leading-relaxed text-[var(--r-t1)]" dangerouslySetInnerHTML={{ __html: mdInline(t) }} />
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Sektionen mit Beiträgen */}
          {report?.sections?.map((sec, si) => (
            <section key={si} className="mb-11">
              {sec.label && (
                <h2 className="mb-4 border-b border-[var(--r-border)] pb-2 text-[14px] font-bold uppercase tracking-[0.06em] text-[var(--r-t3)]">{sec.label}</h2>
              )}
              <div className="grid gap-4">
                {sec.items.map((it, ii) => <ItemCard key={ii} item={it} />)}
              </div>
            </section>
          ))}

          {/* Stimmen aus X */}
          {tweets.length > 0 && (
            <section className="mb-11">
              <h2 className="mb-4 flex items-center gap-2 text-[14px] font-bold uppercase tracking-[0.06em] text-[var(--r-t3)]">
                <Quote className="h-4 w-4 text-[var(--r-accent)]" /> Stimmen aus X
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {tweets.map(t => <TweetEmbed key={`${t.status_id}-${theme}`} tweet={t} theme={theme} />)}
              </div>
            </section>
          )}

          {/* Videos */}
          {videos.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-4 flex items-center gap-2 text-[14px] font-bold uppercase tracking-[0.06em] text-[var(--r-t3)]">
                <Play className="h-3.5 w-3.5 fill-current text-[var(--r-accent)]" /> Videos zum Anschauen
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {videos.map(v => <VideoCard key={v.id} video={v} />)}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

// Minimaler Inline-Markdown-Renderer für die Top-Liste (nur **fett**), ohne
// schwere Abhängigkeit. Escapet erst, dann werden Sternchen zu <strong>.
function mdInline(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}
