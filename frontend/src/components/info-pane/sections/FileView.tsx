import React, { useState, useEffect, useRef } from 'react'
import { X, ChevronLeft, Pause, Play, Download, Shield, Info, MessageSquare, Pencil, MoreHorizontal } from 'lucide-react'
import { useMainAgentName } from '../../../agents'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import * as audioQueue from '../../../audioQueue'
import { playUISound } from '../../../uiSounds'
import { MD } from '../utils/constants'

// ── File Viewer ──

type JobMeta = {
  job?: string
  status?: string
  exit_code?: number
  duration_seconds?: number
  duration_ms?: number
  duration_api_ms?: number
  started_at?: string
  ended_at?: string
  model?: string | null
  session_id?: string
  cost_usd?: number
  num_turns?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  stderr_tail?: string
}

function formatModelLabel(model: string | null | undefined): string {
  if (!model) return ''
  const m = model.toLowerCase()
  const map: Record<string, string> = {
    'claude-fable-5': 'Fable 5',
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-sonnet-4-5': 'Sonnet 4.5',
    'claude-haiku-4-5': 'Haiku 4.5',
    'opus': 'Opus',
    'sonnet': 'Sonnet',
    'haiku': 'Haiku',
  }
  if (map[m]) return map[m]
  // claude-haiku-4-5-20251001 → Haiku 4.5
  const dated = m.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/)
  if (dated) return `${dated[1][0].toUpperCase()}${dated[1].slice(1)} ${dated[2]}.${dated[3]}`
  return model
}

function formatDuration(seconds: number | undefined, ms?: number): string {
  let total = seconds
  if ((total === undefined || total === null) && ms !== undefined) total = Math.round(ms / 1000)
  if (total === undefined || total === null) return ''
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '—'
  return n.toLocaleString('de-DE')
}

function MetaPopover({ meta, onClose }: { meta: JobMeta; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => document.addEventListener('mousedown', onDocClick), 0)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDocClick); document.removeEventListener('keydown', onEsc) }
  }, [onClose])
  const u = meta.usage || {}
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-baseline gap-3 py-0.5">
      <span className="info-text-meta text-[var(--t3)] w-[110px] flex-shrink-0">{label}</span>
      <span className="info-text-meta text-[var(--t1)] font-mono break-all">{value}</span>
    </div>
  )
  return (
    <div ref={ref} className="absolute right-2 top-full mt-1 z-50 w-[320px] rounded-md border border-[var(--border)] bg-[var(--bg-2)] shadow-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="info-text-body text-[var(--t1)] font-medium">Job-Telemetrie</span>
        <button onClick={onClose} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer"><X className="info-icon-sm" /></button>
      </div>
      <div className="flex flex-col">
        {meta.status && <Row label="Status" value={<span style={{ color: meta.status === 'ok' ? 'var(--green)' : 'var(--red)' }}>{meta.status}{meta.exit_code !== undefined && meta.exit_code !== 0 ? ` (exit ${meta.exit_code})` : ''}</span>} />}
        {(meta.duration_seconds !== undefined || meta.duration_ms !== undefined) && <Row label="Dauer" value={formatDuration(meta.duration_seconds, meta.duration_ms)} />}
        {meta.model && <Row label="Modell" value={formatModelLabel(meta.model)} />}
        {meta.started_at && <Row label="Gestartet" value={meta.started_at.replace('T', ' ').replace('Z', '')} />}
        {meta.cost_usd !== undefined && <Row label="Kosten" value={`$${meta.cost_usd.toFixed(4)}`} />}
        {meta.num_turns !== undefined && <Row label="Turns" value={String(meta.num_turns)} />}
        {meta.usage && (
          <>
            <div className="mt-2 mb-1 info-text-meta text-[var(--t3)]/60 uppercase tracking-[0.08em]">Tokens</div>
            <Row label="Input" value={formatNumber(u.input_tokens)} />
            <Row label="Output" value={formatNumber(u.output_tokens)} />
            {(u.cache_read_input_tokens || u.cache_creation_input_tokens) && <Row label="Cache read" value={formatNumber(u.cache_read_input_tokens)} />}
            {u.cache_creation_input_tokens ? <Row label="Cache write" value={formatNumber(u.cache_creation_input_tokens)} /> : null}
          </>
        )}
        {meta.session_id && <Row label="Session" value={<span title={meta.session_id}>{meta.session_id.slice(0, 8)}…</span>} />}
        {meta.stderr_tail && (
          <>
            <div className="mt-2 mb-1 info-text-meta text-[var(--t3)]/60 uppercase tracking-[0.08em]">stderr</div>
            <pre className="info-text-meta text-[var(--t3)] font-mono whitespace-pre-wrap max-h-[120px] overflow-y-auto bg-[var(--bg-3)] rounded p-2">{meta.stderr_tail}</pre>
          </>
        )}
      </div>
    </div>
  )
}

export function FileViewMenu({ meta, metaOpen, setMetaOpen, isMd, hasContent, isEditable, editing, setEditing, path, content }: {
  meta: JobMeta | null
  metaOpen: boolean
  setMetaOpen: React.Dispatch<React.SetStateAction<boolean>>
  isMd: boolean
  hasContent: boolean
  isEditable: boolean
  editing: boolean
  setEditing: (v: boolean) => void
  path: string
  content: string
}) {
  const agentName = useMainAgentName()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  type Item = { label: string; icon: typeof Shield; onClick: () => void; disabled?: boolean }
  const items: Item[] = []
  if (meta) items.push({ label: 'Job-Telemetrie', icon: Info, onClick: () => { setMetaOpen(v => !v); setOpen(false) } })
  if (isMd && hasContent) items.push({ label: `Mit ${agentName} besprechen`, icon: MessageSquare, onClick: () => { window.dispatchEvent(new CustomEvent('deck:discussFile', { detail: { filePath: path, content } })); setOpen(false) } })
  if (isEditable && !editing) items.push({ label: 'Bearbeiten', icon: Pencil, onClick: () => { setEditing(true); setOpen(false) } })
  items.push({ label: 'Herunterladen', icon: Download, onClick: () => { window.location.href = `/api/fs/download?path=${encodeURIComponent(path)}`; setOpen(false) } })

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button onClick={() => setOpen(v => !v)} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer flex items-center justify-center" title="Aktionen">
        <MoreHorizontal className="info-icon-md" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-[var(--bg-2)] rounded-md shadow-xl py-1">
          {items.map((it, i) => (
            <button
              key={i}
              onClick={it.onClick}
              disabled={it.disabled}
              className="w-full flex items-center gap-2 px-3 py-1.5 info-text-body text-[var(--t2)] hover:bg-white/[0.06] hover:text-[var(--t1)] cursor-pointer text-left disabled:opacity-50"
            >
              <it.icon className="info-icon-md text-[var(--t3)]" />
              {it.label}
            </button>
          ))}
        </div>
      )}
      {metaOpen && meta && <MetaPopover meta={meta} onClose={() => setMetaOpen(false)} />}
    </div>
  )
}

export function FileView({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [meta, setMeta] = useState<JobMeta | null>(null)
  const [metaOpen, setMetaOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // TTS player state
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [ttsCurrent, setTtsCurrent] = useState(0)
  const [ttsDuration] = useState(0)
  const ttsRef = useRef<HTMLAudioElement | null>(null)

  const lower = path.toLowerCase()
  const kind: 'text' | 'pdf' | 'image' | 'binary' =
    /\.(pdf)$/.test(lower) ? 'pdf'
    : /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(lower) ? 'image'
    : /\.(md|mdx|txt|json|yaml|yml|html|htm|css|js|jsx|ts|tsx|py|sh|toml|ini|cfg|csv|log|xml|sql)$/.test(lower) ? 'text'
    : 'binary'

  useEffect(() => {
    setError('')
    if (path.endsWith('.md') || path.endsWith('.mdx')) playUISound('doc-open', 0.4)
    setMeta(null); setMetaOpen(false)
    if (kind !== 'text') {
      setContent(''); setDraft('')
      return () => { ttsRef.current?.pause(); ttsRef.current = null }
    }
    fetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
      .then(d => { setContent(d.content || ''); setDraft(d.content || ''); setMeta(d.meta || null) })
      .catch(e => setError(`Laden fehlgeschlagen: ${e.message}`))
    return () => { ttsRef.current?.pause(); ttsRef.current = null }
  }, [path, kind])

  const save = async () => {
    setSaving(true); setError('')
    try {
      const r = await fetch('/api/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, content: draft }) })
      if (!r.ok) throw new Error((await r.json()).error || r.statusText)
      setContent(draft); setEditing(false)
    } catch (e: any) { setError(`Speichern fehlgeschlagen: ${e.message}`) }
    finally { setSaving(false) }
  }

  const onMdClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const btn = target.closest('[data-section-heading]') as HTMLElement | null
    if (!btn) return
    e.preventDefault(); e.stopPropagation()
    const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
    void heading
  }

  // Keep playback rate in sync when user changes it via SettingsMenu
  useEffect(() => {
    return audioQueue.subscribe(s => {
      if (ttsRef.current) ttsRef.current.playbackRate = s.playbackRate
    })
  }, [])

  const toggleTts = () => {
    if (!ttsRef.current) return
    if (ttsPlaying) { ttsRef.current.pause(); setTtsPlaying(false) }
    else { ttsRef.current.play(); setTtsPlaying(true) }
  }

  const stopTts = () => {
    if (!ttsRef.current) return
    ttsRef.current.pause(); ttsRef.current.currentTime = 0
    setTtsPlaying(false); setTtsCurrent(0)
  }

  const seekTts = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ttsRef.current || !ttsDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    ttsRef.current.currentTime = pct * ttsDuration
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  const ttsPct = ttsDuration ? (ttsCurrent / ttsDuration) * 100 : 0
  const hasTtsAudio = !!ttsRef.current

  const filename = path.split('/').pop() || path
  const dirPath = path.replace(/^\/Users\/[^/]+\//, '~/').replace(/\/[^/]+$/, '') + '/'

  return (
    <div className="flex flex-col h-full">
      <div className="relative flex items-center gap-2 px-3" style={{ minHeight: 'var(--header-row-h)', borderBottom: '1px solid var(--border)' }}>
        <button onClick={() => { if (path.endsWith('.md') || path.endsWith('.mdx')) playUISound('doc-open', 0.4); onClose() }} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer flex-shrink-0"><ChevronLeft className="info-icon-md" /></button>
        <div className="flex items-baseline min-w-0 flex-1 info-text-body">
          <span className="text-[var(--t3)] min-w-0 overflow-hidden whitespace-nowrap" style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext', textOverflow: 'ellipsis' }}>{dirPath}</span>
          <span className="text-[var(--t1)] font-medium whitespace-nowrap flex-shrink-0">{filename}</span>
        </div>
        {kind === 'text' && (path.endsWith('.md') || path.endsWith('.mdx')) && editing && (
          <button onClick={save} disabled={saving} className="info-text-body font-mono text-[var(--green)] hover:text-[var(--t1)] cursor-pointer flex-shrink-0">{saving ? '...' : 'Speichern'}</button>
        )}
        <FileViewMenu
          meta={meta}
          metaOpen={metaOpen}
          setMetaOpen={setMetaOpen}
          isMd={path.endsWith('.md')}
          hasContent={!!content}
          isEditable={kind === 'text' && (path.endsWith('.md') || path.endsWith('.mdx'))}
          editing={editing}
          setEditing={setEditing}
          path={path}
          content={content}
        />
      </div>
      {hasTtsAudio && (
        <div className="flex items-center gap-2.5 px-3 py-2">
          <button
            onClick={toggleTts}
            className="h-8 w-8 flex items-center justify-center rounded-full bg-[var(--purple)] text-white hover:brightness-110 cursor-pointer transition-all flex-shrink-0"
          >
            {ttsPlaying ? <Pause className="info-icon-md" /> : <Play className="info-icon-md" style={{ marginLeft: 1 }} />}
          </button>
          <div className="flex-1 flex flex-col gap-0.5 min-w-0">
            <div className="h-1 rounded-full bg-[var(--bg-3)] cursor-pointer" onClick={seekTts}>
              <div className="h-full rounded-full bg-[var(--purple)] transition-all" style={{ width: `${ttsPct}%` }} />
            </div>
            <div className="flex justify-between info-text-meta font-mono text-[var(--t3)]">
              <span>{fmt(ttsCurrent)}</span>
              <span>{ttsDuration ? fmt(ttsDuration) : '--:--'}</span>
            </div>
          </div>
          <button onClick={stopTts} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer transition-colors flex-shrink-0 flex items-center justify-center" title="Schließen">
            <X className="info-icon-md" />
          </button>
        </div>
      )}
      <div className={`flex-1 overflow-y-auto ${kind === 'pdf' ? '' : 'p-3'}`}>
        {error && <div className="info-text-meta text-red-400 mb-2 font-mono px-3 pt-3">{error}</div>}
        {kind === 'pdf' ? (
          <iframe src={`/api/fs/download?path=${encodeURIComponent(path)}&inline=1`} className="w-full h-full border-0" title={path} />
        ) : kind === 'image' ? (
          <div className="flex items-center justify-center h-full">
            <img src={`/api/fs/download?path=${encodeURIComponent(path)}&inline=1`} alt={path.split('/').pop() || ''} className="max-w-full max-h-full object-contain" />
          </div>
        ) : kind === 'binary' ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 text-[var(--t3)]">
            <div className="info-text-body">Vorschau für diesen Dateityp nicht möglich.</div>
            <button
              onClick={() => { window.location.href = `/api/fs/download?path=${encodeURIComponent(path)}` }}
              className="info-text-body font-mono text-[var(--green)] hover:text-[var(--t1)] cursor-pointer flex items-center gap-2"
            ><Download className="w-[18px] h-[18px]" /> Herunterladen</button>
          </div>
        ) : editing ? (
          <textarea value={draft} onChange={e => setDraft(e.target.value)}
            className="w-full h-full bg-transparent border-none outline-none resize-none info-text-body font-mono text-[var(--t2)]" />
        ) : (
          <div className={`chat-md-agent ${MD}`} onClick={onMdClick} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content) as string) }} />
        )}
      </div>
    </div>
  )
}
