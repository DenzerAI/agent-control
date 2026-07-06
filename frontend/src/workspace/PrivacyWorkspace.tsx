import { BadgeCheck, CircleDashed, Database, EyeOff, FileCheck2, FileText, LockKeyhole, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { WorkspaceShell } from './WorkspaceShell'

type ProofStatus = 'ok' | 'open'

type ProofItem = {
  title: string
  text: string
  status: ProofStatus
  icon: LucideIcon
}

const SCORE = 82

const proofs: ProofItem[] = [
  {
    title: 'PII-Schwärzung aktiv',
    text: 'Namen, Telefonnummern, E-Mails und andere personenbezogene Daten werden vor externer Verarbeitung durch Platzhalter ersetzt.',
    status: 'ok',
    icon: EyeOff,
  },
  {
    title: 'Daten lokal gespeichert',
    text: 'Kundendaten bleiben zuerst auf dem eigenen System. Nur vorbereitete, geschützte Ausschnitte verlassen den lokalen Bereich.',
    status: 'ok',
    icon: Database,
  },
  {
    title: 'Auftragsverarbeitung dokumentiert',
    text: 'Die wichtigsten Dienstleister und Datenflüsse sind als Nachweis vorbereitet und können später mit echten Verträgen verknüpft werden.',
    status: 'ok',
    icon: FileCheck2,
  },
  {
    title: 'Löschfristen hinterlegt',
    text: 'Regeln für Aufbewahrung und Löschung sind fachlich vorgesehen. Die echte technische Verdrahtung folgt im nächsten Schritt.',
    status: 'open',
    icon: CircleDashed,
  },
]

const protectedAreas = [
  {
    title: 'Kontaktdaten',
    text: 'Telefonnummern, E-Mail-Adressen und Namen werden im Demo-Beispiel unkenntlich gemacht, bevor ein Text weiterverarbeitet wird.',
  },
  {
    title: 'Nachweise',
    text: 'Der Reiter zeigt, welche Datenschutzpunkte erfüllt sind und wo noch ein echter Beleg oder Vertrag fehlt.',
  },
  {
    title: 'Arbeitsprotokolle',
    text: 'Später kann das Modul sichtbar machen, was der Agent getan hat, ohne sensible Inhalte im Klartext zu zeigen.',
  },
]

function ProofRow({ item }: { item: ProofItem }) {
  const Icon = item.icon
  const ok = item.status === 'ok'
  return (
    <article className={`workspace-system-row is-${ok ? 'ok' : 'warn'} privacy-proof-row`}>
      <span />
      <div>
        <strong>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
          {item.title}
        </strong>
        <em>{item.text}</em>
      </div>
      <aside>
        <b>{ok ? 'erfüllt' : 'offen'}</b>
        <i>{ok ? 'belegt' : 'später verdrahten'}</i>
      </aside>
    </article>
  )
}

export function PrivacyWorkspace() {
  return (
    <WorkspaceShell
      eyebrow="Datenschutz"
      title="DSGVO-Schutzstatus"
      subtitle="Demo-Modul mit Score, Nachweisen und verständlicher PII-Schwärzung. Noch nicht verdrahtet, aber inhaltlich nach dem internen Datenschutz-Vorbild aufgebaut."
    >
      <div className="workspace-system-main workspace-system-stack privacy-workspace">
        <section className="workspace-system-panel privacy-score-panel">
          <div className="privacy-score-ring" style={{ '--privacy-score': `${SCORE}%` } as CSSProperties}>
            <div>
              <strong>{SCORE}%</strong>
              <span>konform</span>
            </div>
          </div>
          <div className="privacy-score-copy">
            <div className="workspace-system-panel-head">
              <div>
                <ShieldCheck className="h-4 w-4" />
                <strong>Datenschutz-Score</strong>
              </div>
              <span>Demo-Wert</span>
            </div>
            <p>
              Der Kunde sieht auf einen Blick, wie gut das System vorbereitet ist: Schutz aktiv, Nachweise vorhanden und offene Punkte klar benannt.
            </p>
            <div className="privacy-progress" aria-label={`${SCORE} Prozent konform`}>
              <span style={{ width: `${SCORE}%` }} />
            </div>
          </div>
        </section>

        <section className="workspace-system-panel">
          <div className="workspace-system-panel-head">
            <div>
              <BadgeCheck className="h-4 w-4" />
              <strong>Prüfpunkte und Nachweise</strong>
            </div>
            <span>4 Punkte</span>
          </div>
          <div className="workspace-system-list">
            {proofs.map(item => <ProofRow key={item.title} item={item} />)}
          </div>
        </section>

        <section className="workspace-system-panel">
          <div className="workspace-system-panel-head">
            <div>
              <LockKeyhole className="h-4 w-4" />
              <strong>Was wird geschützt</strong>
            </div>
            <span>laienverständlich</span>
          </div>
          <div className="privacy-protected-list">
            {protectedAreas.map(area => (
              <article key={area.title}>
                <strong>{area.title}</strong>
                <p>{area.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="workspace-system-panel">
          <div className="workspace-system-panel-head">
            <div>
              <FileText className="h-4 w-4" />
              <strong>PII-Schwärzung als Beispiel</strong>
            </div>
            <span>Vorher / Nachher</span>
          </div>
          <div className="privacy-redaction-demo">
            <article>
              <span>Vorher</span>
              <p>Bitte ruf Max Müller unter 0176 12345678 an und schick den Vertrag an max.mueller@example.de.</p>
            </article>
            <article>
              <span>Nachher</span>
              <p>Bitte ruf [NAME] unter [TELEFON] an und schick den Vertrag an [E-MAIL].</p>
            </article>
          </div>
          <p className="privacy-footnote">
            Die Platzhalter bleiben für den Agenten verständlich, aber echte personenbezogene Daten stehen nicht mehr im Text.
          </p>
        </section>
      </div>
    </WorkspaceShell>
  )
}
