// Confusables-Normalisierung für Titel-/Picker-Suche.
// Mappt visuell/akustisch verwechselbare Zeichen in eine Klasse,
// sodass z.B. "E17" auch "i17" findet.
export function fuzzyKey(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    if ('eiyäö'.includes(ch)) out += '#'
    else if ('o0ü'.includes(ch)) out += '@'
    else if ('1l'.includes(ch)) out += '|'
    else if (ch === 'ß') out += 's'
    else out += ch
  }
  return out
}

// Match-Helfer: trifft, wenn Substring direkt oder per Fuzzy-Klasse vorkommt.
export function fuzzyIncludes(haystack: string, needle: string): boolean {
  const n = needle.trim()
  if (!n) return true
  const hLow = haystack.toLowerCase()
  const nLow = n.toLowerCase()
  if (hLow.includes(nLow)) return true
  return fuzzyKey(haystack).includes(fuzzyKey(n))
}
