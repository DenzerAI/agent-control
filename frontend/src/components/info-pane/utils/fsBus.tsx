import React, { createContext, useMemo, useRef } from 'react'

// ── Workspace FS refresh bus (notifies ProjectBrowse instances after mutations) ──

export type FsBus = {
  bump: (parentPath: string) => void
  subscribe: (path: string, fn: () => void) => () => void
}
export const FsBusContext = createContext<FsBus | null>(null)

export function FsBusProvider({ children }: { children: React.ReactNode }) {
  const subsRef = useRef(new Map<string, Set<() => void>>())
  const bus = useMemo<FsBus>(() => ({
    bump: (parentPath) => {
      const set = subsRef.current.get(parentPath)
      if (set) set.forEach(fn => fn())
    },
    subscribe: (path, fn) => {
      let set = subsRef.current.get(path)
      if (!set) { set = new Set(); subsRef.current.set(path, set) }
      set.add(fn)
      return () => { set!.delete(fn) }
    }
  }), [])
  return <FsBusContext.Provider value={bus}>{children}</FsBusContext.Provider>
}

export async function fsCall(url: string, body: any): Promise<{ ok?: boolean; error?: string; path?: string }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return await r.json()
  } catch (e: any) {
    return { error: String(e) }
  }
}
