#!/usr/bin/env node
/** Orion desktop chat sidecar API. */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { costTracker } from '@orion/engine'
import { corsHeaders } from './sse.js'
import { present, hydrateProcessEnv } from './config.js'
import { rebuildAgent, agentIssue, ActiveRequestMap } from './agent-manager.js'
import {
  handleRoot,
  handleDiagnostics,
  handleSettingsGet,
  handleSettingsPost,
  handleLlms,
  handleCost,
  handleCommands,
  handleLlmSwitch,
  handleReinject,
  handleStop,
  handleApprove,
  handleSessionExport,
  handleSessionReset,
  handleSessionImport,
  handleUpload,
  handleChat,
  handleGatewayStart,
  handleGatewayStop,
  handleGatewayStatus,
} from './router.js'

/** Prevent multiple sidecar instances on the same port. */
function ensureSingleInstance(port: number, label: string): void {
  const srv = net.createServer()
  srv.once('error', () => {
    console.log(`[${label}] Another instance is already running, skipping...`)
    process.exit(0)
  })
  srv.listen(port, '127.0.0.1')
}

/** Load mykey.json up the directory tree. */
function loadMykey(scriptFile?: string): Record<string, unknown> {
  let dir = scriptFile ? path.dirname(scriptFile) : process.cwd()
  if (dir.endsWith('dist') || dir.includes(`${path.sep}dist${path.sep}`) ||
      dir.endsWith('src') || dir.includes(`${path.sep}src${path.sep}`)) {
    dir = path.resolve(dir, '..')
  }
  while (true) {
    const p = path.join(dir, 'mykey.json')
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown> }
      catch { return {} }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return {}
}

async function main(): Promise<void> {
  if (process.env.TAURI_SIDECHAT !== '1') {
    ensureSingleInstance(19536, 'Desktop')
  }
  hydrateProcessEnv()

  const __filename = fileURLToPath(import.meta.url)
  const keys = loadMykey(__filename)
  if (present(keys.claude_kimi_config)) {
    // Keep parity with the legacy startup expectation when this optional key exists.
  }

  rebuildAgent()

  const activeRequests: ActiveRequestMap = new Map()

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
      handleRoot(req, res, cors)
      return
    }

    if (url.pathname === '/api/diagnostics' && req.method === 'GET') {
      handleDiagnostics(res, cors, activeRequests)
      return
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      handleSettingsGet(res, cors, activeRequests)
      return
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      handleSettingsPost(req, res, cors, activeRequests)
      return
    }

    if (url.pathname === '/api/llms' && req.method === 'GET') {
      handleLlms(res, cors)
      return
    }

    if (url.pathname === '/api/cost' && req.method === 'GET') {
      handleCost(res, cors)
      return
    }

    if (url.pathname === '/api/commands' && req.method === 'GET') {
      handleCommands(res, cors)
      return
    }

    if (url.pathname.startsWith('/api/llm/') && req.method === 'POST') {
      handleLlmSwitch(req, res, cors, url)
      return
    }

    if (url.pathname === '/api/reinject' && req.method === 'POST') {
      handleReinject(req, res, cors)
      return
    }

    if (url.pathname === '/api/stop' && req.method === 'POST') {
      handleStop(res, cors, activeRequests)
      return
    }

    if (url.pathname === '/api/approve' && req.method === 'POST') {
      handleApprove(req, res, cors)
      return
    }

    if (url.pathname === '/api/session/export' && req.method === 'GET') {
      handleSessionExport(res, cors)
      return
    }

    if (url.pathname === '/api/session/reset' && req.method === 'POST') {
      handleSessionReset(res, cors, activeRequests)
      return
    }

    if (url.pathname === '/api/session/import' && req.method === 'POST') {
      handleSessionImport(req, res, cors, activeRequests)
      return
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      handleUpload(req, res, cors)
      return
    }

    if (url.pathname === '/chat' && req.method === 'GET') {
      handleChat(req, res, cors, activeRequests, url)
      return
    }

    if (url.pathname === '/api/gateway/start' && req.method === 'POST') {
      handleGatewayStart(res, cors)
      return
    }

    if (url.pathname === '/api/gateway/stop' && req.method === 'POST') {
      handleGatewayStop(res, cors)
      return
    }

    if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
      handleGatewayStatus(res, cors)
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
