import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, X, MessageSquare, MessageCircle, Mail, FileText, FileCog, Wrench } from 'lucide-react'

type Category = 'all' | 'chat' | 'wa' | 'mail' | 'docs' | 'files' | 'skills'

interface ChatHit { kind: 'chat'; title: string; snippet: string; ts: number; agent: string; conversationId: string; matchedTitle: boolean }
interface WaHit { kind: 'wa'; id: string; chat_id: string; chat_name: string; ts: number; from_me: boolean; snippet: string; isContact?: boolean; unread?: number }
interface MailHit { kind: 'mail'; account: string; uid: string; subject: string; from: string; ts: number; snippet: string }
interface DocHit { kind: 'docs'; source: string; path: string; title: string; snippet: string }
interface FileHit { kind: 'files'; name: string; path: string; source: string; ts: number }
interface SkillHit { kind: 'skills'; name: string; slug: string; path: string; category: string; description: string }

type Hit = ChatHit | WaHit | MailHit | DocHit | FileHit | SkillHit

function relTime(ts: number): string {
  const now = Date.now() / 1000
  const diff = now - ts
  if (diff < 60) return 'gerade'
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min`
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std`
  if (diff < 86400 * 7) return `vor ${Math.floor(diff / 86400)} Tg`
  return new Date(ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlight(text: string, query: string): string {
  const safe = escapeHtml(text)
  if (!query) return safe
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return safe.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="bg-[var(--warm)]/30 text-[var(--t1)] rounded px-0.5">$1</mark>')
}

const CATS: [Category, string][] = [
  ['all', 'Alle'],
  ['chat', 'Chats'],
  ['wa', 'WhatsApp'],
  ['mail', 'Mail'],
  ['docs', 'Dokumente'],
  ['files', 'Dateien'],
  ['skills', 'Skills'],
]

export function Spotlight({ onClose, mobile = false }: { onClose: () => void; mobile?: boolean }) {
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<Category>('all')
  const [chat, setChat] = useState<ChatHit[]>([])
  const [wa, setWa] = useState<WaHit[]>([])
  const [mail, setMail] = useState<MailHit[]>([])
  const [docs, setDocs] = useState<DocHit[]>([])
  const [files, setFiles] = useState<FileHit[]>([])
  const [skills, setSkills] = useState<SkillHit[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)

  useEffect(() => { inputRef.current?.focus() }, [])

  const doSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setChat([]); setWa([]); setMail([]); setDocs([]); setFiles([]); setSkills([])
      setLoading(false)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    const enc = encodeURIComponent(trimmed)
    const settle = (n: number) => {
      pending -= n
      if (pending <= 0 && seqRef.current === seq) setLoading(false)
    }
    let pending = 7

    Promise.all([
      fetch(`/api/whatsapp/find-contact?name=${enc}&limit=10`).then(r => r.ok ? r.json() : { matches: [] }).catch(() => ({ matches: [] })),
      fetch(`/api/whatsapp/search?q=${enc}&limit=20`).then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    ]).then(([cData, mData]) => {
      if (seqRef.current !== seq) return
      const contacts = ((cData.matches || []) as Array<{ chat_id: string; name: string; last_ts?: number; unread?: number }>).map(c => ({
        kind: 'wa' as const,
        id: `contact-${c.chat_id}`,
        chat_id: c.chat_id,
        chat_name: c.name,
        ts: c.last_ts || 0,
        from_me: false,
        snippet: 'Kontakt',
        isContact: true,
        unread: c.unread || 0,
      }))
      const seen = new Set(contacts.map(c => c.chat_id))
      const messages = ((mData.results || []) as Array<{ id: string; chat_id: string; chat_name: string; ts: number; from_me: boolean; snippet?: string; body?: string; transcript?: string }>)
        .filter(r => !seen.has(r.chat_id))
        .map(r => ({
          kind: 'wa' as const,
          id: r.id, chat_id: r.chat_id, chat_name: r.chat_name,
          ts: r.ts, from_me: r.from_me,
          snippet: r.snippet || r.transcript || r.body || '',
        }))
      setWa([...contacts, ...messages])
    }).finally(() => settle(2))

    fetch(`/api/search/conversations?q=${enc}&limit=20`).then(r => r.json()).then(d => {
      if (seqRef.current !== seq) return
      const rs = (d.results || []) as Array<{ conversationId: string; title: string; agent: string; ts: number; snippet: string; matchedTitle: boolean }>
      setChat(rs.map(r => ({
        kind: 'chat' as const,
        title: r.title || '(ohne Titel)',
        snippet: r.snippet || '',
        ts: r.ts || 0,
        agent: r.agent || '',
        conversationId: r.conversationId,
        matchedTitle: !!r.matchedTitle,
      })))
    }).catch(() => setChat([])).finally(() => settle(1))

    fetch(`/api/mail/threads?q=${enc}&limit=20`).then(r => r.ok ? r.json() : { threads: [] }).then(d => {
      if (seqRef.current !== seq) return
      const account = d.account || ''
      const ts = (d.threads || []) as Array<{ uid: string; subject?: string; from?: string; date?: string; snippet?: string; ts?: number }>
      setMail(ts.map(t => ({
        kind: 'mail' as const,
        account,
        uid: String(t.uid),
        subject: t.subject || '(kein Betreff)',
        from: t.from || '',
        ts: typeof t.ts === 'number' ? t.ts : (t.date ? Date.parse(t.date) / 1000 : 0),
        snippet: t.snippet || '',
      })))
    }).catch(() => setMail([])).finally(() => settle(1))

    fetch(`/api/search?q=${enc}&limit=20`).then(r => r.json()).then(d => {
      if (seqRef.current !== seq) return
      const rs = (d.results || []) as DocHit[]
      setDocs(rs.map(r => ({ ...r, kind: 'docs' as const })))
    }).catch(() => setDocs([])).finally(() => settle(1))

    fetch(`/api/search/files?q=${enc}&limit=20`).then(r => r.json()).then(d => {
      if (seqRef.current !== seq) return
      const rs = (d.files || []) as FileHit[]
      setFiles(rs.map(r => ({ ...r, kind: 'files' as const })))
    }).catch(() => setFiles([])).finally(() => settle(1))

    fetch('/api/skills', { cache: 'no-store' }).then(r => r.ok ? r.json() : { skills: [] }).then(d => {
      if (seqRef.current !== seq) return
      const qLower = trimmed.toLowerCase()
      const rs = ((d.skills || []) as Array<{ name?: string; slug?: string; path?: string; category?: string; description?: string }>)
        .filter(s => [
          s.name,
          s.slug,
          s.category,
          s.description,
        ].some(v => (v || '').toLowerCase().includes(qLower)))
        .slice(0, 20)
      setSkills(rs.map(s => ({
        kind: 'skills' as const,
        name: s.name || s.slug || 'Skill',
        slug: s.slug || '',
        path: s.path || '',
        category: s.category || 'Skills',
        description: s.description || '',
      })))
    }).catch(() => setSkills([])).finally(() => settle(1))
  }, [])

  const handleChange = (v: string) => {
    setQuery(v)
    setActiveIdx(0)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(v), 200)
  }

  const visible: Hit[] = useMemo(() => {
    const lists: Record<Category, Hit[]> = { all: [], chat, wa, mail, docs, files, skills }
    if (cat !== 'all') return lists[cat]
    if (mobile) {
      const waContacts = wa.filter(h => h.isContact)
      const waMessages = wa.filter(h => !h.isContact)
      return [...waContacts, ...chat, ...waMessages, ...mail, ...docs, ...files, ...skills]
    }
    // Interleave: zeige top-Treffer aller Quellen gemischt nach Quellen-Reihenfolge
    const max = Math.max(chat.length, wa.length, mail.length, docs.length, files.length, skills.length)
    const out: Hit[] = []
    for (let i = 0; i < max; i++) {
      if (chat[i]) out.push(chat[i])
      if (wa[i]) out.push(wa[i])
      if (mail[i]) out.push(mail[i])
      if (docs[i]) out.push(docs[i])
      if (files[i]) out.push(files[i])
      if (skills[i]) out.push(skills[i])
    }
    return out
  }, [cat, chat, wa, mail, docs, files, skills, mobile])

  const counts = { all: chat.length + wa.length + mail.length + docs.length + files.length + skills.length, chat: chat.length, wa: wa.length, mail: mail.length, docs: docs.length, files: files.length, skills: skills.length } as Record<Category, number>

  const open = useCallback((h: Hit) => {
    if (h.kind === 'files' || h.kind === 'docs') {
      window.dispatchEvent(new CustomEvent('deck:openFile', { detail: h.path }))
    } else if (h.kind === 'skills') {
      window.dispatchEvent(new CustomEvent('deck:openFile', { detail: h.path }))
    } else if (h.kind === 'chat') {
      window.dispatchEvent(new CustomEvent('deck:loadConversation', { detail: { agent: h.agent, conversationId: h.conversationId, paneIndex: 0 } }))
    } else if (h.kind === 'wa') {
      window.dispatchEvent(new CustomEvent('deck:openWaChat', { detail: { chatId: h.chat_id } }))
    } else if (h.kind === 'mail') {
      window.dispatchEvent(new CustomEvent('deck:openMailThread', { detail: { account: h.account, uid: h.uid } }))
    }
    onClose()
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(visible.length - 1, i + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)) }
      else if (e.key === 'Enter') {
        const h = visible[activeIdx]
        if (h) { e.preventDefault(); open(h) }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, visible, activeIdx, open])

  useEffect(() => { setActiveIdx(0) }, [cat])

  const renderHit = (h: Hit, i: number) => {
    const active = i === activeIdx
    const base = mobile
      ? `w-full text-left px-4 py-3 cursor-pointer transition-colors flex items-start gap-3 ${active ? 'bg-white/[0.035]' : 'active:bg-white/[0.03]'}`
      : `w-full text-left px-4 py-2.5 cursor-pointer transition-colors flex items-start gap-3 ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`
    if (h.kind === 'chat') {
      return (
        <button key={`c-${i}`} onClick={() => open(h)} onMouseEnter={() => setActiveIdx(i)} className={base}>
          <MessageSquare className="w-4 h-4 text-[var(--t3)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium text-[var(--t1)] truncate" dangerouslySetInnerHTML={{ __html: highlight(h.title, query) }} />
              {!mobile && h.agent && <span className="text-[12px] text-[var(--t3)]">{h.agent}</span>}
              <span className="text-[12px] text-[var(--t3)] ml-auto flex-shrink-0">{h.ts ? relTime(h.ts) : ''}</span>
            </div>
            {h.snippet && (
              <div className="text-[14px] text-[var(--t2)] line-clamp-1 mt-0.5" dangerouslySetInnerHTML={{ __html: highlight(h.snippet, query) }} />
            )}
          </div>
        </button>
      )
    }
    if (h.kind === 'wa') {
      return (
        <button key={`w-${i}`} onClick={() => open(h)} onMouseEnter={() => setActiveIdx(i)} className={base}>
          <MessageCircle className="w-4 h-4 text-[var(--t3)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium text-[var(--t1)] truncate">{h.chat_name}</span>
              <span className="text-[12px] text-[var(--t3)]">{h.isContact ? 'Kontakt' : 'WhatsApp'}</span>
              {h.isContact && h.unread ? <span className="text-[12px] text-[var(--t1)]">{h.unread}</span> : null}
              <span className="text-[12px] text-[var(--t3)] ml-auto flex-shrink-0">{h.ts ? relTime(h.ts) : ''}</span>
            </div>
            {h.isContact
              ? <div className="text-[14px] text-[var(--t3)] line-clamp-1 mt-0.5">Chat öffnen</div>
              : <div className="text-[14px] text-[var(--t2)] line-clamp-1 mt-0.5" dangerouslySetInnerHTML={{ __html: highlight(h.snippet, query) }} />}
          </div>
        </button>
      )
    }
    if (h.kind === 'mail') {
      return (
        <button key={`m-${i}`} onClick={() => open(h)} onMouseEnter={() => setActiveIdx(i)} className={base}>
          <Mail className="w-4 h-4 text-[var(--t3)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium text-[var(--t1)] truncate">{h.subject}</span>
              <span className="text-[12px] text-[var(--t3)] truncate">{h.from}</span>
              <span className="text-[12px] text-[var(--t3)] ml-auto flex-shrink-0">{h.ts ? relTime(h.ts) : ''}</span>
            </div>
            {h.snippet && <div className="text-[14px] text-[var(--t2)] line-clamp-1 mt-0.5" dangerouslySetInnerHTML={{ __html: highlight(h.snippet, query) }} />}
          </div>
        </button>
      )
    }
    if (h.kind === 'docs') {
      const rel = h.path.replace('/workspace/', '~/workspace/')
      return (
        <button key={`d-${i}`} onClick={() => open(h)} onMouseEnter={() => setActiveIdx(i)} className={base}>
          <FileText className="w-4 h-4 text-[var(--t3)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium text-[var(--t1)] truncate">{h.title || rel}</span>
              <span className="text-[12px] text-[var(--t3)] truncate">{h.source}</span>
            </div>
            <div className="text-[14px] text-[var(--t2)] line-clamp-1 mt-0.5" dangerouslySetInnerHTML={{ __html: highlight(stripHtml(h.snippet), query) }} />
          </div>
        </button>
      )
    }
    if (h.kind === 'skills') {
      const rel = h.path.replace('/workspace/', '~/workspace/')
      return (
        <button key={`s-${i}`} onClick={() => open(h)} onMouseEnter={() => setActiveIdx(i)} className={base}>
          <Wrench className="w-4 h-4 text-[var(--t3)] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[14px] font-medium text-[var(--t1)] truncate" dangerouslySetInnerHTML={{ __html: highlight(h.name, query) }} />
              <span className="text-[12px] text-[var(--t3)] truncate">{h.category}</span>
            </div>
            <div className="text-[14px] text-[var(--t2)] line-clamp-1 mt-0.5" dangerouslySetInnerHTML={{ __html: highlight(h.description || rel, query) }} />
          </div>
        </button>
      )
    }
    // files
    const rel = h.path.replace('/workspace/', '~/workspace/')
    return (
      <button key={`f-${i}`} onClick={() => open(h)} onMouseEnter={() => setActiveIdx(i)} className={base}>
        <FileCog className="w-4 h-4 text-[var(--t3)] flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-medium text-[var(--t1)] truncate">{h.name}</span>
            <span className="text-[12px] text-[var(--t3)] truncate">{h.source}</span>
            <span className="text-[12px] text-[var(--t3)] ml-auto flex-shrink-0">{relTime(h.ts)}</span>
          </div>
          <div className="text-[13px] text-[var(--t3)] truncate mt-0.5">{rel}</div>
        </div>
      </button>
    )
  }

  if (mobile) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col"
        style={{
          background: 'var(--bg)',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div className="px-3 pt-3 pb-2 flex-shrink-0">
          <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-white/[0.03]">
            <Search className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => handleChange(e.target.value)}
              placeholder="Alles suchen…"
              className="flex-1 bg-transparent border-none outline-none text-[17px] text-[var(--t1)] placeholder:text-[var(--t3)]/50"
              autoFocus
            />
            {loading && <span className="text-[13px] text-[var(--t3)]">…</span>}
            <button
              onClick={onClose}
              className="-mr-1 flex h-7 w-7 items-center justify-center rounded-full text-[var(--t3)] active:text-[var(--t1)] active:bg-white/[0.04] cursor-pointer flex-shrink-0"
              aria-label="Schließen"
              title="Schließen"
            >
              <X className="w-[20px] h-[20px]" />
            </button>
          </div>
        </div>
        <div className="flex items-center px-3 pb-3 border-b border-[var(--border)]/50 flex-shrink-0">
          {query && (
          <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
            {CATS.map(([key, label]) => (
              <button key={key} onClick={() => setCat(key)}
                className={`px-2.5 py-1 rounded text-[13px] cursor-pointer transition-colors flex-shrink-0 ${cat === key ? 'bg-white/[0.05] text-[var(--t1)]' : 'text-[var(--t3)] active:text-[var(--t2)]'}`}>
                {label}{counts[key] > 0 && <span className="ml-1 text-[var(--t3)]">{counts[key]}</span>}
              </button>
            ))}
          </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {query && !loading && visible.length === 0 && (
            <div className="px-4 py-8 text-center text-[14px] text-[var(--t3)]">Keine Treffer</div>
          )}
          {visible.map((h, i) => renderHit(h, i))}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/30" onClick={onClose}>
      <div
        className="w-full max-w-[640px] mx-4 bg-[var(--bg-1)] border border-[var(--border-f)] rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.6)] animate-[spotlightIn_0.15s_ease] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <Search className="w-4 h-4 text-[var(--t3)] flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => handleChange(e.target.value)}
            placeholder="Alles durchsuchen…"
            className="flex-1 bg-transparent border-none outline-none text-[17px] text-[var(--t1)] placeholder:text-[var(--t3)]"
          />
          {loading && <span className="text-[12px] text-[var(--t3)]">…</span>}
          <button onClick={onClose} className="text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {query && (
          <div className="flex items-center gap-1 px-3 py-2 border-b border-[var(--border)]/50 overflow-x-auto">
            {CATS.map(([key, label]) => (
              <button key={key} onClick={() => setCat(key)}
                className={`px-2 py-0.5 rounded text-[13px] cursor-pointer transition-colors flex-shrink-0 ${cat === key ? 'bg-white/[0.08] text-[var(--t1)]' : 'text-[var(--t3)] hover:text-[var(--t2)]'}`}>
                {label}{counts[key] > 0 && <span className="ml-1 text-[var(--t3)]">{counts[key]}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto">
          {!query && (
            <div className="px-4 py-8 text-center text-[14px] text-[var(--t3)]">
              Tippe um Chats, WhatsApp, Mail, Dokumente und Dateien zu durchsuchen.
            </div>
          )}
          {query && !loading && visible.length === 0 && (
            <div className="px-4 py-8 text-center text-[14px] text-[var(--t3)]">Keine Treffer.</div>
          )}
          {visible.map((h, i) => renderHit(h, i))}
        </div>
      </div>
    </div>
  )
}
