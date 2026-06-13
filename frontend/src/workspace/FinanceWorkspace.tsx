import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileText, Paperclip, Receipt, RefreshCw, ShieldCheck, Target, TrendingUp, Wallet } from 'lucide-react'

type FinanceInvoice = { id: string; number: string; date: string; dueDate: string; contact: string; total: number; open: number; currency: string; status: string }
type FinanceVoucher = { id: string; number: string; date: string; contact: string; total: number; currency: string; status: string; type: string }
type FinanceInboxItem = { key: string; account: string; uid: string; date: string; ts: number; from: string; fromAddress: string; subject: string; kind: string; hasAttachment: boolean; firstSeen: string }
type FinanceOverview = {
  month: { label: string; income: number; expenses: number; balance: number }
  ytd: { label: string; income: number; expenses: number; balance: number }
  open: { count: number; sum: number; overdue: number }
  openInvoices: FinanceInvoice[]
  history?: { firstDate: string; lastDate: string; months: number; income: number; expenses: number; balance: number; monthly: Array<{ month: string; label: string; income: number; expenses: number; balance: number }> }
  fetchedAt: string
}
type MissingVendor = { vendor: string; label: string; count: number; sum_eur: number; unknown: number; status: string }
type FinanceMissing = { items: unknown[]; by_vendor: MissingVendor[]; total_eur: number; count: number; unknown_count: number }
type FinanceTaxCockpit = { path: string; content: string; updatedAt: string }
type StripePeriod = { label: string; incomeGross: number; fees: number; net: number; refunds: number; payouts: number; count: number }
type StripeTransaction = { id: string; date: string; type: string; description: string; amount: number; fee: number; net: number; currency: string }
type FinanceStripe = { configured: boolean; mode?: string; month?: StripePeriod; ytd?: StripePeriod; recent?: StripeTransaction[]; fetchedAt?: string | null; error?: string }

type FinanceCache = {
  overview: FinanceOverview | null
  expenses: FinanceVoucher[]
  inbox: FinanceInboxItem[]
  missing: FinanceMissing | null
  tax: FinanceTaxCockpit | null
  stripe: FinanceStripe | null
  received_at: string
}

const CACHE_KEY = 'workspace:finance:state'
const EMPTY_MISSING: FinanceMissing = { items: [], by_vendor: [], total_eur: 0, count: 0, unknown_count: 0 }
const FINANCE_CHECKLIST_PATH = 'work/artifacts/2026-06-10-finanzdaten-checkliste.html'
const SELF_EMPLOYMENT_EXPLAINER_PATH = 'work/artifacts/2026-06-13-selbststaendigkeit-kalkulator.html'
const SELF_EMPLOYMENT_NET_TARGET = 3000
const SELF_EMPLOYMENT_TAX_RATE = 0.32
const SELF_EMPLOYMENT_HEALTHCARE = 900
const SELF_EMPLOYMENT_PENSION = 450
const SELF_EMPLOYMENT_INSURANCE = 150
const SELF_EMPLOYMENT_MIN_BUSINESS_COSTS = 500
const SELF_EMPLOYMENT_BUFFER_RATE = 0.15
const SELF_EMPLOYMENT_PRIVATE_BUFFER_MONTHS = 6
const SELF_EMPLOYMENT_STABLE_MONTHS = 6

function readCache(): FinanceCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { overview: null, expenses: [], inbox: [], missing: null, tax: null, stripe: null, received_at: '' }
    const parsed = JSON.parse(raw) as FinanceCache
    return {
      overview: parsed.overview ?? null,
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      inbox: Array.isArray(parsed.inbox) ? parsed.inbox : [],
      missing: parsed.missing ?? null,
      tax: parsed.tax ?? null,
      stripe: parsed.stripe ?? null,
      received_at: parsed.received_at || '',
    }
  } catch { return { overview: null, expenses: [], inbox: [], missing: null, tax: null, stripe: null, received_at: '' } }
}

function writeCache(cache: FinanceCache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)) } catch {}
}

function openWorkspaceFile(path: string) {
  window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path } }))
}

function fmtEur(n?: number): string {
  return (n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
}

function fmtPercent(n: number): string {
  return `${Math.round(n)} %`
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const ms = ts > 10_000_000_000 ? ts : ts * 1000
  const age = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (age < 60) return 'gerade'
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  return `vor ${Math.floor(age / 86400)}d`
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

function fetchJson(url: string, init?: RequestInit, timeoutMs = 16000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { cache: 'no-store', ...init, signal: ctrl.signal })
    .then(async res => {
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || res.statusText)
      return data
    })
    .finally(() => window.clearTimeout(timer))
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: 'pos' | 'neg' | null }) {
  return (
    <section className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="truncate text-[11px] leading-4 text-[var(--t3)]">{label}</div>
      <div className={`truncate text-sm font-medium tabular-nums ${accent === 'pos' ? 'text-[var(--green)]' : accent === 'neg' ? 'text-[var(--red)]' : 'text-[var(--t1)]'}`}>{value}</div>
    </section>
  )
}

function Ledger({ label, income, expenses, balance }: { label: string; income: number; expenses: number; balance: number }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">{label}</div>
      <div className="divide-y divide-[var(--border)]">
        <Row k="Einnahmen" v={fmtEur(income)} accent={income > 0 ? 'pos' : null} />
        <Row k="Ausgaben" v={fmtEur(expenses)} accent={expenses > 0 ? 'neg' : null} />
        <Row k="Saldo" v={fmtEur(balance)} accent={balance >= 0 ? 'pos' : 'neg'} bold />
      </div>
    </section>
  )
}

function Row({ k, v, accent, bold }: { k: string; v: string; accent?: 'pos' | 'neg' | null; bold?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 px-3 py-2">
      <span className={`min-w-0 flex-1 truncate text-sm ${bold ? 'text-[var(--t1)] font-medium' : 'text-[var(--t2)]'}`}>{k}</span>
      <span className={`shrink-0 text-sm tabular-nums ${accent === 'pos' ? 'text-[var(--green)]' : accent === 'neg' ? 'text-[var(--red)]' : bold ? 'text-[var(--t1)] font-medium' : 'text-[var(--t2)]'}`}>{v}</span>
    </div>
  )
}

function Panel({ title, count, children }: { title: string; count?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{title}</span>
        {count && <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{count}</span>}
      </div>
      {children}
    </section>
  )
}

function TaxCockpitPanel({ tax }: { tax: FinanceTaxCockpit | null }) {
  const updated = tax?.updatedAt ? fmtAge(new Date(tax.updatedAt).getTime()) : ''
  const source = tax?.path || 'data/finance/steuer-cockpit.md'

  return (
    <Panel title="Steuer-Cockpit" count={updated ? `Quelle ${updated}` : undefined}>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        <Stat label="Status" value="Kleinunternehmer" />
        <Stat label="Umsatzsteuer" value="0,00 €" />
        <Stat label="Vorauszahlung" value="ca. 1.200 €/Quartal" />
        <Stat label="Letzte Zahlung" value="1.028 € am 30.03.2026" />
      </div>
      <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2">
        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">Rechnung</div>
          <div className="divide-y divide-[var(--border)]">
            <Row k="EÜR" v="Einnahmen - Ausgaben" />
            <Row k="Steuer grob" v="Gewinn + privat" />
            <Row k="USt/Vorsteuer" v="aktuell 0 €" bold />
          </div>
        </section>
        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">Fehlt noch</div>
          <div className="divide-y divide-[var(--border)]">
            <Row k="2024" v="Rechnungen + Konto" />
            <Row k="Bank" v="Bank-Auszüge" />
            <Row k="Finanzamt" v="Vorauszahlungsbescheid" />
          </div>
        </section>
      </div>
      <div className="border-t border-[var(--border)] px-3 py-2 text-[11px] leading-4 text-[var(--t3)]">
        Quelle: {source}. Die 1.200 € sind als Einkommensteuer-Vorauszahlung behandelt, nicht als Vorsteuer.
      </div>
      <button
        type="button"
        onClick={() => openWorkspaceFile(FINANCE_CHECKLIST_PATH)}
        className="flex w-full min-w-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-left text-sm text-[var(--t2)] hover:bg-white/[0.04]"
      >
        <FileText className="h-4 w-4 shrink-0 text-[var(--t3)]" />
        <span className="min-w-0 flex-1 truncate">HTML öffnen: Was fehlt noch?</span>
        <span className="shrink-0 text-[11px] text-[var(--t3)]">Checkliste</span>
      </button>
    </Panel>
  )
}

function StripePanel({ stripe }: { stripe: FinanceStripe | null }) {
  const updated = stripe?.fetchedAt ? fmtAge(new Date(stripe.fetchedAt).getTime()) : ''
  const recent = Array.isArray(stripe?.recent) ? stripe.recent : []

  if (!stripe?.configured) {
    return (
      <Panel title="Stripe" count="nicht verbunden">
        <div className="px-3 py-3 text-sm leading-5 text-[var(--t3)]">Bereit, sobald `STRIPE_SECRET_KEY` lokal gesetzt ist.</div>
      </Panel>
    )
  }

  if (stripe.error) {
    return (
      <Panel title="Stripe" count="Fehler">
        <div className="px-3 py-3 text-sm leading-5 text-[var(--warm)]">{stripe.error}</div>
      </Panel>
    )
  }

  const month = stripe.month
  const ytd = stripe.ytd
  return (
    <Panel title="Stripe" count={updated ? `Quelle ${updated}` : undefined}>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-3">
        <Stat label="Monat brutto" value={fmtEur(month?.incomeGross)} accent={(month?.incomeGross || 0) > 0 ? 'pos' : null} />
        <Stat label="Gebühren Monat" value={fmtEur(month?.fees)} accent={(month?.fees || 0) > 0 ? 'neg' : null} />
        <Stat label="Netto Monat" value={fmtEur(month?.net)} accent={(month?.net || 0) >= 0 ? 'pos' : 'neg'} />
      </div>
      <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2">
        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">Jahr</div>
          <div className="divide-y divide-[var(--border)]">
            <Row k="Brutto" v={fmtEur(ytd?.incomeGross)} accent={(ytd?.incomeGross || 0) > 0 ? 'pos' : null} />
            <Row k="Gebühren" v={fmtEur(ytd?.fees)} accent={(ytd?.fees || 0) > 0 ? 'neg' : null} />
            <Row k="Netto" v={fmtEur(ytd?.net)} accent={(ytd?.net || 0) >= 0 ? 'pos' : 'neg'} bold />
          </div>
        </section>
        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">Letzte Stripe-Buchungen</div>
          {recent.length === 0 ? (
            <div className="px-3 py-3 text-sm text-[var(--t3)]">Keine Buchungen im laufenden Jahr.</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {recent.slice(0, 5).map(tx => (
                <div key={tx.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtShortDate(tx.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--t2)]">{tx.description || tx.type}</span>
                  <span className="shrink-0 text-sm tabular-nums text-[var(--t1)]">{fmtEur(tx.net)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="border-t border-[var(--border)] px-3 py-2 text-[11px] leading-4 text-[var(--t3)]">
        Stripe-Brutto zählt als Einnahme, Stripe-Gebühren separat als Ausgabe.
      </div>
    </Panel>
  )
}

function SelfEmploymentPanel({ overview, stripe }: { overview: FinanceOverview; stripe: FinanceStripe | null }) {
  const stripeMonthNet = stripe?.configured && !stripe.error ? stripe.month?.net ?? 0 : 0
  const recentMonths = (overview.history?.monthly ?? []).slice(-3)
  const threeMonthAverage = recentMonths.length > 0
    ? recentMonths.reduce((sum, month) => sum + month.income, 0) / recentMonths.length
    : 0
  const currentMonthRevenue = Math.max(0, overview.month.income + stripeMonthNet)
  const businessCosts = Math.max(overview.month.expenses || 0, SELF_EMPLOYMENT_MIN_BUSINESS_COSTS)
  const protection = SELF_EMPLOYMENT_HEALTHCARE + SELF_EMPLOYMENT_PENSION + SELF_EMPLOYMENT_INSURANCE
  const requiredProfit = (SELF_EMPLOYMENT_NET_TARGET + protection) / (1 - SELF_EMPLOYMENT_TAX_RATE)
  const targetRevenue = (requiredProfit + businessCosts) * (1 + SELF_EMPLOYMENT_BUFFER_RATE)
  const indexBase = Math.max(currentMonthRevenue, threeMonthAverage)
  const gap = Math.max(0, targetRevenue - indexBase)
  const index = targetRevenue > 0 ? Math.min(100, (indexBase / targetRevenue) * 100) : 0
  const privateBuffer = SELF_EMPLOYMENT_NET_TARGET * SELF_EMPLOYMENT_PRIVATE_BUFFER_MONTHS
  const stableMonths = (overview.history?.monthly ?? []).filter(month => month.income >= targetRevenue).length
  const status = index >= 100 ? 'prüfbar' : index >= 75 ? 'nah dran' : index >= 50 ? 'aufbauen' : 'zu früh'
  const statusAccent = index >= 100 ? 'pos' : index >= 50 ? null : 'neg'

  return (
    <Panel title="Selbstständigkeit" count={`Index ${fmtPercent(index)}`}>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-4">
        <Stat label="Ausstiegs-Index" value={fmtPercent(index)} accent={statusAccent} />
        <Stat label="Zielumsatz/Monat" value={fmtEur(targetRevenue)} />
        <Stat label="Index-Basis" value={fmtEur(indexBase)} accent={indexBase > 0 ? 'pos' : null} />
        <Stat label="Lücke" value={fmtEur(gap)} accent={gap > 0 ? 'neg' : 'pos'} />
      </div>

      <div className="grid grid-cols-1 gap-3 px-3 pb-3 lg:grid-cols-3">
        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">
            <Target className="h-3.5 w-3.5" />
            Ziel
          </div>
          <div className="divide-y divide-[var(--border)]">
            <Row k="Job-Ersatzwert" v={fmtEur(SELF_EMPLOYMENT_NET_TARGET)} bold />
            <Row k="Krankenversicherung" v={fmtEur(SELF_EMPLOYMENT_HEALTHCARE)} />
            <Row k="Altersvorsorge" v={fmtEur(SELF_EMPLOYMENT_PENSION)} />
            <Row k="Versicherungen" v={fmtEur(SELF_EMPLOYMENT_INSURANCE)} />
          </div>
        </section>

        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Sicherheitsregeln
          </div>
          <div className="divide-y divide-[var(--border)]">
            <Row k="Steuerpuffer" v={fmtPercent(SELF_EMPLOYMENT_TAX_RATE * 100)} />
            <Row k="Schwankungspuffer" v={fmtPercent(SELF_EMPLOYMENT_BUFFER_RATE * 100)} />
            <Row k="Privater Puffer" v={fmtEur(privateBuffer)} bold />
            <Row k="Stabile Monate" v={`${stableMonths}/${SELF_EMPLOYMENT_STABLE_MONTHS}`} />
          </div>
        </section>

        <section className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--t3)]">
            <TrendingUp className="h-3.5 w-3.5" />
            Ampel
          </div>
          <div className="divide-y divide-[var(--border)]">
            <Row k="Stand" v={status} accent={statusAccent} bold />
            <Row k="Automatisch" v="Lexware komplett + Stripe" />
            <Row k="Annahmen" v="Puffer + Absicherung" />
            <Row k="Business-Kosten" v={fmtEur(businessCosts)} />
            <Row k="Daten fehlen" v="Gehalt, Fixkosten, Kasse" />
          </div>
        </section>
      </div>

      <div className="border-t border-[var(--border)] px-3 py-2 text-[11px] leading-4 text-[var(--t3)]">
        Automatisch einfließend: Lexware seit Gründung, Monatsverlauf, aktuelle Lexware-Ausgaben und Stripe-Netto. Die Index-Basis nimmt den stärkeren Wert aus aktuellem Monat und 3-Monats-Schnitt.
      </div>
      <button
        type="button"
        onClick={() => openWorkspaceFile(SELF_EMPLOYMENT_EXPLAINER_PATH)}
        className="flex w-full min-w-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-left text-sm text-[var(--t2)] hover:bg-white/[0.04]"
      >
        <FileText className="h-4 w-4 shrink-0 text-[var(--t3)]" />
        <span className="min-w-0 flex-1 truncate">HTML öffnen: Wie der Ausstiegs-Index rechnet</span>
        <span className="shrink-0 text-[11px] text-[var(--t3)]">Erklärung</span>
      </button>
    </Panel>
  )
}

export function FinanceWorkspace() {
  const [cache, setCache] = useState<FinanceCache>(() => readCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError('')
    try {
      const [ov, exp, inb, miss, tax, stripe] = await Promise.all([
        fetchJson(`/api/finance/overview${refresh ? '?refresh=1' : ''}`),
        fetchJson('/api/finance/expenses?limit=50').catch(() => ({ expenses: [] })),
        fetchJson('/api/finance/inbox').catch(() => ({ items: [] })),
        fetchJson('/api/finance/missing-receipts').catch(() => EMPTY_MISSING),
        fetchJson('/api/finance/tax-cockpit').catch(() => null),
        fetchJson(`/api/finance/stripe${refresh ? '?refresh=1' : ''}`).catch(() => null),
      ])
      if ((ov as { error?: string }).error) throw new Error((ov as { error: string }).error)
      const next: FinanceCache = {
        overview: ov as FinanceOverview,
        expenses: Array.isArray((exp as { expenses?: unknown }).expenses) ? (exp as { expenses: FinanceVoucher[] }).expenses : [],
        inbox: Array.isArray((inb as { items?: unknown }).items) ? (inb as { items: FinanceInboxItem[] }).items : [],
        missing: (miss as FinanceMissing) ?? EMPTY_MISSING,
        tax: tax as FinanceTaxCockpit | null,
        stripe: stripe as FinanceStripe | null,
        received_at: new Date().toISOString(),
      }
      setCache(next)
      writeCache(next)
    } catch (e) {
      setError(`Lexware gerade nicht erreichbar, letzter Stand bleibt: ${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(() => load(), 180000)
    return () => window.clearInterval(id)
  }, [load])

  const { overview, expenses, inbox, missing, tax, stripe } = cache
  const headline = useMemo(() => {
    if (!overview) return 'Noch kein Stand'
    if (overview.open.overdue > 0) return `${overview.open.overdue} Rechnung${overview.open.overdue === 1 ? '' : 'en'} überfällig`
    if (overview.open.count > 0) return `${overview.open.count} offene Rechnung${overview.open.count === 1 ? '' : 'en'}`
    return 'Alles bezahlt'
  }, [overview])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Finanzen · Lexware · Stripe</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{headline}</h2>
            <div className="truncate text-xs text-[var(--t3)]">Letzter Stand {cache.received_at ? fmtAge(new Date(cache.received_at).getTime()) : 'nie'}</div>
          </div>
          <button type="button" onClick={() => load(true)} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        {overview && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label="Offen" value={overview.open.count} />
            <Stat label="Summe offen" value={fmtEur(overview.open.sum)} />
            <Stat label="Überfällig" value={overview.open.overdue} accent={overview.open.overdue > 0 ? 'neg' : null} />
          </div>
        )}
        {error && <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs leading-5 text-[var(--warm)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {!overview && loading && (
          <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-[var(--t3)]">Lade letzten Stand</div>
        )}
        {!overview && !loading && (
          <div className="flex h-full min-h-[220px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-6 text-center">
            <div><Wallet className="mx-auto mb-3 h-6 w-6 text-[var(--t3)]" /><div className="text-sm font-medium text-[var(--t1)]">Kein Stand geladen</div><div className="mt-1 text-xs leading-5 text-[var(--t3)]">Lexware liefert Monat, Jahr, offene Rechnungen und offene Belege.</div></div>
          </div>
        )}
        {overview && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Ledger label={overview.month.label} income={overview.month.income} expenses={overview.month.expenses} balance={overview.month.balance} />
              <Ledger label={overview.ytd.label} income={overview.ytd.income} expenses={overview.ytd.expenses} balance={overview.ytd.balance} />
            </div>

            <SelfEmploymentPanel overview={overview} stripe={stripe} />

            <TaxCockpitPanel tax={tax} />

            <StripePanel stripe={stripe} />

            <Panel title="Offene Rechnungen" count={overview.open.count > 0 ? `${overview.open.count} · ${fmtEur(overview.open.sum)}` : undefined}>
              {overview.openInvoices.length === 0 ? (
                <div className="px-3 py-3 text-sm text-[var(--t3)]">Alles bezahlt.</div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {overview.openInvoices.map(inv => {
                    const due = dueLabel(inv.dueDate)
                    return (
                      <a key={inv.id} href={`/api/lexware/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"
                        className="flex min-w-0 items-center gap-2 px-3 py-2 no-underline hover:bg-white/[0.04]">
                        <span className="shrink-0 text-sm tabular-nums text-[var(--t2)]">{inv.number || '—'}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--t1)]">{inv.contact || 'Unbekannt'}</span>
                        {due.label && <span className={`shrink-0 text-[11px] tabular-nums ${due.overdue ? 'text-[var(--red)]' : 'text-[var(--t3)]'}`}>{due.label}</span>}
                        <span className="shrink-0 text-sm tabular-nums text-[var(--t1)]">{fmtEur(inv.open || inv.total)}</span>
                      </a>
                    )
                  })}
                </div>
              )}
            </Panel>

            <Panel title="Zu prüfen" count={inbox.length > 0 ? String(inbox.length) : undefined}>
              {inbox.length === 0 ? (
                <div className="px-3 py-3 text-sm text-[var(--t3)]">Nichts offen.</div>
              ) : (
                <div className="divide-y divide-[var(--border)]">
                  {inbox.map(it => (
                    <div key={it.key} className="flex min-w-0 items-center gap-2 px-3 py-2">
                      <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtShortDate(it.date)}</span>
                      {it.hasAttachment && <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--t3)]" />}
                      <span className="shrink-0 max-w-[120px] truncate text-[11px] text-[var(--t3)]" title={it.fromAddress}>{it.kind}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-[var(--t2)]" title={it.subject}>{it.subject}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Panel title="Belege" count={expenses.length > 0 ? String(expenses.length) : undefined}>
                {expenses.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-[var(--t3)]">Keine Belege.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {expenses.slice(0, 30).map(v => (
                      <div key={v.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
                        <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{fmtShortDate(v.date)}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--t2)]">{v.contact || v.number || 'Unbekannt'}</span>
                        <span className="shrink-0 text-sm tabular-nums text-[var(--t1)]">{fmtEur(v.total)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Offene Belege" count={missing && missing.count > 0 ? `${missing.count}${missing.total_eur > 0 ? ` · ${fmtEur(missing.total_eur)}` : ''}` : undefined}>
                {!missing || missing.by_vendor.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-[var(--t3)]">Keine offenen Belege.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {missing.by_vendor.map(v => (
                      <div key={v.vendor} className="flex min-w-0 items-center gap-2 px-3 py-2" title={v.status === 'manual_portal' ? 'Login im Portal nötig' : 'Mail-Snapshot, kein PDF verfügbar'}>
                        <span className={`shrink-0 text-[11px] tabular-nums ${v.status === 'manual_portal' ? 'text-[var(--warm)]' : 'text-[var(--t3)]'}`}>{v.count}×</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--t2)]">{v.label}</span>
                        <span className="shrink-0 text-sm tabular-nums text-[var(--t1)]">
                          {v.sum_eur > 0 ? fmtEur(v.sum_eur) : '—'}
                          {v.unknown > 0 && <span className="text-[var(--t3)] ml-1">+{v.unknown}?</span>}
                        </span>
                      </div>
                    ))}
                    {missing.total_eur > 0 && (
                      <div className="flex items-baseline gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">Summe</span>
                        <span className="shrink-0 text-sm tabular-nums font-medium text-[var(--t1)]">{fmtEur(missing.total_eur)}</span>
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </div>

            <div className="flex items-center gap-2 px-1 py-1 text-[11px] text-[var(--t3)]">
              <Receipt className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">Belege landen über den Posteingang in Lexware, Freigaben laufen über den Rechnungs-Agenten.</span>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
