import { Archive, CircleCheck, CircleDashed, Lightbulb, ShieldCheck } from 'lucide-react'

type IdeaStatus = 'prüfen' | 'geparkt' | 'bauen'

type Idea = {
  id: string
  title: string
  status: IdeaStatus
  category: string
  summary: string
  next: string
}

const IDEAS: Idea[] = [
  {
    id: 'problemfinder',
    title: 'Problemfinder-Agent',
    status: 'prüfen',
    category: 'Abläufe',
    summary: 'Wiederkehrende Reibung erkennen, ohne in den Chat zu springen.',
    next: 'Erst als stiller Wochenblick testen.',
  },
  {
    id: 'claude-bridge',
    title: 'Claude Bridge',
    status: 'geparkt',
    category: 'Experiment',
    summary: 'Privater Zusatzweg für Opus/Claude-App-Arbeit.',
    next: 'Nur wieder öffnen, wenn es echten Kostenvorteil bringt.',
  },
  {
    id: 'one-click-customer-start',
    title: 'One-Click-Kundenstart',
    status: 'bauen',
    category: 'Produkt',
    summary: 'Aus Kickoff, Website und Dateien einen ersten Kunden-Agenten vorbereiten.',
    next: 'Startpaket aus Profil, Datenräumen, Skills und offenen Fragen bauen.',
  },
  {
    id: 'friction-radar',
    title: 'Reibungsradar',
    status: 'prüfen',
    category: 'Betrieb',
    summary: 'Leere Antworten, Limits und Hänger an einer Stelle sichtbar machen.',
    next: 'Nur melden, wenn ein konkreter Fix naheliegt.',
  },
]

const STATUS_META: Record<IdeaStatus, { label: string; className: string }> = {
  prüfen: { label: 'Prüfen', className: 'is-warn' },
  geparkt: { label: 'Geparkt', className: '' },
  bauen: { label: 'Bauen', className: 'is-ok' },
}

function statusCount(status: IdeaStatus) {
  return IDEAS.filter(item => item.status === status).length
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </section>
  )
}

function statusIcon(status: IdeaStatus) {
  if (status === 'bauen') return <CircleCheck className="h-4 w-4" strokeWidth={1.8} />
  if (status === 'geparkt') return <Archive className="h-4 w-4" strokeWidth={1.8} />
  return <CircleDashed className="h-4 w-4" strokeWidth={1.8} />
}

function PanelHead({ title, meta, icon: Icon }: { title: string; meta: string; icon: typeof Lightbulb }) {
  return (
    <div className="workspace-system-panel-head">
      <div>
        <Icon className="h-4 w-4" strokeWidth={1.8} />
        <strong>{title}</strong>
      </div>
      <span>{meta}</span>
    </div>
  )
}

export function IdeasWorkspace() {
  return (
    <div className="workspace-system workspace-ideas">
      <header className="workspace-system-hero">
        <div>
          <p>Ideen & Konzepte</p>
          <h2>Ideen, die warten dürfen</h2>
          <span>
            Ein ruhiger Parkplatz für besprochene Dinge. Nichts läuft von allein, nichts drängt sich vor.
          </span>
        </div>
      </header>

      <div className="workspace-system-strip">
        <Metric label="Ideen" value={`${IDEAS.length}`} detail="sichtbar geparkt" />
        <Metric label="Prüfen" value={`${statusCount('prüfen')}`} detail="braucht Urteil" />
        <Metric label="Bauen" value={`${statusCount('bauen')}`} detail="hat Produkthebel" />
        <Metric label="Ruhemodus" value="an" detail="kein automatisches Nerven" />
      </div>

      <div className="workspace-system-main workspace-ideas-main">
        <section className="workspace-system-panel workspace-ideas-list">
          <PanelHead icon={Lightbulb} title="Parkplatz" meta={`${IDEAS.length} Ideen`} />
          <div className="workspace-idea-table">
            {IDEAS.map(item => {
              const meta = STATUS_META[item.status]
              return (
                <article key={item.id} className={`workspace-idea-row ${meta.className}`}>
                  <div className="workspace-idea-status">
                    {statusIcon(item.status)}
                    <span>{meta.label}</span>
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.summary}</p>
                    <em>{item.next}</em>
                  </div>
                  <b>{item.category}</b>
                </article>
              )
            })}
          </div>
        </section>

        <section className="workspace-system-panel">
          <PanelHead icon={ShieldCheck} title="So funktioniert es" meta="passiv" />
          <div className="workspace-ideas-rules">
            <div>
              <span>Wenn du sagst: „Park die Idee“</span>
              <strong>Ich schätze sie kurz ein und lege sie hier ab.</strong>
            </div>
            <div>
              <span>Was nicht passiert</span>
              <strong>Keine Pushes, keine Hintergrund-Jobs, keine Aufgabenflut.</strong>
            </div>
            <div>
              <span>Wann daraus Arbeit wird</span>
              <strong>Erst wenn wir bewusst sagen: prüfen, bauen oder löschen.</strong>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
