// Geteilter, zuverlaessiger Server-Restart fuer feste UI-Knoepfe (Desktop-Sidebar
// + Mobile-Menue). Bewusst unabhaengig vom fragilen Composer-Restart, der an
// `busy`/Phrasen-Erkennung haengt und deshalb oft nicht erscheint.
//
// Ablauf wie der bewaehrte Composer-Flow: kurze Policy-Freigabe reinhaengen
// (der CLI-Backstop ist sonst gesperrt), dann /api/restart-safe (macht
// os._exit(0), launchd startet neu), danach pollen bis /api/system-status
// wieder 200 liefert und die Seite frisch laden.

let restartInFlight = false

export function isRestartInFlight(): boolean {
  return restartInFlight
}

export async function triggerSafeRestart(opts?: { confirm?: boolean }): Promise<void> {
  if (restartInFlight) return
  if (opts?.confirm !== false) {
    const ok = typeof window !== 'undefined'
      ? window.confirm('Server jetzt neu starten? Laufende Antworten werden kurz unterbrochen.')
      : true
    if (!ok) return
  }
  restartInFlight = true
  window.dispatchEvent(new CustomEvent('deck:restartState', { detail: { busy: true } }))
  try {
    try {
      await fetch('/api/restart-policy/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: 2, reason: 'Fester Restart-Button durch Christian' }),
      })
    } catch { /* nicht fatal, restart-safe prueft selbst */ }

    const r = await fetch('/api/restart-safe', { method: 'POST' })
    if (!r.ok) {
      let detail = ''
      try { const j = await r.json(); detail = j?.detail?.summary || j?.detail || j?.message || '' } catch { /* ignore */ }
      restartInFlight = false
      window.dispatchEvent(new CustomEvent('deck:restartState', { detail: { busy: false } }))
      window.alert(`Restart blockiert${detail ? `: ${detail}` : ''}.`)
      return
    }

    // Poll bis der neue Server wieder antwortet (max 30s), dann frisch laden.
    const started = Date.now()
    while (Date.now() - started < 30000) {
      await new Promise(res => setTimeout(res, 1000))
      try {
        const s = await fetch('/api/system-status', { cache: 'no-store' })
        if (s.ok) { window.location.reload(); return }
      } catch { /* Server noch unten, weiter pollen */ }
    }
    // Timeout: trotzdem neu laden, der Server kommt meist gerade hoch.
    window.location.reload()
  } finally {
    restartInFlight = false
  }
}
