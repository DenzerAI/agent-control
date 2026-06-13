import type { EngineId } from './components/EngineBadge'

export type EngineFeature = {
  label: string
  what: string
  trigger: string
  feature?: string
  fallback?: { engine?: EngineId; provider?: string; model: string }
}

export type EngineCatalogItem = {
  id: string
  badge: EngineId | null
  name: string
  features: EngineFeature[]
}

export type EngineFeatureStat = {
  calls: number
  provider: string
  model: string
  median_latency_ms: number
  error_pct: number
  fallback_pct: number
}

export const ENGINES: EngineCatalogItem[] = [
  {
    id: 'qwen-vl',
    badge: 'qwen',
    name: 'Qwen3-VL-30b',
    features: [
      {
        label: 'Auto-Titel',
        what: 'Vergibt nach den ersten Turns einen Chat-Titel.',
        trigger: 'Nach 2. User-Nachricht in neuem Chat',
        feature: 'auto_title',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
      {
        label: 'Auto-Projekt',
        what: 'Ordnet neue Chats automatisch einem Projekt zu.',
        trigger: 'Nach Auto-Titel-Lauf',
        feature: 'auto_project',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
      {
        label: 'WhatsApp-Klassifikation',
        what: 'Liest neue WA-Nachrichten, klassifiziert Topic und Dringlichkeit.',
        trigger: 'Pro neuer WA-Message',
        feature: 'whatsapp_classify',
        fallback: { provider: 'Groq', model: 'llama-3.1-8b-instant' },
      },
      {
        label: 'WhatsApp-Thread-Zusammenfassung',
        what: 'Verdichtet einen WA-Thread zu Summary + offener Frage.',
        trigger: 'On-Demand im InfoPane',
        feature: 'whatsapp_summary',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
      {
        label: 'Fokus-Verdichtung',
        what: 'Komprimiert lange Fokus-Listen, generiert Kurztitel.',
        trigger: 'Bei /fokus-Aufruf und Kalender-Sync',
        feature: 'fokus_distill',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
      {
        label: 'Health-Verdichtung',
        what: 'Fasst Health-Rohdaten zu kind + Stichpunkt zusammen.',
        trigger: 'Täglich via Cron',
        feature: 'health_distill',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
      {
        label: 'Heartbeat-Pulses',
        what: 'Agent postet einen Satz oder STILL als Lebenszeichen.',
        trigger: 'Pulses-Loop (alle paar Minuten)',
        feature: 'pulses_heartbeat',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
      {
        label: 'Meeting-Extrakt',
        what: 'Zieht aus jedem Meeting-Transkript Summary, Entscheidungen, Fakten und To dos und hängt sie als datierten Eintrag in die Person-MD.',
        trigger: 'Nach finish_meeting (im Hintergrund)',
        feature: 'meeting_extract',
        fallback: { engine: 'claude', model: 'Haiku 4.5' },
      },
    ],
  },
  {
    id: 'qwen-embed',
    badge: 'qwen',
    name: 'Qwen3-Embedding 0.6b',
    features: [
      {
        label: 'Memory-Embedding',
        what: 'Wandelt Chat-Messages und Brain-Files in semantische Fingerabdrücke.',
        trigger: 'Bei jeder neuen Message und Brain-Datei-Änderung',
        feature: 'memory_embed',
      },
    ],
  },
  {
    id: 'claude-opus',
    badge: 'claude',
    name: 'Claude Opus 4.7',
    features: [
      {
        label: 'Chat-Antworten',
        what: 'Du gegen Agent. Das eigentliche Gespräch hier im Fenster.',
        trigger: 'Jede User-Message ohne Engine-Override',
        feature: 'chat_claude',
      },
      {
        label: 'WhatsApp-/Mail-Drafts',
        what: 'Formuliert Drafts in des Nutzers Ton, klingt menschlich.',
        trigger: 'Inline im Chat ("schick X per WA: ...")',
      },
    ],
  },
  {
    id: 'claude-haiku',
    badge: 'claude',
    name: 'Claude Haiku 4.5',
    features: [
      {
        label: 'Mail-Eingang-Klassifikation',
        what: 'Klassifiziert eingehende Mails, erkennt Workshop-Absagen u.ä.',
        trigger: 'Pro neuer Mail (Eingang-Worker)',
        feature: 'mail_classify',
      },
      {
        label: 'Fallback für lokale Features',
        what: 'Springt ein wenn Qwen nicht antwortet oder leeren Output liefert.',
        trigger: 'Automatisch bei Qwen-Timeout/Fehler',
      },
    ],
  },
  {
    id: 'openai',
    badge: 'openai',
    name: 'OpenAI GPT-5.5',
    features: [
      {
        label: 'Code-Review',
        what: 'Zweitmeinung auf Plan/Code, Auto-Review bei Planung und Brainstorm.',
        trigger: '/codex im Chat oder Auto-Hook beim Planen',
        feature: 'chat_codex',
      },
    ],
  },
]
