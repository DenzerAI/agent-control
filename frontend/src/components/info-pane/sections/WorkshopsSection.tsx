import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, GraduationCap, RefreshCw, FolderOpen, FolderClosed, UserRound } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { useEingangCounts, markSectionSeen } from '../../../eingang'
import { fmtRelTs } from '../utils/relTs'
import { Guided } from '../utils/tree'

// ── Workshops — Anmeldungen und Teilnehmerlisten pro Runde ──

type WorkshopRegistration = {
  name: string; email: string; phone: string; company: string;
  tools: string[]; level: string; message: string;
  ts: string; seat: number | null; waitlist: boolean;
  confirmation_sent?: boolean; confirmation_sent_at?: string | null
}

type WorkshopParticipant = {
  token: string; name: string; company: string; branche: string;
  has_feedback: boolean; has_booking: boolean;
  network_interest: 'ja' | 'vielleicht' | 'nein' | null
}

type WorkshopCancellation = WorkshopRegistration & {
  cancelled_at?: string
  cancelled_source?: string
}

type WorkshopRound = {
  id: string; label: string; subtitle: string; status: 'open' | 'done';
  total_seats: number; taken: number; remaining: number;
  registrations?: WorkshopRegistration[]
  cancellations?: WorkshopCancellation[]
  participants?: WorkshopParticipant[]
}

export function WorkshopsSection({ mobile }: { mobile?: boolean }) {
  const [rounds, setRounds] = useState<WorkshopRound[] | null>(null)
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:workshopsOpen') === '1' } catch { return false }
  })
  const [openRounds, setOpenRounds] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('infopane:workshopsRoundsOpen') || '{}') } catch { return {} }
  })
  const [openItems, setOpenItems] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('infopane:workshopsItemsOpen') || '{}') } catch { return {} }
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const eingang = useEingangCounts()
  const workshopsOrange = eingang.workshops > 0

  const load = useCallback((refresh = false) => {
    setLoading(true); setError(null)
    fetch(`/api/workshops${refresh ? '?refresh=1' : ''}`)
      .then(r => r.json())
      .then(d => { setRounds(d.rounds || []); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  useEffect(() => { if (open && rounds === null) load(false) }, [open, rounds, load])
  useEffect(() => { try { localStorage.setItem('infopane:workshopsOpen', open ? '1' : '0') } catch {} }, [open])
  useEffect(() => { if (open && workshopsOrange) markSectionSeen('workshops') }, [open, workshopsOrange])
  useEffect(() => { try { localStorage.setItem('infopane:workshopsRoundsOpen', JSON.stringify(openRounds)) } catch {} }, [openRounds])
  useEffect(() => { try { localStorage.setItem('infopane:workshopsItemsOpen', JSON.stringify(openItems)) } catch {} }, [openItems])

  const toggleRound = (id: string) => setOpenRounds(o => ({ ...o, [id]: !o[id] }))
  const toggleItem = (key: string) => setOpenItems(o => ({ ...o, [key]: !o[key] }))

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <GraduationCap className={`info-icon-md mr-2 flex-shrink-0 ${workshopsOrange ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <span className="text-[var(--t2)] font-medium">Workshops</span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); load(true) }}
            className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0 transition-opacity ${loading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            title="Aktualisieren">
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
        <span className="flex-1" />
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
            {error && <div className="text-[var(--t3)] info-text-meta py-2 pl-1">Fehler: {error}</div>}
            {loading && rounds === null && <div className="text-[var(--t3)]/60 info-text-meta py-2 pl-1">Lädt…</div>}
            {rounds?.map(round => {
              const isOpen = openRounds[round.id] ?? false
              const FolderIcon = isOpen ? FolderOpen : FolderClosed
              return (
                <div key={round.id}>
                  <button
                    onClick={() => { playUISound(isOpen ? 'section-close' : 'section-open'); toggleRound(round.id) }}
                    className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                    <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${isOpen ? 'rotate-90' : ''}`} />
                    <FolderIcon className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                    <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">{round.label}</span>
                    <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 ml-2">
                      {round.taken}/{round.total_seats}
                    </span>
                  </button>
                  {isOpen && (
                    <Guided>
                      {round.subtitle && (
                        <div className="info-text-meta text-[var(--t3)]/60 py-1 pl-1 pr-3">
                          {round.subtitle}
                        </div>
                      )}
                      {round.status === 'open' && (round.registrations || []).map((r, i) => {
                        const key = `${round.id}:${i}`
                        const itemOpen = !!openItems[key]
                        return (
                          <div key={key}>
                            <button
                              onClick={() => { playUISound(itemOpen ? 'section-close' : 'section-open'); toggleItem(key) }}
                              className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                              <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${itemOpen ? 'rotate-90' : ''}`} />
                              <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                              <span
                                className="inline-block w-1.5 h-1.5 rounded-full mr-2 flex-shrink-0"
                                style={{ backgroundColor: r.confirmation_sent ? 'var(--green)' : 'var(--t3)', opacity: r.confirmation_sent ? 0.9 : 0.4 }}
                                title={r.confirmation_sent
                                  ? `Bestätigung versendet${r.confirmation_sent_at ? ' · ' + fmtRelTs(r.confirmation_sent_at) : ''}`
                                  : 'Bestätigung steht noch aus'}
                              />
                              <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">
                                {r.name || '(ohne Name)'}
                                {r.waitlist && <span className="ml-1 text-[var(--red)]/80 info-text-meta">·Warte</span>}
                              </span>
                              <span className="info-text-meta text-[var(--t3)]/50 tabular-nums flex-shrink-0 ml-2">{fmtRelTs(r.ts)}</span>
                            </button>
                            {itemOpen && (
                              <Guided>
                                <div className="info-text-meta text-[var(--t3)]/80 pb-2 pl-1 pr-3 space-y-0.5">
                                  {r.company && <div className="text-[var(--t2)]/90">{r.company}</div>}
                                  {r.email && <div><a href={`mailto:${r.email}`} className="hover:text-[var(--t1)]">{r.email}</a></div>}
                                  {r.phone && <div><a href={`tel:${r.phone}`} className="hover:text-[var(--t1)]">{r.phone}</a></div>}
                                  {r.level && <div>Level: {r.level}</div>}
                                  {r.tools && r.tools.length > 0 && <div>Tools: {r.tools.join(', ')}</div>}
                                  {r.seat != null && <div>Platz: {r.seat}</div>}
                                  {r.message && <div className="text-[var(--t3)]/70 italic mt-1">„{r.message}"</div>}
                                </div>
                              </Guided>
                            )}
                          </div>
                        )
                      })}
                      {round.status === 'open' && (round.registrations || []).length === 0 && (
                        <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Noch keine Anmeldungen.</div>
                      )}
                      {round.status === 'open' && (round.cancellations || []).length > 0 && (
                        <>
                          <div className="info-text-meta text-[var(--t3)]/60 pt-2 pb-1 pl-1 pr-3 uppercase tracking-wide">
                            Abgesagt ({(round.cancellations || []).length})
                          </div>
                          {(round.cancellations || []).map((c, i) => {
                            const key = `${round.id}:cancel:${i}`
                            const itemOpen = !!openItems[key]
                            return (
                              <div key={key}>
                                <button
                                  onClick={() => { playUISound(itemOpen ? 'section-close' : 'section-open'); toggleItem(key) }}
                                  className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors opacity-60`}>
                                  <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${itemOpen ? 'rotate-90' : ''}`} />
                                  <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                                  <span className="truncate flex-1 text-[var(--t2)] line-through">
                                    {c.name || '(ohne Name)'}
                                  </span>
                                  <span className="info-text-meta text-[var(--cc-orange)]/70 ml-2 flex-shrink-0">abgesagt</span>
                                </button>
                                {itemOpen && (
                                  <Guided>
                                    <div className="info-text-meta text-[var(--t3)]/80 pb-2 pl-1 pr-3 space-y-0.5">
                                      {c.company && <div className="text-[var(--t2)]/90">{c.company}</div>}
                                      {c.email && <div><a href={`mailto:${c.email}`} className="hover:text-[var(--t1)]">{c.email}</a></div>}
                                      {c.phone && <div><a href={`tel:${c.phone}`} className="hover:text-[var(--t1)]">{c.phone}</a></div>}
                                      {c.cancelled_at && <div className="text-[var(--t3)]/70">Absage: {fmtRelTs(c.cancelled_at)}</div>}
                                    </div>
                                  </Guided>
                                )}
                              </div>
                            )
                          })}
                        </>
                      )}
                      {round.status === 'done' && (round.participants || []).map((p, i) => {
                        const key = `${round.id}:${i}`
                        const itemOpen = !!openItems[key]
                        const badges: string[] = []
                        if (p.has_feedback) badges.push('Feedback')
                        if (p.has_booking) badges.push('Termin')
                        if (p.network_interest === 'ja') badges.push('Netzwerk: ja')
                        else if (p.network_interest === 'vielleicht') badges.push('Netzwerk: vielleicht')
                        else if (p.network_interest === 'nein') badges.push('Netzwerk: nein')
                        return (
                          <div key={key}>
                            <button
                              onClick={() => { playUISound(itemOpen ? 'section-close' : 'section-open'); toggleItem(key) }}
                              className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2' : 'py-[5px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] transition-colors`}>
                              <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${itemOpen ? 'rotate-90' : ''}`} />
                              <UserRound className="info-icon-sm mr-2 text-[var(--t3)] flex-shrink-0" />
                              <span className="truncate flex-1 text-[var(--t2)] hover:text-[var(--t1)]">{p.name || '(ohne Name)'}</span>
                            </button>
                            {itemOpen && (
                              <Guided>
                                <div className="info-text-meta text-[var(--t3)]/80 pb-2 pl-1 pr-3 space-y-0.5">
                                  {p.company && <div className="text-[var(--t2)]/90">{p.company}{p.branche && ` · ${p.branche}`}</div>}
                                  {badges.length > 0 && <div>{badges.join(' · ')}</div>}
                                </div>
                              </Guided>
                            )}
                          </div>
                        )
                      })}
                      {round.status === 'done' && (round.participants || []).length === 0 && (
                        <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Keine Teilnehmer.</div>
                      )}
                    </Guided>
                  )}
                </div>
              )
            })}
            {rounds && rounds.length === 0 && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Keine Runden gefunden.</div>}
          </Guided>
        </div>
      )}
    </div>
  )
}
