export type AgentSkillSystemId = 'hermes' | 'openclaw' | 'claude-code' | 'codex'

export type AgentSkill = {
  slug: string
  systemId: AgentSkillSystemId
  name: string
  description: string
  folder: string
  category: string
  usageCount: number
}

export type AgentSkillSystem = {
  id: AgentSkillSystemId
  name: string
  short: string
  folder: string
  description: string
  skills: AgentSkill[]
}

export type SkillRegister = {
  systems: AgentSkillSystem[]
  skills: AgentSkill[]
  totalUsage: number
  systemById: Map<AgentSkillSystemId, AgentSkillSystem>
}

function skill(
  systemId: AgentSkillSystemId,
  slug: string,
  name: string,
  description: string,
  folder: string,
  category: string,
  usageCount: number,
): AgentSkill {
  return { systemId, slug, name, description, folder, category, usageCount }
}

export const AGENT_SKILL_SYSTEMS: AgentSkillSystem[] = [
  {
    id: 'hermes',
    name: 'Hermes',
    short: 'HE',
    folder: 'hermes/skills/',
    description: 'Kundenseitige Agentenfähigkeiten für Kommunikation, Vorbereitung und lokale Arbeitsläufe.',
    skills: [
      skill('hermes', 'kundenbriefing', 'Kundenbriefing', 'Verdichtet Gespräch, Kontext und offene Punkte zu einem klaren Kundenbriefing.', 'hermes/skills/kundenbriefing/SKILL.md', 'Vorbereitung', 18),
      skill('hermes', 'termin-nachlauf', 'Termin-Nachlauf', 'Erkennt Beschlüsse nach einem Termin und formt daraus Aufgaben, Entwürfe und offene Fragen.', 'hermes/skills/termin-nachlauf/SKILL.md', 'Organisation', 11),
      skill('hermes', 'crm-kontext', 'CRM-Kontext', 'Liest die lokale Kontaktkarte und stellt nur den passenden Beziehungskontext bereit.', 'hermes/skills/crm-kontext/SKILL.md', 'Gedächtnis', 7),
    ],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    short: 'OC',
    folder: 'openclaw/skills/',
    description: 'Lokale Skills für installierte Kunden-Agenten, Dateiarbeit und Systemaufgaben am Zielgerät.',
    skills: [
      skill('openclaw', 'mac-mini-setup', 'Mac mini Setup', 'Prüft lokale Voraussetzungen wie Node, Docker und Agent-Konfiguration für den Betrieb.', 'openclaw/skills/mac-mini-setup/SKILL.md', 'Setup', 9),
      skill('openclaw', 'audio-transkription', 'Audio-Transkription', 'Bereitet Audio-Dateien lokal für Transkription und spätere Auswertung vor.', 'openclaw/skills/audio-transkription/SKILL.md', 'Medien', 5),
      skill('openclaw', 'lokaler-healthcheck', 'Lokaler Healthcheck', 'Sammelt Status, Dienste und fehlende Zugänge eines installierten Agentensystems.', 'openclaw/skills/lokaler-healthcheck/SKILL.md', 'Betrieb', 14),
    ],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    short: 'CC',
    folder: '.claude/skills/',
    description: 'Bau- und Review-Fähigkeiten aus Claude-Code-Umgebungen, später aus deren Skill-Ordnern importierbar.',
    skills: [
      skill('claude-code', 'repo-review', 'Repo Review', 'Prüft Änderungen auf Risiken, Regressionen und fehlende Tests.', '.claude/skills/repo-review/SKILL.md', 'Review', 16),
      skill('claude-code', 'frontend-polish', 'Frontend Polish', 'Verbessert Abstände, Zustände, Typografie und responsive Details einer Oberfläche.', '.claude/skills/frontend-polish/SKILL.md', 'UI', 12),
      skill('claude-code', 'ci-debug', 'CI Debug', 'Liest Build- und Testfehler und führt sie auf die wahrscheinliche Ursache zurück.', '.claude/skills/ci-debug/SKILL.md', 'Build', 8),
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    short: 'CX',
    folder: '.codex/skills/',
    description: 'Skills aus Codex-Profilen für lokale Werkbankarbeit, Artefakte und strukturierte Projektänderungen.',
    skills: [
      skill('codex', 'html-artifact', 'HTML-Artefakt', 'Erstellt eine lesbare HTML-Zusammenfassung plus Markdown-Protokoll im Artefakte-Ordner.', '.codex/skills/html-artifact/SKILL.md', 'Artefakt', 21),
      skill('codex', 'skill-creator', 'Skill Creator', 'Legt neue Skills mit klarer Anleitung, Triggern und Wiederverwendung im richtigen Ordner an.', '.codex/skills/skill-creator/SKILL.md', 'Skills', 6),
      skill('codex', 'documents', 'Dokumente', 'Erstellt, prüft und rendert Dokumente, wenn Layout und Dateiqualität wichtig sind.', '.codex/skills/documents/SKILL.md', 'Dokumente', 4),
    ],
  },
]

export function buildSkillRegister(systems: AgentSkillSystem[]): SkillRegister {
  const systemById = new Map<AgentSkillSystemId, AgentSkillSystem>()
  const skills: AgentSkill[] = []

  for (const system of systems) {
    systemById.set(system.id, system)
    for (const entry of system.skills) skills.push(entry)
  }

  return {
    systems,
    skills,
    totalUsage: skills.reduce((sum, entry) => sum + entry.usageCount, 0),
    systemById,
  }
}
