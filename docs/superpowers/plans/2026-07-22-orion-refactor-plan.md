# Orion 单包重构 + 桌面端增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge 10 multi-package monorepo into single `packages/core`, delete CLI, enhance desktop capabilities, and apply glassmorphic UI theme.

**Architecture:** Current packages (types, shared, llm, tools, memory, agent, chat, reflect) become domain directories under `packages/core/src/`. Cross-package `@orion/*` imports become relative `../` imports. Apps consume via `@orion/core`. Sidecar single 31KB file splits into manager/config/router/sse modules.

**Tech Stack:** TypeScript (composite → single build), pnpm workspaces (reduced to 3 entries), Tauri 2.x, React, Vite

## Global Constraints

- All source files must remain functionally identical after moves (only import paths change)
- packages/core must compile with a single `tsc` invocation (no composite/compositeReferences)
- Sidecar splitting must NOT change any HTTP API shape or SSE event format
- UI redesign is CSS/styling only — no component restructuring

---

### Task 1: Delete CLI, permissions, old core, update workspace config

**Files:**
- Delete: `apps/cli/` (entire directory)
- Delete: `packages/permissions/` (entire directory)
- Delete: `packages/core/` (old re-export layer)
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: (none)
- Produces: clean repo state ready for new core package

- [ ] **Step 1: Remove directories**

Run these commands:
```bash
git rm -rf apps/cli
git rm -rf packages/permissions
git rm -rf packages/core
```

- [ ] **Step 2: Update pnpm-workspace.yaml**

Replace current content with:
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

Packages only has `core` now, still glob-matches.

- [ ] **Step 3: Update root package.json**

Remove CLI scripts, keep only:
```json
"scripts": {
  "build": "pnpm --filter @orion/core build",
  "dev": "tsx apps/desktop/sidecar/chat-sidecar.ts",
  "desktop:dev": "pnpm --filter @orion/desktop dev:clean",
  "desktop:build": "pnpm --filter @orion/desktop build",
  "gateway": "pnpm --filter @orion/gateway start",
  "lint": "eslint packages apps",
  "typecheck": "tsc --noEmit -p tsconfig.check.json",
  "clean": "pnpm -r exec rm -rf dist",
  "ultraplan:daemon": "tsx packages/core/src/agent/ultraplan-daemon.ts"
}
```

- [ ] **Step 4: Update .gitignore**

No changes needed — the existing .gitignore patterns already cover the new structure.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "refactor: remove CLI, permissions, and old core packages"
```

---

### Task 2: Create packages/core skeleton

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`

**Interfaces:**
- Consumes: merged dependency list from all old packages
- Produces: compilable core package (empty initially), workspace consumers can list `@orion/core`

- [ ] **Step 1: Create packages/core/package.json**

```json
{
  "name": "@orion/core",
  "version": "0.1.0",
  "type": "module",
  "description": "Orion unified runtime — agent, LLM, tools, memory, chat, reflect",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "lint": "eslint src"
  },
  "dependencies": {
    "js-yaml": "^4.1.0",
    "ws": "^8.21.0",
    "langfuse": "^3.32.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.18.1",
    "typescript": "^5.7.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

Key change from old per-package tsconfig: no `composite: true`, no `references` block. Single-pass compilation.

- [ ] **Step 3: Verify empty build**

```bash
pnpm install
pnpm --filter @orion/core build
```
Expected: compiles (warns about empty directory, but no error).

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "refactor(core): create single core package skeleton"
```

---

### Task 3: Merge types and shared domains (no internal deps)

**Files:**
- Create: `packages/core/src/types/index.ts` (copy from `packages/types/src/index.ts`)
- Create: `packages/core/src/shared/index.ts` (copy)
- Create: `packages/core/src/shared/storage.ts` (copy)
- Create: `packages/core/src/shared/run-python.ts` (copy)
- Delete: `packages/types/` (after copy)
- Delete: `packages/shared/` (after copy)

**Interfaces:**
- Consumes: source files from old packages/types and packages/shared
- Produces: `@orion/core` exports types and shared utilities

**No import rewrites needed** — these domains have zero internal `@orion/*` deps.

- [ ] **Step 1: Copy types domain**

```bash
mkdir -p packages/core/src/types
cp packages/types/src/index.ts packages/core/src/types/index.ts
```

`packages/types/src/index.ts` has no `@orion/` imports — it's all external or inline types.

- [ ] **Step 2: Copy shared domain**

```bash
mkdir -p packages/core/src/shared
cp packages/shared/src/index.ts packages/core/src/shared/index.ts
cp packages/shared/src/storage.ts packages/core/src/shared/storage.ts
cp packages/shared/src/run-python.ts packages/core/src/shared/run-python.ts
```

Verify: `packages/shared/src/` files have no `@orion/*` imports.

- [ ] **Step 3: Remove old packages**

```bash
git rm -rf packages/types
git rm -rf packages/shared
```

- [ ] **Step 4: Write core index.ts (partial — two domains for now)**

`packages/core/src/index.ts`:
```ts
export * from './types/index.js'
export * from './shared/index.js'
```

- [ ] **Step 5: Build**

```bash
pnpm --filter @orion/core build
```
Expected: clean compilation.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src
git commit -m "refactor(core): merge types and shared domains"
```

---

### Task 4: Merge llm and tools domains (depend on types/shared)

**Files:**
- Create: `packages/core/src/llm/index.ts` (copy + rewrite imports)
- Create: `packages/core/src/llm/env-config.ts` (copy + rewrite imports)
- Create: `packages/core/src/tools/index.ts` (copy + rewrite imports)
- Create: `packages/core/src/tools/handler.ts` (copy + rewrite imports)
- Create: `packages/core/src/tools/web.ts` (copy + rewrite imports)
- Create: `packages/core/src/tools/tmwebdriver.ts` (copy + rewrite imports)
- Delete: `packages/llm/` (after copy)
- Delete: `packages/tools/` (after copy)

**Interfaces:**
- Consumes: `@orion/types`, `@orion/shared` → rewritten to relative `../types/index.js`, `../shared/index.js`
- Produces: `@orion/core` exports LLM clients and tool handlers

- [ ] **Step 1: Copy and rewrite llm domain**

```bash
mkdir -p packages/core/src/llm
cp packages/llm/src/index.ts packages/core/src/llm/index.ts
cp packages/llm/src/env-config.ts packages/core/src/llm/env-config.ts
```

Rewrite `@orion/*` imports in both files:

In `packages/core/src/llm/index.ts`:
```
from '@orion/types'  →  from '../types/index.js'
from '@orion/shared' →  from '../shared/index.js'
```

In `packages/core/src/llm/env-config.ts`:
```
from '@orion/types'  →  from '../types/index.js'
from '@orion/shared' →  from '../shared/index.js'
```

- [ ] **Step 2: Copy and rewrite tools domain**

```bash
mkdir -p packages/core/src/tools
cp packages/tools/src/index.ts packages/core/src/tools/index.ts
cp packages/tools/src/handler.ts packages/core/src/tools/handler.ts
cp packages/tools/src/web.ts packages/core/src/tools/web.ts
cp packages/tools/src/tmwebdriver.ts packages/core/src/tools/tmwebdriver.ts
```

Rewrite `@orion/*` imports in all four files:
```
from '@orion/types'  →  from '../types/index.js'
from '@orion/shared' →  from '../shared/index.js'
```

- [ ] **Step 3: Remove old packages and update index.ts**

```bash
git rm -rf packages/llm
git rm -rf packages/tools
```

Append to `packages/core/src/index.ts`:
```ts
export * from './llm/index.js'
export * from './tools/index.js'
```

- [ ] **Step 4: Build**

```bash
pnpm --filter @orion/core build
```
Expected: clean compilation (all imports resolve within core).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/src/index.ts
git commit -m "refactor(core): merge llm and tools domains"
```

---

### Task 5: Merge memory domain (depends on types/shared)

**Files:**
- Create: `packages/core/src/memory/index.ts`
- Create: `packages/core/src/memory/*.ts` (all files from packages/memory/src/)
- Create: `packages/core/src/memory/L4_raw_sessions/compress-session.ts`
- Create: `packages/core/src/memory/skill-search/index.ts`
- Create: `packages/core/src/memory/skill-search/engine.ts`
- Delete: `packages/memory/`

**Interfaces:**
- Consumes: `@orion/shared` → rewritten to `../shared/index.js`
- Produces: `@orion/core` exports memory system

- [ ] **Step 1: Copy all memory files**

```bash
mkdir -p packages/core/src/memory/L4_raw_sessions
mkdir -p packages/core/src/memory/skill-search
cp packages/memory/src/*.ts packages/core/src/memory/
cp packages/memory/src/L4_raw_sessions/*.ts packages/core/src/memory/L4_raw_sessions/
cp packages/memory/src/skill-search/*.ts packages/core/src/memory/skill-search/
```

- [ ] **Step 2: Rewrite imports**

In all memory `*.ts` files, replace:
```
from '@orion/shared' → from '../shared/index.js'
from '@orion/types'  → from '../types/index.js'
```

- [ ] **Step 3: Remove old package and update index.ts**

```bash
git rm -rf packages/memory
```

Append to `packages/core/src/index.ts`:
```ts
export * from './memory/index.js'
```

- [ ] **Step 4: Build**

```bash
pnpm --filter @orion/core build
```
Expected: clean compilation.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory packages/core/src/index.ts
git commit -m "refactor(core): merge memory domain"
```

---

### Task 6: Merge agent, chat, reflect domains (depend on all lower domains)

**Files:**
- Create: `packages/core/src/agent/` (all 7 files)
- Create: `packages/core/src/chat/` (all 6 files)
- Create: `packages/core/src/reflect/` (all 6 files)
- Create: `packages/core/src/plugins/langfuse-tracing.ts` (from old core)
- Delete: `packages/agent/`, `packages/chat/`, `packages/reflect/`

**Interfaces:**
- Consumes: all lower domains via relative imports
- Produces: complete `@orion/core` with every domain

- [ ] **Step 1: Copy agent files and rewrite imports**

```bash
mkdir -p packages/core/src/agent
cp packages/agent/src/*.ts packages/core/src/agent/
```

Rewrite all `@orion/*` imports in `packages/core/src/agent/*.ts`:

| Old | New |
|-----|-----|
| `@orion/types` | `../types/index.js` |
| `@orion/shared` | `../shared/index.js` |
| `@orion/llm` | `../llm/index.js` |
| `@orion/tools` | `../tools/index.js` |

- [ ] **Step 2: Copy chat files and rewrite imports**

```bash
mkdir -p packages/core/src/chat
cp packages/chat/src/*.ts packages/core/src/chat/
```

Rewrite:
| Old | New |
|-----|-----|
| `@orion/shared` | `../shared/index.js` |
| `@orion/agent` | `../agent/index.js` |
| `@orion/types` | `../types/index.js` |

- [ ] **Step 3: Copy reflect files and rewrite imports**

```bash
mkdir -p packages/core/src/reflect
cp packages/reflect/src/*.ts packages/core/src/reflect/
```

Rewrite:
| Old | New |
|-----|-----|
| `@orion/shared` | `../shared/index.js` |
| `@orion/memory` | `../memory/index.js` |

- [ ] **Step 4: Copy langfuse plugin**

```bash
mkdir -p packages/core/src/plugins
cp packages/core/src/plugins/langfuse-tracing.ts packages/core/src/plugins/
```

(NOTE: The old `packages/core/` has already been deleted. If the source file only exists in the old core, we need to handle this differently. Let me check if it was already deleted in Task 1.)

If old `packages/core/` was already deleted, recover the file from git first:
```bash
git show HEAD:packages/core/src/plugins/langfuse-tracing.ts > packages/core/src/plugins/langfuse-tracing.ts
```

Then rewrite imports:
| Old | New |
|-----|-----|
| `@orion/agent` | `../agent/index.js` |
| `@orion/llm` | `../llm/index.js` |
| `@orion/shared` | `../shared/index.js` |

- [ ] **Step 5: Remove old packages and finalize index.ts**

```bash
git rm -rf packages/agent
git rm -rf packages/chat
git rm -rf packages/reflect
```

Append to `packages/core/src/index.ts`:
```ts
export * from './agent/index.js'
export * from './chat/index.js'
export * from './reflect/index.js'
```

- [ ] **Step 6: Build**

```bash
pnpm --filter @orion/core build
```
Expected: clean compilation of all ~35 source files.

- [ ] **Step 7: Run typecheck**

```bash
pnpm typecheck
```
Expected: zero type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/agent packages/core/src/chat packages/core/src/reflect packages/core/src/plugins packages/core/src/index.ts
git commit -m "refactor(core): merge agent, chat, reflect domains"
```

---

### Task 7: Update consumer apps (sidecar & gateway)

**Files:**
- Modify: `apps/desktop/sidecar/chat-sidecar.ts`
- Modify: `apps/gateway/src/feishu.ts`
- Modify: `apps/gateway/tsconfig.json` (update project references)
- Delete: `apps/gateway/tsconfig.json` references (if switching to `@orion/core` workspace dep)

**Interfaces:**
- Consumes: `@orion/core` instead of `@orion/agent` + `@orion/chat`
- Produces: sidecar and gateway compile and run against unified core

- [ ] **Step 1: Update sidecar imports**

In `apps/desktop/sidecar/chat-sidecar.ts`:
```
from '@orion/chat'  →  from '@orion/core'
from '@orion/agent' →  from '@orion/core'
```

- [ ] **Step 2: Update gateway imports**

In `apps/gateway/src/feishu.ts`:
```
from '@orion/chat'  →  from '@orion/core'
from '@orion/agent' →  from '@orion/core'
```

- [ ] **Step 3: Update gateway tsconfig**

`apps/gateway/tsconfig.json`: Remove `references` block (no more project references needed), OR if it still uses `@orion/core` as workspace dependency, the `references` should point to `../../packages/core`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [
    {
      "path": "../../packages/core"
    }
  ]
}
```

- [ ] **Step 4: Full workspace build**

```bash
pnpm install
pnpm build
```
Expected: core builds, sidecar builds, gateway builds — all clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/sidecar apps/gateway
git commit -m "refactor: update consumer apps to @orion/core"
```

---

### Task 8: Split sidecar into multi-file modules

**Files:**
- Create: `apps/desktop/sidecar/agent-manager.ts`
- Create: `apps/desktop/sidecar/config.ts`
- Create: `apps/desktop/sidecar/router.ts`
- Create: `apps/desktop/sidecar/sse.ts`
- Modify: `apps/desktop/sidecar/chat-sidecar.ts` (thin entry point)

**Interfaces:**
- Consumes: `chat-sidecar.ts` as single-file to split
- Produces: modular sidecar with same HTTP API

- [ ] **Step 1: Create sse.ts**

```ts
import type http from 'node:http'

export interface SseEvent {
  event: string
  data: string
}

export function sseEvent(res: http.ServerResponse, eventName: string, data: string): void {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`)
}

export function json(res: http.ServerResponse, status: number, data: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(data))
}

export function corsHeaders(origin: string | undefined): http.OutgoingHttpHeaders {
  const allowed = getAllowedOrigin(origin)
  if (!allowed) return {}
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function getAllowedOrigin(origin: string | undefined): string | false {
  if (!origin) return false
  if (origin === 'tauri://localhost') return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
  return false
}
```

- [ ] **Step 2: Create config.ts**

Move from `chat-sidecar.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'

// ... extract: parseEnvText, readEnvConfig, writeEnvConfig, serializeEnvConfig,
//   readMykeyConfig, writeMykeyConfig, hydrateProcessEnv,
//   buildGatewayDiagnostics, buildDiagnostics, buildSettingsPayload,
//   KNOWN_ENV_ORDER, GATEWAY_SPECS, ENV_PATH, MYKEY_PATH, etc.
```

Export everything that's currently top-level in chat-sidecar.ts for configuration/env management.

- [ ] **Step 3: Create agent-manager.ts**

Move from `chat-sidecar.ts`:

```ts
import { GenericAgent } from '@orion/core'
// ... extract: createAgent, rebuildAgent, getAgent,
//   buildEmptySnapshot, exportSnapshot, restoreSnapshot,
//   SseChatFrontend, Approval types, stopActiveTasks, resolveAllPending
```

- [ ] **Step 4: Create router.ts**

Move all API route handlers from the `http.createServer` callback body into named functions:

```ts
import type http from 'node:http'
// ...
export function handleDiagnostics(req: http.IncomingMessage, res: http.ServerResponse): void { ... }
export function handleSettings(req: http.IncomingMessage, res: http.ServerResponse): void { ... }
export function handleChat(req: http.IncomingMessage, res: http.ServerResponse): void { ... }
// ... one function per API endpoint
```

- [ ] **Step 5: Thin down chat-sidecar.ts**

After extraction, `chat-sidecar.ts` becomes:

```ts
#!/usr/bin/env node
import http from 'node:http'
import { costTracker } from '@orion/core'
import { corsHeaders } from './sse.js'
import { handleDiagnostics, handleSettings, /* ... */ } from './router.js'

async function main(): Promise<void> {
  costTracker.install()
  // ... minimal startup logic
  
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const origin = req.headers.origin
    const cors = corsHeaders(origin)
    
    if (req.method === 'OPTIONS') { /* ... */ }
    
    // Route dispatch
    if (url.pathname === '/api/diagnostics' && req.method === 'GET') return handleDiagnostics(req, res, cors)
    if (url.pathname === '/api/settings' && req.method === 'GET') return handleSettings(req, res, cors)
    // ... etc
  })
  
  server.listen(port, () => { /* ... */ })
}

main().catch(/* ... */)
```

- [ ] **Step 6: Build**

```bash
pnpm --filter @orion/desktop build:sidecar
```
Expected: compiles all 5 sidecar files cleanly.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/sidecar
git commit -m "refactor(desktop): split sidecar into multiple modules"
```

---

### Task 9: Desktop UI — file attachment and import/export

**Files:**
- Modify: `apps/desktop/sidecar/router.ts` (add /api/upload endpoint)
- Modify: `apps/desktop/ui/src/api.ts` (add uploadFile, exportConversation, importConversation)
- Modify: `apps/desktop/ui/src/App.tsx` (add attachment button, import/export menu)
- Modify: `apps/desktop/ui/src/style.css` (attachment preview styles)

**Interfaces:**
- Consumes: `sidecar/router.ts` modifications, `App.tsx` modifications
- Produces: file drag-and-drop into chat, conversation JSON export/import

- [ ] **Step 1: Add upload endpoint to sidecar**

In `router.ts`:

```ts
export function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, cors: http.OutgoingHttpHeaders): void {
  // Accept multipart/form-data or raw file body
  // Save to PROJECT_ROOT/temp/attachments/{uuid}-{originalname}
  // Return JSON: { path: "...", name: "...", size: ... }
}
```

- [ ] **Step 2: Add UI API functions**

In `apps/desktop/ui/src/api.ts`:

```ts
export async function uploadFile(file: File): Promise<{ path: string; name: string; size: number }> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await fetch(`${baseUrl()}/api/upload`, { method: 'POST', body: formData })
  return response.json()
}

export async function exportConversation(): Promise<Blob> {
  const response = await fetch(`${baseUrl()}/api/session/export`)
  return response.blob()
}

export async function importConversation(data: unknown): Promise<void> {
  await fetchJson('/api/session/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
```

- [ ] **Step 3: Wire into App.tsx**

Add to the Sender input area:
- Attachment button (paperclip icon) triggering file dialog via Tauri `open()`
- Drag-and-drop zone on the composer area
- On file select/attach: upload to sidecar, inject path into draft text

Add to sidebar footer menu:
- "导出对话" button → calls exportConversation → triggers file save dialog
- "导入对话" button → file open dialog → reads JSON → calls importConversation

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/sidecar/router.ts apps/desktop/ui/src
git commit -m "feat(desktop): file attachment and conversation import/export"
```

---

### Task 10: Desktop UI — syntax highlighting and tool detail view

**Files:**
- Modify: `apps/desktop/ui/src/components/BlockRenderer.tsx`
- Modify: `apps/desktop/ui/src/components/ToolTimeline.tsx`
- Modify: `apps/desktop/ui/src/style.css`
- Check: `apps/desktop/ui/src/shiki.ts` (already exists)

**Interfaces:**
- Consumes: existing `shiki.ts`, existing `BlockRenderer.tsx`
- Produces: code blocks with syntax highlighting, expandable tool results

- [ ] **Step 1: Review existing shiki.ts**

```bash
cat apps/desktop/ui/src/shiki.ts
```
Check if it's already wired into the rendering pipeline.

- [ ] **Step 2: Wire shiki into code block rendering**

In `BlockRenderer.tsx`:
```tsx
import { codeToHtml } from '../shiki'
// When rendering a code block, call codeToHtml(language, code) and
// set dangerouslySetInnerHTML on a <div className="shiki-wrapper">
```

```tsx
// Before rendering:
const [html, setHtml] = useState('')
useEffect(() => {
  codeToHtml(language, code).then(setHtml)
}, [language, code])
```

- [ ] **Step 3: Add expandable tool detail view**

In `ToolTimeline.tsx`, add an expand/collapse for each tool result:

```tsx
const [expanded, setExpanded] = useState(false)

return (
  <div className={`tool-card ${expanded ? 'expanded' : ''}`}>
    <div className="tool-summary" onClick={() => step.resultSummary && setExpanded(!expanded)}>
      {/* existing summary */}
      {step.resultSummary && <button>{expanded ? '收起' : '查看详情'}</button>}
    </div>
    {expanded && (
      <pre className="tool-detail">{step.resultDetail || step.resultSummary}</pre>
    )}
  </div>
)
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/ui/src/components apps/desktop/ui/src/style.css
git commit -m "feat(desktop): syntax highlighting and expandable tool results"
```

---

### Task 11: Desktop UI — glassmorphic CSS redesign

**Files:**
- Modify: `apps/desktop/ui/src/style.css` (complete theme replacement)
- Modify: `apps/desktop/ui/src/App.tsx` (update theme tokens to glassmorphic palette)
- Modify: `apps/desktop/ui/src/components/*.tsx` (class name updates if needed)

**Interfaces:**
- Consumes: current dark theme as base
- Produces: full glassmorphic visual theme

- [ ] **Step 1: Replace Ant Design theme tokens in App.tsx**

```tsx
const orionTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorBgBase: '#0f0f1a',
    colorBgContainer: 'rgba(255,255,255,0.04)',
    colorBgElevated: 'rgba(255,255,255,0.06)',
    colorTextBase: 'rgba(255,255,255,0.85)',
    colorTextSecondary: 'rgba(255,255,255,0.5)',
    colorBorder: 'rgba(255,255,255,0.06)',
    colorPrimary: '#4fd1c5',
    colorPrimaryHover: '#6ee0d5',
    colorPrimaryActive: '#3bb8ac',
    colorLink: '#4fd1c5',
    colorError: '#ef4444',
    borderRadius: 10,
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontFamilyCode: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  },
  components: {
    Button: {
      colorPrimaryBg: 'rgba(79,209,197,0.15)',
      colorPrimaryText: '#4fd1c5',
    },
  },
}
```

- [ ] **Step 2: Replace global CSS background**

In `style.css`, replace the current body/shell background:

```css
body, .shell {
  background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
  min-height: 100vh;
}
```

- [ ] **Step 3: Glass card component styles**

```css
.glass-card {
  background: rgba(255,255,255,0.04);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px;
}

/* Chat messages */
.message-user {
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid rgba(99, 102, 241, 0.15);
  border-radius: 12px 4px 12px 12px;
}

.message-assistant {
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 4px 12px 12px 12px;
}

/* Sidebar */
.chat-sidebar {
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(12px);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

/* Tool cards */
.tool-card {
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}

/* Approval card */
.approval-card {
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}
.approval-allow {
  background: rgba(79, 209, 197, 0.15);
  color: #4fd1c5;
  border: 1px solid rgba(79, 209, 197, 0.2);
}
.approval-deny {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

/* Input area */
.composer-area {
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}

/* Status bar */
.status-dot.ok { background: #4fd1c5; box-shadow: 0 0 6px rgba(79, 209, 197, 0.4); }
.status-dot.warn { background: #f59e0b; }
.status-dot.off { background: #6b7280; }
```

- [ ] **Step 4: Apply brand mark / gradient ambient effect**

Add the subtle "ambient glow" to the shell:

```css
.ambient {
  position: fixed;
  pointer-events: none;
  z-index: 0;
}
.ambient-a {
  top: -20vh;
  right: -10vw;
  width: 60vw;
  height: 60vh;
  background: radial-gradient(ellipse at center, rgba(79, 209, 197, 0.06) 0%, transparent 70%);
}
.ambient-b {
  bottom: -10vh;
  left: -5vw;
  width: 40vw;
  height: 40vh;
  background: radial-gradient(ellipse at center, rgba(99, 102, 241, 0.06) 0%, transparent 70%);
}
```

- [ ] **Step 5: Verify UI renders correctly**

```bash
cd apps/desktop/ui && pnpm lint
```
No type/lint errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/src
git commit -m "feat(desktop): glassmorphic UI redesign with frosted glass cards"
```

---

### Task 12: Gateway process management in desktop

**Files:**
- Modify: `apps/desktop/sidecar/router.ts` (add /api/gateway/start, /api/gateway/stop)
- Modify: `apps/desktop/ui/src/api.ts` (add gatewayStart, gatewayStop)
- Modify: `apps/desktop/ui/src/App.tsx` (add gateway controls in diagnostics panel)

**Interfaces:**
- Consumes: `router.ts` extensibility
- Produces: start/stop gateway from desktop settings panel

- [ ] **Step 1: Add gateway endpoints to sidecar**

In `router.ts`:

```ts
let gatewayProcess: child_process.ChildProcess | null = null

export function handleGatewayStart(): void {
  // Spawn gateway as child process
  // gatewayProcess = spawn(...)
}

export function handleGatewayStop(): void {
  // Kill gateway process
  // gatewayProcess?.kill()
}

export function handleGatewayStatus(): { running: boolean; pid: number | null } {
  return { running: gatewayProcess !== null, pid: gatewayProcess?.pid ?? null }
}
```

- [ ] **Step 2: Add UI API functions**

In `api.ts`:

```ts
export async function startGateway(): Promise<void> {
  await fetchJson('/api/gateway/start', { method: 'POST' })
}
export async function stopGateway(): Promise<void> {
  await fetchJson('/api/gateway/stop', { method: 'POST' })
}
export async function gatewayStatus(): Promise<{ running: boolean; pid: number | null }> {
  return fetchJson('/api/gateway/status')
}
```

- [ ] **Step 3: Add gateway controls to diagnostics drawer**

In `App.tsx`, add start/stop buttons next to each gateway in the diagnostics section. Show running state, allow one-click toggle.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/sidecar/router.ts apps/desktop/ui/src
git commit -m "feat(desktop): gateway process management from settings panel"
```
