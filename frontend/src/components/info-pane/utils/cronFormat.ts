// Helpers für Cron-Anzeige (außerhalb von CronDetail, damit CronDetail lazy bleiben kann)

export function cronHuman(expr: string): string {
  // Convert "0 7 * * *" → "07:00 täglich", "30 13 * * 1-5" → "13:30 Mo-Fr"
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return expr
  const [min, hour, dom, , dow] = parts
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  const dayMap: Record<string, string> = { '*': 'täglich', '1-5': 'Mo–Fr', '0,6': 'Wochenende', '1': 'Mo', '2': 'Di', '3': 'Mi', '4': 'Do', '5': 'Fr', '6': 'Sa', '0': 'So' }
  const day = dom !== '*' ? `am ${dom}.` : (dayMap[dow] || dow)
  return `${time} ${day}`
}

export function relativeNext(ts: number): string {
  if (!ts) return ''
  const diff = ts - Date.now() / 1000
  if (diff < -86400) return ''  // more than a day past — nextRunAt is stale
  if (diff < 0) return ''       // already ran — wait for gateway to update nextRunAt
  if (diff < 3600) return `in ${Math.ceil(diff / 60)} Min`
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`
  return `in ${Math.floor(diff / 86400)}d`
}
