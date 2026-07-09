import { MAX_ATTACHMENTS, STORAGE_KEY } from './constants'
import { cloneTimeline, createSession, sanitizeMessage, sessionPreview } from './utils'
import type { BackendSnapshot, ChatSession, Role, UiMessage, UiState } from './types'

export type ChatAction =
  | { type: 'init'; sessions: ChatSession[]; activeSessionId: string | null }
  | { type: 'addMessage'; sessionId: string; role: Role; text: string; extras?: Partial<UiMessage> }
  | { type: 'updateMessage'; sessionId: string; id: string; patch: Partial<UiMessage> }
  | { type: 'setDraft'; sessionId: string; draft: string }
  | { type: 'setPendingFiles'; sessionId: string; files: string[] }
  | { type: 'addPendingFiles'; sessionId: string; paths: string[] }
  | { type: 'removePendingFile'; sessionId: string; index: number }
  | { type: 'clearPendingFiles'; sessionId: string }
  | { type: 'setBackendState'; sessionId: string; backendState: BackendSnapshot | null }
  | { type: 'touchSession'; sessionId: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'createSession'; title?: string }
  | { type: 'renameCurrent'; title: string }
  | { type: 'deleteCurrent' }
  | { type: 'resetCurrent' }

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

function touch(session: ChatSession): ChatSession {
  return { ...session, updatedAt: Date.now() }
}

export function chatReducer(state: UiState, action: ChatAction): UiState {
  switch (action.type) {
    case 'init':
      return {
        sessions: action.sessions,
        activeSessionId: action.activeSessionId,
      }

    case 'addMessage': {
      const message: UiMessage = {
        id: action.extras?.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: action.role,
        text: action.text,
        createdAt: action.extras?.createdAt ?? Date.now(),
        timeline: cloneTimeline(action.extras?.timeline),
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
            return {
              ...message,
              text: action.patch.text ?? message.text,
              timeline: action.patch.timeline !== undefined ? cloneTimeline(action.patch.timeline) : message.timeline,
            }
          }),
        })
      )

    case 'setDraft':
      return mapSession(state, action.sessionId, (session) => touch({ ...session, draft: action.draft }))

    case 'setPendingFiles':
      return mapSession(state, action.sessionId, (session) => touch({ ...session, pendingFiles: action.files }))

    case 'addPendingFiles': {
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          pendingFiles: [
            ...session.pendingFiles,
            ...action.paths.filter((path) => !session.pendingFiles.includes(path)),
          ].slice(0, MAX_ATTACHMENTS),
        })
      )
    }

    case 'removePendingFile':
      return mapSession(state, action.sessionId, (session) =>
        touch({
          ...session,
          pendingFiles: session.pendingFiles.filter((_, index) => index !== action.index),
        })
      )

    case 'clearPendingFiles':
      return mapSession(state, action.sessionId, (session) => touch({ ...session, pendingFiles: [] }))

    case 'setBackendState':
      return mapSession(state, action.sessionId, (session) =>
        touch({ ...session, backendState: action.backendState })
      )

    case 'touchSession':
      return mapSession(state, action.sessionId, touch)

    case 'switchSession':
      return { ...state, activeSessionId: action.sessionId }

    case 'createSession': {
      const session = createSession(action.title ?? `新会话 ${state.sessions.length + 1}`)
      return {
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
          pendingFiles: [],
          backendState: null,
        })
      )
    }

    default:
      return state
  }
}

export function loadState(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) throw new Error('empty')
    const parsed = JSON.parse(raw) as Partial<UiState> & {
      messages?: UiMessage[]
      draft?: string
      pendingFiles?: string[]
    }

    if (Array.isArray(parsed.sessions) && parsed.sessions.length) {
      return {
        sessions: parsed.sessions.map((session) => ({
          id: session.id || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: session.title || '未命名会话',
          messages: Array.isArray(session.messages)
            ? session.messages.slice(-200).map(sanitizeMessage)
            : [],
          draft: typeof session.draft === 'string' ? session.draft : '',
          pendingFiles: Array.isArray(session.pendingFiles)
            ? session.pendingFiles.filter((item): item is string => typeof item === 'string')
            : [],
          updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
          backendState: session.backendState ?? null,
        })),
        activeSessionId:
          typeof parsed.activeSessionId === 'string'
            ? parsed.activeSessionId
            : parsed.sessions[0]?.id ?? null,
      }
    }

    if (Array.isArray(parsed.messages)) {
      const migrated = createSession('迁移会话')
      migrated.messages = parsed.messages.slice(-200).map(sanitizeMessage)
      migrated.draft = typeof parsed.draft === 'string' ? parsed.draft : ''
      migrated.pendingFiles = Array.isArray(parsed.pendingFiles)
        ? parsed.pendingFiles.filter((item): item is string => typeof item === 'string')
        : []
      return { sessions: [migrated], activeSessionId: migrated.id }
    }
  } catch {
    // ignore and fall back
  }

  const initial = createSession()
  return { sessions: [initial], activeSessionId: initial.id }
}

export function saveState(state: UiState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function maybeUpdateSessionTitle(session: ChatSession, text: string): ChatSession {
  if (!session.title.startsWith('新会话') && !session.title.startsWith('迁移会话')) return session
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 18)
  if (!title) return session
  return { ...session, title, updatedAt: Date.now() }
}

export { sessionPreview }
