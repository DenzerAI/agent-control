import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, Loader2, UserRound, ScrollText } from 'lucide-react'
import { formatWaTime } from '../utils/wa'

type MeetingItem = {
  id: string
  date: string
  title: string
  has_transcript: boolean
  transcript_preview: string
  extract_status?: string
  has_extract?: boolean
}

type MeetingExtract = {
  title?: string
  summary?: string
  facts?: string[]
  decisions?: string[]
  action_items?: string[]
}

type Person = {
  id?: number
  name: string
  phone?: string
  whatsapp_chat_id?: string
  email?: string
  instagram?: string
  role?: string
  relation?: string
  status?: string
  company?: string
  company_cluster?: string
  city?: string
  anrede?: string
  offer_eur?: number | null
  tags?: string[]
  aliases?: string[]
  birthday?: string
  notes?: string
  source?: string
  last_interaction_ts?: number
  ptdesk_id?: string
  agent_enabled?: number
  agent_name?: string
  agent_system?: string
  agent_model?: string
  agent_status?: string
  agent_workspace?: string
  agent_notes?: string
}

type WaContact = {
  phone?: string
  is_business?: number
  business_name?: string
  business_description?: string
  business_website?: string
  business_email?: string
  business_category?: string
}

type Identity = {
  id: number
  kind: string
  value: string
  label?: string | null
  is_primary?: number
  source?: string
  created_at?: number
}

type PersonAgent = {
  id: number
  name: string
  system?: string | null
  model?: string | null
  status?: string | null
  workspace?: string | null
  notes?: string | null
  project_slug?: string | null
  company_cluster?: string | null
  is_primary?: number
}

type CustomerSummary = {
  id: number
  categories: string[]
  status?: string
  rate_eur?: number | null
  active_since?: string | null
  last_invoice_ts?: number | null
  next_step_text?: string | null
  next_step_due?: string | null
  pipeline_stream?: string | null
  pipeline_stage?: string | null
  workshop_kind?: string | null
  lead_source?: string | null
  betreuung_done?: number
}

type PtCard = {
  id: number
  start_date?: string
  total_sessions: number
  used_sessions: number
  price_eur?: number | null
  payment_method?: string
  payment_status?: string
  status?: string
  notes?: string
}

type PtAppt = {
  id: number
  date: string
  start_time: string
  duration_min: number
  training_type?: string
  status?: string
  notes?: string
}

type ProjectLink = {
  id: number
  project_id: number
  slug?: string
  name?: string
  role?: string
  source?: string
  confidence?: number
  project_status?: string
  pp_notes?: string
}

type PeopleGetResponse = {
  person: Person | null
  wa_contact?: WaContact | null
  identities?: Identity[]
  agents?: PersonAgent[]
  customer?: CustomerSummary | null
  pt_cards?: PtCard[]
  pt_upcoming?: PtAppt[]
  pt_recent?: PtAppt[]
  projects?: ProjectLink[]
}

const RELATION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '—' },
  { value: 'kunde', label: 'Kunde' },
  { value: 'lead', label: 'Lead' },
  { value: 'freund', label: 'Freund' },
  { value: 'familie', label: 'Familie' },
  { value: 'partner', label: 'Partner' },
  { value: 'lieferant', label: 'Lieferant' },
  { value: 'kollege', label: 'Kollege' },
  { value: 'kontakt', label: 'Kontakt' },
]

const ANREDE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '—' },
  { value: 'du', label: 'Du' },
  { value: 'sie', label: 'Sie' },
]

const AGENT_ENABLED_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: 'Kein Agent' },
  { value: '1', label: 'Agent vorhanden' },
]

const AGENT_SYSTEM_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '—' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'agent-control', label: 'Agent Control' },
  { value: 'hermes-agent', label: 'Hermes Agent' },
  { value: 'custom', label: 'Custom' },
]

const PIPELINE_STREAM_LABELS: Record<string, string> = {
  leads: 'Leads',
  agent: 'AI-Agent',
  workshops: 'Workshops',
}

export function PersonView({ personId, onBack, mobile }: { personId: number; onBack: () => void; mobile?: boolean }) {
  const [data, setData] = useState<PeopleGetResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [meetings, setMeetings] = useState<MeetingItem[]>([])
  const [meetingText, setMeetingText] = useState<string | null>(null)
  const [meetingExtract, setMeetingExtract] = useState<MeetingExtract | null>(null)

  const person = data?.person || null
  const waContact = data?.wa_contact || null
  const identities = data?.identities || []
  const agents = data?.agents || []
  const customer = data?.customer || null
  const ptCards = data?.pt_cards || []
  const ptUpcoming = data?.pt_upcoming || []
  const ptRecent = data?.pt_recent || []
  const projects = data?.projects || []

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(`/api/people/get?id=${encodeURIComponent(String(personId))}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text())
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setData(d as PeopleGetResponse)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(String(e).slice(0, 160))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [personId])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/meetings?person_id=${encodeURIComponent(String(personId))}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setMeetings(d.meetings || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [personId])

  const saveField = useCallback(async (field: keyof Person, value: unknown) => {
    if (!person?.id) return
    const cur = person[field]
    if (cur === value || (cur == null && value === '')) return
    setSaving(true)
    setError('')
    if (field === 'relation') {
      window.dispatchEvent(new CustomEvent('deck:person-relation-changed', {
        detail: { personId: person.id, oldRelation: (cur as string) || '', newRelation: (value as string) || '' },
      }))
    }
    try {
      const r = await fetch('/api/people/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: person.id, [field]: value }),
      })
      if (!r.ok) throw new Error(await r.text())
      const d = await r.json()
      setData(prev => prev ? { ...prev, person: d.person || prev.person } : prev)
    } catch (e) {
      setError(String(e).slice(0, 160))
      if (field === 'relation') {
        window.dispatchEvent(new CustomEvent('deck:person-relation-changed', {
          detail: { personId: person.id, oldRelation: (value as string) || '', newRelation: (cur as string) || '', revert: true },
        }))
      }
    } finally {
      setSaving(false)
    }
  }, [person])

  return (
    <div className="flex flex-col h-full">
      <div className={`flex items-center gap-2 border-b border-[var(--border)] ${mobile ? 'px-5 py-3' : 'px-3 py-2'} flex-shrink-0`}>
        <button onClick={onBack} className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer">
          <ChevronLeft className="info-icon-md" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="info-text-body text-[var(--t1)] font-medium truncate">{person?.name || 'Person'}</div>
          <div className="info-text-meta text-[var(--t3)] truncate">
            {person?.company || person?.relation || `ID ${personId}`}
          </div>
        </div>
        {saving && <Loader2 className="info-icon-sm text-[var(--t3)] animate-spin flex-shrink-0" />}
      </div>

      <div className={`flex-1 overflow-y-auto ${mobile ? 'px-5 py-4' : 'px-3 py-3'} space-y-3`}>
        {loading && (
          <div className="info-text-body text-[var(--t3)]/70 py-4 flex items-center gap-2">
            <Loader2 className="info-icon-sm animate-spin" />
            Lädt…
          </div>
        )}
        {!loading && !person && !error && (
          <div className="info-text-body text-[var(--t3)]/70 py-4">Person nicht gefunden.</div>
        )}
        {error && (
          <div className="info-text-meta text-[var(--red,#ef4444)]">{error}</div>
        )}

        {person && (
          <>
            <div className="rounded-lg border border-[var(--border)]/50 bg-white/[0.03] px-3 py-2 flex items-center gap-2">
              <UserRound className="info-icon-md text-[var(--t3)] flex-shrink-0" />
              <div className="min-w-0">
                <div className="info-text-body text-[var(--t1)] truncate">{person.name || 'Ohne Namen'}</div>
                <div className="info-text-meta text-[var(--t3)] truncate">
                  {person.company || 'PeopleDB Eintrag'}
                </div>
              </div>
            </div>

            <PcField label="Name" value={person.name || ''} onSave={v => saveField('name', v)} />
            <div className="grid grid-cols-2 gap-2">
              <PcSelect label="Beziehung" value={person.relation || ''} options={RELATION_OPTIONS} onSave={v => saveField('relation', v)} />
              <PcSelect label="Anrede" value={person.anrede || ''} options={ANREDE_OPTIONS} onSave={v => saveField('anrede', v)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <PcField label="Firma" value={person.company || ''} onSave={v => saveField('company', v)} />
              <PcField label="Firmen-Cluster" value={person.company_cluster || ''} onSave={v => saveField('company_cluster', v)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <PcField label="Telefon" value={person.phone || ''} onSave={v => saveField('phone', v)} />
              <PcField label="Stadt" value={person.city || ''} onSave={v => saveField('city', v)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <PcField label="E Mail" value={person.email || ''} onSave={v => saveField('email', v)} type="email" />
              <PcField label="Instagram" value={person.instagram || ''} onSave={v => saveField('instagram', v)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <PcField label="Angebot (€)" value={person.offer_eur != null ? String(person.offer_eur) : ''} onSave={v => saveField('offer_eur', v === '' ? null : Number(v))} type="number" />
              <PcField label="Geburtstag" value={person.birthday || ''} onSave={v => saveField('birthday', v)} />
            </div>
            <PcField
              label="Tags"
              value={(person.tags || []).join(', ')}
              onSave={v => saveField('tags', v.split(',').map(s => s.trim()).filter(Boolean))}
            />

            <div className="pt-2 border-t border-[var(--border)]/40 space-y-2">
              <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">Agent</div>
              <div className="grid grid-cols-2 gap-2">
                <PcSelect label="Besitz" value={person.agent_enabled ? '1' : '0'} options={AGENT_ENABLED_OPTIONS} onSave={v => saveField('agent_enabled', v === '1' ? 1 : 0)} />
                <PcSelect label="System" value={person.agent_system || ''} options={AGENT_SYSTEM_OPTIONS} onSave={v => saveField('agent_system', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <PcField label="Agent-Name" value={person.agent_name || ''} onSave={v => saveField('agent_name', v)} />
                <PcField label="Modell" value={person.agent_model || ''} onSave={v => saveField('agent_model', v)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <PcField label="Agent-Status" value={person.agent_status || ''} onSave={v => saveField('agent_status', v)} />
                <PcField label="Workspace" value={person.agent_workspace || ''} onSave={v => saveField('agent_workspace', v)} />
              </div>
              <PcTextarea label="Agent-Notizen" value={person.agent_notes || ''} onSave={v => saveField('agent_notes', v)} />
            </div>
            <PcTextarea label="Notizen" value={person.notes || ''} onSave={v => saveField('notes', v)} />

            {(person.aliases || []).length > 0 && (
              <div className="pt-1">
                <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium mb-1">Aliase</div>
                <div className="flex flex-wrap gap-1">
                  {(person.aliases || []).map((a, i) => (
                    <span key={i} className="info-text-meta px-2 py-0.5 rounded bg-white/[0.04] border border-[var(--border)]/40 text-[var(--t2)]">{a}</span>
                  ))}
                </div>
              </div>
            )}

            {identities.length > 0 && (
              <ReadOnlyBlock title={`Identitäten (${identities.length})`}>
                {identities.map(idn => (
                  <div key={idn.id} className="flex items-center justify-between gap-2 info-text-body">
                    <div className="min-w-0 flex-1">
                      <span className="text-[var(--t1)] truncate inline-block max-w-full">{idn.value}</span>
                      {idn.label && <span className="text-[var(--t3)] ml-1">· {idn.label}</span>}
                    </div>
                    <div className="info-text-meta text-[var(--t3)] flex items-center gap-1 flex-shrink-0">
                      <span className="uppercase tracking-wider">{idn.kind}</span>
                      {idn.is_primary === 1 && <span className="px-1 rounded bg-white/[0.06] text-[var(--t2)]">primär</span>}
                      {idn.source && <span>· {idn.source}</span>}
                    </div>
                  </div>
                ))}
              </ReadOnlyBlock>
            )}

            {agents.length > 0 && (
              <ReadOnlyBlock title={`Agenten (${agents.length})`}>
                {agents.map(agent => (
                  <div key={agent.id} className="info-text-body text-[var(--t2)]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[var(--t1)] truncate">{agent.name}</span>
                      <span className="info-text-meta text-[var(--t3)] flex-shrink-0">
                        {[agent.system, agent.model, agent.status].filter(Boolean).join(' · ') || (agent.is_primary ? 'primär' : 'zusätzlich')}
                      </span>
                    </div>
                    {(agent.project_slug || agent.company_cluster || agent.notes) && (
                      <div className="info-text-meta text-[var(--t3)]/80 truncate">
                        {[agent.project_slug, agent.company_cluster, agent.notes].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
              </ReadOnlyBlock>
            )}

            {customer && (
              <ReadOnlyBlock title="Kunden-Eintrag">
                <KvLine label="Kategorien" value={(customer.categories || []).join(', ') || '—'} />
                <KvLine label="Status" value={customer.status || '—'} />
                {customer.pipeline_stream && (
                  <KvLine
                    label="Pipeline"
                    value={`${PIPELINE_STREAM_LABELS[customer.pipeline_stream] || customer.pipeline_stream}${customer.pipeline_stage ? ` · ${customer.pipeline_stage}` : ''}`}
                  />
                )}
                {customer.workshop_kind && <KvLine label="Workshop-Art" value={customer.workshop_kind} />}
                {customer.lead_source && <KvLine label="Lead-Quelle" value={customer.lead_source} />}
                {customer.rate_eur != null && <KvLine label="Rate" value={`${customer.rate_eur} €`} />}
                {customer.active_since && <KvLine label="Aktiv seit" value={customer.active_since} />}
                {customer.last_invoice_ts ? (
                  <KvLine label="Letzte Rechnung" value={formatWaTime(customer.last_invoice_ts)} />
                ) : null}
              </ReadOnlyBlock>
            )}

            {(ptCards.length > 0 || ptUpcoming.length > 0 || ptRecent.length > 0) && (
              <ReadOnlyBlock title="Personal Training">
                {ptCards.map(card => (
                  <div key={card.id} className="info-text-body text-[var(--t2)] flex items-center justify-between gap-2">
                    <span className="text-[var(--t1)]">{card.used_sessions}/{card.total_sessions} Einheiten</span>
                    <span className="info-text-meta text-[var(--t3)] flex items-center gap-1 flex-shrink-0">
                      {card.status && <span>{card.status}</span>}
                      {card.payment_status && <span>· Zahlung {card.payment_status}</span>}
                      {card.price_eur != null && <span>· {card.price_eur} €</span>}
                    </span>
                  </div>
                ))}
                {ptUpcoming.length > 0 && (
                  <div className="mt-1">
                    <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] mb-0.5">Kommend</div>
                    {ptUpcoming.map(a => (
                      <div key={a.id} className="info-text-body text-[var(--t2)] flex items-center justify-between gap-2">
                        <span className="text-[var(--t1)]">{a.date} {a.start_time}</span>
                        <span className="info-text-meta text-[var(--t3)] flex-shrink-0">{a.duration_min} min · {a.status}</span>
                      </div>
                    ))}
                  </div>
                )}
                {ptRecent.length > 0 && (
                  <div className="mt-1">
                    <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] mb-0.5">Vergangen</div>
                    {ptRecent.slice(0, 5).map(a => (
                      <div key={a.id} className="info-text-body text-[var(--t2)] flex items-center justify-between gap-2">
                        <span className="text-[var(--t1)]">{a.date} {a.start_time}</span>
                        <span className="info-text-meta text-[var(--t3)] flex-shrink-0">{a.duration_min} min · {a.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </ReadOnlyBlock>
            )}

            {projects.length > 0 && (
              <ReadOnlyBlock title={`Projekte (${projects.length})`}>
                {projects.map(p => (
                  <div key={p.id} className="info-text-body text-[var(--t2)] flex items-center justify-between gap-2">
                    <span className="text-[var(--t1)] truncate">{p.name || p.slug || `#${p.project_id}`}</span>
                    <span className="info-text-meta text-[var(--t3)] flex items-center gap-1 flex-shrink-0">
                      {p.role && <span>{p.role}</span>}
                      {p.source && <span>· {p.source}</span>}
                      {p.project_status && p.project_status !== 'active' && <span>· {p.project_status}</span>}
                    </span>
                  </div>
                ))}
              </ReadOnlyBlock>
            )}

            {waContact && (waContact.phone || waContact.business_name || waContact.business_description || waContact.business_website) && (
              <div className="pt-2 border-t border-[var(--border)]/40 space-y-1">
                <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">Aus WhatsApp</div>
                {waContact.phone && (
                  <div className="info-text-body text-[var(--t2)]">
                    Telefon: <span className="text-[var(--t1)]">{waContact.phone}</span>
                    {!person.phone && (
                      <button
                        onClick={() => saveField('phone', waContact.phone || '')}
                        className="ml-2 info-text-meta text-[var(--t3)] hover:text-[var(--t1)] underline cursor-pointer"
                      >
                        übernehmen
                      </button>
                    )}
                  </div>
                )}
                {waContact.business_name && <div className="info-text-body text-[var(--t2)]">Business: <span className="text-[var(--t1)]">{waContact.business_name}</span></div>}
                {waContact.business_category && <div className="info-text-meta text-[var(--t3)]">Branche: {waContact.business_category}</div>}
                {waContact.business_website && <div className="info-text-meta text-[var(--t3)] break-all">{waContact.business_website}</div>}
                {waContact.business_email && <div className="info-text-meta text-[var(--t3)]">{waContact.business_email}</div>}
                {waContact.business_description && <div className="info-text-meta text-[var(--t3)] whitespace-pre-wrap">{waContact.business_description}</div>}
              </div>
            )}

            {meetingText !== null ? (
              <div className="pt-2 border-t border-[var(--border)]/40">
                <button onClick={() => { setMeetingText(null); setMeetingExtract(null) }} className="info-text-meta text-[var(--t3)] hover:text-[var(--t1)] mb-1 flex items-center gap-1">
                  <ChevronLeft className="w-3 h-3" /> Meetings
                </button>
                {meetingExtract && (
                  <div className="mb-3 rounded border border-[var(--cc-orange)]/30 bg-[var(--cc-orange)]/[0.04] px-3 py-2 space-y-2">
                    {meetingExtract.summary && (
                      <div className="info-text-body text-[var(--t1)] leading-relaxed">{meetingExtract.summary}</div>
                    )}
                    {(meetingExtract.decisions || []).length > 0 && (
                      <ExtractList label="Entscheidungen" items={meetingExtract.decisions || []} />
                    )}
                    {(meetingExtract.action_items || []).length > 0 && (
                      <ExtractList label="To dos" items={meetingExtract.action_items || []} />
                    )}
                    {(meetingExtract.facts || []).length > 0 && (
                      <ExtractList label="Fakten" items={meetingExtract.facts || []} />
                    )}
                  </div>
                )}
                <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium mb-1">Volltext</div>
                <div className="info-text-meta text-[var(--t2)] whitespace-pre-wrap leading-relaxed">{meetingText}</div>
              </div>
            ) : meetings.length > 0 && (
              <ReadOnlyBlock title={`Meetings (${meetings.length})`}>
                {meetings.map(m => (
                  <button key={m.id} disabled={!m.has_transcript}
                    onClick={() => {
                      if (!m.has_transcript) return
                      fetch(`/api/meetings/${m.id}/transcript`).then(r => r.json()).then(d => {
                        setMeetingText(d.transcript || '')
                        setMeetingExtract(d.extract || null)
                      }).catch(() => {})
                    }}
                    className="w-full text-left flex items-start gap-2 py-0.5 hover:bg-white/[0.03] disabled:opacity-40 disabled:cursor-default transition-colors">
                    <ScrollText className="w-3 h-3 text-[var(--t3)] flex-shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="info-text-body text-[var(--t1)] truncate">{m.title}</div>
                      {m.transcript_preview && <div className="info-text-meta text-[var(--t3)] truncate">{m.transcript_preview}</div>}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {m.has_extract && <span className="info-text-meta text-[var(--cc-orange)] tabular-nums">●</span>}
                      <span className="info-text-meta text-[var(--t3)]">{m.date}</span>
                    </div>
                  </button>
                ))}
              </ReadOnlyBlock>
            )}

            <div className="pt-2 border-t border-[var(--border)]/40 info-text-meta text-[var(--t3)] flex items-center gap-2 flex-wrap">
              {person.source && <span>Quelle: {person.source}</span>}
              {person.last_interaction_ts && <><span>·</span><span>Zuletzt: {formatWaTime(person.last_interaction_ts)}</span></>}
              {person.id && <><span>·</span><span>ID {person.id}</span></>}
              {person.ptdesk_id && <><span>·</span><span>PT-Desk {person.ptdesk_id}</span></>}
              {person.whatsapp_chat_id && <><span>·</span><span className="truncate max-w-[180px]">WA ID {person.whatsapp_chat_id}</span></>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ExtractList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="info-text-meta uppercase tracking-wider text-[var(--cc-orange)]/80 font-medium mb-0.5">{label}</div>
      <ul className="info-text-body text-[var(--t2)] space-y-0.5 list-disc pl-4">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  )
}

function ReadOnlyBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-2 border-t border-[var(--border)]/40 space-y-1">
      <div className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function KvLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-text-body flex items-center justify-between gap-2">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)]">{label}</span>
      <span className="text-[var(--t1)] truncate">{value}</span>
    </div>
  )
}

function PcField({ label, value, onSave, type = 'text', datalist }: { label: string; value: string; onSave: (v: string) => void; type?: string; datalist?: string[] }) {
  const [val, setVal] = useState(value)
  useEffect(() => { setVal(value) }, [value])
  const listId = datalist ? `dl-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined
  return (
    <label className="block">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{label}</span>
      <input
        type={type}
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => onSave(val)}
        list={listId}
        className="w-full mt-0.5 bg-[var(--bg-0)] border border-[var(--border)]/60 rounded px-2 py-1 info-text-body text-[var(--t1)] outline-none focus:border-[var(--t3)]"
      />
      {datalist && listId && (
        <datalist id={listId}>
          {datalist.map(o => <option key={o} value={o} />)}
        </datalist>
      )}
    </label>
  )
}

function PcSelect({ label, value, options, onSave }: { label: string; value: string; options: { value: string; label: string }[]; onSave: (v: string) => void }) {
  return (
    <label className="block">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{label}</span>
      <select
        value={value}
        onChange={e => onSave(e.target.value)}
        style={{ colorScheme: 'dark' }}
        className="w-full mt-0.5 bg-[var(--bg-0)] border border-[var(--border)]/60 rounded px-2 py-1 info-text-body text-[var(--t1)] outline-none focus:border-[var(--t3)] cursor-pointer"
      >
        {options.map(o => (
          <option key={o.value} value={o.value} className="bg-[var(--bg-1)] text-[var(--t1)]">{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function PcTextarea({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [val, setVal] = useState(value)
  useEffect(() => { setVal(value) }, [value])
  return (
    <label className="block">
      <span className="info-text-meta uppercase tracking-wider text-[var(--t3)] font-medium">{label}</span>
      <textarea
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={() => onSave(val)}
        rows={4}
        className="w-full mt-0.5 bg-[var(--bg-0)] border border-[var(--border)]/60 rounded px-2 py-1 info-text-body text-[var(--t1)] outline-none focus:border-[var(--t3)] resize-y"
      />
    </label>
  )
}
