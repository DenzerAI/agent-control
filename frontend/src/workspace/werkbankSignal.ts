import { useState, useCallback, useEffect } from 'react'

export type WerkbankNavSignal = {
  active: number
  waiting: number
  attention: number
  done: number
}

// Gemeinsame Quelle fuer das Werkbank-Hintergrundsignal (Desktop-Nav + Mobile-Composer).
// Zieht GET /api/loops/werkbank und trennt laufende von wartenden Auftraegen.
export function useWerkbankNavSignal(): WerkbankNavSignal {
  const [signal, setSignal] = useState<WerkbankNavSignal>({ active: 0, waiting: 0, attention: 0, done: 0 })
  const load = useCallback(async () => {
    if (document.visibilityState !== 'visible') return
    try {
      const r = await fetch('/api/loops/werkbank?limit=80', { cache: 'no-store' })
      if (!r.ok) return
      const d = await r.json()
      const tasks = Array.isArray(d.tasks) ? d.tasks : []
      setSignal({
        active: tasks.filter((t: any) => t?.status === 'running').length,
        waiting: tasks.filter((t: any) => t?.status === 'queued').length,
        attention: tasks.filter((t: any) => ['needs_input', 'needs_work', 'blocked', 'rate_limited'].includes(String(t?.status || ''))).length,
        done: tasks.filter((t: any) => t?.status === 'done').length,
      })
    } catch {}
  }, [])
  useEffect(() => {
    void load()
    const id = window.setInterval(load, 6000)
    document.addEventListener('visibilitychange', load)
    window.addEventListener('deck:sync', load as EventListener)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', load)
      window.removeEventListener('deck:sync', load as EventListener)
    }
  }, [load])
  return signal
}
