import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Check, ChevronRight, Mail, MessageCircle, RefreshCw, Search, Star, Users } from 'lucide-react'
import { WaChatView } from '../components/info-pane/sections/WaChatView'
import { MailThreadView } from '../components/info-pane/sections/MailThreadView'
import { renderInlinePreview } from '../lib/inlinePreview'
import { WorkspaceShell } from './WorkspaceShell'

type WaChat = {
  id: string
  name: string
  is_group: boolean
  unread: number
  last_ts: number
  preview?: string
  triage?: string | null
  is_archived?: boolean
  pinned_project_name?: string
}

type MailThread = {
  uid: string
  message_id: string
  account?: string
  from: string
  subject: string
  snippet: string
  ts: number
}

type InboxMailItem = MailThread & {
  replied?: boolean
  inbox_context?: {
    person_name?: string
    company?: string
    projects?: Array<{ id: number; slug: string; name: string }>
  }
}

type ContactResult = {
  chat_id: string
  name: string
  is_group: boolean
  last_ts: number
  unread: number
  is_archived?: boolean
}

type OpenThread =
  | { kind: 'wa'; chatId: string }
  | { kind: 'mail'; account: string; uid: string }

const MAIL_ARCHIVED_LOCAL_KEY = 'mail:archived-uids'
const MAIL_KEPT_LOCAL_KEY = 'mail-kept-waiting'

function mailItemKey(account: string | undefined, uid: string | undefined): string {
  return `${account || ''}:${uid || ''}`
}

function readKeySet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')) } catch { return new Set() }
}

function writeKeySet(key: string, values: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...values].slice(-1000))) } catch {}
}

function rememberArchivedMail(account: string | undefined, uid: string | undefined) {
  const key = mailItemKey(account, uid)
  if (key.endsWith(':') || key.startsWith(':')) return
  const keys = readKeySet(MAIL_ARCHIVED_LOCAL_KEY)
  keys.add(key)
  writeKeySet(MAIL_ARCHIVED_LOCAL_KEY, keys)
}

function rememberKeptMail(account: string | undefined, uid: string | undefined) {
  const key = mailItemKey(account, uid)
  if (key.endsWith(':') || key.startsWith(':')) return
  const keys = readKeySet(MAIL_KEPT_LOCAL_KEY)
  keys.add(key)
  writeKeySet(MAIL_KEPT_LOCAL_KEY, keys)
}

function forgetKeptMail(account: string | undefined, uid: string | undefined) {
  const key = mailItemKey(account, uid)
  const keys = readKeySet(MAIL_KEPT_LOCAL_KEY)
  if (keys.delete(key)) writeKeySet(MAIL_KEPT_LOCAL_KEY, keys)
}

function mergeMailInboxItems(prev: InboxMailItem[], next: InboxMailItem[], doneKeys: string[] = []): InboxMailItem[] {
  const archived = readKeySet(MAIL_ARCHIVED_LOCAL_KEY)
  const kept = readKeySet(MAIL_KEPT_LOCAL_KEY)
  const done = new Set(doneKeys)
  const byKey = new Map<string, InboxMailItem>()
  for (const item of prev) {
    const key = mailItemKey(item.account, item.uid)
    if (key && kept.has(key) && !archived.has(key) && !done.has(key)) byKey.set(key, item)
  }
  for (const item of next) {
    const key = mailItemKey(item.account, item.uid)
    if (key && !archived.has(key) && !done.has(key)) byKey.set(key, item)
  }
  return [...byKey.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

function attentionScore(chat: WaChat): number {
  if (chat.triage === 'waiting_on_me') return 3
  if ((chat.unread || 0) > 0) return 2
  if (chat.triage === 'waiting_on_them') return 1
  return 0
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] text-[var(--t3)]">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-[var(--t1)]">{value}</div>
    </section>
  )
}

function Panel({ title, count, children, defaultOpen = true }: { title: string; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04] ${open ? 'border-b border-[var(--border)]' : ''}`}
        aria-expanded={open}
      >
        <ChevronRight className={`h-4 w-4 shrink-0 text-[var(--t3)] transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{title}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{count}</span>
      </button>
      {open && <div className="divide-y divide-[var(--border)]">{children}</div>}
    </section>
  )
}

export function InboxWorkspace() {
  const [waChats, setWaChats] = useState<WaChat[]>([])
  const [waArchived, setWaArchived] = useState<WaChat[]>([])
  const [mailItems, setMailItems] = useState<InboxMailItem[]>([])
  const [archivedCount, setArchivedCount] = useState(0)
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('wa-favorites') || '[]')) } catch { return new Set() }
  })
  const [query, setQuery] = useState('')
  const [contactResults, setContactResults] = useState<ContactResult[]>([])
  const [openThread, setOpenThread] = useState<OpenThread | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [waRes, mailRes] = await Promise.all([
        fetch('/api/whatsapp/chats?limit=200', { cache: 'no-store' }),
        fetch('/api/inbox/mail-attention?limit=80', { cache: 'no-store' }),
      ])
      const waData = await waRes.json()
      const mailData = await mailRes.json()
      const chats: WaChat[] = Array.isArray(waData.chats) ? waData.chats : []
      const nextMail: InboxMailItem[] = Array.isArray(mailData.items) ? mailData.items : []
      const doneKeys: string[] = Array.isArray(mailData.done_keys) ? mailData.done_keys : []
      setWaChats(chats.filter(c => !c.is_archived))
      setArchivedCount(typeof waData.archived_count === 'number' ? waData.archived_count : 0)
      setMailItems(prev => mergeMailInboxItems(prev, nextMail, doneKeys))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Inbox gerade nicht erreichbar')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadArchived = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/chats?limit=200&include_archived=true', { cache: 'no-store' })
      const data = await res.json()
      const chats: WaChat[] = Array.isArray(data.chats) ? data.chats : []
      const archived = chats.filter(c => c.is_archived).sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0))
      setWaArchived(archived)
      setArchivedCount(typeof data.archived_count === 'number' ? data.archived_count : archived.length)
    } catch {}
  }, [])

  useEffect(() => {
    load()
    loadArchived()
  }, [load, loadArchived])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setContactResults([])
      return
    }
    const t = window.setTimeout(() => {
      fetch(`/api/whatsapp/find-contact?name=${encodeURIComponent(q)}&limit=12`)
        .then(r => r.ok ? r.json() : { matches: [] })
        .then(d => setContactResults(Array.isArray(d.matches) ? d.matches : []))
        .catch(() => setContactResults([]))
    }, 180)
    return () => window.clearTimeout(t)
  }, [query])

  const toggleFavorite = useCallback((chatId: string) => {
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(chatId)) next.delete(chatId)
      else next.add(chatId)
      try { localStorage.setItem('wa-favorites', JSON.stringify([...next])) } catch {}
      return next
    })
  }, [])

  const archiveWa = useCallback(async (chat: WaChat, archive: boolean) => {
    await fetch('/api/whatsapp/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat.id, archive }),
    })
    await Promise.all([load(), loadArchived()])
    window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
  }, [load, loadArchived])

  const dismissWa = useCallback(async (chat: WaChat) => {
    await fetch('/api/whatsapp/dismiss-triage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat.id }),
    }).catch(() => {})
    load()
  }, [load])

  const archiveMail = useCallback(async (mail: InboxMailItem) => {
    const account = mail.account || ''
    if (!account || !mail.uid) return
    const res = await fetch('/api/mail/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, uid: mail.uid }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) throw new Error(data.error || 'Archivieren fehlgeschlagen')
    rememberArchivedMail(account, mail.uid)
    forgetKeptMail(account, mail.uid)
    setMailItems(prev => prev.filter(m => !((m.account || '') === account && m.uid === mail.uid)))
    window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
  }, [])

  const openWaThread = useCallback((chatId: string) => {
    if (!chatId) return
    setOpenThread({ kind: 'wa', chatId })
  }, [])

  const openMailThread = useCallback((mail: InboxMailItem) => {
    const account = mail.account || ''
    if (!account || !mail.uid) return
    rememberKeptMail(account, mail.uid)
    setOpenThread({ kind: 'mail', account, uid: mail.uid })
  }, [])

  const closeThread = useCallback(() => {
    setOpenThread(null)
    load()
    loadArchived()
  }, [load, loadArchived])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchChat = (c: WaChat) => !q || [c.name, c.preview, c.pinned_project_name].filter(Boolean).join(' ').toLowerCase().includes(q)
    const matchMail = (m: InboxMailItem) => !q || [m.from, m.subject, m.snippet, m.inbox_context?.person_name, m.inbox_context?.company].filter(Boolean).join(' ').toLowerCase().includes(q)
    const waitingWa = waChats.filter(c => c.triage === 'waiting_on_me').sort((a, b) => (a.last_ts || 0) - (b.last_ts || 0))
    const waitingIds = new Set(waitingWa.map(c => c.id))
    const mailWaiting = mailItems.filter(m => !m.replied).sort((a, b) => (a.ts || 0) - (b.ts || 0))
    return {
      waiting: [
        ...waitingWa.filter(matchChat).map(chat => ({ kind: 'wa' as const, ts: chat.last_ts || 0, chat })),
        ...mailWaiting.filter(matchMail).map(mail => ({ kind: 'mail' as const, ts: mail.ts || 0, mail })),
      ].sort((a, b) => a.ts - b.ts),
      dms: waChats.filter(c => !c.is_group && !waitingIds.has(c.id) && matchChat(c)).sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0)),
      groups: waChats.filter(c => c.is_group && !waitingIds.has(c.id) && matchChat(c)).sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0)),
      mailRest: mailItems.filter(m => m.replied && matchMail(m)).sort((a, b) => (b.ts || 0) - (a.ts || 0)),
      archived: waArchived.filter(matchChat),
    }
  }, [mailItems, query, waArchived, waChats])

  const unreadTotal = waChats.reduce((sum, c) => sum + (c.unread || 0), 0)
  const attention = filtered.waiting.length

  const renderChat = (chat: WaChat) => {
    const hot = attentionScore(chat) > 1
    const preview = `${chat.pinned_project_name ? `${chat.pinned_project_name} · ` : ''}${chat.preview || ''}`.trim()
    return (
      <div key={chat.id} className="group flex min-w-0 items-start gap-2 px-3 py-2 hover:bg-white/[0.04]">
        <MessageCircle className={`mt-0.5 h-4 w-4 shrink-0 ${hot ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <button type="button" onClick={() => openWaThread(chat.id)} className="min-w-0 flex-1 text-left">
          <span className={`block truncate text-sm ${hot ? 'font-medium text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>{chat.name}</span>
          <span className="mt-0.5 block truncate text-xs text-[var(--t3)]">{preview ? renderInlinePreview(preview) : 'Kein Preview'}</span>
        </button>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtTime(chat.last_ts)}</span>
        {chat.triage === 'waiting_on_me' && (
          <button type="button" onClick={() => dismissWa(chat)} className="shrink-0 p-1 text-[var(--t3)] hover:text-[var(--t1)]" title="Erledigt">
            <Check className="h-4 w-4" />
          </button>
        )}
        <button type="button" onClick={() => toggleFavorite(chat.id)} className={`shrink-0 p-1 ${favorites.has(chat.id) ? 'text-[var(--warm)]' : 'text-[var(--t3)] hover:text-[var(--warm)]'}`} title={favorites.has(chat.id) ? 'Aus Favoriten' : 'Zu Favoriten'}>
          <Star className={favorites.has(chat.id) ? 'h-4 w-4 fill-current' : 'h-4 w-4'} />
        </button>
        <button type="button" onClick={() => archiveWa(chat, !chat.is_archived)} className="shrink-0 p-1 text-[var(--t3)] hover:text-[var(--t1)]" title={chat.is_archived ? 'Entarchivieren' : 'Archivieren'}>
          {chat.is_archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </button>
      </div>
    )
  }

  const renderMail = (mail: InboxMailItem, hot = true) => {
    const title = mail.inbox_context?.person_name || mail.from || 'Mail'
    const projectName = mail.inbox_context?.projects?.[0]?.name || ''
    const preview = `${projectName ? `${projectName} · ` : ''}${mail.subject || '(ohne Betreff)'}${mail.snippet ? ` · ${mail.snippet}` : ''}`
    return (
      <div key={`mail:${mail.account || ''}:${mail.uid}`} className="group flex min-w-0 items-start gap-2 px-3 py-2 hover:bg-white/[0.04]">
        <Mail className={`mt-0.5 h-4 w-4 shrink-0 ${hot ? 'text-[var(--cc-orange)]' : 'text-[var(--t3)]'}`} />
        <button type="button" onClick={() => openMailThread(mail)} className="min-w-0 flex-1 text-left">
          <span className={`block truncate text-sm ${hot ? 'font-medium text-[var(--cc-orange)]' : 'text-[var(--t1)]'}`}>{title}</span>
          <span className="mt-0.5 block truncate text-xs text-[var(--t3)]">{renderInlinePreview(preview)}</span>
        </button>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtTime(mail.ts)}</span>
        <button type="button" onClick={() => archiveMail(mail)} className="shrink-0 p-1 text-[var(--t3)] hover:text-[var(--t1)]" title="Erledigt">
          <Check className="h-4 w-4" />
        </button>
      </div>
    )
  }

  if (openThread?.kind === 'wa') {
    return (
      <div className="h-full min-h-0 bg-[var(--bg)] text-[var(--t1)]">
        <WaChatView chatId={openThread.chatId} onBack={closeThread} mobile={false} />
      </div>
    )
  }

  if (openThread?.kind === 'mail') {
    return (
      <div className="h-full min-h-0 bg-[var(--bg)] text-[var(--t1)]">
        <MailThreadView
          account={openThread.account}
          uid={openThread.uid}
          onBack={closeThread}
          mobile={false}
          onAction={(uid) => {
            rememberArchivedMail(openThread.account, uid)
            forgetKeptMail(openThread.account, uid)
            setMailItems(prev => prev.filter(mail => !((mail.account || '') === openThread.account && mail.uid === uid)))
            window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
          }}
        />
      </div>
    )
  }

  return (
    <WorkspaceShell
      eyebrow="Inbox"
      title={attention > 0 ? `${attention} wartet` : 'Inbox ruhig'}
      subtitle={unreadTotal > 0 ? `${unreadTotal} ungelesene WhatsApp-Nachrichten` : 'WhatsApp, Mail und Kontakte liegen untereinander in einer ruhigen Arbeitsliste.'}
      action={
        <button type="button" onClick={() => { load(); loadArchived() }} disabled={loading} title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </button>
      }
    >

      <div className="workspace-system-strip">
        <Stat label="Wartet" value={filtered.waiting.length} />
        <Stat label="WhatsApp" value={filtered.dms.length} />
        <Stat label="Gruppen" value={filtered.groups.length} />
        <Stat label="Archiv" value={archivedCount} />
      </div>
      {error && <div className="workspace-system-note">{error}</div>}

      <main className="workspace-system-main workspace-system-stack">
        <label className="workspace-search-slim flex items-center gap-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Kontakt, Chat oder Mail suchen" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]" />
        </label>

        {contactResults.length > 0 && (
          <Panel title="Kontakte" count={contactResults.length}>
            {contactResults.map(contact => (
              <button key={contact.chat_id} type="button" onClick={() => openWaThread(contact.chat_id)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.04]">
                <MessageCircle className="h-4 w-4 shrink-0 text-[var(--t3)]" />
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--t1)]">{contact.name}</span>
                {contact.is_group && <Users className="h-4 w-4 shrink-0 text-[var(--t3)]" />}
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtTime(contact.last_ts)}</span>
              </button>
            ))}
          </Panel>
        )}

        <div className="workspace-inbox-grid grid gap-3">
          <Panel title="Wartet" count={filtered.waiting.length}>
            {filtered.waiting.map(item => item.kind === 'wa' ? renderChat(item.chat) : renderMail(item.mail))}
            {filtered.waiting.length === 0 && <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Inbox' : 'Nichts wartet.'}</div>}
          </Panel>
          <Panel title="WhatsApp" count={filtered.dms.length}>
            {filtered.dms.map(renderChat)}
            {filtered.dms.length === 0 && <div className="px-3 py-4 text-sm text-[var(--t3)]">Keine Chats.</div>}
          </Panel>
          <Panel title="Gruppen" count={filtered.groups.length}>
            {filtered.groups.map(renderChat)}
            {filtered.groups.length === 0 && <div className="px-3 py-4 text-sm text-[var(--t3)]">Keine Gruppen.</div>}
          </Panel>
          <Panel title="E-Mails" count={filtered.mailRest.length}>
            {filtered.mailRest.map(mail => renderMail(mail, false))}
            {filtered.mailRest.length === 0 && <div className="px-3 py-4 text-sm text-[var(--t3)]">Keine erledigten Mails.</div>}
          </Panel>
          <Panel title="Archiviert" count={filtered.archived.length} defaultOpen={false}>
            {filtered.archived.map(renderChat)}
            {filtered.archived.length === 0 && <div className="px-3 py-4 text-sm text-[var(--t3)]">Kein Archiv geladen.</div>}
          </Panel>
        </div>
      </main>
    </WorkspaceShell>
  )
}
