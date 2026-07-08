import { type CSSProperties, useMemo, useState } from 'react'
import { BarChart3, FolderOpen, Search, Wrench } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'
import {
  AGENT_SKILL_SYSTEMS,
  buildSkillRegister,
  type AgentSkill,
  type AgentSkillSystem,
} from './skillRegister'

type FilterId = 'all' | AgentSkillSystem['id']

function formatUses(value: number): string {
  return `${value}x`
}

function byUsageThenName(a: AgentSkill, b: AgentSkill): number {
  return b.usageCount - a.usageCount || a.name.localeCompare(b.name, 'de')
}

function SkillSystemCard({ system }: { system: AgentSkillSystem }) {
  const usage = system.skills.reduce((sum, skill) => sum + skill.usageCount, 0)
  const mark = system.logoSrc
    ? system.logoMode === 'mask'
      ? <span className="skill-system-logo-mask" style={{ '--skill-system-logo': `url(${system.logoSrc})` } as CSSProperties} />
      : <img src={system.logoSrc} alt="" aria-hidden="true" />
    : system.short

  return (
    <section className="skill-system-card">
      <div className="skill-system-card-head">
        <span className={`skill-system-mark${system.logoSrc ? ' has-logo' : ''}`}>
          {mark}
        </span>
        <div>
          <strong>{system.name}</strong>
          <em>{system.folder}</em>
        </div>
      </div>
      <p>{system.description}</p>
      <div className="skill-system-card-stats">
        <span><b>{system.skills.length}</b> Skills</span>
        <span><b>{formatUses(usage)}</b> Nutzung</span>
      </div>
    </section>
  )
}

function SkillRow({ skill, system }: { skill: AgentSkill; system: AgentSkillSystem }) {
  return (
    <article className="skill-register-row">
      <span className="skill-register-dot" aria-hidden="true" />
      <div className="skill-register-main">
        <div className="skill-register-title">
          <strong>{skill.name}</strong>
          <em>{system.name}</em>
        </div>
        <p>{skill.description}</p>
        <div className="skill-register-meta">
          <span><FolderOpen className="h-3.5 w-3.5" /> {skill.folder}</span>
          <span>{skill.category}</span>
        </div>
      </div>
      <aside>
        <b>{formatUses(skill.usageCount)}</b>
        <i>verwendet</i>
      </aside>
    </article>
  )
}

export function SkillsWorkspace() {
  const register = useMemo(() => buildSkillRegister(AGENT_SKILL_SYSTEMS), [])
  const [active, setActive] = useState<FilterId>('all')
  const [query, setQuery] = useState('')

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return register.skills
      .filter(skill => active === 'all' || skill.systemId === active)
      .filter(skill => !needle || [
        skill.name,
        skill.description,
        skill.folder,
        skill.category,
        register.systemById.get(skill.systemId)?.name || '',
      ].join(' ').toLowerCase().includes(needle))
      .sort(byUsageThenName)
  }, [active, query, register])

  const activeLabel = active === 'all'
    ? 'Alle Agentensysteme'
    : register.systemById.get(active)?.name || 'Agentensystem'

  return (
    <WorkspaceShell
      eyebrow="Skills"
      title="Skill-Register der Agentensysteme"
      subtitle="Ein Sammelpunkt für Hermes, OpenClaw, Claude Code und Codex. Noch ohne Ausführung, aber mit sauberem Datenmodell für echtes Ordner-Auslesen."
      className="skills-workspace"
      action={
        <button type="button" title="Skill-Register ist ein lokales Template">
          <Wrench className="h-4 w-4" />
        </button>
      }
    >
      <div className="workspace-system-strip skills-stat-strip">
        <section>
          <span>Systeme</span>
          <strong>{register.systems.length}</strong>
          <em>angebunden im Register</em>
        </section>
        <section>
          <span>Skills</span>
          <strong>{register.skills.length}</strong>
          <em>zusammengeführt</em>
        </section>
        <section>
          <span>Nutzung</span>
          <strong>{formatUses(register.totalUsage)}</strong>
          <em>lokaler Zähler</em>
        </section>
      </div>

      <div className="skills-toolbar">
        <label className="skills-search">
          <Search className="h-4 w-4" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Skill, System oder Ordner suchen"
          />
        </label>
        <div className="skills-filter" aria-label="Agentensystem filtern">
          <button type="button" className={active === 'all' ? 'is-active' : ''} onClick={() => setActive('all')}>
            Alle
          </button>
          {register.systems.map(system => (
            <button
              key={system.id}
              type="button"
              className={active === system.id ? 'is-active' : ''}
              onClick={() => setActive(system.id)}
            >
              {system.name}
            </button>
          ))}
        </div>
      </div>

      <div className="workspace-system-main skills-layout">
        <section className="workspace-system-panel skills-systems-panel">
          <div className="workspace-system-panel-head">
            <div><BarChart3 className="h-4 w-4" /><strong>Quellordner</strong></div>
            <span>{register.systems.length}</span>
          </div>
          <div className="skills-system-grid">
            {register.systems.map(system => <SkillSystemCard key={system.id} system={system} />)}
          </div>
        </section>

        <section className="workspace-system-panel skills-register-panel">
          <div className="workspace-system-panel-head">
            <div><Wrench className="h-4 w-4" /><strong>{activeLabel}</strong></div>
            <span>{visibleSkills.length}</span>
          </div>
          <div className="skill-register-list">
            {visibleSkills.length === 0 ? (
              <p className="skill-register-empty">Keine Skills für diesen Filter.</p>
            ) : visibleSkills.map(skill => {
              const system = register.systemById.get(skill.systemId)
              if (!system) return null
              return <SkillRow key={`${skill.systemId}:${skill.slug}`} skill={skill} system={system} />
            })}
          </div>
        </section>
      </div>
    </WorkspaceShell>
  )
}
