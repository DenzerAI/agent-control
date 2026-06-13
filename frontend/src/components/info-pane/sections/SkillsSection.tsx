import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, FolderClosed, Wrench } from 'lucide-react'
import { playUISound } from '../../../uiSounds'
import { Guided } from '../utils/tree'

type Skill = {
  name: string
  slug: string
  path: string
  directory?: string
  description: string
  category: string
  categoryRank?: number
  fileCount?: number
  usage?: SkillUsage
  manifest?: SkillManifest
}

type SkillManifest = {
  status?: string
  coverage?: number
  missing?: string[]
  warnings?: string[]
  security?: { status?: string; issueCount?: number }
}

type SkillUsage = {
  runs?: number
  successes?: number
  errors?: number
  warnings?: number
  lastAt?: number | null
  lastStatus?: string
  lastReviewStatus?: string
  lastReviewMessage?: string
  score?: number | null
  needsHardening?: boolean
}

type SkillCategory = {
  name: string
  rank: number
  count: number
  runs?: number
  needsHardening?: number
  manifestOpen?: number
}

function loadOpenCategories(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('infopane:skills:openCategories') || '[]'))
  } catch {
    return new Set()
  }
}

function saveOpenCategories(open: Set<string>) {
  try {
    localStorage.setItem('infopane:skills:openCategories', JSON.stringify(Array.from(open)))
  } catch {}
}

function fmtLastUse(ts?: number | null): string {
  if (!ts) return 'noch nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 60) return 'gerade eben'
  if (age < 3600) return `vor ${Math.floor(age / 60)} min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)} h`
  if (age < 86400 * 30) return `vor ${Math.floor(age / 86400)} d`
  return new Date(ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

function SkillRow({ skill, mobile, onOpenFile }: { skill: Skill; mobile?: boolean; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const label = skill.name || skill.slug
  const description = skill.description || 'Keine Kurzbeschreibung vorhanden.'
  const usage = skill.usage || {}
  const runs = usage.runs || 0
  return (
    <div>
      <button
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-[6px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
        title={skill.path}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <FileText className="info-icon-sm mr-2 text-[var(--t3)] group-hover:text-[var(--t2)] flex-shrink-0" />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{label}</span>
      </button>
      {open && (
        <Guided>
          <div className="info-detail-list info-text-meta">
            <div className="info-detail-note info-detail-value leading-relaxed">{description}</div>
            <div className="info-detail-row">
              <span className="info-detail-label">Nutzung</span>
              <span className="info-detail-value">{runs ? `${runs} Einsätze` : 'keine Einsätze'}</span>
            </div>
            <div className="info-detail-row">
              <span className="info-detail-label">Zuletzt</span>
              <span className="info-detail-value">{fmtLastUse(usage.lastAt)}</span>
            </div>
            <div className="info-detail-row">
              <span className="info-detail-label">Datei</span>
              <span className="info-detail-value flex items-center gap-2 min-w-0">
              <button
                onClick={() => onOpenFile(skill.path)}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.09] text-[var(--t2)] hover:text-[var(--t1)] info-text-meta transition-colors"
              >
                <FileText className="info-icon-sm" />
                SKILL.md öffnen
              </button>
              <span className="info-text-meta text-[var(--t3)]/60 truncate">{skill.slug}/</span>
              {skill.fileCount && skill.fileCount > 1 && (
                <span className="info-text-meta text-[var(--t3)]/50 truncate">{skill.fileCount} Dateien</span>
              )}
              </span>
            </div>
          </div>
        </Guided>
      )}
    </div>
  )
}

function CategoryFolder({ category, skills, mobile, onOpenFile, openCategories, onToggleCategory }: {
  category: SkillCategory
  skills: Skill[]
  mobile?: boolean
  onOpenFile: (path: string) => void
  openCategories: Set<string>
  onToggleCategory: (name: string) => void
}) {
  const open = openCategories.has(category.name)
  return (
    <div>
      <button
        onClick={() => onToggleCategory(category.name)}
        className={`group w-full flex items-center pr-3 pl-1 ${mobile ? 'py-2.5' : 'py-[6px]'} info-text-body text-left cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <FolderClosed className="info-icon-sm mr-2 text-[var(--t3)] group-hover:text-[var(--t2)] flex-shrink-0" />
        <span className="truncate flex-1 text-[var(--t2)] group-hover:text-[var(--t1)]">{category.name}</span>
        <span className="info-text-meta text-[var(--t3)] tabular-nums flex-shrink-0">{skills.length}</span>
      </button>
      {open && (
        <Guided>
          {skills.map(skill => (
            <SkillRow key={skill.slug || skill.path} skill={skill} mobile={mobile} onOpenFile={onOpenFile} />
          ))}
        </Guided>
      )}
    </div>
  )
}

export function SkillsSection({ mobile, forceOpenSignal, onOpenFile, onOpenWorkspace }: { mobile?: boolean; forceOpenSignal?: number; onOpenFile?: (path: string) => void; onOpenWorkspace?: () => void }) {
  if (onOpenWorkspace) return <SkillsWorkspaceEntry mobile={mobile} onOpenWorkspace={onOpenWorkspace} />
  const [open, setOpen] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [loading, setLoading] = useState(false)
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => loadOpenCategories())
  const lastSignalRef = useRef<number | undefined>(forceOpenSignal)

  useEffect(() => {
    if (forceOpenSignal !== undefined && forceOpenSignal !== lastSignalRef.current) {
      lastSignalRef.current = forceOpenSignal
      setOpen(true)
    }
  }, [forceOpenSignal])

  const load = useCallback(async (cancelled?: () => boolean) => {
    setLoading(true)
    try {
      const skillsRes = await fetch('/api/skills', { cache: 'no-store' })
      const data = await skillsRes.json()
      if (cancelled?.()) return
      setSkills(Array.isArray(data.skills) ? data.skills : [])
      setCategories(Array.isArray(data.categories) ? data.categories : [])
    } catch {
      if (!cancelled?.()) {
        setSkills([])
        setCategories([])
      }
    } finally {
      if (!cancelled?.()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  const grouped = useMemo(() => {
    const byCategory = new Map<string, Skill[]>()
    for (const skill of skills) {
      const cat = skill.category || 'Sonstige'
      const list = byCategory.get(cat) || []
      list.push(skill)
      byCategory.set(cat, list)
    }
    const source = categories.length > 0
      ? categories
      : Array.from(byCategory.keys()).map((name, i) => ({ name, rank: i, count: byCategory.get(name)?.length || 0 }))
    return source
      .map(category => ({ category, skills: byCategory.get(category.name) || [] }))
      .filter(group => group.skills.length > 0)
  }, [categories, skills])

  const toggleCategory = (name: string) => {
    setOpenCategories(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      saveOpenCategories(next)
      playUISound(next.has(name) ? 'section-open' : 'section-close')
      return next
    })
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v })}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => { playUISound(v ? 'section-close' : 'section-open'); return !v }) } }}
        className={`group flex items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors`}
      >
        <ChevronRight className={`info-icon-sm mr-2 text-[var(--t3)] transition-transform duration-150 flex-shrink-0 ${open ? 'rotate-90' : ''}`} />
        <Wrench className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)]" />
        <span className="text-[var(--t2)] font-medium">Skills</span>
        <span className="flex-1" />
      </div>
      {open && (
        <div className="pb-3">
          <Guided>
            {loading && skills.length === 0 && (
              <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">Lade Skills...</div>
            )}
            {!loading && grouped.length === 0 && (
              <div className="info-text-meta text-[var(--t3)]/60 pl-1 pr-3 py-2">Keine Skills gefunden.</div>
            )}
            {grouped.map(group => (
              <CategoryFolder
                key={group.category.name}
                category={group.category}
                skills={group.skills}
                mobile={mobile}
                onOpenFile={onOpenFile || (() => {})}
                openCategories={openCategories}
                onToggleCategory={toggleCategory}
              />
            ))}
          </Guided>
        </div>
      )}
    </div>
  )
}

function SkillsWorkspaceEntry({ mobile, onOpenWorkspace }: { mobile?: boolean; onOpenWorkspace: () => void }) {
  return (
    <div>
      <button
        type="button"
        onClick={() => { playUISound('section-open'); onOpenWorkspace() }}
        className={`group flex w-full items-center pr-3 pl-2 ${mobile ? 'py-3' : 'py-2'} info-text-body cursor-pointer hover:bg-white/[0.06] active:bg-white/[0.08] transition-colors text-left`}
        title="Skills im Workspace öffnen"
      >
        <Wrench className="info-icon-md mr-2 flex-shrink-0 text-[var(--t3)] group-hover:text-[var(--t2)]" />
        <span className="text-[var(--t2)] font-medium flex-1">Skills</span>
      </button>
    </div>
  )
}
