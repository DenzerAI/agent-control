import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, BellOff, BellPlus, Bookmark, BookmarkCheck, Loader2, RefreshCw, Search, Sparkles } from 'lucide-react'
import { getState, play, setAnchor, subscribe, type YtPlayerState } from '../youtubePlayer'

type YtVideo = {
  id: string
  title: string
  channel: string
  channel_id?: string | null
  duration: number | null
  views: number | null
  timestamp: number | null
  thumbnail: string
  klaus_pick?: boolean
  klaus_reason?: string
}

type YtFollow = { channel_id: string; name: string }

type YtSaved = {
  id: string
  title: string
  channel: string
  channel_id?: string | null
  thumbnail: string
  duration: number | null
  saved_by: 'christian' | 'klaus'
  ts: number
}

type Dossier = {
  status: 'none' | 'processing' | 'done' | 'skipped' | 'error'
  reason?: string
  error?: string
  analysis?: string
}

function renderInline(text: string) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return parts.map((part, i) => i % 2 === 1
    ? <strong key={i} className="font-medium text-[var(--t1)]">{part}</strong>
    : <span key={i}>{part}</span>)
}

function AnalysisBody({ text }: { text: string }) {
  return (
    <div className="space-y-1.5">
      {text.split('\n').map((line, i) => {
        const t = line.trim()
        if (!t) return null
        if (t.startsWith('## ')) {
          return <div key={i} className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--t2)]">{t.slice(3)}</div>
        }
        if (t.startsWith('- ')) {
          return (
            <div key={i} className="flex gap-2 text-sm leading-relaxed text-[var(--t1)]">
              <span className="shrink-0 text-[var(--t3)]">·</span>
              <span className="min-w-0">{renderInline(t.slice(2))}</span>
            </div>
          )
        }
        return <div key={i} className="text-sm leading-relaxed text-[var(--t1)]">{renderInline(t)}</div>
      })}
    </div>
  )
}

const CACHE_KEY = 'workspace:youtube:state'

function readCache(): { query: string; results: YtVideo[] } {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { query: '', results: [] }
    const parsed = JSON.parse(raw)
    return {
      query: typeof parsed.query === 'string' ? parsed.query : '',
      results: Array.isArray(parsed.results) ? parsed.results : [],
    }
  } catch { return { query: '', results: [] } }
}

function writeCache(value: { query: string; results: YtVideo[] }) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)) } catch {}
}

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtViews(views: number | null): string {
  if (views == null) return ''
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1).replace('.', ',')} Mio. Aufrufe`
  if (views >= 1_000) return `${Math.round(views / 1_000)}k Aufrufe`
  return `${views} Aufrufe`
}

function fmtDate(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function VideoCard({ video, followed, saved, onPlay, onToggleFollow, onToggleSave, savedBy }: {
  video: YtVideo
  followed: boolean
  saved: boolean
  onPlay: () => void
  onToggleFollow: (() => void) | null
  onToggleSave: () => void
  savedBy?: 'christian' | 'klaus'
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay() } }}
      className="group min-w-0 cursor-pointer overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-1)] text-left hover:border-[var(--border-f)]"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-[var(--bg-2)]">
        <img src={video.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" draggable={false} />
        {video.duration != null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            {fmtDuration(video.duration)}
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <div className="line-clamp-2 min-h-[40px] text-sm font-medium leading-5 text-[var(--t1)]">{video.title}</div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs text-[var(--t2)]">{video.channel}</span>
          {onToggleFollow && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onToggleFollow() }}
              title={followed ? 'Nicht mehr folgen' : 'Kanal folgen'}
              className="shrink-0 rounded p-0.5 text-[var(--t3)] hover:text-[var(--t1)]"
            >
              {followed ? <BellOff className="h-3.5 w-3.5" /> : <BellPlus className="h-3.5 w-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleSave() }}
            title={saved ? 'Aus Merkliste entfernen' : 'Merken'}
            className="shrink-0 rounded p-0.5 text-[var(--t3)] hover:text-[var(--t1)]"
          >
            {saved ? <BookmarkCheck className="h-3.5 w-3.5 text-[var(--warm)]" /> : <Bookmark className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="truncate text-xs text-[var(--t3)]">
          {[fmtViews(video.views), fmtDate(video.timestamp)].filter(Boolean).join(' · ') || ' '}
        </div>
        {(savedBy === 'klaus' || video.klaus_pick) && (
          <div className="mt-1.5 inline-block rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--warm)]">von Agent markiert</div>
        )}
        {video.klaus_pick && video.klaus_reason && (
          <div className="mt-1 line-clamp-2 text-xs leading-4 text-[var(--t2)]">{video.klaus_reason}</div>
        )}
      </div>
    </div>
  )
}

export function YouTubeWorkspace() {
  const cached = readCache()
  const [tab, setTab] = useState<'search' | 'feed' | 'saved'>('feed')
  const [query, setQuery] = useState(cached.query)
  const [results, setResults] = useState<YtVideo[]>(cached.results)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [player, setPlayer] = useState<YtPlayerState>(getState())
  // Läuft beim Mount schon ein Video (Rückkehr ins Modul / Mini-Player-
  // Button), direkt wieder andocken statt die Liste zu zeigen.
  const [playerOpen, setPlayerOpen] = useState(() => !!getState().video)
  const [follows, setFollows] = useState<YtFollow[]>([])
  const [saved, setSaved] = useState<YtSaved[]>([])
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [dossierTick, setDossierTick] = useState(0)
  const [feed, setFeed] = useState<YtVideo[]>([])
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedError, setFeedError] = useState('')
  const [importPending, setImportPending] = useState(false)
  const [importRedirect, setImportRedirect] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => subscribe(setPlayer), [])
  // Player gestoppt (Mini-Player-X o. Ä.) -> zurück zur Liste
  useEffect(() => { if (!player.video) setPlayerOpen(false) }, [player.video])

  // Platzhalter beim globalen Player an-/abmelden; das iframe dockt dann hier an.
  useEffect(() => {
    if (playerOpen && player.video && anchorRef.current) {
      setAnchor(anchorRef.current)
      return () => setAnchor(null)
    }
  }, [playerOpen, player.video])

  const loadFollows = useCallback(async () => {
    try {
      const res = await fetch('/api/youtube/follows')
      const data = await res.json()
      setFollows(Array.isArray(data.follows) ? data.follows : [])
    } catch {}
  }, [])

  useEffect(() => { loadFollows() }, [loadFollows])

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch('/api/youtube/watchlist')
      const data = await res.json()
      setSaved(Array.isArray(data.items) ? data.items : [])
    } catch {}
  }, [])

  useEffect(() => { loadSaved() }, [loadSaved])

  const toggleSave = useCallback(async (video: YtVideo) => {
    const isSaved = saved.some(it => it.id === video.id)
    try {
      if (isSaved) {
        await fetch(`/api/youtube/watchlist/${encodeURIComponent(video.id)}`, { method: 'DELETE' })
      } else {
        await fetch('/api/youtube/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: video.id, title: video.title, channel: video.channel,
            channel_id: video.channel_id, thumbnail: video.thumbnail, duration: video.duration,
          }),
        })
      }
      loadSaved()
    } catch {}
  }, [saved, loadSaved])

  // Dossier des laufenden Videos laden und pollen, solange es verarbeitet wird.
  const dossierVideoId = playerOpen ? player.video?.id : undefined
  useEffect(() => {
    if (!dossierVideoId) { setDossier(null); return }
    let stopped = false
    let timer: ReturnType<typeof setInterval> | null = null
    const load = async () => {
      try {
        const res = await fetch(`/api/youtube/dossier/${encodeURIComponent(dossierVideoId)}`)
        const data = await res.json()
        if (stopped) return
        setDossier(data)
        if (timer && data.status !== 'processing' && data.status !== 'none') {
          clearInterval(timer)
          timer = null
        }
      } catch {}
    }
    load()
    timer = setInterval(load, 4000)
    return () => { stopped = true; if (timer) clearInterval(timer) }
  }, [dossierVideoId, dossierTick])

  const forceDossier = useCallback(async () => {
    const v = player.video
    if (!v) return
    setDossier({ status: 'processing' })
    try {
      await fetch(`/api/youtube/dossier/${encodeURIComponent(v.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: v.title, channel: v.channel, force: true }),
      })
    } catch {}
    setDossierTick(t => t + 1)
  }, [player.video])

  const loadFeed = useCallback(async () => {
    setFeedLoading(true)
    setFeedError('')
    try {
      const res = await fetch('/api/youtube/feed')
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.detail || `Feed fehlgeschlagen (${res.status})`)
      }
      const data = await res.json()
      setFeed(Array.isArray(data.results) ? data.results : [])
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : 'Feed fehlgeschlagen')
    } finally {
      setFeedLoading(false)
    }
  }, [])

  useEffect(() => { if (tab === 'feed') loadFeed() }, [tab, loadFeed])

  const startImport = useCallback(async () => {
    setImportMsg('')
    try {
      const res = await fetch('/api/youtube/import/start')
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data?.detail || 'Import konnte nicht gestartet werden')
      window.open(data.url, '_blank', 'noopener')
      setImportPending(true)
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Import konnte nicht gestartet werden')
    }
  }, [])

  const finishImport = useCallback(async () => {
    const raw = importRedirect.trim()
    if (!raw) return
    setImportBusy(true)
    setImportMsg('')
    try {
      const res = await fetch('/api/youtube/import/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_url: raw }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || `Import fehlgeschlagen (${res.status})`)
      setImportPending(false)
      setImportRedirect('')
      setImportMsg(`${data.imported} neue Abos übernommen (${data.subscriptions} insgesamt).`)
      loadFollows()
      loadFeed()
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Import fehlgeschlagen')
    } finally {
      setImportBusy(false)
    }
  }, [importRedirect, loadFollows, loadFeed])

  const toggleFollow = useCallback(async (video: YtVideo) => {
    if (!video.channel_id) return
    const isFollowed = follows.some(f => f.channel_id === video.channel_id)
    try {
      if (isFollowed) {
        await fetch(`/api/youtube/follows/${encodeURIComponent(video.channel_id)}`, { method: 'DELETE' })
      } else {
        await fetch('/api/youtube/follows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_id: video.channel_id, name: video.channel }),
        })
      }
      loadFollows()
    } catch {}
  }, [follows, loadFollows])

  const unfollow = useCallback(async (channelId: string) => {
    try {
      await fetch(`/api/youtube/follows/${encodeURIComponent(channelId)}`, { method: 'DELETE' })
      loadFollows()
    } catch {}
  }, [loadFollows])

  const search = useCallback(async (q: string) => {
    const term = q.trim()
    if (!term) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(term)}&limit=12`)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.detail || `Suche fehlgeschlagen (${res.status})`)
      }
      const data = await res.json()
      const list: YtVideo[] = Array.isArray(data.results) ? data.results : []
      setResults(list)
      writeCache({ query: term, results: list })
      if (list.length === 0) setError('Keine Treffer.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suche fehlgeschlagen')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!playerOpen && tab === 'search') inputRef.current?.focus()
  }, [playerOpen, tab])

  const startVideo = useCallback((video: YtVideo) => {
    play({ id: video.id, title: video.title, channel: video.channel, channelId: video.channel_id, thumbnail: video.thumbnail })
    setPlayerOpen(true)
  }, [])

  if (playerOpen && player.video) {
    const v = player.video
    return (
      <div className="@container flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={() => setPlayerOpen(false)}
            className="flex shrink-0 items-center gap-1.5 border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--t2)] hover:text-[var(--t1)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Zurück
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[var(--t1)]">{v.title}</div>
            <div className="truncate text-xs text-[var(--t3)]">{v.channel}</div>
          </div>
          <button
            type="button"
            onClick={() => toggleSave({ id: v.id, title: v.title, channel: v.channel, channel_id: v.channelId ?? null, duration: null, views: null, timestamp: null, thumbnail: v.thumbnail })}
            className="flex shrink-0 items-center gap-1.5 border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--t2)] hover:text-[var(--t1)]"
          >
            {saved.some(it => it.id === v.id)
              ? <><BookmarkCheck className="h-3.5 w-3.5 text-[var(--warm)]" /> Gemerkt</>
              : <><Bookmark className="h-3.5 w-3.5" /> Merken</>}
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <div className="mx-auto w-full max-w-[1100px]">
            {/* Platzhalter: das global gemountete iframe legt sich exakt hierüber */}
            <div ref={anchorRef} className="aspect-video w-full rounded-md bg-black" />
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="min-w-0 text-base font-medium leading-6 text-[var(--t1)]">{v.title}</h2>
            </div>
            <div className="mt-1 text-xs text-[var(--t3)]">{v.channel}</div>
            <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--warm)]" />
                <span className="text-xs font-medium text-[var(--t1)]">Auswertung von Agent</span>
                <span className="min-w-0 flex-1" />
                {dossier?.status === 'processing' && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--t3)]">
                    <Loader2 className="h-3 w-3 animate-spin" /> wird ausgewertet
                  </span>
                )}
                {(dossier?.status === 'skipped' || dossier?.status === 'error' || dossier?.status === 'none' || !dossier) && (
                  <button
                    type="button"
                    onClick={forceDossier}
                    className="shrink-0 border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--t2)] hover:text-[var(--t1)]"
                  >
                    Auswerten
                  </button>
                )}
              </div>
              {dossier?.status === 'done' && dossier.analysis && (
                <div className="mt-3">
                  <AnalysisBody text={dossier.analysis} />
                  <div className="mt-3 text-[11px] text-[var(--t3)]">
                    Transkript und Dossier liegen bereit, du kannst Agent im Chat direkt dazu fragen.
                  </div>
                </div>
              )}
              {dossier?.status === 'skipped' && (
                <div className="mt-2 text-xs text-[var(--t3)]">
                  Übersprungen, {dossier.reason || 'kein Inhalts-Video'}. Über den Knopf wertet Agent trotzdem aus.
                </div>
              )}
              {dossier?.status === 'error' && (
                <div className="mt-2 text-xs text-[var(--warm)]">
                  Auswertung fehlgeschlagen. {dossier.error || ''}
                </div>
              )}
              {dossier?.status === 'processing' && (
                <div className="mt-2 text-xs text-[var(--t3)]">
                  Agent zieht das Transkript und schreibt die Kurzauswertung, das dauert je nach Videolänge ein paar Minuten.
                </div>
              )}
            </div>
            <div className="mt-3 text-xs text-[var(--t3)]">
              Läuft beim Modulwechsel im Mini-Player weiter, unten rechts.
            </div>
          </div>
        </main>
      </div>
    )
  }

  const followedIds = new Set(follows.map(f => f.channel_id))
  const savedIds = new Set(saved.map(it => it.id))

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src="/youtube.svg" alt="" className="h-[18px] w-auto shrink-0" draggable={false} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">YouTube</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] p-0.5">
            {([['feed', 'Feed'], ['search', 'Suche'], ['saved', 'Gemerkt']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded px-2.5 py-1 text-xs ${tab === id ? 'bg-[var(--bg-2)] text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'search' && (
          <form
            className="mt-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2"
            onSubmit={e => { e.preventDefault(); search(query) }}
          >
            {loading
              ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--t3)]" />
              : <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />}
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Videos suchen"
              enterKeyHint="search"
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="shrink-0 border border-[var(--border)] px-3 py-1 text-xs text-[var(--t2)] hover:text-[var(--t1)] disabled:opacity-60"
            >
              Suchen
            </button>
          </form>
        )}
        {tab === 'feed' && (
          <div className="mt-3 flex flex-col gap-2">
            {!importPending ? (
              <button type="button" onClick={startImport}
                className="self-start border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--t2)] hover:text-[var(--t1)]">
                Abos von YouTube importieren
              </button>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2.5">
                <div className="text-xs text-[var(--t2)]">
                  Melde dich im neuen Tab bei Google an. Danach landest du auf einer leeren localhost Seite, kopiere deren komplette Adresse aus der Browserzeile hier rein.
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={importRedirect}
                    onChange={e => setImportRedirect(e.target.value)}
                    placeholder="http://localhost/?code=..."
                    className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--t1)] outline-none placeholder:text-[var(--t3)]"
                  />
                  <button type="button" onClick={finishImport} disabled={importBusy || !importRedirect.trim()}
                    className="shrink-0 border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--t2)] hover:text-[var(--t1)] disabled:opacity-60">
                    {importBusy ? 'Importiere…' : 'Import abschließen'}
                  </button>
                  <button type="button" onClick={() => { setImportPending(false); setImportMsg('') }}
                    className="shrink-0 px-1.5 py-1 text-xs text-[var(--t3)] hover:text-[var(--t1)]">
                    Abbrechen
                  </button>
                </div>
              </div>
            )}
            {importMsg && <div className="text-xs text-[var(--t2)]">{importMsg}</div>}
          </div>
        )}
        {tab === 'feed' && follows.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {follows.map(f => (
              <span key={f.channel_id} className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-1)] py-0.5 pl-2.5 pr-1 text-xs text-[var(--t2)]">
                {f.name}
                <button type="button" onClick={() => unfollow(f.channel_id)} title="Nicht mehr folgen"
                  className="rounded-full p-0.5 text-[var(--t3)] hover:text-[var(--t1)]">
                  <BellOff className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button type="button" onClick={loadFeed} title="Feed aktualisieren"
              className="ml-auto rounded p-1 text-[var(--t3)] hover:text-[var(--t1)]">
              <RefreshCw className={`h-3.5 w-3.5 ${feedLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
        {tab === 'search' && error && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--warm)]">{error}</div>}
        {tab === 'feed' && feedError && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--warm)]">{feedError}</div>}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
        {tab === 'search' ? (
          results.length === 0 && !loading && !error ? (
            <div className="px-1 py-6 text-sm text-[var(--t3)]">Such oben nach einem Video, die Treffer landen hier als Karten. Über das Glocken-Symbol an einer Karte folgst du dem Kanal für den Feed.</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2 @min-[860px]:grid-cols-3">
              {results.map(video => (
                <VideoCard
                  key={video.id}
                  video={video}
                  followed={!!video.channel_id && followedIds.has(video.channel_id)}
                  saved={savedIds.has(video.id)}
                  onPlay={() => startVideo(video)}
                  onToggleFollow={video.channel_id ? () => toggleFollow(video) : null}
                  onToggleSave={() => toggleSave(video)}
                />
              ))}
            </div>
          )
        ) : tab === 'saved' ? (
          saved.length === 0 ? (
            <div className="px-1 py-6 text-sm text-[var(--t3)]">
              Noch nichts gemerkt. Über das Lesezeichen an einer Videokarte oder den Merken-Knopf im Player landet ein Video hier. Agent kann dir hier auch selbst Videos markieren.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2 @min-[860px]:grid-cols-3">
              {saved.map(it => {
                const video: YtVideo = { id: it.id, title: it.title, channel: it.channel, channel_id: it.channel_id, duration: it.duration, views: null, timestamp: null, thumbnail: it.thumbnail }
                return (
                  <VideoCard
                    key={it.id}
                    video={video}
                    followed={!!it.channel_id && followedIds.has(it.channel_id)}
                    saved
                    savedBy={it.saved_by}
                    onPlay={() => startVideo(video)}
                    onToggleFollow={null}
                    onToggleSave={() => toggleSave(video)}
                  />
                )
              })}
            </div>
          )
        ) : follows.length === 0 ? (
          <div className="px-1 py-6 text-sm text-[var(--t3)]">
            Noch keine Kanäle gefolgt. Such in der Suche nach Videos und folge Kanälen über das Glocken-Symbol, dann erscheinen deren neueste Videos hier. Oder hol dir deine echten YouTube-Abos über den Knopf oben, Abos von YouTube importieren.
          </div>
        ) : feedLoading && feed.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-[var(--t3)]"><Loader2 className="h-4 w-4 animate-spin" /> Feed wird geladen…</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @min-[520px]:grid-cols-2 @min-[860px]:grid-cols-3">
            {feed.map(video => (
              <VideoCard
                key={video.id}
                video={video}
                followed={!!video.channel_id && followedIds.has(video.channel_id)}
                saved={savedIds.has(video.id)}
                onPlay={() => startVideo(video)}
                onToggleFollow={video.channel_id ? () => toggleFollow(video) : null}
                onToggleSave={() => toggleSave(video)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
