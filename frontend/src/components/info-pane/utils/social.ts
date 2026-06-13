import { WEEKDAY_DE } from './constants'
import { relativeTime } from './format'

export type SocialState = 'pending' | 'queued' | 'published' | 'failed'

export const stateColor = (s?: SocialState): string => {
  if (s === 'published') return 'var(--green, #4ade80)'
  if (s === 'failed') return 'var(--red, #ef4444)'
  if (s === 'queued') return 'var(--t1)'
  return 'var(--cc-orange)'
}

export const stateLabel = (s?: SocialState, ts?: number | null): string => {
  if (s === 'published') return ts ? `live · ${relativeTime(ts)}` : 'live'
  if (s === 'failed') return 'Fehler'
  if (s === 'queued') return 'wartet auf Slot'
  return 'wartet auf Approve'
}

// "Mo 18.05." aus ISO-Datum oder ähnlichen Inputs. Fällt elegant zurück
// auf den Fallback-Text, wenn das Parsen nicht klappt.
export const formatScheduled = (iso?: string | null, fallback = 'wartet auf Slot'): string => {
  if (!iso) return fallback
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return fallback
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return fallback
  return `${WEEKDAY_DE[d.getDay()]} ${m[3]}.${m[2]}.`
}
