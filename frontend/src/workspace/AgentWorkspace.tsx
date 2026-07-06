import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Brain, FileText, MessageSquare, Network, RefreshCw, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react'
import type { CronJob } from '../components/info-pane/types'
import { useMainAgentName } from '../agents'

type RecentFile = { name: string; path: string; modified: number }
type RecentMessage = { author: string; content: string; ts: number; conversationId: string; title: string }
type AgentData = {
  agent: string
  name: string
  color: string
  model: string
  role: string
  brain: string
  identity: string
  soul: string
  stats: { total: number; today: number; lastActive: number }
  crons: CronJob[]
  recentFiles: RecentFile[]
  recentMessages?: RecentMessage[]
  workspace?: string
  files: { brain: string; identity: string; soul: string; agents: string }
}

const CACHE_KEY = 'workspace:agent:profile'

function readCache(): AgentData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) as AgentData : null
  } catch { return null }
}

function writeCache(data: AgentData) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)) } catch {}
}

function openFile(path?: string) {
  if (!path) return
  window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path } }))
}

function openConversation(message: RecentMessage) {
  if (!message.conversationId) return
  window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent: 'main', conversationId: message.conversationId, paneIndex: 0 } }))
}

function fmtAge(ts?: number): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

function fmtNum(n?: number): string {
  return (n || 0).toLocaleString('de-DE')
}

function section(text: string, heading: string): string {
  const lines = String(text || '').split('\n')
  const start = lines.findIndex(line => line.trim() === `## ${heading}`)
  if (start < 0) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break
    const clean = line.trim()
    if (!clean || clean === '---') continue
    body.push(clean.replace(/^\d+\.\s+/, '').replace(/^-\s+/, ''))
  }
  return body.slice(0, heading === 'Arbeitsweise' ? 5 : 3).join(' ')
}

function shortPath(path?: string): string {
  return String(path || '').replace('/workspace/', '~/workspace/')
}

// Grosse, lebendige Zahl als Herz der Seite: der Nutzer liebt es zu sehen, wie
// viel zwischen ihm und Agent schon passiert ist. Die Hauptzahl traegt den
// warmen Akzent, die Nebenzahlen bleiben ruhig.
function BigStat({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: boolean }) {
  return (
    <section className="agent-stat flex flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3">
      <span className={`agent-bignum whitespace-nowrap leading-none tabular-nums ${accent ? 'text-[var(--warm)]' : 'text-[var(--t1)]'}`}>{value}</span>
      <span className="mt-2 text-[11px] uppercase tracking-[0.14em] text-[var(--t3)]">{label}</span>
      {hint && <span className="mt-0.5 text-[11px] text-[var(--t3)]">{hint}</span>}
    </section>
  )
}

export function AgentWorkspace() {
  const agentName = useMainAgentName()
  const [data, setData] = useState<AgentData | null>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/agent-detail?agent=main', { cache: 'no-store' })
      const next = await res.json()
      if (!res.ok || next.error) throw new Error(next.error || res.statusText)
      setData(next as AgentData)
      writeCache(next as AgentData)
    } catch (e) {
      setError(`Agent-Daten gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const soulCards = useMemo(() => ([
    { icon: Sparkles, label: 'Identität', text: section(data?.soul || '', 'Identität') || data?.role || 'des Nutzers persönlicher Agent.' },
    { icon: Brain, label: 'Haltung', text: section(data?.soul || '', 'Haltung') || 'Handle, wenn der Weg klar ist. Frage nur, wenn es echte Folgen hat.' },
    { icon: MessageSquare, label: 'Stimme', text: section(data?.soul || '', 'Stimme') || 'Warm, direkt, menschlich. Ergebnis zuerst.' },
    { icon: ShieldCheck, label: 'Grenzen', text: section(data?.soul || '', 'Grenzen') || 'Private Daten bleiben privat. Outbound nur als Draft.' },
  ]), [data])

  const files = useMemo(() => ([
    { label: 'SOUL.md', path: data?.files?.soul },
    { label: 'AGENTS.md', path: data?.files?.identity },
    { label: 'BRAIN.md', path: data?.files?.brain },
  ].filter(item => item.path)), [data])

  return (
    <div className="agent-cq flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-5 py-4">
        <div className="flex min-w-0 items-start gap-4">
          <div className="agent-avatar flex shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
            <img src="/agent-control-logo.png" alt="" className="h-8 w-8 opacity-90" draggable={false} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--warm)]">Main Agent · Persona</div>
            <h2 className="agent-title mt-1 truncate font-medium leading-none text-[var(--t1)]">{data?.name || agentName}</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--t2)]">
              {data?.role || 'des Nutzers persönlicher Agent.'} Kein Modell-Showroom, sondern die sichtbare Identität hinter diesem Workspace.
            </p>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <BigStat label="Nachrichten zusammen" value={fmtNum(data?.stats?.total)} accent />
          <BigStat label="Heute" value={fmtNum(data?.stats?.today)} />
          <BigStat label="Zuletzt aktiv" value={fmtAge(data?.stats?.lastActive)} />
        </div>
        {error && <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {!data && loading && <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-[var(--t3)]">Lade {agentName}</div>}
        {data && (
          <div className="agent-grid">
            <section className="agent-soul">
              {soulCards.map(card => <PersonaCard key={card.label} icon={card.icon} label={card.label} text={card.text} />)}
            </section>

            <aside className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
              <PanelHead icon={Network} title="LM-Verdrahtung" meta={data.model || 'Engine'} />
              <div className="space-y-3 p-3 text-sm leading-6 text-[var(--t2)]">
                <p><strong className="text-[var(--t1)]">Engine ist Werkzeug.</strong> Agent bleibt die Identität, egal ob darunter Codex, Claude oder ein lokales Modell läuft.</p>
                <p><strong className="text-[var(--t1)]">Profilpfad:</strong> {shortPath(data.files?.soul)}</p>
                <p className="text-[var(--warm)]">Werkzeug rein, Agent raus. Keine Zaubershow, nur saubere Verdrahtung.</p>
              </div>
            </aside>

            <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
              <PanelHead icon={FileText} title="Aus SOUL.md" meta="Kern" />
              <div className="p-3 text-sm leading-6 text-[var(--t2)]">
                {section(data.soul, 'Arbeitsweise') || 'Problem verstehen. Einfachsten tragfähigen Weg wählen. Aktiv verifizieren. Ergebnis knapp melden.'}
              </div>
            </section>

            <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
              <PanelHead icon={ShieldCheck} title="Aus AGENTS.md" meta="Regel" />
              <div className="p-3 text-sm leading-6 text-[var(--t2)]">
                Du bist Agent. Engines sind nur Werkzeuge. Deutsch ist Default. Backend-Änderungen brauchen einen sauberen Restart-Hinweis.
              </div>
            </section>

            <section className="agent-span-all rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
              <PanelHead icon={MessageSquare} title={`Zuletzt von ${agentName}`} meta={`${data.recentMessages?.length || 0}`} />
              <div className="divide-y divide-[var(--border)]">
                {(data.recentMessages || []).map(message => (
                  <button key={`${message.conversationId}:${message.ts}`} type="button" onClick={() => openConversation(message)} className="flex w-full min-w-0 gap-3 px-3 py-3 text-left hover:bg-white/[0.04]" title={message.title}>
                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t3)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[var(--t3)]">{message.title} · {fmtAge(message.ts)}</span>
                      <span className="mt-1 line-clamp-2 block text-sm leading-5 text-[var(--t1)]">{message.content}</span>
                    </span>
                  </button>
                ))}
                {!data.recentMessages?.length && <div className="px-3 py-3 text-sm text-[var(--t3)]">Noch keine DB-Auszüge geladen.</div>}
              </div>
            </section>

            <section className="agent-span-all rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
              <PanelHead icon={FileText} title="Identitätsdateien" meta={shortPath(data.workspace)} />
              <div className="divide-y divide-[var(--border)]">
                {files.map(file => (
                  <button key={file.label} type="button" onClick={() => openFile(file.path)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04]" title={file.path}>
                    <FileText className="h-4 w-4 shrink-0 text-[var(--t3)]" />
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--t1)]">{file.label}</span>
                    <span className="shrink-0 text-[11px] text-[var(--t3)]">{shortPath(file.path)}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

function PersonaCard({ icon: Icon, label, text }: { icon: LucideIcon; label: string; text: string }) {
  return (
    <article className="min-h-[150px] rounded-md border border-[var(--border)] bg-[var(--bg-1)] p-4">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--warm)]">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--t2)]">{text}</p>
    </article>
  )
}

function PanelHead({ icon: Icon, title, meta }: { icon: LucideIcon; title: string; meta: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-[var(--t3)]" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{title}</span>
      <span className="shrink-0 text-[11px] text-[var(--t3)]">{meta}</span>
    </div>
  )
}
