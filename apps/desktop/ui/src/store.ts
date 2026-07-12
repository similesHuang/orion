import { STORAGE_KEY } from './constants'
import { createSession, sanitizeMessage, sessionPreview } from './utils'
import type { BackendSnapshot, ChatSession, Project, RenderUnit, Role, TimelineStep, UiMessage, UiState } from './types'

export type ChatAction =
  | { type: 'init'; state: UiState }
  | { type: 'addMessage'; sessionId: string; role: Role; text: string; extras?: Partial<UiMessage> }
  | { type: 'updateMessage'; sessionId: string; id: string; patch: Partial<UiMessage> }
  | { type: 'appendText'; sessionId: string; id: string; delta: string }
  | { type: 'appendThought'; sessionId: string; id: string; delta: string }
  | { type: 'addToolUnit'; sessionId: string; id: string; step: TimelineStep }
  | { type: 'updateToolUnit'; sessionId: string; messageId: string; id: string; patch: Partial<TimelineStep> }
  | { type: 'setDraft'; sessionId: string; draft: string }
  | { type: 'setBackendState'; sessionId: string; backendState: BackendSnapshot | null }
  | { type: 'touchSession'; sessionId: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'createSession'; title?: string; projectId?: string | null }
  | { type: 'renameCurrent'; title: string }
  | { type: 'deleteCurrent' }
  | { type: 'resetCurrent' }
  | { type: 'createProject'; project: Project }
  | { type: 'deleteProject'; projectId: string }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'setProjectGitBranch'; projectId: string; gitBranch: string | null }
  | { type: 'bindCurrentProject'; projectId: string }
  | { type: 'unbindCurrentProject' }
  | { type: 'toggleExpandProject'; projectId: string }

export function currentSession(state: UiState): ChatSession {
  if (!state.sessions.length) {
    const session = createSession()
    state.sessions.push(session)
    state.activeSessionId = session.id
    return session
  }
  const found = state.sessions.find((session) => session.id === state.activeSessionId)
  if (found) return found
  state.activeSessionId = state.sessions[0].id
  return state.sessions[0]
}

function mapSession(state: UiState, sessionId: string, fn: (session: ChatSession) => ChatSession): UiState {
  return {
    ...state,
    sessions: state.sessions.map((session) => (session.id === sessionId ? fn(session) : session)),
  }
}

function mapProject(state: UiState, projectId: string, fn: (project: Project) => Project): UiState {
  return {
    ...state,
    projects: state.projects.map((project) => (project.id === projectId ? fn(project) : project)),
  }
}

function touch(session: ChatSession): ChatSession {
  return { ...session, updatedAt: Date.now() }
}

export function chatReducer(state: UiState, action: ChatAction): UiState {
  switch (action.type) {
    case 'init':
      return action.state

    case 'addMessage': {
      const message: UiMessage = {
        id: action.extras?.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: action.role,
        text: action.text,
        thoughts: action.extras?.thoughts ?? [],
        units: action.extras?.units ?? [],
        createdAt: action.extras?.createdAt ?? Date.now(),
      }
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          messages: [...session.messages, message].slice(-200),
        })
      )
    }

    case 'updateMessage':
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          messages: session.messages.map((message) => {
            if (message.id !== action.id) return message
            return { ...message, ...action.patch }
          }),
        })
      )

    case 'appendText':
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          messages: session.messages.map((message) =>
            message.id === action.id
              ? { ...message, text: message.text + action.delta, units: appendUnitText(message.units, action.delta) }
              : message
          ),
        })
      )

    case 'appendThought':
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          messages: session.messages.map((message) => {
            if (message.id !== action.id) return message
            const { units, thoughts } = appendUnitThought(message.units, message.thoughts, action.delta)
            return { ...message, thoughts, units }
          }),
        })
      )

    case 'addToolUnit':
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          messages: session.messages.map((message) =>
            message.id === action.id
              ? { ...message, units: [...message.units, { kind: 'tool', step: action.step }] }
              : message
          ),
        })
      )

    case 'updateToolUnit':
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          messages: session.messages.map((message) =>
            message.id === action.messageId
              ? {
                  ...message,
                  units: updateToolUnit(message.units, action.id, (step) => {
                    const finishedAt = action.patch.finishedAt ?? Date.now()
                    return {
                      ...action.patch,
                      finishedAt,
                      durationMs: finishedAt - step.startedAt,
                    }
                  }),
                }
              : message
          ),
        })
      )

    case 'setDraft':
      return mapSession(state, action.sessionId, (session) => touch({ ...session, draft: action.draft }))

    case 'setBackendState':
      return mapSession(state, action.sessionId, (session) =>
        touch({ ...session, backendState: action.backendState })
      )

    case 'touchSession':
      return mapSession(state, action.sessionId, touch)

    case 'switchSession':
      return { ...state, activeSessionId: action.sessionId }

    case 'createSession': {
      const session = createSession(action.title ?? `新会话 ${state.sessions.length + 1}`, action.projectId ?? null)
      return {
        ...state,
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
      }
    }

    case 'renameCurrent': {
      const session = currentSession(state)
      return mapSession(state, session.id, (item) =>
        touch({ ...item, title: action.title.trim() || item.title })
      )
    }

    case 'deleteCurrent': {
      const session = currentSession(state)
      const remaining = state.sessions.filter((item) => item.id !== session.id)
      if (!remaining.length) remaining.push(createSession())
      return {
        ...state,
        sessions: remaining,
        activeSessionId: remaining[0].id,
      }
    }

    case 'resetCurrent': {
      const session = currentSession(state)
      return mapSession(state, session.id, (item) =>
        touch({
          ...item,
          messages: [],
          draft: '',
          backendState: null,
        })
      )
    }

    case 'createProject': {
      return {
        ...state,
        projects: [action.project, ...state.projects],
        expandedProjectIds: [...state.expandedProjectIds, action.project.id],
      }
    }

    case 'deleteProject': {
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== action.projectId),
        sessions: state.sessions.map((session) =>
          session.projectId === action.projectId ? { ...session, projectId: null } : session
        ),
        expandedProjectIds: state.expandedProjectIds.filter((id) => id !== action.projectId),
      }
    }

    case 'renameProject':
      return mapProject(state, action.projectId, (project) =>
        touchProject({ ...project, name: action.name.trim() || project.name })
      )

    case 'setProjectGitBranch':
      return mapProject(state, action.projectId, (project) =>
        touchProject({ ...project, gitBranch: action.gitBranch })
      )

    case 'bindCurrentProject': {
      const session = currentSession(state)
      return mapSession(state, session.id, (item) => touch({ ...item, projectId: action.projectId }))
    }

    case 'unbindCurrentProject': {
      const session = currentSession(state)
      return mapSession(state, session.id, (item) => touch({ ...item, projectId: null }))
    }

    case 'toggleExpandProject': {
      const expanded = new Set(state.expandedProjectIds)
      if (expanded.has(action.projectId)) {
        expanded.delete(action.projectId)
      } else {
        expanded.add(action.projectId)
      }
      return { ...state, expandedProjectIds: [...expanded] }
    }

    default:
      return state
  }
}

function appendUnitText(units: RenderUnit[], delta: string): RenderUnit[] {
  if (!delta) return units
  const last = units[units.length - 1]
  if (last && last.kind === 'text') {
    return [...units.slice(0, -1), { kind: 'text' as const, content: last.content + delta }]
  }
  return [...units, { kind: 'text' as const, content: delta }]
}

function appendUnitThought(
  units: RenderUnit[],
  thoughts: string[],
  delta: string
): { units: RenderUnit[]; thoughts: string[] } {
  if (!delta) return { units, thoughts }
  const lastUnit = units[units.length - 1]
  const nextUnits: RenderUnit[] =
    lastUnit && lastUnit.kind === 'thought'
      ? [...units.slice(0, -1), { kind: 'thought' as const, content: lastUnit.content + delta }]
      : [...units, { kind: 'thought' as const, content: delta }]
  const lastThought = thoughts[thoughts.length - 1]
  const nextThoughts =
    lastThought !== undefined
      ? [...thoughts.slice(0, -1), lastThought + delta]
      : [...thoughts, delta]
  return { units: nextUnits, thoughts: nextThoughts }
}

function updateToolUnit(
  units: RenderUnit[],
  id: string,
  patch: Partial<TimelineStep> | ((step: TimelineStep) => Partial<TimelineStep>)
): RenderUnit[] {
  return units.map((unit) => {
    if (unit.kind !== 'tool' || unit.step.id !== id) return unit
    const resolved = typeof patch === 'function' ? patch(unit.step) : patch
    return { kind: 'tool', step: { ...unit.step, ...resolved } }
  })
}

function touchProject(project: Project): Project {
  return { ...project, updatedAt: Date.now() }
}

function normalizeSession(session: unknown): ChatSession {
  const cast = session as Partial<ChatSession>
  return {
    id: cast.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: cast.title || '未命名会话',
    messages: Array.isArray(cast.messages) ? cast.messages.slice(-200).map(sanitizeMessage) : [],
    draft: typeof cast.draft === 'string' ? cast.draft : '',
    updatedAt: typeof cast.updatedAt === 'number' ? cast.updatedAt : Date.now(),
    backendState: cast.backendState ?? null,
    projectId: typeof cast.projectId === 'string' ? cast.projectId : null,
  }
}

function normalizeProject(project: unknown): Project | null {
  const cast = project as Partial<Project>
  if (!cast.id || typeof cast.path !== 'string') return null
  return {
    id: cast.id,
    name: cast.name || cast.path.split(/[\\/]/).filter(Boolean).pop() || 'project',
    path: cast.path,
    gitBranch: cast.gitBranch ?? null,
    updatedAt: typeof cast.updatedAt === 'number' ? cast.updatedAt : Date.now(),
  }
}

export function loadState(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) throw new Error('empty')
    const parsed = JSON.parse(raw) as Partial<UiState> & {
      messages?: UiMessage[]
      draft?: string
    }

    if (Array.isArray(parsed.sessions)) {
      return {
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.map(normalizeProject).filter((project): project is Project => project !== null)
          : [],
        sessions: parsed.sessions.map(normalizeSession),
        activeSessionId:
          typeof parsed.activeSessionId === 'string'
            ? parsed.activeSessionId
            : parsed.sessions[0]?.id ?? null,
        expandedProjectIds: Array.isArray(parsed.expandedProjectIds)
          ? parsed.expandedProjectIds.filter((id): id is string => typeof id === 'string')
          : [],
      }
    }

    if (Array.isArray(parsed.messages)) {
      const migrated = createSession('迁移会话')
      migrated.messages = parsed.messages.slice(-200).map(sanitizeMessage)
      migrated.draft = typeof parsed.draft === 'string' ? parsed.draft : ''
      return { projects: [], sessions: [migrated], activeSessionId: migrated.id, expandedProjectIds: [] }
    }
  } catch {
    // ignore and fall back
  }

  const initial = createSession()
  return { projects: [], sessions: [initial], activeSessionId: initial.id, expandedProjectIds: [] }
}

let saveTimer: number | null = null

export function saveState(state: UiState): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  saveTimer = null
}

export function maybeUpdateSessionTitle(session: ChatSession, text: string): ChatSession {
  if (!session.title.startsWith('新会话') && !session.title.startsWith('迁移会话')) return session
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 18)
  if (!title) return session
  return { ...session, title, updatedAt: Date.now() }
}

export { sessionPreview }
