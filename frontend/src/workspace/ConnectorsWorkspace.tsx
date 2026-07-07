import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Bot, CheckCircle2, Cpu, KeyRound, Loader2, MessageSquare, PlugZap, Save, TerminalSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

type ConnectorStatus = 'connected' | 'not_connected'
type AgentSystemKind = 'hermes' | 'openclaw' | 'generic'

type ConnectorItem = {
  id: string
  kind: 'service' | 'engine'
  name: string
  description: string
  account_label: string
  credential_hint: string
  status: ConnectorStatus
  updated_at: number
}

type AgentSystemConnector = {
  id: string
  name: string
  kind: AgentSystemKind
  install_target: string
  created_at: number
}

const AGENT_SYSTEM_STORAGE_KEY = 'agent-control:agent-system-connectors'

const AGENT_SYSTEM_KIND_LABELS: Record<AgentSystemKind, string> = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  generic: 'Generisch',
}

const DEFAULT_AGENT_SYSTEMS: AgentSystemConnector[] = [
  {
    id: 'template-hermes',
    name: 'Hermes Vorlage',
    kind: 'hermes',
    install_target: 'Installier-Kommando oder Endpoint später eintragen',
    created_at: 0,
  },
]

const ICONS: Record<string, LucideIcon> = {
  custom: PlugZap,
  sms: MessageSquare,
  custom_messenger: PlugZap,
  engine_claude: Bot,
  engine_codex_openai: KeyRound,
  engine_local_models: Cpu,
}

const LOGOS: Record<string, string> = {
  openai: '/connectors/openai.svg',
  anthropic: '/connectors/anthropic.svg',
  google_workspace: '/connectors/google.svg',
  microsoft: '/connectors/microsoft.svg',
  slack: '/connectors/slack.svg',
  elevenlabs: '/connectors/elevenlabs.svg',
  telegram: '/connectors/telegram.svg',
  sms: '/connectors/sms.svg',
  whatsapp: '/connectors/whatsapp.svg',
  custom_messenger: '/connectors/custom-messenger.svg',
}

const MONOCHROME_LOGOS = new Set(['openai', 'anthropic', 'elevenlabs'])

const DEMO_CONNECTORS: ConnectorItem[] = [
  { id: 'openai', kind: 'service', name: 'OpenAI', description: 'API-Zugang für GPT, Bilder, Transkription und Agentenläufe.', account_label: '', credential_hint: 'API-Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'anthropic', kind: 'engine', name: 'Claude', description: 'Claude Code und Anthropic-Modelle für Bau- und Analyseaufgaben.', account_label: '', credential_hint: 'API-Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'google_workspace', kind: 'service', name: 'Google / E-Mail', description: 'Gmail, Kalender, Drive und E-Mail-Kontext für den Workspace.', account_label: '', credential_hint: 'OAuth oder Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'microsoft', kind: 'service', name: 'Microsoft', description: 'Outlook, Teams, OneDrive und Microsoft 365 später anbinden.', account_label: '', credential_hint: 'Tenant oder Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'slack', kind: 'service', name: 'Slack', description: 'Channels, Threads und interne Freigaben für Team-Kommunikation.', account_label: '', credential_hint: 'Bot-Token leer', status: 'not_connected', updated_at: 0 },
  { id: 'elevenlabs', kind: 'service', name: 'ElevenLabs', description: 'Stimmen, TTS und Voice-Agent-Ausgabe.', account_label: '', credential_hint: 'API-Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'telegram', kind: 'service', name: 'Telegram', description: 'Chats, Bots und Benachrichtigungen als späterer Messenger-Kanal.', account_label: '', credential_hint: 'Bot-Token leer', status: 'not_connected', updated_at: 0 },
  { id: 'sms', kind: 'service', name: 'SMS', description: 'Kurznachrichten über einen Telefonie-Provider wie Twilio oder Sipgate.', account_label: '', credential_hint: 'Provider-Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'whatsapp', kind: 'service', name: 'WhatsApp', description: 'WhatsApp Business oder lokale Brücke für Kunden- und Teamchats.', account_label: '', credential_hint: 'Zugang leer', status: 'not_connected', updated_at: 0 },
  { id: 'custom', kind: 'service', name: 'Eigener Dienst', description: 'Freier Platz für Kunden-API, CRM, ERP oder interne Tools.', account_label: '', credential_hint: 'Endpoint und Key leer', status: 'not_connected', updated_at: 0 },
  { id: 'custom_messenger', kind: 'service', name: 'Custom Messenger', description: 'Freier Messenger-Kanal für Kunden-App, Community oder internes System.', account_label: '', credential_hint: 'Endpoint und Key leer', status: 'not_connected', updated_at: 0 },
]

function loadAgentSystems(): AgentSystemConnector[] {
  try {
    const raw = window.localStorage.getItem(AGENT_SYSTEM_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return DEFAULT_AGENT_SYSTEMS
    const items = parsed
      .filter((item): item is AgentSystemConnector => (
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.install_target === 'string' &&
        ['hermes', 'openclaw', 'generic'].includes(item.kind)
      ))
    return items.length > 0 ? items : DEFAULT_AGENT_SYSTEMS
  } catch {
    return DEFAULT_AGENT_SYSTEMS
  }
}

function saveAgentSystems(items: AgentSystemConnector[]) {
  window.localStorage.setItem(AGENT_SYSTEM_STORAGE_KEY, JSON.stringify(items))
}

function mergeDemoConnectors(items: ConnectorItem[]): ConnectorItem[] {
  const byId = new Map(items.map(item => [item.id, item]))
  return DEMO_CONNECTORS.map(demo => ({ ...demo, ...(byId.get(demo.id) || {}) }))
}

function ConnectorCard({ item, onSaved }: { item: ConnectorItem; onSaved: (item: ConnectorItem) => void }) {
  const Icon = ICONS[item.id] || PlugZap
  const logo = LOGOS[item.id]
  const monochromeLogo = logo && MONOCHROME_LOGOS.has(item.id)
  const [credential, setCredential] = useState('')
  const [accountLabel, setAccountLabel] = useState(item.account_label || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setAccountLabel(item.account_label || '')
    setCredential('')
  }, [item.account_label, item.id])

  async function save() {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/connectors/${item.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, account_label: accountLabel }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || data?.error || 'Speichern fehlgeschlagen')
      onSaved({ ...item, ...data })
      setCredential('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen')
    } finally {
      setSaving(false)
    }
  }

  const connected = item.status === 'connected'
  return (
    <section className="workspace-system-panel connector-card">
      <div className="connector-card-head">
        <div className="connector-card-title">
          <strong>{item.name}</strong>
          <span>{item.kind === 'engine' ? 'Engine' : 'Dienst'}</span>
        </div>
        <div className="connector-card-actions">
          <span className={`connector-state is-${connected ? 'connected' : 'idle'}`}>
            {connected ? <CheckCircle2 className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            {connected ? 'Verbunden' : 'Offen'}
          </span>
          <span
            className={`connector-logo${monochromeLogo ? ' is-monochrome' : ''}`}
            style={monochromeLogo ? { '--connector-logo-url': `url(${logo})` } as CSSProperties : undefined}
            aria-hidden="true"
          >
            {logo && !monochromeLogo ? <img src={logo} alt="" /> : null}
            {!logo ? <Icon className="h-5 w-5" strokeWidth={1.75} /> : null}
          </span>
        </div>
      </div>
      <p className="connector-card-copy">{connected ? item.credential_hint : item.description}</p>
      <div className="connector-form">
        <label className="connector-field">
          <span>Account</span>
          <input
            value={accountLabel}
            onChange={e => setAccountLabel(e.target.value)}
            placeholder="optional"
            className="connector-input"
          />
        </label>
        <label className="connector-field">
          <span>API-Key oder Zugang</span>
          <input
            value={credential}
            onChange={e => setCredential(e.target.value)}
            placeholder={connected ? item.credential_hint : 'Key eintragen'}
            type="password"
            className="connector-input"
          />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="connector-save-button"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Speichern
        </button>
        {error && <p className="connector-error">{error}</p>}
      </div>
    </section>
  )
}

function AgentSystemRegistry() {
  const [systems, setSystems] = useState<AgentSystemConnector[]>(() => loadAgentSystems())
  const [name, setName] = useState('')
  const [kind, setKind] = useState<AgentSystemKind>('hermes')
  const [installTarget, setInstallTarget] = useState('')

  function addSystem() {
    const cleanName = name.trim()
    const cleanTarget = installTarget.trim()
    if (!cleanName || !cleanTarget) return
    const next = [
      {
        id: `${kind}-${Date.now()}`,
        name: cleanName,
        kind,
        install_target: cleanTarget,
        created_at: Date.now(),
      },
      ...systems,
    ]
    setSystems(next)
    saveAgentSystems(next)
    setName('')
    setKind('hermes')
    setInstallTarget('')
  }

  return (
    <section className="workspace-system-panel agent-system-panel">
      <div className="connector-card-head">
        <div className="connector-card-title">
          <strong>Agentensystem</strong>
          <span>Template-Konnektor</span>
        </div>
        <span className="connector-logo" aria-hidden="true">
          <TerminalSquare className="h-5 w-5" strokeWidth={1.75} />
        </span>
      </div>
      <p className="connector-card-copy">
        Leere Hülle für fremde Agentensysteme wie Hermes oder OpenClaw. Hier wird nur registriert, noch nichts gestartet oder angebunden.
      </p>

      <div className="connector-form agent-system-form">
        <label className="connector-field">
          <span>Name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="z. B. Hermes beim Kunden"
            className="connector-input"
          />
        </label>
        <label className="connector-field">
          <span>Art</span>
          <select value={kind} onChange={e => setKind(e.target.value as AgentSystemKind)} className="connector-input">
            <option value="hermes">Hermes</option>
            <option value="openclaw">OpenClaw</option>
            <option value="generic">Generisch</option>
          </select>
        </label>
        <label className="connector-field agent-system-target">
          <span>Installier-Kommando oder Endpoint</span>
          <input
            value={installTarget}
            onChange={e => setInstallTarget(e.target.value)}
            placeholder="Platzhalter, kein Live-Call"
            className="connector-input"
          />
        </label>
        <button
          type="button"
          onClick={addSystem}
          disabled={!name.trim() || !installTarget.trim()}
          className="connector-save-button"
        >
          <Save className="h-4 w-4" />
          Eintragen
        </button>
      </div>

      <div className="agent-system-register" aria-label="Registrierte Agentensysteme">
        {systems.map(system => (
          <article key={system.id} className="agent-system-row">
            <div>
              <strong>{system.name}</strong>
              <span>{AGENT_SYSTEM_KIND_LABELS[system.kind]}</span>
            </div>
            <p>{system.install_target}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function ConnectorsWorkspace() {
  const [items, setItems] = useState<ConnectorItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const res = await fetch('/api/connectors', { cache: 'no-store' })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || 'Konnektoren nicht erreichbar')
        if (alive) setItems(mergeDemoConnectors(Array.isArray(data.items) ? data.items : []))
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Konnektoren nicht erreichbar')
        if (alive) setItems(mergeDemoConnectors([]))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => { alive = false }
  }, [])

  const stats = useMemo(() => {
    const connected = items.filter(item => item.status === 'connected').length
    const engines = items.filter(item => item.kind === 'engine').length
    return { connected, open: Math.max(0, items.length - connected), engines }
  }, [items])

  function handleSaved(next: ConnectorItem) {
    setItems(current => current.map(item => item.id === next.id ? { ...item, ...next } : item))
  }

  return (
    <WorkspaceShell
      eyebrow="Konnektoren"
      title="Zugänge für Dienste und Engines"
      subtitle="Keys werden nur maskiert gespeichert und nie im Klartext an die Oberfläche zurückgegeben."
      className="connectors-workspace"
      action={
        <button type="button" title="Konnektoren aktualisieren" onClick={() => window.location.reload()}>
          <PlugZap className="h-4 w-4" />
        </button>
      }
    >

      {error && <div className="workspace-system-note">{error}</div>}

      <div className="workspace-system-strip">
        <section>
          <span>Verbunden</span>
          <strong>{loading ? '…' : stats.connected}</strong>
          <em>maskiert gespeichert</em>
        </section>
        <section className={stats.open > 0 ? 'is-warning' : undefined}>
          <span>Offen</span>
          <strong>{loading ? '…' : stats.open}</strong>
          <em>noch ohne Zugang</em>
        </section>
        <section>
          <span>Agentensysteme</span>
          <strong>Template</strong>
          <em>Hermes, OpenClaw, frei</em>
        </section>
      </div>

      <div className="workspace-system-main workspace-system-stack">
        <AgentSystemRegistry />
        {items.map(item => <ConnectorCard key={item.id} item={item} onSaved={handleSaved} />)}
        {loading && <section className="workspace-system-panel"><div className="workspace-system-list"><p>Lädt …</p></div></section>}
      </div>
    </WorkspaceShell>
  )
}
