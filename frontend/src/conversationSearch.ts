import { useEffect, useRef, useState } from 'react'

export interface ChatSearchHit {
  conversationId: string
  title: string
  snippet: string
  matchedTitle: boolean
}

// Hookt die Chat-Suche an `/api/search/conversations` (FTS5 + Embeddings via RRF).
// Liefert eine geordnete Trefferliste; bei leerem/kurzem Query oder Netzfehler null,
// damit der Aufrufer auf die lokale fuzzy-Filterung zurückfallen kann.
export function useConversationSearch(query: string, limit = 30): {
  hits: ChatSearchHit[] | null
  loading: boolean
} {
  const [hits, setHits] = useState<ChatSearchHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits(null)
      setLoading(false)
      return
    }
    const seq = ++seqRef.current
    const handle = window.setTimeout(() => {
      setLoading(true)
      fetch(`/api/search/conversations?q=${encodeURIComponent(q)}&limit=${limit}`)
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
        .then(d => {
          if (seqRef.current !== seq) return
          const rs = (d.results || []) as ChatSearchHit[]
          setHits(rs)
        })
        .catch(() => {
          if (seqRef.current !== seq) return
          setHits(null)
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false)
        })
    }, 180)
    return () => window.clearTimeout(handle)
  }, [query, limit])

  return { hits, loading }
}
