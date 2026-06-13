import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Check, Clock, Newspaper, Pencil, Play, RefreshCw, Save, Send, Trash2, X, Zap } from 'lucide-react'

type RedStep = {
  step_key: string
  label: string
  status: string
  summary: string
  ts?: number
}

type RedDraft = {
  idx: number
  title?: string
  ref?: string
  body: string
  ping?: string
  kind?: string
  words?: number
  warnings?: string[]
  source_note?: string
  status?: string
  run_id?: string
  run_created_at?: number
}

type RedRun = {
  id: string
  status: string
  created_at?: number
  steps?: RedStep[]
  result?: {
    items?: RedDraft[]
    ready?: boolean
  }
}

type QueueEntry = {
  id: string
  run_id: string
  idx: number
  title?: string
  ref?: string
  body: string
  ping?: string
  kind?: string
  source_note?: string
  queued_at?: number
}

type QueueSnapshot = {
  queue: QueueEntry[]
  count: number
  last_dispatch: string
  interval_days: number
  due: boolean
  next_slot: string
  pending: RedDraft[]
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
}

async function postJSON(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || 'Aktion fehlgeschlagen')
  return data
}

function Stat({ label, value, warm }: { label: string; value: string | number; warm?: boolean }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] text-[var(--t3)]">{label}</div>
      <div className={`truncate text-sm font-medium tabular-nums ${warm ? 'text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>{value}</div>
    </section>
  )
}

// ── Wartender Entwurf: Freigeben (in Queue), Sofort senden, Bearbeiten, Verwerfen ──
function DraftCard({ draft, onChanged }: { draft: RedDraft; onChanged: () => void }) {
  const runId = draft.run_id || ''
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'now' | 'discard' | 'edit' | ''>('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState(draft.body || '')
  const warnings = draft.warnings || []
  const blocked = draft.status === 'blocked' || !draft.body
  const title = draft.title || 'Pioniere-Post'

  const act = useCallback(async (mode: 'approve' | 'now' | 'discard', url: string) => {
    setBusy(mode)
    setError('')
    try {
      await postJSON(url, { run_id: runId, idx: draft.idx })
      setConfirming(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }, [draft.idx, onChanged, runId])

  const saveEdit = useCallback(async () => {
    setBusy('edit')
    setError('')
    try {
      await postJSON('/api/pioniere/edit', { run_id: runId, idx: draft.idx, body: draftText })
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }, [draftText, draft.idx, onChanged, runId])

  return (
    <article className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex items-start gap-2 border-b border-[var(--border)] px-3 py-2">
        {blocked ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cc-orange)]" /> : <Newspaper className="mt-0.5 h-4 w-4 shrink-0 text-[var(--cc-orange)]" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--t1)]">{title}</div>
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--t3)]">
            {draft.ref && <span className="shrink-0 rounded bg-white/[0.05] px-1 font-mono tabular-nums">#{draft.ref}</span>}
            <span className="truncate">{draft.source_note || `${draft.words ?? 0} Wörter`}</span>
            <span className="shrink-0">· {fmtAge(draft.run_created_at)}</span>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-[var(--t3)]">{blocked ? 'offen' : 'wartet'}</span>
      </div>
      {editing ? (
        <div className="px-3 py-3">
          <textarea
            value={draftText}
            onChange={e => setDraftText(e.target.value)}
            rows={10}
            autoFocus
            className="w-full resize-y border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm leading-6 text-[var(--t1)] outline-none focus:border-[var(--cc-orange)]"
          />
          <div className="mt-1 text-[11px] text-[var(--t3)]">{draftText.trim().split(/\s+/).filter(Boolean).length} Wörter</div>
        </div>
      ) : (
        <div className="max-h-[36vh] overflow-auto px-3 py-3 text-sm leading-6 text-[var(--t2)] whitespace-pre-wrap">{draft.body || 'Kein Entwurf'}</div>
      )}
      {warnings.length > 0 && <div className="px-3 pb-2 text-[11px] leading-5 text-[var(--cc-orange)]">{warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
      {error && <div className="px-3 pb-2 text-[11px] text-[var(--cc-orange)]">{error}</div>}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-3 py-2">
        {editing ? (
          <>
            <button type="button" onClick={saveEdit} disabled={busy !== '' || !draftText.trim()} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-40">
              <Save className={busy === 'edit' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Speichern
            </button>
            <button type="button" onClick={() => { setEditing(false); setError('') }} disabled={busy !== ''} className="px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)]">Abbrechen</button>
          </>
        ) : confirming ? (
          <>
            <span className="text-[11px] text-[var(--cc-orange)]">In die Versand-Queue legen?</span>
            <button type="button" onClick={() => act('approve', '/api/pioniere/approve')} disabled={busy !== ''} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-60">
              <Check className={busy === 'approve' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Ja, freigeben
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)]">Abbrechen</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setConfirming(true)} disabled={blocked || busy !== ''} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-40">
              <Check className="h-3.5 w-3.5" /> Freigeben
            </button>
            <button type="button" onClick={() => act('now', '/api/pioniere/publish-now')} disabled={blocked || busy !== ''} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-40" title="Sofort posten, ohne auf den Takt zu warten">
              <Zap className={busy === 'now' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Sofort senden
            </button>
            <button type="button" onClick={() => { setDraftText(draft.body || ''); setError(''); setEditing(true) }} disabled={busy !== ''} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-50">
              <Pencil className="h-3.5 w-3.5" /> Bearbeiten
            </button>
            <button type="button" onClick={() => act('discard', '/api/pioniere/discard')} disabled={busy !== ''} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-50">
              <X className={busy === 'discard' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Verwerfen
            </button>
          </>
        )}
      </div>
    </article>
  )
}

// ── Freigegebener Eintrag in der Versand-Queue: Reihenfolge, Sofort senden, raus ──
function QueueCard({ entry, index, total, onMove, onChanged }: {
  entry: QueueEntry
  index: number
  total: number
  onMove: (id: string, dir: -1 | 1) => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<'now' | 'remove' | ''>('')
  const [error, setError] = useState('')

  const sendNow = useCallback(async () => {
    setBusy('now'); setError('')
    try {
      await postJSON('/api/pioniere/publish-now', { run_id: entry.run_id, idx: entry.idx })
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }, [entry.run_id, entry.idx, onChanged])

  const remove = useCallback(async () => {
    setBusy('remove'); setError('')
    try {
      await postJSON('/api/pioniere/queue/remove', { id: entry.id })
      onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }, [entry.id, onChanged])

  return (
    <article className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="flex flex-col items-center gap-0.5 pt-0.5">
          <button type="button" onClick={() => onMove(entry.id, -1)} disabled={index === 0} className="text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-25" title="Früher senden"><ArrowUp className="h-3.5 w-3.5" /></button>
          <span className="text-[11px] font-mono tabular-nums text-[var(--t3)]">{index + 1}</span>
          <button type="button" onClick={() => onMove(entry.id, 1)} disabled={index === total - 1} className="text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-25" title="Später senden"><ArrowDown className="h-3.5 w-3.5" /></button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--t1)]">{entry.title || 'Pioniere-Post'}</div>
          <div className="mt-1 max-h-[18vh] overflow-auto text-[13px] leading-6 text-[var(--t2)] whitespace-pre-wrap">{entry.body}</div>
          {error && <div className="mt-1 text-[11px] text-[var(--cc-orange)]">{error}</div>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={sendNow} disabled={busy !== ''} className="inline-flex items-center gap-1 border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-50" title="Sofort posten, ohne auf den Takt zu warten">
              <Zap className={busy === 'now' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Sofort senden
            </button>
            <button type="button" onClick={remove} disabled={busy !== ''} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[var(--t3)] hover:text-[var(--t1)] disabled:opacity-50" title="Aus der Queue nehmen (zurück in den Stapel ist nicht nötig, Entwurf bleibt im Lauf)">
              <Trash2 className={busy === 'remove' ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} /> Aus Queue nehmen
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

export function PioniereWorkspace() {
  const [runs, setRuns] = useState<RedRun[]>([])
  const [snap, setSnap] = useState<QueueSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [planning, setPlanning] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [runsRes, qRes] = await Promise.all([
        fetch('/api/pioniere/runs?limit=12', { cache: 'no-store' }),
        fetch('/api/pioniere/queue', { cache: 'no-store' }),
      ])
      const runsData = await runsRes.json().catch(() => ({}))
      const qData = await qRes.json().catch(() => ({}))
      if (!runsRes.ok || runsData.error) throw new Error(runsData.error || 'Pionierplaner nicht erreichbar')
      setRuns(Array.isArray(runsData.runs) ? runsData.runs : [])
      setSnap(qData && qData.ok ? qData as QueueSnapshot : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [])

  const plan = useCallback(async () => {
    setPlanning(true); setError(''); setNote('')
    try {
      const res = await fetch('/api/pioniere/run', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) throw new Error(data.error || 'Anstoß fehlgeschlagen')
      setNote('Planung läuft im Hintergrund, neue Entwürfe erscheinen in ein bis zwei Minuten.')
      window.setTimeout(load, 30000)
      window.setTimeout(load, 75000)
      window.setTimeout(load, 120000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanning(false)
    }
  }, [load])

  const move = useCallback(async (id: string, dir: -1 | 1) => {
    if (!snap) return
    const ids = snap.queue.map(e => e.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    // optimistisch umsortieren
    const reordered = ids.map(x => snap.queue.find(e => e.id === x)!).filter(Boolean)
    setSnap({ ...snap, queue: reordered })
    try {
      await postJSON('/api/pioniere/queue/reorder', { order: ids })
    } catch { load() }
  }, [snap, load])

  useEffect(() => { load() }, [load])

  const pending = useMemo(() => snap?.pending || [], [snap])
  const queue = useMemo(() => snap?.queue || [], [snap])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Agent · Pioniere-Community</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">Pionierplaner</h2>
            <div className="truncate text-xs text-[var(--t3)]">Täglich sammeln, du gibst frei, der Versand läuft getaktet von selbst.</div>
          </div>
          <button type="button" onClick={plan} disabled={planning} className="shrink-0 inline-flex items-center gap-1 border border-[var(--border)] px-2 py-2 text-[11px] text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-60" title="Jetzt Entwürfe planen lassen">
            <Play className={planning ? 'h-4 w-4 animate-pulse' : 'h-4 w-4'} /> {planning ? 'Plant…' : 'Jetzt planen'}
          </button>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          <Stat label="Wartet auf dich" value={pending.length} warm={pending.length > 0} />
          <Stat label="In Versand-Queue" value={queue.length} />
          <Stat label="Nächster Versand" value={snap?.next_slot || '—'} />
        </div>
        {error && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--warm)]">{error}</div>}
        {note && !error && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--t2)]">{note}</div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {/* Zone 1: Wartet auf dich */}
        <div className="mb-2 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--t3)]">
          <Newspaper className="h-3.5 w-3.5" /> Wartet auf dich
        </div>
        {pending.length > 0 ? (
          <div className="grid gap-3">
            {pending.map(item => <DraftCard key={`${item.run_id}:${item.idx}`} draft={item} onChanged={load} />)}
          </div>
        ) : (
          <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-4 text-sm text-[var(--t3)]">
            {loading ? 'Lade Stapel' : 'Kein Entwurf wartet.'}
          </section>
        )}

        {/* Zone 2: Versand-Queue */}
        <div className="mb-2 mt-5 flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--t3)]">
          <Send className="h-3.5 w-3.5" /> Versand-Queue
          {snap && <span className="font-normal normal-case tracking-normal text-[var(--t3)]">· alle {snap.interval_days} Tage einer · {snap.next_slot}</span>}
        </div>
        {queue.length > 0 ? (
          <div className="grid gap-3">
            {queue.map((entry, i) => (
              <QueueCard key={entry.id} entry={entry} index={i} total={queue.length} onMove={move} onChanged={load} />
            ))}
          </div>
        ) : (
          <section className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-4 text-sm text-[var(--t3)]">
            <Clock className="h-4 w-4" /> Nichts freigegeben. Was du oben freigibst, reiht sich hier ein.
          </section>
        )}

        {/* Zone 3: Frühere Läufe */}
        {runs.length > 0 && (
          <section className="mt-5 rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
            <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--t3)]">Frühere Läufe</div>
            <div className="divide-y divide-[var(--border)]">
              {runs.map(run => {
                const posted = (run.steps || []).some(s => s.step_key.startsWith('posted_') && s.status === 'ok')
                const items = run.result?.items || []
                return (
                  <div key={run.id} className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${run.status === 'error' ? 'bg-[var(--cc-orange)]' : posted ? 'bg-[var(--green)]' : 'bg-[var(--t3)]'}`} />
                    <span className="min-w-0 flex-1 truncate text-[var(--t2)]">{items[0]?.title || `${items.length} Entwurf`}{items.length > 1 ? ` +${items.length - 1}` : ''}</span>
                    <span className="shrink-0 text-[11px] text-[var(--t3)]">{fmtAge(run.created_at)}</span>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
