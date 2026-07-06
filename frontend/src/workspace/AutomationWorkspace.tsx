import { Activity, Clock3, Plus, ShieldCheck } from 'lucide-react'

export function AutomationWorkspace() {
  const demoTasks = [
    ['Morgenbriefing vorbereiten', 'Kalender, offene Antworten und Fokusblöcke sammeln.', 'Demo'],
    ['Kundenunterlagen prüfen', 'Neue Dateien erkennen, zusammenfassen und Rückfragen markieren.', 'Demo'],
    ['Follow-up erinnern', 'Nach Meetings Aufgaben und wartende Antworten sichtbar machen.', 'Demo'],
  ]
  return (
    <div className="workspace-system">
      <header className="workspace-system-hero">
        <div>
          <p>Aufgaben</p>
          <h2>Demo-Abläufe vorbereitet</h2>
          <span>Kurze Platzhalter, damit der Reiter sofort lesbar ist und später echte Routinen aufnehmen kann.</span>
        </div>
        <button type="button" title="Aufgabe vormerken">
          <Plus className="h-4 w-4" />
        </button>
      </header>

      <div className="workspace-system-strip">
        <section>
          <span>Status</span>
          <strong>Demo</strong>
          <em>noch nicht aktiv</em>
        </section>
        <section>
          <span>Auslöser</span>
          <strong>3</strong>
          <em>vorbereitet</em>
        </section>
        <section>
          <span>Prüfung</span>
          <strong>0</strong>
          <em>keine offenen Freigaben</em>
        </section>
      </div>

      <div className="workspace-system-main workspace-system-stack">
        <section className="workspace-system-panel">
          <div className="workspace-system-panel-head">
            <div>
              <Activity className="h-4 w-4" />
              <strong>Aufgaben</strong>
            </div>
            <span>später</span>
          </div>
          <div className="workspace-system-list">
            {demoTasks.map(([title, text, status]) => (
              <article key={title} className="workspace-system-row is-neutral">
                <span />
                <div>
                  <strong>{title}</strong>
                  <em>{text}</em>
                </div>
                <aside>
                  <b>{status}</b>
                  <i>nicht aktiv</i>
                </aside>
              </article>
            ))}
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
            <article className="workspace-system-row is-ok">
              <span />
              <div>
                <strong>Freigabe bleibt Pflicht</strong>
                <em>Alles mit Außenwirkung wartet auf Christians klares Ja.</em>
              </div>
              <aside><ShieldCheck className="h-4 w-4" /></aside>
            </article>
            <article className="workspace-system-row is-neutral">
              <span />
              <div>
                <strong>Zeitplan später</strong>
                <em>Trigger laufen erst, wenn echte Daten und gewünschter Rhythmus gesetzt sind.</em>
              </div>
              <aside><Clock3 className="h-4 w-4" /></aside>
            </article>
          </div>
        </section>
      </div>
    </div>
  )
}
