import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldCheck, ShieldAlert, RefreshCw, KeyRound, UserRound, FileLock2, Activity, Cloud, Database, Download, Search, UserX, ChevronDown } from 'lucide-react'

type Stage2 = {
  enabled: boolean
  available: boolean
  loaded: boolean
  failed: boolean
  lang: string
  min_score: number
  entities: string[]
}

type Stage3 = {
  enabled: boolean
  available: boolean
  where: string
  source: string
  contacts: number | null
  masks: string[]
  reversible: boolean
}

type DataMapEntry = { key: string; label: string; unit: string; count: number | null; where: string; handling: string }

type PersonHit = { id: number; name: string; email: string; company: string; status: string }
type AnonPlan = { person_id: number; name_present: boolean; fields_cleared: string[]; tables_purged: { table: string; rows: number }[]; offers_kept: number }

type TypeStat = { key: string; label: string; marker: string; kind: 'pii' | 'secret'; count: number }
type DayStat = { date: string; entries: number; redactions: number }
type ToolStat = { tool: string; entries: number; redactions: number }
type RecentEntry = { ts: number; tool: string; decision: string; ok: boolean; redactions: number; preview: string }

type AuditState = {
  generated_at: string
  stage2: Stage2
  stage3: Stage3
  data_map: DataMapEntry[]
  totals: {
    entries: number
    scanned: number
    redactions: number
    entries_with_redaction: number
    oldest_ts: number | null
    newest_ts: number | null
  }
  by_type: TypeStat[]
  timeline: DayStat[]
  top_tools: ToolStat[]
  recent: RecentEntry[]
}

const CACHE_KEY = 'workspace:privacy:lastState'

function readCache(): AuditState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as AuditState) : null
  } catch { return null }
}
function writeCache(state: AuditState) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)) } catch {}
}

function fetchJsonWithTimeout(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', signal: ctrl.signal })
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
    .finally(() => window.clearTimeout(timer))
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–'
  return new Intl.NumberFormat('de-DE').format(n)
}

function fmtDateRange(oldest: number | null, newest: number | null): string {
  if (!oldest || !newest) return 'noch keine Läufe'
  const o = new Date(oldest * 1000)
  const n = new Date(newest * 1000)
  const f = (d: Date) => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  return o.toDateString() === n.toDateString() ? f(n) : `${f(o)} bis ${f(n)}`
}

function fmtAge(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'gerade eben'
  if (mins < 60) return `vor ${mins} Min`
  const h = Math.floor(mins / 60)
  if (h < 24) return `vor ${h}h`
  return `vor ${Math.floor(h / 24)}d`
}

function fmtTs(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// Hebt die Schwärzungs-Marker in einer Vorschau farblich hervor, Rest bleibt mono.
function renderPreview(text: string) {
  const parts = text.split(/(\[[A-Z_]+\]|…)/g)
  return parts.map((p, i) =>
    /^\[[A-Z_]+\]$/.test(p)
      ? <span key={i} className="rounded px-1 font-medium" style={{ color: 'var(--warm)', background: 'color-mix(in srgb, var(--warm) 14%, transparent)' }}>{p}</span>
      : <span key={i}>{p}</span>,
  )
}

function StatCard({ icon: Icon, label, value, hint }: { icon: typeof Activity; label: string; value: string; hint: string }) {
  return (
    <div className="flex min-h-[104px] flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
      <div className="flex items-center gap-2 text-[var(--t2)]">
        <Icon className="h-4 w-4" />
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2">
        <div className="text-2xl font-semibold leading-tight text-[var(--t1)]">{value}</div>
        <div className="text-xs text-[var(--t3)]">{hint}</div>
      </div>
    </div>
  )
}

export function PrivacyWorkspace() {
  const [state, setState] = useState<AuditState | null>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    fetchJsonWithTimeout('/api/privacy/audit')
      .then(d => {
        const next = d as AuditState
        if (next?.totals) { setState(next); writeCache(next) }
      })
      .catch(e => setError(`Audit nicht lesbar, letzter Stand bleibt: ${e.message}`))
      .finally(() => setLoading(false))
  }, [])

  const downloadExport = useCallback(() => {
    // Same-origin, der Auth-Cookie geht mit; Content-Disposition löst den Download aus.
    const a = document.createElement('a')
    a.href = '/api/privacy/export'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [])

  // ── Betroffenenrechte pro Person ──
  const [pq, setPq] = useState('')
  const [hits, setHits] = useState<PersonHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [anonFor, setAnonFor] = useState<number | null>(null)
  const [anonPlan, setAnonPlan] = useState<AnonPlan | null>(null)
  const [anonBusy, setAnonBusy] = useState(false)
  const [anonDone, setAnonDone] = useState<number | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)

  const doSearch = useCallback(() => {
    const q = pq.trim()
    setAnonFor(null); setAnonDone(null)
    if (q.length < 2) { setHits([]); setSearched(false); return }
    setSearching(true)
    fetchJsonWithTimeout(`/api/privacy/person/search?q=${encodeURIComponent(q)}`)
      .then(d => setHits(((d as { results?: PersonHit[] })?.results) || []))
      .catch(() => setHits([]))
      .finally(() => { setSearching(false); setSearched(true) })
  }, [pq])

  const downloadAuskunft = useCallback((pid: number) => {
    const a = document.createElement('a')
    a.href = `/api/privacy/person/${pid}/export`
    a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
  }, [])

  const startAnon = useCallback((pid: number) => {
    setAnonFor(pid); setAnonPlan(null); setAnonDone(null)
    fetch(`/api/privacy/person/${pid}/anonymize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: false }),
    }).then(r => r.json()).then(d => setAnonPlan(d?.plan || null)).catch(() => setAnonPlan(null))
  }, [])

  const confirmAnon = useCallback((pid: number) => {
    setAnonBusy(true)
    fetch(`/api/privacy/person/${pid}/anonymize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    }).then(r => r.json()).then(() => { setAnonDone(pid); setAnonFor(null); doSearch() })
      .catch(() => {}).finally(() => setAnonBusy(false))
  }, [doSearch])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 120000)
    return () => window.clearInterval(id)
  }, [load])

  const stage2 = state?.stage2
  const stage2Active = !!(stage2?.enabled && stage2?.available && !stage2?.failed)
  const stage3 = state?.stage3
  const stage3Active = !!(stage3?.enabled && stage3?.available)
  const dataMap = state?.data_map || []
  const maxDay = useMemo(() => Math.max(1, ...(state?.timeline || []).map(d => d.entries)), [state])
  const piiTypes = (state?.by_type || []).filter(t => t.kind === 'pii')
  const secretTypes = (state?.by_type || []).filter(t => t.kind === 'secret')
  const maxTypeCount = Math.max(1, ...(state?.by_type || []).map(t => t.count))

  if (!state) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-[var(--bg)] text-[var(--t2)]">
        <ShieldCheck className="h-8 w-8" style={{ color: 'var(--warm)' }} />
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 rounded-full border border-[var(--border)] px-4 py-2 text-sm text-[var(--t1)]"
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span>{error || (loading ? 'lädt …' : 'DSGVO-Status laden')}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] uppercase tracking-wide text-[var(--t3)]">Datenschutz · Agent Control</div>
          <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">Geschwärztes Werkzeug-Protokoll</h2>
          <div className="truncate text-xs text-[var(--t3)]">
            Nur die Blackbox-Mitschrift wird geschwärzt, deine Quellen bleiben im Klartext · {fmtAge(state.generated_at)}
          </div>
        </div>
        <button
          type="button"
          onClick={downloadExport}
          title="DSGVO-Nachweis als Datei laden"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-2 text-xs text-[var(--t2)]"
        >
          <Download className="h-4 w-4" />
          <span className="hidden @min-[480px]:inline">Nachweis</span>
        </button>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title="Neu laden"
          className="shrink-0 rounded-full border border-[var(--border)] p-2 text-[var(--t2)]"
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {error && <div className="rounded-xl border border-[var(--border)] px-3 py-2 text-xs text-[var(--warm)]">{error}</div>}

          {/* Drei Schutzstufen */}
          <section className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[900px]:grid-cols-3">
            <div className="flex min-h-[96px] items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
              <KeyRound className="mt-0.5 h-5 w-5 shrink-0" style={{ color: 'var(--green)' }} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-sm text-[var(--t1)]">Stufe 1 · Secrets</strong>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: 'var(--green)', background: 'color-mix(in srgb, var(--green) 16%, transparent)' }}>aktiv</span>
                </div>
                <p className="mt-1 text-xs text-[var(--t2)]">API-Keys, Tokens, private Schlüssel und sensible Pfade werden vor dem Schreiben ersetzt.</p>
              </div>
            </div>
            <div className="flex min-h-[96px] items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
              {stage2Active
                ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" style={{ color: 'var(--green)' }} />
                : <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" style={{ color: 'var(--warm)' }} />}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-sm text-[var(--t1)]">Stufe 2 · Personendaten</strong>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: stage2Active ? 'var(--green)' : 'var(--warm)', background: `color-mix(in srgb, ${stage2Active ? 'var(--green)' : 'var(--warm)'} 16%, transparent)` }}>
                    {stage2Active ? 'aktiv' : stage2?.enabled ? 'nicht verfügbar' : 'aus'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--t2)]">
                  Lokales deutsches Sprachmodell (Presidio) maskiert Namen, Orte, Telefon, Mail, IBAN. Läuft offline, kein API-Call.
                </p>
              </div>
            </div>
            <div className="flex min-h-[96px] items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
              <Cloud className="mt-0.5 h-5 w-5 shrink-0" style={{ color: stage3Active ? 'var(--green)' : 'var(--warm)' }} />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-sm text-[var(--t1)]">Stufe 3 · Cloud-Schutz</strong>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: stage3Active ? 'var(--green)' : 'var(--warm)', background: `color-mix(in srgb, ${stage3Active ? 'var(--green)' : 'var(--warm)'} 16%, transparent)` }}>
                    {stage3Active ? 'aktiv' : 'aus'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--t2)]">
                  Vor Mail-Entwürfen über die Cloud werden echte Kontaktdaten durch Platzhalter ersetzt und in der Antwort wieder eingesetzt. Reversibel, Abgleich gegen people.db.
                </p>
              </div>
            </div>
          </section>

          {/* Kennzahlen */}
          <section className="grid grid-cols-1 gap-3 @min-[420px]:grid-cols-2 @min-[880px]:grid-cols-4">
            <StatCard icon={Activity} label="Protokoll-Läufe" value={fmtNum(state.totals.entries)} hint={fmtDateRange(state.totals.oldest_ts, state.totals.newest_ts)} />
            <StatCard icon={FileLock2} label="Schwärzungen" value={fmtNum(state.totals.redactions)} hint={`in ${fmtNum(state.totals.entries_with_redaction)} Läufen`} />
            <StatCard icon={UserRound} label="Personendaten" value={fmtNum(piiTypes.reduce((s, t) => s + t.count, 0))} hint="Namen, Orte, Kontakte, IBAN" />
            <StatCard icon={KeyRound} label="Secrets" value={fmtNum(secretTypes.reduce((s, t) => s + t.count, 0))} hint="Keys, Tokens, Pfade" />
          </section>

          {/* Datenkarte: wo liegen welche Daten */}
          {dataMap.length > 0 && (
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
              <div className="mb-3 flex items-center justify-between">
                <strong className="text-sm text-[var(--t1)]">Datenkarte</strong>
                <span className="text-[11px] text-[var(--t3)]">wo liegen welche Daten</span>
              </div>
              <div className="flex flex-col divide-y divide-[var(--border)]">
                {dataMap.map(d => {
                  const tone = d.handling.includes('geschwärzt') ? 'var(--warm)'
                    : d.handling.includes('tokenisiert') ? 'var(--green)' : 'var(--t3)'
                  return (
                    <div key={d.key} className="flex items-center gap-3 py-2.5">
                      <Database className="h-4 w-4 shrink-0 text-[var(--t3)]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm text-[var(--t1)]">{d.label}</span>
                          <span className="text-xs tabular-nums text-[var(--t2)]">{fmtNum(d.count ?? undefined)} {d.unit}</span>
                        </div>
                        <div className="truncate font-mono text-[10px] text-[var(--t3)]">{d.where}</div>
                      </div>
                      <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
                        {d.handling}
                      </span>
                    </div>
                  )
                })}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--t3)]">
                Alle Quellen liegen lokal. Sie bleiben im Klartext nutzbar; geschützt wird, was nach außen geht (Cloud) oder ins Protokoll wandert.
              </p>
            </section>
          )}

          {/* Typ-Verteilung + Zeitachse */}
          <section className="grid grid-cols-1 gap-3 @min-[760px]:grid-cols-2">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
              <div className="mb-3 flex items-center justify-between">
                <strong className="text-sm text-[var(--t1)]">Was wurde ersetzt</strong>
                <span className="text-[11px] text-[var(--t3)]">nach Typ</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {state.by_type.map(t => (
                  <div key={t.key} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 truncate text-xs text-[var(--t2)]">{t.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--border) 60%, transparent)' }}>
                      <span className="block h-full rounded-full" style={{ width: `${Math.max(t.count ? 6 : 0, (t.count / maxTypeCount) * 100)}%`, background: t.kind === 'secret' ? 'var(--green)' : 'var(--warm)' }} />
                    </div>
                    <span className="w-8 shrink-0 text-right text-xs tabular-nums text-[var(--t1)]">{fmtNum(t.count)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
              <div className="mb-3 flex items-center justify-between">
                <strong className="text-sm text-[var(--t1)]">Aktivität</strong>
                <span className="text-[11px] text-[var(--t3)]">letzte 14 Tage</span>
              </div>
              <div className="flex h-28 items-end gap-1">
                {state.timeline.map(d => (
                  <div key={d.date} className="flex h-full flex-1 flex-col justify-end" title={`${d.date}: ${d.entries} Läufe, ${d.redactions} Schwärzungen`}>
                    <div className="w-full rounded-t" style={{ height: `${(d.entries / maxDay) * 100}%`, minHeight: d.entries ? 3 : 0, background: d.redactions ? 'var(--warm)' : 'color-mix(in srgb, var(--t3) 55%, transparent)' }} />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-[var(--t3)]">
                <span>{state.timeline[0]?.date.slice(5)}</span>
                <span>heute</span>
              </div>
            </div>
          </section>

          {/* Geschwärzte Vorschauen */}
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
            <button
              type="button"
              onClick={() => setRecentOpen(o => !o)}
              aria-expanded={recentOpen}
              aria-controls="recent-redactions"
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span className="flex items-baseline gap-2">
                <strong className="text-sm text-[var(--t1)]">Letzte geschwärzte Einträge</strong>
                <span className="text-[11px] tabular-nums text-[var(--t3)]">{state.recent.length}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] text-[var(--t3)]">bereits maskiert, gekappt</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-[var(--t3)] transition-transform" style={{ transform: recentOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              </span>
            </button>
            {recentOpen && (
            <div id="recent-redactions" className="mt-3 flex flex-col divide-y divide-[var(--border)]">
              {state.recent.length === 0 && <p className="py-2 text-xs text-[var(--t3)]">Noch keine Protokoll-Einträge.</p>}
              {state.recent.map((r, i) => (
                <div key={i} className="flex flex-col gap-1 py-2.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-[var(--t1)]">{r.tool}</span>
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ color: r.ok ? 'var(--green)' : 'var(--warm)', background: `color-mix(in srgb, ${r.ok ? 'var(--green)' : 'var(--warm)'} 14%, transparent)` }}>{r.decision || (r.ok ? 'ok' : 'fehler')}</span>
                    {r.redactions > 0 && <span className="text-[10px] text-[var(--warm)]">{r.redactions}× geschwärzt</span>}
                    <span className="ml-auto text-[10px] text-[var(--t3)]">{fmtTs(r.ts)}</span>
                  </div>
                  <p className="break-words font-mono text-[11px] leading-relaxed text-[var(--t2)]">{renderPreview(r.preview || '—')}</p>
                </div>
              ))}
            </div>
            )}
          </section>

          {/* Auskunft und Anonymisierung pro Person */}
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel,var(--bg))] p-4">
            <div className="mb-3 flex items-center justify-between">
              <strong className="text-sm text-[var(--t1)]">Auskunft und Anonymisierung</strong>
              <span className="text-[11px] text-[var(--t3)]">Art. 15 und Art. 17</span>
            </div>
            <div className="flex gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-xl border border-[var(--border)] px-3">
                <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
                <input
                  value={pq}
                  onChange={e => setPq(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') doSearch() }}
                  placeholder="Person suchen: Name, Mail, Firma"
                  className="min-h-[40px] w-full flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]"
                />
              </div>
              <button type="button" onClick={doSearch} disabled={searching}
                className="shrink-0 rounded-xl border border-[var(--border)] px-4 text-sm text-[var(--t1)]">
                {searching ? '…' : 'Suchen'}
              </button>
            </div>

            {searched && hits.length === 0 && (
              <p className="mt-3 text-xs text-[var(--t3)]">Keine Treffer.</p>
            )}

            <div className="mt-2 flex flex-col divide-y divide-[var(--border)]">
              {hits.map(h => (
                <div key={h.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--t1)]">{h.name}</div>
                      <div className="truncate text-[10px] text-[var(--t3)]">
                        {[h.company, h.email, h.status].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    {anonDone === h.id
                      ? <span className="shrink-0 text-[11px] font-medium" style={{ color: 'var(--green)' }}>anonymisiert</span>
                      : (
                        <>
                          <button type="button" onClick={() => downloadAuskunft(h.id)} title="Auskunft als Datei"
                            className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--t2)]">
                            <Download className="h-3.5 w-3.5" /> Auskunft
                          </button>
                          <button type="button" onClick={() => startAnon(h.id)} title="Anonymisieren (Art. 17)"
                            className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]"
                            style={{ borderColor: 'color-mix(in srgb, var(--warm) 40%, transparent)', color: 'var(--warm)' }}>
                            <UserX className="h-3.5 w-3.5" /> Anonymisieren
                          </button>
                        </>
                      )}
                  </div>

                  {anonFor === h.id && (
                    <div className="mt-2 rounded-xl border p-3 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--warm) 40%, transparent)', background: 'color-mix(in srgb, var(--warm) 8%, transparent)' }}>
                      {!anonPlan ? (
                        <span className="text-[var(--t3)]">Vorschau lädt …</span>
                      ) : (
                        <>
                          <p className="text-[var(--t2)]">
                            Name und Kontaktdaten werden geleert
                            {anonPlan.tables_purged.length > 0 && `, ${anonPlan.tables_purged.reduce((s, t) => s + t.rows, 0)} Nebeneinträge entfernt`}
                            {anonPlan.offers_kept > 0 && `, ${anonPlan.offers_kept} Angebot bleibt für die Buchhaltung`}
                            . Das ist endgültig.
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button type="button" onClick={() => confirmAnon(h.id)} disabled={anonBusy}
                              className="rounded-full px-3 py-1 text-[11px] font-medium text-white" style={{ background: 'var(--warm)' }}>
                              {anonBusy ? 'läuft …' : 'Endgültig anonymisieren'}
                            </button>
                            <button type="button" onClick={() => setAnonFor(null)}
                              className="rounded-full border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--t2)]">
                              Abbrechen
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--t3)]">
              Auskunft lädt alle Stammdaten der Person als Datei. Anonymisieren erfüllt das Recht auf Löschung, ohne Buchhaltungs- und Verlaufsdaten zu zerstören.
            </p>
          </section>

          <p className="px-1 pb-2 text-[11px] leading-relaxed text-[var(--t3)]">
            Hinweis: Dies ist ein technischer Schutz und Nachweis der Schwärzung, keine vollständige DSGVO-Zertifizierung.
            Quellen wie people.db, Chats und Kalender bleiben unangetastet im Klartext nutzbar.
          </p>
        </div>
      </main>
    </div>
  )
}
