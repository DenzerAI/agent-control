import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronDown, ExternalLink, MailOpen, Star, FolderInput, Archive, Trash2, Paperclip, Download } from 'lucide-react'
import DOMPurify from 'dompurify'

// ── Mail Thread View ──

type MailAttachment = { index: number; filename: string; content_type: string; size: number }
type MailMessage = {
  uid: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  message_id: string
  body_text: string
  body_html: string
  attachments?: MailAttachment[]
  unsubscribe_url?: string
}
type ContactThreadMessage = Partial<MailMessage> & {
  id: string
  direction: 'in' | 'out'
  source: string
  ts?: number
  status?: string
  current?: boolean
}

function splitTextSignature(raw: string): { body: string; signature: string } {
  const text = (raw || '').replace(/\r\n/g, '\n').trim()
  if (!text) return { body: '', signature: '' }
  const separator = text.search(/\n-- ?\n/)
  if (separator >= 0) {
    return {
      body: text.slice(0, separator).trim(),
      signature: text.slice(separator).replace(/^\n-- ?\n/, '').trim(),
    }
  }
  const lines = text.split('\n')
  const isGreeting = (line: string) => /^(mit freundlichen grüßen|freundliche grüße|viele grüße|beste grüße|liebe grüße|kind regards|best regards|regards|mfg)[,.\s]*$/i.test(line.trim())
  const isContactLine = (line: string) => /(@|https?:\/\/|www\.|tel\.?|telefon|mobil|phone|linkedin|xing|straße|strasse|gmbh|ust|register|company ai)/i.test(line)
  const start = Math.max(0, lines.length - 14)
  for (let i = start; i < lines.length - 2; i += 1) {
    const tail = lines.slice(i).filter(l => l.trim())
    if (tail.length < 3) continue
    const contactCount = tail.filter(isContactLine).length
    if (contactCount >= 2) {
      const splitAt = i > 0 && isGreeting(lines[i - 1]) ? i - 1 : i
      return {
        body: lines.slice(0, splitAt).join('\n').trim(),
        signature: lines.slice(splitAt).join('\n').trim(),
      }
    }
  }
  return { body: text, signature: '' }
}

function splitHtmlSignature(html: string): { bodyHtml: string; signatureHtml: string } {
  if (!html || typeof DOMParser === 'undefined') return { bodyHtml: html || '', signatureHtml: '' }
  try {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
    const root = doc.body.firstElementChild
    if (!root) return { bodyHtml: html, signatureHtml: '' }
    const sigNodes = Array.from(root.querySelectorAll('*')).filter(el => {
      const marker = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`.toLowerCase()
      return marker.includes('signature') || marker.includes('gmail_signature')
    })
    if (!sigNodes.length) return { bodyHtml: html, signatureHtml: '' }
    const signatureHtml = sigNodes.map(el => el.outerHTML).join('')
    sigNodes.forEach(el => el.parentElement?.removeChild(el))
    return { bodyHtml: root.innerHTML, signatureHtml }
  } catch {
    return { bodyHtml: html, signatureHtml: '' }
  }
}

export function MailThreadView({ account, uid, onBack, onAction, mobile, footer, reloadSignal, title }: { account: string; uid: string; onBack: () => void; onAction?: (uid: string) => void; mobile?: boolean; footer?: ReactNode; reloadSignal?: number; title?: string }) {
  const [msg, setMsg] = useState<MailMessage | null>(null)
  const [threadMessages, setThreadMessages] = useState<ContactThreadMessage[]>([])
  const [answeredAfterCurrent, setAnsweredAfterCurrent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [starred, setStarred] = useState(false)
  const [labels, setLabels] = useState<string[]>([])
  const [showMove, setShowMove] = useState(false)
  const [expandedSignatures, setExpandedSignatures] = useState<Record<string, boolean>>({})
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true); setError('')
    setThreadMessages([])
    setAnsweredAfterCurrent(false)
    setExpandedSignatures({})
    fetch(`/api/mail/contact-thread?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(uid)}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        else {
          setMsg(d.message || d)
          setThreadMessages(Array.isArray(d.messages) ? d.messages : [])
          setAnsweredAfterCurrent(!!d.answered_after_current)
        }
        setLoading(false)
      })
      .catch(e => { setError(String(e)); setLoading(false) })
    fetch('/api/mail/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, uid }),
    }).catch(() => {})
  }, [account, uid])

  // Stiller Refetch nach einer gesendeten Antwort: kein "Lade..."-Flash, kein
  // erneutes mark-read. Die frisch gesendete Mail kommt aus dem Outbox-Ledger
  // und erscheint als eigene Bubble unter der eingegangenen — wie in einem Chat.
  useEffect(() => {
    if (!reloadSignal) return
    let cancelled = false
    fetch(`/api/mail/contact-thread?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(uid)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled || d.error) return
        if (d.message) setMsg(d.message)
        setThreadMessages(Array.isArray(d.messages) ? d.messages : [])
        setAnsweredAfterCurrent(!!d.answered_after_current)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [reloadSignal, account, uid])

  useEffect(() => {
    fetch(`/api/mail/labels?account=${encodeURIComponent(account)}`)
      .then(r => r.json()).then(d => setLabels(d.labels || [])).catch(() => {})
  }, [account])

  const toggleStar = useCallback(async () => {
    const next = !starred
    setStarred(next)
    try {
      await fetch('/api/mail/star', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, uid, on: next }),
      })
    } catch {
      setStarred(!next)
    }
  }, [starred, account, uid])

  const doMove = useCallback(async (label: string) => {
    setShowMove(false)
    try {
      const r = await fetch('/api/mail/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, uid, label }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      onAction?.(uid)
      onBack()
    } catch (e) {
      setError(String(e).slice(0, 200))
    }
  }, [account, uid, onAction, onBack])

  const [busy, setBusy] = useState<'' | 'archive' | 'delete'>('')
  const doArchive = useCallback(async () => {
    if (busy) return
    setBusy('archive'); setError('')
    try {
      const r = await fetch('/api/mail/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, uid }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      onAction?.(uid)
      onBack()
    } catch (e) {
      setError(String(e).slice(0, 200))
      setBusy('')
    }
  }, [busy, account, uid, onAction, onBack])
  const doDelete = useCallback(async () => {
    if (busy) return
    if (!window.confirm('Diese Mail in den Papierkorb verschieben?')) return
    setBusy('delete'); setError('')
    try {
      const r = await fetch('/api/mail/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, uid }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      onAction?.(uid)
      onBack()
    } catch (e) {
      setError(String(e).slice(0, 200))
      setBusy('')
    }
  }, [busy, account, uid, onAction, onBack])

  const markUnread = useCallback(async () => {
    if (!msg) return
    try {
      await fetch('/api/mail/mark-unread', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, uid }),
      })
      onAction?.(uid)
      onBack()
    } catch (e) {
      setError(String(e).slice(0, 200))
    }
  }, [msg, account, uid, onAction, onBack])

  const sanitizeMailHtml = useCallback((html: string) => {
    if (!html) return ''
    const hook = (node: Element) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
      }
    }
    DOMPurify.addHook('afterSanitizeAttributes', hook)
    try {
      return DOMPurify.sanitize(html, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link'],
        FORBID_ATTR: ['onclick', 'onerror', 'onload'],
      })
    } finally {
      DOMPurify.removeHook('afterSanitizeAttributes')
    }
  }, [])

  const renderMailBody = useCallback((messageKey: string, text: string, html: string) => {
    const expanded = !!expandedSignatures[messageKey]
    if ((text || '').trim()) {
      const split = splitTextSignature(text)
      return (
        <>
          <div className="info-text-body text-[var(--t1)] whitespace-pre-wrap break-words">{split.body || '(leer)'}</div>
          {split.signature && (
            <div className="mt-2">
              <button
                onClick={() => setExpandedSignatures(prev => ({ ...prev, [messageKey]: !prev[messageKey] }))}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 info-text-meta text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.05]"
              >
                <ChevronDown className={`info-icon-sm transition-transform ${expanded ? 'rotate-180' : ''}`} />
                Signatur
              </button>
              {expanded && (
                <div className="mt-1 info-text-meta text-[var(--t3)] whitespace-pre-wrap break-words">{split.signature}</div>
              )}
            </div>
          )}
        </>
      )
    }
    const split = splitHtmlSignature(html || '')
    const safeBody = sanitizeMailHtml(split.bodyHtml)
    const safeSignature = sanitizeMailHtml(split.signatureHtml)
    return (
      <>
        {safeBody ? (
          <div className="info-text-body text-[var(--t1)] mail-body" dangerouslySetInnerHTML={{ __html: safeBody }} />
        ) : (
          <div className="info-text-body text-[var(--t1)] whitespace-pre-wrap break-words">(leer)</div>
        )}
        {safeSignature && (
          <div className="mt-2">
            <button
              onClick={() => setExpandedSignatures(prev => ({ ...prev, [messageKey]: !prev[messageKey] }))}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 info-text-meta text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.05]"
            >
              <ChevronDown className={`info-icon-sm transition-transform ${expanded ? 'rotate-180' : ''}`} />
              Signatur
            </button>
            {expanded && (
              <div className="mt-1 opacity-80 mail-body" dangerouslySetInnerHTML={{ __html: safeSignature }} />
            )}
          </div>
        )}
      </>
    )
  }, [expandedSignatures, sanitizeMailHtml])

  // ── Mobile: exakt der WhatsApp-Thread-Look ──
  // Schlanker Header (Zurück, Name, Archiv), Mails als Chat-Bubbles ohne
  // Von/An/Datum-Kopf, Zeit unter der Bubble. Desktop bleibt unten unberührt.
  if (mobile) {
    const fromLabel = (raw: string) => {
      const s = (raw || '').trim()
      const m = s.match(/^(.*?)\s*<([^>]+)>/)
      if (m) return (m[1].replace(/^"|"$/g, '').trim()) || m[2]
      return s
    }
    const fmtTime = (entry: { ts?: number; date?: string }) => {
      let ts = Number(entry.ts || 0)
      if (!ts && entry.date) {
        const p = Date.parse(entry.date)
        if (!Number.isNaN(p)) ts = Math.floor(p / 1000)
      }
      if (!ts) return ''
      const d = new Date(ts * 1000)
      const now = new Date()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`
      return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}. ${hh}:${mm}`
    }
    const entries: ContactThreadMessage[] = threadMessages.length > 0
      ? threadMessages
      : (msg ? [{
          id: `single:${account}:${uid}`,
          direction: 'in' as const,
          source: 'imap',
          from: msg.from, to: msg.to, cc: msg.cc, subject: msg.subject, date: msg.date,
          body_text: msg.body_text, body_html: msg.body_html,
        }] : [])
    const headerTitle = (title || '').trim() || fromLabel(msg?.from || '') || (loading ? '' : '(Mail)')
    // Anhänge gehören unter ihre eigene Bubble, nicht gesammelt ans Thread-Ende.
    // Jede Nachricht rendert ihre eigenen Attachments, ausgerichtet wie die Bubble.
    const renderEntryAttachments = (entry: ContactThreadMessage, outgoing: boolean) => {
      const atts = entry.attachments || []
      if (atts.length === 0) return null
      const attUid = entry.uid || uid
      const imgs = atts.filter(a => (a.content_type || '').startsWith('image/'))
      const files = atts.filter(a => !(a.content_type || '').startsWith('image/'))
      return (
        <div style={{ display: 'flex', justifyContent: outgoing ? 'flex-end' : 'flex-start', marginTop: 6 }}>
          <div style={{ maxWidth: '82%', width: '100%' }}>
            {imgs.length > 0 && (
              <div className="grid grid-cols-2 gap-2" style={{ marginBottom: files.length ? 6 : 0 }}>
                {imgs.map(a => {
                  const inlineUrl = `/api/mail/attachment?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(attUid)}&index=${a.index}&inline=1`
                  const dlUrl = `/api/mail/attachment?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(attUid)}&index=${a.index}`
                  return (
                    <a key={a.index} href={dlUrl} download={a.filename} className="block rounded overflow-hidden" style={{ background: 'var(--bg-2)' }}>
                      <img src={inlineUrl} alt={a.filename} className="w-full h-32 object-cover" loading="lazy" />
                      <div style={{ padding: '4px 6px', fontSize: 11.5, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</div>
                    </a>
                  )
                })}
              </div>
            )}
            {files.map(a => {
              const kb = Math.max(1, Math.round(a.size / 1024))
              const url = `/api/mail/attachment?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(attUid)}&index=${a.index}`
              return (
                <a key={a.index} href={url} download={a.filename} className="flex items-center gap-2 rounded" style={{ padding: '8px 10px', background: 'var(--bg-2)', color: 'var(--text)', fontSize: 13, marginTop: 6 }}>
                  <Paperclip size={17} style={{ color: 'var(--t3)', flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
                  <span style={{ color: 'var(--t3)', flexShrink: 0 }}>{kb} KB</span>
                  <Download size={17} style={{ color: 'var(--t3)', flexShrink: 0 }} />
                </a>
              )
            })}
          </div>
        </div>
      )
    }

    return (
      <div className="flex flex-col h-full" style={{ background: 'var(--bg)' }}>
        <div className="mobile-hero-chrome" style={{
          display: 'flex', alignItems: 'center',
          paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1px)',
          paddingBottom: 5, paddingLeft: 16, paddingRight: 12, flexShrink: 0,
        }}>
          <button type="button" onClick={onBack} style={{ padding: 2, marginRight: 6, color: 'var(--t3)', display: 'flex' }}>
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
          <div style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 1.1, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '0.02em' }}>
            {headerTitle}
          </div>
          <button type="button" onClick={doArchive} disabled={!msg || !!busy} style={{ padding: 2, marginLeft: 8, color: 'var(--t3)', display: 'flex', opacity: (!msg || busy) ? 0.4 : 1 }}>
            <Archive size={22} strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ padding: '10px 14px 18px', overscrollBehavior: 'contain' }}>
          {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 14 }}>Lade…</div>}
          {error && !msg && <div style={{ color: 'var(--warm)', padding: '8px 2px', fontSize: 14 }}>{error}</div>}
          {msg && (
            <>
              {msg.subject && (
                <div style={{ textAlign: 'center', margin: '2px auto 12px', fontSize: 12.5, fontWeight: 600, color: 'var(--t3)', letterSpacing: '0.01em', maxWidth: '90%' }}>
                  {msg.subject}
                </div>
              )}
              {entries.map(entry => {
                const outgoing = entry.direction === 'out'
                const text = (entry.body_text || '').trim()
                const messageKey = entry.id || `${entry.source}:${entry.uid}:${entry.ts}`
                return (
                  <div key={messageKey} style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', justifyContent: outgoing ? 'flex-end' : 'flex-start' }}>
                      <div style={{
                        maxWidth: '82%',
                        padding: '9px 13px 8px',
                        borderRadius: outgoing ? '16px 16px 6px 16px' : '16px 16px 16px 6px',
                        background: outgoing ? 'var(--hover)' : 'var(--bg-2)',
                        color: 'var(--text)',
                        wordBreak: 'break-word',
                      }}>
                        {renderMailBody(messageKey, text, entry.body_html || '')}
                      </div>
                    </div>
                    {renderEntryAttachments(entry, outgoing)}
                    <div style={{
                      display: 'flex', justifyContent: outgoing ? 'flex-end' : 'flex-start',
                      fontSize: 12, color: 'color-mix(in srgb, var(--t3) 78%, var(--t1) 22%)',
                      marginTop: 4, padding: outgoing ? '0 4px 0 0' : '0 0 0 4px',
                    }}>
                      {fmtTime(entry)}
                    </div>
                  </div>
                )
              })}
              {footer}
            </>
          )}
        </div>

        {error && msg && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '8px 16px', flexShrink: 0 }}>
            <div style={{ color: '#ef4444', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className={`flex items-center gap-2 ${mobile ? 'wa-chrome-b px-5 py-2' : 'border-b border-[var(--border)] px-3 py-2'} flex-shrink-0`}>
        <button onClick={onBack} className="text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer">
          <ChevronLeft className={mobile ? 'info-icon-sm' : 'info-icon-md'} />
        </button>
        <div className="flex-1 min-w-0">
          <div className={`info-text-body text-[var(--t1)] font-medium truncate`}>{msg?.subject || (loading ? '...' : '(kein Betreff)')}</div>
          {!mobile && <div className="info-text-meta text-[var(--t3)] truncate">{msg?.from || ''}</div>}
        </div>
        {msg?.unsubscribe_url && (
          <a
            href={msg.unsubscribe_url}
            target="_blank"
            rel="noopener noreferrer"
            title="Newsletter abbestellen"
            className="p-1 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.05] cursor-pointer flex-shrink-0">
            <ExternalLink className={mobile ? 'info-icon-sm' : 'info-icon-md'} />
          </a>
        )}
        <button
          onClick={markUnread}
          disabled={!msg}
          title="Als ungelesen markieren"
          className="p-1 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-40 cursor-pointer flex-shrink-0">
          <MailOpen className={mobile ? 'info-icon-sm' : 'info-icon-md'} />
        </button>
        <button
          onClick={toggleStar}
          disabled={!msg}
          title={starred ? 'Stern entfernen' : 'Markieren'}
          className={`p-1 rounded hover:bg-white/[0.05] disabled:opacity-40 cursor-pointer flex-shrink-0 ${starred ? 'text-[#c89860]' : 'text-[var(--t3)] hover:text-[#c89860]'}`}>
          <Star className={mobile ? 'info-icon-sm' : 'info-icon-md'} fill={starred ? '#c89860' : 'none'} />
        </button>
        {labels.length > 0 && (
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowMove(v => !v)}
              disabled={!msg || !!busy}
              title="In Label verschieben"
              className="p-1 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-40 cursor-pointer">
              <FolderInput className={mobile ? 'info-icon-sm' : 'info-icon-md'} />
            </button>
            {showMove && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[200px] max-h-[300px] overflow-y-auto bg-[var(--bg-elev, #1c1c1c)] border border-[var(--border)] rounded shadow-lg py-1">
                {labels.map(l => (
                  <button key={l} onClick={() => doMove(l)}
                    className="block w-full text-left info-text-meta text-[var(--t2)] hover:text-[var(--t1)] hover:bg-white/[0.06] px-2 py-1 truncate">
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          onClick={doArchive}
          disabled={!msg || !!busy}
          title="Archivieren"
          className="p-1 rounded text-[var(--t3)] hover:text-[var(--t1)] hover:bg-white/[0.05] disabled:opacity-40 cursor-pointer flex-shrink-0">
          <Archive className={mobile ? 'info-icon-sm' : 'info-icon-md'} />
        </button>
        <button
          onClick={doDelete}
          disabled={!msg || !!busy}
          title="Löschen"
          className="p-1 rounded text-[var(--t3)] hover:text-red-400 hover:bg-white/[0.05] disabled:opacity-40 cursor-pointer flex-shrink-0">
          <Trash2 className={mobile ? 'info-icon-sm' : 'info-icon-md'} />
        </button>
      </div>

      <div ref={bodyRef} className={`flex-1 overflow-y-auto ${mobile ? 'px-4 py-3' : 'px-4 py-3'}`}>
        {loading && <div className="info-text-body text-[var(--t3)] text-center py-4">Lade...</div>}
        {error && !msg && <div className="info-text-body text-[var(--warm)]/80 py-2">{error}</div>}
        {msg && (
          <>
            {answeredAfterCurrent && (
              <div className="info-text-meta text-[var(--warm)] mb-3">
                Spätere Antwort von dir erkannt, nicht mehr Wartet.
              </div>
            )}
            {threadMessages.length > 1 ? (
              <div className="space-y-3">
                {threadMessages.map(entry => {
                  const outgoing = entry.direction === 'out'
                  const text = (entry.body_text || '').trim()
                  const messageKey = entry.id || `${entry.source}:${entry.uid}:${entry.ts}`
                  return (
                    <div key={messageKey} className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[92%] rounded-md border px-3 py-2 ${outgoing ? 'bg-[var(--warm)]/10 border-[var(--warm)]/30' : 'bg-white/[0.035] border-white/[0.08]'}`}>
                        <div className="info-text-meta text-[var(--t3)] mb-1 space-y-0.5">
                          <div className="truncate"><span className="text-[var(--t3)]/70">Von:</span> {outgoing ? 'Du' : (entry.from || 'Eingang')}</div>
                          {entry.to && <div className="truncate"><span className="text-[var(--t3)]/70">An:</span> {entry.to}</div>}
                          {entry.cc && <div className="truncate"><span className="text-[var(--t3)]/70">Cc:</span> {entry.cc}</div>}
                          {entry.subject && <div className="truncate">{entry.subject}</div>}
                          {entry.date && <div className="truncate">{entry.date}</div>}
                        </div>
                        {renderMailBody(messageKey, text, entry.body_html || '')}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <>
                <div className="info-text-meta text-[var(--t3)] mb-3 space-y-0.5">
                  <div><span className="text-[var(--t3)]/70">Von:</span> {msg.from}</div>
                  <div><span className="text-[var(--t3)]/70">An:</span> {msg.to}</div>
                  {msg.cc && <div><span className="text-[var(--t3)]/70">Cc:</span> {msg.cc}</div>}
                  {msg.date && <div><span className="text-[var(--t3)]/70">Datum:</span> {msg.date}</div>}
                </div>
                {renderMailBody(`single:${account}:${uid}`, msg.body_text || '', msg.body_html || '')}
              </>
            )}
            {msg.attachments && msg.attachments.length > 0 && (() => {
              const images = msg.attachments.filter(a => (a.content_type || '').startsWith('image/'))
              const others = msg.attachments.filter(a => !(a.content_type || '').startsWith('image/'))
              return (
                <div className="mt-4 pt-3 border-t border-[var(--border)]/60 space-y-3">
                  <div className="info-text-meta text-[var(--t3)]">Anhänge</div>
                  {images.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {images.map(a => {
                        const inlineUrl = `/api/mail/attachment?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(uid)}&index=${a.index}&inline=1`
                        const dlUrl = `/api/mail/attachment?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(uid)}&index=${a.index}`
                        return (
                          <a key={a.index} href={dlUrl} download={a.filename}
                            className="block group rounded overflow-hidden bg-white/[0.04] hover:bg-white/[0.08]">
                            <img src={inlineUrl} alt={a.filename}
                              className="w-full h-32 object-cover" loading="lazy" />
                            <div className="px-1.5 py-1 info-text-meta text-[var(--t3)] truncate">{a.filename}</div>
                          </a>
                        )
                      })}
                    </div>
                  )}
                  {others.length > 0 && (
                    <div className="space-y-1">
                      {others.map(a => {
                        const kb = Math.max(1, Math.round(a.size / 1024))
                        const url = `/api/mail/attachment?account=${encodeURIComponent(account)}&uid=${encodeURIComponent(uid)}&index=${a.index}`
                        return (
                          <a key={a.index} href={url} download={a.filename}
                            className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/[0.04] hover:bg-white/[0.08] text-[var(--t1)] info-text-meta">
                            <Paperclip className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                            <span className="truncate flex-1">{a.filename}</span>
                            <span className="text-[var(--t3)] tabular-nums flex-shrink-0">{kb} KB</span>
                            <Download className="info-icon-sm text-[var(--t3)] flex-shrink-0" />
                          </a>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}
            {footer}
          </>
        )}
      </div>

      {error && msg && (
        <div className={`border-t border-[var(--border)] ${mobile ? 'px-5 py-2.5' : 'px-4 py-2'} flex-shrink-0`}>
          <div className="info-text-meta text-red-400 truncate">{error}</div>
        </div>
      )}
    </div>
  )
}
