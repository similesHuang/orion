export type Role = 'user' | 'assistant' | 'system'
export type StatusKind = 'booting' | 'ready' | 'error' | 'busy'

export interface TimelineStep {
  id: string
  toolName: string
  turn: number
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  resultSummary?: string
}

export type RenderUnit =
  | { kind: 'text'; content: string }
  | { kind: 'thought'; content: string }
  | { kind: 'tool'; step: TimelineStep }

export interface UiMessage {
  id: string
  role: Role
  text: string
  thoughts: string[]
  units: RenderUnit[]
  createdAt: number
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
  gitBranch: string | null
  updatedAt: number
}

export interface ChatSession {
  id: string
  title: string
  messages: UiMessage[]
  draft: string
  updatedAt: number
  backendState: BackendSnapshot | null
  projectId: string | null
}

export interface UiState {
  projects: Project[]
  sessions: ChatSession[]
  activeSessionId: string | null
  expandedProjectIds: string[]
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
  projectRoot: string
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
    envPath: string
    envExists: boolean
    envExamplePath: string
    envExampleExists: boolean
  }
  gateways: GatewayDiagnostic[]
}

export interface SettingsPayload {
  env: Record<string, string>
  mykey: Record<string, unknown>
  diagnostics: DiagnosticsPayload
}

export interface SettingsState {
  open: boolean
  loading: boolean
  saving: boolean
  dirty: boolean
  error: string
  env: Record<string, string>
  mykey: Record<string, unknown>
  diagnostics: DiagnosticsPayload | null
}

export interface FieldSpec {
  scope: 'env' | 'mykey'
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
