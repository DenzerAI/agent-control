import { useState, useEffect, useMemo } from 'react'

export type WerkbankNavSignal = {
  active: number
  waiting: number
  attention: number
  done: number
}

export type WerkbankTask = {
  status?: string
  updated_at?: number
  origin?: { conversation_id?: string }
  [key: string]: any
}

// ---- Single Source of Truth fuer das Werkbank-Polling ----------------------
// Frueher pollte jede offene Chat-Pane, die Desktop-Nav und der Mobile-Composer
// den Endpoint GET /api/loops/werkbank eigenstaendig alle 6s. Jetzt gibt es
// genau einen gemeinsamen Poll-Loop; alle Consumer abonnieren denselben Cache.

const POLL_INTERVAL_MS = 12000

let cachedTasks: WerkbankTask[] = []
let hasData = false
const subscribers = new Set<() => void>()
let intervalId: number | null = null
let inFlight = false
let lastLoadAt = 0

async function loadTasks(force = false): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (inFlight) return
  const now = Date.now()
  if (!force && now - lastLoadAt < 1000) return
  inFlight = true
  try {
    const r = await fetch('/api/loops/werkbank?limit=80', { cache: 'no-store' })
    if (!r.ok) return
    const d = await r.json()
    cachedTasks = Array.isArray(d.tasks) ? d.tasks : []
    hasData = true
    lastLoadAt = Date.now()
    subscribers.forEach(fn => { try { fn() } catch {} })
  } catch {
    // still: Netzfehler lassen den Cache unveraendert
  } finally {
    inFlight = false
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void loadTasks(true)
}

function onDeckSync(): void {
  void loadTasks(true)
}

function startPolling(): void {
  if (intervalId !== null) return
  void loadTasks(true)
  intervalId = window.setInterval(() => { void loadTasks() }, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('deck:sync', onDeckSync as EventListener)
}

function stopPolling(): void {
  if (intervalId === null) return
  window.clearInterval(intervalId)
  intervalId = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('deck:sync', onDeckSync as EventListener)
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  if (subscribers.size === 1) startPolling()
  return () => {
    subscribers.delete(fn)
    if (subscribers.size === 0) stopPolling()
  }
}

// Liefert das rohe Task-Array aus dem gemeinsamen Cache. Consumer filtern selbst.
export function useWerkbankTasks(): WerkbankTask[] {
  const [tasks, setTasks] = useState<WerkbankTask[]>(cachedTasks)
  useEffect(() => {
    const update = () => setTasks(cachedTasks)
    const unsub = subscribe(update)
    if (hasData) update()
    return unsub
  }, [])
  return tasks
}

// Aggregierte Zaehler fuer Nav + Mobile-Composer, abgeleitet aus demselben Cache.
export function useWerkbankNavSignal(): WerkbankNavSignal {
  const tasks = useWerkbankTasks()
  return useMemo<WerkbankNavSignal>(() => ({
    active: tasks.filter(t => t?.status === 'running').length,
    waiting: tasks.filter(t => t?.status === 'queued').length,
    attention: tasks.filter(t => ['needs_input', 'needs_work', 'blocked', 'rate_limited'].includes(String(t?.status || ''))).length,
    done: tasks.filter(t => t?.status === 'done').length,
  }), [tasks])
}
