import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Brain, FileText, MessageSquare, Network, RefreshCw, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react'
import type { CronJob } from '../components/info-pane/types'
import { useMainAgentName } from '../agents'
import { WorkspaceShell } from './WorkspaceShell'

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

function demoAgentData(name: string): AgentData {
  const now = Math.floor(Date.now() / 1000)
  return {
    agent: 'main',
    name,
    color: '#D97757',
    model: 'lokal verbunden',
    role: 'Persönlicher Agent, der Entscheidungen vorbereitet, Arbeit bündelt und private Daten lokal hält.',
    brain: '',
    identity: '',
    soul: [
      '## Identität',
      'Realistischer Optimist. Warm, direkt und output-orientiert.',
      '## Haltung',
      'Ursache finden, nicht Symptome überpinseln. Einfach, robust, lokal zuerst.',
      '## Stimme',
      'Ergebnis zuerst. Menschlich, knapp und ohne Support-Theater.',
      '## Grenzen',
      'Private Daten bleiben privat. Outbound nur nach Freigabe.',
      '## Arbeitsweise',
      'Problem verstehen.',
      'Einfachsten tragfähigen Weg wählen.',
      'Aktiv verifizieren.',
      'Ergebnis knapp melden.',
    ].join('\n'),
    stats: { total: 1248, today: 18, lastActive: now - 420 },
    crons: [],
    recentFiles: [],
    recentMessages: [
      { author: name, content: 'Header-Logik vereinheitlichen, alte Workspace-Köpfe rausnehmen und die Demo-Flächen beruhigen.', ts: now - 900, conversationId: 'demo-1', title: 'Workspace Feinschliff' },
      { author: name, content: 'Artefakte, Dateien und Agent-Seite optisch vorbereiten, echte Verbindungen kommen danach.', ts: now - 3600, conversationId: 'demo-2', title: 'Demo-Daten' },
    ],
    workspace: '/workspace',
    files: {
      soul: '/workspace/soul/SOUL.md',
      identity: '/workspace/AGENTS.md',
      brain: '/workspace/brain/REPO-MAP.md',
      agents: '/workspace/config/agents.json',
    },
  }
}

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
    <section className={accent ? 'is-warning' : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <em>{hint}</em>}
    </section>
  )
}

export function AgentWorkspace() {
  const agentName = useMainAgentName()
  const [data, setData] = useState<AgentData | null>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const viewData = data || demoAgentData(agentName)

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
      setError('Echter Agent-Stand gerade nicht erreichbar, die Demo-Ansicht bleibt sichtbar.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const soulCards = useMemo(() => ([
    { icon: Sparkles, label: 'Identität', text: section(viewData.soul || '', 'Identität') || viewData.role || 'des Nutzers persönlicher Agent.' },
    { icon: Brain, label: 'Haltung', text: section(viewData.soul || '', 'Haltung') || 'Handle, wenn der Weg klar ist. Frage nur, wenn es echte Folgen hat.' },
    { icon: MessageSquare, label: 'Stimme', text: section(viewData.soul || '', 'Stimme') || 'Warm, direkt, menschlich. Ergebnis zuerst.' },
    { icon: ShieldCheck, label: 'Grenzen', text: section(viewData.soul || '', 'Grenzen') || 'Private Daten bleiben privat. Outbound nur als Draft.' },
  ]), [viewData])

  const files = useMemo(() => ([
    { label: 'SOUL.md', path: viewData.files?.soul },
    { label: 'AGENTS.md', path: viewData.files?.identity },
    { label: 'BRAIN.md', path: viewData.files?.brain },
  ].filter(item => item.path)), [viewData])

  return (
    <WorkspaceShell
      className="agent-cq"
      eyebrow="Agent"
      title={viewData.name || agentName}
      subtitle={viewData.role || 'Persönlicher Agent, Identität und Systemzustand als übersichtliches Dashboard.'}
      action={
        <button type="button" onClick={load} disabled={loading} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      }
    >

      <div className="workspace-system-strip">
        <BigStat label="Nachrichten zusammen" value={fmtNum(viewData.stats?.total)} accent />
        <BigStat label="Heute" value={fmtNum(viewData.stats?.today)} />
        <BigStat label="Zuletzt aktiv" value={fmtAge(viewData.stats?.lastActive)} />
      </div>
      {error && <div className="workspace-system-note flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

      <main className="workspace-system-main workspace-system-stack">
        {loading && !data && <div className="flex min-h-[42px] items-center text-sm text-[var(--t3)]">Lade echten Stand, Demo bleibt sichtbar.</div>}
        {viewData && (
          <>
            <section className="workspace-system-panel">
              <div className="workspace-system-panel-head">
                <div><Sparkles className="h-4 w-4" /><strong>Persona</strong></div>
                <span>SOUL</span>
              </div>
              <div className="agent-soul">
              {soulCards.map(card => <PersonaCard key={card.label} icon={card.icon} label={card.label} text={card.text} />)}
              </div>
            </section>

            <section className="workspace-system-panel">
              <PanelHead icon={Network} title="LM-Verdrahtung" meta={viewData.model || 'Engine'} />
              <div className="space-y-3 p-3 text-sm leading-6 text-[var(--t2)]">
                <p><strong className="text-[var(--t1)]">Engine ist Werkzeug.</strong> Agent bleibt die Identität, egal ob darunter Codex, Claude oder ein lokales Modell läuft.</p>
                <p><strong className="text-[var(--t1)]">Profilpfad:</strong> {shortPath(viewData.files?.soul)}</p>
                <p className="text-[var(--warm)]">Werkzeug rein, Agent raus. Keine Zaubershow, nur saubere Verdrahtung.</p>
              </div>
            </section>

            <section className="workspace-system-panel">
              <PanelHead icon={FileText} title="Aus SOUL.md" meta="Kern" />
              <div className="p-3 text-sm leading-6 text-[var(--t2)]">
                {section(viewData.soul, 'Arbeitsweise') || 'Problem verstehen. Einfachsten tragfähigen Weg wählen. Aktiv verifizieren. Ergebnis knapp melden.'}
              </div>
            </section>

            <section className="workspace-system-panel">
              <PanelHead icon={ShieldCheck} title="Aus AGENTS.md" meta="Regel" />
              <div className="p-3 text-sm leading-6 text-[var(--t2)]">
                Du bist Agent. Engines sind nur Werkzeuge. Deutsch ist Default. Backend-Änderungen brauchen einen sauberen Restart-Hinweis.
              </div>
            </section>

            <section className="workspace-system-panel">
              <PanelHead icon={MessageSquare} title={`Zuletzt von ${agentName}`} meta={`${viewData.recentMessages?.length || 0}`} />
              <div className="divide-y divide-[var(--border)]">
                {(viewData.recentMessages || []).map(message => (
                  <button key={`${message.conversationId}:${message.ts}`} type="button" onClick={() => openConversation(message)} className="flex w-full min-w-0 gap-3 px-3 py-3 text-left hover:bg-white/[0.04]" title={message.title}>
                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t3)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-[var(--t3)]">{message.title} · {fmtAge(message.ts)}</span>
                      <span className="mt-1 line-clamp-2 block text-sm leading-5 text-[var(--t1)]">{message.content}</span>
                    </span>
                  </button>
                ))}
                {!viewData.recentMessages?.length && <div className="px-3 py-3 text-sm text-[var(--t3)]">Noch keine DB-Auszüge geladen.</div>}
              </div>
            </section>

            <section className="workspace-system-panel">
              <PanelHead icon={FileText} title="Identitätsdateien" meta={shortPath(viewData.workspace)} />
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
          </>
        )}
      </main>
    </WorkspaceShell>
  )
}

function PersonaCard({ icon: Icon, label, text }: { icon: LucideIcon; label: string; text: string }) {
  return (
    <article className="agent-persona-row">
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
