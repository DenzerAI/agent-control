import { MONTHS_DE } from './constants'

interface DailyLogLite { date: string }

export function formatBytes(b: number | null | undefined): string {
  if (b == null) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatRelTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = (Date.now() / 1000) - ts
  if (diff < 60) return 'jetzt'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)}w`
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)}mo`
  return `${Math.floor(diff / 86400 / 365)}y`
}

export function relativeTime(ts: number): string {
  if (!ts) return 'nie'
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'gerade'
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min`
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)}h`
  return `vor ${Math.floor(diff / 86400)}d`
}

export function groupByMonth<T extends DailyLogLite>(logs: T[]) {
  const months: Record<string, T[]> = {}
  for (const log of logs) {
    const key = log.date.slice(0, 7)
    if (!months[key]) months[key] = []
    months[key].push(log)
  }
  return Object.entries(months).sort(([a], [b]) => b.localeCompare(a))
}

export function monthLabel(key: string) {
  const [year, month] = key.split('-')
  return `${MONTHS_DE[month] || month} ${year}`
}

// Extract a markdown section by heading (depth 2 or 3) from the full text.
// Mirrors Chat.tsx:extractSection so the click-to-speak behavior is identical.
export function extractSection(markdown: string, heading: string): string {
  const target = heading.trim().toLowerCase()
  const lines = markdown.split('\n')
  let startIdx = -1
  let startDepth = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3})\s+(.*)$/)
    if (!m) continue
    const text = m[2].replace(/[*_`]/g, '').trim().toLowerCase()
    if (text === target) { startIdx = i; startDepth = m[1].length; break }
  }
  if (startIdx === -1) return ''
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+/)
    if (m && m[1].length <= startDepth) { endIdx = i; break }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim()
}
