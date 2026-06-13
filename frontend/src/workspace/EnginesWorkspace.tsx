import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Layers, RefreshCw, Zap } from 'lucide-react'
import { EngineBadge } from '../components/EngineBadge'
import { ENGINES, type EngineCatalogItem, type EngineFeature, type EngineFeatureStat } from '../enginesCatalog'

type EnginesStatsPayload = {
  by_feature?: Record<string, EngineFeatureStat>
}

const CACHE_KEY = 'workspace:engines:stats'

function readCache(): Record<string, EngineFeatureStat> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, EngineFeatureStat> : {}
  } catch { return {} }
}

function writeCache(stats: Record<string, EngineFeatureStat>) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(stats)) } catch {}
}

function fmtMs(ms?: number): string {
  if (!ms) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function featureStat(feature: EngineFeature, stats: Record<string, EngineFeatureStat>) {
  return feature.feature ? stats[feature.feature] : undefined
}

function engineTotals(engine: EngineCatalogItem, stats: Record<string, EngineFeatureStat>) {
  return engine.features.reduce((acc, feature) => {
    const stat = featureStat(feature, stats)
    if (!stat) return acc
    acc.calls += stat.calls || 0
    acc.errors += stat.error_pct > 0 ? 1 : 0
    acc.fallbacks += stat.fallback_pct > 0 ? 1 : 0
    return acc
  }, { calls: 0, errors: 0, fallbacks: 0 })
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warm' | 'bad' }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] leading-4 text-[var(--t3)]">{label}</div>
      <div className={`truncate text-sm font-medium tabular-nums ${tone === 'bad' ? 'text-[var(--red)]' : tone === 'warm' ? 'text-[var(--warm)]' : 'text-[var(--t1)]'}`}>{value}</div>
    </section>
  )
}

function FeatureRow({ feature, stat }: { feature: EngineFeature; stat?: EngineFeatureStat }) {
  return (
    <article className="min-w-0 border-t border-[var(--border)] px-3 py-2 first:border-t-0">
      <div className="flex min-w-0 items-start gap-2">
        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t3)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--t1)]">{feature.label}</div>
          <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-[var(--t3)]">{feature.what}</div>
          <div className="mt-1 truncate text-[11px] text-[var(--t3)]">Trigger: {feature.trigger}</div>
          {feature.fallback && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--t3)]">
              <span className="shrink-0">Fallback:</span>
              {feature.fallback.engine && <EngineBadge engine={feature.fallback.engine} size={14} className="shrink-0 text-[var(--t3)]" />}
              <span className="min-w-0 truncate">{feature.fallback.provider ? `${feature.fallback.provider} · ${feature.fallback.model}` : feature.fallback.model}</span>
            </div>
          )}
        </div>
        <aside className="shrink-0 text-right">
          <div className="text-xs tabular-nums text-[var(--t2)]">{stat?.calls ? `${stat.calls}x` : '0x'}</div>
          <div className="text-[11px] tabular-nums text-[var(--t3)]">{fmtMs(stat?.median_latency_ms)}</div>
        </aside>
      </div>
      {stat && (stat.error_pct > 0 || stat.fallback_pct > 0) && (
        <div className="mt-2 flex flex-wrap gap-2 pl-6 text-[11px] tabular-nums">
          {stat.error_pct > 0 && <span className="text-[var(--red)]">Fehler {stat.error_pct}%</span>}
          {stat.fallback_pct > 0 && <span className="text-[var(--warm)]">Fallback {stat.fallback_pct}%</span>}
        </div>
      )}
    </article>
  )
}

function EnginePanel({ engine, stats }: { engine: EngineCatalogItem; stats: Record<string, EngineFeatureStat> }) {
  const totals = engineTotals(engine, stats)
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex min-w-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        {engine.badge ? <EngineBadge engine={engine.badge} className="h-4 w-4 shrink-0 text-[var(--t3)]" /> : <Layers className="h-4 w-4 shrink-0 text-[var(--t3)]" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{engine.name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{totals.calls}x</span>
      </div>
      <div className="grid grid-cols-3 gap-2 border-b border-[var(--border)] px-3 py-2">
        <Stat label="Features" value={engine.features.length} />
        <Stat label="Fehler" value={totals.errors} tone={totals.errors ? 'bad' : undefined} />
        <Stat label="Fallback" value={totals.fallbacks} tone={totals.fallbacks ? 'warm' : undefined} />
      </div>
      <div>
        {engine.features.map(feature => (
          <FeatureRow key={feature.label} feature={feature} stat={featureStat(feature, stats)} />
        ))}
      </div>
    </section>
  )
}

export function EnginesWorkspace() {
  const [stats, setStats] = useState<Record<string, EngineFeatureStat>>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/engines/stats', { cache: 'no-store' })
      const data = await res.json() as EnginesStatsPayload
      const next = data.by_feature || {}
      setStats(next)
      writeCache(next)
    } catch (e) {
      setError(`Engine-Stats gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, 60000)
    return () => window.clearInterval(id)
  }, [load])

  const totals = useMemo(() => {
    const featureCount = ENGINES.reduce((sum, engine) => sum + engine.features.length, 0)
    const values = Object.values(stats)
    return {
      featureCount,
      calls: values.reduce((sum, stat) => sum + (stat.calls || 0), 0),
      errors: values.filter(stat => stat.error_pct > 0).length,
    }
  }, [stats])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Engines · LLM-Betriebslandkarte</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{totals.calls ? `${totals.calls} Calls in 24h` : 'Engine-Landkarte'}</h2>
            <div className="truncate text-xs text-[var(--t3)]">Modelle, Features, Fallbacks und Live-Stats</div>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Engines" value={ENGINES.length} />
          <Stat label="Features" value={totals.featureCount} />
          <Stat label="Fehlerquellen" value={totals.errors} tone={totals.errors ? 'bad' : undefined} />
        </div>
        {error && <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {loading && Object.keys(stats).length === 0 && (
          <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-[var(--t3)]">Lade Engine-Stats</div>
        )}
        <div className="grid grid-cols-1 gap-3 workspace-engines-grid">
          {ENGINES.map(engine => (
            <EnginePanel key={engine.id} engine={engine} stats={stats} />
          ))}
        </div>
      </main>
    </div>
  )
}
