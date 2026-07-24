import type http from 'node:http'
import fs from 'node:fs'
import {
  getSessionCount, getCurrentIndex, switchSession,
  listSessions, getBackendSnapshot, restoreBackendSnapshot,
  createDesktopProvider,
} from './llm/provider.js'
import { OrionAgent, costTracker } from '@orion/engine'
import { sseEvent } from './sse.js'
import { clone, ENV_PATH } from './config.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackendSnapshot {
  llmNo: number
  history: string[]
  // The LLM session histories are stored as opaque arrays for restore.
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

function createAgent(llmNo = 0): OrionAgent {
  const provider = createDesktopProvider(ENV_PATH)
  if (!provider) {
    throw new Error(
      'No LLM configuration found. Please configure your API key in Settings.'
    )
  }
  const next = new OrionAgent({ llmProvider: provider })
  next.verbose = false
  // Switch to the requested LLM index if valid
  if (llmNo > 0 && llmNo < getSessionCount()) {
    switchSession(llmNo)
  }
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
    llmNo: getCurrentIndex(),
    history: [...current.history],
    sessionHistories: getBackendSnapshot(),
  }
}

export function restoreSnapshot(snapshot: BackendSnapshot): OrionAgent {
  const next = createAgent(snapshot.llmNo)
  next.history = [...(snapshot.history || [])]
  if (snapshot.sessionHistories.length) {
    restoreBackendSnapshot(snapshot.sessionHistories)
  }
  return next
}

export function rebuildAgent(snapshot?: BackendSnapshot | null): void {
  try {
    if (snapshot) {
      agent = restoreSnapshot(snapshot)
    } else {
      const llmNo = getCurrentIndex()
      agent = createAgent(llmNo)
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

export class SseChatFrontend {
  label = 'Desktop'
  source = 'desktop'
  splitLimit = 2000
  private agent: OrionAgent
  private cb: (event: string, data: string) => void

  constructor(agent: OrionAgent, cb: (event: string, data: string) => void) {
    this.agent = agent
    this.cb = cb
  }

  async sendText(_chatId: string, content: string): Promise<void> {
    this.cb('text', JSON.stringify({ delta: content }))
  }

  async sendDone(_chatId: string, rawText: string): Promise<void> {
    const text = this.buildDoneText(rawText)
    this.cb('done', JSON.stringify({ text }))
  }

  splitText(text: string, limit: number): string[] {
    text = (text || '').trim() || '...'
    const parts: string[] = []
    while (text.length > limit) {
      let cut = text.lastIndexOf('\n', limit)
      if (cut < limit * 0.6) cut = limit
      parts.push(text.slice(0, cut).trimEnd())
      text = text.slice(cut).trimStart()
    }
    if (text) parts.push(text)
    return parts.length ? parts : ['...']
  }

  private buildDoneText(rawText: string): string {
    const files = this.extractFiles(rawText).filter((p: string) => {
      try { return fs.existsSync(p) } catch { return false }
    })
    let body = this.stripFiles(this.cleanReply(rawText))
    if (files.length) {
      body = (body ? body + '\n\n' : '') + files.map((p: string) => `生成文件: ${p}`).join('\n')
    }
    return body || '...'
  }

  private cleanReply(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n').trim() || '...'
  }

  private extractFiles(text: string): string[] {
    return [...(text || '').matchAll(/\[FILE:([^\]]+)\]/g)].map((m) => m[1])
  }

  private stripFiles(text: string): string {
    return (text || '').replace(/\[FILE:[^\]]+\]/g, '').trim()
  }

  /** Slash command handler (subset of the old AgentChatMixin commands). */
  async handleCommand(chatId: string, cmd: string): Promise<void> {
    const parts = (cmd || '').split(/\s+/)
    const op = (parts[0] || '').toLowerCase()

    if (op === '/help') {
      const helpText = `📖 命令列表:
/help - 显示帮助
/status - 查看状态
/stop - 停止当前任务
/llm - 查看当前模型列表
/llm [n] - 切换到第 n 个模型
/cost - 查看本次 token 消耗`
      return this.sendText(chatId, helpText)
    }

    if (op === '/stop') {
      this.agent.abort()
      return this.sendText(chatId, '⏹️ 正在停止...')
    }

    if (op === '/status') {
      const llm = this.agent.llmName
      return this.sendText(chatId, `状态: ${this.agent.isRunning ? '🔴 运行中' : '🟢 空闲'}\nLLM: ${llm}`)
    }

    if (op === '/llm') {
      if (parts.length > 1) {
        const idx = parseInt(parts[1], 10)
        const name = switchSession(idx)
        return this.sendText(chatId, `✅ 已切换到 [${idx}] ${name}`)
      }
      const llms = listSessions()
      return this.sendText(chatId, `LLMs:\n${llms}`)
    }

    if (op === '/cost') {
      return this.sendText(chatId, costTracker.formatCostReport('main'))
    }

    return this.sendText(chatId, '📖 命令列表:\n/help /status /stop /llm /cost')
  }
}
