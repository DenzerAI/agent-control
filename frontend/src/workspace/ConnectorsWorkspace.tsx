import { useEffect, useMemo, useState } from 'react'
import {
  Bot, CheckCircle2, Cpu, KeyRound, Loader2, MessageSquare, PlugZap, Save,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

type ConnectorStatus = 'connected' | 'not_connected'

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

function mergeDemoConnectors(items: ConnectorItem[]): ConnectorItem[] {
  const byId = new Map(items.map(item => [item.id, item]))
  return DEMO_CONNECTORS.map(demo => ({ ...demo, ...(byId.get(demo.id) || {}) }))
}

function ConnectorCard({ item, onSaved }: { item: ConnectorItem; onSaved: (item: ConnectorItem) => void }) {
  const Icon = ICONS[item.id] || PlugZap
  const logo = LOGOS[item.id]
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
        <span className="connector-logo" aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <Icon className="h-5 w-5" strokeWidth={1.75} />}
        </span>
        <div className="connector-card-title">
          <strong>{item.name}</strong>
          <span>{item.kind === 'engine' ? 'Engine' : 'Dienst'}</span>
        </div>
        <span className={`connector-state is-${connected ? 'connected' : 'idle'}`}>
          {connected ? <CheckCircle2 className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
          {connected ? 'Verbunden' : 'Offen'}
        </span>
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
          <span>Engines</span>
          <strong>{loading ? '…' : stats.engines}</strong>
          <em>Claude, Codex, lokal</em>
        </section>
      </div>

      <div className="workspace-system-main workspace-system-stack">
        {items.map(item => <ConnectorCard key={item.id} item={item} onSaved={handleSaved} />)}
        {loading && <section className="workspace-system-panel"><div className="workspace-system-list"><p>Lädt …</p></div></section>}
      </div>
    </WorkspaceShell>
  )
}
