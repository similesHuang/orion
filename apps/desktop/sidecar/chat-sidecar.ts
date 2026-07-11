#!/usr/bin/env node
/** Orion desktop chat sidecar API. */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { FILE_HINT, AgentChatMixin, costTracker, ensureSingleInstance } from '@orion/chat'
import { GenericAgent, GenericAgentHandler } from '@orion/agent'
import { initStorage, getGlobalRoot, getWorkspaceRoot, globalPath, loadSettings, saveSettings, applySettingsToEnv } from '@orion/shared'

const MAX_FILE_SIZE = 1024 * 1024
const SETTINGS_PATH = () => globalPath('config', 'settings.yaml')

type Dict<T> = Record<string, T>
type TimelineStepStatus = 'running' | 'done' | 'error'

interface BackendSnapshot {
  llmNo: number
  history: string[]
  sessionHistories: unknown[][]
}

interface TimelineStep {
  id: string
  toolName: string
  title: string
  argsPreview: string
  turn: number
  status: TimelineStepStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  resultSummary?: string
}

interface TimelineState {
  requestId: string
  running: boolean
  turn: number
  startedAt: number
  updatedAt: number
  steps: TimelineStep[]
}

interface TimelineRuntime {
  activeStepId: string | null
  seq: number
  state: TimelineState
  emit: (payload: TimelineState) => void
}

interface ActiveRequestState {
  running: boolean
}

interface GatewayDiagnostic {
  id: string
  label: string
  portKey: string | null
  portValue: string | null
  configured: boolean
  requiredMissing: string[]
  allowedUsers: string[]
}

interface DiagnosticsPayload {
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

interface SettingsPayload {
  settings: Record<string, unknown>
  diagnostics: DiagnosticsPayload
}

class SseChatFrontend extends AgentChatMixin {
  label = 'Desktop'
  source = 'desktop'
  splitLimit = 2000
  private cb: (content: string) => void

  constructor(agent: GenericAgent, cb: (content: string) => void) {
    super(agent, new Map())
    this.cb = cb
  }

  async sendText(_chatId: string, content: string): Promise<void> {
    this.cb(content)
  }
}

const GATEWAY_SPECS: Array<{
  id: string
  label: string
  portKey: string | null
  requiredKeys: string[]
  allowedKey: string | null
}> = [
  { id: 'telegram', label: 'Telegram', portKey: null, requiredKeys: ['tg_bot_token'], allowedKey: 'tg_allowed_users' },
  { id: 'feishu', label: 'Feishu', portKey: 'FEISHU_PORT', requiredKeys: ['fs_app_id', 'fs_app_secret'], allowedKey: 'fs_allowed_users' },
  { id: 'wecom', label: 'WeCom', portKey: 'WECOM_PORT', requiredKeys: ['wecom_bot_id', 'wecom_secret'], allowedKey: 'wecom_allowed_users' },
  { id: 'wechat', label: 'WeChat', portKey: 'WECHAT_PORT', requiredKeys: ['wx_bot_token'], allowedKey: 'wx_allowed_users' },
  { id: 'qq', label: 'QQ', portKey: 'QQ_PORT', requiredKeys: ['qq_app_id', 'qq_app_secret'], allowedKey: 'qq_allowed_users' },
  { id: 'dingtalk', label: 'DingTalk', portKey: 'DINGTALK_PORT', requiredKeys: ['dingtalk_client_id', 'dingtalk_client_secret'], allowedKey: 'dingtalk_allowed_users' },
  { id: 'discord', label: 'Discord', portKey: null, requiredKeys: ['discord_bot_token'], allowedKey: 'discord_allowed_users' },
]

let agent: GenericAgent | null = null
let agentIssue: string | null = null
let activeTimeline: TimelineRuntime | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return String(value ?? '').trim().length > 0
}

function compactToolArgs(name: string, input: Dict<unknown>): string {
  const args = { ...input }
  delete args._index
  if ('path' in args) args.path = String(args.path).split('/').pop() || String(args.path)
  if (name === 'update_working_checkpoint') {
    const summary = String(args.key_info ?? '')
    return summary.length > 80 ? `${summary.slice(0, 80)}...` : summary
  }
  if (name === 'ask_user') {
    const question = String(args.question ?? '')
    const candidates = Array.isArray(args.candidates) ? args.candidates.map((item) => String(item)) : []
    return candidates.length ? `${question} | ${candidates.join(', ')}` : question
  }
  const raw = JSON.stringify(args)
  return raw.length > 160 ? `${raw.slice(0, 160)}...` : raw
}

function summarizeValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim()
    return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const raw = JSON.stringify(value)
    return raw.length > 180 ? `${raw.slice(0, 180)}...` : raw
  } catch {
    return String(value)
  }
}

function outcomeStatus(ret: unknown): TimelineStepStatus {
  const data =
    ret && typeof ret === 'object' && 'data' in ret
      ? (ret as { data?: unknown }).data
      : ret

  if (data && typeof data === 'object' && 'status' in data && (data as { status?: unknown }).status === 'error') {
    return 'error'
  }
  if (typeof data === 'string' && /^error[:\s]/i.test(data.trim())) {
    return 'error'
  }
  return 'done'
}

function createAgent(llmNo = 0): GenericAgent {
  const next = new GenericAgent()
  next.verbose = false
  if (llmNo > 0) next.nextLlm(llmNo)
  return next
}

function buildEmptySnapshot(): BackendSnapshot {
  return {
    llmNo: 0,
    history: [],
    sessionHistories: [],
  }
}

function exportSnapshot(current: GenericAgent | null): BackendSnapshot {
  if (!current) return buildEmptySnapshot()
  return {
    llmNo: current.llmNo,
    history: [...current.history],
    sessionHistories: current.sessions.map((session) => clone(session.history)),
  }
}

function restoreSnapshot(snapshot: BackendSnapshot): GenericAgent {
  const next = createAgent(snapshot.llmNo)
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

function rebuildAgent(snapshot?: BackendSnapshot | null): void {
  try {
    if (snapshot) {
      agent = restoreSnapshot(snapshot)
    } else {
      const llmNo = agent?.llmNo ?? 0
      agent = createAgent(llmNo)
    }
    agentIssue = null
  } catch (error) {
    agent = null
    agentIssue = error instanceof Error ? error.message : String(error)
  }
}

function getAgent(): GenericAgent {
  if (!agent) {
    throw new Error(agentIssue || 'Agent unavailable')
  }
  return agent
}

function readSettingsConfig(): Record<string, unknown> {
  try {
    return loadSettings()
  } catch {
    return {}
  }
}

function writeSettingsConfig(settings: Record<string, unknown>): void {
  saveSettings(settings)
}

function toAllowedList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function buildGatewayDiagnostics(settings: Record<string, unknown>): GatewayDiagnostic[] {
  return GATEWAY_SPECS.map((spec) => {
    const requiredMissing = spec.requiredKeys.filter((key) => !present(settings[key]))
    const allowedUsers = spec.allowedKey ? toAllowedList(settings[spec.allowedKey]) : []
    return {
      id: spec.id,
      label: spec.label,
      portKey: spec.portKey,
      portValue: spec.portKey ? String(settings[spec.portKey] || '') : null,
      configured: requiredMissing.length === 0,
      requiredMissing,
      allowedUsers,
    }
  })
}

function safeListLlms(current: GenericAgent | null): string[] {
  if (!current) return []
  try {
    return current.listLlms().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function getGitBranch(dir: string): string | null {
  try {
    const branch = execSync('git branch --show-current', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    return branch || null
  } catch {
    return null
  }
}

function buildDiagnostics(activeRequests: number): DiagnosticsPayload {
  const settings = readSettingsConfig()
  const settingsPath = SETTINGS_PATH()
  const current = agent
  return {
    pid: process.pid,
    nodeVersion: process.version,
    cwd: process.cwd(),
    globalRoot: getGlobalRoot(),
    workspaceRoot: getWorkspaceRoot(),
    settingsPath,
    sidecarPort: Number(process.env.WEB_PORT || 8502),
    activeRequests,
    agent: {
      ready: !!current,
      issue: agentIssue,
      llmIndex: current ? current.llmNo : null,
      llmName: current ? current.llmName : null,
      llms: safeListLlms(current),
    },
    files: {
      settingsPath,
      settingsExists: fs.existsSync(settingsPath),
    },
    gateways: buildGatewayDiagnostics(settings),
  }
}

function buildSettingsPayload(activeRequests: number): SettingsPayload {
  return {
    settings: readSettingsConfig(),
    diagnostics: buildDiagnostics(activeRequests),
  }
}

function readAttachment(filePath: string): string {
  try {
    const workspaceRoot = getWorkspaceRoot()
    const resolved = path.resolve(workspaceRoot, filePath)
    // Restrict attachments to files inside the workspace root to prevent LFI.
    if (!resolved.startsWith(workspaceRoot + path.sep)) {
      return `\n[附件路径超出允许范围: ${filePath}]\n`
    }
    if (!fs.existsSync(resolved)) return `\n[附件不存在: ${filePath}]\n`
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) return `\n[附件不是普通文件: ${filePath}]\n`
    if (stat.size > MAX_FILE_SIZE) return `\n[附件过大已省略: ${filePath}]\n`
    const raw = fs.readFileSync(resolved)
    if (raw.includes(0)) return `\n[二进制附件: ${filePath}]\n`
    return `\n--- ${filePath} ---\n${raw.toString('utf-8')}\n---\n`
  } catch (error) {
    return `\n[无法读取附件 ${filePath}: ${error instanceof Error ? error.message : String(error)}]\n`
  }
}

const MAX_QUERY_LENGTH = 100_000
const MAX_ATTACHMENTS = 20

function buildPrompt(q: string, files: string | null): string {
  if (q.length > MAX_QUERY_LENGTH) {
    q = q.slice(0, MAX_QUERY_LENGTH) + '\n...[查询过长，已截断]'
  }
  let prompt = q
  let paths: string[] = []
  if (files) {
    try {
      const parsed = JSON.parse(files) as unknown
      paths = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      paths = []
    }
  }
  if (paths.length > MAX_ATTACHMENTS) {
    paths = paths.slice(0, MAX_ATTACHMENTS)
  }
  if (paths.length) {
    prompt = `${FILE_HINT}\n\n${paths.map(readAttachment).join('')}\n\n${q}`
  }
  return prompt
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

function sseWrite(res: http.ServerResponse, data: string): void {
  res.write(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`)
}

function sseEvent(res: http.ServerResponse, eventName: string, data: string): void {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`)
}

function emitTimeline(runtime: TimelineRuntime): void {
  runtime.state.updatedAt = Date.now()
  runtime.emit(clone(runtime.state))
}

function finalizeTimeline(runtime: TimelineRuntime, reason?: string): void {
  const step = runtime.activeStepId
    ? runtime.state.steps.find((item) => item.id === runtime.activeStepId)
    : undefined

  if (reason && step && step.status === 'running') {
    step.status = 'error'
    step.finishedAt = Date.now()
    step.durationMs = step.finishedAt - step.startedAt
    step.resultSummary = reason
  }

  runtime.state.running = false
  runtime.activeStepId = null
  emitTimeline(runtime)
}

function applyTurnMarkers(runtime: TimelineRuntime, chunk: string): void {
  const matches = [...chunk.matchAll(/\*\*LLM Running \(Turn (\d+)\) \.\.\.\*\*/g)]
  if (!matches.length) return
  runtime.state.turn = Number(matches[matches.length - 1][1]) || runtime.state.turn
  emitTimeline(runtime)
}

function withTimelineRuntime<T>(runtime: TimelineRuntime, fn: () => Promise<T>): Promise<T> {
  const previous = activeTimeline
  activeTimeline = runtime
  emitTimeline(runtime)
  return fn().finally(() => {
    activeTimeline = previous
  })
}

function patchTimelineHooks(): void {
  const flag = globalThis as typeof globalThis & { __desktopTimelinePatched?: boolean }
  if (flag.__desktopTimelinePatched) return
  flag.__desktopTimelinePatched = true

  const originalBefore = GenericAgentHandler.prototype.toolBeforeCallback
  const originalAfter = GenericAgentHandler.prototype.toolAfterCallback

  GenericAgentHandler.prototype.toolBeforeCallback = async function patchedBefore(toolName, args, response) {
    await originalBefore.call(this, toolName, args, response)
    if (!activeTimeline) return
    if (toolName === 'no_tool') return

    const now = Date.now()
    const step: TimelineStep = {
      id: `step-${++activeTimeline.seq}`,
      toolName,
      title: toolName.replace(/_/g, ' '),
      argsPreview: compactToolArgs(toolName, args as Dict<unknown>),
      turn: this.currentTurn || activeTimeline.state.turn || 1,
      status: 'running',
      startedAt: now,
    }

    activeTimeline.state.turn = step.turn
    activeTimeline.state.steps.push(step)
    activeTimeline.activeStepId = step.id
    emitTimeline(activeTimeline)
  }

  GenericAgentHandler.prototype.toolAfterCallback = async function patchedAfter(toolName, args, response, ret) {
    await originalAfter.call(this, toolName, args, response, ret)
    if (toolName === 'no_tool') return
    const runtime = activeTimeline
    if (!runtime) return

    const step = runtime.activeStepId
      ? runtime.state.steps.find((item) => item.id === runtime.activeStepId)
      : [...runtime.state.steps].reverse().find((item) => item.toolName === toolName && item.status === 'running')

    if (!step) return
    step.status = outcomeStatus(ret)
    step.finishedAt = Date.now()
    step.durationMs = step.finishedAt - step.startedAt
    step.resultSummary = summarizeValue(
      ret && typeof ret === 'object' && 'data' in ret ? (ret as { data?: unknown }).data : ret
    )
    runtime.activeStepId = null
    emitTimeline(runtime)
  }
}

function stopActiveTasks(activeRequests: Map<string, { state: ActiveRequestState; runtime: TimelineRuntime }>): void {
  if (agent) agent.abort()
  for (const { state, runtime } of activeRequests.values()) {
    state.running = false
    finalizeTimeline(runtime, 'Stopped by user')
  }
}

function json(res: http.ServerResponse, status: number, data: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(data))
}

function getAllowedOrigin(origin: string | undefined): string | false {
  if (!origin) return false
  // Tauri production window uses tauri://localhost; dev server uses http://127.0.0.1:5173
  if (origin === 'tauri://localhost') return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
  return false
}

function corsHeaders(origin: string | undefined): http.OutgoingHttpHeaders {
  const allowed = getAllowedOrigin(origin)
  if (!allowed) return {}
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

async function main(): Promise<void> {
  initStorage({ workspaceRoot: process.env.ORION_WORKSPACE_DIR })
  applySettingsToEnv()

  if (process.env.TAURI_SIDECHAT !== '1') {
    ensureSingleInstance(19536, 'Desktop')
  }
  costTracker.install()
  patchTimelineHooks()

  rebuildAgent()

  const activeRequests = new Map<string, { res: http.ServerResponse; state: ActiveRequestState; runtime: TimelineRuntime }>()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const origin = req.headers.origin
    const cors = corsHeaders(origin)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...cors })
      res.end('Orion desktop sidecar is running.')
      return
    }

    if (url.pathname === '/api/diagnostics' && req.method === 'GET') {
      json(res, 200, buildDiagnostics(activeRequests.size), cors)
      return
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      json(res, 200, buildSettingsPayload(activeRequests.size), cors)
      return
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      void (async () => {
        try {
          const payload = (await readJsonBody(req)) as { settings?: Record<string, unknown> } | null
          const settings = payload?.settings && typeof payload.settings === 'object' ? payload.settings : {}
          const snapshot = exportSnapshot(agent)

          stopActiveTasks(activeRequests)
          writeSettingsConfig(settings)
          applySettingsToEnv(settings)
          rebuildAgent(snapshot)

          json(res, 200, buildSettingsPayload(activeRequests.size), cors)
        } catch (error) {
          json(
            res,
            400,
            { error: error instanceof Error ? error.message : String(error) },
            cors
          )
        }
      })()
      return
    }

    if (url.pathname === '/api/workspace' && req.method === 'POST') {
      void (async () => {
        try {
          const payload = (await readJsonBody(req)) as { path?: string } | null
          const workspacePath = payload?.path
          if (!workspacePath || typeof workspacePath !== 'string') {
            json(res, 400, { error: 'path is required' }, cors)
            return
          }
          if (!fs.existsSync(workspacePath)) {
            json(res, 400, { error: `path does not exist: ${workspacePath}` }, cors)
            return
          }
          const stat = fs.statSync(workspacePath)
          if (!stat.isDirectory()) {
            json(res, 400, { error: `path is not a directory: ${workspacePath}` }, cors)
            return
          }
          initStorage({ workspaceRoot: workspacePath })
          process.chdir(workspacePath)
          json(res, 200, { ok: true, diagnostics: buildDiagnostics(activeRequests.size) }, cors)
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
        }
      })()
      return
    }

    if (url.pathname === '/api/project-info' && req.method === 'GET') {
      const projectPath = url.searchParams.get('path') || ''
      const branch = projectPath ? getGitBranch(projectPath) : null
      json(res, 200, { path: projectPath, isGit: branch !== null, branch }, cors)
      return
    }

    if (url.pathname === '/api/llms' && req.method === 'GET') {
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
      return
    }

    if (url.pathname.startsWith('/api/llm/') && req.method === 'POST') {
      try {
        const current = getAgent()
        const idx = Number.parseInt(url.pathname.split('/').pop() || '', 10)
        current.nextLlm(idx)
        json(res, 200, { ok: true, current: current.llmNo }, cors)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
      }
      return
    }

    if (url.pathname === '/api/reinject' && req.method === 'POST') {
      try {
        const current = getAgent()
        const backend = current.client.backend as unknown as Dict<unknown>
        backend.lastTools = ''
        json(res, 200, { ok: true }, cors)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) }, cors)
      }
      return
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      stopActiveTasks(activeRequests)
      json(res, 200, { ok: true }, cors)
      return
    }

    if (url.pathname === '/api/session/export' && req.method === 'GET') {
      json(res, 200, exportSnapshot(agent), cors)
      return
    }

    if (url.pathname === '/api/session/reset' && req.method === 'POST') {
      const snapshot = exportSnapshot(agent)
      stopActiveTasks(activeRequests)
      rebuildAgent({ ...buildEmptySnapshot(), llmNo: snapshot.llmNo })
      json(res, 200, { ok: true, current: agent?.llmNo ?? 0 }, cors)
      return
    }

    if (url.pathname === '/api/session/import' && req.method === 'POST') {
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
      return
    }

    if (url.pathname === '/chat' && req.method === 'GET') {
      let current: GenericAgent
      try {
        current = getAgent()
      } catch (error) {
        json(res, 503, { error: error instanceof Error ? error.message : String(error) }, cors)
        return
      }

      const q = url.searchParams.get('q') || ''
      const files = url.searchParams.get('files')
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...cors,
      })

      const requestId = crypto.randomUUID()
      const requestState: ActiveRequestState = { running: true }
      const runtime: TimelineRuntime = {
        activeStepId: null,
        seq: 0,
        state: {
          requestId,
          running: true,
          turn: 0,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          steps: [],
        },
        emit: (payload) => {
          sseEvent(res, 'timeline', JSON.stringify(payload))
        },
      }

      activeRequests.set(requestId, { res, state: requestState, runtime })

      req.on('close', () => {
        requestState.running = false
        if (runtime.state.running) finalizeTimeline(runtime, 'Connection closed')
        activeRequests.delete(requestId)
      })

      void (async () => {
        let fullText = ''
        const writeChunk = (chunk: string) => {
          fullText += chunk
          applyTurnMarkers(runtime, chunk)
          sseWrite(res, chunk)
        }
        const writeDone = (text: string) => {
          if (runtime.state.running) finalizeTimeline(runtime)
          sseEvent(res, 'done', text)
        }

        const frontend = new SseChatFrontend(current, writeChunk)

        try {
          if (q.startsWith('/')) {
            await withTimelineRuntime(runtime, async () => {
              await frontend.handleCommand(requestId, q)
            })
            writeDone(fullText)
            return
          }

          const prompt = buildPrompt(q, files)
          const queue = current.putTask(prompt, 'desktop')

          await withTimelineRuntime(runtime, async () => {
            while (requestState.running) {
              const item = await queue.get(true, 3)
              if (!item) continue
              if (item.next) writeChunk(item.next)
              if (item.done) {
                fullText = item.done
                writeDone(item.done)
                break
              }
            }
          })
        } catch (error) {
          const message = `❌ ${error instanceof Error ? error.message : String(error)}`
          writeChunk(message)
          writeDone(fullText || message)
        } finally {
          activeRequests.delete(requestId)
          res.end()
        }
      })()
      return
    }

    res.writeHead(404, cors)
    res.end('Not found')
  })

  const port = Number(process.env.WEB_PORT || 8502)
  server.listen(port, () => {
    console.log(`[Desktop] sidecar at http://127.0.0.1:${port}`)
    if (agentIssue) {
      console.warn(`[Desktop] agent unavailable: ${agentIssue}`)
    }
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
