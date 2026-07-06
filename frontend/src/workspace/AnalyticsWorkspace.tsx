import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, ChevronDown, FileText, Globe2, MousePointerClick, RefreshCw } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

type AnalyticsOverview = {
  days: number
  pageviews: number
  visitors: number
  sessions: number
  by_day: { day: string; pageviews: number; visitors: number }[]
  top_paths: { path: string; pageviews: number; visitors: number; submits?: number }[]
  top_referrers: { referrer: string; hits: number }[]
  by_country: { country: string; visitors: number }[]
}

type AnalyticsPage = {
  path: string
  days: number
  pageviews: number
  visitors: number
  avg_duration_ms: number
  scroll_distribution: Record<string, number>
  clicks: { label: string; hits: number }[]
  outbound: { href: string; hits: number }[]
  form_submits: number
}

type AnalyticsRecentSession = {
  session_id: string
  start_ts: number
  duration_ms: number
  pageviews: number
  clicks: number
  submits: number
  paths: string[]
  country: string | null
  city: string | null
  device: 'mobile' | 'desktop'
  referrer: string | null
}

type AnalyticsCompare = {
  today: { pageviews: number; visitors: number; sessions: number }
  yesterday: { pageviews: number; visitors: number; sessions: number }
}

type AnalyticsCache = {
  overview: AnalyticsOverview | null
  compare: AnalyticsCompare | null
  recent: AnalyticsRecentSession[]
  received_at: string
}

type OfferRow = {
  kind: 'Angebot' | 'Onboarding'
  slug: string
  name: string
  path: string
  pageviews: number
  visitors: number
  submits: number
}

const CACHE_KEY = 'workspace:analytics:lastState'

function readCache(): AnalyticsCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { overview: null, compare: null, recent: [], received_at: '' }
    const parsed = JSON.parse(raw) as AnalyticsCache
    return {
      overview: parsed.overview || null,
      compare: parsed.compare || null,
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      received_at: parsed.received_at || '',
    }
  } catch {
    return { overview: null, compare: null, recent: [], received_at: '' }
  }
}

function writeCache(cache: AnalyticsCache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch {}
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

function fmtAge(value?: string | number | null): string {
  const ts = typeof value === 'number' ? value : value ? Date.parse(value) : 0
  if (!ts || !Number.isFinite(ts)) return 'nie'
  const ms = ts > 10_000_000_000 ? ts : ts * 1000
  const age = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function fmtDuration(ms: number): string {
  if (!ms) return 'kurz'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m}m ${rest}s` : `${m}m`
}

function fmtCountry(country: string | null): string {
  if (!country || country === '??') return 'unbekannt'
  const labels: Record<string, string> = { DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', US: 'USA', NL: 'Niederlande', FR: 'Frankreich', GB: 'UK', PL: 'Polen', DK: 'Dänemark' }
  return labels[country] || country
}

function trendLabel(compare: AnalyticsCompare | null): string {
  if (!compare) return 'Vergleich offen'
  const today = compare.today.pageviews
  const yesterday = compare.yesterday.pageviews
  if (yesterday === 0 && today === 0) return 'heute ruhig'
  if (yesterday === 0) return `heute +${today}`
  const pct = Math.round(((today - yesterday) / yesterday) * 100)
  return pct >= 0 ? `heute +${pct}%` : `heute ${pct}%`
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Angebots- und Onboarding-Seiten aus den Top-Pfaden ziehen und pro Slug buendeln.
function buildOffers(overview: AnalyticsOverview | null): OfferRow[] {
  if (!overview?.top_paths?.length) return []
  const map = new Map<string, OfferRow>()
  for (const p of overview.top_paths) {
    const segs = p.path.split('/').filter(Boolean)
    const root = segs[0]
    const kind = root === 'angebot' ? 'Angebot' : root === 'onboarding' ? 'Onboarding' : null
    if (!kind) continue
    const slug = segs[1]
    if (!slug) continue
    const key = `${kind}:${slug}`
    const existing = map.get(key)
    if (existing) {
      existing.pageviews += p.pageviews
      existing.visitors = Math.max(existing.visitors, p.visitors)
      existing.submits += p.submits || 0
    } else {
      map.set(key, {
        kind,
        slug,
        name: titleCase(slug),
        path: `/${root}/${slug}/`,
        pageviews: p.pageviews,
        visitors: p.visitors,
        submits: p.submits || 0,
      })
    }
  }
  return [...map.values()].sort((a, b) =>
    b.submits - a.submits || b.visitors - a.visitors || b.pageviews - a.pageviews
  )
}

export function AnalyticsWorkspace() {
  const [cache, setCache] = useState<AnalyticsCache>(() => readCache())
  const [days, setDays] = useState<number>(() => {
    try { return Number(localStorage.getItem('workspace:analytics:days') || 30) || 30 } catch { return 30 }
  })
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [openOffer, setOpenOffer] = useState<string | null>(null)
  const [offerDetail, setOfferDetail] = useState<Record<string, AnalyticsPage>>({})
  const [offerLoading, setOfferLoading] = useState<string | null>(null)

  const loadOffer = useCallback((path: string) => {
    if (offerDetail[path]) return
    setOfferLoading(path)
    fetchJsonWithTimeout<AnalyticsPage>(`/api/company/analytics/page?days=${days}&path=${encodeURIComponent(path)}`)
      .then(page => setOfferDetail(prev => ({ ...prev, [path]: page })))
      .catch(() => {})
      .finally(() => setOfferLoading(null))
  }, [days, offerDetail])

  // Zeitraumwechsel verwirft die geladenen Details, weil sie sonst veraltet sind.
  useEffect(() => { setOfferDetail({}); setOpenOffer(null) }, [days])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const [overviewRes, compareRes, recentRes] = await Promise.allSettled([
      fetchJsonWithTimeout<AnalyticsOverview>(`/api/company/analytics/overview?days=${days}`),
      fetchJsonWithTimeout<AnalyticsCompare>('/api/company/analytics/compare'),
      fetchJsonWithTimeout<{ sessions?: AnalyticsRecentSession[] }>('/api/company/analytics/recent?limit=15'),
    ])
    const failures: string[] = []
    const next: AnalyticsCache = { ...cache, received_at: new Date().toISOString() }
    if (overviewRes.status === 'fulfilled') next.overview = overviewRes.value
    else failures.push('Übersicht')
    if (compareRes.status === 'fulfilled') next.compare = compareRes.value
    else failures.push('Vergleich')
    if (recentRes.status === 'fulfilled') next.recent = recentRes.value.sessions || []
    else failures.push('Besuche')
    setCache(next)
    writeCache(next)
    setError(failures.length ? `${failures.join(', ')} gerade nicht erreichbar, letzter Stand bleibt.` : '')
    setLoading(false)
  }, [cache, days])

  const sync = useCallback(async () => {
    setSyncing(true)
    setError('')
    try {
      await fetchJsonWithTimeout('/api/company/analytics/sync', { method: 'POST' }, 20000)
      await load()
    } catch (e) {
      setError(`Sync nicht erreichbar, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }, [load])

  useEffect(() => {
    try { localStorage.setItem('workspace:analytics:days', String(days)) } catch {}
    load()
  }, [days]) // eslint-disable-line react-hooks/exhaustive-deps

  const overview = cache.overview
  const recent = cache.recent
  const offers = useMemo(() => buildOffers(overview), [overview])
  const offerSlugs = useMemo(() => new Set(offers.map(o => o.path)), [offers])
  const otherPaths = useMemo(
    () => (overview?.top_paths || []).filter(p => {
      const root = p.path.split('/').filter(Boolean)[0]
      return root !== 'angebot' && root !== 'onboarding'
    }).slice(0, 8),
    [overview, offerSlugs] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const countries = useMemo(() => overview?.by_country?.slice(0, 6) || [], [overview])
  const offerLeads = offers.reduce((sum, o) => sum + o.submits, 0)
  const headline = overview
    ? overview.pageviews > 0 ? `${overview.pageviews} Aufrufe` : 'Analytics ruhig'
    : 'Analytics laden'

  return (
    <WorkspaceShell
      eyebrow={`Analytics · example.com · ${cache.received_at ? fmtAge(cache.received_at) : 'kein Stand'}`}
      title={headline}
      subtitle={overview ? `${overview.visitors} Leute · ${offers.length} Angebote angesehen · ${offerLeads} mit Formular` : 'Letzter Stand wird geladen und bleibt danach sichtbar.'}
      action={
        <>
        <button type="button" onClick={load} disabled={loading || syncing} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
        <button type="button" onClick={sync} disabled={loading || syncing} title="Aus KV ziehen">
          <BarChart3 className={syncing ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} />
        </button>
        </>
      }
    >

      {error && <div className="workspace-system-note">{error}</div>}

      <div className="workspace-limits-engine" role="tablist" aria-label="Zeitraum">
        {[1, 7, 30].map(n => (
          <button key={n} type="button" className={days === n ? 'is-active' : ''} onClick={() => setDays(n)}>
            <span>{n === 1 ? 'Heute' : `${n} Tage`}</span>
          </button>
        ))}
      </div>

      <div className="workspace-system-strip">
        <Metric label="Aufrufe" value={overview?.pageviews ?? '-'} detail={trendLabel(cache.compare)} warn={!!cache.compare && cache.compare.today.pageviews < cache.compare.yesterday.pageviews} />
        <Metric label="Leute" value={overview?.visitors ?? '-'} detail={`${cache.compare?.today.visitors ?? 0} heute`} />
        <Metric label="Angebote offen" value={offers.length} detail={`${offers.reduce((s, o) => s + o.visitors, 0)} Leute drauf`} />
        <Metric label="Mit Formular" value={offerLeads} detail={offerLeads > 0 ? 'Leute abgeschickt' : 'noch keiner'} warn={offerLeads > 0} />
      </div>

      <div className="workspace-system-main">
        <section className="workspace-system-panel is-wide">
          <PanelHead icon={FileText} title="Angebote & Onboarding" meta="Leute · Aufrufe · Formular" />
          <div className="workspace-system-list">
            {offers.map(offer => {
              const open = openOffer === offer.path
              const detail = offerDetail[offer.path]
              return (
                <div key={`${offer.kind}:${offer.slug}`} className={`workspace-offer ${open ? 'is-open' : ''}`}>
                  <article
                    className={`workspace-system-row is-${offer.submits > 0 ? 'ok' : 'neutral'}`}
                    onClick={() => {
                      const next = open ? null : offer.path
                      setOpenOffer(next)
                      if (next) loadOffer(offer.path)
                    }}
                  >
                    <span />
                    <div>
                      <strong>{offer.name}{offer.kind === 'Onboarding' ? ' · Onboarding' : ''}</strong>
                      <em>{offer.submits > 0 ? `${offer.submits} ${offer.submits > 1 ? 'Leute haben' : 'Person hat'} abgeschickt` : 'angesehen, noch kein Formular'}</em>
                    </div>
                    <aside>
                      <b>{offer.visitors} Leute</b>
                      <i>{offer.pageviews} Aufrufe</i>
                    </aside>
                  </article>
                  {open && (
                    <OfferDetail detail={detail} loading={offerLoading === offer.path} />
                  )}
                </div>
              )
            })}
            {offers.length === 0 && <p>Keine Angebots- oder Onboarding-Seiten im Zeitraum.</p>}
          </div>
        </section>

        <section className="workspace-system-panel is-wide">
          <PanelHead icon={MousePointerClick} title="Letzte Besuche" meta={`${recent.length}`} />
          <div className="workspace-system-list">
            {recent.slice(0, 10).map(session => (
              <article key={session.session_id} className={`workspace-system-row is-${session.submits > 0 ? 'ok' : session.clicks > 0 ? 'warn' : 'neutral'}`}>
                <span />
                <div>
                  <strong>{session.paths[session.paths.length - 1] || '/'}</strong>
                  <em>{fmtCountry(session.country)}{session.city ? `, ${session.city}` : ''} · {session.device === 'mobile' ? 'Handy' : 'Computer'} · {fmtDuration(session.duration_ms)}</em>
                </div>
                <aside>
                  <b>{session.pageviews} Seiten</b>
                  <i>{fmtAge(session.start_ts)}</i>
                </aside>
              </article>
            ))}
            {recent.length === 0 && <p>Keine letzten Besuche im Cache.</p>}
          </div>
        </section>
      </div>

      <button type="button" className="workspace-system-more-toggle" onClick={() => setShowMore(v => !v)}>
        <ChevronDown className={showMore ? 'h-4 w-4 is-open' : 'h-4 w-4'} />
        <span>Quellen, Länder & weitere Seiten</span>
      </button>

      {showMore && (
        <div className="workspace-system-main">
          <section className="workspace-system-panel">
            <PanelHead icon={BarChart3} title="Weitere Seiten" meta="Aufrufe · Leute" />
            <div className="workspace-system-list">
              {otherPaths.map(path => (
                <article key={path.path} className="workspace-system-row is-neutral">
                  <span />
                  <div><strong>{path.path}</strong></div>
                  <aside><b>{path.pageviews}</b><i>{path.visitors} Leute</i></aside>
                </article>
              ))}
              {!otherPaths.length && <p>Keine weiteren Seiten im Zeitraum.</p>}
            </div>
          </section>

          <section className="workspace-system-panel">
            <PanelHead icon={Globe2} title="Quellen" meta="Referrer" />
            <div className="workspace-system-list">
              {(overview?.top_referrers || []).slice(0, 6).map(ref => (
                <article key={ref.referrer} className="workspace-system-row is-neutral">
                  <span />
                  <div><strong>{ref.referrer === '(direct)' ? 'direkt' : ref.referrer}</strong></div>
                  <aside><b>{ref.hits}x</b></aside>
                </article>
              ))}
              {!overview?.top_referrers?.length && <p>Keine Quellen im Zeitraum.</p>}
            </div>
          </section>

          <section className="workspace-system-panel">
            <PanelHead icon={Globe2} title="Länder" meta={`${countries.length}`} />
            <div className="workspace-system-list">
              {countries.map(country => (
                <article key={country.country} className="workspace-system-row is-neutral">
                  <span />
                  <div><strong>{fmtCountry(country.country)}</strong></div>
                  <aside><b>{country.visitors}</b></aside>
                </article>
              ))}
              {countries.length === 0 && <p>Keine Länder-Daten im Zeitraum.</p>}
            </div>
          </section>
        </div>
      )}
    </WorkspaceShell>
  )
}

function Metric({ label, value, detail, warn }: { label: string; value: string | number; detail: string; warn?: boolean }) {
  return (
    <section className={warn ? 'is-warning' : ''}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </section>
  )
}

function PanelHead({ icon: Icon, title, meta }: { icon: typeof BarChart3; title: string; meta: string }) {
  return (
    <div className="workspace-system-panel-head">
      <div>
        <Icon className="h-4 w-4" />
        <strong>{title}</strong>
      </div>
      <span>{meta}</span>
    </div>
  )
}

function OfferDetail({ detail, loading }: { detail?: AnalyticsPage; loading: boolean }) {
  if (loading && !detail) return <div className="workspace-offer-detail is-loading"><p>Lade Details für dieses Angebot.</p></div>
  if (!detail) return <div className="workspace-offer-detail"><p>Keine Details verfügbar.</p></div>
  const scroll = detail.scroll_distribution || {}
  const scrollTotal = Object.values(scroll).reduce((a, b) => a + (b || 0), 0)
  const readToEnd = scrollTotal ? Math.round(((scroll['100'] || 0) / scrollTotal) * 100) : 0
  const readHalf = scrollTotal ? Math.round((((scroll['100'] || 0) + (scroll['75-100'] || 0) + (scroll['50-75'] || 0)) / scrollTotal) * 100) : 0
  return (
    <div className="workspace-offer-detail">
      <div className="workspace-offer-stats">
        <span className={detail.form_submits > 0 ? 'is-lead' : ''}><b>{detail.form_submits}</b>Leute mit Formular</span>
        <span><b>{fmtDuration(detail.avg_duration_ms)}</b>Ø Verweildauer</span>
        <span><b>{readToEnd}%</b>lasen bis zum Ende</span>
        <span><b>{readHalf}%</b>kamen über die Hälfte</span>
        <span><b>{detail.pageviews}</b>Aufrufe gesamt</span>
      </div>
      {detail.clicks.length > 0 && (
        <div className="workspace-offer-sub">
          <h5>Worauf geklickt wurde</h5>
          {detail.clicks.slice(0, 6).map((c, i) => (
            <div key={i} className="workspace-offer-line"><span>{c.label}</span><b>{c.hits}x</b></div>
          ))}
        </div>
      )}
      {detail.outbound.length > 0 && (
        <div className="workspace-offer-sub">
          <h5>Klicks nach außen</h5>
          {detail.outbound.slice(0, 5).map((o, i) => (
            <div key={i} className="workspace-offer-line"><span>{o.href}</span><b>{o.hits}x</b></div>
          ))}
        </div>
      )}
      {detail.clicks.length === 0 && detail.outbound.length === 0 && (
        <p>Angeschaut, aber noch nichts geklickt.</p>
      )}
    </div>
  )
}
