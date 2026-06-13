// Relative-Zeit-Formatter für ISO-Timestamps. "eben", "vor 5 min", "vor 2 d" oder Datum.

export function fmtRelTs(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diffSec = (Date.now() - d.getTime()) / 1000
  if (diffSec < 60) return 'eben'
  if (diffSec < 3600) return `vor ${Math.floor(diffSec / 60)} min`
  if (diffSec < 86400) return `vor ${Math.floor(diffSec / 3600)} h`
  if (diffSec < 7 * 86400) return `vor ${Math.floor(diffSec / 86400)} d`
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}
