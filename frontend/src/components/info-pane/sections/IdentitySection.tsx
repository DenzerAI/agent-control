import { useEffect, useState } from 'react'
import { ChevronRight, FileText } from 'lucide-react'
import { Guided } from '../utils/tree'

interface IdentityAgent {
  id: string
  name: string
  rulesPath: string
  soulPath: string
}

interface IdentityPayload {
  active: string
  agents: IdentityAgent[]
}

const IDENTITY_OPEN_KEY = 'infopane:identity:openAgents'

function loadIdentityOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_OPEN_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveIdentityOpen(next: Record<string, boolean>) {
  try {
    localStorage.setItem(IDENTITY_OPEN_KEY, JSON.stringify(next))
  } catch {}
}

export function IdentitySection({ mobile, onOpenFile }: { mobile?: boolean; onOpenFile?: (path: string) => void }) {
  const [data, setData] = useState<IdentityPayload | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>(() => loadIdentityOpen())

  useEffect(() => {
    let cancelled = false
    fetch('/api/identity')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setData(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const agents = data?.agents || []

  return (
    <div>
      {agents.length === 0 && (
        <div className="px-3 py-2 info-text-meta text-[var(--t3)]/60">Keine Identity geladen.</div>
      )}
      {agents.map(agent => {
        const isOpen = Boolean(open[agent.id])
        return (
          <div key={agent.id}>
            <button
              onClick={() => setOpen(prev => {
                const next = { ...prev, [agent.id]: !isOpen }
                saveIdentityOpen(next)
                return next
              })}
              className={`w-full flex items-center pr-3 ${mobile ? 'py-3' : 'py-2'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
              style={{ paddingLeft: '8px' }}
            >
              <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
              <AgentIdentityIcon />
              <span className="text-[var(--t2)] font-medium flex-1 truncate">{agent.name}</span>
            </button>
            {isOpen && (
              <Guided>
                <div className="pb-2">
                  <IdentityFileRow path={agent.rulesPath} mobile={mobile} onOpenFile={onOpenFile} />
                  <IdentityFileRow path={agent.soulPath} mobile={mobile} onOpenFile={onOpenFile} />
                </div>
              </Guided>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AgentIdentityIcon() {
  return (
    <svg
      viewBox="0 0 200 200"
      aria-hidden="true"
      className="info-icon-md mr-2 rounded-full flex-shrink-0 text-[var(--t3)]"
    >
      <circle cx="100" cy="100" r="92" fill="currentColor" />
      <rect x="49" y="71" width="14" height="58" rx="7" fill="#111110" />
      <rect x="71" y="59" width="14" height="82" rx="7" fill="#111110" />
      <rect x="93" y="48" width="14" height="104" rx="7" fill="#111110" />
      <rect x="115" y="59" width="14" height="82" rx="7" fill="#111110" />
      <rect x="137" y="71" width="14" height="58" rx="7" fill="#111110" />
    </svg>
  )
}

function IdentityFileRow({ path, mobile, onOpenFile }: {
  path: string
  mobile?: boolean
  onOpenFile?: (path: string) => void
}) {
  const label = path.split('/').pop() || path
  return (
    <button
      onClick={() => path && onOpenFile?.(path)}
      disabled={!path}
      className={`group w-full flex items-center pl-1 pr-3 ${mobile ? 'py-2' : 'py-[5px]'} text-left hover:bg-white/[0.06] transition-colors disabled:hover:bg-transparent`}
      title={path}
    >
      {mobile && <span className="info-icon-sm mr-2 flex-shrink-0" aria-hidden="true" />}
      <FileText className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
      <span className="info-text-body text-[var(--t2)] group-hover:text-[var(--t1)] flex-1 truncate">{label}</span>
    </button>
  )
}
