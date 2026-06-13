import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MeshGradient } from '@paper-design/shaders-react'
import { Bot, Check, ChevronRight, FileText, Globe, Mail, MessageSquare, Pencil, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'

type StepStatus = 'done' | 'active' | 'next' | 'pending'

export interface FlowToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  status?: string
  result?: string
  output?: string
}

export interface FlowSnapshot {
  conversationId: string
  title?: string
  agent?: string
  agentId?: string
  model?: string
  running: boolean
  startedAt?: number
  thinkingText?: string
  fullText?: string
  toolCalls: FlowToolCall[]
}

interface FlowStep {
  id: string
  label: string
  detail: string
  icon: LucideIcon
}

interface LiveModel {
  title: string
  subtitle: string
  steps: FlowStep[]
  targetIdx: number
}

function clip(text: string, limit = 58): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > limit ? `${s.slice(0, limit - 1).trimEnd()}…` : s
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function humanizeToolName(name: string): string {
  const raw = String(name || '').trim()
  if (!raw) return 'Werkzeug nutzen'
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

function describeTool(tool: FlowToolCall, index: number): FlowStep {
  const name = (tool.name || '').toLowerCase()
  const input = tool.input || {}
  const command = firstString(input.command, input.cmd)
  const path = firstString(input.file_path, input.path)
  const query = firstString(input.q, input.query, input.pattern, input.search_query)
  const url = firstString(input.url, input.ref_id)

  if (name === 'bash') {
    const readOnly = /^(rg|grep|find|ls|cat|head|tail|sed|git status|git diff|git show|pwd|which|wc|stat)\b/i.test(command)
    return {
      id: tool.id || `tool-${index}`,
      label: readOnly ? 'Code prüfen' : 'Änderung ausführen',
      detail: clip(command || 'Shell-Kommando'),
      icon: readOnly ? Search : Terminal,
    }
  }

  if (name === 'read' || name === 'open_file') {
    return {
      id: tool.id || `tool-${index}`,
      label: 'Datei lesen',
      detail: clip(path || 'Projektdatei öffnen'),
      icon: FileText,
    }
  }

  if (name === 'write' || name === 'edit' || name === 'apply_patch' || name === 'notebookedit') {
    return {
      id: tool.id || `tool-${index}`,
      label: 'Code ändern',
      detail: clip(path || 'Lösung direkt anpassen'),
      icon: Pencil,
    }
  }

  if (name.includes('search') || name === 'find' || name === 'glob') {
    return {
      id: tool.id || `tool-${index}`,
      label: 'Stelle suchen',
      detail: clip(query || path || 'Relevanten Kontext finden'),
      icon: Search,
    }
  }

  if (name === 'open' || name === 'click' || name.includes('web')) {
    return {
      id: tool.id || `tool-${index}`,
      label: 'Ansicht prüfen',
      detail: clip(url || query || 'Ergebnis kurz ansehen'),
      icon: Globe,
    }
  }

  if (name === 'agent') {
    return {
      id: tool.id || `tool-${index}`,
      label: 'Kurz gegenprüfen',
      detail: clip(firstString(input.prompt, input.message, tool.result, tool.output) || 'Zweite Sicht auf den Schritt'),
      icon: Bot,
    }
  }

  if (name.includes('mail')) {
    return {
      id: tool.id || `tool-${index}`,
      label: 'Mail vorbereiten',
      detail: clip(firstString(input.subject, input.account, tool.result) || 'Mail-Kontext bearbeiten'),
      icon: Mail,
    }
  }

  return {
    id: tool.id || `tool-${index}`,
    label: humanizeToolName(tool.name),
    detail: clip(path || query || command || firstString(tool.result, tool.output) || 'Werkzeug verwenden'),
    icon: Wrench,
  }
}

function buildLiveModel(snapshot: FlowSnapshot): LiveModel {
  const tools = Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : []

  if (tools.length === 0) {
    return {
      title: snapshot.title || 'Aktiver Ablauf',
      subtitle: snapshot.agent || snapshot.model || 'Live',
      steps: [{
        id: 'thinking',
        label: snapshot.running ? 'Auftrag lesen' : 'Antwort fertig',
        detail: clip(snapshot.thinkingText || snapshot.fullText || 'Wartet auf den nächsten Ablauf'),
        icon: snapshot.running ? Bot : MessageSquare,
      }],
      targetIdx: 0,
    }
  }

  const steps = tools.map((tool, index) => describeTool(tool, index))

  if (!snapshot.running) {
    steps.push({
      id: 'reply',
      label: 'Antwort schreiben',
      detail: clip(snapshot.fullText || 'Bringt das Ergebnis in den Chat zurück'),
      icon: MessageSquare,
    })
  }

  const activeIdxRaw = tools.findIndex(tool => (tool.status || 'running') !== 'completed')
  const targetIdx = !snapshot.running
    ? Math.max(0, steps.length - 1)
    : activeIdxRaw >= 0
      ? activeIdxRaw
      : Math.max(0, steps.length - 1)

  return {
    title: snapshot.title || 'Aktiver Ablauf',
    subtitle: snapshot.agent || snapshot.model || 'Live',
    steps,
    targetIdx,
  }
}

function StationCard({ step, status, mobile }: { step: FlowStep; status: StepStatus; mobile?: boolean }) {
  const Icon = step.icon
  const tone =
    status === 'done'   ? 'text-[#f2c3a7]/82' :
    status === 'active' ? 'text-white' :
                          'text-white/45'

  const iconBg =
    status === 'done'
      ? 'bg-[rgba(217,119,87,0.10)] border-[rgba(217,119,87,0.28)]'
      : status === 'active'
        ? 'bg-[rgba(217,119,87,0.12)] border-[rgba(217,119,87,0.72)]'
        : 'bg-[rgba(255,255,255,0.02)] border-white/10'

  return (
    <div className={`flex-1 min-w-0 flex flex-col items-center text-center transition-opacity duration-500 ${status === 'pending' ? 'opacity-0' : 'opacity-100'}`}>
      <div className="relative">
        <div className={`w-9 h-9 rounded-full border flex items-center justify-center ${iconBg} transition-colors duration-500`}>
          {status === 'done' ? (
            <Check size={16} className="text-[#f2c3a7]/90" />
          ) : (
            <Icon size={16} className={tone} />
          )}
        </div>
        {status === 'active' && (
          <span className="absolute inset-0 rounded-full border border-[rgba(217,119,87,0.42)] animate-ping-slow pointer-events-none" />
        )}
      </div>
      <div className={`mt-1.5 ${mobile ? 'text-[12px]' : 'text-[14px]'} leading-tight font-semibold truncate w-full px-1 ${tone}`}>
        {step.label}
      </div>
      {status === 'active' && !mobile && (
        <div className="mt-0.5 text-[13px] leading-tight text-white/82 truncate w-full px-1">
          {step.detail}
        </div>
      )}
    </div>
  )
}

function Connector({ filled }: { filled: boolean }) {
  return (
    <div className="flex items-center justify-center px-1 pt-3">
      <ChevronRight
        size={15}
        className={`transition-colors duration-500 ${filled ? 'text-[rgba(217,119,87,0.74)]' : 'text-white/20'}`}
      />
    </div>
  )
}

function FlowShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/8 bg-[#141312] px-3 pt-2 pb-[22px]">
      <MeshGradient
        className="pointer-events-none absolute inset-0 h-full w-full opacity-55"
        colors={['#141312', '#1b1817', '#d97757', '#f0dfd2', '#7a3e27']}
        speed={0.12}
      />
      <MeshGradient
        className="pointer-events-none absolute inset-0 h-full w-full opacity-20"
        colors={['#141312', '#2a211d', '#b85f3f', '#f4e9df']}
        speed={0.08}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `
            radial-gradient(120% 90% at 15% 15%, rgba(217,119,87,0.10) 0%, rgba(217,119,87,0.03) 24%, rgba(217,119,87,0) 52%),
            linear-gradient(135deg, rgba(20,19,18,0.78) 0%, rgba(20,19,18,0.82) 52%, rgba(17,16,15,0.9) 100%)
          `,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  )
}

export function AgentFlowPane({ mobile, snapshot, loading }: { mobile?: boolean; snapshot?: FlowSnapshot | null; loading?: boolean }) {
  const live = useMemo(() => (snapshot ? buildLiveModel(snapshot) : null), [snapshot])
  const [displayIdx, setDisplayIdx] = useState(0)

  useEffect(() => {
    setDisplayIdx(0)
  }, [snapshot?.conversationId])

  useEffect(() => {
    if (!live) {
      setDisplayIdx(0)
      return
    }
    setDisplayIdx(current => {
      const maxIdx = Math.max(0, live.steps.length - 1)
      return Math.min(current, maxIdx)
    })
  }, [live])

  useEffect(() => {
    if (!live) return
    const targetIdx = Math.max(0, Math.min(live.targetIdx, live.steps.length - 1))
    if (displayIdx === targetIdx) return
    const timer = window.setTimeout(() => {
      setDisplayIdx(current => {
        if (current === targetIdx) return current
        return current < targetIdx ? current + 1 : current - 1
      })
    }, 260)
    return () => window.clearTimeout(timer)
  }, [displayIdx, live])

  if (!live) {
    return (
      <FlowShell>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full ${loading ? 'bg-[var(--cc-orange)] animate-pulse' : 'bg-white/25'}`} />
            <span className="text-[14px] text-white font-medium truncate">Agentenfluss</span>
            <span className="text-[12px] text-[#f2c3a7]/70 truncate">{loading ? '· lädt' : '· bereit'}</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
          <div className="text-[14px] text-white truncate">Kein aktiver Ablauf. Sobald ein Chat oder Job läuft, erscheint er hier.</div>
        </div>
      </FlowShell>
    )
  }

  const safeIdx = Math.max(0, Math.min(displayIdx, live.steps.length - 1))
  const currentStep = live.steps[safeIdx]
  const prevStep = safeIdx > 0 ? live.steps[safeIdx - 1] : null
  const nextStep = safeIdx < live.steps.length - 1 ? live.steps[safeIdx + 1] : null

  return (
    <FlowShell>
      <div className="flex items-center justify-between mb-2 gap-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--cc-orange)] animate-pulse" />
          <span className={`${mobile ? 'text-[14px]' : 'text-[16px]'} text-white font-semibold truncate`}>{live.title}</span>
          <span className={`${mobile ? 'text-[12px]' : 'text-[14px]'} text-[#f2c3a7]/70 truncate`}>· {live.subtitle}</span>
        </div>
      </div>

      <div key={`${snapshot?.conversationId || 'idle'}:${safeIdx}:${live.steps.length}`} className="flex items-start gap-0 animate-flow-slide">
        {prevStep ? <StationCard step={prevStep} status="done" mobile={mobile} /> : <div className="flex-1" />}
        <Connector filled={!!prevStep} />
        <StationCard step={currentStep} status="active" mobile={mobile} />
        <Connector filled={!!nextStep} />
        {nextStep ? <StationCard step={nextStep} status="next" mobile={mobile} /> : <div className="flex-1" />}
      </div>
    </FlowShell>
  )
}
