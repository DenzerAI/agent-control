/**
 * Theme: 'auto' folgt System-prefers-color-scheme, sonst 'dark' oder 'light'.
 * Applied über data-theme auf <html>. Persistenz via prefs (synced).
 */

import { setPref } from './prefs'

export type ThemeMode = 'auto' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

const PREF_KEY = 'control:theme'

export function getThemeMode(): ThemeMode {
  const raw = localStorage.getItem(PREF_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
  return 'auto'
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') {
    const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches
    return prefersLight ? 'light' : 'dark'
  }
  return mode
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode)
  if (resolved === 'dark') {
    document.documentElement.removeAttribute('data-theme')
  } else {
    document.documentElement.setAttribute('data-theme', resolved)
  }
}

export function setThemeMode(mode: ThemeMode): void {
  setPref(PREF_KEY, mode)
  applyTheme(mode)
  // notify listeners in current tab
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { mode } }))
}

/** Call once at startup. Re-applies theme when system scheme changes (auto mode only). */
export function initThemeListener(): void {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)')
  if (!mq) return
  const onChange = () => {
    if (getThemeMode() === 'auto') applyTheme('auto')
  }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else mq.addListener(onChange)
}
