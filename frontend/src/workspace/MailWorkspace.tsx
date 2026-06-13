import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Inbox, Paperclip, RefreshCw, Search, Star } from 'lucide-react'
import { MailThreadView } from '../components/info-pane/sections/MailThreadView'

type MailAccount = {
  key: string
  name: string
  email: string
}

type MailThread = {
  uid: string
  message_id: string
  account?: string
  account_name?: string
  account_email?: string
  from: string
  from_raw: string
  subject: string
  snippet: string
  ts: number
  unread: boolean
  starred?: boolean
  to_me: boolean
  has_attachment?: boolean
  category?: string
  bucket?: string
}

type MailRules = {
  folders?: string[]
  tab_labels?: Record<string, string>
}

type OpenMail = {
  account: string
  uid: string
}

const DEFAULT_RULES: MailRules = {
  folders: ['attention', 'rechnung', 'rest'],
  tab_labels: {
    all: 'Alle',
    attention: 'Aufmerksamkeit',
    primary: 'Rest',
    rest: 'Rest',
    denzer: 'Denzer AI',
    fch: 'FCH',
    amazon: 'Amazon',
    rechnung: 'Rechnung',
    newsletter: 'Newsletter',
  },
}

function readCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeCache<T>(key: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays < 7) return d.toLocaleDateString('de-DE', { weekday: 'short' })
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

function initialsOf(label: string): string {
  const s = (label || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return s.slice(0, 2).toUpperCase()
}

function colorFor(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  const palette = ['#7a6a55', '#6a7a55', '#55706a', '#6a5a7a', '#7a5a5a', '#5a6a7a', '#7a705a']
  return palette[h % palette.length]
}

export function MailWorkspace() {
  const [accounts, setAccounts] = useState<MailAccount[]>(() => readCache('mail:accounts', []))
  const [account, setAccount] = useState<string>(() => readCache('mail:account', ''))
  const [threads, setThreads] = useState<MailThread[]>([])
  const [rules, setRules] = useState<MailRules>(() => readCache('mail:rules', DEFAULT_RULES))
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [openMail, setOpenMail] = useState<OpenMail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const folders = useMemo(() => {
    const fromRules = rules.folders && rules.folders.length > 0 ? rules.folders : DEFAULT_RULES.folders || []
    return ['all', ...fromRules.filter(folder => folder !== 'all')]
  }, [rules])

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/mail/accounts', { cache: 'no-store' })
      const data = await res.json()
      const next: MailAccount[] = Array.isArray(data.accounts) ? data.accounts : []
      setAccounts(next)
      writeCache('mail:accounts', next)
      const currentValid = next.some(a => a.key === account)
      const preferred = next.find(a => a.key === 'all')?.key || next.find(a => a.key === 'denzer')?.key || next[0]?.key || ''
      if ((!account || !currentValid) && preferred) setAccount(preferred)
    } catch {}
  }, [account])

  const loadThreads = useCallback(async (nextAccount = account, nextCategory = category, nextQuery = query) => {
    if (!nextAccount) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ account: nextAccount, limit: '80' })
      if (nextQuery.trim()) params.set('q', nextQuery.trim())
      if (nextCategory && nextCategory !== 'all') params.set('category', nextCategory)
      const res = await fetch(`/api/mail/threads?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || 'Mail nicht erreichbar')
      setThreads(Array.isArray(data.threads) ? data.threads : [])
      if (data.rules) {
        setRules(data.rules)
        writeCache('mail:rules', data.rules)
      }
    } catch (e) {
      setThreads([])
      setError(e instanceof Error ? e.message : 'Mail nicht erreichbar')
    } finally {
      setLoading(false)
    }
  }, [account, category, query])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    writeCache('mail:account', account)
    if (account) loadThreads(account)
  }, [account, loadThreads])

  const chooseCategory = useCallback((nextCategory: string) => {
    setCategory(nextCategory)
    loadThreads(account, nextCategory)
  }, [account, loadThreads])

  const submitSearch = useCallback(() => {
    loadThreads(account, category, query)
  }, [account, category, loadThreads, query])

  const toggleStar = useCallback(async (thread: MailThread) => {
    const acc = thread.account || account
    const on = !thread.starred
    setThreads(prev => prev.map(t => t.uid === thread.uid && (t.account || account) === acc ? { ...t, starred: on } : t))
    try {
      await fetch('/api/mail/star', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: acc, uid: thread.uid, on }),
      })
    } catch {
      setThreads(prev => prev.map(t => t.uid === thread.uid && (t.account || account) === acc ? { ...t, starred: !on } : t))
    }
  }, [account])

  const archiveThread = useCallback(async (thread: MailThread) => {
    const acc = thread.account || account
    if (!acc || !thread.uid) return
    const res = await fetch('/api/mail/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: acc, uid: thread.uid }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) throw new Error(data.error || 'Archivieren fehlgeschlagen')
    setThreads(prev => prev.filter(t => !(t.uid === thread.uid && (t.account || account) === acc)))
    window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
  }, [account])

  const openThread = useCallback((thread: MailThread) => {
    const acc = thread.account || account
    if (!acc || !thread.uid) return
    setOpenMail({ account: acc, uid: thread.uid })
    if (thread.unread) {
      setThreads(prev => prev.map(t => t.uid === thread.uid && (t.account || account) === acc ? { ...t, unread: false } : t))
    }
  }, [account])

  if (openMail) {
    return (
      <div className="h-full min-h-0 bg-[var(--bg)] text-[var(--t1)]">
        <MailThreadView
          account={openMail.account}
          uid={openMail.uid}
          onBack={() => {
            setOpenMail(null)
            loadThreads()
          }}
          mobile={false}
          onAction={(uid) => {
            setThreads(prev => prev.filter(thread => !((thread.account || account) === openMail.account && thread.uid === uid)))
            window.dispatchEvent(new CustomEvent('deck:inboxChanged'))
          }}
        />
      </div>
    )
  }

  const activeLabel = rules.tab_labels?.[category] || DEFAULT_RULES.tab_labels?.[category] || category
  const unreadCount = threads.filter(t => t.unread).length

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Mail · {activeLabel}</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{threads.length > 0 ? `${threads.length} Mails` : 'Mail'}</h2>
            <div className="truncate text-xs text-[var(--t3)]">{unreadCount > 0 ? `${unreadCount} ungelesen` : 'Keine ungelesenen Mails in dieser Ansicht'}</div>
          </div>
          <button type="button" onClick={() => loadThreads()} disabled={loading || !account} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>

        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          {accounts.map(item => (
            <button
              key={item.key}
              type="button"
              onClick={() => setAccount(item.key)}
              className={`max-w-[190px] truncate border px-3 py-1.5 text-xs ${account === item.key ? 'border-[var(--border-active)] bg-[var(--bg-2)] text-[var(--t1)]' : 'border-[var(--border)] text-[var(--t3)] hover:text-[var(--t1)]'}`}
              title={item.email || item.name}
            >
              {item.name || item.key}
            </button>
          ))}
          {accounts.length === 0 && <span className="text-xs text-[var(--t3)]">Kein Account konfiguriert</span>}
        </div>

        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          {folders.map(folder => {
            const label = rules.tab_labels?.[folder] || DEFAULT_RULES.tab_labels?.[folder] || folder
            return (
              <button
                key={folder}
                type="button"
                onClick={() => chooseCategory(folder)}
                className={`border px-3 py-1.5 text-xs ${category === folder ? 'border-[var(--border-active)] bg-[var(--bg-2)] text-[var(--t1)]' : 'border-[var(--border)] text-[var(--t3)] hover:text-[var(--t1)]'}`}
              >
                {label}
              </button>
            )
          })}
        </div>

        <label className="mt-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitSearch() }}
            placeholder="Im Postfach suchen"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]"
          />
        </label>
        {error && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--warm)]">{error}</div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <Inbox className="h-4 w-4 shrink-0 text-[var(--t3)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{activeLabel}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{threads.length}</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {threads.map(thread => (
              <div key={`${thread.account || account}:${thread.uid}`} className="group flex min-w-0 items-start gap-2 px-3 py-2 hover:bg-white/[0.04]">
                <div
                  className="mt-0.5 flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full text-[11px] font-medium text-white/90"
                  style={{ backgroundColor: colorFor(thread.from_raw || thread.from || '?') }}
                  aria-hidden="true"
                >
                  {initialsOf(thread.from || thread.from_raw || '?')}
                </div>
                <button type="button" onClick={() => openThread(thread)} className="min-w-0 flex-1 text-left">
                  <span className={`block truncate text-sm ${thread.unread ? 'font-medium text-[var(--t1)]' : 'text-[var(--t2)]'}`}>{thread.from || '(unbekannt)'}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--t3)]">
                    {thread.subject || '(ohne Betreff)'}
                    {thread.account_name && account === 'all' ? ` · ${thread.account_name}` : ''}
                    {thread.snippet ? ` · ${thread.snippet}` : ''}
                  </span>
                </button>
                {thread.has_attachment && <Paperclip className="mt-1 h-4 w-4 shrink-0 text-[var(--t3)]" />}
                <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtTime(thread.ts)}</span>
                <button type="button" onClick={() => toggleStar(thread)} className={`shrink-0 p-1 ${thread.starred ? 'text-[var(--warm)]' : 'text-[var(--t3)] hover:text-[var(--warm)]'}`} title={thread.starred ? 'Stern entfernen' : 'Markieren'}>
                  <Star className={thread.starred ? 'h-4 w-4 fill-current' : 'h-4 w-4'} />
                </button>
                <button type="button" onClick={() => archiveThread(thread)} className="shrink-0 p-1 text-[var(--t3)] hover:text-[var(--t1)]" title="Archivieren">
                  <Check className="h-4 w-4" />
                </button>
              </div>
            ))}
            {threads.length === 0 && <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Mails' : 'Keine Mails.'}</div>}
          </div>
        </section>
      </main>
    </div>
  )
}
