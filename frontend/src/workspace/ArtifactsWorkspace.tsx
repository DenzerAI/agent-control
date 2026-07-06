import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BarChart3, Database, Download, FileText, Image, Presentation, RefreshCw, Search, X } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

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
  demoText?: string
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
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'report', name: 'kundenlage-report.html', label: 'Kundenlage Report', relativeDate: 'Demo', path: '/workspace/work/artifacts/kundenlage-report.html', ts: 0, demoText: 'Ein klarer Überblick über Lage, Hebel und nächste Entscheidung.' },
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'chart', name: 'pipeline-chart.svg', label: 'Pipeline Chart', relativeDate: 'Demo', path: '/workspace/work/artifacts/pipeline-chart.svg', ts: 0, demoText: 'Verdichtete Kennzahlen als ruhige Chart-Ansicht.' },
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'presentation', name: 'strategie-deck.pdf', label: 'Strategie Präsentation', relativeDate: 'Demo', path: '/workspace/work/artifacts/strategie-deck.pdf', ts: 0, demoText: 'Drei Slides, die ein Angebot schnell erklärbar machen.' },
  { agent: 'main', agentName: 'Agent', color: '#D97757', category: 'asset:image', name: 'kampagnenmotiv.png', label: 'Kampagnenmotiv', relativeDate: 'Demo', path: '/workspace/work/artifacts/kampagnenmotiv.png', ts: 0, demoText: 'Ein visuelles Motiv für Landingpage oder Kundenmail.' },
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
function iconFor(entry: ArtifactEntry) {
  if (entry.category === 'chart') return BarChart3
  if (entry.category === 'presentation') return Presentation
  if (isImage(entry.path)) return Image
  if (isMarkdown(entry.path)) return FileText
  if (isHtml(entry.path)) return FileText
  return Database
}

function ArtifactThumb({ entry }: { entry: ArtifactEntry }) {
  const DemoIcon = iconFor(entry)
  if (entry.demoText) {
    return (
      <div className="workspace-artifact-demo-thumb">
        <DemoIcon className="h-5 w-5" />
      </div>
    )
  }
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
function ArtifactLine({ entry, onOpen }: { entry: ArtifactEntry; onOpen: (entry: ArtifactEntry) => void }) {
  return (
    <article className="workspace-artifact-line group">
      <button type="button" onClick={() => entry.demoText ? onOpen(entry) : openArtifact(entry.path)} title={entry.path} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
          <ArtifactThumb entry={entry} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--t1)]">{entry.label || entry.name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--t3)]">{entry.demoText || `${categoryLabel(entry.category)} · ${fmtWhen(entry.ts) || entry.relativeDate || 'Demo'}`}</span>
        </span>
      </button>
      <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--t3)]">{ext(entry.path)}</span>
      <a
        href={entry.demoText ? `data:text/plain;charset=utf-8,${encodeURIComponent(`${entry.label}\n\n${entry.demoText}`)}` : `/api/fs/download?path=${encodeURIComponent(entry.path)}`}
        download={entry.name}
        className="workspace-artifact-download"
        title="Herunterladen"
        onClick={e => e.stopPropagation()}
      >
        <Download className="h-4 w-4" />
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
  const [openDemo, setOpenDemo] = useState<ArtifactEntry | null>(null)
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
    <WorkspaceShell
      eyebrow="Artefakte"
      title="Was der Agent gebaut hat"
      subtitle="Reports, Charts, Präsentationen und Bilder als saubere Liste. Demo-Artefakte öffnen direkt als Vollbild-Vorschau."
      action={
        <button type="button" onClick={load} disabled={loading} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      }
    >

      <main className="workspace-system-main workspace-system-stack">
        <label className="workspace-artifact-search">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--t3)]" />
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

        {error && <div className="workspace-system-note flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

        <section className="workspace-system-panel">
          {visible.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Artefakte' : 'Keine Artefakte.'}</div>
          ) : (
            visible.map(entry => <ArtifactLine key={`${entry.path}:${entry.ts}`} entry={entry} onOpen={setOpenDemo} />)
          )}
        </section>
      </main>
      {openDemo && <ArtifactDemoLightbox entry={openDemo} onClose={() => setOpenDemo(null)} />}
    </WorkspaceShell>
  )
}

function ArtifactDemoLightbox({ entry, onClose }: { entry: ArtifactEntry; onClose: () => void }) {
  const Icon = iconFor(entry)
  return (
    <div className="workspace-artifact-lightbox" role="dialog" aria-modal="true">
      <div className="workspace-artifact-lightbox-panel">
        <button type="button" className="workspace-artifact-lightbox-close" onClick={onClose} title="Schließen">
          <X className="h-4 w-4" />
        </button>
        <div className="workspace-artifact-lightbox-visual">
          <Icon className="h-12 w-12" />
          <span>{categoryLabel(entry.category)}</span>
        </div>
        <h3>{entry.label || entry.name}</h3>
        <p>{entry.demoText}</p>
        <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${entry.label}\n\n${entry.demoText}`)}`} download={entry.name}>
          <Download className="h-4 w-4" />
          Download
        </a>
      </div>
    </div>
  )
}
