let active = false
let initialBuildId = ''
let noticeEl: HTMLElement | null = null

const MOBILE_SLOT_ID = 'cc-update-mobile-slot'

export function startBuildGuard() {
  if (active || typeof window === 'undefined') return
  active = true

  const readBuildId = async () => {
    const r = await fetch('/api/build-id', { cache: 'no-store' })
    if (!r.ok) return ''
    const d = await r.json().catch(() => ({}))
    return typeof d.buildId === 'string' ? d.buildId : ''
  }

  const ensureStyle = () => {
    if (document.getElementById('cc-update-style')) return
    const style = document.createElement('style')
    style.id = 'cc-update-style'
    style.textContent = `
/* Mobile: leise Pille in der oberen Leiste, links gegenüber den Modell-Controls.
   Kein Banner über dem Composer, Reload bleibt opt-in. */
.cc-update-mini {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 8px;
  padding: 4px 9px 4px 8px;
  border: 1px solid color-mix(in srgb, var(--cc-orange, #d97757) 22%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--cc-orange, #d97757) 9%, transparent);
  color: var(--t2, #cfc9bf);
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 12px;
  line-height: 1;
  letter-spacing: .01em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  animation: cc-update-fade .42s ease both;
}
.cc-update-mini svg {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--cc-orange, #d97757);
  transition: transform .55s cubic-bezier(.16,1,.3,1);
}
.cc-update-mini:active svg { transform: rotate(360deg); }

/* Desktop: ruhige Glas-Pille unten mittig, kein Puls, kein Vollton-Druck. */
.cc-update {
  position: fixed;
  left: 50%;
  bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100vw - 28px);
  padding: 8px 11px 8px 14px;
  border: 1px solid var(--border, rgba(255,255,255,.08));
  border-radius: 13px;
  background: color-mix(in srgb, var(--bg-1, #222) 82%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: 0 6px 22px rgba(0,0,0,.18);
  color: var(--t2, #cfc9bf);
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
  line-height: 1.25;
  animation: cc-update-fade .42s ease both;
}
.cc-update-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 999px;
  background: var(--cc-orange, #d97757);
}
.cc-update-text {
  font-weight: 500;
  letter-spacing: .01em;
  white-space: nowrap;
}
.cc-update-btn {
  flex: none;
  margin-left: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 999px;
  padding: 0;
  background: transparent;
  color: var(--cc-orange, #d97757);
  cursor: pointer;
  transition: background .16s ease;
}
.cc-update-btn:hover {
  background: color-mix(in srgb, var(--cc-orange, #d97757) 12%, transparent);
}
.cc-update-btn svg {
  width: 15px;
  height: 15px;
  transition: transform .55s cubic-bezier(.16,1,.3,1);
}
.cc-update-btn:hover svg { transform: rotate(360deg); }
.cc-update-btn:active svg { transform: rotate(360deg) scale(.9); }
@keyframes cc-update-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
`
    document.head.appendChild(style)
  }

  const refreshIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'

  const showMobile = (slot: HTMLElement) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cc-update-mini'
    btn.setAttribute('aria-label', 'Neue Version verfügbar, tippen zum Neuladen')
    btn.title = 'Neue Version verfügbar'
    btn.innerHTML = refreshIcon + '<span>Neu</span>'
    btn.onclick = () => window.location.reload()
    slot.appendChild(btn)
    noticeEl = btn
  }

  const showDesktop = () => {
    const el = document.createElement('div')
    el.className = 'cc-update'

    const dot = document.createElement('span')
    dot.className = 'cc-update-dot'
    el.appendChild(dot)

    const text = document.createElement('span')
    text.className = 'cc-update-text'
    text.textContent = 'Neue Version'
    el.appendChild(text)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cc-update-btn'
    btn.setAttribute('aria-label', 'Neu laden')
    btn.title = 'Neu laden'
    btn.innerHTML = refreshIcon
    btn.onclick = () => window.location.reload()
    el.appendChild(btn)

    document.body.appendChild(el)
    noticeEl = el
  }

  const showNotice = () => {
    if (noticeEl && noticeEl.isConnected) return
    noticeEl = null
    ensureStyle()
    const slot = document.getElementById(MOBILE_SLOT_ID)
    if (slot) showMobile(slot)
    else showDesktop()
  }

  const check = async () => {
    try {
      const next = await readBuildId()
      if (!next) return
      if (!initialBuildId) {
        initialBuildId = next
        return
      }
      if (next !== initialBuildId) showNotice()
    } catch {}
  }

  check()
  const timer = window.setInterval(() => {
    if (!document.hidden) check()
  }, 60000)
  window.addEventListener('focus', check)
  window.addEventListener('online', check)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check()
  })
  window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true })
}
