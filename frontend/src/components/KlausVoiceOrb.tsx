import type { CSSProperties } from 'react'
import type { VoiceState } from './voiceState'

// KlausVoiceOrb — Agent' eigenes Gesicht als Voice-Indikator. Der Kreis ist sein
// Kopf, die fuenf Pillen sind seine Augen. Geometrie 1:1 aus public/agent.svg.
//
// Sobald Voice live ist, wird der ganze Kopf Terracotta und die Augen weiss —
// das Signal "Agent ist wach". Die Zustaende traegt dann Farbe UND Bewegung,
// damit man sie auch bei 50px sofort auseinanderhaelt:
//   listening  — ruhiger, langsamer Atem + Idle-Persoenlichkeit (schweben,
//                gucken, blinzeln). Auf Desktop schlagen die Augen live mit
//                Christians Mikro-Pegel aus (--voice-input-level).
//   speaking   — heller Kopf, schnelles Pumpen der Augen UND ein sichtbarer
//                Puls des ganzen Kopfes (reden).
//   thinking   — teal, Welle laeuft durch die Augen (verarbeiten).
//   paused     — grauer Kopf, Augen als zwei ruhende Balken, alles steht still.
//   connecting — grauer Kopf, dunkle Augen, dezenter Puls (noch nicht wach).
//
// Reduced-Motion wird hier bewusst NICHT respektiert: die Bewegung ist das
// Kernsignal des Voice-Modus auf Christians eigenem Geraet, kein Deko-Effekt.
// Transform-Ebenen sind getrennt (eine Achse pro <g>), damit Puls, Schweben,
// Gucken, Blinzeln und Atmung nicht um dieselbe Achse konkurrieren.

type OrbState = 'connecting' | 'thinking' | 'speaking' | 'listening' | 'paused'

function orbState(v: VoiceState): OrbState {
  if (v.phase === 'connecting' || v.phase === 'init') return 'connecting'
  if (v.isPaused) return 'paused'
  if (v.isThinking) return 'thinking'
  if (v.isSpeaking) return 'speaking'
  return 'listening'
}

// x-Positionen und Ruhehoehen der fuenf Pillen aus klaus.svg.
const PILLS = [
  { x: 49, y: 71, h: 58, delay: 0.0 },
  { x: 71, y: 59, h: 82, delay: 0.16 },
  { x: 93, y: 48, h: 104, delay: 0.32 },
  { x: 115, y: 59, h: 82, delay: 0.48 },
  { x: 137, y: 71, h: 58, delay: 0.64 },
]

export default function KlausVoiceOrb({ state, size = 46 }: { state: VoiceState; size?: number }) {
  const st = orbState(state)
  return (
    <span style={{ display: 'inline-flex', width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 200 200" width={size} height={size} className={`kvo kvo--${st}`}>
        <style>{`
          /* Kopf: grau im Standby/Pause, Terracotta sobald wach, heller beim Reden. */
          .kvo .kvo-bg { fill: #E6E6E3; transition: fill .3s ease; }
          .kvo--listening .kvo-bg { fill: #d97757; }
          .kvo--speaking  .kvo-bg { fill: #e8896d; }
          .kvo--thinking  .kvo-bg { fill: #3f9b91; }
          .kvo--paused    .kvo-bg { fill: #9a9a96; }

          /* Ganzkörper-Puls: nur beim Reden, und gut sichtbar auch klein. */
          .kvo .kvo-pulse { transform-box: fill-box; transform-origin: center; }
          .kvo--speaking .kvo-pulse { animation: kvo-pulse 0.62s ease-in-out infinite; }
          @keyframes kvo-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.075); } }

          /* Schweben / Gucken / Blinzeln — Idle-Persoenlichkeit beim Zuhoeren. */
          .kvo .kvo-float, .kvo .kvo-sway, .kvo .kvo-blink {
            transform-box: fill-box; transform-origin: center;
          }
          .kvo--listening .kvo-float { animation: kvo-fl 5.2s ease-in-out infinite; }
          .kvo--listening .kvo-sway  { animation: kvo-sw 9s   ease-in-out infinite; }
          .kvo--listening .kvo-blink { animation: kvo-bl 5.2s ease-in-out infinite; }
          @keyframes kvo-fl { 0%,100% { transform: translate(0,0); } 50% { transform: translate(0,-11px); } }
          @keyframes kvo-sw { 0%,100% { transform: translate(0,0); } 25% { transform: translate(13px,0); } 75% { transform: translate(-13px,0); } }
          @keyframes kvo-bl { 0%,68% { transform: scaleY(1); } 72% { transform: scaleY(0.06); } 76%,100% { transform: scaleY(1); } }

          /* Mic-Level-Hub (Desktop). Neutral wenn Level 0 (Mobile/still). */
          .kvo .kvo-lvl {
            transform-box: fill-box; transform-origin: center;
            transform: scaleY(1); transition: transform 0.07s linear;
          }
          .kvo--listening .kvo-lvl { transform: scaleY(calc(1 + var(--voice-input-level, 0) * 1.6)); }

          /* Augen-Atmung pro Pille. */
          .kvo .kvo-pill {
            transform-box: fill-box; transform-origin: center;
            fill: #1F1F1E;
            animation: kvo-br var(--dur, 3s) ease-in-out var(--delay, 0s) infinite;
          }
          @keyframes kvo-br { 0%,100% { transform: scaleY(1); } 50% { transform: scaleY(var(--amp, 0.85)); } }

          /* Augen weiss sobald wach. */
          .kvo--listening .kvo-pill,
          .kvo--speaking  .kvo-pill,
          .kvo--thinking  .kvo-pill,
          .kvo--paused    .kvo-pill { fill: #FBFBF9; }

          .kvo--listening  .kvo-pill { --amp: 0.60; --dur: 2.8s; }
          .kvo--speaking   .kvo-pill { --amp: 0.22; --dur: 0.42s; }
          .kvo--thinking   .kvo-pill { --amp: 0.45; --dur: 0.95s; }
          .kvo--connecting .kvo-pill { fill: #8a8a86; --amp: 0.62; --dur: 1.3s; }
          /* Pause: Augen stehen still, leicht gedimmt — sichtbares "ich warte". */
          .kvo--paused     .kvo-pill { fill: #ECECE8; --amp: 1; animation: none; }
        `}</style>
        <g className="kvo-pulse">
          <circle className="kvo-bg" cx="100" cy="100" r="92" />
          <g className="kvo-float">
            <g className="kvo-sway">
              <g className="kvo-blink">
                {PILLS.map((p, i) => (
                  <g key={i} className="kvo-lvl">
                    <rect
                      className="kvo-pill"
                      style={{ '--delay': `${p.delay}s` } as CSSProperties}
                      x={p.x}
                      y={p.y}
                      width={14}
                      height={p.h}
                      rx={7}
                    />
                  </g>
                ))}
              </g>
            </g>
          </g>
        </g>
      </svg>
    </span>
  )
}
