import React from 'react'

// Fängt "Failed to fetch dynamically imported module" nach Deploys (Chunk-Hash hat sich geändert):
// einmaliger Page-Reload holt das neue index.html samt frischer Chunk-Namen.
// sessionStorage-Flag verhindert Endlos-Reload, wenn der Fehler wirklich am Modul liegt.

const RELOAD_KEY = 'lazyRetry:reloaded'

export function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return React.lazy(async () => {
    try {
      const mod = await factory()
      try { sessionStorage.removeItem(RELOAD_KEY) } catch {}
      return mod
    } catch (err) {
      const already = (() => { try { return sessionStorage.getItem(RELOAD_KEY) } catch { return null } })()
      if (!already) {
        try { sessionStorage.setItem(RELOAD_KEY, '1') } catch {}
        window.location.reload()
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }
  })
}
