// Engines — Landkarte: pro Engine eine Karte mit ihren Funktionen.
// Top-Level zeigt die Engine (Badge + Modell + Funktions-Count + 24h-Calls).
// Aufklappbar zeigt die einzelnen Features. Jedes Feature ist selbst nochmal
// aufklappbar (Was/Trigger/Fallback/Live-Stats). Live-Zahlen aus
// /api/engines/stats (Quelle: llm_calls).
import { useEffect, useState } from 'react'
import { ChevronRight, Layers } from 'lucide-react'
import { EngineBadge } from '../../EngineBadge'
import { playUISound } from '../../../uiSounds'
import { ENGINES, type EngineCatalogItem, type EngineFeature, type EngineFeatureStat } from '../../../enginesCatalog'
import { Guided } from '../utils/tree'

function useEngineStats() {
  const [stats, setStats] = useState<Record<string, EngineFeatureStat>>({})
  useEffect(() => {
    let cancelled = false
    const fetchStats = async () => {
      try {
        const r = await fetch('/api/engines/stats', { cache: 'no-store' })
        const j = await r.json()
        if (!cancelled) setStats(j.by_feature || {})
      } catch {}
    }
    fetchStats()
    const id = setInterval(fetchStats, 60000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  return stats
}

function FeatureRow({ row, mobile, stat }: { row: EngineFeature; mobile?: boolean; stat?: EngineFeatureStat }) {
  const [open, setOpen] = useState(false)
  const callsLabel = stat && stat.calls > 0 ? `${stat.calls}× · ${stat.median_latency_ms}ms` : null
  return (
    <div>
      <button
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`w-full flex items-center gap-2 pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <span className="text-[var(--t2)] flex-1 truncate">{row.label}</span>
        {callsLabel && (
          <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0 tabular-nums">{callsLabel}</span>
        )}
      </button>
      {open && (
        <Guided>
          <div className="info-detail-list info-text-meta">
            <div className="info-detail-row">
              <span className="info-detail-label">Was</span>
              <span className="info-detail-value">{row.what}</span>
            </div>
            <div className="info-detail-row">
              <span className="info-detail-label">Trigger</span>
              <span className="info-detail-value">{row.trigger}</span>
            </div>
            {row.fallback && (
              <div className="info-detail-row">
                <span className="info-detail-label">Fallback</span>
                <span className="info-detail-value inline-flex items-center gap-1.5">
                  {row.fallback.engine && (
                    <EngineBadge engine={row.fallback.engine} size={14} className="text-[var(--t3)]" />
                  )}
                  <span>{row.fallback.provider ? `${row.fallback.provider} · ${row.fallback.model}` : row.fallback.model}</span>
                </span>
              </div>
            )}
            {stat && stat.calls > 0 && (
              <div className="info-detail-row">
                <span className="info-detail-label">24h</span>
                <span className="info-detail-value">
                  {stat.calls} Calls · Median {stat.median_latency_ms}ms
                  {stat.fallback_pct > 0 && ` · Fallback ${stat.fallback_pct}%`}
                  {stat.error_pct > 0 && <span className="text-[var(--cc-orange)]"> · Fehler {stat.error_pct}%</span>}
                </span>
              </div>
            )}
          </div>
        </Guided>
      )}
    </div>
  )
}

function EngineRow({ engine, mobile, featureStats }: { engine: EngineCatalogItem; mobile?: boolean; featureStats: Record<string, EngineFeatureStat> }) {
  const [open, setOpen] = useState(false)
  const totalCalls = engine.features.reduce((sum, f) => {
    const s = f.feature ? featureStats[f.feature] : undefined
    return sum + (s?.calls || 0)
  }, 0)
  return (
    <div>
      <button
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`w-full flex items-center gap-2 pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        {engine.badge ? (
          <EngineBadge engine={engine.badge} className="info-icon-md text-[var(--t3)]" />
        ) : (
          <span className="info-icon-md flex-shrink-0" />
        )}
        <span className="text-[var(--t2)] font-medium flex-1 truncate">{engine.name}</span>
        <span className="info-text-meta text-[var(--t3)]/70 flex-shrink-0 tabular-nums">
          {engine.features.length} {engine.features.length === 1 ? 'Funktion' : 'Funktionen'}
          {totalCalls > 0 && <span className="ml-2">· {totalCalls}×</span>}
        </span>
      </button>
      {open && (
        <Guided>
          {engine.features.map(f => (
            <FeatureRow
              key={f.label}
              row={f}
              mobile={mobile}
              stat={f.feature ? featureStats[f.feature] : undefined}
            />
          ))}
        </Guided>
      )}
    </div>
  )
}

function EnginesWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Engines im Workspace öffnen"
      >
        <Layers className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Engines</span>
      </button>
    </div>
  )
}

export function EnginesSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <EnginesWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  const [open, setOpen] = useState(false)
  const featureStats = useEngineStats()

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v }) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Layers className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)]" />
        <span className="text-[var(--t2)] font-medium">Engines</span>
        <span className="flex-1" />
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            {ENGINES.map(e => (
              <EngineRow key={e.id} engine={e} mobile={mobile} featureStats={featureStats} />
            ))}
          </Guided>
        </div>
      )}
    </div>
  )
}
