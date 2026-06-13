import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, UserRound, Users, RefreshCw, Building2, Search, Tag, Folder } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { openPersonInInfoPane } from '../utils/openPerson'
import { Guided } from '../utils/tree'

// ── Personen — reine Sicht auf people.db ──
// Eine Liste pro Filter, kein Aufklappen mehr. Klick auf Namen oeffnet PersonView.
// Datenquelle: /api/customers (intern people-basiert) liefert Folders inkl. "Alle".

type PersonLite = {
  id: number
  name: string
  company?: string
  city?: string
  phone?: string
  email?: string
  agent_name?: string
  agent_system?: string
  agent_enabled?: number
  last_interaction_ts?: number
  firm_role?: string | null
}

type CustomerEntry = {
  person_id: number
  categories: string[]
  status: string
  last_interaction_ts?: number | null
  person?: {
    id?: number
    name?: string
    company?: string
    city?: string
    phone?: string
    email?: string
    agent_name?: string
    agent_system?: string
    agent_enabled?: number
  }
  firm_role?: string | null
}

type Firm = {
  id: string
  label: string
  count: number
  leads: string[]
  people: CustomerEntry[]
}

type Folder = {
  id: string
  label: string
  count: number
  customers: CustomerEntry[]
  firms?: Firm[]
}

type FolderId = 'alle' | 'personal-training' | 'workshops' | 'agent' | 'leads'

const FOLDER_LABELS: Record<string, string> = {
  alle: 'Alle',
  'personal-training': 'Personal Training',
  workshops: 'Workshops',
  agent: 'Agenten',
  leads: 'Leads',
}

const FOLDER_ORDER: FolderId[] = ['alle', 'personal-training', 'workshops', 'agent', 'leads']

type UntaggedPerson = {
  id: number
  name: string
  company?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  last_interaction_ts?: number | null
}

const REL_BINDINGS: Array<{ key: string; rel: string; label: string }> = [
  { key: '1', rel: 'kunde', label: 'Kunde' },
  { key: '2', rel: 'lead', label: 'Lead' },
  { key: '3', rel: 'freund', label: 'Freund' },
  { key: '4', rel: 'familie', label: 'Familie' },
  { key: '5', rel: 'partner', label: 'Partner' },
  { key: '6', rel: 'lieferant', label: 'Lieferant' },
  { key: '7', rel: 'kollege', label: 'Kollege' },
  { key: '8', rel: 'kontakt', label: 'Kontakt' },
]

function fmtRelShort(ts: number): string {
  if (!ts) return ''
  const days = Math.floor((Date.now() / 1000 - ts) / 86400)
  if (days < 0) return ''
  if (days === 0) return 'heute'
  if (days === 1) return 'gestern'
  if (days < 7) return `${days}d`
  if (days < 35) return `${Math.floor(days / 7)}w`
  if (days < 400) return `${Math.floor(days / 30)}m`
  return `${Math.floor(days / 365)}j`
}

function entryToLite(e: CustomerEntry): PersonLite {
  const p = e.person || {}
  return {
    id: e.person_id,
    name: p.name || '(ohne Name)',
    company: p.company,
    city: p.city,
    phone: p.phone,
    email: p.email,
    agent_name: p.agent_name,
    agent_system: p.agent_system,
    agent_enabled: p.agent_enabled,
    last_interaction_ts: e.last_interaction_ts || undefined,
    firm_role: e.firm_role,
  }
}

function filterPeople(list: PersonLite[], q: string): PersonLite[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list
  return list.filter(p => {
    const hay = [p.name, p.company, p.city, p.phone, p.email, p.agent_name, p.agent_system].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(needle)
  })
}

function PersonRow({ p, mobile, jumpId }: { p: PersonLite; mobile?: boolean; jumpId?: number }) {
  const rowRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (jumpId === p.id && rowRef.current) {
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        rowRef.current?.focus({ preventScroll: true })
      })
    }
  }, [jumpId, p.id])
  const rel = fmtRelShort(p.last_interaction_ts || 0)
  return (
    <button
      ref={rowRef}
      onClick={() => { playUISound('section-open'); openPersonInInfoPane(p.id) }}
      className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}
      title={p.name}
    >
      <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
      <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">
        {p.name}
        {p.firm_role && <span className="ml-1.5 info-text-meta text-[var(--t3)]/70">·{p.firm_role}</span>}
        {!p.firm_role && p.company && <span className="ml-1 info-text-meta text-[var(--t3)]/60">·{p.company}</span>}
        {p.agent_enabled ? <span className="ml-1.5 info-text-meta text-[var(--cc-orange)]/80">·{p.agent_name || 'Agent'}</span> : null}
      </span>
      {rel && (
        <span className="info-text-meta text-[var(--t3)]/60 ml-2 flex-shrink-0 tabular-nums" title="letzter Kontakt">
          {rel}
        </span>
      )}
    </button>
  )
}

function UntaggedTagger({ mobile }: { mobile?: boolean }) {
  const [people, setPeople] = useState<UntaggedPerson[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [focus, setFocus] = useState(0)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [done, setDone] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({})

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/people/list?relation=unklassifiziert&limit=500')
      .then(r => r.json())
      .then(d => {
        setPeople(Array.isArray(d.people) ? d.people : [])
        setFocus(0)
        setLoading(false)
      })
      .catch(() => { setPeople([]); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  const setRelation = useCallback((personId: number, rel: string | null) => {
    setSavingId(personId)
    fetch(`/api/people/${personId}/relation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relation: rel }),
    })
      .then(r => r.json())
      .then(() => {
        setPeople(list => {
          if (!list) return list
          const next = list.filter(p => p.id !== personId)
          setFocus(f => Math.max(0, Math.min(f, next.length - 1)))
          return next
        })
        setDone(n => n + 1)
        setSavingId(null)
      })
      .catch(() => setSavingId(null))
  }, [])

  useEffect(() => {
    const el = rowRefs.current[focus]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [focus, people])

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!people || people.length === 0) return
    const current = people[focus]
    if (e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault()
      setFocus(f => Math.min(f + 1, people.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocus(f => Math.max(f - 1, 0))
      return
    }
    if (e.key === '0' || e.key === ' ') {
      e.preventDefault()
      setFocus(f => Math.min(f + 1, people.length - 1))
      return
    }
    if (e.key === 'Backspace' && current) {
      e.preventDefault()
      setRelation(current.id, null)
      return
    }
    const hit = REL_BINDINGS.find(b => b.key === e.key)
    if (hit && current) {
      e.preventDefault()
      setRelation(current.id, hit.rel)
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKey}
      className="outline-none pl-1 pr-3">
      <div className="info-text-meta text-[var(--t3)]/65 py-2 leading-relaxed">
        Klick rein, dann Tasten <span className="text-[var(--t2)]">1–8</span> zum Taggen,{' '}
        <span className="text-[var(--t2)]">↑↓</span> navigieren,{' '}
        <span className="text-[var(--t2)]">0/Space</span> überspringen,{' '}
        <span className="text-[var(--t2)]">⌫</span> Tag löschen.
        {done > 0 && <span className="text-[var(--t3)]/50"> · {done} getaggt</span>}
      </div>
      <div className="flex flex-wrap gap-1 pb-2">
        {REL_BINDINGS.map(b => (
          <span key={b.key} className="info-text-meta px-1.5 py-0.5 rounded bg-white/[0.05] text-[var(--t2)]/80">
            <span className="text-[var(--cc-orange)] mr-1">{b.key}</span>{b.label}
          </span>
        ))}
      </div>
      {loading && <div className="info-text-meta text-[var(--t3)]/60 py-2">Lädt…</div>}
      {people && people.length === 0 && !loading && (
        <div className="info-text-meta text-[var(--t3)]/60 py-2">Alles getaggt.</div>
      )}
      {people && people.map((p, i) => {
        const isFocus = i === focus
        const rel = fmtRelShort(p.last_interaction_ts || 0)
        return (
          <div
            key={p.id}
            ref={el => { rowRefs.current[i] = el }}
            onClick={() => { setFocus(i); containerRef.current?.focus() }}
            className={`flex items-center ${mobile ? 'py-2' : 'py-[5px]'} px-2 rounded info-text-body cursor-pointer transition-colors ${isFocus ? 'bg-[var(--cc-orange)]/15 ring-1 ring-[var(--cc-orange)]/40' : 'hover:bg-white/[0.05]'}`}>
            <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
            <span className="truncate flex-1 text-[var(--t2)]">
              {p.name}
              {p.company && <span className="ml-1 text-[var(--t3)]/60 info-text-meta">·{p.company}</span>}
            </span>
            {savingId === p.id && <span className="info-text-meta text-[var(--t3)]/60 ml-2">…</span>}
            {rel && savingId !== p.id && (
              <span className="info-text-meta text-[var(--t3)]/55 ml-2 tabular-nums flex-shrink-0">{rel}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function PeopleSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <PeopleWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <PeopleInlineSection mobile={mobile} />
}

function PeopleWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Personen im Workspace öffnen"
      >
        <Users className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Personen</span>
      </button>
    </div>
  )
}

function PeopleInlineSection({ mobile }: { mobile?: boolean }) {
  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:peopleOpen') === '1' } catch { return false }
  })
  const [openFolder, setOpenFolder] = useState<FolderId | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [openFirms, setOpenFirms] = useState<Record<string, boolean>>({})
  const [taggerOpen, setTaggerOpen] = useState(false)
  const [untaggedCount, setUntaggedCount] = useState<number | null>(null)
  const [jumpPersonId, setJumpPersonId] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/customers')
      .then(r => r.json())
      .then(d => {
        setFolders(d.folders || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { if (open && folders === null) load() }, [open, folders, load])
  useEffect(() => { try { localStorage.setItem('infopane:peopleOpen', open ? '1' : '0') } catch {} }, [open])

  useEffect(() => {
    if (!open) return
    fetch('/api/people/list?relation=unklassifiziert&limit=1')
      .then(r => r.json())
      .then(d => {
        const rel = (d.relations || []).find((r: { value: string; count: number }) => r.value === 'unklassifiziert')
        setUntaggedCount(rel ? rel.count : 0)
      })
      .catch(() => {})
  }, [open])

  // Springe zu Person nach openPersonInInfoPane-Event (z.B. aus Chat-Link)
  useEffect(() => {
    const onOpenPerson = (e: Event) => {
      const personId = Number((e as CustomEvent).detail?.personId || 0)
      if (!personId) return
      setOpen(true)
      setOpenFolder('alle')
      setQuery('')
      setSearchOpen(false)
      setJumpPersonId(personId)
      if (folders === null) load()
    }
    window.addEventListener('deck:open-person', onOpenPerson as EventListener)
    return () => window.removeEventListener('deck:open-person', onOpenPerson as EventListener)
  }, [folders, load])

  const activeFolder = useMemo(() => folders?.find(f => f.id === openFolder) || null, [folders, openFolder])
  const flatList = useMemo<PersonLite[]>(() => {
    if (!activeFolder) return []
    return activeFolder.customers.map(entryToLite)
  }, [activeFolder])
  const filteredList = useMemo(() => filterPeople(flatList, query), [flatList, query])
  const globalSearchHits = useMemo<PersonLite[]>(() => {
    if (!query.trim() || !folders) return []
    const all = folders.find(f => f.id === 'alle')
    if (!all) return []
    return filterPeople(all.customers.map(entryToLite), query)
  }, [folders, query])

  const folderCount = (id: string) => folders?.find(f => f.id === id)?.count ?? 0

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Users className="info-icon-md mr-2 text-[var(--t3)] flex-shrink-0" />
        <span className="text-[var(--t2)] font-medium">Personen</span>
        {open && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); load() }}
              className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 transition-opacity ${loading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
              title="Aktualisieren">
              <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setSearchOpen(v => { const next = !v; if (!next) setQuery(''); return next }) }}
              className={`ml-1 p-0.5 cursor-pointer flex-shrink-0 ${searchOpen ? 'text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t1)]'}`}
              title="Suchen">
              <Search className="info-icon-sm" />
            </button>
          </>
        )}
        <span className="flex-1" />
      </div>

      {open && (
        <div className="pb-2">
          <Guided>
          {loading && folders === null && (
            <div className="text-[var(--t3)]/60 info-text-meta py-2 pl-1">Lädt…</div>
          )}

          {folders && (
            <>
              {searchOpen && (
                <div className="py-1 pl-1 pr-3">
                  <div className="flex items-center gap-1.5 rounded-md bg-white/[0.04] border border-[var(--t3)]/15 px-2 py-1">
                    <Search className="info-icon-sm text-[var(--t3)]/60 flex-shrink-0" />
                    <input
                      type="text"
                      value={query}
                      autoFocus
                      onChange={e => setQuery(e.target.value)}
                      placeholder="Name, Firma, Telefon …"
                      className="flex-1 bg-transparent outline-none info-text-body text-[var(--t2)] placeholder:text-[var(--t3)]/40"
                    />
                    {query && (
                      <button
                        onClick={() => setQuery('')}
                        className="info-text-meta text-[var(--t3)]/60 hover:text-[var(--t1)] cursor-pointer">
                        ×
                      </button>
                    )}
                  </div>
                </div>
              )}

              {query.trim() ? (
                <Guided>
                  {globalSearchHits.length === 0 && (
                    <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">
                      Niemand passt zur Suche.
                    </div>
                  )}
                  {globalSearchHits.map(p => (
                    <PersonRow key={p.id} p={p} mobile={mobile} jumpId={jumpPersonId || undefined} />
                  ))}
                </Guided>
              ) : FOLDER_ORDER.map(fid => {
                const isActive = openFolder === fid
                const cnt = folderCount(fid)
                return (
                  <div key={fid}>
                    <button
                      onClick={() => {
                        if (isActive) {
                          playUISound('section-close')
                          setOpenFolder(null)
                        } else {
                          playUISound('section-open')
                          setOpenFolder(fid)
                        }
                      }}
                      className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                      <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isActive ? 'rotate-90' : ''}`} />
                      <Folder className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                      <span className="truncate flex-1 text-[var(--t2)]">{FOLDER_LABELS[fid]}</span>
                      {cnt > 0 && (
                        <span className="info-text-meta text-[var(--t3)]/60 tabular-nums flex-shrink-0 ml-2">{cnt}</span>
                      )}
                    </button>

                    {isActive && (fid === 'agent' && activeFolder?.firms ? (
                      <Guided>
                        {activeFolder.firms.map(firm => {
                          const firmOpen = openFirms[firm.id] ?? true
                          return (
                            <div key={firm.id}>
                              <button
                                onClick={() => { playUISound(firmOpen ? 'section-close' : 'section-open'); setOpenFirms(s => ({ ...s, [firm.id]: !firmOpen })) }}
                                className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                                <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${firmOpen ? 'rotate-90' : ''}`} />
                                <Building2 className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                                <span className="truncate flex-1 text-[var(--t2)]">{firm.label}</span>
                                <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{firm.count}</span>
                              </button>
                              {firmOpen && (
                                <Guided>
                                  {firm.people.map(e => (
                                    <PersonRow key={e.person_id} p={entryToLite(e)} mobile={mobile} jumpId={jumpPersonId || undefined} />
                                  ))}
                                </Guided>
                              )}
                            </div>
                          )
                        })}
                      </Guided>
                    ) : (
                      <Guided>
                        {filteredList.length === 0 && (
                          <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">
                            Niemand hier.
                          </div>
                        )}
                        {filteredList.map(p => (
                          <PersonRow key={p.id} p={p} mobile={mobile} jumpId={jumpPersonId || undefined} />
                        ))}
                      </Guided>
                    ))}
                  </div>
                )
              })}

              {/* Ohne Tag — Quick-Tagger nur sichtbar wenn es welche gibt */}
              {untaggedCount !== null && untaggedCount > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() => { playUISound(taggerOpen ? 'section-close' : 'section-open'); setTaggerOpen(v => !v) }}
                    className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                    <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${taggerOpen ? 'rotate-90' : ''}`} />
                    <Tag className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                    <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">Ohne Tag</span>
                    <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">{untaggedCount}</span>
                  </button>
                  {taggerOpen && <Guided><UntaggedTagger mobile={mobile} /></Guided>}
                </div>
              )}
            </>
          )}
          </Guided>
        </div>
      )}
    </div>
  )
}
