import { useCallback, useEffect, useMemo, useState } from 'react'
import { Brain, ChevronRight, Moon, RefreshCw } from 'lucide-react'
import { playUISound } from '../../../uiSounds'

const READ_KEY = 'agent.dreaming.latestReadMtime'

type DreamingInfo = {
  ok: boolean
  latestNight: { mtime: number; summary: string } | null
  candidates: { id: string; promoted: boolean; status: string; body: string }[]
  promotedCandidateCount: number
}

const EMPTY: DreamingInfo = {
  ok: false,
  latestNight: null,
  candidates: [],
  promotedCandidateCount: 0,
}

function fmtAge(ts?: number): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

export function DreamingSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <DreamingWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  const [info, setInfo] = useState<DreamingInfo>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [readMtime] = useState(() => {
    const raw = window.localStorage.getItem(READ_KEY)
    return raw ? Number(raw) || 0 : 0
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/dreaming', { cache: 'no-store' })
      const data = await res.json().catch(() => EMPTY)
      setInfo(data?.ok ? data : EMPTY)
    } catch {
      setInfo(EMPTY)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const promoted = useMemo(() => (
    info.candidates
      .filter(item => item.promoted && item.status !== 'rejected' && item.body)
      .slice(0, 1)
  ), [info.candidates])
  const latestMtime = Number(info.latestNight?.mtime || 0)
  const attention = latestMtime > 0 && latestMtime > readMtime + 1

  return (
    <div>
      <button
        type="button"
        onClick={() => playUISound('section-open')}
        className={`group w-full flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
        <Moon className={`info-icon-md mr-2 flex-shrink-0 ${attention ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-[var(--t2)] font-medium">Dreaming</span>
          <span className="block truncate info-text-meta text-[var(--t3)]/70">
            {promoted[0]?.body || info.latestNight?.summary || 'Muster, Nachtanalyse und Nap'}
          </span>
        </span>
        <span className="ml-2 flex items-center gap-2 flex-shrink-0">
          <span className={`info-text-meta tabular-nums ${attention ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`}>
            {info.promotedCandidateCount || fmtAge(latestMtime)}
          </span>
          {loading ? <RefreshCw className="info-icon-sm animate-spin text-[var(--t3)]" /> : <Brain className="info-icon-sm text-[var(--t3)]" />}
        </span>
      </button>
    </div>
  )
}

function DreamingWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={() => { playUISound('section-open'); onOpenWorkspace() }}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Dreaming im Workspace öffnen"
      >
        <Moon className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Dreaming</span>
      </button>
    </div>
  )
}
