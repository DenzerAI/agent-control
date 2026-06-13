import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, Wallet, RefreshCw, Paperclip, Loader2, Check, Upload, X, Pencil } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { playUISound } from '../../../uiSounds'
import { MD } from '../utils/constants'
import { Guided } from '../utils/tree'
import { fmtEur, fmtEurExact } from '../utils/eur'

// ── Finanzen — Lexware Office als Single Source of Truth ──

type FinanceInvoice = { id: string; number: string; date: string; dueDate: string; contact: string; total: number; open: number; currency: string; status: string }
type FinanceVoucher = { id: string; number: string; date: string; contact: string; total: number; currency: string; status: string; type: string }
type FinanceInboxItem = { key: string; account: string; uid: string; date: string; ts: number; from: string; fromAddress: string; subject: string; kind: string; hasAttachment: boolean; firstSeen: string }
type FinanceOverview = {
  month: { label: string; income: number; expenses: number; balance: number }
  ytd: { label: string; income: number; expenses: number; balance: number }
  open: { count: number; sum: number; overdue: number }
  openInvoices: FinanceInvoice[]
  fetchedAt: string
}

function fmtShortDate(s: string): string {
  if (!s || s.length < 10) return ''
  const d = new Date(s + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}
function dueLabel(dueDate: string): { label: string; overdue: boolean } {
  if (!dueDate) return { label: '', overdue: false }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dueDate + 'T00:00:00')
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (diff === 0) return { label: 'heute fällig', overdue: false }
  if (diff === 1) return { label: 'morgen fällig', overdue: false }
  if (diff < 0) return { label: `${Math.abs(diff)}d überfällig`, overdue: true }
  if (diff <= 14) return { label: `in ${diff}d fällig`, overdue: false }
  return { label: fmtShortDate(dueDate), overdue: false }
}

export function FinanceSection({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <FinanceWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  return <FinanceInlineSection mobile={mobile} />
}

function FinanceWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={onOpenWorkspace}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Finanzen im Workspace öffnen"
      >
        <Wallet className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Finanzen</span>
      </button>
    </div>
  )
}

function FinanceInlineSection({ mobile }: { mobile?: boolean }) {
  const [overview, setOverview] = useState<FinanceOverview | null>(null)
  const [expenses, setExpenses] = useState<FinanceVoucher[] | null>(null)
  const [inbox, setInbox] = useState<FinanceInboxItem[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:financeOpen') === '1' } catch { return false }
  })
  const [openInbox, setOpenInbox] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:financeInbox') !== '0' } catch { return true }
  })
  const [openOpenInv, setOpenOpenInv] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:financeOpenInv') !== '0' } catch { return true }
  })
  const [openExpenses, setOpenExpenses] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:financeExp') === '1' } catch { return false }
  })
  const [openMissing, setOpenMissing] = useState<boolean>(() => {
    try { return localStorage.getItem('infopane:financeMissing') === '1' } catch { return false }
  })
  const [missing, setMissing] = useState<{ items: any[]; by_vendor: any[]; total_eur: number; count: number; unknown_count: number } | null>(null)

  const loadOverview = useCallback((refresh = false) => {
    setLoading(true); setError(null)
    fetch(`/api/finance/overview${refresh ? '?refresh=1' : ''}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setLoading(false); return }
        setOverview(d as FinanceOverview); setLoading(false)
      })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [])

  const loadExpenses = useCallback(() => {
    fetch('/api/finance/expenses?limit=50')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.expenses)) setExpenses(d.expenses) })
      .catch(() => {})
  }, [])

  const loadInbox = useCallback(() => {
    fetch('/api/finance/inbox')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.items)) setInbox(d.items) })
      .catch(() => {})
  }, [])

  const loadMissing = useCallback(() => {
    fetch('/api/finance/missing-receipts')
      .then(r => r.json())
      .then(d => setMissing(d))
      .catch(() => {})
  }, [])

  const triggerScan = useCallback(() => {
    setScanning(true)
    fetch('/api/finance/inbox/scan', { method: 'POST' })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.items)) setInbox(d.items) })
      .catch(() => {})
      .finally(() => setScanning(false))
  }, [])

  const dismissInbox = useCallback((key: string) => {
    setInbox(prev => prev ? prev.filter(i => i.key !== key) : prev)
    fetch('/api/finance/inbox/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }).catch(() => {})
  }, [])

  const [busyItem, setBusyItem] = useState<Record<string, 'upload' | 'done' | 'error'>>({})
  const [itemError, setItemError] = useState<Record<string, string>>({})

  const sendToLexware = useCallback(async (key: string) => {
    setBusyItem(prev => ({ ...prev, [key]: 'upload' }))
    setItemError(prev => { const n = { ...prev }; delete n[key]; return n })
    try {
      const r = await fetch('/api/finance/inbox/to-lexware', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      const d = await r.json()
      if (!r.ok || d.error) {
        setBusyItem(prev => ({ ...prev, [key]: 'error' }))
        setItemError(prev => ({ ...prev, [key]: d.error || `HTTP ${r.status}` }))
        return
      }
      setBusyItem(prev => ({ ...prev, [key]: 'done' }))
      setTimeout(() => {
        setInbox(prev => prev ? prev.filter(i => i.key !== key) : prev)
        loadOverview(true)
      }, 600)
    } catch (e) {
      setBusyItem(prev => ({ ...prev, [key]: 'error' }))
      setItemError(prev => ({ ...prev, [key]: String(e) }))
    }
  }, [loadOverview])

  useEffect(() => { if (open && overview === null) loadOverview(false) }, [open, overview, loadOverview])
  useEffect(() => { if (open && openExpenses && expenses === null) loadExpenses() }, [open, openExpenses, expenses, loadExpenses])
  useEffect(() => { if (open && openMissing && missing === null) loadMissing() }, [open, openMissing, missing, loadMissing])
  useEffect(() => { if (open && inbox === null) loadInbox() }, [open, inbox, loadInbox])
  useEffect(() => { try { localStorage.setItem('infopane:financeOpen', open ? '1' : '0') } catch {} }, [open])
  useEffect(() => { try { localStorage.setItem('infopane:financeInbox', openInbox ? '1' : '0') } catch {} }, [openInbox])
  useEffect(() => { try { localStorage.setItem('infopane:financeOpenInv', openOpenInv ? '1' : '0') } catch {} }, [openOpenInv])
  useEffect(() => { try { localStorage.setItem('infopane:financeExp', openExpenses ? '1' : '0') } catch {} }, [openExpenses])
  useEffect(() => { try { localStorage.setItem('infopane:financeMissing', openMissing ? '1' : '0') } catch {} }, [openMissing])

  const renderKv = (label: string, value: string, accent?: 'pos' | 'neg' | null) => (
    <div className="flex items-baseline gap-2 py-[3px] pl-1" style={{ paddingRight: mobile ? '16px' : '12px' }}>
      <span className="info-text-body text-[var(--t3)] flex-1">{label}</span>
      <span className={`info-text-body tabular-nums ${accent === 'pos' ? 'text-[var(--green)]' : accent === 'neg' ? 'text-[#ef4444]' : 'text-[var(--t2)]'}`}>{value}</span>
    </div>
  )

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => { playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUISound(open ? 'section-close' : 'section-open'); setOpen(v => !v) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Wallet className="info-icon-md mr-2 text-[var(--t3)] flex-shrink-0" />
        <span className="text-[var(--t2)] font-medium">Finanzen</span>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); loadOverview(true) }}
            disabled={loading}
            className={`ml-2 p-0.5 text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer disabled:opacity-40 flex-shrink-0 transition-opacity ${loading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            title="Neu laden">
            <RefreshCw className={`info-icon-sm ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
        <span className="flex-1" />
      </div>
      {open && (
        <div className="pb-2">
          <Guided>
          {error && <div className="info-text-meta text-[#ef4444]/80 py-2 pl-1">Lexware: {error}</div>}
          {!error && !overview && loading && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">lade…</div>}
          {overview && (
            <>
              {/* ── Übersicht: Monat + YTD ── */}
              <div className="pt-1 pb-1 pl-1 info-text-meta text-[var(--t3)]/50 uppercase tracking-[0.08em] font-medium">{overview.month.label}</div>
              {renderKv('Einnahmen', fmtEurExact(overview.month.income), overview.month.income > 0 ? 'pos' : null)}
              {renderKv('Ausgaben', fmtEurExact(overview.month.expenses), overview.month.expenses > 0 ? 'neg' : null)}
              {renderKv('Saldo', fmtEurExact(overview.month.balance), overview.month.balance >= 0 ? 'pos' : 'neg')}

              <div className="pt-3 pb-1 pl-1 info-text-meta text-[var(--t3)]/50 uppercase tracking-[0.08em] font-medium">{overview.ytd.label}</div>
              {renderKv('Einnahmen', fmtEurExact(overview.ytd.income), overview.ytd.income > 0 ? 'pos' : null)}
              {renderKv('Ausgaben', fmtEurExact(overview.ytd.expenses), overview.ytd.expenses > 0 ? 'neg' : null)}
              {renderKv('Saldo', fmtEurExact(overview.ytd.balance), overview.ytd.balance >= 0 ? 'pos' : 'neg')}

              {/* ── Zu prüfen: Mail-Scan-Treffer ── */}
              <div className="mt-2">
                <div className="flex items-center">
                  <button
                    onClick={() => { playUISound(openInbox ? 'section-close' : 'section-open'); setOpenInbox(v => !v) }}
                    className={`flex-1 flex items-center pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
                    <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${openInbox ? 'rotate-90' : ''}`} />
                    <span className="text-[var(--t3)] flex-1">Zu prüfen</span>
                    {inbox && inbox.length > 0 && (
                      <span className="info-text-meta tabular-nums text-[var(--t3)]">{inbox.length}</span>
                    )}
                  </button>
                  <button
                    onClick={triggerScan}
                    disabled={scanning}
                    className={`${mobile ? 'p-2' : 'p-1.5'} mr-1 rounded hover:bg-white/[0.06] text-[var(--t3)] hover:text-[var(--t2)] transition-colors flex-shrink-0 disabled:opacity-40`}
                    title="Jetzt scannen">
                    <RefreshCw className={`info-icon-sm ${scanning ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                {openInbox && (
                  <Guided>
                    {inbox === null && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">lade…</div>}
                    {inbox && inbox.length === 0 && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Nichts offen.</div>}
                    {inbox && inbox.map(it => {
                      const state = busyItem[it.key]
                      const err = itemError[it.key]
                      return (
                        <div key={it.key}
                          className={`group flex flex-col pl-1 ${mobile ? 'py-2' : 'py-1'} hover:bg-white/[0.04] transition-colors`}
                          style={{ paddingRight: mobile ? '16px' : '12px' }}>
                          <div className="flex items-center gap-2">
                            <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 w-[36px]">{fmtShortDate(it.date)}</span>
                            {it.hasAttachment && <Paperclip className="info-icon-sm text-[var(--t3)]/60 flex-shrink-0" />}
                            <span className="info-text-meta text-[var(--t3)]/80 truncate flex-shrink-0 max-w-[120px]" title={it.fromAddress}>{it.kind}</span>
                            <span className="info-text-body text-[var(--t2)] truncate flex-1" title={it.subject}>{it.subject}</span>
                            {state === 'upload' && (
                              <Loader2 className="info-icon-sm animate-spin text-[var(--t3)]/70 flex-shrink-0" />
                            )}
                            {state === 'done' && (
                              <Check className="info-icon-sm text-[var(--green)] flex-shrink-0" />
                            )}
                            {state !== 'upload' && state !== 'done' && it.hasAttachment && (
                              <button
                                onClick={() => sendToLexware(it.key)}
                                className={`${mobile ? 'px-2 py-1 opacity-90' : 'px-1.5 py-0.5 opacity-0 group-hover:opacity-100'} rounded hover:bg-white/[0.08] text-[var(--t3)] hover:text-[var(--t2)] info-text-meta transition-all flex-shrink-0 inline-flex items-center gap-1`}
                                title="Beleg in Lexware hochladen">
                                <Upload className="info-icon-sm" />
                                <span className="hidden sm:inline">Lexware</span>
                              </button>
                            )}
                            <button
                              onClick={() => dismissInbox(it.key)}
                              className={`${mobile ? 'p-1.5 opacity-60' : 'p-0.5 opacity-0 group-hover:opacity-100'} rounded hover:bg-white/[0.08] text-[var(--t3)] hover:text-[var(--t2)] transition-all flex-shrink-0`}
                              title="Ignorieren">
                              <X className="info-icon-sm" />
                            </button>
                          </div>
                          {err && (
                            <div className="info-text-meta text-[#ef4444]/80 truncate" style={{ paddingLeft: '40px' }} title={err}>{err}</div>
                          )}
                        </div>
                      )
                    })}
                  </Guided>
                )}
              </div>

              {/* ── Offene Rechnungen ── */}
              <div className="mt-1">
                <button
                  onClick={() => { playUISound(openOpenInv ? 'section-close' : 'section-open'); setOpenOpenInv(v => !v) }}
                  className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
                  <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${openOpenInv ? 'rotate-90' : ''}`} />
                  <span className="text-[var(--t3)] flex-1">Offene Rechnungen</span>
                  {overview.open.count > 0 && (
                    <span className="info-text-meta tabular-nums text-[var(--t3)]">
                      {overview.open.overdue > 0 && <span className="text-[#ef4444]/80">{overview.open.overdue} überfällig · </span>}
                      {overview.open.count} · {fmtEur(overview.open.sum)}
                    </span>
                  )}
                </button>
                {openOpenInv && (
                  <Guided>
                    {overview.openInvoices.length === 0 && (
                      <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Alles bezahlt.</div>
                    )}
                    {overview.openInvoices.map(inv => {
                      const due = dueLabel(inv.dueDate)
                      return (
                        <a key={inv.id}
                          href={`/api/lexware/invoices/${inv.id}/pdf`} target="_blank" rel="noopener noreferrer"
                          className={`group flex items-center gap-2 pl-1 ${mobile ? 'py-2' : 'py-1'} cursor-pointer hover:bg-white/[0.04] active:bg-white/[0.08] transition-colors no-underline`}
                          style={{ paddingRight: mobile ? '16px' : '12px' }}>
                          <span className="info-text-body text-[var(--t2)] tabular-nums flex-shrink-0">{inv.number || '—'}</span>
                          <span className="info-text-body text-[var(--t3)] truncate flex-1">{inv.contact || '—'}</span>
                          {due.label && (
                            <span className={`info-text-meta tabular-nums flex-shrink-0 ${due.overdue ? 'text-[#ef4444]/80' : 'text-[var(--t3)]/60'}`}>{due.label}</span>
                          )}
                          <span className="info-text-body tabular-nums text-[var(--t2)] flex-shrink-0">{fmtEurExact(inv.open || inv.total)}</span>
                        </a>
                      )
                    })}
                  </Guided>
                )}
              </div>

              {/* ── Belege/Eingangsrechnungen ── */}
              <div className="mt-1">
                <button
                  onClick={() => { playUISound(openExpenses ? 'section-close' : 'section-open'); setOpenExpenses(v => !v) }}
                  className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
                  <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${openExpenses ? 'rotate-90' : ''}`} />
                  <span className="text-[var(--t3)] flex-1">Belege</span>
                  {expenses && (
                    <span className="info-text-meta tabular-nums text-[var(--t3)]">{expenses.length}</span>
                  )}
                </button>
                {openExpenses && (
                  <Guided>
                    {expenses === null && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">lade…</div>}
                    {expenses && expenses.length === 0 && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Keine Belege.</div>}
                    {expenses && expenses.map(v => (
                      <div key={v.id}
                        className={`group flex items-center gap-2 pl-1 ${mobile ? 'py-2' : 'py-1'}`}
                        style={{ paddingRight: mobile ? '16px' : '12px' }}>
                        <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0 w-[36px]">{fmtShortDate(v.date)}</span>
                        <span className="info-text-body text-[var(--t3)] truncate flex-1">{v.contact || v.number || '—'}</span>
                        <span className="info-text-body tabular-nums text-[var(--t2)] flex-shrink-0">{fmtEurExact(v.total)}</span>
                      </div>
                    ))}
                  </Guided>
                )}
              </div>

              {/* ── Offene Belege: Mail-Snapshots ohne PDF ── */}
              <div className="mt-1">
                <button
                  onClick={() => { playUISound(openMissing ? 'section-close' : 'section-open'); setOpenMissing(v => !v) }}
                  className={`w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-1.5'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}>
                  <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${openMissing ? 'rotate-90' : ''}`} />
                  <span className="text-[var(--t3)] flex-1">Offene Belege</span>
                  {missing && (
                    <span className="info-text-meta tabular-nums text-[var(--t3)]">{missing.count}{missing.total_eur > 0 ? ` · ${fmtEur(missing.total_eur)}` : ''}</span>
                  )}
                </button>
                {openMissing && (
                  <Guided>
                    {missing === null && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">lade…</div>}
                    {missing && missing.by_vendor && missing.by_vendor.length === 0 && <div className="info-text-meta text-[var(--t3)]/50 py-2 pl-1">Keine offenen Belege.</div>}
                    {missing && missing.by_vendor && missing.by_vendor.map(v => (
                      <div key={v.vendor}
                        className={`group flex items-center gap-2 pl-1 ${mobile ? 'py-2' : 'py-1'}`}
                        style={{ paddingRight: mobile ? '16px' : '12px' }}
                        title={v.status === 'manual_portal' ? 'Login im Portal noetig' : 'Mail-Snapshot, kein PDF verfuegbar'}>
                        <span className={`info-text-meta tabular-nums flex-shrink-0 w-[36px] ${v.status === 'manual_portal' ? 'text-[var(--cc-orange)]/80' : 'text-[var(--t3)]'}`}>{v.count}×</span>
                        <span className="info-text-body text-[var(--t3)] truncate flex-1">{v.label}</span>
                        <span className="info-text-body tabular-nums text-[var(--t2)] flex-shrink-0">
                          {v.sum_eur > 0 ? fmtEur(v.sum_eur) : '—'}
                          {v.unknown > 0 && <span className="text-[var(--t3)]/60 ml-1">+{v.unknown}?</span>}
                        </span>
                      </div>
                    ))}
                    {missing && missing.total_eur > 0 && (
                      <div className={`flex items-center gap-2 mt-1 pl-1 ${mobile ? 'py-2' : 'py-1'} border-t border-white/5`}
                        style={{ paddingRight: mobile ? '16px' : '12px' }}>
                        <span className="info-text-body text-[var(--t3)] flex-1">Summe</span>
                        <span className="info-text-body tabular-nums text-[var(--t2)]">{fmtEur(missing.total_eur)}</span>
                      </div>
                    )}
                  </Guided>
                )}
              </div>
            </>
          )}
          </Guided>
        </div>
      )}
    </div>
  )
}


export function EditableMarkdown({ content, filePath }: { content: string; filePath: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(content)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(content) }, [content])

  const save = async () => {
    setSaving(true)
    await fetch('/api/file', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: draft })
    })
    setSaving(false); setEditing(false)
  }

  if (editing) {
    return (
      <div>
        <textarea value={draft} onChange={e => setDraft(e.target.value)}
          className="w-full h-[240px] bg-[var(--bg-1)] border border-[var(--border)] rounded-lg p-3 info-text-body font-mono text-[var(--t2)] outline-none resize-none" />
        <div className="flex gap-3 mt-2">
          <button onClick={save} disabled={saving}
            className="info-text-body text-[var(--green)] hover:text-[var(--t1)] cursor-pointer flex items-center gap-1">
            <Check className="info-icon-sm" /> {saving ? '...' : 'Speichern'}
          </button>
          <button onClick={() => { setEditing(false); setDraft(content) }}
            className="info-text-body text-[var(--t3)] hover:text-[var(--t1)] cursor-pointer flex items-center gap-1">
            <X className="info-icon-sm" /> Abbrechen
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group relative bg-[var(--bg-1)] rounded-lg p-3">
      <div className={MD} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(content) as string) }} />
      <button onClick={() => setEditing(true)}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer transition-opacity"
        title="Bearbeiten">
        <Pencil className="info-icon-sm" />
      </button>
    </div>
  )
}
