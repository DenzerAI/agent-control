// Eingang-Counts — orange-Icon-Indikator pro InfoPane-Sektion.
// Lädt /api/eingang/counts, poll alle 60s, lebt als Modul-Singleton.
// Sections subscribieren via useEingangCounts().

import { useEffect, useState } from 'react'

export type EingangCounts = {
  fokus: number
  leads: number
  workshops: number
  total: number
}

const DEFAULT: EingangCounts = { fokus: 0, leads: 0, workshops: 0, total: 0 }

let currentCounts: EingangCounts = DEFAULT
const listeners = new Set<(c: EingangCounts) => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchOnce() {
  try {
    const r = await fetch('/api/eingang/counts')
    if (!r.ok) return
    const d = await r.json()
    const next: EingangCounts = {
      fokus: Number(d.fokus) || 0,
      leads: Number(d.leads) || 0,
      workshops: Number(d.workshops) || 0,
      total: Number(d.total) || 0,
    }
    currentCounts = next
    listeners.forEach(fn => fn(next))
  } catch {
    /* still */
  }
}

function ensurePolling() {
  if (pollTimer !== null) return
  fetchOnce()
  pollTimer = setInterval(fetchOnce, 60_000)
}

function stopPollingIfIdle() {
  if (listeners.size === 0 && pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function useEingangCounts(): EingangCounts {
  const [counts, setCounts] = useState<EingangCounts>(currentCounts)
  useEffect(() => {
    listeners.add(setCounts)
    ensurePolling()
    return () => {
      listeners.delete(setCounts)
      stopPollingIfIdle()
    }
  }, [])
  return counts
}

// Imperativer Refresh — z. B. nach mark-seen.
export function refreshEingangCounts() {
  fetchOnce()
}

// Markiert alle Events einer Section als gesehen und refresht Counts.
// Wird beim Aufklappen der Section gerufen, damit das orange Icon zurück auf grau geht.
export async function markSectionSeen(section: 'fokus' | 'leads' | 'workshops') {
  try {
    await fetch('/api/eingang/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section }),
    })
    fetchOnce()
  } catch {
    /* still */
  }
}
