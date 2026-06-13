import { useEffect, useState, useCallback } from 'react'

// Mobile-Pipeline-Leseansicht für /fokus.
// Vertikaler Stream gruppiert nach Workshops/Agent/Leads.
// Tap auf Card öffnet Personen-Dossier-Sheet.
// Daten kommen aus /api/customers (gleiche Quelle wie Desktop-PipelineView).

type PipelineCard = {
  id: string
  label: string
  subtitle?: string
  person_ids: number[]
  attention?: boolean
  archived?: boolean
  value_eur?: number
  next_step_text?: string | null
  missing_next_step?: boolean
  ball?: 'me' | 'them' | 'idle' | string
  days_since_real_contact?: number | null
  last_real_contact_dir?: 'in' | 'out' | string | null
  last_real_contact_kind?: string | null
  last_interaction_ts?: number | null
  lost?: boolean
  lost_reason?: string | null
  lost_reason_label?: string | null
  lost_at?: number | null
}

type PipelineStage = {
  id: string
  label: string
  cards: PipelineCard[]
}

type PipelineStream = {
  id: string
  label: string
  stages: PipelineStage[]
  dropped?: PipelineCard[]
}

type PersonDetail = {
  id: number
  name: string
  phone?: string | null
  email?: string | null
  company?: string | null
  city?: string | null
  notes?: string | null
  relation?: string | null
  birthday?: string | null
  whatsapp_chat_id?: string | null
}

// Reihenfolge: Workshops, Agent, Leads (was Christian zuerst sieht).
const STREAM_ORDER = ['workshops', 'agent', 'leads']

const STREAM_ACCENT: Record<string, string> = {
  workshops: '#a37acf',
  agent: '#d97a5a',
  leads: '#4abca0',
}

const STREAM_LABELS: Record<string, string> = { leads: 'Leads', agent: 'AI-Agent', workshops: 'Workshops' }
// Erste Stufe je Ziel-Stream (für Übergabe). Stabil; bei Stage-Umbau hier mitziehen.
const STREAM_FIRST_STAGE: Record<string, string> = { leads: 'new', agent: 'angebot', workshops: 'anmeldung' }
// Kette: aus Leads an Workshop oder direkt Agent, aus Workshop weiter an Agent.
const HANDOFF_TARGETS: Record<string, string[]> = { leads: ['workshops', 'agent'], workshops: ['agent'], agent: [] }

function fmtEurShort(n: number | null | undefined): string {
  if (!n || n <= 0) return ''
  if (n >= 1000) {
    const k = n / 1000
    return (k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace('.', ',')) + 'k €'
  }
  return n + ' €'
}

function ballGlyph(ball?: string): { label: string; color: string } {
  if (ball === 'me') return { label: 'Du bist dran', color: 'var(--cc-orange)' }
  if (ball === 'them') return { label: 'Warten auf Antwort', color: 'var(--t3)' }
  if (ball === 'idle') return { label: 'Ruht', color: 'var(--t3)' }
  return { label: '', color: 'var(--t3)' }
}

function CardRow({ card, streamId, onOpen }: {
  card: PipelineCard
  streamId: string
  onOpen: (card: PipelineCard, streamId: string) => void
}) {
  const accent = STREAM_ACCENT[streamId] || 'var(--t1)'
  const b = ballGlyph(card.ball)
  const days = card.days_since_real_contact
  const daysLabel = days == null ? '' : days === 0 ? 'heute' : days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`
  const primaryPid = card.person_ids?.[0]
  return (
    <button
      onClick={() => primaryPid && onOpen(card, streamId)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        width: '100%',
        textAlign: 'left',
        padding: '12px 14px',
        background: 'transparent',
        border: 'none',
        borderTop: '1px solid color-mix(in srgb, var(--t3) 12%, transparent)',
        cursor: primaryPid ? 'pointer' : 'default',
        color: 'var(--t1)',
      }}
    >
      <span
        aria-hidden
        style={{
          marginTop: 6,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: card.attention ? 'var(--cc-orange)' : accent,
          opacity: card.attention ? 1 : 0.55,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-heading)',
            fontSize: 15,
            fontWeight: 500,
            color: 'var(--t1)',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {card.label}
          </div>
          {card.value_eur && card.value_eur > 0 ? (
            <span style={{
              flexShrink: 0,
              fontFamily: 'var(--font-body)',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--t1)',
              opacity: 0.6,
              fontVariantNumeric: 'tabular-nums',
            }}>{fmtEurShort(card.value_eur)}</span>
          ) : null}
        </div>
        {(b.label || daysLabel) && (
          <div style={{
            display: 'flex',
            gap: 10,
            marginTop: 4,
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--t1)',
            opacity: 0.6,
          }}>
            {b.label && <span style={{ color: b.color, opacity: 0.85 }}>{b.label}</span>}
            {b.label && daysLabel && <span style={{ opacity: 0.4 }}>·</span>}
            {daysLabel && <span>{daysLabel}</span>}
          </div>
        )}
        {card.next_step_text ? (
          <div style={{
            marginTop: 4,
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--t1)',
            opacity: 0.6,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            <span style={{ color: 'var(--cc-orange)', fontWeight: 600 }}>→ </span>{card.next_step_text}
          </div>
        ) : (streamId === 'leads' && card.missing_next_step) ? (
          <div style={{
            marginTop: 4,
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--cc-orange)',
          }}>○ Schritt fehlt</div>
        ) : null}
      </div>
    </button>
  )
}

function StageBlock({ stream, stage, onOpen }: {
  stream: PipelineStream
  stage: PipelineStage
  onOpen: (card: PipelineCard, streamId: string) => void
}) {
  const cards = stage.cards.filter(c => !c.archived)
  if (!cards.length) return null
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{
        padding: '8px 14px 4px',
        fontFamily: 'var(--font-body)',
        fontSize: 10.5,
        letterSpacing: '0.16em',
        fontWeight: 600,
        textTransform: 'uppercase',
        color: 'var(--t1)',
        opacity: 0.5,
      }}>
        {stage.label} <span style={{ opacity: 0.6 }}>· {cards.length}</span>
      </div>
      {cards.map(c => <CardRow key={c.id} card={c} streamId={stream.id} onOpen={onOpen} />)}
    </div>
  )
}

function StreamBlock({ stream, onOpen }: {
  stream: PipelineStream
  onOpen: (card: PipelineCard, streamId: string) => void
}) {
  const nonEmptyStages = stream.stages.filter(st => st.cards.some(c => !c.archived))
  const dropped = stream.dropped || []
  if (!nonEmptyStages.length && !dropped.length) return null
  const accent = STREAM_ACCENT[stream.id] || 'var(--t1)'
  const totalCards = nonEmptyStages.reduce((sum, st) => sum + st.cards.filter(c => !c.archived).length, 0)
  return (
    <section style={{ marginBottom: 18 }}>
      <header style={{
        position: 'sticky',
        top: 0,
        zIndex: 5,
        background: 'var(--bg)',
        padding: '14px 14px 10px',
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        borderBottom: '1px solid color-mix(in srgb, var(--t3) 14%, transparent)',
      }}>
        <span style={{
          width: 6, height: 16, borderRadius: 2, background: accent, alignSelf: 'center',
        }} />
        <h2 style={{
          fontFamily: 'var(--font-heading)',
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--t1)',
          margin: 0,
          letterSpacing: '-0.01em',
        }}>{stream.label}</h2>
        <span style={{
          fontFamily: 'var(--font-body)',
          fontSize: 12,
          color: 'var(--t1)',
          opacity: 0.5,
          marginLeft: 'auto',
        }}>{totalCards}</span>
      </header>
      {nonEmptyStages.map(st => <StageBlock key={st.id} stream={stream} stage={st} onOpen={onOpen} />)}
      {dropped.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{
            padding: '8px 14px 4px',
            fontFamily: 'var(--font-body)',
            fontSize: 10.5,
            letterSpacing: '0.16em',
            fontWeight: 600,
            textTransform: 'uppercase',
            color: 'var(--t1)',
            opacity: 0.4,
          }}>
            Abgelegt <span style={{ opacity: 0.6 }}>· {dropped.length}</span>
          </div>
          {dropped.map(c => (
            <button
              key={`drop-${c.id}`}
              onClick={() => c.person_ids?.[0] && onOpen(c, stream.id)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                width: '100%',
                textAlign: 'left',
                padding: '10px 14px',
                background: 'transparent',
                border: 'none',
                borderTop: '1px solid color-mix(in srgb, var(--t3) 12%, transparent)',
                cursor: 'pointer',
                color: 'var(--t1)',
                opacity: 0.6,
              }}
            >
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 500, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
              <span style={{ marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--t3)' }}>{c.lost_reason_label || 'Abgelegt'}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function PersonSheet({ card, streamId, onClose, onChanged }: {
  card: PipelineCard
  streamId: string
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const personId = card.person_ids[0]
  const [person, setPerson] = useState<PersonDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [showLost, setShowLost] = useState(false)

  const handoffTo = useCallback(async (target: string) => {
    if (!card.person_ids.length) return
    setActionBusy(true)
    try {
      if (streamId === 'leads') {
        // Bedarf-Weiche: Lead verlässt den Trichter, landet im Zielstream.
        await Promise.all(card.person_ids.map(pid =>
          fetch('/api/customers/handoff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: pid, target }),
          })
        ))
      } else {
        const stage = STREAM_FIRST_STAGE[target]
        if (!stage) { setActionBusy(false); return }
        await Promise.all(card.person_ids.map(pid =>
          fetch('/api/customers/stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: pid, stream: target, stage, from_stream: streamId }),
          })
        ))
      }
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, streamId, onChanged, onClose])

  const removeFromBoard = useCallback(async () => {
    if (!card.person_ids.length) return
    const who = card.subtitle || card.label
    if (!confirm(`${who} aus „${STREAM_LABELS[streamId] || streamId}" entfernen? Bleibt in der Datenbank.`)) return
    setActionBusy(true)
    try {
      await Promise.all(card.person_ids.map(pid =>
        fetch('/api/customers/membership/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream: streamId }),
        })
      ))
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, card.subtitle, card.label, streamId, onChanged, onClose])

  const markLost = useCallback(async (reason: string) => {
    if (!card.person_ids.length) return
    setActionBusy(true)
    try {
      await Promise.all(card.person_ids.map(pid =>
        fetch('/api/customers/membership/lost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream: streamId, reason }),
        })
      ))
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, streamId, onChanged, onClose])

  const reactivate = useCallback(async () => {
    if (!card.person_ids.length) return
    setActionBusy(true)
    try {
      await Promise.all(card.person_ids.map(pid =>
        fetch('/api/customers/membership/reactivate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: pid, stream: streamId }),
        })
      ))
      await onChanged()
      onClose()
    } catch (e) { console.error(e) } finally { setActionBusy(false) }
  }, [card.person_ids, streamId, onChanged, onClose])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/people/get?id=${encodeURIComponent(String(personId))}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text())
        return r.json()
      })
      .then(d => {
        if (cancelled) return
        setPerson(d.person || null)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(String(e).slice(0, 160))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [personId])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          padding: '14px 18px 28px',
          maxHeight: '85vh',
          overflowY: 'auto',
          color: 'var(--t1)',
          boxShadow: '0 -12px 32px rgba(0,0,0,0.45)',
        }}
      >
        <div
          aria-hidden
          style={{
            width: 36, height: 4, borderRadius: 2,
            background: 'color-mix(in srgb, var(--t3) 40%, transparent)',
            margin: '0 auto 16px',
          }}
        />
        {loading && (
          <div style={{ padding: '32px 0', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 14, opacity: 0.5 }}>
            Lade…
          </div>
        )}
        {error && !loading && (
          <div style={{ padding: '16px 0', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--cc-orange)' }}>
            {error}
          </div>
        )}
        {person && !loading && (
          <>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 500, lineHeight: 1.2 }}>
              {person.name}
            </div>
            {(person.company || person.city) && (
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, opacity: 0.6, marginTop: 4 }}>
                {[person.company, person.city].filter(Boolean).join(' · ')}
              </div>
            )}
            <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {person.phone && (
                <a
                  href={`tel:${person.phone}`}
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: 15,
                    color: 'var(--t1)',
                    textDecoration: 'none',
                    padding: '10px 12px',
                    background: 'var(--bg-2)',
                    borderRadius: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>{person.phone}</span>
                  <span style={{ fontSize: 11, opacity: 0.5, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Anrufen</span>
                </a>
              )}
              {person.email && (
                <a
                  href={`mailto:${person.email}`}
                  style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: 15,
                    color: 'var(--t1)',
                    textDecoration: 'none',
                    padding: '10px 12px',
                    background: 'var(--bg-2)',
                    borderRadius: 10,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{person.email}</span>
                  <span style={{ fontSize: 11, opacity: 0.5, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Mail</span>
                </a>
              )}
            </div>
            {person.notes && (
              <div style={{ marginTop: 18 }}>
                <div style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 10.5,
                  letterSpacing: '0.16em',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  color: 'var(--t1)',
                  opacity: 0.5,
                  marginBottom: 6,
                }}>Notiz</div>
                <div style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  color: 'var(--t1)',
                  opacity: 0.85,
                }}>{person.notes}</div>
              </div>
            )}
            {(HANDOFF_TARGETS[streamId] || []).length > 0 && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(HANDOFF_TARGETS[streamId] || []).map(target => (
                  <button
                    key={`ho-${target}`}
                    disabled={actionBusy}
                    onClick={() => handoffTo(target)}
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      background: 'transparent',
                      border: '1px solid var(--accent)',
                      borderRadius: 10,
                      color: 'var(--accent)',
                      fontFamily: 'var(--font-body)',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: actionBusy ? 0.5 : 1,
                    }}
                  >→ An {STREAM_LABELS[target] || target} übergeben</button>
                ))}
              </div>
            )}
            {card.lost ? (
              <button
                disabled={actionBusy}
                onClick={reactivate}
                style={{
                  marginTop: 12,
                  width: '100%',
                  padding: '12px 14px',
                  background: 'transparent',
                  border: '1px solid var(--accent)',
                  borderRadius: 10,
                  color: 'var(--accent)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: actionBusy ? 0.5 : 1,
                }}
              >↩ Zurück in die Pipeline</button>
            ) : showLost ? (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t1)', opacity: 0.5 }}>Grund fürs Ablegen</div>
                {[{ key: 'nicht_gemeldet', label: 'Nicht gemeldet' }, { key: 'abgesagt', label: 'Abgesagt' }, { key: 'kein_bedarf', label: 'Kein Bedarf' }].map(opt => (
                  <button
                    key={`lost-${opt.key}`}
                    disabled={actionBusy}
                    onClick={() => markLost(opt.key)}
                    style={{
                      width: '100%',
                      padding: '11px 14px',
                      background: 'var(--bg-2)',
                      border: '1px solid color-mix(in srgb, var(--t3) 22%, transparent)',
                      borderRadius: 10,
                      color: 'var(--cc-orange)',
                      fontFamily: 'var(--font-body)',
                      fontSize: 14,
                      cursor: 'pointer',
                      opacity: actionBusy ? 0.5 : 1,
                    }}
                  >{opt.label}</button>
                ))}
                <button
                  onClick={() => setShowLost(false)}
                  style={{ padding: '8px', background: 'transparent', border: 'none', color: 'var(--t3)', fontFamily: 'var(--font-body)', fontSize: 13, cursor: 'pointer' }}
                >Abbrechen</button>
              </div>
            ) : (
              <button
                disabled={actionBusy}
                onClick={() => setShowLost(true)}
                style={{
                  marginTop: 12,
                  width: '100%',
                  padding: '11px 14px',
                  background: 'transparent',
                  border: '1px solid color-mix(in srgb, var(--t3) 22%, transparent)',
                  borderRadius: 10,
                  color: 'var(--cc-orange)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 13,
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                  opacity: actionBusy ? 0.5 : 1,
                }}
              >Als verloren ablegen</button>
            )}
            {!card.lost && !showLost ? (
              <button
                disabled={actionBusy}
                onClick={removeFromBoard}
                style={{
                  marginTop: 8,
                  width: '100%',
                  padding: '10px 14px',
                  background: 'transparent',
                  border: '1px solid color-mix(in srgb, var(--t3) 22%, transparent)',
                  borderRadius: 10,
                  color: 'var(--t3)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 12.5,
                  letterSpacing: '0.04em',
                  cursor: 'pointer',
                  opacity: actionBusy ? 0.5 : 1,
                }}
              >Ganz aus {STREAM_LABELS[streamId] || streamId} entfernen</button>
            ) : null}
            <button
              onClick={() => { window.location.href = `/mobile?openPerson=${personId}` }}
              style={{
                marginTop: 12,
                width: '100%',
                padding: '12px 14px',
                background: 'transparent',
                border: '1px solid color-mix(in srgb, var(--t3) 22%, transparent)',
                borderRadius: 10,
                color: 'var(--t1)',
                fontFamily: 'var(--font-body)',
                fontSize: 13,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              Volles Dossier öffnen
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function MobilePipeline() {
  const [streams, setStreams] = useState<PipelineStream[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openCard, setOpenCard] = useState<{ card: PipelineCard; streamId: string } | null>(null)

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/customers')
      const d = await r.json()
      if (Array.isArray(d.pipeline)) {
        const sorted = [...d.pipeline].sort((a: PipelineStream, b: PipelineStream) => {
          const ia = STREAM_ORDER.indexOf(a.id)
          const ib = STREAM_ORDER.indexOf(b.id)
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
        })
        setStreams(sorted)
      } else {
        setErr('Keine Daten')
      }
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  if (err) return (
    <div style={{ padding: 24, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--t1)', opacity: 0.6 }}>
      Fehler: {err}
    </div>
  )
  if (!streams) return (
    <div style={{ padding: 24, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--t1)', opacity: 0.5, fontStyle: 'italic' }}>
      Lade Pipeline…
    </div>
  )

  return (
    <div style={{ paddingBottom: 24 }}>
      {streams.map(s => (
        <StreamBlock key={s.id} stream={s} onOpen={(card, streamId) => setOpenCard({ card, streamId })} />
      ))}
      {openCard != null && (
        <PersonSheet
          card={openCard.card}
          streamId={openCard.streamId}
          onClose={() => setOpenCard(null)}
          onChanged={reload}
        />
      )}
    </div>
  )
}
