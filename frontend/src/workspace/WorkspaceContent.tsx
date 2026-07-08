import type { WorkspaceFile, WorkspaceMode } from './types'
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

export function WorkspaceContent({
  mode,
  file,
  filesystemPath,
  onClose,
  onOpenFile,
  onRevealPath,
}: {
  mode: WorkspaceMode
  file?: WorkspaceFile | null
  filesystemPath?: string | null
  onClose: () => void
  onOpenFile: (path: string) => boolean
  onRevealPath: (path: string) => void
  onModeChange?: (mode: WorkspaceMode) => void
}) {
  return (
    <>
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
    </>
  )
}
