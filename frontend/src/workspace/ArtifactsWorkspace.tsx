import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Database, FileText, RefreshCw, Search } from 'lucide-react'

type ArtifactEntry = {
  agent: string
  agentName: string
  color: string
  category: string
  name: string
  label?: string
  relativeDate?: string
  path: string
  ts: number
}

const CACHE_KEY = 'workspace:artifacts:entries'

function readCache(): ArtifactEntry[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) as ArtifactEntry[] : []
  } catch { return [] }
}

function writeCache(entries: ArtifactEntry[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(entries)) } catch {}
}

const DEMO_ARTIFACTS: ArtifactEntry[] = [
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'report', name: 'demo-kundenbriefing.html', label: 'Kundenbriefing als HTML', relativeDate: 'Demo', path: '/workspace/work/artifacts/demo-kundenbriefing.html', ts: 0 },
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'doc', name: 'demo-protokoll.md', label: 'Werkbank-Protokoll', relativeDate: 'Demo', path: '/workspace/work/artifacts/demo-protokoll.md', ts: 0 },
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'asset:image', name: 'demo-visual.png', label: 'Kampagnenvisual', relativeDate: 'Demo', path: '/workspace/work/artifacts/demo-visual.png', ts: 0 },
]

// Immer mit Uhrzeit: heute nur die Zeit, sonst Tag plus Zeit. Das Datum allein
// ist redundant, weil die Dateien ohnehin nach Datum heissen.
function fmtWhen(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `${time} Uhr`
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return `gestern ${time}`
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} · ${time}`
}

function categoryLabel(category: string): string {
  if (category.startsWith('job:')) return category.slice(4).replaceAll('-', ' ')
  if (category.startsWith('asset:')) return `Asset · ${category.slice(6).replaceAll('-', ' ')}`
  if (category === 'share') return 'Share'
  return category || 'Artefakt'
}

function ext(path: string): string {
  const match = path.match(/\.([^.]+)$/)
  return match ? match[1].toUpperCase() : 'FILE'
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path)
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path)
}

function downloadUrl(path: string): string {
  return `/api/fs/download?path=${encodeURIComponent(path)}&inline=1`
}

function openArtifact(path: string) {
  window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path } }))
}

// Das kleine Vorschau-Quadrat links in jeder Zeile: Bild als echtes Thumbnail,
// HTML als verkleinerte Live-Seite (gibt zumindest die CI-Farbe), sonst ein
// ruhiges Datei-Glyph. Eine feste Groesse haelt die Liste sauber ausgerichtet.
function ArtifactThumb({ entry }: { entry: ArtifactEntry }) {
  const url = downloadUrl(entry.path)
  if (isImage(entry.path)) {
    return <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" draggable={false} />
  }
  if (isHtml(entry.path)) {
    return (
      <iframe
        src={url}
        tabIndex={-1}
        loading="lazy"
        sandbox="allow-same-origin"
        title={entry.name}
        className="pointer-events-none absolute left-0 top-0 origin-top-left"
        style={{ width: '400%', height: '400%', transform: 'scale(0.25)', border: 0 }}
      />
    )
  }
  const Icon = isMarkdown(entry.path) ? FileText : Database
  return (
    <div className="flex h-full w-full items-center justify-center text-[var(--t3)]">
      <Icon className="h-5 w-5" />
    </div>
  )
}

// Eine ruhige Zeile fuer jedes Artefakt: Thumbnail, Titel, darunter Kategorie
// und Zeit. Kein Kasten, nur eine Haarlinie als Trenner. Apple-Liste trifft
// Claude-Verlauf: alles gleich aufgebaut, scanbar, leise.
function ArtifactLine({ entry }: { entry: ArtifactEntry }) {
  return (
    <article className="group flex w-full min-w-0 items-center gap-3 border-b border-[var(--border)] px-2 py-2.5 text-left transition-colors hover:bg-white/[0.03]">
      <button type="button" onClick={() => openArtifact(entry.path)} title={entry.path} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
          <ArtifactThumb entry={entry} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--t1)]">{entry.label || entry.name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--t3)]">{categoryLabel(entry.category)} · {fmtWhen(entry.ts) || entry.relativeDate || 'Demo'}</span>
        </span>
      </button>
      <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--t3)]">{ext(entry.path)}</span>
      <a
        href={`/api/fs/download?path=${encodeURIComponent(entry.path)}`}
        className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--t3)] transition-colors hover:bg-white/[0.05] hover:text-[var(--t1)]"
        title="Herunterladen"
        onClick={e => e.stopPropagation()}
      >
        Download
      </a>
    </article>
  )
}

type Filter = 'all' | 'html' | 'image' | 'doc' | 'data'

function kindOf(entry: ArtifactEntry): Filter {
  if (isHtml(entry.path)) return 'html'
  if (isImage(entry.path)) return 'image'
  if (isMarkdown(entry.path)) return 'doc'
  return 'data'
}

const FILTER_LABEL: Record<Filter, string> = {
  all: 'Alle',
  html: 'Visualisierungen',
  image: 'Bilder',
  doc: 'Notizen',
  data: 'Daten',
}

export function ArtifactsWorkspace() {
  const [entries, setEntries] = useState<ArtifactEntry[]>(() => readCache())
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/recent-entries?limit=100', { cache: 'no-store' })
      const data = await res.json()
      const next = Array.isArray(data.entries) && data.entries.length ? data.entries as ArtifactEntry[] : DEMO_ARTIFACTS
      setEntries(next)
      writeCache(next)
    } catch (e) {
      setError(`Artefakte gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Ein einziger Strom, neueste zuerst. Suche und Filter greifen direkt darauf,
  // statt die Liste in vier Stapel zu zerlegen.
  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase()
    return [...entries]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .filter(entry => {
        if (!q) return true
        return [entry.label, entry.name, entry.category, entry.path, entry.agentName]
          .filter(Boolean).join(' ').toLowerCase().includes(q)
      })
  }, [entries, query])

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: sorted.length, html: 0, image: 0, doc: 0, data: 0 }
    for (const e of sorted) c[kindOf(e)]++
    return c
  }, [sorted])

  const visible = useMemo(
    () => filter === 'all' ? sorted : sorted.filter(e => kindOf(e) === filter),
    [sorted, filter],
  )

  const filters: Filter[] = ['all', 'html', 'image', 'doc', 'data']

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Artefakte</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">Was Agent gebaut hat</h2>
            <div className="truncate text-xs text-[var(--t3)]">Reports, Visualisierungen und Dateien aus Chats und Jobs</div>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 rounded-md border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <label className="mb-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, Kategorie oder Pfad suchen" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]" />
        </label>

        {/* Leise Filterzeile statt bunter Pillen: aktiver Filter in Terracotta. */}
        <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[12px]">
          {filters.map(f => {
            const active = filter === f
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                disabled={f !== 'all' && counts[f] === 0}
                className={`transition-colors disabled:opacity-30 ${active ? 'font-semibold text-[var(--warm)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
              >
                {FILTER_LABEL[f]} <span className="tabular-nums opacity-70">{counts[f]}</span>
              </button>
            )
          })}
        </div>

        {error && <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

        <div className="mt-2">
          {visible.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Artefakte' : 'Keine Artefakte.'}</div>
          ) : (
            visible.map(entry => <ArtifactLine key={`${entry.path}:${entry.ts}`} entry={entry} />)
          )}
        </div>
      </main>
    </div>
  )
}
