import { useEffect, useMemo, useState } from 'react'
import {
  Bot, BrainCircuit, CheckCircle2, Cloud, Cpu, KeyRound, Loader2,
  MessageSquare, PlugZap, Save, Server, Sparkles, Volume2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

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
  openai: Sparkles,
  anthropic: BrainCircuit,
  google_workspace: Cloud,
  microsoft: Server,
  slack: MessageSquare,
  elevenlabs: Volume2,
  custom: PlugZap,
  engine_claude: Bot,
  engine_codex_openai: KeyRound,
  engine_local_models: Cpu,
}

function ConnectorCard({ item, onSaved }: { item: ConnectorItem; onSaved: (item: ConnectorItem) => void }) {
  const Icon = ICONS[item.id] || PlugZap
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
    <section className="workspace-system-panel">
      <div className="workspace-system-panel-head">
        <div>
          <Icon className="h-4 w-4" />
          <strong>{item.name}</strong>
        </div>
        <span>{item.kind === 'engine' ? 'Engine' : 'Dienst'}</span>
      </div>
      <div className="workspace-system-list">
        <article className={`workspace-system-row is-${connected ? 'ok' : 'neutral'}`}>
          <span />
          <div>
            <strong>{connected ? 'Verbunden' : 'Nicht verbunden'}</strong>
            <em>{connected ? item.credential_hint : item.description}</em>
          </div>
          <aside>{connected ? <CheckCircle2 className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}</aside>
        </article>
        <label className="grid gap-1 text-xs text-[var(--t2)]">
          <span className="font-medium text-[var(--t3)]">Account</span>
          <input
            value={accountLabel}
            onChange={e => setAccountLabel(e.target.value)}
            placeholder="optional"
            className="min-h-10 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--t1)] outline-none transition-colors focus:border-[var(--cc-orange)]"
          />
        </label>
        <label className="grid gap-1 text-xs text-[var(--t2)]">
          <span className="font-medium text-[var(--t3)]">API-Key oder Zugang</span>
          <input
            value={credential}
            onChange={e => setCredential(e.target.value)}
            placeholder={connected ? item.credential_hint : 'Key eintragen'}
            type="password"
            className="min-h-10 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--t1)] outline-none transition-colors focus:border-[var(--cc-orange)]"
          />
        </label>
        {error && <p className="text-xs text-[var(--cc-orange)]">{error}</p>}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-[var(--cc-orange)] px-3 text-sm font-medium text-white transition-transform active:scale-[0.96] disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Speichern
        </button>
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
        if (alive) setItems(Array.isArray(data.items) ? data.items : [])
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Konnektoren nicht erreichbar')
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
    <div className="workspace-system">
      <header className="workspace-system-hero">
        <div>
          <p>Konnektoren</p>
          <h2>Zugänge für Dienste und Engines</h2>
          <span>Keys werden nur maskiert gespeichert und nie im Klartext an die Oberfläche zurückgegeben.</span>
        </div>
        <button type="button" title="Konnektoren aktualisieren" onClick={() => window.location.reload()}>
          <PlugZap className="h-4 w-4" />
        </button>
      </header>

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

      <div className="workspace-system-main">
        {items.map(item => <ConnectorCard key={item.id} item={item} onSaved={handleSaved} />)}
        {loading && <section className="workspace-system-panel"><div className="workspace-system-list"><p>Lädt …</p></div></section>}
      </div>
    </div>
  )
}
