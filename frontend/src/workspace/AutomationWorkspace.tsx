import { Activity, Clock3, Plus, ShieldCheck } from 'lucide-react'
import { WorkspaceShell } from './WorkspaceShell'

export function AutomationWorkspace() {
  const demoTasks = [
    ['WhatsApp beantworten', 'Offene Chat-Antworten erkennen und als Entwurf vorbereiten.', 'Demo'],
    ['Firmengedächtnis-Interview', 'Wissenslücken sammeln und als geführte Fragen sichtbar machen.', 'Demo'],
    ['Termine erinnern', 'Kalendertermine mit Kontext und Vorlauf in den Fokus holen.', 'Demo'],
  ]
  return (
    <WorkspaceShell
      eyebrow="Aufgaben"
      title="Demo-Abläufe vorbereitet"
      subtitle="Kurze Platzhalter, damit der Reiter sofort lesbar ist und später echte Routinen aufnehmen kann."
      action={
        <button type="button" title="Aufgabe vormerken">
          <Plus className="h-4 w-4" />
        </button>
      }
    >

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
    </WorkspaceShell>
  )
}
