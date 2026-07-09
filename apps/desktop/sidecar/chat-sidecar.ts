#!/usr/bin/env node
/** Orion desktop chat sidecar API. */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { FILE_HINT, AgentChatMixin, costTracker, ensureSingleInstance, loadMykey } from '@orion/chat'
import { GenericAgent, GenericAgentHandler } from '@orion/agent'

const __filename = fileURLToPath(import.meta.url)
const MAX_FILE_SIZE = 1024 * 1024
const PROJECT_ROOT = findProjectRoot(path.dirname(__filename))
const ENV_PATH = path.join(PROJECT_ROOT, '.env')
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example')
const MYKEY_PATH = path.join(PROJECT_ROOT, 'mykey.json')
const MYKEY_TEMPLATE_PATH = path.join(PROJECT_ROOT, 'mykey.template.json')

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
    mykeyPath: string
    mykeyExists: boolean
    mykeyTemplatePath: string
    mykeyTemplateExists: boolean
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
  'FEISHU_PORT',
  'WECOM_PORT',
  'WECHAT_PORT',
  'QQ_PORT',
  'DINGTALK_PORT',
]

let agent: GenericAgent | null = null
let agentIssue: string | null = null
let activeTimeline: TimelineRuntime | null = null

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
  if (fs.existsSync(ENV_EXAMPLE_PATH)) return parseEnvText(fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8'))
  return {}
}

function readMykeyConfig(): Dict<unknown> {
  for (const filePath of [MYKEY_PATH, MYKEY_TEMPLATE_PATH]) {
    if (!fs.existsSync(filePath)) continue
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Dict<unknown>
    } catch {
      return {}
    }
  }
  return {}
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
      mykeyPath: MYKEY_PATH,
      mykeyExists: fs.existsSync(MYKEY_PATH),
      mykeyTemplatePath: MYKEY_TEMPLATE_PATH,
      mykeyTemplateExists: fs.existsSync(MYKEY_TEMPLATE_PATH),
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

function readAttachment(filePath: string): string {
  try {
    const resolved = path.resolve(PROJECT_ROOT, filePath)
    // Restrict attachments to files inside the project root to prevent LFI.
    if (!resolved.startsWith(PROJECT_ROOT + path.sep)) {
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
  if (process.env.TAURI_SIDECHAT !== '1') {
    ensureSingleInstance(19536, 'Desktop')
  }
  costTracker.install()
  patchTimelineHooks()

  const keys = loadMykey(__filename)
  if (present(keys.claude_kimi_config)) {
    // Keep parity with the legacy startup expectation when this optional key exists.
  }

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
          const payload = (await readJsonBody(req)) as { env?: Dict<string>; mykey?: Dict<unknown> } | null
          const env = payload?.env && typeof payload.env === 'object' ? payload.env : {}
          const mykey = payload?.mykey && typeof payload.mykey === 'object' ? payload.mykey : {}
          const snapshot = exportSnapshot(agent)

          stopActiveTasks(activeRequests)
          writeEnvConfig(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value ?? '')])))
          writeMykeyConfig(mykey)
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
