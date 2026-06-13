export interface CronJob {
  id: string; name: string; enabled: boolean; schedule: string; model: string
  lastStatus: string; lastRunStatus?: string; lastRunAt: number; lastDurationMs: number; nextRunAt: number
  consecutiveErrors: number; lastError: string; message: string
  lastOutputPath: string; lastOutputTs: number
  source?: 'local'
  promptPath?: string
  category?: string
  manifest?: {
    status?: string
    coverage?: number
    missing?: string[]
    warnings?: string[]
    security?: { status?: string; issueCount?: number }
  }
  governance?: {
    status?: string
    openCount?: number
    checks?: { status?: string; code?: string; message?: string }[]
  }
}
