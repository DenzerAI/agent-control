import { Building2, Database, FileText, ShieldCheck } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

function MemoryCard({ icon: Icon, title, text }: { icon: typeof Building2; title: string; text: string }) {
  return (
    <article className="workspace-system-row is-neutral">
      <span />
      <div>
        <strong className="flex items-center gap-2"><Icon className="h-4 w-4 text-[var(--warm)]" strokeWidth={1.75} />{title}</strong>
        <em>{text}</em>
      </div>
    </article>
  )
}

export function CompanyMemoryWorkspace() {
  return (
    <WorkspaceShell
      eyebrow="Wissen"
      title="Zentrale Wissensbasis"
      subtitle="Demo-Einträge untereinander, später mit echten Kundenakten, Regeln und Vorlagen befüllbar."
    >
      <section className="workspace-system-panel">
        <div className="workspace-system-list">
          <MemoryCard icon={Building2} title="Unternehmen" text="Profil, Angebote, Zielgruppen, Tonalität und feste Spielregeln des Kunden." />
          <MemoryCard icon={Database} title="Geprüftes Wissen" text="Dokumente, Notizen, Entscheidungen und Fakten mit Quelle und Stand." />
          <MemoryCard icon={FileText} title="Vorlagen" text="Wiederverwendbare Texte, Angebotsbausteine, Checklisten und Kundenantworten." />
          <MemoryCard icon={ShieldCheck} title="Regeln" text="Was der Agent darf, was Freigabe braucht und wo sensible Grenzen liegen." />
        </div>
      </section>
    </WorkspaceShell>
  )
}
