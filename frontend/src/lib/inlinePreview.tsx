import React from 'react'

// Übersetzt nur Inline-Bold (**…**) und freistehendes Kursiv (_…_) aus
// WA-Transkripten in React-Knoten. Bewusst kein voller Markdown-Renderer und
// kein HTML-Parsing: Eingabe bleibt reiner Text, Ausgabe sind Text-Nodes plus
// <strong>/<em>, damit einzeilige Previews mit truncate weiter funktionieren.
const INLINE_RE = /\*\*([^*\n]+?)\*\*|(^|[\s(["'])_([^_\n]+?)_(?=$|[\s)\]"'.,!?:;])/g

export function renderInlinePreview(text: string | null | undefined): React.ReactNode {
  if (!text) return text
  if (!text.includes('**') && !text.includes('_')) return text
  const parts: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      parts.push(<strong key={key++} className="font-semibold">{m[1]}</strong>)
    } else {
      if (m[2]) parts.push(m[2])
      parts.push(<em key={key++}>{m[3]}</em>)
    }
    last = m.index + m[0].length
  }
  if (parts.length === 0) return text
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
