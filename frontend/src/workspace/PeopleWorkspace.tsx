import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Building2, RefreshCw, Search, Tag, UserRound } from 'lucide-react'

type CustomerEntry = {
  person_id: number
  categories: string[]
  status: string
  last_interaction_ts?: number | null
  person?: {
    name?: string
    company?: string
    city?: string
    phone?: string
    email?: string
    agent_name?: string
    agent_enabled?: number
  }
  firm_role?: string | null
}

type Firm = { id: string; label: string; count: number; leads: string[]; people: CustomerEntry[] }
type Folder = { id: string; label: string; count: number; customers: CustomerEntry[]; firms?: Firm[] }
type PersonLite = { id: number; name: string; company?: string; city?: string; email?: string; phone?: string; agent?: string; last?: number | null; role?: string | null }

type Identity = { id: number; kind: string; value: string; label?: string; is_primary?: number; source?: string }
type PersonFull = Record<string, unknown> & { id: number; name?: string; identities?: Identity[] }

const CACHE_KEY = 'workspace:people:folders'
const FOLDER_ORDER = ['alle', 'personal-training', 'workshops', 'agent', 'leads']
const FOLDER_LABELS: Record<string, string> = {
  alle: 'Alle',
  'personal-training': 'Personal Training',
  workshops: 'Workshops',
  agent: 'Agenten',
  leads: 'Leads',
}

function readCache(): Folder[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) as Folder[] : []
  } catch { return [] }
}

function writeCache(folders: Folder[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(folders)) } catch {}
}

function fmtAge(ts?: number | null): string {
  if (!ts) return ''
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 86400) return 'heute'
  if (age < 86400 * 7) return `${Math.floor(age / 86400)}d`
  if (age < 86400 * 35) return `${Math.floor(age / 86400 / 7)}w`
  if (age < 86400 * 400) return `${Math.floor(age / 86400 / 30)}m`
  return `${Math.floor(age / 86400 / 365)}j`
}

function entryToLite(entry: CustomerEntry): PersonLite {
  const p = entry.person || {}
  return {
    id: entry.person_id,
    name: p.name || '(ohne Name)',
    company: p.company,
    city: p.city,
    email: p.email,
    phone: p.phone,
    agent: p.agent_enabled ? p.agent_name || 'Agent' : '',
    last: entry.last_interaction_ts || null,
    role: entry.firm_role,
  }
}

function matches(person: PersonLite, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [person.name, person.company, person.city, person.email, person.phone, person.agent, person.role]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(q)
}

export function PeopleWorkspace() {
  const [folders, setFolders] = useState<Folder[]>(() => readCache())
  const [active, setActive] = useState('alle')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/customers', { cache: 'no-store' })
      const data = await res.json()
      const next = Array.isArray(data.folders) ? data.folders as Folder[] : []
      setFolders(next)
      writeCache(next)
    } catch (e) {
      setError(`Personendatenbank gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const activeFolder = folders.find(f => f.id === active) || folders[0] || null
  const people = useMemo(() => {
    const source = activeFolder?.customers || []
    return source.map(entryToLite).filter(person => matches(person, query)).slice(0, 250)
  }, [activeFolder, query])
  const allCount = folders.find(f => f.id === 'alle')?.count || 0
  const agentCount = folders.find(f => f.id === 'agent')?.count || 0
  const leadCount = folders.find(f => f.id === 'leads')?.count || 0

  if (selectedId != null) {
    return <PersonDetail personId={selectedId} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Personendatenbank · people.db</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{allCount ? `${allCount} Personen` : 'Personen'}</h2>
            <div className="truncate text-xs text-[var(--t3)]">Kunden, Leads, Agenten und unklassifizierte Kontakte</div>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Alle" value={allCount} />
          <Stat label="Agenten" value={agentCount} />
          <Stat label="Leads" value={leadCount} />
        </div>
        {error && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--warm)]">{error}</div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {FOLDER_ORDER.map(id => {
            const folder = folders.find(f => f.id === id)
            return (
              <button key={id} type="button" onClick={() => setActive(id)} className={`border px-3 py-1.5 text-xs ${active === id ? 'border-[var(--t2)] text-[var(--t1)]' : 'border-[var(--border)] text-[var(--t3)] hover:text-[var(--t1)]'}`}>
                {FOLDER_LABELS[id] || id} {folder?.count ? `· ${folder.count}` : ''}
              </button>
            )
          })}
        </div>

        <label className="mb-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, Firma, Ort, Mail suchen" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]" />
        </label>

        <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <Building2 className="h-4 w-4 text-[var(--t3)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{activeFolder?.label || FOLDER_LABELS[active] || active}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{people.length}</span>
          </div>
          {people.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Personen' : 'Keine Treffer.'}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {people.map(person => (
                <button key={person.id} type="button" onClick={() => setSelectedId(person.id)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04]">
                  <UserRound className="h-4 w-4 shrink-0 text-[var(--t3)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--t1)]">{person.name}</span>
                    <span className="block truncate text-xs text-[var(--t3)]">{[person.company, person.city, person.email || person.phone].filter(Boolean).join(' · ') || 'kein Detail'}</span>
                  </span>
                  {person.agent && <Tag className="h-3.5 w-3.5 shrink-0 text-[var(--warm)]" />}
                  {person.last && <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtAge(person.last)}</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="text-[11px] text-[var(--t3)]">{label}</div>
      <div className="text-sm font-medium tabular-nums text-[var(--t1)]">{value}</div>
    </section>
  )
}

// ── Personen-Datenblatt ──────────────────────────────────────────────
// Zeigt die wirklichen, deterministischen people.db-Felder. Leere Felder
// werden bewusst als "nicht hinterlegt" gezeigt, damit Lücken sichtbar sind.

const EUR_KEYS = new Set(['offer_eur', 'rate_eur', 'value_eur'])
const TS_KEYS = new Set(['last_interaction_ts', 'last_invoice_ts', 'active_since', 'next_step_due', 'created_at', 'updated_at'])
const ARR_KEYS = new Set(['tags', 'categories', 'aliases'])

type FieldGroup = { title: string; fields: [string, string][] }
const FIELD_GROUPS: FieldGroup[] = [
  { title: 'Kontakt', fields: [
    ['anrede', 'Anrede'], ['role', 'Rolle'], ['company', 'Firma'], ['city', 'Ort'],
    ['phone', 'Telefon'], ['email', 'E-Mail'], ['instagram', 'Instagram'],
    ['whatsapp_chat_id', 'WhatsApp-ID'], ['birthday', 'Geburtstag'],
  ] },
  { title: 'Geschäft', fields: [
    ['relation', 'Beziehung'], ['customer_status', 'Kundenstatus'], ['status', 'Status'],
    ['pipeline_stream', 'Pipeline'], ['pipeline_stage', 'Stufe'], ['workshop_kind', 'Workshop-Art'],
    ['offer_eur', 'Angebot'], ['rate_eur', 'Satz'], ['value_eur', 'Wert'],
    ['active_since', 'Aktiv seit'], ['last_invoice_ts', 'Letzte Rechnung'],
    ['next_step_text', 'Nächster Schritt'], ['next_step_due', 'Fällig am'],
  ] },
  { title: 'Rechnung', fields: [
    ['billing_email', 'Rechnungs-Mail'], ['billing_address', 'Rechnungsadresse'], ['ust_idnr', 'USt-IdNr.'],
  ] },
  { title: 'Notizen & Herkunft', fields: [
    ['tags', 'Tags'], ['categories', 'Kategorien'], ['source', 'Quelle'], ['lead_source', 'Lead-Quelle'],
    ['notes', 'Notiz'], ['customer_notes', 'Kundennotiz'],
  ] },
  { title: 'System', fields: [
    ['id', 'ID'], ['slug', 'Slug'], ['last_interaction_ts', 'Letzter Kontakt'],
    ['created_at', 'Angelegt'], ['updated_at', 'Aktualisiert'],
  ] },
]

const LONG_KEYS = new Set(['notes', 'customer_notes', 'billing_address', 'next_step_text'])

function fmtValue(key: string, raw: unknown): string | null {
  if (raw == null || raw === '') return null
  if (ARR_KEYS.has(key)) {
    const arr = Array.isArray(raw) ? raw : []
    return arr.length ? arr.join(', ') : null
  }
  if (EUR_KEYS.has(key)) {
    const n = Number(raw)
    if (!Number.isFinite(n) || n === 0) return null
    return `${n.toLocaleString('de-DE')} €`
  }
  if (TS_KEYS.has(key)) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 1e9) {
      return new Date(n * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    }
    const s = String(raw)
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return s
  }
  return String(raw)
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// iOS-Settings-Zeile: Label leise links, Wert klar rechts. Lange Werte stapeln
// sich voll über die Breite, leere Felder bleiben als ruhiges "—" sichtbar.
function Row({ label, value, long }: { label: string; value: string | null; long?: boolean }) {
  if (long) {
    return (
      <div className="px-4 py-2.5">
        <div className="mb-1 text-xs text-[var(--t3)]">{label}</div>
        <div className={`text-sm leading-5 ${value ? 'text-[var(--t1)]' : 'text-[var(--t3)]'}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value ?? '—'}</div>
      </div>
    )
  }
  return (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <div className="shrink-0 text-sm text-[var(--t3)]">{label}</div>
      <div className={`min-w-0 flex-1 text-right text-sm ${value ? 'text-[var(--t1)]' : 'text-[var(--t3)]'}`} style={{ wordBreak: 'break-word' }}>{value ?? '—'}</div>
    </div>
  )
}

function PersonDetail({ personId, onBack }: { personId: number; onBack: () => void }) {
  const [person, setPerson] = useState<PersonFull | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    fetch(`/api/people/get?id=${personId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => { if (alive) setPerson(d.person as PersonFull) })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'unbekannt') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [personId])

  const agent = (person?.agent || {}) as { enabled?: boolean; name?: string; status?: string; model?: string }
  const identities = (person?.identities || []) as Identity[]
  const name = (person?.name as string) || '(ohne Name)'
  const sub = [person?.company, person?.city].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 px-4 pb-4 pt-3">
        <button type="button" onClick={onBack} className="-ml-1 mb-4 inline-flex items-center gap-1 text-sm text-[var(--t3)] transition-colors hover:text-[var(--t1)]">
          <ArrowLeft className="h-4 w-4" /> Personen
        </button>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--bg-1)] text-base font-medium text-[var(--t2)]">{initials(name)}</div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold leading-7 text-[var(--t1)]">{name}</h2>
            {sub && <div className="truncate text-sm text-[var(--t3)]">{sub}</div>}
            {agent.enabled && (
              <span className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--warm)]">
                <Tag className="h-3 w-3" />{agent.name || 'Agent'}{agent.status ? ` · ${agent.status}` : ''}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        {loading && <div className="py-4 text-sm text-[var(--t3)]">Lade Datenblatt</div>}
        {error && <div className="rounded-xl bg-[var(--bg-1)] px-4 py-3 text-sm text-[var(--warm)]">Datenblatt nicht erreichbar: {error}</div>}
        {person && !loading && (
          <div className="flex flex-col gap-6">
            {identities.length > 0 && (
              <section>
                <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--t3)]">Identitäten</div>
                <div className="divide-y divide-[var(--border)]/60 overflow-hidden rounded-xl bg-[var(--bg-1)]">
                  {identities.map(idn => (
                    <div key={idn.id} className="flex items-baseline gap-4 px-4 py-2.5">
                      <span className="shrink-0 text-sm text-[var(--t3)]">{idn.label || idn.kind}</span>
                      <span className="min-w-0 flex-1 break-words text-right text-sm text-[var(--t1)]">{idn.value}</span>
                      {idn.is_primary ? <span className="shrink-0 text-[11px] text-[var(--warm)]">primär</span> : null}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {FIELD_GROUPS.map(group => (
              <section key={group.title}>
                <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--t3)]">{group.title}</div>
                <div className="divide-y divide-[var(--border)]/60 overflow-hidden rounded-xl bg-[var(--bg-1)]">
                  {group.fields.map(([key, label]) => (
                    <Row key={key} label={label} value={fmtValue(key, person[key])} long={LONG_KEYS.has(key)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
