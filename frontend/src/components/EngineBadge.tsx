// EngineBadge — kleines monochromes Icon pro LLM-Engine.
// Nutzt currentColor, also via text-Klasse einfärbbar.

export type EngineId = 'claude' | 'codex' | 'qwen' | 'openai'

const TITLES: Record<EngineId, string> = {
  claude: 'Claude',
  codex: 'Codex / GPT',
  qwen: 'Qwen (lokal)',
  openai: 'OpenAI',
}

// Marken-SVGs sind „filled" und wirken neben Lucide-Stroke-Icons schnell zu schwer.
// Wir rendern sie deshalb mit etwas Innenabstand: das Logo nimmt ~80% des
// Containers ein und sitzt zentriert, sodass es visuell mit den Stroke-Icons
// in derselben Zeile harmoniert.
const MASK_SIZE = '80%'

export function EngineBadge({
  engine,
  size,
  className = '',
}: {
  engine: EngineId
  size?: number
  className?: string
}) {
  const url = `/engines/${engine}.svg`
  const style: React.CSSProperties = {
    WebkitMaskImage: `url(${url})`,
    maskImage: `url(${url})`,
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    WebkitMaskSize: MASK_SIZE,
    maskSize: MASK_SIZE,
    backgroundColor: 'currentColor',
  }
  if (size != null) { style.width = size; style.height = size }
  return (
    <span
      role="img"
      aria-label={TITLES[engine]}
      title={TITLES[engine]}
      className={`inline-block flex-shrink-0 ${className}`}
      style={style}
    />
  )
}
