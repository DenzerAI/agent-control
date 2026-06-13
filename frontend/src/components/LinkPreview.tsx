import { useEffect, useState, useRef } from 'react'
import { Loader2, Globe } from 'lucide-react'

interface Preview {
  title?: string | null
  description?: string | null
  image?: string | null
  site?: string | null
  url?: string
  error?: string
}

const cache = new Map<string, Preview>()
const inflight = new Map<string, Promise<Preview>>()

async function fetchPreview(url: string): Promise<Preview> {
  if (cache.has(url)) return cache.get(url)!
  if (inflight.has(url)) return inflight.get(url)!
  const p = (async () => {
    try {
      const r = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
      const data = await r.json()
      cache.set(url, data)
      return data as Preview
    } catch (e: any) {
      const err = { error: String(e?.message || e) }
      cache.set(url, err)
      return err
    } finally {
      inflight.delete(url)
    }
  })()
  inflight.set(url, p)
  return p
}

export function LinkPreview() {
  const [data, setData] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null)
  const [url, setUrl] = useState<string>('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('a[data-link-preview]') as HTMLAnchorElement | null
      if (!el) return
      const href = el.getAttribute('href') || ''
      if (!/^https?:\/\//i.test(href)) return
      if (anchorRef.current === el && url === href) return
      anchorRef.current = el
      clearTimer()
      timerRef.current = setTimeout(async () => {
        const rect = el.getBoundingClientRect()
        const above = rect.top > window.innerHeight / 2
        const x = Math.min(Math.max(rect.left, 12), window.innerWidth - 360)
        const y = above ? window.innerHeight - rect.top + 6 : rect.bottom + 6
        setPos({ x, y, above })
        setUrl(href)
        if (cache.has(href)) {
          setData(cache.get(href)!); setLoading(false)
        } else {
          setLoading(true); setData(null)
          const p = await fetchPreview(href)
          if (anchorRef.current === el) { setData(p); setLoading(false) }
        }
      }, 350)
    }

    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null
      if (related && related.closest && related.closest('[data-link-preview-popup]')) return
      clearTimer()
      // Close immediately on leave; popup itself handles its own hover
      anchorRef.current = null
      setPos(null); setData(null); setLoading(false); setUrl('')
    }

    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      clearTimer()
    }
  }, [url])

  if (!pos) return null

  const style: React.CSSProperties = {
    position: 'fixed',
    left: pos.x,
    [pos.above ? 'bottom' : 'top']: pos.y,
    zIndex: 9999,
    maxWidth: 360,
    width: 360,
  }

  return (
    <div data-link-preview-popup style={style}
      className="bg-[var(--bg-2)] border border-[var(--border-f)] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden animate-[fadeIn_0.12s_ease] pointer-events-none">
      {loading && (
        <div className="flex items-center gap-2 px-3 py-2.5 text-[14px] text-[var(--t3)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Vorschau lädt...
        </div>
      )}
      {!loading && data && !data.error && (
        <>
          {data.image && (
            <img src={data.image} alt="" className="w-full h-[140px] object-cover bg-[var(--bg-3)]"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          )}
          <div className="p-3 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--t3)] uppercase tracking-wider">
              <Globe className="w-2.5 h-2.5" />
              <span className="truncate">{data.site || (() => { try { return new URL(url).hostname } catch { return '' } })()}</span>
            </div>
            {data.title && <div className="text-[15px] font-medium text-[var(--t1)] leading-tight line-clamp-2">{data.title}</div>}
            {data.description && <div className="text-[13px] text-[var(--t2)] leading-snug line-clamp-3">{data.description}</div>}
          </div>
        </>
      )}
      {!loading && data && data.error && (
        <div className="px-3 py-2.5 text-[13px] text-[var(--t3)]">
          Keine Vorschau verfügbar
        </div>
      )}
    </div>
  )
}
