// Zentrale Registry für Slash-Commands. Quelle der Wahrheit für
// die Autocomplete-Liste im Composer und die Handler im ChatPane.
// Wer einen neuen Command einführt, trägt ihn hier ein — sonst nirgends.

export type SlashEngine = 'all' | 'codex' | 'claude'

export interface SlashCommand {
  cmd: string
  label: string
  hint?: string
  engines?: SlashEngine
  /** Wenn true, taucht er nicht in der Autocomplete-Liste auf, ist aber als
   * getippter Command weiterhin akzeptiert. Für versteckte Power-Befehle. */
  hidden?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/new', label: 'Neue Session', engines: 'all' },
  { cmd: '/stop', label: 'Agent stoppen', engines: 'all' },
  { cmd: '/model', label: 'Model wechseln', hint: '<name>', engines: 'all' },
  { cmd: '/consult', label: 'Zweitmeinung sichtbar holen', hint: '[claude|codex] <frage>', engines: 'all' },
  { cmd: '/dual', label: 'Dual-Modus schalten', hint: '[on|off]', engines: 'all' },
  { cmd: '/goal', label: 'Ziel iterativ verfolgen', hint: '<beschreibung>', engines: 'claude' },
  { cmd: '/jobs', label: 'Job-Läufe der letzten 24h', engines: 'all' },
  { cmd: '/memory', label: 'Notiz ins Gedächtnis speichern', hint: '<text>', engines: 'claude' },
  { cmd: '/thinking', label: 'Thinking-Level setzen', hint: 'off|low|medium|high|adaptive', engines: 'claude', hidden: true },
  { cmd: '/tasks', label: 'Tagesplan zeigen', engines: 'claude', hidden: true },
  { cmd: '/flow', label: 'Flow-Übersicht', engines: 'claude', hidden: true },
]

export function matchEngine(cmd: SlashCommand, isCodex: boolean): boolean {
  const e = cmd.engines || 'all'
  return e === 'all' || (e === 'codex' && isCodex) || (e === 'claude' && !isCodex)
}
