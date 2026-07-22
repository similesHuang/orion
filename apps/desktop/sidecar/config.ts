import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Dict<T> = Record<string, T>

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
  env: Dict<string>
  mykey: Dict<unknown>
  diagnostics: DiagnosticsPayload
}

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)

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

export const PROJECT_ROOT = findProjectRoot(path.dirname(__filename))
export const ENV_PATH = path.join(PROJECT_ROOT, '.env')
export const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example')
export const MYKEY_PATH = path.join(PROJECT_ROOT, 'mykey.json')

// ---------------------------------------------------------------------------
// Gateway / env constants
// ---------------------------------------------------------------------------

export const GATEWAY_SPECS: Array<{
  id: string
  label: string
  portKey: string | null
  requiredKeys: string[]
  allowedKey: string | null
}> = [
  { id: 'feishu', label: 'Feishu', portKey: 'FEISHU_PORT', requiredKeys: ['fs_app_id', 'fs_app_secret'], allowedKey: 'fs_allowed_users' },
]

export const KNOWN_ENV_ORDER = [
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

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return String(value ?? '').trim().length > 0
}

// ---------------------------------------------------------------------------
// .env read / write
// ---------------------------------------------------------------------------

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

export function readEnvConfig(): Dict<string> {
  if (fs.existsSync(ENV_PATH)) return parseEnvText(fs.readFileSync(ENV_PATH, 'utf-8'))
  return {}
}

/**
 * Push .env values into process.env so settings that are read directly via
 * process.env deep in the tool layer (e.g. ORION_ALLOW_SHELL) take effect
 * without restarting the sidecar. Values already set in the real environment
 * win, matching loadEnv()'s precedence.
 */
export function hydrateProcessEnv(): void {
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

export function writeEnvConfig(env: Dict<string>): void {
  fs.writeFileSync(ENV_PATH, serializeEnvConfig(env), 'utf-8')
}

// ---------------------------------------------------------------------------
// mykey read / write
// ---------------------------------------------------------------------------

export function readMykeyConfig(): Dict<unknown> {
  if (!fs.existsSync(MYKEY_PATH)) return {}
  try {
    return JSON.parse(fs.readFileSync(MYKEY_PATH, 'utf-8')) as Dict<unknown>
  } catch {
    return {}
  }
}

export function writeMykeyConfig(mykey: Dict<unknown>): void {
  fs.writeFileSync(MYKEY_PATH, `${JSON.stringify(mykey, null, 2)}\n`, 'utf-8')
}

// ---------------------------------------------------------------------------
// Diagnostics / settings payload builders
// ---------------------------------------------------------------------------

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

function safeListLlms(current: unknown): string[] {
  if (!current) return []
  try {
    return (current as { listLlms: () => string }).listLlms().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function buildDiagnostics(activeRequests: number, agent: unknown, agentIssue: string | null): DiagnosticsPayload {
  const env = readEnvConfig()
  const mykey = readMykeyConfig()
  return {
    pid: process.pid,
    nodeVersion: process.version,
    cwd: process.cwd(),
    projectRoot: PROJECT_ROOT,
    sidecarPort: Number(process.env.WEB_PORT || 8502),
    activeRequests,
    agent: {
      ready: !!agent,
      issue: agentIssue,
      llmIndex: agent ? (agent as { llmNo: number }).llmNo : null,
      llmName: agent ? (agent as { llmName: string | null }).llmName : null,
      llms: safeListLlms(agent),
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

export function buildSettingsPayload(activeRequests: number, agent: unknown, agentIssue: string | null): SettingsPayload {
  return {
    env: readEnvConfig(),
    mykey: readMykeyConfig(),
    diagnostics: buildDiagnostics(activeRequests, agent, agentIssue),
  }
}

// ---------------------------------------------------------------------------
// Working directory resolution
// ---------------------------------------------------------------------------

export function resolveWorkingDir(raw: string | null): string {
  if (!raw) return path.join(PROJECT_ROOT, 'temp')
  const resolved = path.resolve(raw)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录: ${raw}`)
  }
  return resolved
}
