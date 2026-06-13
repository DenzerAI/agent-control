import { CheckCircle2, Play } from 'lucide-react'

export function KanbanMock() {
  const columns = [
    ['Offen', 'Briefing verdichten', 'Rechnung prüfen', 'Lead einordnen'],
    ['Läuft', 'Website Preview', 'Agent Kanban skizzieren'],
    ['Fertig', 'Chat bleibt aktiv', 'Workspace Overlay'],
  ]
  return (
    <div className="workspace-kanban">
      {columns.map(([title, ...items]) => (
        <section key={title}>
          <h3>{title}</h3>
          {items.map(item => (
            <button key={item} type="button">
              <span>{item}</span>
              <CheckCircle2 className="h-4 w-4" />
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}

export function AgentsMock() {
  const agents = [
    ['Agent', 'denkt mit', 82],
    ['Research', 'sammelt Quellen', 56],
    ['Builder', 'setzt um', 68],
    ['Wächter', 'prüft Leerlauf', 34],
  ] as const
  return (
    <div className="workspace-agents">
      {agents.map(([name, status, progress]) => (
        <section key={name}>
          <div>
            <strong>{name}</strong>
            <span>{status}</span>
          </div>
          <Play className="h-4 w-4" />
          <div className="workspace-progress"><span style={{ width: `${progress}%` }} /></div>
        </section>
      ))}
    </div>
  )
}
