import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, memo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ChevronRight, ChevronDown, Copy, Check, Reply, Wrench, Volume2, Pause, Play, Square, RotateCcw, Trash2 } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

// Custom marked renderer for syntax highlighting
const renderer = new marked.Renderer()

// Path detection: single token, has slash, has file extension or known top-level prefix
const PATH_RE = /^(?:~\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}$/
const PATH_PREFIXES = ['work/', 'brain/', 'jobs/', 'skills/', 'frontend/', 'backend/', 'config/', 'data/', 'scripts/', 'video/', 'soul/', 'logs/']
function looksLikePath(s: string): boolean {
  const t = s.trim()
  if (!t || t.includes(' ') || t.includes('\n')) return false
  if (PATH_RE.test(t)) return true
  return PATH_PREFIXES.some(p => t.startsWith(p)) && t.includes('/')
}
function pathLink(raw: string): string {
  const safe = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const enc = encodeURIComponent(raw.trim())
  return `<a href="/api/fs/download?path=${enc}" data-path-link="1" class="path-link" title="${safe} öffnen (Cmd/Ctrl-Klick: Download)">${safe}</a>`
}

renderer.codespan = ({ text }: { text: string }) => {
  if (looksLikePath(text)) return pathLink(text)
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<code>${safe}</code>`
}

renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  if (lang === 'mermaid') {
    const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`
    return `<div class="mermaid-block" data-mermaid="${encodeURIComponent(text)}" id="${id}"><pre class="hljs-block"><code class="hljs">${text}</code></pre></div>`
  }
  // Draft block: Outbound-Drafts (WhatsApp, Mail, ...) im grünen WA-Bubble-Stil.
  // `draft` und `wa-draft` rendern identisch — ein Look für alle Drafts.
  if (lang === 'draft' || lang === 'wa-draft' || lang === 'mail-draft' || lang === 'email-draft') {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const paragraphs = escaped.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('')
    return `<div class="draft-block" data-draft-text="${encodeURIComponent(text)}"><div class="draft-head"><span class="draft-tag"><span class="draft-dot"></span>Entwurf</span></div><div class="draft-block-body">${paragraphs}</div></div>`
  }
  // Plain code block: convert path-only lines into download links.
  // Also catch text/txt/path-tagged blocks so a repo path stays clickable
  // regardless of the fence language.
  if (!lang || lang === 'text' || lang === 'txt' || lang === 'path') {
    const lines = text.split('\n')
    if (lines.every(l => !l.trim() || looksLikePath(l))) {
      const html = lines.map(l => l.trim() ? pathLink(l) : '').join('\n')
      return `<pre class="hljs-block path-block"><code>${html}</code></pre>`
    }
  }
  const language = lang && hljs.getLanguage(lang) ? lang : null
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value
  const label = '' // Sprachlabel bewusst aus: Code bleibt clean
  return `<pre class="hljs-block">${label}<code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`
}

renderer.image = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
  const alt = text || title || ''
  const safeTitle = (title || alt || 'Bild').replace(/"/g, '&quot;')
  let pathAttr = ''
  try {
    const u = new URL(href, window.location.origin)
    if (u.pathname.startsWith('/api/fs/download')) {
      const p = u.searchParams.get('path') || ''
      if (p) pathAttr = ` data-image-path="${p.replace(/"/g, '&quot;')}"`
    }
  } catch {}
  return `<img src="${href}" alt="${alt}" title="${safeTitle} — Klick: Vorschau" class="block my-2 max-w-full max-h-[400px] rounded-xl object-contain hover:opacity-90 transition-opacity cursor-zoom-in" loading="lazy" data-image-preview="1"${pathAttr} />`
}

const defaultLinkRenderer = renderer.link.bind(renderer)
function looksLikeProjectPath(href: string): boolean {
  if (!href) return false
  if (/^[a-z]+:/i.test(href)) return false
  if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false
  const stripped = href.replace(/^(?:\.\.?\/)+/, '').replace(/^\//, '')
  return looksLikePath(stripped)
}
function projectPathFromHref(href: string): string {
  const clean = String(href || '').trim()
  if (/^(?:~\/|\/Users\/)/.test(clean)) return clean
  return clean.replace(/^(?:\.\.?\/)+/, '').replace(/^\//, '')
}
renderer.link = (args: any) => {
  const href = String(args.href || '')
  if (looksLikeProjectPath(href)) {
    const filePath = projectPathFromHref(href)
    const labelSrc = String(args.text || filePath)
    const safe = labelSrc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const enc = encodeURIComponent(filePath.trim())
    return `<a href="/api/fs/download?path=${enc}" data-path-link="1" class="path-link" title="${safe} öffnen (Cmd/Ctrl-Klick: Download)">${safe}</a>`
  }
  const html = defaultLinkRenderer(args)
  return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" data-link-preview="1" ')
}

const defaultHeadingRenderer = renderer.heading.bind(renderer)
renderer.heading = (args: any) => {
  const html = defaultHeadingRenderer(args)
  if (args.depth !== 2 && args.depth !== 3) return html
  const plain = String(args.text || '').replace(/<[^>]+>/g, '').trim()
  if (!plain) return html
  const slug = encodeURIComponent(plain)
  const btn = `<button type="button" class="section-play" data-section-heading="${slug}" aria-label="Abschnitt abspielen" tabindex="-1"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>`
  return html.replace(/<\/(h[23])>\s*$/, ` ${btn}</$1>`)
}

// Rohes HTML aus Antworten wird grundsaetzlich escaped (Sicherheit).
// Ausnahme: schlichte <span>-Tags fuer farbige Kicker/Akzente. DOMPurify
// laeuft danach und entfernt Event-Handler & gefaehrliche style-Inhalte,
// ein span mit color ist harmlos.
const SAFE_INLINE_HTML = /^<\/?span(\s[^>]*)?>$/i
renderer.html = (args: any) => {
  const text = typeof args === 'string' ? args : (args?.text || '')
  if (SAFE_INLINE_HTML.test(text.trim())) return text
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

marked.setOptions({ renderer, gfm: true, breaks: false })

function enforceLinksInNewTab(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (tag, attrs) => {
    if (/\bdata-path-link\s*=/.test(attrs)) return tag

    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const href = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '').trim() : ''
    if (!href || href.startsWith('#') || /^mailto:|^tel:/i.test(href)) return tag

    let next = tag
    if (!/\btarget\s*=/.test(attrs)) {
      next = next.replace(/^<a\b/i, '<a target="_blank"')
    }
    if (!/\brel\s*=/.test(attrs)) {
      next = next.replace(/^<a\b/i, '<a rel="noopener noreferrer"')
    }
    return next
  })
}

function renderMarkdownHtml(text: string): string {
  return enforceLinksInNewTab(
    DOMPurify.sanitize(marked.parse(text) as string, { ADD_ATTR: ['target'] })
  )
}


interface Attachment {
  name: string
  url: string
  type: string
  size: number
}

interface ToolCall {
  name: string
  input: Record<string, unknown>
  id: string
  result?: string
  status?: string
  output?: string
  diffStats?: { added: number; removed: number }
}

interface MemoryRef {
  source: string
  path: string
  title: string
  snippet: string
  color: string
}

interface Reaction {
  emoji: string
  agent: string
  ts: number
}

type ChatStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCall }

interface Message {
  id?: number
  author: string
  content: string
  bot?: boolean
  system?: string
  ts?: number
  attachments?: Attachment[]
  tools?: ToolCall[]
  thinking?: string
  refs?: MemoryRef[]
  tool?: { name: string; info?: string; output?: string }
  edited_at?: number | null
  reactions?: Reaction[]
  errorRetry?: string
  elapsedMs?: number | null
  steps?: ChatStep[]
  segments?: string[]
  incomplete?: boolean
}

function hasVisibleMessageBody(m: Message): boolean {
  const content = typeof m.content === 'string' ? m.content.trim() : ''
  if (content) return true
  if (m.attachments?.length) return true
  if (m.tool) return true
  if (m.tools?.length) return true
  if (m.thinking?.trim()) return true
  if (m.refs?.length) return true
  if (m.errorRetry) return true
  if (m.segments?.some(seg => seg.trim())) return true
  if (m.steps?.some(step => step.kind === 'tool' || step.text.trim())) return true
  return false
}

function extractResultForSpeech(text: string): string {
  const cleaned = (text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .trim()
  if (!cleaned) return ''

  const headingKeywords = '(?:Ergebnis|Fazit|Zusammenfassung|Kurzfassung|Kurz gesagt|Zusammengefasst|Abschließend|Bottom Line|Summary|Conclusion|TL;DR|Tldr)'
  const headingRe = new RegExp(`^#{1,4}\\s+.*${headingKeywords}.*$`, 'gim')
  let match: RegExpExecArray | null
  let lastMatch: RegExpExecArray | null = null
  while ((match = headingRe.exec(cleaned)) !== null) {
    if (match.index >= cleaned.length * 0.35) lastMatch = match
  }
  if (lastMatch) {
    const start = lastMatch.index
    const nextHeading = cleaned.slice(start + lastMatch[0].length).search(/\n#{1,4}\s+/)
    if (nextHeading >= 0) return cleaned.slice(start, start + lastMatch[0].length + nextHeading).trim()
    return cleaned.slice(start).trim()
  }

  const leadRe = new RegExp(`^\\s*(?:\\*\\*)?${headingKeywords}(?:\\*\\*)?\\s*:?`, 'gim')
  lastMatch = null
  while ((match = leadRe.exec(cleaned)) !== null) {
    if (match.index >= cleaned.length * 0.35) lastMatch = match
  }
  if (lastMatch) return cleaned.slice(lastMatch.index).trim()

  return cleaned
}

function getAgentSpeechText(m: Message, fallbackText: string): string {
  const stepTexts = (m.steps || [])
    .filter((step): step is { kind: 'text'; text: string } => step.kind === 'text')
    .map(step => step.text.trim())
    .filter(Boolean)
  if (stepTexts.length > 1) return stepTexts[stepTexts.length - 1]

  const segmentTexts = (m.segments || []).map(seg => seg.trim()).filter(Boolean)
  if (segmentTexts.length > 1) return segmentTexts[segmentTexts.length - 1]

  return extractResultForSpeech(fallbackText || m.content)
}

function AudioPlayer({ src, name }: { src: string; name: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTime = () => setCurrent(el.currentTime)
    const onMeta = () => setDuration(el.duration || 0)
    const onEnd = () => setPlaying(false)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('ended', onEnd)
    return () => { el.removeEventListener('timeupdate', onTime); el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('ended', onEnd) }
  }, [])

  const toggle = () => {
    if (!ref.current) return
    if (playing) { ref.current.pause() } else { ref.current.play() }
    setPlaying(!playing)
  }

  const stop = () => {
    if (!ref.current) return
    ref.current.pause()
    ref.current.currentTime = 0
    setPlaying(false)
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    ref.current.currentTime = pct * duration
  }

  const pct = duration ? (current / duration) * 100 : 0

  return (
    <div className="audio-attachment flex items-center gap-1.5 bg-[var(--bg-2)] rounded-xl px-2.5 py-2 min-w-0 max-w-full">
      <audio ref={ref} src={src} preload="metadata" />
      <button onClick={toggle} className="shrink-0 text-[var(--t2)] hover:text-[var(--t1)] cursor-pointer transition-colors">
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
      </button>
      <button onClick={stop} className="shrink-0 text-[var(--t3)] hover:text-[var(--t2)] cursor-pointer transition-colors">
        <Square className="w-3 h-3" />
      </button>
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div className="h-1 rounded-full bg-[var(--bg-3)] cursor-pointer" onClick={seek}>
          <div className="h-full rounded-full bg-[var(--t3)] transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-[var(--t3)]">
          <span className="shrink-0">{fmt(current)}</span>
          <span className="truncate min-w-0 max-w-[72px] text-[var(--t3)]/60">{name}</span>
          <span className="shrink-0">{duration ? fmt(duration) : '--:--'}</span>
        </div>
      </div>
    </div>
  )
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Heute'
  if (d.toDateString() === yesterday.toDateString()) return 'Gestern'
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  if (d.toDateString() === yesterday.toDateString()) return `Gestern ${time}`
  return `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })} ${time}`
}


const MD_STYLES = `text-[16px] font-normal leading-[1.62] text-[var(--t-body)] min-w-0 break-words
  [&_p+p]:mt-[1rem]
  [&_strong]:font-bold [&_strong]:text-[var(--strong)]
  [&_em]:text-[var(--t1)] [&_em]:italic
  [&_del]:line-through [&_del]:text-[var(--t1)]
  [&_code]:text-[var(--t1)]
  [&_pre]:border-t [&_pre]:border-b [&_pre]:border-[var(--border)] [&_pre]:py-[16px] [&_pre]:my-[1.5rem] [&_pre]:overflow-x-hidden [&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:leading-relaxed [&_pre]:relative [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words [&_pre_code]:font-mono [&_pre_code]:text-[13px]
  [&_ul]:pl-9 [&_ul]:list-disc [&_ul]:my-[1rem] [&_ol]:pl-9 [&_ol]:list-decimal [&_ol]:my-[1rem] [&_li]:my-[8px] [&_li]:pl-1
  [&_a]:text-[var(--purple)] [&_a]:underline [&_a]:underline-offset-2
  [&_h1]:text-[28px] [&_h1]:font-semibold [&_h1]:text-[var(--t1)] [&_h1]:mt-[2.5rem] [&_h1]:mb-[1rem] [&_h1]:tracking-tight [&_h1]:leading-[1.25]
  [&_h2]:text-[23px] [&_h2]:font-semibold [&_h2]:text-[var(--t1)] [&_h2]:mt-[2rem] [&_h2]:mb-[0.875rem] [&_h2]:leading-[1.3]
  [&_h3]:text-[19px] [&_h3]:font-semibold [&_h3]:text-[var(--t1)] [&_h3]:mt-[1.5rem] [&_h3]:mb-[0.5rem] [&_h3]:leading-[1.35]
  [&_blockquote]:pl-[16px] [&_blockquote]:py-[4px] [&_blockquote]:text-[var(--t-body)] [&_blockquote]:italic
  [&_hr]:border-[var(--border)] [&_hr]:my-[2rem]
  [&_table]:w-full [&_table]:max-w-full [&_table]:my-[1rem] [&_table]:text-[15px] [&_table]:border-collapse
  [&_th]:text-center [&_th]:align-middle [&_th]:font-semibold [&_th]:text-[var(--t1)] [&_th]:px-[8px] [&_th]:py-[5px] [&_th]:border-b-2 [&_th]:border-[var(--t3)] [&_th]:leading-[1.3]
  [&_th:first-child]:text-left
  [&_td]:text-center [&_td]:align-middle [&_td]:px-[8px] [&_td]:py-[5px] [&_td]:text-[var(--t-body)] [&_td]:border-b [&_td]:border-[var(--border)]/30 [&_td]:leading-[1.4] [&_td]:break-words [&_td]:tabular-nums
  [&_td:first-child]:text-left
  [&_tr:last-child_td]:border-b-0`

function CollapsibleUserMsg({ html, mobile, children }: { html: string; mobile?: boolean; children?: React.ReactNode }) {
  return (
    <div
      className="bg-[var(--hover)] rounded-2xl px-3.5 py-2 user-msg-rise"
      style={{ width: 'fit-content', maxWidth: '100%', marginLeft: 'auto', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
      <div
        className={MD_STYLES}
        style={{ fontSize: mobile ? '23px' : '16px', lineHeight: mobile ? 1.55 : 1.43, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {children}
    </div>
  )
}

// Insert <hr> before the last heading that looks like a conclusion (Fazit, Zusammenfassung, etc.)
function extractSection(markdown: string, heading: string): string {
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

function injectFazitSeparator(html: string): string {
  // Skip short messages or messages that already end with an <hr> near the bottom
  if (html.length < 200) return html
  const lastHr = html.lastIndexOf('<hr')
  if (lastHr > html.length * 0.7) return html
  // Match headings OR bold paragraph starts with conclusion keywords
  const keywords = 'Fazit|Zusammenfassung|Abschließend|Schluss|Ergebnis|Kurzfassung|Resumee|Résumé|Conclusion|Summary|TL;DR|Bottom Line|Kurz gesagt|Zusammengefasst|Quintessenz'
  const pattern = new RegExp(`(?:<h[1-3][^>]*>(?:.*?)(?:${keywords})(?:.*?)<\\/h[1-3]>|<p><strong>(?:${keywords}):?<\\/strong>)`, 'gi')
  let lastMatch: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = pattern.exec(html)) !== null) lastMatch = m
  // Only insert if it's in the last 50% of the content (actual conclusion)
  if (lastMatch && lastMatch.index > html.length * 0.5) {
    return html.slice(0, lastMatch.index) + '<hr>' + html.slice(lastMatch.index)
  }
  return html
}

// Inject color-swatches next to hex codes in plain text (not inside code/pre/tag/attributes).
function injectColorSwatches(html: string): string {
  if (html.indexOf('#') === -1) return html
  const protectedRe = /<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>/g
  const hexRe = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g
  const parts: string[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = protectedRe.exec(html)) !== null) {
    parts.push(html.slice(lastIdx, m.index))
    parts.push(m[0])
    lastIdx = m.index + m[0].length
  }
  parts.push(html.slice(lastIdx))
  const swatchStyle = 'display:inline-block;width:0.85em;height:0.85em;border-radius:50%;margin-right:0.3em;vertical-align:-0.08em;border:1px solid rgba(127,127,127,0.25);box-shadow:0 0 0 1px rgba(0,0,0,0.04) inset;'
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(hexRe, (match, hex) => `<span class="color-swatch" style="${swatchStyle}background-color:#${hex}"></span>${match}`)
  }
  return parts.join('')
}

// Memoized markdown renderer — preserves DOM nodes (and text selection) across parent re-renders
const MemoizedMarkdown = memo(function MemoizedMarkdown({ html, className, style, 'data-streaming': streaming }: { html: string; className?: string; style?: React.CSSProperties; 'data-streaming'?: boolean | undefined }) {
  return <div className={className} style={style} data-streaming={streaming ? 'true' : undefined} dangerouslySetInnerHTML={{ __html: html }} />
}, (prev, next) => prev.html === next.html && prev.className === next.className && prev['data-streaming'] === next['data-streaming'])

// Module-level Persistenz für Typewriter-Fortschritt. Damit überlebt der
// Reveal-State Re-Mounts (z.B. wenn Chat.tsx mid-stream zwischen zwei
// Render-Pfaden wechselt, sobald ein Tool-Call dazukommt). Sonst geht
// `armed` verloren und der Rest wird sofort gedumpt.
// Zusätzlich wird der Stand in sessionStorage gespiegelt, damit nach einem
// Hard Refresh schon gelesene Antworten nicht von vorne animiert werden.
const TYPEWRITER_SS_KEY = 'agent.typewriter.v1'

function loadTypewriterState(): Map<string, { revealed: number; armed: boolean }> {
  if (typeof sessionStorage === 'undefined') return new Map()
  try {
    const raw = sessionStorage.getItem(TYPEWRITER_SS_KEY)
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, { revealed: number; armed: boolean }>
    return new Map(Object.entries(obj))
  } catch { return new Map() }
}

export const typewriterState = loadTypewriterState()

let typewriterPersistTimer: number | null = null
function schedulePersistTypewriter() {
  if (typeof sessionStorage === 'undefined') return
  if (typewriterPersistTimer != null) return
  typewriterPersistTimer = window.setTimeout(() => {
    typewriterPersistTimer = null
    try {
      const obj: Record<string, { revealed: number; armed: boolean }> = {}
      typewriterState.forEach((v, k) => { obj[k] = v })
      sessionStorage.setItem(TYPEWRITER_SS_KEY, JSON.stringify(obj))
    } catch { /* ignore quota */ }
  }, 250) as unknown as number
}

function setTypewriter(key: string, val: { revealed: number; armed: boolean }) {
  typewriterState.set(key, val)
  schedulePersistTypewriter()
}

// Vom Reattach-Pfad nutzbar: markiert für eine Message den aktuellen Stand
// als „schon gelesen", damit nach Hard Refresh nicht alles neu animiert wird.
export function markTypewriterRead(messageTs: number | string, charsRead: number) {
  setTypewriter(`m${messageTs}-text-0`, { revealed: charsRead, armed: true })
}

// Reveal-Stil: 'cursor' = klassisches Zeichen-Tippen, 'soft' = wortweise mit
// weicher Einblend-Maske (ruhiger Apple-Look).
function readRevealStyle(): 'cursor' | 'soft' {
  return localStorage.getItem('control:revealStyle') === 'soft' ? 'soft' : 'cursor'
}
function readSmartBlocks(): boolean {
  return (localStorage.getItem('control:smartBlocks') ?? 'false') === 'true'
}

// Liest Reveal-Stil + smartBlocks live und hört auf Style-Änderungen.
function useChatStyleFlags(): { revealStyle: 'cursor' | 'soft'; smartBlocks: boolean } {
  const [flags, setFlags] = useState(() => ({ revealStyle: readRevealStyle(), smartBlocks: readSmartBlocks() }))
  useEffect(() => {
    const sync = () => setFlags({ revealStyle: readRevealStyle(), smartBlocks: readSmartBlocks() })
    window.addEventListener('deck:chatStyleChanged', sync)
    window.addEventListener('deck:prefsRemoteUpdate', sync)
    return () => {
      window.removeEventListener('deck:chatStyleChanged', sync)
      window.removeEventListener('deck:prefsRemoteUpdate', sync)
    }
  }, [])
  return flags
}

// Höchste Reveal-Position, bei der kein unfertiger Codeblock oder keine
// angefangene Tabellenzeile angeschnitten wird. So bauen sich Code und
// Tabellen nicht zerrupft auf, sondern erscheinen am Stück, sobald komplett.
function safeRevealLimit(s: string): number {
  const fences: number[] = []
  let p = s.indexOf('```')
  while (p !== -1) { fences.push(p); p = s.indexOf('```', p + 3) }
  if (fences.length % 2 === 1) return fences[fences.length - 1]
  if (!s.endsWith('\n')) {
    const lastNl = s.lastIndexOf('\n')
    const lastLine = s.slice(lastNl + 1)
    if (lastLine.includes('|')) return lastNl + 1
  }
  return s.length
}

// Taktet das Streaming wie Lesen: pro Zeichen ein Basis-Delay, dazu kurze
// Atempausen an Interpunktion. Start sanfter, dann gleichmäßig.
function useTypewriter(target: string, enabled: boolean, charsPerSecond: number, persistKey?: string, fromStart = false, restartToken?: number | null, soft = false, smartBlocks = false): { revealed: string; skip: () => void } {
  const stateKey = persistKey || ''
  const restored = stateKey ? typewriterState.get(stateKey) : undefined
  const [revealed, setRevealed] = useState<string>(() => {
    if (!enabled) return target
    if (restored) return target.slice(0, Math.min(restored.revealed, target.length))
    // Ein neuer Textblock nach Tool-Schritten muss wirklich sichtbar einlaufen.
    // Reattach-Snapshots werden vorher über typewriterState vorgemerkt.
    return ''
  })
  const targetRef = useRef(target)
  targetRef.current = target
  const speedRef = useRef(charsPerSecond)
  speedRef.current = charsPerSecond
  const softRef = useRef(soft)
  softRef.current = soft
  const smartRef = useRef(smartBlocks)
  smartRef.current = smartBlocks
  const [armed, setArmed] = useState<boolean>(() => enabled && (restored?.armed ?? true))
  const restartTokenRef = useRef<number | null | undefined>(restartToken)
  const revealedRef = useRef(revealed)
  revealedRef.current = revealed
  // Drain-Modus: läuft die Animation beim Stream-Ende noch, tippt sie sichtbar
  // bis zum Ende aus, statt hart auf den vollen Text zu springen.
  const drainingRef = useRef(false)

  // Beim Stream-Ende (animate true→false) NICHT hart auf den vollen Text
  // springen, sondern den Rest sauber austippen lassen (Drain). Nur wenn der
  // Reveal ohnehin fertig ist oder kein rAF läuft (Tab im Hintergrund), sofort
  // komplettieren, damit nie ein halber Text einfriert.
  useEffect(() => {
    if (enabled) { drainingRef.current = false; return }
    const done = target.length === 0 || revealedRef.current.length >= target.length
    const hidden = typeof document !== 'undefined' && document.hidden
    if (done || hidden) { drainingRef.current = false; setRevealed(target); return }
    drainingRef.current = true
    setArmed(true)
  }, [enabled, target])

  // Drain abgeschlossen: Animation sauber beenden.
  useEffect(() => {
    if (drainingRef.current && target.length > 0 && revealed.length >= target.length) {
      drainingRef.current = false
      setArmed(false)
    }
  }, [revealed, target])

  // Geht der Tab während des Drains in den Hintergrund, pausiert rAF und der
  // Text würde einfrieren — dann sofort komplettieren.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVis = () => {
      if (document.hidden && drainingRef.current) {
        drainingRef.current = false
        setRevealed(targetRef.current)
        setArmed(false)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  useEffect(() => {
    if (enabled && !armed) {
      setRevealed(prev => (target.length > 0 && prev.length >= target.length ? '' : prev))
      setArmed(true)
    }
  }, [enabled, armed, target])

  useEffect(() => {
    if (enabled && fromStart) {
      // Wenn der Text laut sessionStorage-Cache schon komplett gelesen wurde
      // (Mobile-Send, Conv-Reload usw.), KEINEN Buchstaben-für-Buchstaben-
      // Replay starten — er wurde bereits vollständig gestreamt.
      const fresh = stateKey ? typewriterState.get(stateKey) : undefined
      if (fresh && fresh.revealed >= target.length && target.length > 0) {
        setRevealed(target)
        setArmed(false)
        return
      }
      setRevealed(prev => (target.length > 0 && prev.length >= target.length ? '' : prev))
      setArmed(true)
    }
  }, [enabled, fromStart, target, stateKey])

  useEffect(() => {
    if (!enabled) {
      restartTokenRef.current = restartToken
      return
    }
    if (restartToken == null || restartTokenRef.current === restartToken) return
    restartTokenRef.current = restartToken
    const fresh = stateKey ? typewriterState.get(stateKey) : undefined
    if (fresh && fresh.revealed >= target.length && target.length > 0) {
      setRevealed(target)
      setArmed(false)
      return
    }
    setRevealed(prev => (target.length > 0 && prev.length >= target.length ? '' : prev))
    setArmed(true)
  }, [enabled, restartToken, target, stateKey])

  // Persistent halten: jeder neue revealed-Stand wird in die Map (und
  // gedrosselt in sessionStorage) gespiegelt.
  useEffect(() => {
    if (!stateKey) return
    setTypewriter(stateKey, { revealed: revealed.length, armed })
  }, [stateKey, revealed, armed])

  useEffect(() => {
    if (!armed) { setRevealed(target); return }
    setRevealed(prev => (prev.length > target.length ? target : prev))
    let raf = 0
    let last = performance.now()
    const startTime = last
    let budget = 0

    const tick = () => {
      const now = performance.now()
      const dt = Math.min(now - last, 100)
      last = now
      budget += dt

      setRevealed(prev => {
        const tgt = targetRef.current
        const limit = smartRef.current ? Math.min(tgt.length, safeRevealLimit(tgt)) : tgt.length
        if (prev.length >= limit) return prev
        const cps = Math.max(2, speedRef.current)
        const base = 1000 / cps
        const elapsed = now - startTime
        const easing = elapsed < 280 ? 1.8 : 1.0
        const wordwise = softRef.current

        let next = prev
        let safety = 0
        while (next.length < limit && safety++ < 5000) {
          const lastCh = next[next.length - 1] || ''
          const prevCh = next[next.length - 2] || ''
          let delay = base
          if (lastCh === '\n') {
            delay = prevCh === '\n' ? base + 500 : base + 200
          } else if (',;:'.indexOf(lastCh) >= 0) {
            delay = base + 100
          } else if ('.!?'.indexOf(lastCh) >= 0) {
            const nextCh = tgt[next.length] || ''
            if (nextCh === ' ' || nextCh === '\n' || nextCh === '') delay = base + 280
          }
          delay *= easing
          if (budget < delay) break
          budget -= delay
          next += tgt[next.length]
          // Sanft-Stil: ganzes Wort auf einen Schlag freigeben, dann einblenden.
          if (wordwise) {
            while (next.length < limit && !/\s/.test(tgt[next.length] ?? ' ')) {
              next += tgt[next.length]
            }
          }
        }
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [armed])

  useEffect(() => { if (!armed) setRevealed(target) }, [armed, target])

  const skip = useCallback(() => {
    const tgt = targetRef.current
    setRevealed(tgt)
    if (stateKey) setTypewriter(stateKey, { revealed: tgt.length, armed: true })
  }, [stateKey])

  return { revealed, skip }
}

function AgentTextBlock({ text, animate, speed, onClick, mobile: _mobile, persistKey, fromStart = false, restartToken, onRevealComplete, tone = 'default' }: { text: string; animate: boolean; speed: number; onClick?: (e: React.MouseEvent) => void; mobile?: boolean; persistKey?: string; fromStart?: boolean; restartToken?: number | null; onRevealComplete?: () => void; tone?: 'default' | 'answer' | 'work' }) {
  const { revealStyle, smartBlocks } = useChatStyleFlags()
  const { revealed, skip } = useTypewriter(text, animate, speed, persistKey, fromStart, restartToken, revealStyle === 'soft', smartBlocks)
  const streaming = animate && revealed.length < text.length
  const completionKeyRef = useRef('')
  const pendingRestartRef = useRef<number | null>(null)

  useEffect(() => {
    if (restartToken == null) return
    if (pendingRestartRef.current === restartToken) return
    // Wenn der Text bereits vollständig angezeigt ist (Stream durchgelaufen
    // oder aus sessionStorage restored), KEIN Replay anstoßen — sonst spielt
    // er Buchstabe für Buchstabe erneut, obwohl das schon passiert ist.
    if (revealed.length >= text.length && text.length > 0) {
      pendingRestartRef.current = null
      completionKeyRef.current = ''
      return
    }
    pendingRestartRef.current = restartToken
  }, [restartToken, revealed.length, text.length])

  useEffect(() => {
    if (pendingRestartRef.current == null) return
    if (revealed.length < text.length) pendingRestartRef.current = null
  }, [revealed.length, text.length])

  useEffect(() => {
    if (!onRevealComplete || !animate) return
    if (pendingRestartRef.current != null) return
    if (revealed.length < text.length) return
    const completionKey = `${persistKey || text.length}:${text.length}:${restartToken ?? 'live'}`
    if (completionKeyRef.current === completionKey) return
    completionKeyRef.current = completionKey
    onRevealComplete()
  }, [animate, onRevealComplete, persistKey, restartToken, revealed.length, text.length])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (streaming) { skip(); return }
    if (onClick) onClick(e)
  }, [streaming, skip, onClick])

  // Markdown-Pipeline memoisieren: marked.parse + DOMPurify + Highlighting sind
  // teuer. Ohne Memo parst beim Streaming jeder setMessages-Tick ALLE Bot-Bubbles
  // neu (nicht nur die tippende), weil der Parent neu rendert. Mit [revealed] als
  // Dep parst eine fertige Bubble nur einmal; nur die streamende rechnet weiter.
  const html = useMemo(
    () => injectColorSwatches(injectFazitSeparator(renderMarkdownHtml(revealed))),
    [revealed],
  )

  return (
    <div onClick={handleClick}>
      <MemoizedMarkdown
        html={html}
        className={`chat-md-agent ${MD_STYLES} ${tone === 'answer' ? 'answer-md' : tone === 'work' ? 'work-md' : ''} ${streaming && revealStyle === 'soft' ? 'chat-reveal-soft' : ''}`}
        data-streaming={streaming || undefined}
      />
    </div>
  )
}

function CalmWorkLine({ text, mobile, separated = false }: { text: string; mobile?: boolean; separated?: boolean }) {
  return (
    <div className={`mb-2 ${separated ? 'work-trace-divider pt-3' : ''}`}>
      <div className="work-trace-body opacity-78">
        <AgentTextBlock
          text={text}
          animate={false}
          speed={0}
          mobile={mobile}
          tone="work"
        />
      </div>
    </div>
  )
}

function AnswerSeparator({ label }: { label: string }) {
  return (
    <div className="answer-separator" aria-hidden="true">
      <span className="answer-separator-line" />
      <span className="answer-separator-label">{label}</span>
      <span className="answer-separator-line" />
    </div>
  )
}

function splitCalmText(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (!cleaned) return []

  const paragraphs = cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const chunks: string[] = []

  for (const paragraph of paragraphs) {
    if (paragraph.length <= 320) {
      chunks.push(paragraph)
      continue
    }

    const sentences = paragraph.match(/[^.!?\n]+(?:[.!?…]+|$)/g)?.map(s => s.trim()).filter(Boolean) || [paragraph]
    let current = ''

    for (const sentence of sentences) {
      if (!current) {
        current = sentence
        continue
      }
      const next = `${current} ${sentence}`.trim()
      if (next.length <= 320) current = next
      else {
        chunks.push(current)
        current = sentence
      }
    }

    if (current) chunks.push(current)
  }

  const merged: string[] = []
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1]
    if (prev && prev.length < 120 && `${prev}\n\n${chunk}`.length <= 320) merged[merged.length - 1] = `${prev}\n\n${chunk}`
    else merged.push(chunk)
  }

  return merged
}

function normalizeCalmTextGroups(groups: { text: string }[], splitSingleRaw = false): { text: string }[] {
  const cleaned = groups.map(g => g.text.trim()).filter(Boolean)
  if (cleaned.length <= 1) {
    if (splitSingleRaw && cleaned[0]) {
      const chunks = splitCalmText(cleaned[0])
      if (chunks.length > 1) return chunks.map(text => ({ text }))
    }
    return cleaned.map(text => ({ text }))
  }

  const finalText = cleaned[cleaned.length - 1]
  const workTexts = cleaned.slice(0, -1).flatMap(splitCalmText)
  return [...workTexts.map(text => ({ text })), { text: finalText }]
}

function ContextBlock({ context }: { context: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[13px] text-[var(--t3)] hover:text-[var(--t2)] transition-all cursor-pointer"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Kontext
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3 max-h-[200px] overflow-y-auto text-[14px] font-mono text-[var(--t3)] leading-relaxed whitespace-pre-wrap">
          {context}
        </div>
      )}
    </div>
  )
}

function stripHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

function parseContent(content: string): { context?: string; message: string } {
  const cleaned = stripHtmlComments(content)
  const match = cleaned.match(/^Kontext:\n```\n([\s\S]*?)\n```\n\n([\s\S]*)$/)
  if (match) return { context: match[1], message: match[2] }
  return { message: cleaned }
}

interface KlausPingMeta {
  source: string
  label: string
  tone: 'digest' | 'notice' | 'decision' | 'signal'
}

function parseKlausPingMeta(content: string): KlausPingMeta | null {
  const marker = content.match(/<!--klaus-channel:([^:>]*):([^>]*)-->/)
  if (!marker) return null
  const source = (marker[1] || '').trim()
  const labelMap: Record<string, { label: string; tone: KlausPingMeta['tone'] }> = {
    morgenbriefing: { label: 'Morgenbriefing', tone: 'digest' },
    'health-chat': { label: 'Gesundheitscheck', tone: 'signal' },
    'radar-intraday': { label: 'Radarhinweis', tone: 'signal' },
    'dreaming-pattern': { label: 'Mir fällt auf', tone: 'signal' },
    'learning-curator': { label: 'Lernvorschlag', tone: 'signal' },
    systemagent: { label: 'Systemagenthinweis', tone: 'signal' },
    werkbank: { label: 'Werkbank', tone: 'signal' },
    'skill-bibliothekar': { label: 'Systemagenthinweis', tone: 'decision' },
    'mail-scanner': { label: 'Hinweis', tone: 'notice' },
    'lead-reconciler': { label: 'Hinweis', tone: 'notice' },
    'lead-digest': { label: 'Hinweis', tone: 'notice' },
    'mail-send': { label: 'Hinweis', tone: 'notice' },
  }
  const mapped = labelMap[source] || { label: 'Hinweis', tone: 'signal' as const }
  return { source, label: mapped.label, tone: mapped.tone }
}

function MobileInlineActions({ content, ts, isAgent, isUser, onSpeak, isPlaying, onQuote, onResend, onClose }: { content: string; ts?: number; isAgent: boolean; isUser: boolean; onSpeak?: () => void; isPlaying?: boolean; onQuote: () => void; onResend?: (text: string) => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const timeStr = ts ? formatTimestamp(ts) : ''

  useEffect(() => {
    const timer = setTimeout(onClose, 5000)
    return () => clearTimeout(timer)
  }, [onClose])

  const doCopy = async () => {
    try { await navigator.clipboard.writeText(content) } catch {
      const ta = document.createElement('textarea'); ta.value = content; ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className={`flex items-center gap-3 mt-2 animate-[fadeIn_0.15s_ease] ${isUser ? 'justify-end' : 'justify-start'}`}
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
    >
      {isUser && onResend && (
        <button onClick={() => { onResend(content); onClose() }} className="p-2 rounded-lg active:bg-[var(--bg-3)] text-[var(--t3)] transition-colors cursor-pointer">
          <RotateCcw className="w-5 h-5" />
        </button>
      )}
      <button onClick={doCopy} className={`p-2 rounded-lg active:bg-[var(--bg-3)] transition-colors cursor-pointer ${copied ? 'text-[var(--green)]' : 'text-[var(--t3)]'}`}>
        {copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
      </button>
      {isAgent && (
        <button onClick={() => { onQuote(); onClose() }} className="p-2 rounded-lg active:bg-[var(--bg-3)] text-[var(--t3)] transition-colors cursor-pointer">
          <Reply className="w-5 h-5" />
        </button>
      )}
      {isAgent && onSpeak && (
        <button onClick={onSpeak} className={`p-2 rounded-lg active:bg-[var(--bg-3)] transition-colors cursor-pointer ${isPlaying ? 'text-[var(--purple)]' : 'text-[var(--t3)]'}`}>
          {isPlaying ? <Pause className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      )}
      {timeStr && <span className="text-[16px] text-[var(--t3)]">{timeStr}</span>}
    </div>
  )
}

function AgentMessageActions({ content, ts, onSpeak, isPlaying, mobile, hidden }: { content: string; ts?: number; onSpeak?: () => void; isPlaying?: boolean; mobile?: boolean; hidden?: boolean }) {
  const [copied, setCopied] = useState(false)

  if (hidden) return null

  const timeStr = ts ? formatTimestamp(ts) : ''
  const iconSize = mobile ? 'w-[24px] h-[24px]' : 'w-[20px] h-[20px]'
  const padCls = mobile ? 'p-2' : 'p-1.5'

  return (
    <div
      className={`flex items-center mt-1.5 justify-start ${mobile ? 'gap-3' : 'gap-1.5'}`}
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
    >
      {onSpeak && (
        <button onClick={onSpeak} className={`${padCls} rounded-md transition-colors cursor-pointer ${isPlaying ? 'text-[var(--t2)] hover:text-white' : 'text-[var(--t3)]/65 hover:text-white'}`} title="Abspielen">
          {isPlaying ? <Pause className={iconSize} /> : <Volume2 className={iconSize} />}
        </button>
      )}
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(content) } catch {
            const ta = document.createElement('textarea'); ta.value = content; ta.style.cssText = 'position:fixed;opacity:0'
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
          }
          setCopied(true); setTimeout(() => setCopied(false), 1500)
        }}
        className={`${padCls} rounded-md transition-colors cursor-pointer ${copied ? 'text-[var(--green)]' : 'text-[var(--t3)]/65 hover:text-white'}`}
        title="Kopieren"
      >
        {copied ? <Check className={iconSize} /> : <Copy className={iconSize} />}
      </button>
      {timeStr && (
        <span className={`${mobile ? 'text-[15px]' : 'text-[14px]'} text-[var(--t3)]/65`}>{timeStr}</span>
      )}
    </div>
  )
}

function toolAction(name: string): string {
  switch (name) {
    case 'exec': case 'Bash': return 'Führe aus'
    case 'read': case 'Read': return 'Lese'
    case 'write': case 'Write': return 'Schreibe'
    case 'edit': case 'Edit': return 'Bearbeite'
    case 'grab': case 'Grep': return 'Durchsucht Code'
    case 'Glob': return 'Suche Dateien'
    case 'web_search': case 'WebSearch': return 'Websuche'
    case 'web_fetch': case 'WebFetch': return 'Lade Webseite'
    case 'Agent': return 'Hole zweite Meinung'
    default: return name.replace(/([a-z])([A-Z])/g, '$1 $2')
  }
}

export type TallyItem = {
  count?: number
  label: string
  tone?: 'add' | 'del'
  prefix?: string
  added?: number
  removed?: number
}

// Strukturierte Lauf-Bilanz — eine Liste statt eines fertigen Strings,
// damit die Zahlen einzeln hochlaufen können.
export function buildTallyItems(tools: ToolCall[]): TallyItem[] {
  const done = tools.filter(t => t.status === 'completed')
  const reads = done.filter(t => ['Read', 'read'].includes(t.name)).length
  const edits = done.filter(t => ['Edit', 'edit'].includes(t.name)).length
  const writes = done.filter(t => ['Write', 'write'].includes(t.name)).length
  const searches = done.filter(t => ['Grep', 'grab', 'Glob'].includes(t.name)).length
  const bash = done.filter(t => ['Bash', 'exec'].includes(t.name)).length
  const webs = done.filter(t => ['WebSearch', 'WebFetch', 'web_search', 'web_fetch'].includes(t.name)).length
  const agents = done.filter(t => t.name === 'Agent').length
  let addedLines = 0
  let removedLines = 0
  done.forEach(t => {
    if (t.diffStats) {
      addedLines += t.diffStats.added || 0
      removedLines += t.diffStats.removed || 0
    }
  })
  // Bewusst reduziert: im Footer interessieren nur Zeit, Token und die
  // geänderten Zeilen. Die einzelnen Tool-Zähler (gelesen, Suchen, Checks,
  // Quellen, Änderungen, zweite Meinungen) bleiben absichtlich ungezeigt.
  void reads; void edits; void writes; void searches; void bash; void webs; void agents
  const items: TallyItem[] = []
  if (addedLines > 0 || removedLines > 0) {
    items.push({ label: 'Zeilen', added: addedLines, removed: removedLines })
  }
  return items
}

// Eased-Tween für Zahlen — beim Sprung von alt zu neu läuft die Zahl in
// ~500 ms weich hoch, statt zu schnappen.
function AnimatedNumber({ value, durationMs = 520 }: { value: number; durationMs?: number }) {
  const [shown, setShown] = useState(value)
  const fromRef = useRef(value)
  const targetRef = useRef(value)
  targetRef.current = value

  useEffect(() => {
    if (value === shown) return
    fromRef.current = shown
    const startTime = performance.now()
    let raf = 0
    const tick = () => {
      const now = performance.now()
      const t = Math.min(1, (now - startTime) / durationMs)
      const eased = 1 - Math.pow(1 - t, 3)
      const next = Math.round(fromRef.current + (targetRef.current - fromRef.current) * eased)
      setShown(next)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs])

  return <>{shown}</>
}

// Rendert die Tally-Items mit hochlaufenden Zahlen und kommata getrennt.
function TallyView({ items, className, style }: { items: TallyItem[]; className?: string; style?: React.CSSProperties }) {
  if (items.length === 0) return null
  return (
    <span className={className} style={style}>
      {items.map((item, i) => (
        <span
          key={`${item.tone || 'plain'}:${item.label}:${i}`}
        >
          {i > 0 ? ', ' : ''}
          {typeof item.added === 'number' || typeof item.removed === 'number' ? (
            <>
              {item.label}: {' '}
              {item.added ? (
                <span style={{ color: 'var(--diff-add-soft)' }}>+<AnimatedNumber value={item.added} /></span>
              ) : null}
              {item.added && item.removed ? ' / ' : null}
              {item.removed ? (
                <span style={{ color: 'var(--diff-del-soft)' }}>-<AnimatedNumber value={item.removed} /></span>
              ) : null}
            </>
          ) : (
            <>
              {item.tone ? (
                <span style={{ color: item.tone === 'add' ? 'var(--diff-add-soft)' : 'var(--diff-del-soft)' }}>
                  {item.prefix || ''}<AnimatedNumber value={item.count || 0} />
                </span>
              ) : (
                <AnimatedNumber value={item.count || 0} />
              )}
              {' '}{item.label}
            </>
          )}
        </span>
      ))}
    </span>
  )
}

export function aggregateHint(name: string, count: number): string {
  if (count < 2) return ''
  switch (name) {
    case 'read': case 'Read': return `${count} Dateien gelesen`
    case 'edit': case 'Edit': return `${count} Änderungen`
    case 'write': case 'Write': return `${count} Dateien geschrieben`
    case 'exec': case 'Bash': return `${count} Checks`
    case 'grab': case 'Grep': case 'Glob': return `${count} Suchen`
    case 'web_search': case 'WebSearch': return `${count} Websuchen`
    case 'web_fetch': case 'WebFetch': return `${count} Seiten`
    case 'Agent': return `${count} zweite Meinungen`
    default: return `${count} Schritte`
  }
}

export function aggregateMeta(name: string, count: number): string {
  if (count < 2) return ''
  switch (name) {
    case 'read': case 'Read': return `Schon ${count} Dateien geprüft`
    case 'edit': case 'Edit': return `Schon ${count} Stellen angepasst`
    case 'write': case 'Write': return `Schon ${count} Dateien aufgebaut`
    case 'exec': case 'Bash': return `Schon ${count} Checks gelaufen`
    case 'grab': case 'Grep': case 'Glob': return `Schon ${count} Stellen abgeklopft`
    case 'web_search': case 'WebSearch': case 'web_fetch': case 'WebFetch': return `Schon ${count} Quellen geprüft`
    case 'Agent': return `Schon ${count} zweite Meinungen geholt`
    case 'TodoWrite': return `Schon ${count} Schritte sortiert`
    default: return `Schon ${count} Schritte durch`
  }
}

function toolStatus(status?: string): 'active' | 'done' | 'error' {
  if (status === 'completed') return 'done'
  if (status === 'error') return 'error'
  return 'active'
}

function readToolStepMinMs(): number {
  const raw = localStorage.getItem('control:toolStepMinMs')
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n >= 600 ? n : 2500
}

function toolEmphasis(name: string): 'high' | 'med' | 'low' {
  if (['Edit','edit','Write','write','Bash','exec','Agent'].includes(name)) return 'high'
  if (['Read','read','TodoWrite'].includes(name)) return 'med'
  return 'low'
}

function ToolStep({ tool, mobile }: { tool: ToolCall; mobile?: boolean }) {
  const [open, setOpen] = useState(false)
  const state = toolStatus(tool.status)
  const running = state === 'active'
  const hasOutput = !!tool.output
  const ds = tool.diffStats
  const p = tool.input || {}
  const filePath = String(p.file_path || p.path || '')
  const command = String(p.command || '')
  const pattern = String(p.pattern || p.query || p.glob || '')
  const description = String(p.description || '')
  const action = toolAction(tool.name)
  const isBash = tool.name === 'Bash' || tool.name === 'exec'
  const isSearch = ['grab', 'Grep', 'Glob'].includes(tool.name)
  const isAgent = tool.name === 'Agent'

  // Primary label: what's shown next to the action word
  let label = ''
  if (filePath) label = filePath
  else if (isAgent && description) label = description
  else if (isBash && description) label = description
  else if (isBash && command) label = command
  else if (pattern) label = pattern

  // Detail line: supplementary info (search path for grep, full command for bash with description)
  const details: string[] = []
  if (isAgent && pattern) details.push(pattern)
  if (isSearch && filePath && pattern) {
    // Grep: label shows pattern, detail shows path
    label = pattern
    details.push(filePath)
  } else if (isSearch && pattern && !filePath) {
    // Search without specific path — no extra detail needed
  }
  if (isBash && description && command) details.push(command)

  const openFile = (path: string) => {
    if (!path) return
    window.dispatchEvent(new CustomEvent('deck:openFile', { detail: path }))
  }
  const labelIsFile = label === filePath && !!filePath

  const emphasis = toolEmphasis(tool.name)
  const actionColor = running
    ? 'work-trace-strong'
    : state === 'error' ? 'text-[#ffb1b1]'
      : emphasis === 'high' ? 'work-trace-strong'
      : emphasis === 'med' ? 'work-trace-body'
        : 'work-trace-soft'

  if (mobile) {
    return (
      <div className={`border-t border-[var(--border-f)]/70 ${hasOutput ? 'cursor-pointer' : ''}`}
        onClick={e => { e.stopPropagation(); if (hasOutput) setOpen(!open) }}
      >
        {/* Zeile 1: Aktion links, Diff/Chevron rechts */}
        <div className={`flex items-center gap-2 pt-1.5 text-[16px] transition-all ${
          hasOutput ? 'hover:text-[var(--t1)]' : ''
        } ${actionColor}`}>
          <span className="font-semibold flex-shrink-0">{action}</span>
          {running && <span className="animate-pulse flex-shrink-0">…</span>}
          <span className="ml-auto flex items-center gap-2 flex-shrink-0">
            {ds && (ds.added > 0 || ds.removed > 0) && (
              <span className="flex items-center gap-1.5 text-[16px] font-mono font-medium">
                {ds.added > 0 && <span className="text-[var(--diff-add)]">+{ds.added}</span>}
                {ds.removed > 0 && <span className="text-[var(--diff-del)]">-{ds.removed}</span>}
              </span>
            )}
            {hasOutput && (
              <ChevronRight className={`w-3.5 h-3.5 opacity-30 transition-transform ${open ? 'rotate-90' : ''}`} />
            )}
          </span>
        </div>
        {/* Zeile 2: Pfad/Label, linksbündig auf gleicher Ebene wie die Aktion */}
        {label && (
          labelIsFile ? (
            <div
              onClick={e => { e.stopPropagation(); openFile(filePath) }}
              className="text-[15px] font-mono work-trace-body opacity-80 pb-1.5 break-all active:text-[var(--t1)]"
              title="In InfoPane öffnen"
            >{label}</div>
          ) : (
            <div className="text-[15px] font-mono work-trace-body opacity-70 pb-1.5 break-all">{label}</div>
          )
        )}
        {!label && <div className="pb-1" />}
        {details.length > 0 && details.map((d, i) => {
          const isPath = d === filePath && !!filePath
          return isPath ? (
            <div key={i}
              onClick={e => { e.stopPropagation(); openFile(d) }}
              className="text-[14px] font-mono work-trace-soft -mt-1 pb-1.5 break-all active:text-[var(--t2)]"
              title="In InfoPane öffnen"
            >{d}</div>
          ) : (
            <div key={i} className="text-[14px] font-mono work-trace-faint -mt-1 pb-1.5 break-all">{d}</div>
          )
        })}
        {open && tool.output && (
          <pre className="mb-2 text-[14px] leading-[1.5] work-trace-output bg-[var(--bg-1)] rounded-lg px-3 py-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all font-mono border work-trace-border">
            {tool.output.slice(0, 1500)}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className={`border-t border-[var(--border-f)]/70 ${hasOutput ? 'cursor-pointer' : ''}`}
      onClick={e => { e.stopPropagation(); if (hasOutput) setOpen(!open) }}
    >
      {/* Zeile 1: Aktion links, Diff/Chevron rechts */}
      <div className={`flex items-center gap-2 pt-1 text-[14px] transition-all ${
        hasOutput ? 'hover:text-[var(--t1)]' : ''
      } ${actionColor}`}>
        <span className="font-semibold flex-shrink-0">{action}</span>
        {running && <span className="animate-pulse flex-shrink-0">…</span>}
        <span className="ml-auto flex items-center gap-2 flex-shrink-0">
          {ds && (ds.added > 0 || ds.removed > 0) && (
            <span className="flex items-center gap-1.5 text-[14px] font-mono font-medium">
              {ds.added > 0 && <span className="text-[var(--diff-add)]">+{ds.added}</span>}
              {ds.removed > 0 && <span className="text-[var(--diff-del)]">-{ds.removed}</span>}
            </span>
          )}
          {hasOutput && (
            <ChevronRight className={`w-3 h-3 opacity-30 transition-transform ${open ? 'rotate-90' : ''}`} />
          )}
        </span>
      </div>
      {/* Zeile 2: Pfad/Label, linksbündig, darf umbrechen */}
      {label && (
        labelIsFile ? (
          <div
            onClick={e => { e.stopPropagation(); openFile(filePath) }}
            className="text-[13px] font-mono work-trace-body opacity-75 pb-1 break-all hover:text-[var(--t1)] hover:opacity-100 hover:underline decoration-dotted underline-offset-2 cursor-pointer"
            title="In InfoPane öffnen"
          >{label}</div>
        ) : (
          <div className="text-[13px] font-mono work-trace-body opacity-65 pb-1 break-all">{label}</div>
        )
      )}
      {!label && <div className="pb-0.5" />}
      {details.length > 0 && details.map((d, i) => {
        const isPath = d === filePath && !!filePath
        return isPath ? (
          <div key={i}
            onClick={e => { e.stopPropagation(); openFile(d) }}
            className="text-[12px] font-mono work-trace-soft -mt-0.5 pb-1 break-all hover:text-[var(--t2)] hover:underline decoration-dotted underline-offset-2 cursor-pointer"
            title="In InfoPane öffnen"
          >{d}</div>
        ) : (
          <div key={i} className="text-[12px] font-mono work-trace-faint -mt-0.5 pb-1 break-all">{d}</div>
        )
      })}
      {open && tool.output && (
        <pre className="mb-2 text-[13px] leading-[1.5] work-trace-output bg-[var(--bg-1)] rounded-lg px-3 py-2 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all font-mono border work-trace-border">
          {tool.output.slice(0, 1500)}
        </pre>
      )}
    </div>
  )
}

function ToolSummary({ tools, collapsed, elapsedMs }: { tools: ToolCall[], collapsed?: boolean, elapsedMs?: number | null }) {
  const allDone = tools.every(t => t.status === 'completed')
  if (!allDone) return null

  const reads = tools.filter(t => ['Read', 'read'].includes(t.name)).length
  const edits = tools.filter(t => ['Edit', 'edit'].includes(t.name)).length
  const writes = tools.filter(t => ['Write', 'write'].includes(t.name)).length
  const searches = tools.filter(t => ['Grep', 'grab', 'Glob'].includes(t.name)).length
  const bash = tools.filter(t => ['Bash', 'exec'].includes(t.name)).length
  const agents = tools.filter(t => t.name === 'Agent').length

  let totalAdded = 0, totalRemoved = 0
  tools.forEach(t => {
    if (t.diffStats) {
      totalAdded += t.diffStats.added || 0
      totalRemoved += t.diffStats.removed || 0
    }
  })

  const parts: string[] = []
  parts.push(`${tools.length} Tool${tools.length !== 1 ? 's' : ''}`)
  if (reads) parts.push(`${reads} gelesen`)
  if (edits + writes) parts.push(`${edits + writes} bearbeitet`)
  if (searches) parts.push(`${searches} durchsucht`)
  if (bash) parts.push(`${bash} ausgeführt`)
  if (agents) parts.push(`${agents} Subagent${agents > 1 ? 'en' : ''}`)

  return (
    <div className="border-t work-trace-border flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-[14px] font-mono work-trace-soft hover:text-[var(--t2)] transition-colors">
      {elapsedMs && elapsedMs > 0 ? (
        <span className="work-trace-body tabular-nums whitespace-nowrap">
          {Math.round(elapsedMs / 1000)} s
        </span>
      ) : null}
      {parts.map((p, i) => (
        <span key={i} className="whitespace-nowrap">{p}{i < parts.length - 1 ? ',' : ''}</span>
      ))}
      {(totalAdded > 0 || totalRemoved > 0) && (
        <span className="whitespace-nowrap">
          {totalAdded > 0 && <span className="text-[var(--diff-add)]">+{totalAdded}</span>}
          {totalAdded > 0 && totalRemoved > 0 && ' '}
          {totalRemoved > 0 && <span className="text-[var(--diff-del)]">-{totalRemoved}</span>}
        </span>
      )}
      <ChevronRight className={`w-4 h-4 flex-shrink-0 opacity-60 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
    </div>
  )
}

function QuietToolSummary({ tools, collapsed, elapsedMs, mobile }: { tools: ToolCall[], collapsed?: boolean, elapsedMs?: number | null, mobile?: boolean }) {
  let totalAdded = 0
  let totalRemoved = 0
  tools.forEach(t => {
    if (t.diffStats) {
      totalAdded += t.diffStats.added || 0
      totalRemoved += t.diffStats.removed || 0
    }
  })
  const changedLines = totalAdded + totalRemoved
  const latest = tools[tools.length - 1]

  void latest
  void collapsed
  void changedLines
  const tallyItems = buildTallyItems(tools)
  const seconds = elapsedMs && elapsedMs > 0 ? Math.round(elapsedMs / 1000) : 0

  // Kein Schluss-Satz mehr: nach getaner Arbeit bleibt nur der ruhige Tacho
  // stehen (Zeit · Dateien · Checks · Zeilen), in derselben Größe wie live.
  if (seconds <= 0 && tallyItems.length === 0) return null
  return (
    <div className={`py-2 ${mobile ? 'text-[17px]' : 'text-[16px]'}`}>
      <div
        className="text-[13px] work-trace-body tabular-nums leading-[1.2]"
        style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '0.01em' }}
      >
        {seconds > 0 ? (<>{fmtDur(seconds)}{tallyItems.length > 0 ? ' · ' : ''}</>) : null}
        {tallyItems.length > 0 ? <TallyView items={tallyItems} /> : null}
      </div>
    </div>
  )
}

// Mindeststandzeit: ein neuer Schritt löst den alten erst nach 2500ms ab,
// damit der Leser ihn wirklich erfassen kann und der Fluss ruhig bleibt.
function useStickyStep(target: ToolCall | undefined, minMs = 2500): ToolCall | undefined {
  const [shown, setShown] = useState<ToolCall | undefined>(target)
  const sinceRef = useRef(Date.now())
  const pendingRef = useRef<ToolCall | undefined>(undefined)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!target) return

    if (!shown) {
      setShown(target)
      sinceRef.current = Date.now()
      pendingRef.current = undefined
      return
    }

    const sameVisualState = target.id === shown.id && target.status === shown.status
    if (sameVisualState) {
      setShown(target)
      return
    }

    pendingRef.current = target

    const flushPending = () => {
      const next = pendingRef.current
      if (!next) return
      setShown(next)
      sinceRef.current = Date.now()
      pendingRef.current = undefined
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const elapsed = Date.now() - sinceRef.current
    if (elapsed >= minMs) {
      flushPending()
      return
    }

    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flushPending, minMs - elapsed)

    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, target?.status, target?.name])

  return shown
}

// Schlichter Satzwechsel: prev bleibt kurz liegen und fadet nur über Opacity
// aus, current fadet parallel ein.
export function CrossfadeText({ k, children, className, style }: { k: string; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const [current, setCurrent] = useState<{ k: string; node: React.ReactNode }>({ k, node: children })
  const [prev, setPrev] = useState<{ k: string; node: React.ReactNode } | null>(null)
  const prevTimer = useRef<number | null>(null)

  useEffect(() => {
    if (k === current.k) {
      setCurrent({ k, node: children })
      return
    }
    if (prevTimer.current != null) window.clearTimeout(prevTimer.current)
    setPrev(current)
    setCurrent({ k, node: children })
    prevTimer.current = window.setTimeout(() => { setPrev(null); prevTimer.current = null }, 540)
    return () => {
      if (prevTimer.current != null) { window.clearTimeout(prevTimer.current); prevTimer.current = null }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, children])

  return (
    <div className={className} style={{ position: 'relative', ...style }}>
      <div key={current.k} className="quiet-presence-fade-in">{current.node}</div>
      {prev ? (
        <div
          key={prev.k}
          className="quiet-presence-fade-out"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          {prev.node}
        </div>
      ) : null}
    </div>
  )
}

// Dauer als ruhiger Tacho-Wert: unter einer Minute schlicht Sekunden,
// darüber m:ss wie eine Stoppuhr.
export function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// Laufende Gesamtzeit des aktiven Laufs: startet beim Erscheinen der Live-Zeile
// und tickt sekündlich, stabil über Re-Renders (Startzeit im Ref). Die exakte
// Schlusszeit liefert hinterher das Backend in der Summary.
// Schlichte Live-Uhr für die Denkphase, bevor der erste Tool-Schritt kommt:
// gleiche Optik wie der Tacho oben (Zeit gross, darunter ein ruhiges Statuswort),
// nur die laufende Zeit ab Absenden. Die Sekunden kommen aus ChatPane (eine Quelle
// der Wahrheit, übersteht auch einen Hard Refresh). So steht von Sekunde eins an
// schon etwas da statt nur nackter Zahlen.
function ThinkingElapsedRow({ mobile, label }: { elapsedSeconds?: number; mobile?: boolean; label?: string }) {
  // Die laufende Zeit lebt jetzt allein in der Composer-Pille. Im Chatfluss bleibt
  // nur das ruhige Statuswort, bis die Toolcalls uebernehmen, kein doppelter Tacho.
  const status = (label && label.trim()) || 'Denke nach'
  return (
    <div className={`flex flex-col ${mobile ? 'py-2' : 'py-1.5'}`}>
      <span
        className={`status-shimmer-warm leading-[1.3] ${mobile ? 'text-[15px]' : 'text-[14px]'}`}
        style={{ fontFamily: 'var(--font-heading)', letterSpacing: '0.01em' }}
      >
        {status}
      </span>
    </div>
  )
}

function QuietToolRow({ tools, mobile, expanded = false, onToggle }: { tools: ToolCall[]; mobile?: boolean; expanded?: boolean; onToggle: () => void; elapsedSeconds?: number }) {
  const latest = tools.find(t => t.status !== 'completed') || tools[tools.length - 1]
  const [toolStepMinMs, setToolStepMinMs] = useState<number>(() => readToolStepMinMs())
  useEffect(() => {
    const sync = () => setToolStepMinMs(readToolStepMinMs())
    window.addEventListener('deck:chatStyleChanged', sync)
    window.addEventListener('deck:prefsRemoteUpdate', sync)
    return () => {
      window.removeEventListener('deck:chatStyleChanged', sync)
      window.removeEventListener('deck:prefsRemoteUpdate', sync)
    }
  }, [])
  const shown = useStickyStep(latest, toolStepMinMs)
  if (!shown) return null
  const state = toolStatus(shown.status)

  // Keine laufende Zeit mehr im Chatfluss (die lebt in der Composer-Pille). Hier
  // bleibt nur der ruhige kumulative Stand (Dateien, Checks, Aenderungen, Zeilen)
  // mit hochdrehenden Zahlen, daneben der Aufklapp-Chevron.
  const tallyItems = buildTallyItems(tools)
  const labelClass = `text-[13px] tabular-nums leading-[1.2] ${state === 'error' ? 'text-[#ffb1b1]' : 'work-trace-body'}`

  return (
    <div
      onClick={onToggle}
      className={`flex items-center gap-2 cursor-pointer hover:opacity-90 transition-opacity ${mobile ? 'py-2' : 'py-1.5'}`}
    >
      {tallyItems.length > 0 ? (
        <TallyView
          items={tallyItems}
          className={labelClass}
          style={{ letterSpacing: '0.01em' }}
        />
      ) : (
        <span className={labelClass} style={{ letterSpacing: '0.01em' }}>Arbeitet</span>
      )}
      <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 work-trace-soft transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </div>
  )
}

type ToolMode = 'open' | 'quiet' | 'silent'

function ToolSteps({ tools, mobile, streaming, elapsedMs, mode = 'quiet', anchored = false, elapsedSeconds }: { tools: ToolCall[], mobile?: boolean, streaming?: boolean, elapsedMs?: number | null, mode?: ToolMode, anchored?: boolean, elapsedSeconds?: number }) {
  const allDone = tools.every(t => t.status === 'completed')
  // Sobald nicht mehr gestreamt wird, ist der Lauf vorbei — auch wenn einzelne
  // Tool-Status aus einem unsauber abgeschlossenen Stream noch auf 'active'
  // haengen (passierte bei aus dem Verlauf nachgeladenen Antworten). Sonst bleibt
  // die Gruppe faelschlich voll ausgeklappt statt zu einer Zeile zu kollabieren.
  const done = !streaming && (allDone || tools.length > 0)
  const dimmedActive = !!(streaming && (mode === 'quiet' || mode === 'silent'))
  const [expanded, setExpanded] = useState(!dimmedActive)
  const collapsedOnce = useRef(false)
  const wrapClass = 'mt-4'
  const quietHeaderClass = anchored && dimmedActive
    ? `${mobile ? 'sticky bottom-1 z-10 mt-3' : 'sticky bottom-1 z-10 mt-3'}`
    : ''

  useEffect(() => {
    if (done && !collapsedOnce.current) { setExpanded(false); collapsedOnce.current = true }
    if (streaming) collapsedOnce.current = false
  }, [done, streaming])

  useEffect(() => {
    if (dimmedActive) setExpanded(false)
  }, [dimmedActive])

  // Aus-Modus: komplett unsichtbar, weder live noch finale Summary — Composer-
  // Sekunden + Agent-Text signalisieren bereits genug.
  if (mode === 'silent') return null
  if (dimmedActive) {
    // Desktop führt die Live-Bilanz im festen Footer-Bereich, nicht im Chatfluss —
    // so springt der Verlauf nicht und der Tacho hat immer denselben Platz.
    if (!mobile) return null
    return (
      <div className={wrapClass}>
        <div className={quietHeaderClass}>
          <QuietToolRow tools={tools} mobile={mobile} expanded={expanded} onToggle={() => setExpanded(v => !v)} elapsedSeconds={elapsedSeconds} />
        </div>
        {expanded && (
          <div className="mt-2">
            {tools.map((tool, i) => <ToolStep key={tool.id || i} tool={tool} mobile={mobile} />)}
          </div>
        )}
      </div>
    )
  }

  // Desktop führt die Lauf-Bilanz im festen Footer-Bereich — der Chatfluss bleibt
  // ruhig, kein Abschluss-Tacho pro Antwort. Mobile behält die Summary im Verlauf.
  if (!mobile) return null
  return (
    <div className={wrapClass}>
      {expanded && tools.map((tool, i) => <ToolStep key={tool.id || i} tool={tool} mobile={mobile} />)}
      {done ? (
        <div className="cursor-pointer quiet-presence-fade-in" onClick={() => setExpanded(!expanded)}>
          {mode === 'quiet'
            ? <QuietToolSummary tools={tools} collapsed={!expanded} elapsedMs={elapsedMs} mobile={mobile} />
            : <ToolSummary tools={tools} collapsed={!expanded} elapsedMs={elapsedMs} />}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null

  return (
    <div className="my-1.5">
      <button
        onClick={e => { e.stopPropagation(); setOpen(!open) }}
        className="flex items-center gap-1.5 text-[13px] text-[var(--t3)] hover:text-[var(--t2)] transition-all cursor-pointer"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Thinking
      </button>
      {open && (
        <div className="mt-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3 max-h-[200px] overflow-y-auto text-[14px] font-mono text-[var(--t3)] leading-relaxed whitespace-pre-wrap italic">
          {text}
        </div>
      )}
    </div>
  )
}

function MemoryRefs({ refs, onOpen }: { refs: MemoryRef[]; onOpen?: (path: string) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  if (!refs.length) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {refs.map((ref, i) => (
        <div key={i} className="relative inline-block">
          <button
            onClick={() => onOpen?.(ref.path)}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-mono border transition-all cursor-pointer"
            style={{
              borderColor: `${ref.color}30`,
              color: ref.color,
              background: `${ref.color}08`,
            }}
          >
            <span className="opacity-50">{i + 1}</span>
            <span className="truncate max-w-[120px]">{ref.title}</span>
          </button>
          {hover === i && ref.snippet && (
            <div className="absolute bottom-full mb-1.5 left-0 bg-[var(--bg-2)] border border-[var(--border-f)] rounded-lg px-3 py-2 min-w-[200px] max-w-[280px] z-30 shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
              <div className="text-[13px] font-mono text-[var(--t2)] mb-1">{ref.title}</div>
              <div className="text-[12px] text-[var(--t3)] line-clamp-2 leading-relaxed">{ref.snippet.replace(/<[^>]*>/g, '')}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function ReactionChips({ reactions }: { reactions?: Reaction[] }) {
  if (!reactions || reactions.length === 0) return null
  // Group by emoji
  const grouped: Record<string, string[]> = {}
  for (const r of reactions) {
    if (!grouped[r.emoji]) grouped[r.emoji] = []
    grouped[r.emoji].push(r.agent)
  }
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {Object.entries(grouped).map(([emoji, agents]) => (
        <span
          key={emoji}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--bg-2)] text-[14px] border border-[var(--border)]/30"
          title={agents.join(', ')}
        >
          <span>{emoji}</span>
          {agents.length > 1 && <span className="text-[var(--t3)] text-[12px]">{agents.length}</span>}
        </span>
      ))}
    </div>
  )
}

function EditableMessage({ content, onSave, onCancel }: { content: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(content)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(text.length, text.length)
      ref.current.style.height = 'auto'
      ref.current.style.height = ref.current.scrollHeight + 'px'
    }
  }, [])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim() && text.trim() !== content) onSave(text.trim()); else onCancel() }
  }

  return (
    <div className="w-full">
      <textarea
        ref={ref}
        value={text}
        onChange={e => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px' }}
        onKeyDown={handleKey}
        className="w-full bg-[var(--bg-2)] text-[var(--t1)] text-[16px] leading-[1.43] rounded-xl px-3 py-2 resize-none outline-none border border-[var(--warm)]/30 focus:border-[var(--warm)]/60"
        rows={1}
      />
      <div className="flex gap-2 mt-1 text-[13px] text-[var(--t3)]">
        <span>Enter = Speichern</span>
        <span>Esc = Abbrechen</span>
      </div>
    </div>
  )
}

function UserMessageActions({ content, ts, onResend, mobile, onDelete, showStop, onStop }: { content: string; ts?: number; onResend?: (text: string) => void; onQuote?: () => void; mobile?: boolean; onEdit?: () => void; onDelete?: () => void; showStop?: boolean; onStop?: () => void }) {
  const [copied, setCopied] = useState(false)

  if (mobile) return null

  const timeStr = ts ? formatTimestamp(ts) : ''

  return (
    <div className="flex items-center gap-1.5 mt-1.5 justify-end">
      {timeStr && (
        <span className="text-[14px] text-[var(--t3)]/65">{timeStr}</span>
      )}
      <button
        onClick={() => onResend?.(content)}
        className="p-1.5 rounded-md text-[var(--t3)]/65 hover:text-white transition-colors cursor-pointer"
        title="Wiederholen"
      >
        <RotateCcw className="w-[20px] h-[20px]" />
      </button>
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(content) } catch {
            const ta = document.createElement('textarea'); ta.value = content; ta.style.cssText = 'position:fixed;opacity:0'
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
          }
          setCopied(true); setTimeout(() => setCopied(false), 1500)
        }}
        className={`p-1.5 rounded-md transition-colors cursor-pointer ${copied ? 'text-[var(--green)]' : 'text-[var(--t3)]/65 hover:text-white'}`}
        title="Kopieren"
      >
        {copied ? <Check className="w-[20px] h-[20px]" /> : <Copy className="w-[20px] h-[20px]" />}
      </button>
      {onDelete && (
        <button onClick={onDelete} className="p-1.5 rounded-md text-[var(--t3)]/65 hover:text-white transition-colors cursor-pointer" title="Löschen">
          <Trash2 className="w-[20px] h-[20px]" />
        </button>
      )}
      {/* Stopp ganz rechts, nur während dieser Lauf arbeitet — gleiche Optik wie
          die anderen Aktions-Icons: dezent grau, beim Hover weiss. */}
      {showStop && onStop && (
        <button
          onClick={onStop}
          className="p-1.5 rounded-md text-[var(--t3)]/65 hover:text-white transition-colors cursor-pointer"
          title="Agent stoppen"
          aria-label="Agent stoppen"
        >
          <Square className="w-[20px] h-[20px]" fill="currentColor" strokeWidth={0} />
        </button>
      )}
    </div>
  )
}

export type AgentStatus = 'idle' | 'thinking' | 'writing' | 'tool' | 'error' | 'done'
type ResponseMode = 'live' | 'calm' | 'final'

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: '',
  thinking: 'Denkt nach',
  writing: 'Schreibt',
  tool: 'Arbeitet',
  error: 'Fehler',
  done: '',
}

export function StatusIndicator({ status, elapsed = 0, mobile }: { status: AgentStatus; elapsed?: number; mobile?: boolean }) {
  const [done, setDone] = useState<number | null>(null)
  const sz = mobile ? 'text-[20px]' : 'text-[20px]'
  const szTimer = mobile ? 'text-[18px]' : 'text-[17px]'

  useEffect(() => {
    if (status !== 'idle' && status !== 'done') {
      setDone(null)
    }
  }, [status])

  useEffect(() => {
    if (status === 'done') {
      setDone(elapsed)
      const timer = setTimeout(() => setDone(null), 6000)
      return () => clearTimeout(timer)
    }
  }, [status, elapsed])

  if (status === 'done' && done !== null) {
    return (
      <div className={`${mobile ? 'pb-0.5' : 'pb-1.5'} animate-[fadeIn_0.2s_ease]`}>
        <span className={`${sz} text-[var(--t3)]/40`} style={{ fontFamily: 'var(--font-heading)' }}>
          Fertig
        </span>
        <span className={`${szTimer} font-mono text-[var(--t3)]/30 ml-1.5`}>{done}s</span>
      </div>
    )
  }

  if (status === 'idle' || status === 'done') return null

  return (
    <div className={`${mobile ? 'pb-0.5' : 'pb-1.5'} animate-[fadeIn_0.2s_ease]`}>
      <span
        className={`${sz} status-shimmer`}
        style={{ fontFamily: 'var(--font-heading)' }}
      >
        {STATUS_LABELS[status]}...
      </span>
      <span className={`${szTimer} font-mono text-[var(--t3)]/50 ml-1.5`}>{elapsed}s</span>
    </div>
  )
}

interface ChatProps {
  messages: Message[]
  activeTools?: ToolCall[]
  thinkingText?: string
  onQuote?: (text: string) => void
  onOpenRef?: (path: string) => void
  onSpeak?: (text: string, agent: string, ts?: number) => void
  onResend?: (text: string) => void
  onEditMessage?: (id: number, content: string) => void
  onDeleteMessage?: (id: number) => void
  onStop?: () => void
  playingTs?: number
  scrollTrigger?: number
  layoutTrigger?: number
  mobile?: boolean
  streaming?: boolean
  elapsedSeconds?: number
  visualFinalizeKey?: string | null
  visualFinalizeToken?: number
  onVisualComplete?: (messageKey: string) => void
  onNearBottomChange?: (nearBottom: boolean) => void
}

export function Chat({ messages, onQuote, onOpenRef, onSpeak, onResend, onEditMessage, onDeleteMessage, onStop, playingTs, scrollTrigger, layoutTrigger, mobile, streaming, elapsedSeconds, thinkingText, visualFinalizeKey, visualFinalizeToken, onVisualComplete, onNearBottomChange }: ChatProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [hasNewBelow, setHasNewBelow] = useState(false)
  const [contextMenuIdx, setContextMenuIdx] = useState<number | null>(null)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [, setTick] = useState(0)
  const [responseMode, setResponseMode] = useState<ResponseMode>(() => {
    const raw = localStorage.getItem('control:responseMode')
    return raw === 'live' || raw === 'final' ? raw : 'calm'
  })
  const [typewriter, setTypewriter] = useState<boolean>(() => (localStorage.getItem('control:typewriter') ?? 'false') === 'true')
  const [typewriterSpeed, setTypewriterSpeed] = useState<number>(() => {
    const raw = localStorage.getItem('control:typewriterSpeed')
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) && n >= 4 ? n : 18
  })
  const [toolMode, setToolMode] = useState<'open' | 'quiet' | 'silent'>(() => {
    const raw = localStorage.getItem('control:toolMode')
    if (raw === 'open' || raw === 'silent') return raw
    // Migration von altem control:quietTools
    if (raw === 'quiet') return 'quiet'
    const legacy = localStorage.getItem('control:quietTools')
    if (legacy === 'false') return 'open'
    return 'quiet'
  })
  useEffect(() => {
    const sync = () => {
      const mode = localStorage.getItem('control:responseMode')
      setResponseMode(mode === 'live' || mode === 'final' ? mode : 'calm')
      setTypewriter((localStorage.getItem('control:typewriter') ?? 'false') === 'true')
      const rawSpeed = localStorage.getItem('control:typewriterSpeed')
      const n = rawSpeed ? parseInt(rawSpeed, 10) : NaN
      setTypewriterSpeed(Number.isFinite(n) && n >= 4 ? n : 18)
      const m = localStorage.getItem('control:toolMode')
      setToolMode(m === 'open' || m === 'silent' ? m : 'quiet')
    }
    window.addEventListener('deck:chatStyleChanged', sync)
    window.addEventListener('deck:prefsRemoteUpdate', sync)
    return () => {
      window.removeEventListener('deck:chatStyleChanged', sync)
      window.removeEventListener('deck:prefsRemoteUpdate', sync)
    }
  }, [])
  const userScrolledUp = useRef(false)
  // Harte User-Geste (Touch/Wheel nach oben) gewinnt immer gegen den Auto-Scroll.
  const userTouchingRef = useRef(false)
  const showScrollBtnRef = useRef(false)
  const nearBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const prevMsgCount = useRef(0)
  const prevReplayCountRef = useRef(0)
  const prevReplayKeyRef = useRef('')
  const [typewriterReplayKey, setTypewriterReplayKey] = useState<string | null>(null)
  // Darstellung (Tippen/Sanft) ist orthogonal zum Inhalts-Modus: sie wirkt auf den
  // finalen Antwort-Block in JEDEM responseMode, nicht nur in 'live'. Sonst zeigt
  // 'calm'/'final' den Text sofort komplett ("unendlich schnell").
  const revealEnabled = typewriter
  const scrollBottomNow = useCallback((behavior: ScrollBehavior = 'instant') => {
    const el = containerRef.current
    if (!el) return
    if (behavior === 'smooth') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }, [])

  // Refresh relative timestamps every 30s — skip if user has text selected
  useLayoutEffect(() => {
    const interval = setInterval(() => {
      const sel = window.getSelection()
      if (sel && sel.toString().length > 0) return // don't re-render during selection
      setTick(t => t + 1)
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  // Wrap tables in scrollable container after render
  useLayoutEffect(() => {
    if (!containerRef.current) return
    const tables = containerRef.current.querySelectorAll('table')
    tables.forEach(table => {
      if (table.dataset.wrapped) return
      table.dataset.wrapped = '1'
      const wrapper = document.createElement('div')
      wrapper.style.overflowX = 'auto'
      wrapper.style.maxWidth = '100%'
      table.parentNode?.insertBefore(wrapper, table)
      wrapper.appendChild(table)
    })
  }, [messages])

  // Scroll to bottom when messages load or change. Fresh loads must be corrected
  // before the first visible paint, otherwise mobile shows a top/bottom jump.
  useLayoutEffect(() => {
    if (!messages.length) return
    // Instant scroll on fresh load (message count jumped), smooth on incremental
    const isNewLoad = Math.abs(messages.length - prevMsgCount.current) > 1
    const grew = messages.length > prevMsgCount.current
    prevMsgCount.current = messages.length
    if (!userScrolledUp.current) {
      // Poll-Re-Render ohne neue Nachricht (mergeLiveTools liefert frische
      // Referenz mit gleichem Inhalt): NICHT scrollen, sonst ruckelt der Smooth-
      // Scroll bei jedem Tick. Echtes Wachstum waehrend Streaming deckt die RAF-
      // Schleife ab; hier zaehlt nur eine wirklich neue Bubble.
      if (!grew) return
      if (!isNewLoad) {
        const t = window.setTimeout(() => scrollBottomNow('smooth'), 30)
        return () => window.clearTimeout(t)
      }
      scrollBottomNow('instant')
      let raf1 = 0
      raf1 = requestAnimationFrame(() => {
        scrollBottomNow('instant')
      })
      return () => {
        cancelAnimationFrame(raf1)
      }
    } else if (grew && messages[messages.length - 1]?.bot) {
      // Hochgescrollt und liest etwas Älteres → nicht wegreißen, sondern die
      // Pille einblenden, dass unten eine neue Antwort wartet.
      setHasNewBelow(true)
    }
  }, [messages, scrollBottomNow])

  useEffect(() => {
    const last = messages.length ? messages[messages.length - 1] : null
    const key = last ? String(last.id ?? last.ts ?? messages.length) : ''
    const delta = messages.length - prevReplayCountRef.current
    if (!revealEnabled) {
      setTypewriterReplayKey(null)
    } else if (!streaming && delta === 1 && last?.bot && key && key !== prevReplayKeyRef.current) {
      setTypewriterReplayKey(key)
    }
    prevReplayCountRef.current = messages.length
    prevReplayKeyRef.current = key
  }, [messages, streaming, revealEnabled])

  // Während Streaming kontinuierlich nach unten ziehen, damit große Codex-Blöcke
  // den Scroll-Sensor nicht aus der Spur kicken.
  useEffect(() => {
    if (!streaming) return
    const el = containerRef.current
    if (!el) return
    let raf = 0
    const tick = () => {
      if (!userScrolledUp.current && !userTouchingRef.current) {
        const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        if (distFromBottom > 4) el.scrollTop = el.scrollHeight
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [streaming])

  // Force scroll on trigger (agent switch, conversation load)
  useLayoutEffect(() => {
    if (!scrollTrigger) return
    userScrolledUp.current = false
    setHasNewBelow(false)
    scrollBottomNow('instant')
    let raf = 0
    raf = requestAnimationFrame(() => scrollBottomNow('instant'))
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [scrollTrigger, scrollBottomNow])

  useLayoutEffect(() => {
    if (!layoutTrigger) return
    const el = containerRef.current
    if (!el) return
    let raf1 = 0
    let raf2 = 0
    const correctIfAtBottom = () => {
      void el.getBoundingClientRect()
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      if (!userScrolledUp.current || distFromBottom <= 40) {
        scrollBottomNow('instant')
      }
    }
    correctIfAtBottom()
    raf1 = requestAnimationFrame(() => {
      correctIfAtBottom()
      raf2 = requestAnimationFrame(correctIfAtBottom)
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [layoutTrigger, scrollBottomNow])

  // Composer-Resize kann den Chat-Viewport verändern, ohne dass Nachrichten wechseln.
  // Dann explizit unten halten, sonst kann Chromium eine leere Scrollfläche painten.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (userScrolledUp.current) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // Layout lesen erzwingt einen frischen Reflow vor dem Scroll-Korrigieren.
        void el.getBoundingClientRect()
        scrollBottomNow('instant')
      })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [scrollBottomNow])

  // Track scroll position for scroll-to-bottom button
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const scrolledUpNow = el.scrollTop < lastScrollTopRef.current - 2
    if (scrolledUpNow && distFromBottom > 2) {
      userScrolledUp.current = true
    } else if (distFromBottom <= 8) {
      userScrolledUp.current = false
      setHasNewBelow(false)
    } else if (distFromBottom > 120) {
      userScrolledUp.current = true
    }
    lastScrollTopRef.current = el.scrollTop
    const shouldShow = distFromBottom > 120
    if (shouldShow !== showScrollBtnRef.current) {
      showScrollBtnRef.current = shouldShow
      setShowScrollBtn(shouldShow)
    }
    const isNear = distFromBottom <= 40
    if (isNear !== nearBottomRef.current) {
      nearBottomRef.current = isNear
      onNearBottomChange?.(isNear)
    }
  }, [onNearBottomChange])

  // Harte User-Geste: Finger/Wheel nach oben pausiert den Auto-Scroll sofort,
  // unabhaengig von Pixel-Schwellen. So reisst es der Nutzer beim Lesen nie runter.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let touchStartY = 0
    const onTouchStart = (e: TouchEvent) => {
      userTouchingRef.current = true
      touchStartY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0
      if (y - touchStartY > 6) { // Finger zieht nach unten = Inhalt nach oben = hochlesen
        userScrolledUp.current = true
        setHasNewBelow(true)
      }
    }
    const onTouchEnd = () => {
      userTouchingRef.current = false
    }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < -1) {
        userScrolledUp.current = true
        setHasNewBelow(true)
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    userScrolledUp.current = false
    setHasNewBelow(false)
    scrollBottomNow('smooth')
  }, [scrollBottomNow])

  // Inject copy buttons into code blocks after render
  useEffect(() => {
    if (!containerRef.current) return
    const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`
    const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
    const attachCopy = (host: HTMLElement, getText: () => string) => {
      if (host.querySelector(':scope > .copy-btn')) return
      host.style.position = 'relative'
      const btn = document.createElement('button')
      btn.className = 'copy-btn'
      btn.title = 'Kopieren'
      btn.innerHTML = copyIcon
      btn.onclick = async () => {
        const text = getText()
        try { await navigator.clipboard.writeText(text) }
        catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta) }
        btn.innerHTML = checkIcon
        setTimeout(() => { btn.innerHTML = copyIcon }, 2000)
      }
      host.appendChild(btn)
    }
    containerRef.current.querySelectorAll('pre.hljs-block').forEach(pre => {
      attachCopy(pre as HTMLElement, () => pre.querySelector('code')?.textContent || '')
    })
    containerRef.current.querySelectorAll('.draft-block').forEach(block => {
      attachCopy(block as HTMLElement, () => decodeURIComponent(block.getAttribute('data-draft-text') || ''))
    })
  }, [messages])

  // Render mermaid diagrams in code blocks
  useEffect(() => {
    if (!containerRef.current) return
    const blocks = containerRef.current.querySelectorAll('.mermaid-block[data-mermaid]:not(.mermaid-rendered)')
    if (blocks.length === 0) return
    blocks.forEach(el => el.classList.add('mermaid-rendered'))
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: { background: '#1F1F1E', primaryColor: '#2C2C2B', primaryTextColor: '#E6E6E3', primaryBorderColor: '#D97757', secondaryColor: '#353533', secondaryTextColor: '#E6E6E3', secondaryBorderColor: '#3A3A38', tertiaryColor: '#353533', tertiaryTextColor: '#A1A1A0', tertiaryBorderColor: '#3A3A38', lineColor: '#D97757', textColor: '#E6E6E3', mainBkg: '#2C2C2B', nodeBorder: '#D97757', clusterBkg: '#252524', clusterBorder: '#3A3A38', titleColor: '#E6E6E3', edgeLabelBackground: '#1F1F1E', pie1: '#D97757', pie2: '#D6C9A8', pie3: '#A1A1A0', pie4: '#3A3A38', pieStrokeColor: '#1F1F1E', pieOuterStrokeColor: '#3A3A38', pieTitleTextSize: '18px', pieSectionTextColor: '#1F1F1E', fontFamily: 'Inter, system-ui, sans-serif' } })
      blocks.forEach(async (el) => {
        const source = decodeURIComponent(el.getAttribute('data-mermaid') || '')
        if (!source) return
        try {
          const { svg } = await mermaid.render(el.id + '-svg', source)
          el.innerHTML = svg
        } catch { /* fallback: raw code stays visible */ }
      })
    }).catch(() => { /* mermaid failed to load */ })
  }, [messages])

  const visibleMessages = messages.filter(hasVisibleMessageBody)
  // Letzte User-Bubble: nur dort erscheint während eines Laufs der Stopp-Knopf.
  let lastUserIdx = -1
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    if (!visibleMessages[i].bot && visibleMessages[i].author !== 'System') { lastUserIdx = i; break }
  }

  // Check if message should show header (grouping: same author within 2 min = no header)
  const shouldShowHeader = (m: Message, i: number) => {
    if (i === 0) return true
    const prev = visibleMessages[i - 1]
    if (prev.author !== m.author) return true
    if (!m.ts || !prev.ts) return true
    return m.ts - prev.ts > 120
  }

  // Date separator logic
  const dateSeparator = (m: Message, i: number) => {
    if (!m.ts) return null
    if (i === 0) return formatDate(m.ts)
    const prev = visibleMessages[i - 1]
    if (!prev.ts) return null
    const d1 = new Date(prev.ts * 1000).toDateString()
    const d2 = new Date(m.ts * 1000).toDateString()
    return d1 !== d2 ? formatDate(m.ts) : null
  }

  const messageKey = (m: Message, i: number) => {
    if (m.id !== undefined && m.id !== null) return `id:${m.id}`
    if (m.ts) return `${m.author}:${m.ts}:${i}`
    return `${m.author}:local:${i}`
  }

  return (
    <div className="h-full min-h-0 relative">
    <div
      className="h-full min-h-0 overflow-y-auto overflow-x-hidden"
      ref={containerRef}
      onScroll={handleScroll}
      style={{ overflowAnchor: 'none' }}
    >
      <div
        className={mobile
          ? `px-5 flex flex-col min-h-full justify-end ${streaming ? 'pb-3' : 'pb-3'}`
          : `pt-14 flex flex-col min-h-full justify-end ${streaming ? 'pb-[2.25rem]' : 'pb-4'}`}
        style={mobile ? { paddingTop: 12, overflowAnchor: 'none' } : { overflowAnchor: 'none' }}
      >
        {visibleMessages.map((m, i) => {
          const sep = dateSeparator(m, i)
          const showHeader = shouldShowHeader(m, i)
          const isSystem = m.author === 'System'

          return (
            <div key={messageKey(m, i)} data-ts={m.ts}>
              {/* Date separator */}
              {sep && (
                <div className="flex items-center gap-4 my-6">
                  <div className="flex-1 h-px bg-[var(--border)]" />
                  <span className="text-[14px] text-[var(--t3)]">{sep}</span>
                  <div className="flex-1 h-px bg-[var(--border)]" />
                </div>
              )}

              {/* System message */}
              {isSystem ? (
                <div className="text-center py-2">
                  <span className="text-[14px] text-[var(--t3)]/50" style={{ fontFamily: 'var(--font-body)' }}>{m.content}</span>
                </div>
              ) : m.tool ? (
                <div className="px-1 py-2 my-1">
                  <div className="flex items-center gap-2 text-[14px] font-mono text-[var(--t3)]">
                    <Wrench className="w-3 h-3 text-[var(--warm)]" />
                    <span>{m.tool.name}</span>
                    {m.tool.info && <span className="text-[var(--t3)]/60 truncate">{m.tool.info}</span>}
                  </div>
                  {m.tool.output && (
                    <div className="mt-2 ml-5 text-[var(--t3)]/60 max-h-[140px] overflow-y-auto whitespace-pre-wrap font-mono text-[13px] leading-relaxed">
                      {m.tool.output}
                    </div>
                  )}
                </div>
              ) : (() => {
                const { context, message } = parseContent(m.content)
                const isUser = m.author === 'Du'
                const klausPing = isUser ? null : parseKlausPingMeta(m.content)
                const hasContextMenu = mobile && contextMenuIdx === i
                const speechText = isUser ? m.content : getAgentSpeechText(m, message)
                return (
                  <div
                    className={`relative group ${klausPing ? 'klaus-proactive-wrap' : ''} ${showHeader ? 'pt-6' : 'pt-0.5'} ${showHeader ? 'pb-2' : 'pb-0.5'} ${
                      isUser ? 'flex justify-end' : ''
                    }`}
                    onClick={mobile ? () => setContextMenuIdx(prev => prev === i ? null : i) : undefined}
                  >
                   {isUser ? (() => {
                    const extras = (
                      <>
                        {m.edited_at && (
                          <span className="text-[12px] text-[var(--t3)]/40 mt-0.5 block text-right">bearbeitet</span>
                        )}
                        {m.attachments && m.attachments.length > 0 && (
                          <div className="flex flex-wrap justify-end gap-2 mt-2 max-w-full min-w-0">
                            {m.attachments.map((att, ai) => (
                              att.type.startsWith('image/') ? (
                                <a key={ai} href={att.url} target="_blank" rel="noopener noreferrer" className="block">
                                  <img
                                    src={att.url}
                                    alt={att.name}
                                    className={`rounded-xl object-cover max-w-full ${mobile ? 'max-w-[min(80vw,480px)] max-h-[60vh]' : 'max-w-[320px] max-h-[240px]'}`}
                                  />
                                </a>
                              ) : att.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|3gp)$/i.test(att.name) ? (
                                <video
                                  key={ai}
                                  src={att.url}
                                  controls
                                  preload="metadata"
                                  className={`rounded-xl bg-black max-w-full ${mobile ? 'max-w-[min(80vw,480px)] max-h-[60vh]' : 'max-w-[320px] max-h-[320px]'}`}
                                />
                              ) : att.type.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|webm)$/i.test(att.name) ? (
                                <AudioPlayer key={ai} src={att.url} name={att.name} />
                              ) : (
                                <a
                                  key={ai}
                                  href={att.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`flex items-center gap-2 bg-[var(--bg-2)] rounded-xl px-3 py-2 max-w-full min-w-0 text-[var(--t2)] hover:text-[var(--t1)] transition-all ${mobile ? 'text-[17px]' : 'text-[14px]'}`}
                                >
                                  <span className={`truncate ${mobile ? 'max-w-[80vw]' : 'max-w-[160px]'}`}>{att.name}</span>
                                </a>
                              )
                            ))}
                          </div>
                        )}
                      </>
                    )
                    return (
                    <div className="user-msg-enter" style={{ maxWidth: '85%', minWidth: 0, marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      {editingIdx === i ? (
                        <div className="bg-[var(--hover)] rounded-2xl px-3.5 py-2" style={{ width: 'fit-content', maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                          <EditableMessage
                            content={m.content}
                            onSave={(text) => { if (m.id) onEditMessage?.(m.id, text); setEditingIdx(null) }}
                            onCancel={() => setEditingIdx(null)}
                          />
                          {extras}
                        </div>
                      ) : message ? (
                        <CollapsibleUserMsg html={injectColorSwatches(renderMarkdownHtml(message))} mobile={mobile}>
                          {extras}
                        </CollapsibleUserMsg>
                      ) : (
                        <div className="bg-[var(--hover)] rounded-2xl px-3.5 py-2" style={{ width: 'fit-content', maxWidth: '100%', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                          {extras}
                        </div>
                      )}
                    <ReactionChips reactions={m.reactions} />
                    {hasContextMenu ? (
                      <MobileInlineActions content={m.content} ts={m.ts} isAgent={false} isUser onQuote={() => onQuote?.(m.content)} onResend={onResend} onClose={() => setContextMenuIdx(null)} />
                    ) : (
                      <UserMessageActions
                        content={m.content} ts={m.ts} onResend={onResend} onQuote={() => onQuote?.(m.content)} mobile={mobile}
                        onEdit={m.id ? () => setEditingIdx(i) : undefined}
                        onDelete={m.id ? () => { if (confirm('Nachricht löschen?')) onDeleteMessage?.(m.id!) } : undefined}
                        showStop={!!streaming && i === lastUserIdx} onStop={onStop}
                      />
                    )}
                    </div>
                    )
                   })() : (
                    <>
                    {klausPing ? (
                      <div className={`klaus-proactive-card klaus-proactive-${klausPing.tone}`}>
                        <div className="klaus-proactive-kicker">
                          <span className="klaus-proactive-label">{klausPing.label}</span>
                        </div>
                        {context && <ContextBlock context={context} />}
                        {m.thinking && <ThinkingBlock text={m.thinking} />}
                        {(() => {
                      // EIN Renderpfad für Agent-Antworten: aus m.steps (oder Fallback
                      // aus message + m.tools) bauen wir ein einheitliches groups-Array.
                      // So bleibt der React-Tree stabil — kein Re-Mount des Typewriters,
                      // wenn mid-stream ein Tool-Call dazukommt und der Stream danach endet.
                      type Group = { kind: 'text'; text: string } | { kind: 'tools'; tools: ToolCall[] }
                      const groups: Group[] = []
                      if (m.steps && m.steps.length) {
                        for (const s of m.steps) {
                          const last = groups[groups.length - 1]
                          if (s.kind === 'text') {
                            if (last && last.kind === 'text') last.text += s.text
                            else groups.push({ kind: 'text', text: s.text })
                          } else {
                            if (last && last.kind === 'tools') last.tools.push(s.tool)
                            else groups.push({ kind: 'tools', tools: [s.tool] })
                          }
                        }
                      } else if (m.segments && m.segments.length) {
                        for (const seg of m.segments) {
                          if (seg) groups.push({ kind: 'text', text: seg })
                        }
                        if (m.tools && m.tools.length) groups.push({ kind: 'tools', tools: m.tools })
                      } else {
                        if (message) groups.push({ kind: 'text', text: message })
                        if (m.tools && m.tools.length) groups.push({ kind: 'tools', tools: m.tools })
                      }
                      if (groups.length === 0) return null
                      const isLastMsg = i === messages.length - 1
                      const msgKey = String(m.id ?? m.ts ?? i)
                      const replayAnimate = revealEnabled && !streaming && isLastMsg && typewriterReplayKey === msgKey
                      const visualFinalizing = revealEnabled && isLastMsg && visualFinalizeKey === msgKey && typeof visualFinalizeToken === 'number'
                      const rawTextGroups = groups.filter((g): g is { kind: 'text'; text: string } => g.kind === 'text' && !!g.text)
                      const toolGroups = groups.filter((g): g is { kind: 'tools'; tools: ToolCall[] } => g.kind === 'tools' && g.tools.length > 0)
                      const calmTextGroups = normalizeCalmTextGroups(rawTextGroups, toolGroups.length > 0)
                      const computedTextGroups = responseMode === 'final' && rawTextGroups.length > 0
                        ? [rawTextGroups[rawTextGroups.length - 1]]
                        : responseMode === 'calm'
                          ? calmTextGroups
                          : rawTextGroups
                      // Mobile: keine Fake-Tool-Call-Narration. Nur die echten Tool-Calls
                      // plus die finale Antwort, der Zwischen-Arbeitstext fliegt raus.
                      const textGroups = mobile && computedTextGroups.length > 1
                        ? [computedTextGroups[computedTextGroups.length - 1]]
                        : computedTextGroups
                      const mergedTools = toolGroups.flatMap(g => g.tools)
                      const lastTextIdx = textGroups.length - 1
                      const mergedText = responseMode === 'final'
                        ? (textGroups[0]?.text || '')
                        : textGroups.map(g => g.text).join('')
                      const holdTextUntilDone = responseMode === 'final' && !!streaming && isLastMsg
                      const useMergedTextBlock = responseMode === 'final'

                      return (
                        <>
                          {!holdTextUntilDone && (useMergedTextBlock ? (
                            mergedText ? (
                              <div className={mergedTools.length > 0 ? 'answer-focus' : ''}>
                                <AgentTextBlock
                                  key="text-merged"
                                  persistKey={`m${m.ts || m.id || i}-text-merged`}
                                  text={mergedText}
                                  animate={revealEnabled && isLastMsg && (replayAnimate || visualFinalizing)}
                                  fromStart={replayAnimate}
                                  restartToken={visualFinalizing ? visualFinalizeToken : null}
                                  onRevealComplete={visualFinalizing ? () => onVisualComplete?.(msgKey) : undefined}
                                  speed={typewriterSpeed}
                                  mobile={mobile}
                                  tone={mergedTools.length > 0 ? 'answer' : 'default'}
                                  onClick={(e) => {
                                    const tgt = e.target as HTMLElement
                                    const btn = tgt.closest('[data-section-heading]') as HTMLElement | null
                                    if (!btn) return
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
                                    const section = extractSection(mergedText, heading)
                                    if (section) onSpeak?.(section, m.author)
                                  }}
                                />
                              </div>
                            ) : null
                          ) : responseMode === 'calm' ? (() => {
                            // Nur zurueckhalten, wenn der Reveal den Text am Ende selbst aufdeckt.
                            // Ohne Schreibmaschine (revealEnabled=false) MUSS der Text live mitlaufen,
                            // sonst bleibt er auf Mobile bei verschlucktem Schluss-Event unsichtbar bis Reload.
                            const holdSingleLiveGroup = revealEnabled && isLastMsg && !!streaming && rawTextGroups.length <= 1 && textGroups.length <= 1
                            if (holdSingleLiveGroup) return null
                            return textGroups.map((g, gi) => {
                              const isLastText = gi === lastTextIdx
                              const shouldElevateAnswer = isLastText && (textGroups.length > 1 || mergedTools.length > 0)
                              if (!isLastText) {
                                return <CalmWorkLine key={`calm-work-${gi}`} text={g.text} mobile={mobile} separated={gi > 0} />
                              }
                              return (
                                <div key={`calm-text-${gi}`} className={shouldElevateAnswer ? 'answer-focus' : ''}>
                                  {textGroups.length > 1 ? <AnswerSeparator label="Ergebnis" /> : null}
                                  <AgentTextBlock
                                    persistKey={`m${m.ts || m.id || i}-text-${gi}`}
                                    text={g.text}
                                    animate={revealEnabled && isLastMsg && (!!streaming || replayAnimate || visualFinalizing)}
                                    fromStart={replayAnimate}
                                    restartToken={visualFinalizing ? visualFinalizeToken : null}
                                    onRevealComplete={visualFinalizing ? () => onVisualComplete?.(msgKey) : undefined}
                                    speed={typewriterSpeed}
                                    mobile={mobile}
                                    tone={shouldElevateAnswer ? 'answer' : 'default'}
                                    onClick={(e) => {
                                      const tgt = e.target as HTMLElement
                                      const btn = tgt.closest('[data-section-heading]') as HTMLElement | null
                                      if (!btn) return
                                      e.preventDefault()
                                      e.stopPropagation()
                                      const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
                                      const section = extractSection(g.text, heading)
                                      if (section) onSpeak?.(section, m.author)
                                    }}
                                  />
                                </div>
                              )
                            })
                          })() : textGroups.map((g, gi) => {
                            const animate = revealEnabled && isLastMsg && gi === lastTextIdx && (!!streaming || replayAnimate || visualFinalizing)
                            const persistKey = `m${m.ts || m.id || i}-text-${gi}`
                            return (
                              <AgentTextBlock
                                key={`text-${gi}`}
                                persistKey={persistKey}
                                text={g.text}
                                animate={animate}
                                fromStart={replayAnimate}
                                restartToken={visualFinalizing ? visualFinalizeToken : null}
                                onRevealComplete={visualFinalizing ? () => onVisualComplete?.(msgKey) : undefined}
                                speed={typewriterSpeed}
                                mobile={mobile}
                                onClick={(e) => {
                                  const tgt = e.target as HTMLElement
                                  const btn = tgt.closest('[data-section-heading]') as HTMLElement | null
                                  if (!btn) return
                                  e.preventDefault()
                                  e.stopPropagation()
                                  const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
                                  const section = extractSection(g.text, heading)
                                  if (section) onSpeak?.(section, m.author)
                                }}
                              />
                            )
                          }))}
                          {mergedTools.length > 0 && (
                            <ToolSteps
                              key="tools-merged"
                              tools={mergedTools}
                              mobile={mobile}
                              streaming={!!streaming && isLastMsg}
                              elapsedMs={m.elapsedMs}
                              elapsedSeconds={elapsedSeconds}
                              mode={toolMode}
                              anchored={!!streaming && isLastMsg && toolMode === 'quiet'}
                            />
                          )}
                        </>
                      )
                        })()}
                      </div>
                    ) : (
                      <>
                      {context && <ContextBlock context={context} />}
                      {m.thinking && <ThinkingBlock text={m.thinking} />}
                      {(() => {
                      // EIN Renderpfad für Agent-Antworten: aus m.steps (oder Fallback
                      // aus message + m.tools) bauen wir ein einheitliches groups-Array.
                      // So bleibt der React-Tree stabil — kein Re-Mount des Typewriters,
                      // wenn mid-stream ein Tool-Call dazukommt und der Stream danach endet.
                      type Group = { kind: 'text'; text: string } | { kind: 'tools'; tools: ToolCall[] }
                      const groups: Group[] = []
                      if (m.steps && m.steps.length) {
                        for (const s of m.steps) {
                          const last = groups[groups.length - 1]
                          if (s.kind === 'text') {
                            if (last && last.kind === 'text') last.text += s.text
                            else groups.push({ kind: 'text', text: s.text })
                          } else {
                            if (last && last.kind === 'tools') last.tools.push(s.tool)
                            else groups.push({ kind: 'tools', tools: [s.tool] })
                          }
                        }
                      } else if (m.segments && m.segments.length) {
                        for (const seg of m.segments) {
                          if (seg) groups.push({ kind: 'text', text: seg })
                        }
                        if (m.tools && m.tools.length) groups.push({ kind: 'tools', tools: m.tools })
                      } else {
                        if (message) groups.push({ kind: 'text', text: message })
                        if (m.tools && m.tools.length) groups.push({ kind: 'tools', tools: m.tools })
                      }
                      if (groups.length === 0) return null
                      const isLastMsg = i === messages.length - 1
                      const msgKey = String(m.id ?? m.ts ?? i)
                      const replayAnimate = revealEnabled && !streaming && isLastMsg && typewriterReplayKey === msgKey
                      const visualFinalizing = revealEnabled && isLastMsg && visualFinalizeKey === msgKey && typeof visualFinalizeToken === 'number'
                      const rawTextGroups = groups.filter((g): g is { kind: 'text'; text: string } => g.kind === 'text' && !!g.text)
                      const toolGroups = groups.filter((g): g is { kind: 'tools'; tools: ToolCall[] } => g.kind === 'tools' && g.tools.length > 0)
                      const calmTextGroups = normalizeCalmTextGroups(rawTextGroups, toolGroups.length > 0)
                      const computedTextGroups = responseMode === 'final' && rawTextGroups.length > 0
                        ? [rawTextGroups[rawTextGroups.length - 1]]
                        : responseMode === 'calm'
                          ? calmTextGroups
                          : rawTextGroups
                      // Mobile: keine Fake-Tool-Call-Narration. Nur die echten Tool-Calls
                      // plus die finale Antwort, der Zwischen-Arbeitstext fliegt raus.
                      const textGroups = mobile && computedTextGroups.length > 1
                        ? [computedTextGroups[computedTextGroups.length - 1]]
                        : computedTextGroups
                      const mergedTools = toolGroups.flatMap(g => g.tools)
                      const lastTextIdx = textGroups.length - 1
                      const mergedText = responseMode === 'final'
                        ? (textGroups[0]?.text || '')
                        : textGroups.map(g => g.text).join('')
                      const holdTextUntilDone = responseMode === 'final' && !!streaming && isLastMsg
                      const useMergedTextBlock = responseMode === 'final'

                      return (
                        <>
                          {!holdTextUntilDone && (useMergedTextBlock ? (
                            mergedText ? (
                              <div className={mergedTools.length > 0 ? 'answer-focus' : ''}>
                                <AgentTextBlock
                                  key="text-merged"
                                  persistKey={`m${m.ts || m.id || i}-text-merged`}
                                  text={mergedText}
                                  animate={revealEnabled && isLastMsg && (replayAnimate || visualFinalizing)}
                                  fromStart={replayAnimate}
                                  restartToken={visualFinalizing ? visualFinalizeToken : null}
                                  onRevealComplete={visualFinalizing ? () => onVisualComplete?.(msgKey) : undefined}
                                  speed={typewriterSpeed}
                                  mobile={mobile}
                                  tone={mergedTools.length > 0 ? 'answer' : 'default'}
                                  onClick={(e) => {
                                    const tgt = e.target as HTMLElement
                                    const btn = tgt.closest('[data-section-heading]') as HTMLElement | null
                                    if (!btn) return
                                    e.preventDefault()
                                    e.stopPropagation()
                                    const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
                                    const section = extractSection(mergedText, heading)
                                    if (section) onSpeak?.(section, m.author)
                                  }}
                                />
                              </div>
                            ) : null
                          ) : responseMode === 'calm' ? (() => {
                            // Nur zurueckhalten, wenn der Reveal den Text am Ende selbst aufdeckt.
                            // Ohne Schreibmaschine (revealEnabled=false) MUSS der Text live mitlaufen,
                            // sonst bleibt er auf Mobile bei verschlucktem Schluss-Event unsichtbar bis Reload.
                            const holdSingleLiveGroup = revealEnabled && isLastMsg && !!streaming && rawTextGroups.length <= 1 && textGroups.length <= 1
                            if (holdSingleLiveGroup) return null
                            return textGroups.map((g, gi) => {
                              const isLastText = gi === lastTextIdx
                              const shouldElevateAnswer = isLastText && (textGroups.length > 1 || mergedTools.length > 0)
                              if (!isLastText) {
                                return <CalmWorkLine key={`calm-work-${gi}`} text={g.text} mobile={mobile} separated={gi > 0} />
                              }
                              return (
                                <div key={`calm-text-${gi}`} className={shouldElevateAnswer ? 'answer-focus' : ''}>
                                  {textGroups.length > 1 ? <AnswerSeparator label="Ergebnis" /> : null}
                                  <AgentTextBlock
                                    persistKey={`m${m.ts || m.id || i}-text-${gi}`}
                                    text={g.text}
                                    animate={revealEnabled && isLastMsg && (!!streaming || replayAnimate || visualFinalizing)}
                                    fromStart={replayAnimate}
                                    restartToken={visualFinalizing ? visualFinalizeToken : null}
                                    onRevealComplete={visualFinalizing ? () => onVisualComplete?.(msgKey) : undefined}
                                    speed={typewriterSpeed}
                                    mobile={mobile}
                                    tone={shouldElevateAnswer ? 'answer' : 'default'}
                                    onClick={(e) => {
                                      const tgt = e.target as HTMLElement
                                      const btn = tgt.closest('[data-section-heading]') as HTMLElement | null
                                      if (!btn) return
                                      e.preventDefault()
                                      e.stopPropagation()
                                      const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
                                      const section = extractSection(g.text, heading)
                                      if (section) onSpeak?.(section, m.author)
                                    }}
                                  />
                                </div>
                              )
                            })
                          })() : textGroups.map((g, gi) => {
                            const animate = revealEnabled && isLastMsg && gi === lastTextIdx && (!!streaming || replayAnimate || visualFinalizing)
                            const persistKey = `m${m.ts || m.id || i}-text-${gi}`
                            return (
                              <AgentTextBlock
                                key={`text-${gi}`}
                                persistKey={persistKey}
                                text={g.text}
                                animate={animate}
                                fromStart={replayAnimate}
                                restartToken={visualFinalizing ? visualFinalizeToken : null}
                                onRevealComplete={visualFinalizing ? () => onVisualComplete?.(msgKey) : undefined}
                                speed={typewriterSpeed}
                                mobile={mobile}
                                onClick={(e) => {
                                  const tgt = e.target as HTMLElement
                                  const btn = tgt.closest('[data-section-heading]') as HTMLElement | null
                                  if (!btn) return
                                  e.preventDefault()
                                  e.stopPropagation()
                                  const heading = decodeURIComponent(btn.getAttribute('data-section-heading') || '')
                                  const section = extractSection(g.text, heading)
                                  if (section) onSpeak?.(section, m.author)
                                }}
                              />
                            )
                          }))}
                          {mergedTools.length > 0 && (
                            <ToolSteps
                              key="tools-merged"
                              tools={mergedTools}
                              mobile={mobile}
                              streaming={!!streaming && isLastMsg}
                              elapsedMs={m.elapsedMs}
                              elapsedSeconds={elapsedSeconds}
                              mode={toolMode}
                              anchored={!!streaming && isLastMsg && toolMode === 'quiet'}
                            />
                          )}
                        </>
                      )
                    })()}
                    </>
                    )}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-3 max-w-full min-w-0">
                        {m.attachments.map((att, ai) => (
                          att.type.startsWith('image/') ? (
                            <a key={ai} href={att.url} target="_blank" rel="noopener noreferrer" className="block">
                              <img
                                src={att.url}
                                alt={att.name}
                                className={`rounded-xl object-cover max-w-full ${mobile ? 'max-w-[min(80vw,480px)] max-h-[60vh]' : 'max-w-[320px] max-h-[240px]'}`}
                              />
                            </a>
                          ) : att.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|3gp)$/i.test(att.name) ? (
                            <video
                              key={ai}
                              src={att.url}
                              controls
                              preload="metadata"
                              className={`rounded-xl bg-black max-w-full ${mobile ? 'max-w-[min(80vw,480px)] max-h-[60vh]' : 'max-w-[320px] max-h-[320px]'}`}
                            />
                          ) : att.type.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|webm)$/i.test(att.name) ? (
                            <AudioPlayer key={ai} src={att.url} name={att.name} />
                          ) : (
                            <a
                              key={ai}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`flex items-center gap-2 bg-[var(--bg-2)] rounded-xl px-3 py-2 max-w-full min-w-0 text-[var(--t2)] hover:text-[var(--t1)] transition-all ${mobile ? 'text-[17px]' : 'text-[14px]'}`}
                            >
                              <span className={`truncate ${mobile ? 'max-w-[80vw]' : 'max-w-[160px]'}`}>{att.name}</span>
                            </a>
                          )
                        ))}
                      </div>
                    )}
                    {m.refs && m.refs.length > 0 && <MemoryRefs refs={m.refs} onOpen={onOpenRef} />}
                    {m.errorRetry && (
                      <button
                        onClick={() => onResend?.(m.errorRetry!)}
                        className="mt-2 px-3 py-1.5 rounded-lg bg-[var(--warm)]/10 text-[var(--warm)] text-[15px] hover:bg-[var(--warm)]/20 transition-colors cursor-pointer"
                      >
                        Erneut versuchen
                      </button>
                    )}
                    <ReactionChips reactions={m.reactions} />
                    <AgentMessageActions
                      content={m.content}
                      ts={m.ts}
                      onSpeak={() => onSpeak?.(speechText || m.content, m.author, m.ts)}
                      isPlaying={!!playingTs && playingTs === m.ts}
                      mobile={mobile}
                      hidden={!!streaming && i === messages.length - 1}
                    />
                    </>
                   )}
                  </div>
                )
              })()}
            </div>
          )
        })}

        {/* Denkphase: vom Absenden an läuft die Zeit, auch solange erst die eigene
            Nachricht steht und Agent noch denkt — sonst wirkt es, als käme der Timer
            zu spät. Sobald die Antwort Text oder Tools zeigt, übernimmt der Tacho. */}
        {(() => {
          // Desktop zeigt die Denkphase im festen Footer-Bereich, nicht im Chatfluss.
          if (!streaming || !mobile) return null
          const last = messages[messages.length - 1]
          if (last && last.bot) {
            const hasText = !!(last.content && last.content.trim())
            const hasTools = !!(last.tools && last.tools.length)
            const hasSteps = !!(last.steps && last.steps.some(s => s.kind === 'tool' || (s.kind === 'text' && !!s.text && !!s.text.trim())))
            if (hasText || hasTools || hasSteps) return null
          }
          return <ThinkingElapsedRow elapsedSeconds={elapsedSeconds} mobile={mobile} label={thinkingText} />
        })()}

        <div ref={endRef} />
      </div>
    </div>

      {(hasNewBelow || showScrollBtn) && (
        <button
          onClick={scrollToBottom}
          className={`absolute left-1/2 -translate-x-1/2 flex items-center justify-center rounded-full bg-[var(--bg-2)]/55 backdrop-blur-xl text-[var(--t3)] hover:text-[var(--t1)] transition-colors cursor-pointer animate-[fadeIn_0.15s_ease] z-20 ${
            mobile ? 'bottom-3 w-10 h-10' : 'bottom-4 w-8 h-8'
          }`}
          title="Nach unten"
        >
          <ChevronDown className={mobile ? "w-5 h-5" : "w-4 h-4"} />
        </button>
      )}
    </div>
  )
}
