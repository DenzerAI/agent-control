// Pulses + Workers + Hooks + Tasks — Status-Polling für den Automation-Tab.
// Lädt /api/automation, poll alle 30s, lebt als Modul-Singleton.

import { useEffect, useState } from 'react'

export type PulseColor = 'green' | 'orange' | 'red' | 'gray'

export type AutomationRow = {
  name: string
  label?: string
  what?: string
  how?: string
  who?: string
  internal_name?: string
  last_run: number | null
  last_ok_at?: number | null
  last_status: string
  last_message: string
  fail_streak: number
  color: PulseColor
  age_sec: number | null
  last_file?: string | null
}

export type Pulse = AutomationRow & {
  interval_sec: number
  engine?: 'claude' | 'codex' | 'qwen' | null
  llm?: string
}

export type AutomationSnapshot = {
  pulses: Pulse[]
  workers: AutomationRow[]
  hooks: AutomationRow[]
  tasks: AutomationRow[]
  workflows: WorkflowRun[]
}

export type WorkflowRun = {
  id: string
  workflow_key: string
  title: string
  status: string
  review_status: string
  review_message: string
  subject_type?: string
  subject_ref?: string
  error?: string
  created_at: number
  finished_at?: number | null
  input?: Record<string, unknown>
  result?: Record<string, unknown>
  review?: {
    suggested_refinement?: string
    checks?: unknown[]
    trace?: string[]
    learning?: {
      class?: 'direct' | 'detour' | 'blocker' | string
      label?: string
      detour_count?: number
      blocker_count?: number
      learning_count?: number
      failed_attempts?: string[]
      working_after_failure?: string[]
      highway_note?: string
    }
    metrics?: {
      overall_score?: number
      safety_score?: number
      completion_score?: number
      check_score?: number
      speed_score?: number
      duration_ms?: number
      step_count?: number
      error_count?: number
      warning_count?: number
      detour_count?: number
      blocker_count?: number
      learning_count?: number
      check_count?: number
      source_count?: number
      candidate_count?: number
      dropped_count?: number
      injected_chars?: number
      tool_count?: number
      changed_tool_count?: number
      input_tokens?: number
      output_tokens?: number
    }
    feedback_summary?: {
      helpful?: number
      wrong?: number
      last_rating?: string
    }
  } & Record<string, unknown>
  steps?: { step_key: string; label: string; status: string; summary: string; ts: number }[]
}

const EMPTY: AutomationSnapshot = { pulses: [], workers: [], hooks: [], tasks: [], workflows: [] }
let current: AutomationSnapshot = EMPTY
const listeners = new Set<(p: AutomationSnapshot) => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchOnce() {
  try {
    const r = await fetch('/api/automation')
    if (!r.ok) return
    const d = await r.json()
    const next: AutomationSnapshot = {
      pulses: Array.isArray(d?.pulses) ? d.pulses : [],
      workers: Array.isArray(d?.workers) ? d.workers : [],
      hooks: Array.isArray(d?.hooks) ? d.hooks : [],
      tasks: Array.isArray(d?.tasks) ? d.tasks : [],
      workflows: Array.isArray(d?.workflows) ? d.workflows : [],
    }
    current = next
    listeners.forEach(fn => fn(next))
  } catch {
    /* still */
  }
}

function ensurePolling() {
  if (pollTimer !== null) return
  fetchOnce()
  pollTimer = setInterval(fetchOnce, 30_000)
}

function stopPollingIfIdle() {
  if (listeners.size === 0 && pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function useAutomation(): AutomationSnapshot {
  const [snap, setSnap] = useState<AutomationSnapshot>(current)
  useEffect(() => {
    listeners.add(setSnap)
    ensurePolling()
    return () => {
      listeners.delete(setSnap)
      stopPollingIfIdle()
    }
  }, [])
  return snap
}

// Abwärtskompatibler Selector — Pulses-Liste (für bestehende Verbraucher).
export function usePulses(): Pulse[] {
  return useAutomation().pulses
}

export function refreshPulses() {
  fetchOnce()
}

// Tageszähler für lokales Modell, parst aus dem local-llm-Pulse die Zahl
// "X Calls heute" raus. Wenn der Pulse fehlt, null.
export function useLocalLlmStats(): { today_count: number | null } {
  const pulses = usePulses()
  const p = pulses.find(x => x.name === 'local-llm')
  if (!p || !p.last_message) return { today_count: null }
  const m = /^(\d+)\s+Calls\s+heute/.exec(p.last_message)
  return { today_count: m ? parseInt(m[1], 10) : null }
}
