import { Building2, Database, FileText } from 'lucide-react'

function MemoryCard({ icon: Icon, title, text }: { icon: typeof Building2; title: string; text: string }) {
  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-1)] p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--t1)]">
        <Icon className="h-4 w-4 text-[var(--warm)]" strokeWidth={1.75} />
        <span>{title}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--t2)]">{text}</p>
    </section>
  )
}

export function CompanyMemoryWorkspace() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-5 py-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--warm)]">Wissen</div>
        <h2 className="mt-1 text-2xl font-medium leading-tight text-[var(--t1)]">Zentrale Wissensbasis</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--t2)]">
          Platzhalter für Kundenwissen, Standards, Entscheidungen und wiederverwendbare Unterlagen.
        </p>
      </header>
      <main className="grid gap-3 overflow-auto p-4 sm:grid-cols-3">
        <MemoryCard icon={Building2} title="Unternehmen" text="Profil, Angebote, Zielgruppen und feste Spielregeln des Kunden." />
        <MemoryCard icon={Database} title="Wissen" text="Dokumente, Notizen und geprüfte Fakten an einem neutralen Ort." />
        <MemoryCard icon={FileText} title="Vorlagen" text="Wiederverwendbare Texte, Prozesse und Kundenbausteine." />
      </main>
    </div>
  )
}
