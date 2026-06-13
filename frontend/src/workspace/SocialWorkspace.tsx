import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, Film, Image, Images, Loader2, RefreshCw, Trash2, Video } from 'lucide-react'
import { formatScheduled, stateColor, stateLabel, type SocialState } from '../components/info-pane/utils/social'
import { relativeTime } from '../components/info-pane/utils/format'

type Reel = {
  id: string
  file: string
  title: string
  url: string
  size_mb: number
  duration_sec: number | null
  rendered_at: number
  caption: string | null
  caption_path: string | null
  state?: SocialState
  approved?: boolean
  last_error?: string | null
  published: { started_at_str?: string; catbox_url?: string | null; ig_media_id?: string | null; published_at?: number | null } | null
  scheduled_for?: string | null
  scheduled_time?: string | null
  draft_title?: string | null
}

type Karussell = {
  id: string
  title: string
  slides: { n: number; url: string }[]
  slide_count: number
  rendered_at: number
  caption: string | null
  state?: SocialState
  approved?: boolean
  scheduled_for?: string | null
  last_error?: string | null
  published: { ig_media_id?: string; published_at?: number } | null
}

type Beitrag = {
  id: string
  title: string
  url: string
  rendered_at: number
  caption: string | null
  state?: SocialState
  approved?: boolean
  scheduled_for?: string | null
  last_error?: string | null
  published: { ig_media_id?: string; published_at?: number } | null
}

type SocialKind = 'reel' | 'karussell' | 'beitrag'
type SelectedItem = { kind: SocialKind; id: string }
type PipelineItem =
  | { kind: 'reel'; id: string; title: string; state?: SocialState; scheduled_for?: string | null; scheduled_time?: string | null; rendered_at: number; published_at?: number | null; item: Reel; versions: Reel[] }
  | { kind: 'karussell'; id: string; title: string; state?: SocialState; scheduled_for?: string | null; rendered_at: number; published_at?: number | null; item: Karussell }
  | { kind: 'beitrag'; id: string; title: string; state?: SocialState; scheduled_for?: string | null; rendered_at: number; published_at?: number | null; item: Beitrag }

type CacheEnvelope<T> = { ts: number; data: T }

const CACHE_PREFIX = 'infopane:cache:'
const CACHE_KEYS = {
  reels: 'social:reels',
  karussells: 'social:karussells',
  beitraege: 'social:beitraege',
}

function readPaneCache<T>(key: string, fallback: T): CacheEnvelope<T> {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${key}`)
    if (!raw) return { ts: 0, data: fallback }
    const parsed = JSON.parse(raw)
    return parsed && 'data' in parsed
      ? { ts: Number(parsed.ts || 0), data: parsed.data as T }
      : { ts: 0, data: fallback }
  } catch {
    return { ts: 0, data: fallback }
  }
}

function writePaneCache(key: string, data: unknown) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({ ts: Date.now(), data }))
  } catch {}
}

function fetchJsonWithTimeout<T>(url: string, init?: RequestInit, timeoutMs = 12000): Promise<T> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', ...init, signal: ctrl.signal })
    .then(async r => {
      if (!r.ok) throw new Error((await r.text()) || r.statusText)
      return r.json() as Promise<T>
    })
    .finally(() => window.clearTimeout(timer))
}

function encPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/')
}

function isLive(state?: SocialState): boolean {
  return state === 'published'
}

function statusText(item: PipelineItem): string {
  if (item.kind === 'reel' && item.scheduled_for && item.state !== 'published') {
    return `${formatScheduled(item.scheduled_for)} ${item.scheduled_time || '18:00'}`
  }
  if (item.state === 'queued') return formatScheduled(item.scheduled_for, 'wartet auf Slot')
  return stateLabel(item.state, item.published_at ?? null)
}

function sortPipeline<T extends { state?: SocialState; scheduled_for?: string | null; rendered_at: number }>(items: T[]): T[] {
  const rank = (state?: SocialState) => state === 'queued' ? 0 : state === 'failed' ? 1 : state === 'pending' ? 2 : 3
  return [...items].sort((a, b) => {
    const ranked = rank(a.state) - rank(b.state)
    if (ranked !== 0) return ranked
    if (a.state === 'queued' && b.state === 'queued') {
      const da = a.scheduled_for || '9999'
      const db = b.scheduled_for || '9999'
      if (da !== db) return da < db ? -1 : 1
    }
    return b.rendered_at - a.rendered_at
  })
}

function reelVersion(reel: Reel): number {
  return Number((reel.id.match(/-v(\d+)$/i) || [])[1] || 0)
}

function reelGroupKey(reel: Reel): string {
  const match = reel.id.match(/^(clip|opus-rank)(\d+)-v(\d+)$/i)
  return match ? `${match[1].toLowerCase()}${match[2]}` : reel.id
}

function fmtCacheAge(ts: number): string {
  if (!ts) return 'kein Cache'
  return `Cache ${relativeTime(Math.floor(ts / 1000))}`
}

function kindLabel(kind: SocialKind): string {
  if (kind === 'reel') return 'Reel'
  if (kind === 'karussell') return 'Karussell'
  return 'Beitrag'
}

function instagramUrl(item: PipelineItem): string | null {
  const id = item.kind === 'reel'
    ? item.item.published?.ig_media_id
    : item.item.published?.ig_media_id
  if (!id) return null
  return item.kind === 'reel'
    ? `https://www.instagram.com/reel/${id}`
    : `https://www.instagram.com/p/${id}`
}

function itemCaption(item: PipelineItem): string {
  return item.item.caption || ''
}

function itemError(item: PipelineItem): string {
  return item.item.last_error || ''
}

function itemPrimaryUrl(item: PipelineItem): string {
  if (item.kind === 'karussell') return item.item.slides[0]?.url || ''
  return item.item.url
}

export function SocialWorkspace() {
  const cachedReels = readPaneCache<Reel[]>(CACHE_KEYS.reels, [])
  const cachedKarussells = readPaneCache<Karussell[]>(CACHE_KEYS.karussells, [])
  const cachedBeitraege = readPaneCache<Beitrag[]>(CACHE_KEYS.beitraege, [])
  const [reels, setReels] = useState<Reel[]>(cachedReels.data)
  const [karussells, setKarussells] = useState<Karussell[]>(cachedKarussells.data)
  const [beitraege, setBeitraege] = useState<Beitrag[]>(cachedBeitraege.data)
  const [cacheTs, setCacheTs] = useState(Math.max(cachedReels.ts, cachedKarussells.ts, cachedBeitraege.ts))
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [reelResult, karussellResult, beitragResult] = await Promise.allSettled([
      fetchJsonWithTimeout<{ reels?: Reel[] }>('/api/reels'),
      fetchJsonWithTimeout<{ karussells?: Karussell[] }>('/api/karussells'),
      fetchJsonWithTimeout<{ beitraege?: Beitrag[] }>('/api/beitraege'),
    ])

    const failures: string[] = []
    if (reelResult.status === 'fulfilled') {
      const next = reelResult.value.reels || []
      setReels(next)
      writePaneCache(CACHE_KEYS.reels, next)
    } else {
      failures.push(`Reels: ${reelResult.reason instanceof Error ? reelResult.reason.message : 'nicht erreichbar'}`)
    }

    if (karussellResult.status === 'fulfilled') {
      const next = karussellResult.value.karussells || []
      setKarussells(next)
      writePaneCache(CACHE_KEYS.karussells, next)
    } else {
      failures.push(`Karussells: ${karussellResult.reason instanceof Error ? karussellResult.reason.message : 'nicht erreichbar'}`)
    }

    if (beitragResult.status === 'fulfilled') {
      const next = beitragResult.value.beitraege || []
      setBeitraege(next)
      writePaneCache(CACHE_KEYS.beitraege, next)
    } else {
      failures.push(`Beiträge: ${beitragResult.reason instanceof Error ? beitragResult.reason.message : 'nicht erreichbar'}`)
    }

    if (failures.length) {
      setError(`${failures.join(' · ')}. Letzter Stand bleibt sichtbar.`)
    } else {
      setCacheTs(Date.now())
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 180000)
    return () => window.clearInterval(id)
  }, [load])

  const pipeline = useMemo(() => {
    const reelGroups = new Map<string, Reel[]>()
    for (const reel of reels) {
      const key = reelGroupKey(reel)
      reelGroups.set(key, [...(reelGroups.get(key) || []), reel])
    }

    const reelItems: PipelineItem[] = []
    for (const versionsRaw of reelGroups.values()) {
      const versions = [...versionsRaw].sort((a, b) => reelVersion(b) - reelVersion(a) || b.rendered_at - a.rendered_at)
      const current = versions[0]
      if (!current || isLive(current.state)) continue
      reelItems.push({
        kind: 'reel',
        id: current.id,
        title: current.title,
        state: current.state,
        scheduled_for: current.scheduled_for,
        scheduled_time: current.scheduled_time,
        rendered_at: current.rendered_at,
        published_at: current.published?.published_at ?? null,
        item: current,
        versions,
      })
    }

    const karussellItems: PipelineItem[] = karussells
      .filter(item => !isLive(item.state))
      .map(item => ({
        kind: 'karussell',
        id: item.id,
        title: item.title,
        state: item.state,
        scheduled_for: item.scheduled_for,
        rendered_at: item.rendered_at,
        published_at: item.published?.published_at ?? null,
        item,
      }))

    const beitragItems: PipelineItem[] = beitraege
      .filter(item => !isLive(item.state))
      .map(item => ({
        kind: 'beitrag',
        id: item.id,
        title: item.title,
        state: item.state,
        scheduled_for: item.scheduled_for,
        rendered_at: item.rendered_at,
        published_at: item.published?.published_at ?? null,
        item,
      }))

    return {
      reels: sortPipeline(reelItems),
      karussells: sortPipeline(karussellItems),
      beitraege: sortPipeline(beitragItems),
    }
  }, [reels, karussells, beitraege])

  const allItems = useMemo(
    () => [...pipeline.reels, ...pipeline.karussells, ...pipeline.beitraege],
    [pipeline],
  )

  const activeItem = useMemo(() => {
    if (selected) {
      const found = allItems.find(item => item.kind === selected.kind && item.id === selected.id)
      if (found) return found
    }
    return allItems[0] || null
  }, [allItems, selected])

  const stats = useMemo(() => {
    const queued = allItems.filter(item => item.state === 'queued').length
    const failed = allItems.filter(item => item.state === 'failed').length
    const pending = allItems.filter(item => item.state === 'pending' || !item.state).length
    return { total: allItems.length, queued, failed, pending }
  }, [allItems])

  const reloadAfterAction = useCallback(() => {
    window.setTimeout(load, 150)
  }, [load])

  const approve = useCallback(async (item: PipelineItem) => {
    const key = `approve:${item.kind}:${item.id}`
    setBusyAction(key)
    setError('')
    try {
      const path = item.kind === 'karussell'
        ? `/api/karussells/${encPath(item.id)}/approve`
        : item.kind === 'beitrag'
          ? `/api/beitraege/${encodeURIComponent(item.id)}/approve`
          : `/api/reels/${encodeURIComponent(item.id)}/approve`
      await fetchJsonWithTimeout(path, { method: 'POST' }, 18000)
      reloadAfterAction()
    } catch (e) {
      setError(`Approve nicht ausgeführt, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setBusyAction(null)
    }
  }, [reloadAfterAction])

  const discard = useCallback(async (item: PipelineItem) => {
    if (!confirm(`${kindLabel(item.kind)} verwerfen? (bleibt auf der Platte, raus aus der Pane)`)) return
    const key = `del:${item.kind}:${item.id}`
    setBusyAction(key)
    setError('')
    try {
      const path = item.kind === 'karussell'
        ? `/api/karussells/${encPath(item.id)}`
        : item.kind === 'beitrag'
          ? `/api/beitraege/${encodeURIComponent(item.id)}`
          : `/api/reels/${encodeURIComponent(item.id)}`
      await fetchJsonWithTimeout(path, { method: 'DELETE' }, 18000)
      setSelected(null)
      reloadAfterAction()
    } catch (e) {
      setError(`Verwerfen nicht ausgeführt, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setBusyAction(null)
    }
  }, [reloadAfterAction])

  const headline = stats.failed > 0
    ? 'Fehler prüfen'
    : stats.pending > 0
      ? 'Freigaben offen'
      : stats.queued > 0
        ? 'Plan steht'
        : 'Pipeline leer'

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] text-[var(--t1)]">
      <div className="@container mx-auto flex w-full max-w-[1180px] flex-col gap-3 p-3 @min-[640px]:p-4">
        <header className="flex min-h-[92px] items-start justify-between gap-3 border-b border-[var(--border)]/60 pb-3">
          <div className="min-w-0">
            <p className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--t3)]">
              <Film className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">Social Media · Reels · Karussells · Beiträge</span>
            </p>
            <h2 className="truncate text-[22px] font-semibold leading-tight text-[var(--t1)] @min-[640px]:text-[26px]">{headline}</h2>
            <span className="mt-1 block max-w-[680px] text-[13px] leading-5 text-[var(--t3)]">
              {stats.total > 0
                ? `${stats.total} aktive Assets in der Pipeline. ${stats.pending} warten auf Approve, ${stats.queued} sind geplant.`
                : 'Keine offenen Social Assets im aktuellen Stand.'}
            </span>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="Neu laden"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-[var(--border)]/70 text-[var(--t2)] hover:bg-white/[0.04] disabled:opacity-50"
          >
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </header>

        <div className="grid grid-cols-2 gap-2 @min-[680px]:grid-cols-4">
          <Stat label="Aktiv" value={stats.total} detail={fmtCacheAge(cacheTs)} />
          <Stat label="Approve" value={stats.pending} detail="wartet auf Freigabe" />
          <Stat label="Geplant" value={stats.queued} detail="nächste Slots zuerst" />
          <Stat label="Fehler" value={stats.failed} detail="sichtbar halten" tone={stats.failed ? 'bad' : 'neutral'} />
        </div>

        {error && (
          <div className="rounded-md border border-[var(--red,#ef4444)]/30 bg-[var(--red,#ef4444)]/10 px-3 py-2 text-[13px] leading-5 text-[var(--t2)]">
            {error}
          </div>
        )}

        <main className="grid grid-cols-1 gap-3 @min-[860px]:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <section className="min-w-0 rounded-md border border-[var(--border)]/70 bg-[var(--bg-1)]">
            <PanelHead title="Pipeline" meta={loading ? 'lädt …' : `${stats.total} offen`} />
            <div className="divide-y divide-[var(--border)]/50">
              <Bucket title="Reels" icon={Video} items={pipeline.reels} selected={activeItem} onSelect={setSelected} />
              <Bucket title="Karussells" icon={Images} items={pipeline.karussells} selected={activeItem} onSelect={setSelected} />
              <Bucket title="Beiträge" icon={Image} items={pipeline.beitraege} selected={activeItem} onSelect={setSelected} />
            </div>
          </section>

          <section className="min-w-0 rounded-md border border-[var(--border)]/70 bg-[var(--bg-1)]">
            {activeItem ? (
              <Detail item={activeItem} busyAction={busyAction} onApprove={approve} onDiscard={discard} />
            ) : (
              <div className="flex min-h-[360px] items-center justify-center px-4 text-center text-[13px] text-[var(--t3)]">
                {loading ? 'Social Pipeline lädt …' : 'Pipeline leer.'}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}

function Stat({ label, value, detail, tone = 'neutral' }: { label: string; value: number; detail: string; tone?: 'neutral' | 'bad' }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)]/70 bg-[var(--bg-1)] px-3 py-2">
      <span className="block truncate text-[11px] uppercase tracking-[0.14em] text-[var(--t3)]">{label}</span>
      <strong className={`mt-1 block text-[22px] font-semibold leading-none ${tone === 'bad' ? 'text-[var(--red,#ef4444)]' : 'text-[var(--t1)]'}`}>{value}</strong>
      <em className="mt-1 block truncate text-[12px] not-italic text-[var(--t3)]">{detail}</em>
    </section>
  )
}

function PanelHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border)]/60 px-3 py-2">
      <strong className="truncate text-[13px] font-medium text-[var(--t1)]">{title}</strong>
      <span className="flex-shrink-0 text-[12px] text-[var(--t3)]">{meta}</span>
    </div>
  )
}

function Bucket({ title, icon: Icon, items, selected, onSelect }: {
  title: string
  icon: typeof Video
  items: PipelineItem[]
  selected: PipelineItem | null
  onSelect: (item: SelectedItem) => void
}) {
  return (
    <div className="py-2">
      <div className="mb-1 flex items-center gap-2 px-3 text-[12px] text-[var(--t3)]">
        <Icon className="h-3.5 w-3.5" />
        <span className="font-medium text-[var(--t2)]">{title}</span>
        <span className="ml-auto tabular-nums">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-[var(--t3)]/70">Leer.</p>
      ) : (
        <div className="space-y-0.5 px-1.5">
          {items.map(item => {
            const active = selected?.kind === item.kind && selected.id === item.id
            return (
              <button
                key={`${item.kind}:${item.id}`}
                type="button"
                onClick={() => onSelect({ kind: item.kind, id: item.id })}
                className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/[0.04] ${active ? 'bg-white/[0.06]' : ''}`}
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: stateColor(item.state) }} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--t2)]">{item.title}</span>
                <span className="max-w-[42%] flex-shrink-0 truncate text-[11px] tabular-nums text-[var(--t3)]">{statusText(item)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Detail({ item, busyAction, onApprove, onDiscard }: {
  item: PipelineItem
  busyAction: string | null
  onApprove: (item: PipelineItem) => void
  onDiscard: (item: PipelineItem) => void
}) {
  const isQueued = item.state === 'queued'
  const approveBusy = busyAction === `approve:${item.kind}:${item.id}`
  const deleteBusy = busyAction === `del:${item.kind}:${item.id}`
  const liveUrl = instagramUrl(item)
  const caption = itemCaption(item)
  const error = itemError(item)

  return (
    <div className="@container flex min-h-[360px] flex-col">
      <PanelHead title={item.title} meta={`${kindLabel(item.kind)} · ${statusText(item)}`} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 @min-[560px]:grid-cols-[minmax(200px,300px)_minmax(0,1fr)]">
        <Preview item={item} />
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--t3)]">
            <span className="inline-flex items-center gap-1.5 rounded border border-[var(--border)]/60 px-2 py-1">
              <span className="h-2 w-2 rounded-full" style={{ background: stateColor(item.state) }} />
              {stateLabel(item.state, item.published_at ?? null)}
            </span>
            <span className="rounded border border-[var(--border)]/60 px-2 py-1">gerendert {relativeTime(item.rendered_at)}</span>
            {item.scheduled_for && <span className="rounded border border-[var(--border)]/60 px-2 py-1">Slot {formatScheduled(item.scheduled_for)}{item.kind === 'reel' ? ` ${item.scheduled_time || '18:00'}` : ' 12:30'}</span>}
            {item.kind === 'reel' && item.versions.length > 1 && <span className="rounded border border-[var(--border)]/60 px-2 py-1">{item.versions.length} Versionen</span>}
          </div>

          {error && (
            <div className="rounded-md border border-[var(--red,#ef4444)]/30 bg-[var(--red,#ef4444)]/10 px-3 py-2 text-[12px] leading-5 text-[var(--red,#ef4444)]">
              {error}
            </div>
          )}

          {caption ? (
            <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[var(--border)]/60 bg-[var(--bg)] p-3 font-sans text-[13px] leading-5 text-[var(--t2)]">{caption}</pre>
          ) : (
            <p className="rounded-md border border-[var(--border)]/60 bg-[var(--bg)] p-3 text-[13px] text-[var(--t3)]">Keine Caption hinterlegt.</p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)]/60 pt-3">
            {liveUrl && (
              <a href={liveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)]/70 px-3 py-1.5 text-[13px] text-[var(--t2)] hover:bg-white/[0.04]">
                Instagram <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <a href={itemPrimaryUrl(item)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)]/70 px-3 py-1.5 text-[13px] text-[var(--t2)] hover:bg-white/[0.04]">
              Asset öffnen <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {isQueued ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)]/70 px-3 py-1.5 text-[13px] text-[var(--t2)]">
                <Check className="h-3.5 w-3.5" /> Approved
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onApprove(item)}
                disabled={approveBusy || deleteBusy}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] text-white hover:opacity-90 disabled:opacity-45"
              >
                {approveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Approve
              </button>
            )}
            <button
              type="button"
              onClick={() => onDiscard(item)}
              disabled={approveBusy || deleteBusy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)]/70 px-3 py-1.5 text-[13px] text-[var(--t3)] hover:bg-white/[0.04] hover:text-[var(--t1)] disabled:opacity-45"
            >
              {deleteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Verwerfen
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Preview({ item }: { item: PipelineItem }) {
  if (item.kind === 'reel') {
    return (
      <video
        src={item.item.url}
        controls
        preload="metadata"
        className="mx-auto aspect-[9/16] max-h-[520px] w-full max-w-[320px] rounded-md border border-[var(--border)]/60 bg-black object-contain"
      />
    )
  }

  if (item.kind === 'karussell') {
    return (
      <div className="grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto">
        {item.item.slides.map(slide => (
          <a key={slide.n} href={slide.url} target="_blank" rel="noreferrer" className="relative block overflow-hidden rounded-md border border-[var(--border)]/60 bg-[var(--bg)]">
            <img src={slide.url} alt={`Slide ${slide.n}`} className="aspect-square h-full w-full object-cover" />
            <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[11px] tabular-nums text-white">{slide.n}</span>
          </a>
        ))}
      </div>
    )
  }

  return (
    <a href={item.item.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-[var(--border)]/60 bg-[var(--bg)]">
      <img src={item.item.url} alt={item.item.title} className="max-h-[520px] w-full object-contain" />
    </a>
  )
}
