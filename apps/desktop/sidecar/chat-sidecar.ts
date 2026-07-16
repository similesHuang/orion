#!/usr/bin/env node
/** Orion desktop chat sidecar API. */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AgentChatMixin, buildDoneText, costTracker, ensureSingleInstance, loadMykey, HELP_COMMANDS } from '@orion/chat'
import { AgentYield, GenericAgent } from '@orion/agent'

const __filename = fileURLToPath(import.meta.url)
const PROJECT_ROOT = findProjectRoot(path.dirname(__filename))
const ENV_PATH = path.join(PROJECT_ROOT, '.env')
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example')
const MYKEY_PATH = path.join(PROJECT_ROOT, 'mykey.json')

type Dict<T> = Record<string, T>

interface BackendSnapshot {
  llmNo: number
  history: string[]
  sessionHistories: unknown[][]
}

interface ActiveRequestState {
  running: boolean
  agent?: GenericAgent
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

interface SettingsPayload {
  env: Dict<string>
  mykey: Dict<unknown>
  diagnostics: DiagnosticsPayload
}

class SseChatFrontend extends AgentChatMixin {
  label = 'Desktop'
  source = 'desktop'
  splitLimit = 2000
  private cb: (event: string, data: string) => void

  constructor(agent: GenericAgent, cb: (event: string, data: string) => void) {
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

const GATEWAY_SPECS: Array<{
  id: string
  label: string
  portKey: string | null
  requiredKeys: string[]
  allowedKey: string | null
}> = [
  { id: 'feishu', label: 'Feishu', portKey: 'FEISHU_PORT', requiredKeys: ['fs_app_id', 'fs_app_secret'], allowedKey: 'fs_allowed_users' },
]

const KNOWN_ENV_ORDER = [
  'GA_LANG',
  'LLM_TYPE',
  'LLM_NAME',
  'LLM_APIKEY',
  'LLM_APIBASE',
  'LLM_MODEL',
  'LLM_MAX_RETRIES',
  'LLM_CONNECT_TIMEOUT',
  'LLM_READ_TIMEOUT',
  'LLM_CONTEXT_WIN',
  'LLM_PROXY',
  'LLM_VERIFY',
  'LLM_STREAM',
  'LLM_TIMEOUT',
  'LLM_TEMPERATURE',
  'LLM_MAX_TOKENS',
  'LLM_API_MODE',
  'LLM_REASONING_EFFORT',
  'LLM_THINKING_TYPE',
  'LLM_THINKING_BUDGET_TOKENS',
  'LLM_FAKE_CC_SYSTEM_PROMPT',
  'LLM_USER_AGENT',
  'ORION_TOOL_APPROVAL',
  'ORION_ALLOW_SHELL',
  'FEISHU_PORT',
]

let agent: GenericAgent | null = null
let agentIssue: string | null = null

/** Tools that must be approved by the user before running. Everything else auto-allows. */
const HIGH_RISK_TOOLS = new Set(['code_run', 'file_write', 'file_patch'])

function toolApprovalEnabled(): boolean {
  // On by default; users disable via ORION_TOOL_APPROVAL=false in settings/.env.
  const raw = (process.env.ORION_TOOL_APPROVAL ?? readEnvConfig().ORION_TOOL_APPROVAL ?? '').toLowerCase()
  return raw !== 'false' && raw !== '0' && raw !== 'off'
}

interface PendingApproval {
  toolName: string
  resolve: (decision: 'allow' | 'deny') => void
}

/** Per-request approval waiters, keyed by requestId then a per-call approvalId. */
const pendingApprovals = new Map<string, Map<string, PendingApproval>>()

/** Per-request bridge so /api/approve can resolve a specific waiter. */
type ApprovalResolver = (approvalId: string, decision: 'allow' | 'deny', remember: boolean) => boolean
const approvalResolvers = new Map<string, ApprovalResolver>()

function resolveAllPending(requestId: string, decision: 'allow' | 'deny'): void {
  const forReq = pendingApprovals.get(requestId)
  if (forReq) {
    for (const p of forReq.values()) p.resolve(decision)
    pendingApprovals.delete(requestId)
  }
  approvalResolvers.delete(requestId)
}

function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  const seen = new Set<string>()
  while (!seen.has(dir)) {
    seen.add(dir)
    if (['assets', 'memory', 'package.json'].every((marker) => fs.existsSync(path.join(dir, marker)))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function resolveWorkingDir(raw: string | null): string {
  if (!raw) return path.join(PROJECT_ROOT, 'temp')
  const resolved = path.resolve(raw)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录: ${raw}`)
  }
  return resolved
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return String(value ?? '').trim().length > 0
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

function createAgent(llmNo = 0, cwd?: string): GenericAgent {
  const next = new GenericAgent(cwd ? { cwd } : undefined)
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

function restoreSnapshot(snapshot: BackendSnapshot, cwd?: string): GenericAgent {
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

function rebuildAgent(snapshot?: BackendSnapshot | null, cwd?: string): void {
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

function getAgent(): GenericAgent {
  if (!agent) {
    throw new Error(agentIssue || 'Agent unavailable')
  }
  return agent
}

function parseEnvText(text: string): Dict<string> {
  const result: Dict<string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const key = match[2]
    let value = match[3].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function readEnvConfig(): Dict<string> {
  if (fs.existsSync(ENV_PATH)) return parseEnvText(fs.readFileSync(ENV_PATH, 'utf-8'))
  return {}
}

/**
 * Push .env values into process.env so settings that are read directly via
 * process.env deep in the tool layer (e.g. ORION_ALLOW_SHELL) take effect
 * without restarting the sidecar. Values already set in the real environment
 * win, matching loadEnv()'s precedence.
 */
function hydrateProcessEnv(): void {
  const fileEnv = readEnvConfig()
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value
    else if (key === 'ORION_ALLOW_SHELL' || key === 'ORION_TOOL_APPROVAL') {
      // These toggles are owned by the settings panel; let the file value win
      // so flipping them in the UI applies immediately.
      process.env[key] = value
    }
  }
}

function readMykeyConfig(): Dict<unknown> {
  if (!fs.existsSync(MYKEY_PATH)) return {}
  try {
    return JSON.parse(fs.readFileSync(MYKEY_PATH, 'utf-8')) as Dict<unknown>
  } catch {
    return {}
  }
}

function serializeEnvValue(value: string): string {
  if (value === '') return ''
  if (/[\s#"'`]/.test(value)) return JSON.stringify(value)
  return value
}

function serializeEnvConfig(env: Dict<string>): string {
  const entries = Object.entries(env).filter(([, value]) => value !== undefined)
  const order = new Map(KNOWN_ENV_ORDER.map((key, idx) => [key, idx]))
  entries.sort(([left], [right]) => {
    const leftOrder = order.has(left) ? order.get(left)! : Number.MAX_SAFE_INTEGER
    const rightOrder = order.has(right) ? order.get(right)! : Number.MAX_SAFE_INTEGER
    return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder
  })

  const lines = [
    '# Orion desktop configuration',
    '# Managed by the desktop settings panel.',
    '',
    ...entries.map(([key, value]) => `${key}=${serializeEnvValue(String(value))}`),
    '',
  ]
  return lines.join('\n')
}

function writeEnvConfig(env: Dict<string>): void {
  fs.writeFileSync(ENV_PATH, serializeEnvConfig(env), 'utf-8')
}

function writeMykeyConfig(mykey: Dict<unknown>): void {
  fs.writeFileSync(MYKEY_PATH, `${JSON.stringify(mykey, null, 2)}\n`, 'utf-8')
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

function buildGatewayDiagnostics(env: Dict<string>, mykey: Dict<unknown>): GatewayDiagnostic[] {
  return GATEWAY_SPECS.map((spec) => {
    const requiredMissing = spec.requiredKeys.filter((key) => !present(mykey[key]))
    const allowedUsers = spec.allowedKey ? toAllowedList(mykey[spec.allowedKey]) : []
    return {
      id: spec.id,
      label: spec.label,
      portKey: spec.portKey,
      portValue: spec.portKey ? String(env[spec.portKey] || '') : null,
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

function buildDiagnostics(activeRequests: number): DiagnosticsPayload {
  const env = readEnvConfig()
  const mykey = readMykeyConfig()
  const current = agent
  return {
    pid: process.pid,
    nodeVersion: process.version,
    cwd: process.cwd(),
    projectRoot: PROJECT_ROOT,
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
      envPath: ENV_PATH,
      envExists: fs.existsSync(ENV_PATH),
      envExamplePath: ENV_EXAMPLE_PATH,
      envExampleExists: fs.existsSync(ENV_EXAMPLE_PATH),
    },
    gateways: buildGatewayDiagnostics(env, mykey),
  }
}

function buildSettingsPayload(activeRequests: number): SettingsPayload {
  return {
    env: readEnvConfig(),
    mykey: readMykeyConfig(),
    diagnostics: buildDiagnostics(activeRequests),
  }
}

const MAX_QUERY_LENGTH = 100_000

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

function sseEvent(res: http.ServerResponse, eventName: string, data: string): void {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`)
}

function stopActiveTasks(activeRequests: Map<string, { res: http.ServerResponse; state: ActiveRequestState }>): void {
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
  if (process.env.TAURI_SIDECHAT !== '1') {
    ensureSingleInstance(19536, 'Desktop')
  }
  costTracker.install()
  hydrateProcessEnv()

  const keys = loadMykey(__filename)
  if (present(keys.claude_kimi_config)) {
    // Keep parity with the legacy startup expectation when this optional key exists.
  }

  rebuildAgent()

  const activeRequests = new Map<string, { res: http.ServerResponse; state: ActiveRequestState }>()

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
          const payload = (await readJsonBody(req)) as { env?: Dict<string>; mykey?: Dict<unknown> } | null
          const env = payload?.env && typeof payload.env === 'object' ? payload.env : {}
          const mykey = payload?.mykey && typeof payload.mykey === 'object' ? payload.mykey : {}
          const snapshot = exportSnapshot(agent)

          stopActiveTasks(activeRequests)
          writeEnvConfig(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value ?? '')])))
          writeMykeyConfig(mykey)
          hydrateProcessEnv()
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

    if (url.pathname === '/api/cost' && req.method === 'GET') {
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
      return
    }

    if (url.pathname === '/api/commands' && req.method === 'GET') {
      json(res, 200, HELP_COMMANDS.map(([command, description]) => ({ command, description })), cors)
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

    if (url.pathname === '/api/approve' && req.method === 'POST') {
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

          while (requestState.running) {
            const item = await queue.get(true, 3)
            if (!item) continue
            if (item.next) consumeYield(item.next)
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
