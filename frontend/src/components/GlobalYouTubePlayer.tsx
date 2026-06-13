import { useEffect, useRef, useState } from 'react'
import { Pause, Play, SquareArrowOutUpRight, X } from 'lucide-react'
import {
  registerIframe, stop, subscribe, subscribeAnchor, syncPlayerState, togglePause,
  type YtPlayerState,
} from '../youtubePlayer'

/**
 * Global gemountetes YouTube-iframe plus Mini-Player.
 * Ist im YouTube-Modul ein Player-Platzhalter registriert, legt sich das
 * iframe per fixed-Positionierung exakt darüber; sonst läuft die Wiedergabe
 * unsichtbar weiter und unten rechts erscheint die kompakte Steuerleiste.
 */
export function GlobalYouTubePlayer({ onOpenModule }: { onOpenModule: () => void }) {
  const [state, setState] = useState<YtPlayerState>({ video: null, paused: false })
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => subscribe(setState), [])

  // Anker-Geometrie verfolgen: ResizeObserver + Scroll/Resize (capture),
  // damit das iframe dem Platzhalter im scrollenden Workspace folgt.
  useEffect(() => {
    let el: HTMLElement | null = null
    let ro: ResizeObserver | null = null
    const update = () => {
      if (!el || !el.isConnected) { setRect(null); return }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    const onScroll = () => update()
    const unsub = subscribeAnchor(next => {
      ro?.disconnect(); ro = null
      el = next
      if (el) {
        ro = new ResizeObserver(update)
        ro.observe(el)
        update()
      } else setRect(null)
    })
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      unsub(); ro?.disconnect()
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  // Playerzustand aus dem iframe zurücklesen (Pause direkt im Video etc.)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== 'string' || !e.origin.includes('youtube')) return
      try {
        const data = JSON.parse(e.data)
        const ps = data?.info?.playerState
        if (typeof ps === 'number') syncPlayerState(ps)
      } catch {}
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const { video, paused } = state
  if (!video) return null

  const docked = rect != null && rect.width > 0
  const iframeStyle: React.CSSProperties = docked
    ? { position: 'fixed', top: rect!.top, left: rect!.left, width: rect!.width, height: rect!.height, zIndex: 30 }
    : { position: 'fixed', bottom: 0, left: 0, width: 2, height: 2, opacity: 0, pointerEvents: 'none', zIndex: 0 }

  return (
    <>
      <iframe
        ref={el => {
          iframeRef.current = el
          registerIframe(el)
          // 'listening' anmelden, damit YouTube Statusmeldungen postet
          try { el?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'ac-yt' }), '*') } catch {}
        }}
        key={video.id}
        src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0&enablejsapi=1`}
        title={video.title}
        style={iframeStyle}
        className={docked ? 'rounded-md border border-[var(--border)] bg-black' : ''}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        onLoad={() => {
          try { iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'ac-yt' }), '*') } catch {}
        }}
      />
      {!docked && (
        <div
          className="fixed bottom-3 right-3 z-40 flex w-[300px] max-w-[calc(100vw-24px)] items-center gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-1)] py-2 pl-2.5 pr-1.5 shadow-lg"
          style={{ bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}
        >
          <img src={video.thumbnail} alt="" className="h-9 w-9 shrink-0 rounded object-cover" draggable={false} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-[var(--t1)]">{video.title}</div>
            <div className="truncate text-[11px] text-[var(--t3)]">{video.channel}</div>
          </div>
          <button type="button" onClick={togglePause} title={paused ? 'Weiter' : 'Pause'}
            className="shrink-0 rounded p-1.5 text-[var(--t2)] hover:bg-[var(--bg-2)] hover:text-[var(--t1)]">
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </button>
          <button type="button" onClick={onOpenModule} title="Zum YouTube-Modul"
            className="shrink-0 rounded p-1.5 text-[var(--t2)] hover:bg-[var(--bg-2)] hover:text-[var(--t1)]">
            <SquareArrowOutUpRight className="h-4 w-4" />
          </button>
          <button type="button" onClick={stop} title="Stop"
            className="shrink-0 rounded p-1.5 text-[var(--t2)] hover:bg-[var(--bg-2)] hover:text-[var(--t1)]">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </>
  )
}
