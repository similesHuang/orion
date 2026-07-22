import type http from 'node:http'
import crypto from 'node:crypto'
import { AgentYield, buildDoneText, costTracker, GenericAgent, HELP_COMMANDS } from '@orion/core'
import { sseEvent, json } from './sse.js'
import {
  readEnvConfig,
  readMykeyConfig,
  writeEnvConfig,
  writeMykeyConfig,
  hydrateProcessEnv,
  buildDiagnostics,
  buildSettingsPayload,
  present,
  resolveWorkingDir,
  Dict,
} from './config.js'
import {
  agent,
  agentIssue,
  getAgent,
  rebuildAgent,
  buildEmptySnapshot,
  exportSnapshot,
  restoreSnapshot,
  stopActiveTasks,
  resolveAllPending,
  pendingApprovals,
  approvalResolvers,
  SseChatFrontend,
  BackendSnapshot,
  ActiveRequestState,
  ActiveRequestMap,
} from './agent-manager.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUERY_LENGTH = 100_000

/** Tools that must be approved by the user before running. Everything else auto-allows. */
const HIGH_RISK_TOOLS = new Set(['code_run', 'file_write', 'file_patch'])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolApprovalEnabled(): boolean {
  // On by default; users disable via ORION_TOOL_APPROVAL=false in settings/.env.
  const raw = (process.env.ORION_TOOL_APPROVAL ?? readEnvConfig().ORION_TOOL_APPROVAL ?? '').toLowerCase()
  return raw !== 'false' && raw !== '0' && raw !== 'off'
}

function buildPrompt(q: string): string {
  if (q.length > MAX_QUERY_LENGTH) {
    q = q.slice(0, MAX_QUERY_LENGTH) + '\n...[查询过长，已截断]'
  }
  return q
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  if (!chunks.length) return null
  const text = Buffer.concat(chunks).toString('utf-8').trim()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`
    throw new Error(message, { cause: error })
  }
}

function summarizeToolResult(toolName: string, content: unknown): string {
  const prefix = `[${toolName}] `
  if (content == null) return prefix

  // Prefer structured fields when available; tool handlers normally return objects.
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (toolName === 'code_run') {
      const msg = typeof obj.msg === 'string' ? obj.msg.trim() : ''
      const stdout = typeof obj.stdout === 'string' ? obj.stdout : ''
      // When exit_code is null the command never actually ran (disabled shell,
      // unsupported type, spawn failure). Surface the handler's msg instead of
      // a bare "exit=?" that hides the real reason.
      if (obj.exit_code == null) {
        return `${prefix}${msg || (obj.status === 'error' ? '执行失败（命令未运行）' : '命令未产生退出码')}`
      }
      const summary = stdout.length > 200 ? `${stdout.slice(0, 200)} ...` : stdout
      const tail = summary || msg
      return `${prefix}exit=${obj.exit_code}${tail ? ` ${tail}` : ''}`
    }
    if (toolName === 'file_write' || toolName === 'file_patch') {
      const bytes = typeof obj.writed_bytes === 'number' ? obj.writed_bytes : '?'
      return `${prefix}${bytes} bytes`
    }
    const raw = JSON.stringify(content)
    return raw.length > 240 ? `${prefix}${raw.slice(0, 240)}...` : `${prefix}${raw}`
  }

  if (typeof content === 'string') {
    const clean = content.replace(/\s+/g, ' ').trim()
    if (!clean) return prefix
    if (/^error[:\s]/i.test(clean)) return `${prefix}${clean.slice(0, 240)}`
    if (toolName === 'file_read') {
      const MAX_PREVIEW_CHARS = 4000
      const rawLines = content.split('\n')
      const lines = rawLines.length
      if (content.length <= MAX_PREVIEW_CHARS) {
        return `${prefix}${lines} lines\n${content}`
      }
      let preview = content.slice(0, MAX_PREVIEW_CHARS)
      const lastNewline = preview.lastIndexOf('\n')
      if (lastNewline > 0) {
        preview = preview.slice(0, lastNewline)
      }
      const shownLines = preview.split('\n').length
      return `${prefix}${lines} lines\n${preview}\n... (${lines - shownLines} more lines, ${content.length - preview.length} chars omitted)`
    }
    return clean.length > 240 ? `${prefix}${clean.slice(0, 240)}...` : `${prefix}${clean}`
  }

  if (typeof content === 'number' || typeof content === 'boolean') return `${prefix}${String(content)}`
  return `${prefix}${String(content)}`
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function handleRoot(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors })
  res.end('Orion desktop sidecar is running.')
}

export function handleDiagnostics(res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap): void {
  json(res, 200, buildDiagnostics(activeRequests.size, agent, agentIssue), cors)
}

export function handleSettingsGet(res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap): void {
  json(res, 200, buildSettingsPayload(activeRequests.size, agent, agentIssue), cors)
}

export function handleSettingsPost(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap): void {
  void (async () => {
    try {
      const payload = (await readJsonBody(req)) as { env?: Dict<string>; mykey?: Dict<unknown> } | null
      const env = payload?.env && typeof payload.env === 'object' ? payload.env : {}
      const mykey = payload?.mykey && typeof payload.mykey === 'object' ? payload.mykey : {}
      const snapshot = exportSnapshot(agent)

      // MERGE with the on-disk config rather than overwrite. A partial
      // payload (e.g. when the panel only ever loaded some fields) must
      // never wipe keys it didn't include — that once erased LLM config.
      const mergedEnv: Dict<string> = { ...readEnvConfig() }
      for (const [key, value] of Object.entries(env)) mergedEnv[key] = String(value ?? '')
      const mergedMykey: Dict<unknown> = { ...readMykeyConfig(), ...mykey }

      stopActiveTasks(activeRequests)
      writeEnvConfig(mergedEnv)
      writeMykeyConfig(mergedMykey)
      hydrateProcessEnv()
      rebuildAgent(snapshot)

      json(res, 200, buildSettingsPayload(activeRequests.size, agent, agentIssue), cors)
    } catch (error) {
      json(
        res,
        400,
        { error: error instanceof Error ? error.message : String(error) },
        cors
      )
    }
  })()
}

export function handleLlms(res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  try {
    const current = getAgent()
    const options = current
      .listLlms()
      .split('\n')
      .map((line, idx) => ({ idx, label: line, current: idx === current.llmNo }))
    json(res, 200, options, cors)
  } catch (error) {
    json(res, 503, { error: error instanceof Error ? error.message : String(error) }, cors)
  }
}

export function handleCost(res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  try {
    const stats = costTracker.getTracker('main')
    const inputSide = stats.input + stats.cacheCreate + stats.cacheRead
    json(
      res,
      200,
      {
        requests: stats.requests,
        inputTokens: inputSide,
        outputTokens: stats.output,
        totalTokens: costTracker.totalTokens(stats),
        cacheHitRate: costTracker.cacheHitRate(stats),
        elapsedSeconds: costTracker.elapsedSeconds(stats),
      },
      cors
    )
  } catch (error) {
    json(res, 200, { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitRate: 0, elapsedSeconds: 0, error: error instanceof Error ? error.message : String(error) }, cors)
  }
}

export function handleCommands(res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  json(res, 200, HELP_COMMANDS.map(([command, description]) => ({ command, description })), cors)
}

export function handleLlmSwitch(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders, url: URL): void {
  try {
    const current = getAgent()
    const idx = Number.parseInt(url.pathname.split('/').pop() || '', 10)
    current.nextLlm(idx)
    json(res, 200, { ok: true, current: current.llmNo }, cors)
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
  }
}

export function handleReinject(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  try {
    const current = getAgent()
    const backend = current.client.backend as unknown as Dict<unknown>
    backend.lastTools = ''
    json(res, 200, { ok: true }, cors)
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
  }
}

export function handleStop(res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap): void {
  stopActiveTasks(activeRequests)
  json(res, 200, { ok: true }, cors)
}

export function handleApprove(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  void (async () => {
    try {
      const payload = (await readJsonBody(req)) as
        | { requestId?: string; approvalId?: string; decision?: string; remember?: boolean }
        | null
      const requestId = payload?.requestId || ''
      const approvalId = payload?.approvalId || ''
      const decision = payload?.decision === 'deny' ? 'deny' : 'allow'
      const remember = !!payload?.remember
      const resolver = approvalResolvers.get(requestId)
      const ok = resolver ? resolver(approvalId, decision, remember) : false
      json(res, 200, { ok }, cors)
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
    }
  })()
}

export function handleSessionExport(res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  json(res, 200, exportSnapshot(agent), cors)
}

export function handleSessionReset(res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap): void {
  const snapshot = exportSnapshot(agent)
  stopActiveTasks(activeRequests)
  rebuildAgent({ ...buildEmptySnapshot(), llmNo: snapshot.llmNo })
  json(res, 200, { ok: true, current: agent?.llmNo ?? 0 }, cors)
}

export function handleSessionImport(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap): void {
  void (async () => {
    try {
      const payload = (await readJsonBody(req)) as BackendSnapshot | null
      stopActiveTasks(activeRequests)
      if (payload) rebuildAgent(payload)
      else rebuildAgent()
      json(res, 200, { ok: true, current: agent?.llmNo ?? 0 }, cors)
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
    }
  })()
}

export function handleChat(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders, activeRequests: ActiveRequestMap, url: URL): void {
  let current: GenericAgent
  try {
    current = getAgent()
  } catch (error) {
    json(res, 503, { error: error instanceof Error ? error.message : String(error) }, cors)
    return
  }

  const q = url.searchParams.get('q') || ''

  let targetCwd: string
  try {
    const rawCwd = url.searchParams.get('cwd')
    targetCwd = resolveWorkingDir(rawCwd)
    console.log(`[Desktop] /chat cwd: ${targetCwd}`)
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
    return
  }

  const originalSnapshot = exportSnapshot(current)
  const requestAgent = restoreSnapshot(originalSnapshot, targetCwd)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...cors,
  })

  const requestId = crypto.randomUUID()
  const requestState: ActiveRequestState = { running: true }
  const runningStepIds = new Map<string, string>()

  activeRequests.set(requestId, { res, state: { ...requestState, agent: requestAgent } })

  req.on('close', () => {
    requestState.running = false
    activeRequests.delete(requestId)
    // Unblock any tool waiting on approval so the agent loop can unwind.
    resolveAllPending(requestId, 'deny')
  })

  const emit = (eventName: string, data: string) => {
    sseEvent(res, eventName, data)
  }

  // Tool approval gate. High-risk tools pause here and wait for the UI to
  // POST /api/approve; low-risk tools and the disabled setting auto-allow.
  // "allow for this session" is tracked per request via sessionAllowed.
  const sessionAllowed = new Set<string>()
  requestAgent.approveToolCall = async (toolName, args) => {
    if (!requestState.running) return 'deny'
    if (!toolApprovalEnabled()) return 'allow'
    if (!HIGH_RISK_TOOLS.has(toolName)) return 'allow'
    if (sessionAllowed.has(toolName)) return 'allow'

    const approvalId = crypto.randomUUID()
    return await new Promise<'allow' | 'deny'>((resolve) => {
      let forReq = pendingApprovals.get(requestId)
      if (!forReq) {
        forReq = new Map()
        pendingApprovals.set(requestId, forReq)
      }
      forReq.set(approvalId, {
        toolName,
        resolve: (decision) => {
          forReq!.delete(approvalId)
          resolve(decision)
        },
      })
      emit(
        'tool_approval',
        JSON.stringify({ requestId, approvalId, toolName, args: args ?? {} })
      )
    })
  }
  // Bridge the /api/approve endpoint to this request's waiters.
  approvalResolvers.set(requestId, (approvalId, decision, remember) => {
    const waiter = pendingApprovals.get(requestId)?.get(approvalId)
    if (!waiter) return false
    if (remember && decision === 'allow') sessionAllowed.add(waiter.toolName)
    waiter.resolve(decision)
    return true
  })

  // Keep-alive to prevent UI from timing out during long tool calls
  const pingInterval = setInterval(() => {
    try {
      res.write(':ping\n\n')
    } catch {
      clearInterval(pingInterval)
    }
  }, 30000)

  void (async () => {
    let fullText = ''
    const frontend = new SseChatFrontend(requestAgent, (eventName, data) => {
      emit(eventName, data)
    })

    const consumeYield = (y: AgentYield) => {
      switch (y.kind) {
        case 'text':
          fullText += y.content
          emit('text', JSON.stringify({ delta: y.content }))
          break
        case 'thought':
          emit('thought', JSON.stringify({ delta: y.content }))
          break
        case 'tool_call':
          runningStepIds.set(y.id, y.toolName)
          emit('tool_call', JSON.stringify({ id: y.id, turn: y.turn, toolName: y.toolName, args: y.args }))
          break
        case 'tool_result':
          {
            const toolName = runningStepIds.get(y.id) || 'tool'
            runningStepIds.delete(y.id)
            emit('tool_result', JSON.stringify({ id: y.id, status: y.status, summary: summarizeToolResult(toolName, y.content) }))
          }
          break
        case 'error':
          emit('error', JSON.stringify({ message: y.message }))
          break
      }
    }

    try {
      if (q.startsWith('/')) {
        await frontend.handleCommand(requestId, q)
        emit('done', JSON.stringify({ text: buildDoneText(fullText) }))
        return
      }

      const prompt = buildPrompt(q)
      const queue = requestAgent.putTask(prompt, 'desktop', targetCwd)

      let lastError = ''
      let idleTicks = 0
      while (requestState.running) {
        const item = await queue.get(true, 3)
        if (!item) {
          // No output for a tick. If the agent has stopped running and the
          // queue has drained, the task ended without pushing a terminal
          // 'done' (e.g. an error path that only yielded 'error'). Close the
          // stream ourselves so the UI never spins forever.
          if (!requestAgent.isRunning) {
            idleTicks += 1
            if (idleTicks >= 2) {
              emit('done', JSON.stringify({ text: fullText || lastError || '任务已结束' }))
              break
            }
          }
          continue
        }
        idleTicks = 0
        if (item.next) {
          if (item.next.kind === 'error') lastError = item.next.message
          consumeYield(item.next)
        }
        if (item.done) {
          fullText = item.done
          emit('done', JSON.stringify({ text: item.done }))
          break
        }
      }
    } catch (error) {
      const message = `❌ ${error instanceof Error ? error.message : String(error)}`
      emit('error', JSON.stringify({ message }))
      emit('done', JSON.stringify({ text: fullText || message }))
    } finally {
      clearInterval(pingInterval)
      activeRequests.delete(requestId)
      resolveAllPending(requestId, 'deny')
      res.end()
      // Sync any session history changes back to the global agent only when idle
      if (activeRequests.size === 0) {
        rebuildAgent(exportSnapshot(requestAgent))
      }
    }
  })()
}
