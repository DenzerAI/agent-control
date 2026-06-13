import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileText, RefreshCw, ScrollText, Search, UserRound } from 'lucide-react'

type Meeting = {
  id: string
  date: string
  title: string
  has_transcript: boolean
  transcript_preview?: string
  transcript_path?: string
  person_label?: string
  chat_title?: string
  extract_status?: string
  has_extract?: boolean
}

const CACHE_KEY = 'workspace:meetings:list'

function readCache(): Meeting[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) as Meeting[] : []
  } catch { return [] }
}

function writeCache(meetings: Meeting[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(meetings)) } catch {}
}

function openTranscript(meeting: Meeting) {
  const path = meeting.transcript_path || `jobs/meetings/data/${meeting.id}/transcript.md`
  window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path } }))
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] text-[var(--t3)]">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-[var(--t1)]">{value}</div>
    </section>
  )
}

export function MeetingsWorkspace() {
  const [meetings, setMeetings] = useState<Meeting[]>(() => readCache())
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/meetings', { cache: 'no-store' })
      const data = await res.json()
      const next = Array.isArray(data.meetings) ? data.meetings as Meeting[] : []
      setMeetings(next)
      writeCache(next)
    } catch (e) {
      setError(`Meetings gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return meetings
    return meetings.filter(m => [m.title, m.date, m.person_label, m.chat_title, m.transcript_preview]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q))
  }, [meetings, query])

  const transcriptCount = meetings.filter(m => m.has_transcript).length
  const extractCount = meetings.filter(m => m.has_extract || m.extract_status === 'ok').length

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Meetings · Transkripte</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{meetings.length ? `${meetings.length} Meetings` : 'Meetings'}</h2>
            <div className="truncate text-xs text-[var(--t3)]">Aufnahmen, Transkripte und Extrakte</div>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Alle" value={meetings.length} />
          <Stat label="Transkripte" value={transcriptCount} />
          <Stat label="Extrakte" value={extractCount} />
        </div>
        {error && <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <label className="mb-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Meeting, Person oder Chat suchen" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]" />
        </label>

        <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <FileText className="h-4 w-4 text-[var(--t3)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">Letzte Meetings</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{visible.length}</span>
          </div>
          {visible.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Meetings' : 'Keine Meetings.'}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {visible.map(meeting => (
                <button key={meeting.id} type="button" onClick={() => openTranscript(meeting)} className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left hover:bg-white/[0.04]">
                  <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t3)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--t1)]">{meeting.title}</span>
                    <span className="block truncate text-xs text-[var(--t3)]">{[meeting.person_label, meeting.chat_title, meeting.date].filter(Boolean).join(' · ') || meeting.date}</span>
                    {meeting.transcript_preview && <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--t3)]">{meeting.transcript_preview}</span>}
                  </span>
                  {meeting.person_label && <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--warm)]" />}
                  <span className="shrink-0 text-[11px] text-[var(--t3)]">{meeting.has_extract || meeting.extract_status === 'ok' ? 'Extrakt' : meeting.has_transcript ? 'Text' : 'offen'}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
