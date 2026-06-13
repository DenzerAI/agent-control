import { useEffect } from 'react'
import { useMainAgentName } from '../agents'

// "Agent ruft an" — pulsierendes Anruf-Overlay.
//
// Erscheint, wenn das Backend ein `voice.incoming_call`-Event broadcastet. Christian
// geht ran (startet die Voice-Session, die das Anruf-Briefing als zweite Prompt-
// Schicht zieht) oder wischt weg. Die Kontrolle bleibt bei ihm: ein Klingeln, das
// man ignorieren kann. Agent-Control-Dunkellook, Terracotta als Akzent.

export interface CallBriefing {
  teaser?: string
  anrufgrund?: string
  was_erzaehlen?: string[]
  gespraechsziel?: string
  opener?: string
}

interface Props {
  briefing: CallBriefing
  onAccept: () => void
  onDismiss: () => void
}

export function IncomingCallOverlay({ briefing, onAccept, onDismiss }: Props) {
  const agentName = useMainAgentName()
  // Esc wischt weg, Enter nimmt an — schnelle Tastatur-Bedienung am Desktop.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onDismiss() }
      else if (e.key === 'Enter') { e.preventDefault(); onAccept() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onAccept, onDismiss])

  const teaser = briefing.teaser || briefing.anrufgrund || `${agentName} möchte mit dir reden`

  return (
    <div
      className="fixed inset-0 z-[108] flex items-center justify-center"
      onClick={onDismiss}
      role="dialog"
      aria-label="Eingehender Anruf von Agent"
    >
      <div className="absolute inset-0 bg-black/65 backdrop-blur-md" />
      <div
        className="relative flex flex-col items-center gap-7 rounded-3xl px-10 py-12 text-center shadow-2xl"
        style={{
          background: '#1F1F1E',
          border: '1px solid rgba(217,119,87,0.28)',
          maxWidth: 'min(92vw, 420px)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Pulsierender Telefon-Ring */}
        <div className="relative flex h-28 w-28 items-center justify-center">
          <span className="incoming-call-ring absolute inset-0 rounded-full" />
          <span className="incoming-call-ring incoming-call-ring--delay absolute inset-0 rounded-full" />
          <span
            className="relative flex h-20 w-20 items-center justify-center rounded-full"
            style={{ background: '#D97757' }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6.5 3.5c.4 0 .76.24.9.62l1.3 3.4a.96.96 0 0 1-.24 1.02l-1.5 1.43a13 13 0 0 0 5.65 5.65l1.43-1.5a.96.96 0 0 1 1.02-.24l3.4 1.3c.38.14.62.5.62.9V20a1.5 1.5 0 0 1-1.5 1.5C10.6 21.5 2.5 13.4 2.5 5A1.5 1.5 0 0 1 4 3.5h2.5Z"
                fill="#FAF9F5"
              />
            </svg>
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <div
            className="text-xs font-semibold uppercase tracking-[0.18em]"
            style={{ color: '#D97757' }}
          >
            {agentName} ruft an
          </div>
          <div className="text-lg font-medium leading-snug" style={{ color: '#FAF9F5' }}>
            {teaser}
          </div>
        </div>

        <div className="flex items-center gap-5">
          <button
            onClick={onDismiss}
            className="flex flex-col items-center gap-2"
            aria-label="Wegwischen"
          >
            <span
              className="flex h-16 w-16 items-center justify-center rounded-full transition-transform active:scale-95"
              style={{ background: 'rgba(250,249,245,0.10)' }}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6.5 3.5c.4 0 .76.24.9.62l1.3 3.4a.96.96 0 0 1-.24 1.02l-1.5 1.43a13 13 0 0 0 5.65 5.65l1.43-1.5a.96.96 0 0 1 1.02-.24l3.4 1.3c.38.14.62.5.62.9V20a1.5 1.5 0 0 1-1.5 1.5C10.6 21.5 2.5 13.4 2.5 5A1.5 1.5 0 0 1 4 3.5h2.5Z"
                  fill="#FAF9F5"
                  transform="rotate(135 12 12)"
                />
              </svg>
            </span>
            <span className="text-xs" style={{ color: '#FAF9F5' }}>Später</span>
          </button>

          <button
            onClick={onAccept}
            className="flex flex-col items-center gap-2"
            aria-label="Rangehen"
          >
            <span
              className="incoming-call-accept flex h-16 w-16 items-center justify-center rounded-full transition-transform active:scale-95"
              style={{ background: '#3FB860' }}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M6.5 3.5c.4 0 .76.24.9.62l1.3 3.4a.96.96 0 0 1-.24 1.02l-1.5 1.43a13 13 0 0 0 5.65 5.65l1.43-1.5a.96.96 0 0 1 1.02-.24l3.4 1.3c.38.14.62.5.62.9V20a1.5 1.5 0 0 1-1.5 1.5C10.6 21.5 2.5 13.4 2.5 5A1.5 1.5 0 0 1 4 3.5h2.5Z"
                  fill="#FAF9F5"
                />
              </svg>
            </span>
            <span className="text-xs" style={{ color: '#FAF9F5' }}>Rangehen</span>
          </button>
        </div>
      </div>

      <style>{`
        @keyframes incomingCallRing {
          0% { transform: scale(0.7); opacity: 0.55; }
          100% { transform: scale(1.25); opacity: 0; }
        }
        .incoming-call-ring {
          border: 2px solid #D97757;
          animation: incomingCallRing 1.8s ease-out infinite;
        }
        .incoming-call-ring--delay { animation-delay: 0.9s; }
        @keyframes incomingCallAccept {
          0%, 100% { box-shadow: 0 0 0 0 rgba(63,184,96,0.45); }
          50% { box-shadow: 0 0 0 10px rgba(63,184,96,0); }
        }
        .incoming-call-accept { animation: incomingCallAccept 1.4s ease-out infinite; }
      `}</style>
    </div>
  )
}
