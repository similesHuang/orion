import type http from 'node:http'
import { AgentChatMixin, buildDoneText } from '@orion/core'
import { OrionAgent } from '@orion/engine'
import { sseEvent } from './sse.js'
import { clone } from './config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackendSnapshot {
  llmNo: number
  history: string[]
  sessionHistories: unknown[][]
}

export interface ActiveRequestState {
  running: boolean
  agent?: OrionAgent
}

export interface ActiveRequestEntry {
  res: http.ServerResponse
  state: ActiveRequestState
}

export type ActiveRequestMap = Map<string, ActiveRequestEntry>

export interface PendingApproval {
  toolName: string
  resolve: (decision: 'allow' | 'deny') => void
}

export type ApprovalResolver = (approvalId: string, decision: 'allow' | 'deny', remember: boolean) => boolean

// ---------------------------------------------------------------------------
// Module-level agent state
// ---------------------------------------------------------------------------

export let agent: OrionAgent | null = null
export let agentIssue: string | null = null

/** Per-request approval waiters, keyed by requestId then a per-call approvalId. */
export const pendingApprovals = new Map<string, Map<string, PendingApproval>>()

/** Per-request bridge so /api/approve can resolve a specific waiter. */
export const approvalResolvers = new Map<string, ApprovalResolver>()

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

function createAgent(llmNo = 0, cwd?: string): OrionAgent {
  const next = new OrionAgent(cwd ? { cwd } : undefined)
  next.verbose = false
  if (llmNo > 0) next.nextLlm(llmNo)
  return next
}

export function buildEmptySnapshot(): BackendSnapshot {
  return {
    llmNo: 0,
    history: [],
    sessionHistories: [],
  }
}

export function exportSnapshot(current: OrionAgent | null): BackendSnapshot {
  if (!current) return buildEmptySnapshot()
  return {
    llmNo: current.llmNo,
    history: [...current.history],
    sessionHistories: current.sessions.map((session) => clone(session.history)),
  }
}

export function restoreSnapshot(snapshot: BackendSnapshot, cwd?: string): OrionAgent {
  const next = createAgent(snapshot.llmNo, cwd)
  next.history = [...(snapshot.history || [])]
  snapshot.sessionHistories.forEach((history, idx) => {
    const session = next.sessions[idx]
    if (session) {
      session.history = clone(history) as typeof session.history
    }
  })
  if (next.sessions[next.llmNo]) {
    next.client.backend.history = next.sessions[next.llmNo].history
  }
  return next
}

export function rebuildAgent(snapshot?: BackendSnapshot | null, cwd?: string): void {
  try {
    if (snapshot) {
      agent = restoreSnapshot(snapshot, cwd)
    } else {
      const llmNo = agent?.llmNo ?? 0
      agent = createAgent(llmNo, cwd)
    }
    agentIssue = null
  } catch (error) {
    agent = null
    agentIssue = error instanceof Error ? error.message : String(error)
  }
}

export function getAgent(): OrionAgent {
  if (!agent) {
    throw new Error(agentIssue || 'Agent unavailable')
  }
  return agent
}

// ---------------------------------------------------------------------------
// Approval / task management
// ---------------------------------------------------------------------------

export function resolveAllPending(requestId: string, decision: 'allow' | 'deny'): void {
  const forReq = pendingApprovals.get(requestId)
  if (forReq) {
    for (const p of forReq.values()) p.resolve(decision)
    pendingApprovals.delete(requestId)
  }
  approvalResolvers.delete(requestId)
}

export function stopActiveTasks(activeRequests: ActiveRequestMap): void {
  if (agent) agent.abort()
  // Release any tools blocked on approval so aborting can actually unwind them.
  for (const requestId of [...pendingApprovals.keys(), ...approvalResolvers.keys()]) {
    resolveAllPending(requestId, 'deny')
  }
  for (const { res, state } of activeRequests.values()) {
    state.running = false
    state.agent?.abort()
    try {
      sseEvent(res, 'stop', JSON.stringify({ reason: 'user_stop' }))
    } catch {
      // ignore emit errors on closing responses
    }
  }
}

// ---------------------------------------------------------------------------
// SSE chat frontend
// ---------------------------------------------------------------------------

export class SseChatFrontend extends AgentChatMixin {
  label = 'Desktop'
  source = 'desktop'
  splitLimit = 2000
  private cb: (event: string, data: string) => void

  constructor(agent: OrionAgent, cb: (event: string, data: string) => void) {
    super(agent, new Map())
    this.cb = cb
  }

  async sendText(_chatId: string, content: string): Promise<void> {
    this.cb('text', JSON.stringify({ delta: content }))
  }

  async sendDone(_chatId: string, rawText: string): Promise<void> {
    this.cb('done', JSON.stringify({ text: buildDoneText(rawText) }))
  }
}
