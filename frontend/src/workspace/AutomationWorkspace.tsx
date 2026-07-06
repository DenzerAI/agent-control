import { Activity, Plus, Rows3, ShieldCheck } from 'lucide-react'

function EmptyRow({ title, text }: { title: string; text: string }) {
  return (
    <article className="workspace-system-row is-neutral">
      <span />
      <div>
        <strong>{title}</strong>
        <em>{text}</em>
      </div>
      <aside>
        <Rows3 className="h-4 w-4" />
      </aside>
    </article>
  )
}

export function AutomationWorkspace() {
  return (
    <div className="workspace-system">
      <header className="workspace-system-hero">
        <div>
          <p>Automationen</p>
          <h2>Noch keine Automationen</h2>
          <span>Der Rahmen steht, die konkreten Abläufe kommen später dazu.</span>
        </div>
        <button type="button" title="Automation vormerken">
          <Plus className="h-4 w-4" />
        </button>
      </header>

      <div className="workspace-system-strip">
        <section>
          <span>Status</span>
          <strong>Leer</strong>
          <em>keine aktiven Regeln</em>
        </section>
        <section>
          <span>Auslöser</span>
          <strong>0</strong>
          <em>noch nicht konfiguriert</em>
        </section>
        <section>
          <span>Prüfung</span>
          <strong>0</strong>
          <em>keine offenen Freigaben</em>
        </section>
      </div>

      <div className="workspace-system-main">
        <section className="workspace-system-panel">
          <div className="workspace-system-panel-head">
            <div>
              <Activity className="h-4 w-4" />
              <strong>Automationen</strong>
            </div>
            <span>später</span>
          </div>
          <div className="workspace-system-list">
            <EmptyRow title="Noch kein Ablauf angelegt" text="Hier landen später wiederkehrende Aufgaben, Trigger und Freigaben." />
            <EmptyRow title="Vorlagen vorbereitet" text="Der Reiter bleibt bewusst leer, bis echte Kunden-Abläufe definiert sind." />
          </div>
        </section>

        <section className="workspace-system-panel">
          <div className="workspace-system-panel-head">
            <div>
              <ShieldCheck className="h-4 w-4" />
              <strong>Freigaben</strong>
            </div>
            <span>keine</span>
          </div>
          <div className="workspace-system-list">
            <p>Automationen mit Außenwirkung erscheinen hier erst, wenn sie sauber angelegt und freigegeben werden.</p>
          </div>
        </section>
      </div>
    </div>
  )
}
