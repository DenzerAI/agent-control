import { ArrowLeft, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import type { WorkspaceFile, WorkspaceMode, WorkspaceSpan } from './types'
import { WorkspaceNav, workspaceModeLabel } from './WorkspaceNav'
import { PreviewPane } from './PreviewPane'
import { DocumentPane } from './DocumentPane'
import { WorkspaceHome } from './WorkspaceHome'
import { AgentWorkspace } from './AgentWorkspace'
import { HealthWorkspace } from './HealthWorkspace'
import { LimitsWorkspace } from './LimitsWorkspace'
import { SystemagentWorkspace } from './SystemagentWorkspace'
import { ChatagentWorkspace } from './ChatagentWorkspace'
import { AutomationWorkspace } from './AutomationWorkspace'
import { LoopWorkspace } from './LoopWorkspace'
import { PioniereWorkspace } from './PioniereWorkspace'
import { YouTubeWorkspace } from './YouTubeWorkspace'
import { SocialWorkspace } from './SocialWorkspace'
import { AnalyticsWorkspace } from './AnalyticsWorkspace'
import { InvoiceWorkspace } from './InvoiceWorkspace'
import { FinanceWorkspace } from './FinanceWorkspace'
import { PeopleWorkspace } from './PeopleWorkspace'
import { SkillsWorkspace } from './SkillsWorkspace'
import { EnginesWorkspace } from './EnginesWorkspace'
import { InboxWorkspace } from './InboxWorkspace'
import { CompanyMemoryWorkspace } from './CompanyMemoryWorkspace'
import { ArtifactsWorkspace } from './ArtifactsWorkspace'
import { RadarWorkspace } from './RadarWorkspace'
import { IdeasWorkspace } from './IdeasWorkspace'
import { CalendarWorkspace } from './CalendarWorkspace'
import { PipelineWorkspace } from './WorkspacePipeline'
import { ProjectsWorkspace } from './ProjectsWorkspace'
import { SettingsWorkspace } from './SettingsWorkspace'
import { AgentKanbanWorkspace } from './AgentKanbanWorkspace'
import { PrivacyWorkspace } from './PrivacyWorkspace'
import { ConnectorsWorkspace } from './ConnectorsWorkspace'

// Workspace als permanente linke Spalte: die schmale Nav-Rail ersetzt die alte
// InfoPane. Ein Klick öffnet den Body rechts daneben, der
// die Chats schmaler schiebt. Erneuter Klick auf den aktiven Reiter schließt ihn.
export function WorkspaceOverlay({ open, mode, returnMode, span, collapsed, file, filesystemPath, onClose, onModeChange, onBack, onToggleCollapsed, onOpenFile, onRevealPath, onOpenSearch }: {
  open: boolean
  mode: WorkspaceMode
  returnMode?: WorkspaceMode | null
  span: WorkspaceSpan
  collapsed: boolean
  file?: WorkspaceFile | null
  filesystemPath?: string | null
  onClose: () => void
  onModeChange: (mode: WorkspaceMode) => void
  onBack?: () => void
  onToggleCollapsed: () => void
  onOpenFile: (path: string) => boolean
  onRevealPath: (path: string) => void
  onOpenSearch?: () => void
}) {
  return (
    <aside className={`workspace-dock workspace-span-${span}${open ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`} aria-label="Workspace">
      <div className="workspace-rail">
        <div className="workspace-rail-head">
          <img className="workspace-rail-logo" src="/agent-control-logo.png" alt="Agent Control" draggable={false} />
        </div>
        <WorkspaceNav mode={mode} collapsed={collapsed} onModeChange={onModeChange} />
        <div className="workspace-rail-top">
          <button
            type="button"
            className="workspace-rail-tool workspace-rail-collapse"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Menü ausklappen' : 'Menü einklappen'}
          >
            {collapsed ? <PanelLeftOpen className="h-[14px] w-[14px]" /> : <PanelLeftClose className="h-[14px] w-[14px]" />}
          </button>
          {onOpenSearch && (
            <button type="button" className="workspace-rail-tool" onClick={onOpenSearch} title="Suchen">
              <Search className="h-[14px] w-[14px]" />
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="workspace-panel">
          {returnMode && mode !== returnMode && onBack && (
            <div className="workspace-topbar workspace-topbar-backonly">
              <div className="workspace-title-group">
                <button
                  type="button"
                  className="workspace-back"
                  onClick={onBack}
                  title={`Zurück zu ${workspaceModeLabel(returnMode || 'artifacts')}`}
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span>{workspaceModeLabel(returnMode || 'artifacts')}</span>
                </button>
              </div>
            </div>
          )}

          <div className="workspace-body">
            {mode === 'preview' && <PreviewPane file={file?.kind === 'html' ? file : null} onRevealPath={onRevealPath} />}
            {mode === 'document' && <DocumentPane file={file?.kind === 'markdown' ? file : null} onRevealPath={onRevealPath} />}
            {mode === 'filesystem' && <WorkspaceHome onOpenFile={onOpenFile} onClose={onClose} onRevealPath={onRevealPath} path={filesystemPath} filePath={file && file.kind !== 'html' ? file.path : null} />}
            {mode === 'agent' && <AgentWorkspace />}
            {mode === 'knowledge' && <CompanyMemoryWorkspace />}
            {mode === 'tasks' && <AutomationWorkspace />}
            {mode === 'connectors' && <ConnectorsWorkspace />}
            {mode === 'health' && <HealthWorkspace />}
            {mode === 'limits' && <LimitsWorkspace />}
            {mode === 'systemagent' && <SystemagentWorkspace />}
            {mode === 'chatagent' && <ChatagentWorkspace />}
            {mode === 'loops' && <LoopWorkspace initialView="werkbank" lockedView />}
            {mode === 'offers' && <LoopWorkspace initialView="offers" lockedView />}
            {mode === 'pionierplaner' && <PioniereWorkspace />}
            {mode === 'youtube' && <YouTubeWorkspace />}
            {mode === 'social' && <SocialWorkspace />}
            {mode === 'analytics' && <AnalyticsWorkspace />}
            {mode === 'invoice' && <InvoiceWorkspace />}
            {mode === 'finance' && <FinanceWorkspace />}
            {mode === 'people' && <PeopleWorkspace />}
            {mode === 'skills' && <SkillsWorkspace />}
            {mode === 'engines' && <EnginesWorkspace />}
            {mode === 'inbox' && <InboxWorkspace />}
            {mode === 'artifacts' && <ArtifactsWorkspace />}
            {mode === 'radar' && <RadarWorkspace />}
            {mode === 'ideas' && <IdeasWorkspace />}
            {mode === 'calendar' && <CalendarWorkspace />}
            {mode === 'privacy' && <PrivacyWorkspace />}
            {mode === 'settings' && <SettingsWorkspace />}
            {mode === 'kanban' && <AgentKanbanWorkspace />}
            {mode === 'pipeline' && <PipelineWorkspace />}
            {mode === 'projects' && <ProjectsWorkspace />}
          </div>
        </div>
      )}
    </aside>
  )
}
