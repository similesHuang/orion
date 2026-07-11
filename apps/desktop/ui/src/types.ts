export type Role = 'user' | 'assistant' | 'system'
export type StatusKind = 'booting' | 'ready' | 'error' | 'busy'

export interface TimelineStep {
  id: string
  toolName: string
  title: string
  argsPreview: string
  turn: number
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  resultSummary?: string
}

export interface TimelineState {
  requestId: string
  running: boolean
  turn: number
  startedAt: number
  updatedAt: number
  steps: TimelineStep[]
}

export interface UiMessage {
  id: string
  role: Role
  text: string
  createdAt: number
  timeline?: TimelineState | null
}

export interface LlmOption {
  idx: number
  label: string
  current: boolean
}

export interface BackendSnapshot {
  llmNo: number
  history: string[]
  sessionHistories: unknown[][]
}

export interface Project {
  id: string
  name: string
  path: string
  gitBranch?: string | null
  createdAt: number
  updatedAt: number
}

export interface ChatSession {
  id: string
  title: string
  projectId: string | null
  messages: UiMessage[]
  draft: string
  pendingFiles: string[]
  updatedAt: number
  backendState: BackendSnapshot | null
}

export interface UiState {
  version: number
  projects: Project[]
  sessions: ChatSession[]
  activeProjectId: string | null
  activeSessionId: string | null
}

export interface GatewayDiagnostic {
  id: string
  label: string
  portKey: string | null
  portValue: string | null
  configured: boolean
  requiredMissing: string[]
  allowedUsers: string[]
}

export interface DiagnosticsPayload {
  pid: number
  nodeVersion: string
  cwd: string
  globalRoot: string
  workspaceRoot: string
  settingsPath: string
  sidecarPort: number
  activeRequests: number
  agent: {
    ready: boolean
    issue: string | null
    llmIndex: number | null
    llmName: string | null
    llms: string[]
  }
  files: {
    settingsPath: string
    settingsExists: boolean
  }
  gateways: GatewayDiagnostic[]
}

export interface SettingsPayload {
  settings: Record<string, unknown>
  diagnostics: DiagnosticsPayload
}

export interface SettingsState {
  open: boolean
  loading: boolean
  saving: boolean
  dirty: boolean
  error: string
  settings: Record<string, unknown>
  diagnostics: DiagnosticsPayload | null
}

export interface FieldSpec {
  scope: 'settings'
  key: string
  label: string
  placeholder?: string
  secret?: boolean
  multiline?: boolean
  hint?: string
}

export interface GatewayUiSpec {
  id: string
  label: string
  description: string
  fields: FieldSpec[]
}
