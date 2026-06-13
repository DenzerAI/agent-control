import { useCallback, useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ChevronRight, FileText, FolderOpen, MessageSquare, RefreshCw, Search } from 'lucide-react'
import { useMainAgentName } from '../agents'

type Skill = {
  name: string
  slug: string
  path: string
  description: string
  category: string
  fileCount?: number
  usage?: { runs?: number; errors?: number; warnings?: number; lastAt?: number | null; needsHardening?: boolean }
  manifest?: { status?: string; missing?: string[]; warnings?: string[] }
}

type SkillCategory = { name: string; rank: number; count: number; needsHardening?: number; manifestOpen?: number }

const CACHE_KEY = 'workspace:skills:state'

function readCache(): { skills: Skill[]; categories: SkillCategory[] } {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return { skills: [], categories: [] }
    const parsed = JSON.parse(raw)
    return {
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    }
  } catch { return { skills: [], categories: [] } }
}

function writeCache(value: { skills: Skill[]; categories: SkillCategory[] }) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)) } catch {}
}

function fmtAge(ts?: number | null): string {
  if (!ts) return 'nie'
  const age = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (age < 3600) return `vor ${Math.floor(age / 60)}min`
  if (age < 86400) return `vor ${Math.floor(age / 3600)}h`
  if (age < 86400 * 30) return `vor ${Math.floor(age / 86400)}d`
  return new Date(ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

export function SkillsWorkspace() {
  const agentName = useMainAgentName()
  const cached = readCache()
  const [skills, setSkills] = useState<Skill[]>(cached.skills)
  const [categories, setCategories] = useState<SkillCategory[]>(cached.categories)
  const [active, setActive] = useState('alle')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openSlug, setOpenSlug] = useState('')
  const [docs, setDocs] = useState<Record<string, { html?: string; raw?: string; loading?: boolean; error?: string }>>({})

  const toggleSkill = useCallback((skill: Skill) => {
    const key = skill.slug || skill.path
    setOpenSlug(prev => (prev === key ? '' : key))
    setDocs(prev => {
      if (prev[key]?.html || prev[key]?.loading) return prev
      const next = { ...prev, [key]: { loading: true } }
      fetch(`/api/file?path=${encodeURIComponent(skill.path)}`)
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() })
        .then(d => {
          const raw = String(d.content || '')
          const html = DOMPurify.sanitize(marked.parse(raw) as string)
          setDocs(cur => ({ ...cur, [key]: { html, raw } }))
        })
        .catch(e => setDocs(cur => ({ ...cur, [key]: { error: `Laden fehlgeschlagen: ${e instanceof Error ? e.message : 'unbekannt'}` } })))
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/skills', { cache: 'no-store' })
      const data = await res.json()
      const nextSkills = Array.isArray(data.skills) ? data.skills as Skill[] : []
      const nextCategories = Array.isArray(data.categories) ? data.categories as SkillCategory[] : []
      setSkills(nextSkills)
      setCategories(nextCategories)
      writeCache({ skills: nextSkills, categories: nextCategories })
    } catch (e) {
      setError(`Skills gerade nicht erreichbar, letzter Stand bleibt: ${e instanceof Error ? e.message : 'unbekannt'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const grouped = useMemo(() => {
    const map = new Map<string, Skill[]>()
    for (const skill of skills) {
      const key = skill.category || 'Sonstige'
      const list = map.get(key) || []
      list.push(skill)
      map.set(key, list)
    }
    const source = categories.length ? categories : Array.from(map.keys()).map((name, rank) => ({ name, rank, count: map.get(name)?.length || 0 }))
    return [{ name: 'alle', rank: -1, count: skills.length }, ...source].sort((a, b) => a.rank - b.rank)
  }, [categories, skills])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills
      .filter(skill => active === 'alle' || (skill.category || 'Sonstige') === active)
      .filter(skill => !q || [skill.name, skill.slug, skill.path, skill.description, skill.category].filter(Boolean).join(' ').toLowerCase().includes(q))
      .sort((a, b) => (b.usage?.runs || 0) - (a.usage?.runs || 0))
      .slice(0, 250)
  }, [active, query, skills])

  const hardening = skills.filter(s => s.usage?.needsHardening || s.manifest?.missing?.length || s.manifest?.warnings?.length).length
  const used = skills.filter(s => (s.usage?.runs || 0) > 0).length

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Skills · lokale Fähigkeiten</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">{skills.length} Skills</h2>
            <div className="truncate text-xs text-[var(--t3)]">Systemfähigkeiten, Nutzung und SKILL.md-Pfade</div>
          </div>
          <button type="button" onClick={load} disabled={loading} className="shrink-0 border border-[var(--border)] p-2 text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-60" title="Neu laden">
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Kategorien" value={Math.max(0, grouped.length - 1)} />
          <Stat label="Genutzt" value={used} />
          <Stat label="Härten" value={hardening} />
        </div>
        {error && <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2 text-xs text-[var(--warm)]">{error}</div>}
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {grouped.map(category => (
            <button key={category.name} type="button" onClick={() => setActive(category.name)} className={`border px-3 py-1.5 text-xs ${active === category.name ? 'border-[var(--t2)] text-[var(--t1)]' : 'border-[var(--border)] text-[var(--t3)] hover:text-[var(--t1)]'}`}>
              {category.name === 'alle' ? 'Alle' : category.name} · {category.count}
            </button>
          ))}
        </div>

        <label className="mb-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-[var(--t3)]" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Skill, Pfad oder Beschreibung suchen" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--t1)] outline-none placeholder:text-[var(--t3)]" />
        </label>

        <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <FileText className="h-4 w-4 text-[var(--t3)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--t1)]">{active === 'alle' ? 'Alle Skills' : active}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--t3)]">{visible.length}</span>
          </div>
          {visible.length === 0 ? (
            <div className="px-3 py-4 text-sm text-[var(--t3)]">{loading ? 'Lade Skills' : 'Keine Treffer.'}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {visible.map(skill => {
                const needs = !!(skill.usage?.needsHardening || skill.manifest?.missing?.length || skill.manifest?.warnings?.length)
                const key = skill.slug || skill.path
                const isOpen = openSlug === key
                const doc = docs[key]
                return (
                  <article key={key} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => toggleSkill(skill)}
                      aria-expanded={isOpen}
                      className={`flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left transition-colors ${isOpen ? 'bg-white/[0.04]' : 'hover:bg-white/[0.025]'}`}
                    >
                      <ChevronRight className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--t3)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      <FileText className={`mt-0.5 h-4 w-4 shrink-0 ${needs ? 'text-[var(--warm)]' : 'text-[var(--t3)]'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-[var(--t1)]">{skill.name || skill.slug}</div>
                        <div className={`text-xs leading-5 text-[var(--t3)] ${isOpen ? '' : 'line-clamp-2'}`}>{skill.description || 'Keine Beschreibung.'}</div>
                        <div className="mt-1 truncate text-[11px] text-[var(--t3)]">{skill.path}</div>
                      </div>
                      <aside className="shrink-0 text-right">
                        <div className="text-xs tabular-nums text-[var(--t2)]">{skill.usage?.runs || 0}x</div>
                        <div className="text-[11px] text-[var(--t3)]">{fmtAge(skill.usage?.lastAt)}</div>
                      </aside>
                    </button>
                    {isOpen && (
                      <div className="border-t border-[var(--border)] bg-[var(--bg)] px-3 py-3">
                        <div className="mb-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => window.dispatchEvent(new CustomEvent('deck:openFile', { detail: { path: skill.path } }))}
                            className="flex items-center gap-1.5 border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--t2)] hover:bg-white/[0.05]"
                          >
                            <FolderOpen className="h-3.5 w-3.5" /> Im File System öffnen
                          </button>
                          <button
                            type="button"
                            disabled={!doc?.raw}
                            onClick={() => window.dispatchEvent(new CustomEvent('deck:discussFile', { detail: { filePath: skill.path, content: doc?.raw || '' } }))}
                            className="flex items-center gap-1.5 border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--t2)] hover:bg-white/[0.05] disabled:opacity-50"
                          >
                            <MessageSquare className="h-3.5 w-3.5" /> Mit {agentName} besprechen
                          </button>
                        </div>
                        {doc?.loading ? (
                          <div className="text-sm text-[var(--t3)]">Lade SKILL.md</div>
                        ) : doc?.error ? (
                          <div className="text-sm text-[var(--warm)]">{doc.error}</div>
                        ) : doc?.html ? (
                          <article className="chat-md-agent workspace-reader-content" dangerouslySetInnerHTML={{ __html: doc.html }} />
                        ) : null}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2">
      <div className="text-[11px] text-[var(--t3)]">{label}</div>
      <div className="text-sm font-medium tabular-nums text-[var(--t1)]">{value}</div>
    </section>
  )
}
