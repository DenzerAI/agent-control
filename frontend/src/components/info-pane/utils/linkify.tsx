import React from 'react'

// ── Link autolinking ──

export const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi

export function linkifyText(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    let url = m[0]
    let trail = ''
    while (url.length && /[.,;:!?)\]'"»]/.test(url[url.length - 1])) {
      trail = url[url.length - 1] + trail
      url = url.slice(0, -1)
    }
    const href = url.startsWith('http') ? url : `https://${url}`
    out.push(
      <a
        key={`l${m.index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--t1)] underline underline-offset-2 decoration-[var(--t3)]/50 hover:decoration-[var(--t1)] break-all"
        onClick={(e) => e.stopPropagation()}
      >{url}</a>
    )
    if (trail) out.push(trail)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
