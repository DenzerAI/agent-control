import { SettingsPanel } from '../components/SettingsPanel'

export function SettingsWorkspace() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[var(--t1)]">
      <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-[var(--t3)]">Settings</div>
            <h2 className="truncate text-base font-medium leading-6 text-[var(--t1)]">Einstellungen</h2>
            <div className="truncate text-xs text-[var(--t3)]">Theme, Stimme, Engine und Tool-Anzeige</div>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <section className="workspace-settings-surface">
          <SettingsPanel agent="main" variant="cards" />
        </section>
      </main>
    </div>
  )
}
