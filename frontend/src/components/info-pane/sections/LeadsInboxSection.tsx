import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, Inbox, RefreshCw } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { markSectionSeen } from '../../../eingang'
import { fmtRelTs } from '../utils/relTs'
import { Guided } from '../utils/tree'

// ── Leads-Inbox — alle example.com-Anmeldungen + Kontaktformular, gespiegelt aus KV ──

type CompanyLead = {
  key: string
  ts_kv: number
  ts_iso: string
  name: string
  email: string
  phone: string
  company: string
  message: string
  source: string
  level: string
  tools: string[]
  seat_number: number | null
  waitlist: boolean
  mail_sent: boolean
  mail_reason: string
  mail_fail_visible: boolean
  confirmation_sent: boolean
  seen: boolean
  seen_at: number | null
}

function leadSourceLabel(source: string): string {
  if (source === 'ai-sprint-2026-06') return 'AI Sprint Juni'
  if (source === 'ai-sprint-2026-05') return 'AI Sprint Mai'
  if (source === 'example.com-kontakt') return 'Kontakt'
  if (source.startsWith('ai-sprint-')) return 'AI Sprint'
  return source
}

export function LeadsInboxSection({ mobile }: { mobile?: boolean }) {
  const [leads, setLeads] = useState<CompanyLead[] | null>(null)
  const [unseen, setUnseen] = useState(0)
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:leadsOpen') === '1' } catch { return false }
  })
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({})
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(() => {
    fetch('/api/company/leads?limit=100')
      .then(r => r.json())
      .then(d => { setLeads(d.leads || []); setUnseen(d.unseen || 0) })
      .catch(() => {})
  }, [])

  const sync = useCallback(() => {
    setSyncing(true)
    fetch('/api/company/leads/sync', { method: 'POST' })
      .then(r => r.json())
      .finally(() => { setSyncing(false); load() })
  }, [load])

  useEffect(() => {
    // Stats laden auch wenn zu, damit die Counter-Pille sichtbar ist.
    fetch('/api/company/leads/stats')
      .then(r => r.json())
      .then(d => setUnseen(d.unseen || 0))
      .catch(() => {})
  }, [])
  useEffect(() => { if (open && leads === null) load() }, [open, leads, load])
  useEffect(() => { try { localStorage.setItem('infopane:leadsOpen', open ? '1' : '0') } catch {} }, [open])
  useEffect(() => {
    if (open && unseen > 0) {
      markSectionSeen('leads')
      setUnseen(0)
      setLeads(ls => (ls || []).map(l => ({ ...l, seen: true })))
    }
  }, [open, unseen])

  const markSeen = (key: string) => {
    fetch('/api/company/leads/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [key] }),
    }).then(() => {
      setLeads(ls => (ls || []).map(l => l.key === key ? { ...l, seen: true } : l))
      setUnseen(n => Math.max(0, n - 1))
    })
  }
  const markAllSeen = () => {
    fetch('/api/company/leads/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).then(() => {
      setLeads(ls => (ls || []).map(l => ({ ...l, seen: true })))
      setUnseen(0)
    })
  }

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Inbox className={`info-icon-md mr-2 flex-shrink-0 ${unseen > 0 ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Leads</span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); sync() }}
            className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 transition-opacity ${syncing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            title="Aktualisieren">
            <RefreshCw className={`info-icon-sm ${syncing ? 'animate-spin' : ''}`} />
          </button>
        )}
        <span className="flex-1" />
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            {leads === null && <div className="text-[var(--t3)]/60 info-text-meta py-2 pl-1">Lädt…</div>}
            {leads && leads.length === 0 && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Keine Leads im KV.</div>}
            {unseen > 0 && (
              <div className="pb-1 pl-1 pr-3">
                <button onClick={markAllSeen} className="info-text-meta text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer">Alle als gesehen markieren</button>
              </div>
            )}
            {leads?.map(lead => {
              const itemOpen = !!openItems[lead.key]
              return (
                <div key={lead.key}>
                  <button
                    onClick={() => { playUISound(itemOpen ? 'section-close' : 'section-open'); setOpenItems(o => ({ ...o, [lead.key]: !o[lead.key] })) }}
                    className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                    <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${itemOpen ? 'rotate-90' : ''}`} />
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
                      style={{
                        backgroundColor: lead.seen ? 'var(--t3)' : 'var(--cc-orange)',
                        opacity: lead.seen ? 0.4 : 1,
                      }}
                      title={lead.seen ? 'gesehen' : 'neu'}
                    />
                    <span className={`truncate flex-1 ${lead.seen ? 'text-[var(--t3)]' : 'text-[var(--t2)]'} hover:text-[var(--t1)]`}>
                      {lead.name || '(ohne Name)'}
                      {lead.mail_fail_visible && (
                        <span className="ml-1 text-[var(--red)]/80 info-text-meta" title={`Notification-Mail nicht zugestellt: ${lead.mail_reason || 'unknown'}`}>·Mail-Fail</span>
                      )}
                      {lead.waitlist && <span className="ml-1 text-[var(--t3)] info-text-meta">·Warte</span>}
                    </span>
                    <span className="info-text-meta text-[var(--t3)]/60 ml-2 flex-shrink-0">{leadSourceLabel(lead.source)}</span>
                    <span className="info-text-meta text-[var(--t3)]/50 tabular-nums flex-shrink-0 ml-2 w-[58px] text-right">{fmtRelTs(lead.ts_iso)}</span>
                  </button>
                  {itemOpen && (
                    <Guided>
                      <div className="info-text-meta text-[var(--t3)]/80 pb-2 pl-1 pr-3 space-y-0.5">
                        {lead.company && <div className="text-[var(--t2)]/90">{lead.company}</div>}
                        {lead.email && <div><a href={`mailto:${lead.email}`} className="hover:text-[var(--t1)]">{lead.email}</a></div>}
                        {lead.phone && <div><a href={`tel:${lead.phone}`} className="hover:text-[var(--t1)]">{lead.phone}</a></div>}
                        {lead.level && <div>Level: {lead.level}</div>}
                        {lead.tools && lead.tools.length > 0 && <div>Tools: {lead.tools.join(', ')}</div>}
                        {lead.seat_number != null && <div>Platz: {lead.seat_number}</div>}
                        {lead.message && <div className="text-[var(--t3)]/70 italic mt-1 whitespace-pre-wrap">„{lead.message}"</div>}
                        <div className="pt-1 flex items-center gap-3">
                          <span className="text-[var(--t3)]/60">
                            Mail: {lead.mail_sent
                              ? <span className="text-[var(--green)]">zugestellt</span>
                              : (lead.mail_fail_visible
                                  ? <span className="text-[var(--red)]">{lead.mail_reason || 'nicht gesendet'}</span>
                                  : <span className="text-[var(--t3)]/60">vor Mailfix</span>)}
                          </span>
                          {!lead.seen && (
                            <button onClick={() => markSeen(lead.key)} className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer">Als gesehen markieren</button>
                          )}
                        </div>
                      </div>
                    </Guided>
                  )}
                </div>
              )
            })}
          </Guided>
        </div>
      )}
    </div>
  )
}
