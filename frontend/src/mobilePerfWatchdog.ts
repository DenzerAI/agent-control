type PerfMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let started = false
let fetchWrapped = false
let activeClientKind = 'unknown'

type AreaStats = {
  count: number
  ok: number
  error: number
  totalMs: number
  maxMs: number
}

const areaStats: Record<string, AreaStats> = {}
const routeStats: Record<string, AreaStats> = {}

function heapUsedMb(): number | null {
  const perf = performance as Performance & { memory?: PerfMemory }
  const used = perf.memory?.usedJSHeapSize
  return typeof used === 'number' ? Math.round(used / 1048576) : null
}

function postSample(sample: Record<string, unknown>) {
  const body = JSON.stringify({ clientKind: activeClientKind, ...sample })
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      if (navigator.sendBeacon('/api/mobile-perf', blob)) return
    }
  } catch {}
  fetch('/api/mobile-perf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {})
}

function classifyUrl(input: RequestInfo | URL): { area: string; route: string } | null {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
  let url: URL
  try {
    url = new URL(raw, location.origin)
  } catch {
    return null
  }
  if (url.origin !== location.origin) return null
  if (!url.pathname.startsWith('/api/')) return null
  if (url.pathname === '/api/mobile-perf') return null

  const path = url.pathname
  const route = path
    .replace(/\/[a-f0-9]{8}(?=\/|$)/gi, '/:id')
    .replace(/\/[a-f0-9]{16,}(?=\/|$)/gi, '/:id')

  if (path.startsWith('/api/whatsapp/')) return { area: 'whatsapp', route }
  if (path.startsWith('/api/inbox/') || path.startsWith('/api/mail/')) return { area: 'mail', route }
  if (path.startsWith('/api/fokus') || path.startsWith('/api/calendar')) return { area: 'fokus', route }
  if (path.startsWith('/api/deck/')) return { area: 'remote', route }
  if (path.startsWith('/api/history') || path.startsWith('/api/conversations') || path.startsWith('/api/messages')) return { area: 'chat', route }
  if (path.startsWith('/api/slots') || path.startsWith('/api/active-streams') || path.startsWith('/api/mark-read') || path.startsWith('/api/message-queue')) return { area: 'sync', route }
  if (path.startsWith('/api/projects')) return { area: 'projects', route }
  if (path.startsWith('/api/transcribe') || path.startsWith('/api/voice')) return { area: 'voice', route }
  if (path.startsWith('/api/search')) return { area: 'search', route }
  return { area: 'other', route }
}

function addStat(bucket: Record<string, AreaStats>, key: string, durationMs: number, ok: boolean) {
  const s = bucket[key] || { count: 0, ok: 0, error: 0, totalMs: 0, maxMs: 0 }
  s.count += 1
  if (ok) s.ok += 1
  else s.error += 1
  s.totalMs += durationMs
  s.maxMs = Math.max(s.maxMs, durationMs)
  bucket[key] = s
}

function drainStats(bucket: Record<string, AreaStats>) {
  const out: Record<string, AreaStats & { avgMs: number }> = {}
  for (const [key, value] of Object.entries(bucket)) {
    out[key] = {
      ...value,
      totalMs: Math.round(value.totalMs),
      maxMs: Math.round(value.maxMs),
      avgMs: Math.round(value.totalMs / Math.max(1, value.count)),
    }
    delete bucket[key]
  }
  return out
}

function wrapFetchForMobilePerf() {
  if (fetchWrapped || typeof window === 'undefined') return
  fetchWrapped = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const meta = classifyUrl(input)
    const startedAt = performance.now()
    try {
      const res = await originalFetch(input, init)
      if (meta) {
        const duration = performance.now() - startedAt
        addStat(areaStats, meta.area, duration, res.ok)
        addStat(routeStats, meta.route, duration, res.ok)
      }
      return res
    } catch (err) {
      if (meta) {
        const duration = performance.now() - startedAt
        addStat(areaStats, meta.area, duration, false)
        addStat(routeStats, meta.route, duration, false)
      }
      throw err
    }
  }
}

function inferClientKind() {
  const path = location.pathname
  if (path.startsWith('/mobile')) return 'mobile'
  if (path.startsWith('/remote') || path.startsWith('/deck')) return 'remote'
  if (window.innerWidth < 768) return 'mobile'
  return 'desktop'
}

export function startMobilePerfWatchdog(clientKind?: 'desktop' | 'mobile' | 'remote') {
  if (started || typeof window === 'undefined') return
  started = true
  activeClientKind = clientKind || inferClientKind()
  wrapFetchForMobilePerf()

  let expected = performance.now() + 1000
  let maxDriftMs = 0
  let longTaskCount = 0
  let longTaskMs = 0
  let lastReport = performance.now()
  let hiddenSince = 0

  try {
    const Observer = window.PerformanceObserver
    if (Observer) {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1
          longTaskMs += entry.duration
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    }
  } catch {}

  const resetClock = () => {
    const now = performance.now()
    expected = now + 1000
    maxDriftMs = 0
    lastReport = now
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenSince = performance.now()
    else {
      hiddenSince = 0
      resetClock()
    }
  })

  window.setInterval(() => {
    const now = performance.now()
    const drift = Math.max(0, now - expected)
    expected = now + 1000
    if (document.hidden) {
      if (hiddenSince && now - hiddenSince > 30000) resetClock()
      return
    }
    maxDriftMs = Math.max(maxDriftMs, drift)

    const due = now - lastReport >= 60_000
    const unhealthy = maxDriftMs >= 500 || longTaskMs >= 800
    if (!due && !unhealthy) return

    postSample({
      ts: Date.now(),
      path: location.pathname,
      hidden: document.hidden,
      areas: drainStats(areaStats),
      routes: drainStats(routeStats),
      maxDriftMs: Math.round(maxDriftMs),
      longTaskCount,
      longTaskMs: Math.round(longTaskMs),
      heapUsedMb: heapUsedMb(),
    })
    maxDriftMs = 0
    longTaskCount = 0
    longTaskMs = 0
    lastReport = now
  }, 1000)
}
