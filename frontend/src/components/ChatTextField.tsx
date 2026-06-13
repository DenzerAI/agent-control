// Isoliertes Chat-Eingabefeld: hält text + Mention/Slash-Detection + Auto-Height
// intern, damit der grosse Composer-Tree NICHT bei jedem Tastendruck re-rendert.
// Mention/Slash-Menüs rendert der Parent (wegen Layout); Sub meldet Status via
// onMentionChange / onSlashChange und exposed insert-Operationen via Handle.

import { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { getAgents, type Engine, type AgentConfig as Agent } from '../agents'
import { SLASH_COMMANDS, matchEngine, type SlashCommand } from '../slashCommands'

const AGENTS = getAgents()

export type MentionState = { query: string; index: number }
export type SlashState = { query: string; index: number }

export interface ChatTextFieldHandle {
  getText(): string
  getTrimmed(): string
  setText(v: string): void
  clear(): void
  focus(): void
  blur(): void
  prepend(v: string): void
  appendText(v: string): void
  resetHeight(): void
  selectMentionAt(index: number): void
  selectSlashAt(index: number): void
}

interface Props {
  paneIndex: number
  draftStorageKey: string | null
  engine: Engine
  disabled?: boolean
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  rows?: number
  autoFocus?: boolean
  autoCorrect?: string
  autoComplete?: string
  maxHeight: number
  onSubmit: () => void
  onCommandSubmit?: (cmd: string, args: string) => void
  onHasContentChange?: (has: boolean) => void
  onAgentChange?: (id: string) => void
  onCommand?: (cmd: string, args: string) => void
  onPaste?: (e: React.ClipboardEvent) => void
  onFocusChange?: (focused: boolean) => void
  onMentionChange?: (state: MentionState | null, agents: Agent[]) => void
  onSlashChange?: (state: SlashState | null, commands: SlashCommand[]) => void
}

export const ChatTextField = forwardRef<ChatTextFieldHandle, Props>(function ChatTextField(props, handleRef) {
  const {
    paneIndex, draftStorageKey, engine, disabled, placeholder, className, style,
    rows, autoFocus, autoCorrect, autoComplete, maxHeight,
    onSubmit, onCommandSubmit, onHasContentChange, onAgentChange, onCommand, onPaste, onFocusChange,
    onMentionChange, onSlashChange,
  } = props
  const isCodex = engine === 'codex'

  const [text, setText] = useState<string>(() => {
    if (!draftStorageKey) return ''
    try { return localStorage.getItem(draftStorageKey) || '' } catch { return '' }
  })
  const [mention, setMention] = useState<MentionState | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Draft-Wechsel: Text aus neuem Slot ziehen.
  const lastKey = useRef(draftStorageKey)
  useEffect(() => {
    if (lastKey.current === draftStorageKey) return
    lastKey.current = draftStorageKey
    if (!draftStorageKey) { setText(''); return }
    try { setText(localStorage.getItem(draftStorageKey) || '') } catch { setText('') }
  }, [draftStorageKey])

  // Debounced Draft-Save: schont Mobile beim Tippen.
  useEffect(() => {
    if (!draftStorageKey) return
    const t = setTimeout(() => {
      try {
        if (text) localStorage.setItem(draftStorageKey, text)
        else localStorage.removeItem(draftStorageKey)
      } catch {}
    }, 300)
    return () => clearTimeout(t)
  }, [text, draftStorageKey])

  // hasContent nur bei Wechsel melden — Parent rendert dann genau einmal.
  const lastHas = useRef(text.length > 0)
  useEffect(() => {
    const has = text.length > 0
    if (has !== lastHas.current) {
      lastHas.current = has
      onHasContentChange?.(has)
    }
  }, [text, onHasContentChange])

  // Auto-Height per rAF — vermeidet Layout-Thrash im onChange-Pfad.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const id = requestAnimationFrame(() => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, maxHeight) + 'px'
    })
    return () => cancelAnimationFrame(id)
  }, [text, maxHeight])

  const filteredAgents = mention
    ? AGENTS.filter(a => a.name.toLowerCase().startsWith(mention.query) || a.id.startsWith(mention.query))
    : []
  const filteredCommands = slash
    ? SLASH_COMMANDS.filter(c => !c.hidden && c.cmd.slice(1).startsWith(slash.query) && matchEngine(c, isCodex))
    : []

  // Mention/Slash-Status nach oben melden (Parent rendert Menüs).
  useEffect(() => { onMentionChange?.(mention, filteredAgents) }, [mention, onMentionChange]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onSlashChange?.(slash, filteredCommands) }, [slash, onSlashChange]) // eslint-disable-line react-hooks/exhaustive-deps

  const detectMention = (value: string, cursorPos: number) => {
    if (!value.includes('@')) { if (mention) setMention(null); return }
    const before = value.slice(0, cursorPos)
    const match = before.match(/@(\w*)$/)
    if (match) setMention({ query: match[1].toLowerCase(), index: 0 })
    else if (mention) setMention(null)
  }
  const detectSlash = (value: string) => {
    if (value.length === 0 || value[0] !== '/') { if (slash) setSlash(null); return }
    const match = value.match(/^\/(\w*)$/)
    if (match) setSlash({ query: match[1].toLowerCase(), index: 0 })
    else if (slash) setSlash(null)
  }

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setText(v)
    detectMention(v, e.target.selectionStart)
    detectSlash(v)
  }

  const doSelectMention = (agentId: string) => {
    const ta = taRef.current
    if (!ta) return
    const before = text.slice(0, ta.selectionStart)
    const after = text.slice(ta.selectionStart)
    const atPos = before.lastIndexOf('@')
    const newText = before.slice(0, atPos) + after
    setText(newText)
    setMention(null)
    onAgentChange?.(agentId)
    setTimeout(() => {
      ta.focus()
      try { ta.setSelectionRange(atPos, atPos) } catch {}
    }, 0)
  }

  const doSelectSlash = (cmd: SlashCommand) => {
    if (cmd.hint) {
      setText(cmd.cmd + ' ')
      setSlash(null)
      taRef.current?.focus()
    } else {
      onCommand?.(cmd.cmd, '')
      setText('')
      setSlash(null)
    }
  }

  const handleMentionKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!mention || filteredAgents.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setMention(p => p ? { ...p, index: Math.min(p.index + 1, filteredAgents.length - 1) } : null); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setMention(p => p ? { ...p, index: Math.max(p.index - 1, 0) } : null); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); doSelectMention(filteredAgents[mention.index].id); return true }
    if (e.key === 'Escape') { e.preventDefault(); setMention(null); return true }
    return false
  }

  const handleSlashKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!slash || filteredCommands.length === 0) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setSlash(p => p ? { ...p, index: Math.min(p.index + 1, filteredCommands.length - 1) } : null); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSlash(p => p ? { ...p, index: Math.max(p.index - 1, 0) } : null); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); doSelectSlash(filteredCommands[slash.index]); return true }
    if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return true }
    return false
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (handleSlashKeyDown(e)) return
    if (handleMentionKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const trimmed = text.trim()
      const slashMatch = trimmed.match(/^\/(\w+)\s*(.*)$/)
      if (slashMatch) {
        const cmdName = `/${slashMatch[1]}`
        const cmdDef = SLASH_COMMANDS.find(c => c.cmd === cmdName)
        if (cmdDef && matchEngine(cmdDef, isCodex)) {
          onCommandSubmit?.(cmdName, slashMatch[2].trim())
          setText('')
          setSlash(null)
          return
        }
      }
      onSubmit()
    }
  }

  useImperativeHandle(handleRef, () => ({
    getText: () => text,
    getTrimmed: () => text.trim(),
    setText: (v: string) => setText(v),
    clear: () => { setText(''); setSlash(null); setMention(null) },
    focus: () => taRef.current?.focus(),
    blur: () => taRef.current?.blur(),
    prepend: (v: string) => setText(prev => v + prev),
    appendText: (v: string) => {
      setText(prev => {
        const sep = prev && !prev.endsWith('\n') && !prev.endsWith(' ') ? ' ' : ''
        return prev + sep + v
      })
      requestAnimationFrame(() => {
        const ta = taRef.current
        if (!ta) return
        ta.focus()
        const end = ta.value.length
        try { ta.setSelectionRange(end, end) } catch {}
      })
    },
    resetHeight: () => {
      const ta = taRef.current
      if (!ta) return
      requestAnimationFrame(() => { ta.style.height = 'auto' })
    },
    selectMentionAt: (idx: number) => {
      const a = filteredAgents[idx]
      if (a) doSelectMention(a.id)
    },
    selectSlashAt: (idx: number) => {
      const c = filteredCommands[idx]
      if (c) doSelectSlash(c)
    },
  }), [text, filteredAgents, filteredCommands])

  // Externe Events: deck:composerFill (Pillen vorbefüllen), deck:appendText (Paste).
  useEffect(() => {
    const fillHandler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      const incoming = String(d.text || '')
      if (!incoming) return
      setText(incoming)
      requestAnimationFrame(() => {
        const el = taRef.current
        if (el) {
          el.focus()
          try { el.setSelectionRange(incoming.length, incoming.length) } catch {}
        }
      })
    }
    const appendHandler = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if ((d.paneIndex ?? 0) !== paneIndex) return
      const incoming = typeof d.text === 'string' ? d.text : ''
      if (!incoming) return
      setText(prev => {
        const sep = prev && !prev.endsWith('\n') && !prev.endsWith(' ') ? ' ' : ''
        return prev + sep + incoming
      })
      requestAnimationFrame(() => {
        const ta = taRef.current
        if (!ta) return
        ta.focus()
        const end = ta.value.length
        try { ta.setSelectionRange(end, end) } catch {}
      })
    }
    window.addEventListener('deck:composerFill', fillHandler)
    window.addEventListener('deck:appendText', appendHandler)
    return () => {
      window.removeEventListener('deck:composerFill', fillHandler)
      window.removeEventListener('deck:appendText', appendHandler)
    }
  }, [paneIndex])

  return (
    <textarea
      ref={taRef}
      value={text}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      disabled={disabled}
      placeholder={placeholder}
      rows={rows}
      autoFocus={autoFocus}
      autoCorrect={autoCorrect}
      autoComplete={autoComplete}
      className={className}
      style={style}
    />
  )
})
