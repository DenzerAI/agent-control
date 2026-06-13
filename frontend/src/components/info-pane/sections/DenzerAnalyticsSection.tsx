import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, BarChart3, RefreshCw, Check } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

// ── Example.com Analytics — eigene Tracking-Auswertung aus data/analytics.db ──

type AnalyticsOverview = {
  days: number
  pageviews: number
  visitors: number
  sessions: number
  by_day: { day: string; pageviews: number; visitors: number }[]
  top_paths: { path: string; pageviews: number; visitors: number }[]
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

function fmtDuration(ms: number) {
  if (!ms) return '–'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} Sek.`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m} Min. ${rest} Sek.` : `${m} Min.`
}

function fmtCountry(c: string | null) {
  if (!c || c === '??') return 'unbekannt'
  const flags: Record<string, string> = { DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', US: 'USA', NL: 'Niederlande', FR: 'Frankreich', GB: 'UK', PL: 'Polen', DK: 'Dänemark' }
  return flags[c] || c
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

function relTime(ms: number) {
  const diff = Math.floor((Date.now() - ms) / 1000)
  if (diff < 60) return 'gerade eben'
  if (diff < 3600) return `${Math.floor(diff / 60)} min`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`
  return `${Math.floor(diff / 86400)} T`
}

function trendArrow(today: number, yest: number) {
  if (yest === 0 && today === 0) return null
  if (yest === 0) return { sym: '↗', cls: 'text-[var(--green,#22c55e)]', label: `+${today}` }
  const pct = Math.round(((today - yest) / yest) * 100)
  if (pct >= 0) return { sym: '↗', cls: 'text-[var(--green,#22c55e)]', label: `+${pct}%` }
  return { sym: '↘', cls: 'text-[var(--red,#ef4444)]', label: `${pct}%` }
}

export function DenzerAnalyticsSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <AnalyticsWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <DenzerAnalyticsInlineSection mobile={mobile} />
}

function AnalyticsWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Analytics im Workspace öffnen"
      >
        <BarChart3 className="info-icon-md mr-2 text-[var(--t3)] flex-shrink-0 group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Analytics</span>
      </button>
    </div>
  )
}

function DenzerAnalyticsInlineSection({ mobile }: { mobile?: boolean }) {
  const [data, setData] = useState<AnalyticsOverview | null>(null)
  const [compare, setCompare] = useState<AnalyticsCompare | null>(null)
  const [recent, setRecent] = useState<AnalyticsRecentSession[]>([])
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:analyticsOpen') === '1' } catch { return false }
  })
  const [days, setDays] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('infopane:analyticsDays') || '7', 10) || 7 } catch { return 7 }
  })
  const [syncing, setSyncing] = useState(false)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [pageData, setPageData] = useState<Record<string, AnalyticsPage>>({})
  const [openSession, setOpenSession] = useState<string | null>(null)
  const [recentOpen, setRecentOpen] = useState(true)
  const [pathsOpen, setPathsOpen] = useState(true)
  const [referrersOpen, setReferrersOpen] = useState(true)

  const load = useCallback(() => {
    fetch(`/api/denzer/analytics/overview?days=${days}`).then(r => r.json()).then(setData).catch(() => {})
    fetch('/api/denzer/analytics/compare').then(r => r.json()).then(setCompare).catch(() => {})
    fetch('/api/denzer/analytics/recent?limit=15').then(r => r.json()).then(d => setRecent(d.sessions || [])).catch(() => {})
  }, [days])

  const sync = useCallback(() => {
    setSyncing(true)
    fetch('/api/denzer/analytics/sync', { method: 'POST' })
      .then(r => r.json())
      .finally(() => { setSyncing(false); load() })
  }, [load])

  useEffect(() => { if (open) { load(); sync() } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) load() }, [open, load, days])
  useEffect(() => { try { localStorage.setItem('infopane:analyticsOpen', open ? '1' : '0') } catch {} }, [open])
  useEffect(() => { try { localStorage.setItem('infopane:analyticsDays', String(days)) } catch {} }, [days])

  const loadPage = useCallback((path: string) => {
    fetch(`/api/denzer/analytics/page?days=${days}&path=${encodeURIComponent(path)}`)
      .then(r => r.json())
      .then(d => setPageData(prev => ({ ...prev, [path]: d })))
      .catch(() => {})
  }, [days])

  const pvTrend = compare ? trendArrow(compare.today.pageviews, compare.yesterday.pageviews) : null

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <BarChart3 className="info-icon-md mr-2 text-[var(--t3)] flex-shrink-0" />
        <span className="text-[var(--t2)] font-medium">Analytics</span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); sync() }}
            className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 transition-opacity ${syncing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            title="Aus KV ziehen">
            <RefreshCw className={`info-icon-sm ${syncing ? 'animate-spin' : ''}`} />
          </button>
        )}
        <span className="flex-1" />
      </div>

      {open && (
        <div className="pb-2">
          <Guided>
            <div className="flex items-center gap-1 pb-2 pt-0.5 pl-1 pr-3">
              <span className="info-text-meta text-[var(--t3)]/50 mr-1">Zeitraum</span>
              {[
                [1, 'Heute'],
                [7, '7 Tage'],
                [30, '30 Tage'],
              ].map(([n, label]) => (
                <button
                  key={n as number}
                  onClick={() => setDays(n as number)}
                  className={`info-text-meta px-1.5 py-0.5 rounded cursor-pointer transition-colors ${days === n ? 'bg-white/[0.10] text-[var(--t1)]' : 'text-[var(--t3)] hover:bg-white/[0.06]'}`}>
                  {label}
                </button>
              ))}
              {compare && pvTrend && (
                <span className="info-text-meta tabular-nums ml-auto">
                  <span className="text-[var(--t3)]/50">heute </span>
                  <span className="text-[var(--t2)]">{compare.today.pageviews}</span>
                  <span className="text-[var(--t3)]/50">/{compare.yesterday.pageviews} </span>
                  <span className={pvTrend.cls}>{pvTrend.sym} {pvTrend.label}</span>
                </span>
              )}
            </div>

            {data === null && <div className="info-text-meta text-[var(--t3)]/60 py-2 pl-1">Lädt…</div>}

            {data && data.pageviews === 0 && (
              <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Noch keine Events im Zeitraum.</div>
            )}

            {data && data.pageviews > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 pl-1 pr-3 info-text-meta">
                  <span className="text-[var(--t2)] tabular-nums">{data.pageviews} <span className="text-[var(--t3)]/55">Aufrufe</span></span>
                  <span className="text-[var(--t2)] tabular-nums">{data.visitors} <span className="text-[var(--t3)]/55">Leute</span></span>
                  <span className="text-[var(--t2)] tabular-nums">{data.sessions} <span className="text-[var(--t3)]/55">Besuche</span></span>
                </div>

                {recent.length > 0 && (
                  <>
                    <button
                      onClick={() => {
                        playUISound(recentOpen ? 'section-close' : 'section-open')
                        setRecentOpen(v => !v)
                      }}
                      className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-1.5' : 'py-[4px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                      <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${recentOpen ? 'rotate-90' : ''}`} />
                      <span className="text-[var(--t2)]">Letzte Besuche</span>
                      <span className="ml-2 info-text-meta text-[var(--t3)]/55 tabular-nums">{recent.length}</span>
                    </button>
                    {recentOpen && (
                      <Guided>
                        {recent.map(s => {
                          const lastPath = s.paths[s.paths.length - 1] || '/'
                          const isOpen = openSession === s.session_id
                          const durMin = Math.round((s.duration_ms || 0) / 60000)
                          return (
                            <div key={s.session_id}>
                              <button
                                onClick={() => {
                                  playUISound(isOpen ? 'section-close' : 'section-open')
                                  setOpenSession(isOpen ? null : s.session_id)
                                }}
                                className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-1.5' : 'py-[4px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                                <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                                <span className="info-text-meta text-[var(--t3)]/70 tabular-nums w-[58px] flex-shrink-0">vor {relTime(s.start_ts)}</span>
                                <span className="truncate flex-1 text-[var(--t2)]/85 pr-2">{lastPath}</span>
                                {s.submits > 0 && <Check className="info-icon-sm text-[var(--green,#22c55e)] ml-1 flex-shrink-0" />}
                              </button>
                              {isOpen && (
                                <Guided>
                                  <div className="info-text-meta text-[var(--t3)]/80 pb-2 pt-1 pl-1 pr-3 space-y-0.5">
                                    <div>
                                      <span className="text-[var(--t3)]/60">Wo: </span>
                                      <span className="text-[var(--t2)]">{fmtCountry(s.country)}</span>
                                      {s.city && <span className="text-[var(--t2)]">, {s.city}</span>}
                                      <span className="text-[var(--t3)]/60"> · </span>
                                      <span className="text-[var(--t2)]">{s.device === 'mobile' ? 'Handy' : 'Computer'}</span>
                                    </div>
                                    <div>
                                      <span className="text-[var(--t3)]/60">Wie lange: </span>
                                      <span className="text-[var(--t2)]">{s.duration_ms ? fmtDuration(s.duration_ms) : 'kurz aufgemacht'}</span>
                                      {durMin > 5 && <span className="text-[var(--t3)]/60"> (lang)</span>}
                                    </div>
                                    <div>
                                      <span className="text-[var(--t3)]/60">Seiten angesehen: </span>
                                      <span className="text-[var(--t2)]">{s.pageviews}</span>
                                      {s.paths.length > 1 && <span className="text-[var(--t3)]/60"> ({s.paths.join(' → ')})</span>}
                                    </div>
                                    <div>
                                      <span className="text-[var(--t3)]/60">Geklickt: </span>
                                      <span className="text-[var(--t2)]">{s.clicks === 0 ? 'nichts' : `${s.clicks}×`}</span>
                                    </div>
                                    <div>
                                      <span className="text-[var(--t3)]/60">Formular abgeschickt: </span>
                                      <span className={s.submits > 0 ? 'text-[var(--green,#22c55e)]' : 'text-[var(--t2)]'}>{s.submits > 0 ? `ja, ${s.submits}×` : 'nein'}</span>
                                    </div>
                                    {s.referrer && s.referrer !== '(direct)' && (
                                      <div>
                                        <span className="text-[var(--t3)]/60">Kam von: </span>
                                        <span className="text-[var(--t2)]/80 break-all">{s.referrer}</span>
                                      </div>
                                    )}
                                  </div>
                                </Guided>
                              )}
                            </div>
                          )
                        })}
                      </Guided>
                    )}
                  </>
                )}

                {data.top_paths.length > 0 && (
                  <>
                    <button
                      onClick={() => {
                        playUISound(pathsOpen ? 'section-close' : 'section-open')
                        setPathsOpen(v => !v)
                      }}
                      className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-1.5' : 'py-[4px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                      <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${pathsOpen ? 'rotate-90' : ''}`} />
                      <span className="text-[var(--t2)]">Beliebteste Seiten</span>
                      <span className="ml-auto info-text-meta text-[var(--t3)]/40">Aufrufe · Leute</span>
                    </button>
                    {pathsOpen && (
                      <Guided>
                        {data.top_paths.slice(0, 8).map(p => {
                          const pOpen = openPath === p.path
                          const pd = pageData[p.path]
                          return (
                            <div key={p.path}>
                              <button
                                onClick={() => {
                                  playUISound(pOpen ? 'section-close' : 'section-open')
                                  const next = pOpen ? null : p.path
                                  setOpenPath(next)
                                  if (next && !pageData[p.path]) loadPage(p.path)
                                }}
                                className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-1.5' : 'py-[4px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                                <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${pOpen ? 'rotate-90' : ''}`} />
                                <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">{p.path}</span>
                                <span className="info-text-meta text-[var(--t3)]/70 tabular-nums ml-2 flex-shrink-0" title="Seitenaufrufe (insgesamt)">{p.pageviews}</span>
                                <span className="info-text-meta text-[var(--t3)]/50 tabular-nums ml-2 flex-shrink-0" title="Verschiedene Leute">{p.visitors}</span>
                              </button>
                              {pOpen && (
                                <Guided>
                                  <div className="info-text-meta text-[var(--t3)]/80 pb-2 pt-1 pl-1 pr-3 space-y-1">
                                    {!pd && <div className="text-[var(--t3)]/60 py-1">Lädt…</div>}
                                    {pd && (
                                      <>
                                        <div>
                                          <span className="text-[var(--t3)]/60">Bleibt im Schnitt: </span>
                                          <span className="text-[var(--t2)]">{pd.avg_duration_ms ? fmtDuration(pd.avg_duration_ms) : 'kein Wert'}</span>
                                        </div>
                                        <div>
                                          <span className="text-[var(--t3)]/60">Formulare abgeschickt: </span>
                                          <span className={pd.form_submits > 0 ? 'text-[var(--green,#22c55e)]' : 'text-[var(--t2)]'}>
                                            {pd.form_submits > 0 ? `${pd.form_submits}×` : 'noch keins'}
                                          </span>
                                        </div>
                                        {Object.values(pd.scroll_distribution).some(v => v > 0) && (
                                          <div>
                                            <div className="text-[var(--t3)]/60 pb-0.5">Wie weit gescrollt</div>
                                            {[
                                              ['100', 'bis ganz unten'],
                                              ['75-100', 'fast bis unten'],
                                              ['50-75', 'bis zur Mitte'],
                                              ['25-50', 'das obere Viertel'],
                                              ['0-25', 'nur kurz reingeschaut'],
                                            ].map(([k, label]) => {
                                              const v = pd.scroll_distribution[k] || 0
                                              if (!v) return null
                                              return (
                                                <div key={k} className="flex justify-between items-center">
                                                  <span className="text-[var(--t2)]/80 pr-2">{label}</span>
                                                  <span className="text-[var(--t3)]/70 tabular-nums">{v}×</span>
                                                </div>
                                              )
                                            })}
                                          </div>
                                        )}
                                        {pd.clicks.length > 0 && (
                                          <div>
                                            <div className="text-[var(--t3)]/60 pt-0.5 pb-0.5">Was wurde angeklickt</div>
                                            {pd.clicks.slice(0, 8).map((c, i) => (
                                              <div key={i} className="flex justify-between items-center">
                                                <span className="truncate text-[var(--t2)]/80 pr-2">{c.label || '(ohne Beschriftung)'}</span>
                                                <span className="text-[var(--t3)]/70 tabular-nums">{c.hits}×</span>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                        {pd.outbound.length > 0 && (
                                          <div>
                                            <div className="text-[var(--t3)]/60 pt-0.5 pb-0.5">Externe Links angeklickt</div>
                                            {pd.outbound.slice(0, 6).map((o, i) => (
                                              <div key={i} className="flex justify-between items-center">
                                                <span className="truncate text-[var(--t2)]/80 pr-2">{o.href}</span>
                                                <span className="text-[var(--t3)]/70 tabular-nums">{o.hits}×</span>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </Guided>
                              )}
                            </div>
                          )
                        })}
                      </Guided>
                    )}
                  </>
                )}

                {data.top_referrers.length > 0 && (
                  <>
                    <button
                      onClick={() => {
                        playUISound(referrersOpen ? 'section-close' : 'section-open')
                        setReferrersOpen(v => !v)
                      }}
                      className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-1.5' : 'py-[4px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                      <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${referrersOpen ? 'rotate-90' : ''}`} />
                      <span className="text-[var(--t2)]">Woher sie kamen</span>
                      <span className="ml-2 info-text-meta text-[var(--t3)]/55 tabular-nums">{Math.min(data.top_referrers.length, 6)}</span>
                    </button>
                    {referrersOpen && (
                      <Guided>
                        {data.top_referrers.slice(0, 6).map((r, i) => (
                          <div key={i} className="flex justify-between items-center info-text-body pl-1 pr-3 py-[2px]">
                            <span className="truncate text-[var(--t2)]/80 pr-2">{r.referrer === '(direct)' ? 'direkt eingetippt' : r.referrer}</span>
                            <span className="info-text-meta text-[var(--t3)]/70 tabular-nums">{r.hits}×</span>
                          </div>
                        ))}
                      </Guided>
                    )}
                  </>
                )}
              </>
            )}
          </Guided>
        </div>
      )}
    </div>
  )
}
