import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Eye, Moon, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react'

const READ_KEY = 'klaus.dreaming.latestReadMtime'
const CACHE_KEY = 'workspace:dreaming:lastState'

type DreamEntry = {
  name: string
  relativePath: string
  mtime: number
  text: string
  summary: string
  tonus: string
}

type DreamCandidate = {
  id: string
  kind: string
  title: string
  body: string
  score: number
  frequency: number
  promoted: boolean
  status: string
  source: string
  evidenceSources: string[]
  why: string
}

type DreamingInfo = {
  ok: boolean
  module: { current: string; future: string; benefit: string }
  automation: { nightly: string; nap: string; weeklyDeep: string; review: string }
  latestNight: DreamEntry | null
  latestNap: DreamEntry | null
  threads: { counts: Record<string, number>; relativePath: string; summary: string }
  sources: { chatMessagesToday: number; dreamsCount: number; dailyLogTodayExists: boolean }
  candidates: DreamCandidate[]
  threshold: number
  openCandidateCount: number
  promotedCandidateCount: number
}

const EMPTY: DreamingInfo = {
  ok: false,
  module: { current: '', future: '', benefit: '' },
  automation: { nightly: '', nap: '', weeklyDeep: '', review: '' },
  latestNight: null,
  latestNap: null,
  threads: { counts: {}, relativePath: '', summary: '' },
  sources: { chatMessagesToday: 0, dreamsCount: 0, dailyLogTodayExists: false },
  candidates: [],
  threshold: 0.72,
  openCandidateCount: 0,
  promotedCandidateCount: 0,
}

function readCache(): DreamingInfo {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) as DreamingInfo : EMPTY
  } catch { return EMPTY }
}

function writeCache(value: DreamingInfo) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)) } catch {}
}

function fmtAge(ts?: number): string {
  if (!ts) return 'noch nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade eben'
  if (age < 3600) return `vor ${Math.floor(age / 60)} min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)} h`
  return `vor ${Math.floor(age / 86400)} Tagen`
}

// Muster-Bullets kommen als "**Kurztitel:** ausführlicher Satz". Wir trennen
// den fetten Kopf vom Rest, damit jede Karte eine klare Überschrift bekommt.
function splitInsight(text: string): { head: string; rest: string } {
  const clean = (text || '').trim()
  const m = clean.match(/^\*\*(.+?)\*\*[:.\s]*(.*)$/s)
  if (m) {
    return { head: m[1].replace(/:$/, '').trim(), rest: m[2].replace(/^[:\s]+/, '').replace(/\*\*/g, '').trim() }
  }
  return { head: '', rest: clean.replace(/\*\*/g, '').trim() }
}

function fetchJsonWithTimeout<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', ...init, signal: ctrl.signal })
    .then(async r => {
      if (!r.ok) throw new Error((await r.text()) || r.statusText)
      return r.json() as Promise<T>
    })
    .finally(() => window.clearTimeout(timer))
}

export function DreamingWorkspace() {
  const [info, setInfo] = useState<DreamingInfo>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [napRunning, setNapRunning] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await fetchJsonWithTimeout<DreamingInfo>('/api/dreaming')
      const next = data?.ok ? data : EMPTY
      setInfo(next)
      writeCache(next)
      if (next.latestNight?.mtime) {
        localStorage.setItem(READ_KEY, String(next.latestNight.mtime))
      }
    } catch (e) {
      setError(`Dreaming gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const runNap = useCallback(async () => {
    setNapRunning(true)
    setError('')
    try {
      await fetchJsonWithTimeout('/api/dreaming/nap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, 30000)
      await load()
    } catch (e) {
      setError(`Konnte gerade nicht nachdenken: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setNapRunning(false)
    }
  }, [load])

  const decide = useCallback(async (id: string, status: 'accepted' | 'rejected') => {
    setBusyId(id)
    setError('')
    try {
      await fetchJsonWithTimeout(`/api/dreaming/candidates/${id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      await load()
    } catch (e) {
      setError(`Konnte nicht speichern: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setBusyId('')
    }
  }, [load])

  // Was Agent schon nutzt: bestätigte oder sichere Muster, doppelte raus.
  const inUse = useMemo(() => (
    info.candidates
      .filter(item => item.promoted && item.status !== 'rejected' && (item.body || item.title))
      .filter((item, idx, arr) => arr.findIndex(other => other.body === item.body) === idx)
  ), [info.candidates])

  // Was Agent noch beobachtet: erkannt, aber noch nicht stark genug oder bestätigt.
  const watching = useMemo(() => (
    info.candidates
      .filter(item => !item.promoted && item.status !== 'rejected' && (item.body || item.title))
      .filter((item, idx, arr) => arr.findIndex(other => other.body === item.body) === idx)
      .sort((a, b) => b.score - a.score)
  ), [info.candidates])

  const night = info.latestNight

  return (
    <div className="workspace-system workspace-dreaming">
      <header className="workspace-system-hero">
        <div>
          <p>Dreaming</p>
          <h2>Was ich nachts über dich lerne</h2>
          <span>
            Während du schläfst, lese ich unsere Gespräche des Tages noch einmal und merke mir wiederkehrende
            Muster, deine Energie, deine Reibung, deine Denkweise. Daraus mache ich keine Aufgaben, nur ein
            besseres Gespür dafür, wie ich dich begleite.
          </span>
        </div>
        <button type="button" onClick={load} disabled={loading} title="Neu laden">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      </header>

      {error && <div className="workspace-system-note">{error}</div>}

      <div className="workspace-system-strip">
        <Metric icon={Moon} label="Zuletzt nachgedacht" value={fmtAge(night?.mtime)} detail="letzte Nachtanalyse" />
        <Metric icon={Sparkles} label="Fließt schon ein" value={`${inUse.length}`} detail="Muster, die ich nutze" tone={inUse.length > 0 ? 'ok' : undefined} />
        <Metric icon={Eye} label="Noch im Blick" value={`${watching.length}`} detail="beobachte ich noch" />
        <Metric icon={Clock} label="Gesammelt" value={`${info.sources.dreamsCount || 0}`} detail="Nächte notiert" />
      </div>

      <div className="workspace-system-main">
        <section className="workspace-system-panel">
          <PanelHead icon={Moon} title="Heute Nacht" meta={night ? fmtAge(night.mtime) : 'noch offen'} />
          <div className="workspace-system-list">
            {night ? (
              <article className="workspace-system-row is-ok">
                <span />
                <div>
                  <strong>{night.summary || 'Nachtanalyse ohne Kernsatz.'}</strong>
                  {night.tonus && <em>Die Nacht lief {night.tonus}.</em>}
                </div>
              </article>
            ) : (
              <p>Noch keine Nachtanalyse. Die nächste läuft automatisch heute Nacht um 05:45. Du kannst mich auch jetzt kurz nachdenken lassen, unten rechts.</p>
            )}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={Sparkles} title="Das nutze ich schon" meta="fließt in meine Antworten ein" />
          <div className="workspace-system-list">
            {inUse.length === 0 && (
              <p>Noch nichts Bestätigtes. Sobald ein Muster sicher genug ist oder du es bestätigst, steht es hier und beeinflusst, wie ich mit dir rede.</p>
            )}
            {inUse.map(item => {
              const { head, rest } = splitInsight(item.body || item.title)
              return (
                <article key={item.id} className="workspace-system-row is-ok">
                  <span />
                  <div>
                    <strong>{head || (item.kind === 'pattern' ? 'Muster' : 'Einsicht')}</strong>
                    <em>{rest || item.body}</em>
                  </div>
                  <aside>
                    <b className="dream-badge">fließt ein</b>
                    {item.frequency > 1 && <i>{item.frequency}× gesehen</i>}
                  </aside>
                </article>
              )
            })}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={Eye} title="Das beobachte ich noch" meta="erkannt, noch nicht bestätigt" />
          <div className="workspace-system-list">
            <p className="dream-hint">Bestätige, was wirklich stimmt, dann fließt es in meine Antworten ein. Verwirf, was nicht passt, dann vergesse ich es.</p>
            {watching.length === 0 && <p>Nichts Offenes gerade.</p>}
            {watching.map(item => {
              const { head, rest } = splitInsight(item.body || item.title)
              return (
                <article key={item.id} className="workspace-system-row is-warn">
                  <span />
                  <div>
                    <strong>{head || (item.kind === 'pattern' ? 'Muster' : 'Einsicht')}</strong>
                    <em>{rest || item.body}</em>
                    <div className="dream-actions">
                      <button type="button" className="is-yes" disabled={busyId === item.id} onClick={() => decide(item.id, 'accepted')}>Stimmt, merk's dir</button>
                      <button type="button" className="is-no" disabled={busyId === item.id} onClick={() => decide(item.id, 'rejected')}>Nein, vergiss</button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={Clock} title="Wann ich nachdenke" meta="läuft leise im Hintergrund" />
          <div className="workspace-system-list">
            <article className="workspace-system-row is-neutral">
              <span />
              <div>
                <strong>Jede Nacht</strong>
                <em>Automatische Nachtanalyse um 05:45, du musst nichts tun.</em>
              </div>
            </article>
            <article className="workspace-system-row is-neutral">
              <span />
              <div>
                <strong>Jetzt nachdenken</strong>
                <em>Kurzer Zwischenlauf auf Abruf, ohne etwas Festes zu speichern.</em>
              </div>
              <aside>
                <button type="button" className="dream-nap" onClick={runNap} disabled={napRunning}>
                  <b>{napRunning ? 'Läuft' : 'Nachdenken'}</b>
                </button>
              </aside>
            </article>
            <article className="workspace-system-row is-neutral">
              <span />
              <div>
                <strong>Deine Kontrolle</strong>
                <em>Nur bestätigte oder sehr häufige Muster steuern mich. Alles andere bleibt nur eine Notiz und beeinflusst nichts.</em>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone?: 'ok' }) {
  return (
    <section className={tone === 'ok' ? 'is-good' : ''}>
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </section>
  )
}

function PanelHead({ icon: Icon, title, meta }: { icon: LucideIcon; title: string; meta: string }) {
  return (
    <div className="workspace-system-panel-head">
      <div>
        <Icon className="h-4 w-4" />
        <strong>{title}</strong>
      </div>
      <span>{meta}</span>
    </div>
  )
}
