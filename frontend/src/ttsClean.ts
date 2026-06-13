// Markdown → sprechbarer Text. Aus ChatPane.cleanForTTS gezogen, damit auch die
// Remote-Fernbedienung die letzte Agent-Nachricht sauber vorlesen kann (keine
// Sternchen, Codeblöcke, URLs). Reine Funktion, keine Abhängigkeiten.
export function cleanForTTS(text: string): string {
  if (!text) return ''
  let t = text
  // Sources-Block entfernen (Websuche-Fußnoten)
  t = t.replace(/\n?sources?:\s*\n(?:[ \t]*[-*][ \t]+[^\n]*\n?)*/gi, ' ')
  // Fenced & indented code blocks
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/~~~[\s\S]*?~~~/g, ' ')
  // Inline code
  t = t.replace(/`[^`\n]*`/g, ' ')
  // File paths: nur letztes Segment vorlesen, humanisiert
  t = t.replace(/(?<![:/])(?:[a-zA-Z0-9_.~-]+\/)+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/g, (_, last) => {
    const dot = last.lastIndexOf('.')
    const base = dot > 0 ? last.slice(0, dot) : last
    const ext = dot > 0 ? last.slice(dot + 1).toUpperCase() : ''
    const words = base.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
    const humanized = words.replace(/\b\w/g, (c: string) => c.toUpperCase())
    return ext ? `${humanized} in ${ext}` : humanized
  })
  // Images ![alt](url)
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  // Markdown-Links [text](url) → text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Reference-Links [text][ref] → text
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  // Bare URLs (http/https/www)
  t = t.replace(/https?:\/\/\S+/gi, ' ')
  t = t.replace(/\bwww\.\S+/gi, ' ')
  // E-Mails
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ')
  // Tabellen: komplette Pipe-Zeilen raus
  t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
  t = t.replace(/^[ \t]*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*[ \t]*$/gm, '')
  // Horizontale Linien
  t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
  // Heading-Marker
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  // Blockquote-Marker
  t = t.replace(/^[ \t]*>[ \t]?/gm, '')
  // Listenzeichen
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  t = t.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
  // Bold / Italic / Strike — Marker entfernen, Inhalt behalten
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1')
  t = t.replace(/__([^_]+)__/g, '$1')
  t = t.replace(/\*([^*\n]+)\*/g, '$1')
  t = t.replace(/(?<![a-zA-Z0-9])_([^_\n]+)_(?![a-zA-Z0-9])/g, '$1')
  t = t.replace(/~~([^~]+)~~/g, '$1')
  // HTML-Tags
  t = t.replace(/<[^>]+>/g, ' ')
  // Restliche Markdown-Reste
  t = t.replace(/[|`]/g, ' ')
  t = t.replace(/\*+/g, '')
  t = t.replace(/(^|\s)_+(\s|$)/g, '$1$2')
  // Absatzwechsel zu Satzenden
  t = t.replace(/\n{2,}/g, '. ')
  t = t.replace(/\n/g, ' ')
  // Whitespace & Satzzeichen-Kosmetik
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.replace(/(\.\s*){2,}/g, '. ')
  t = t.replace(/\s+([.,;:!?])/g, '$1')
  return t.trim()
}
