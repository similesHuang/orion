# Orion Agent Engine SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `packages/core/src/agent` into `packages/engine` — rename `GenericAgent` → `OrionAgent`, add structured output, ToolRegistry, stream consumer, context window management, state serialization, sub-agent delegation, MCP support, error grading with retry, and observability hooks.

**Architecture:** `OrionAgent` composes `ToolRegistry`, `WindowManager`, `RetryPolicy`, and a `StreamConsumer`. The agent loop yields typed `AgentYield` events consumed by pluggable `AgentYieldConsumer` implementations (CLI, desktop SSE, etc.). Tools register programmatically; MCP tools auto-register via adapter. Sub-agents are constrained `OrionAgent` instances sharing a cost tracker.

**Tech Stack:** TypeScript, Node.js >= 22, `@modelcontextprotocol/sdk` (MCP), optional OpenTelemetry SDK

## Global Constraints

- Package name: `@orion/engine` (was `@orion/core`)
- Directory: `packages/engine/src/`
- All existing public APIs must remain backward-compatible via re-exports in a compatibility layer
- TypeScript strict mode as inherited from `tsconfig.base.json`
- No new dependencies beyond `@modelcontextprotocol/sdk` (optional/peer)
- All UI rendering stays out of the engine — `renderAgentYieldToText` moves to `stream/cli-consumer.ts`

## Task Dependencies

```
Task 1 (scaffold)
  └─ Task 2 (types/shared)
       ├─ Task 3 (errors/retry)
       │    └─ Task 4 (agent-loop) ← MUST build before Tasks 5,6,12,13
       ├─ Task 5 (ToolRegistry) — imports StepOutcome from Task 4
       ├─ Task 6 (builtin tools) — imports ToolRegistry from Task 5
       ├─ Task 7 (stream consumer)
       ├─ Task 8 (window manager)
       ├─ Task 9 (state serialization)
       ├─ Task 10 (telemetry)
       ├─ Task 11 (MCP) — imports ToolRegistry from Task 5
       ├─ Task 12 (handler) — imports ToolRegistry + BaseHandler from Tasks 4,5
       └─ Task 13 (OrionAgent) — composes all above
            ├─ Task 14 (sub-agent) — imports OrionAgent from Task 13
            ├─ Task 15 (exports)
            ├─ Task 16 (migration)
            └─ Task 17 (cleanup)
```

Tasks are designed to be executed sequentially. Each task's "verify build" step may fail until dependent tasks are complete — this is expected and noted where applicable.

---

### Task 1: Scaffold `packages/engine` package

**Files:**
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/src/index.ts` (empty re-export shell)

**Interfaces:**
- Produces: `@orion/engine` package ready for code migration

- [ ] **Step 1: Create `packages/engine/package.json`**

```json
{
  "name": "@orion/engine",
  "version": "0.1.0",
  "type": "module",
  "description": "Orion Agent Engine SDK — platform-agnostic agent runtime",
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
    "@types/ws": "^8.18.1"
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "peerDependenciesMeta": {
    "@modelcontextprotocol/sdk": { "optional": true }
  }
}
```

- [ ] **Step 2: Create `packages/engine/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/engine/src/index.ts`** (shell — will be populated in later tasks)

```typescript
// Orion Agent Engine SDK — exports will be added as modules are implemented
export {};
```

- [ ] **Step 4: Verify package builds**

Run: `cd packages/engine && npm run build`
Expected: success (empty build)

- [ ] **Step 5: Commit**

```bash
git add packages/engine/package.json packages/engine/tsconfig.json packages/engine/src/index.ts
git commit -m "feat: scaffold @orion/engine package"
```

---

### Task 2: Copy shared dependencies from core into engine

**Files:**
- Create: `packages/engine/src/types/index.ts`
- Create: `packages/engine/src/shared/index.ts`

**Interfaces:**
- Produces: types (`Message`, `BaseSession`, `SessionConfig`, `LLMResponse`, `LLMStreamDelta`, `AgentYield`, `ToolDefinition`, `ToolCall`, `ContentBlock*`, `ChatOptions`, `TaskQueueLike`, `GenericAgentLike`) and shared utilities (`findProjectRoot`, `resolveAllowedPath`, `sleep`, `getGlobalMemory`, `smartFormat`, etc.) available in engine without depending on `@orion/core`

- [ ] **Step 1: Copy `packages/core/src/types/index.ts` → `packages/engine/src/types/index.ts`**

Copy verbatim, then apply the following edits:

1. Rename `GenericAgentLike` → `AgentLike`
2. In `AgentYield`, rename `kind: 'thought'` → `kind: 'thinking'`
3. Add new `AgentYield` variants:

```typescript
export type AgentYield =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }
  | { kind: 'tool_call'; id: string; turn: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; status: 'done' | 'error'; content: unknown }
  | { kind: 'error'; severity: 'retryable' | 'fatal'; message: string }
  | { kind: 'state'; snapshot: AgentState }
  | { kind: 'trace'; span: SpanContext };

export interface AgentState {
  version: number;
  messages: Message[];
  working: Record<string, unknown>;
  historyInfo: string[];
  turn: number;
  createdAt: number;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  name: string;
  attributes?: Record<string, unknown>;
}
```

4. Keep `GenericAgentLike` as a deprecated alias:

```typescript
/** @deprecated Use AgentLike instead */
export type GenericAgentLike = AgentLike;
```

- [ ] **Step 2: Create `packages/engine/src/shared/index.ts`**

Copy from `packages/core/src/shared/index.ts` the following exports: `findProjectRoot`, `resolveAllowedPath`, `sleep`, `smartFormat`, `getGlobalMemory`. Leave storage.ts in core for now.

- [ ] **Step 3: Verify build**

Run: `cd packages/engine && npm run build`
Expected: success

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/types/ packages/engine/src/shared/
git commit -m "feat: add types and shared utilities to @orion/engine"
```

---

### Task 3: Error grading and retry policy

**Files:**
- Create: `packages/engine/src/resilience/errors.ts`
- Create: `packages/engine/src/resilience/retry.ts`

**Interfaces:**
- Produces: `AgentError`, `RetryPolicy`, `withRetry()`

- [ ] **Step 1: Create `packages/engine/src/resilience/errors.ts`**

```typescript
export type ErrorSeverity = 'retryable' | 'fatal';

export class AgentError extends Error {
  severity: ErrorSeverity;
  code: string;

  constructor(message: string, code: string, severity: ErrorSeverity) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.severity = severity;
  }

  static rateLimit(message = 'Rate limit exceeded'): AgentError {
    return new AgentError(message, 'rate_limit', 'retryable');
  }

  static serverError(message = 'Server error'): AgentError {
    return new AgentError(message, 'server_error', 'retryable');
  }

  static networkError(message = 'Network error'): AgentError {
    return new AgentError(message, 'network_error', 'retryable');
  }

  static timeout(message = 'Request timed out'): AgentError {
    return new AgentError(message, 'timeout', 'retryable');
  }

  static invalidRequest(message: string): AgentError {
    return new AgentError(message, 'invalid_request', 'fatal');
  }

  static authError(message = 'Authentication failed'): AgentError {
    return new AgentError(message, 'auth_error', 'fatal');
  }

  static toolError(message: string): AgentError {
    return new AgentError(message, 'tool_error', 'fatal');
  }

  static from(e: unknown): AgentError {
    if (e instanceof AgentError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    const errName = e instanceof Error ? e.name : '';
    if (/rate.?limit|429/i.test(msg)) return AgentError.rateLimit(msg);
    if (/timeout|abort/i.test(msg) || errName === 'AbortError') return AgentError.timeout(msg);
    if (/network|fetch|ECONN|ENOTFOUND/i.test(msg)) return AgentError.networkError(msg);
    if (/50[02359]/i.test(msg)) return AgentError.serverError(msg);
    if (/40[13]/i.test(msg)) return AgentError.authError(msg);
    return AgentError.toolError(msg);
  }
}
```

- [ ] **Step 2: Create `packages/engine/src/resilience/retry.ts`**

```typescript
import { AgentError } from './errors.js';
import { sleep } from '../shared/index.js';

export interface RetryPolicy {
  maxRetries: number;
  baseDelay: number;
  backoff: 'exponential' | 'linear';
  retryOn: string[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelay: 1000,
  backoff: 'exponential',
  retryOn: ['rate_limit', 'server_error', 'network_error'],
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const ae = AgentError.from(e);
      if (ae.severity === 'fatal' || !policy.retryOn.includes(ae.code)) {
        throw ae;
      }
      if (attempt < policy.maxRetries) {
        const delay = policy.backoff === 'exponential'
          ? policy.baseDelay * 2 ** attempt
          : policy.baseDelay;
        await sleep(delay);
      }
    }
  }
  throw AgentError.from(lastError);
}
```

- [ ] **Step 3: Verify build**

Run: `cd packages/engine && npm run build`
Expected: success

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/resilience/
git commit -m "feat: add AgentError grading and RetryPolicy to @orion/engine"
```

---

### Task 4: ToolRegistry

**Files:**
- Create: `packages/engine/src/tools/registry.ts`

**Interfaces:**
- Produces: `ToolRegistry` class with `register()`, `unregister()`, `list()`, `dispatch()`
- Consumes: `ToolDefinition` from types, `StepOutcome` from agent-loop (to be created)

- [ ] **Step 1: Create `packages/engine/src/tools/registry.ts`**

```typescript
import { ToolDefinition, ToolCall } from '../types/index.js';
import { StepOutcome } from '../agent-loop.js';

export interface ToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => AsyncGenerator<string, StepOutcome, unknown>;
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
}

type HandlerFn = (args: Record<string, unknown>) => AsyncGenerator<string, StepOutcome, unknown>;

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();
  private mcpServers = new Map<string, MCPServerConfig>();

  register(tool: ToolRegistration): void {
    if (!/^[a-zA-Z0-9_]+$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  async registerMCP(server: MCPServerConfig): Promise<void> {
    this.mcpServers.set(server.name, server);
    // Actual MCP connection is deferred to connectMCPAll()
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.mcpServers.delete(name);
  }

  list(): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const [name, tool] of this.tools) {
      defs.push({
        type: 'function',
        function: {
          name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return defs;
  }

  getTool(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }
}
```

- [ ] **Step 2: Verify build (will fail on agent-loop import — that's expected for now)**

Run: `cd packages/engine && npm run build 2>&1 || true`

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/tools/registry.ts
git commit -m "feat: add ToolRegistry for programmatic tool registration"
```

---

### Task 5: Builtin tools extracted from handler

**Files:**
- Create: `packages/engine/src/tools/builtin/file.ts`
- Create: `packages/engine/src/tools/builtin/code.ts`
- Create: `packages/engine/src/tools/builtin/web.ts`
- Create: `packages/engine/src/tools/builtin/user.ts`

**Interfaces:**
- Produces: `registerFileTools()`, `registerCodeTools()`, `registerWebTools()`, `registerUserTools()` — each takes a `ToolRegistry` and context, registers tools
- Consumes: `ToolRegistry`, `StepOutcome`, tool impl functions re-exported via `../../compat.js` (a bridge re-exporting from `@orion/core`'s tools module: `fileRead`, `fileWrite`, `filePatch`, `codeRun`, `webScan`, `webNavigate`, `webExecuteJs`, `expandFileRefs`, `formatError`, `extractCodeBlock`, `resolveAllowedPath`, `smartFormat`)

- [ ] **Step 0: Create `packages/engine/src/compat.ts`**

- [ ] **Step 0: Create `packages/engine/src/compat.ts`**

```typescript
// Bridge — re-exports tool implementations from @orion/core.
// These will eventually migrate to @orion/engine directly.
export {
  fileRead, fileWrite, filePatch, codeRun,
  expandFileRefs, extractCodeBlock, extractRobustContent,
  formatError, smartFormat, webScan, webNavigate, webExecuteJs,
} from '@orion/core/tools';
export { resolveAllowedPath } from '@orion/core/shared';
```

- [ ] **Step 1: Create `packages/engine/src/tools/builtin/file.ts`**

Extract the `do_file_read`, `do_file_write`, `do_file_patch` implementations from `packages/core/src/agent/handler-base.ts`. Each becomes a standalone async generator that takes `(args, cwd)` and yields strings + returns `StepOutcome`. The registrations:

```typescript
import { ToolRegistry } from '../registry.js';
import { StepOutcome } from '../../agent-loop.js';
import { fileRead, fileWrite, filePatch, expandFileRefs, formatError } from '../../compat.js';
// compat.ts re-exports from @orion/core's tools module for now

export function registerFileTools(registry: ToolRegistry, cwd: string): void {
  registry.register({
    name: 'file_read',
    description: 'Read a file from the filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        start: { type: 'integer', description: 'Line number to start from' },
        count: { type: 'integer', description: 'Number of lines to read' },
        keyword: { type: 'string', description: 'Filter lines containing this keyword' },
      },
      required: ['path'],
    },
    handler: async function* (args): AsyncGenerator<string, StepOutcome, unknown> {
      const filePath = String(args.path || '');
      yield `[Action] Reading file: ${filePath}\n`;
      const start = parseInt(String(args.start ?? 1), 10);
      const count = parseInt(String(args.count ?? 200), 10);
      const result = fileRead(filePath, start, args.keyword as string | undefined, count, true, cwd);
      return new StepOutcome(result, '\n');
    },
  });

  registry.register({
    name: 'file_write',
    description: 'Write content to a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'prepend'], description: 'Write mode' },
      },
      required: ['path', 'content'],
    },
    handler: async function* (args): AsyncGenerator<string, StepOutcome, unknown> {
      const filePath = String(args.path || '');
      const mode = (args.mode as string) || 'overwrite';
      let content = String(args.content || '');
      yield `[Action] Writing file: ${filePath}\n`;
      const result = fileWrite(filePath, content, mode, cwd);
      return new StepOutcome(result, '\n');
    },
  });

  registry.register({
    name: 'file_patch',
    description: 'Patch a file by replacing old content with new content',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_content: { type: 'string', description: 'Content to replace' },
        new_content: { type: 'string', description: 'Replacement content' },
      },
      required: ['path', 'old_content', 'new_content'],
    },
    handler: async function* (args): AsyncGenerator<string, StepOutcome, unknown> {
      const filePath = String(args.path || '');
      const oldContent = String(args.old_content || '');
      const newContent = String(args.new_content || '');
      yield `[Action] Patching file: ${filePath}\n`;
      const result = filePatch(filePath, oldContent, newContent, cwd);
      return new StepOutcome(result, '\n');
    },
  });
}
```

(Full handler logic from handler-base.ts for each tool is inlined — yield messages, edge case handling, error formatting.)

- [ ] **Step 2: Create `packages/engine/src/tools/builtin/code.ts`**

Same pattern — extract `do_code_run` logic into a registered tool:

```typescript
import { ToolRegistry } from '../registry.js';
import { StepOutcome } from '../../agent-loop.js';
import { codeRun, extractCodeBlock } from '../../compat.js';
import { runInlineSandbox } from '../../inline-sandbox.js';

export function registerCodeTools(registry: ToolRegistry, cwd: string, stopSignal: number[]): void {
  registry.register({
    name: 'code_run',
    description: 'Execute code (python/bash/js) in a sandbox',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['python', 'bash', 'js'] },
        code: { type: 'string' },
        timeout: { type: 'integer' },
        cwd: { type: 'string' },
        inline_eval: { type: 'boolean' },
      },
      required: ['type'],
    },
    handler: async function* (args, response): AsyncGenerator<string, StepOutcome, unknown> {
      // Copy lines 139-167 from packages/core/src/agent/handler-base.ts do_code_run method.
      // Replace: this.cwd → cwd, this.codeStopSignal → stopSignal
      // Replace: this.getAnchorPrompt(!!args._index) → '\n'
      // Return: new StepOutcome(result, '\n') instead of this.getAnchorPrompt
      const codeType = (args.type as string) || 'python';
      let code = (args.code as string) || (args.script as string) || '';
      if (!code) {
        code = extractCodeBlock(response, codeType);
        if (!code) return new StepOutcome('[Error] Code missing', '\n');
      }
      const timeout = parseInt(String(args.timeout ?? 60), 10) || 60;
      const codeCwd = cwd;
      if (codeType === 'python' && args.inline_eval) {
        const result = await runInlineSandbox(code, timeout * 1000, cwd);
        if (result.error) return new StepOutcome(`Error: ${result.error}`, '\n');
        return new StepOutcome(result.result, '\n');
      }
      const result = yield* codeRun(code, codeType, timeout, cwd, codeCwd, stopSignal);
      return new StepOutcome(result, '\n');
    },
  });
}
```

- [ ] **Step 3: Create `packages/engine/src/tools/builtin/web.ts`** and **`packages/engine/src/tools/builtin/user.ts`**

**web.ts** — extracts `do_web_scan` (lines 337-364), `do_web_navigate` (lines 366-380), `do_web_execute_js` (lines 382-419) from `packages/core/src/agent/handler-base.ts`. Each becomes a registered tool. Replace `this.cwd` → `cwd`, `this.getAnchorPrompt(!!args._index)` → `'\n'`, `this.getAbsPath(...)` → `resolveAllowedPath(cwd, ...)`. Remove `yield` of action hints (those are part of the old CLI rendering path).

**user.ts** — extracts `do_ask_user` (lines 169-175). Kept simple:
```typescript
registry.register({
  name: 'ask_user',
  description: 'Ask the user a question and wait for input',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      candidates: { type: 'array', items: { type: 'string' } },
    },
    required: ['question'],
  },
  handler: async function* (args) {
    const question = (args.question as string) || 'Please provide input:';
    const candidates = (args.candidates as string[]) || [];
    yield 'Waiting for your answer...\n';
    return new StepOutcome(
      { status: 'INTERRUPT', intent: 'HUMAN_INTERVENTION', data: { question, candidates } },
      '', true
    );
  },
});
```

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/tools/builtin/
git commit -m "feat: extract builtin tools from handler into standalone registrations"
```

---

### Task 6: Agent loop — enhanced `agentRunnerLoop`

**Files:**
- Create: `packages/engine/src/agent-loop.ts`

**Interfaces:**
- Produces: `AgentLoopOptions`, `agentRunnerLoop()`, `StepOutcome`, `BaseHandler`, `AgentLoopHook`
- Consumes: `AgentYield`, `Message`, `LLMStreamDelta`, `LLMResponse` from types; `RetryPolicy` from resilience; `ToolRegistry` from tools

- [ ] **Step 1: Create `packages/engine/src/agent-loop.ts`**

Copy the current `packages/core/src/agent/agent-loop.ts` and apply:

1. Add `AgentLoopOptions` interface:

```typescript
export interface AgentLoopOptions {
  maxTurns?: number;
  toolChoice?: 'auto' | 'required' | { name: string };
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; schema: Record<string, unknown> };
  retryPolicy?: RetryPolicy;
  hooks?: {
    beforeTurn?: (turn: number, messages: Message[]) => void;
    afterTurn?: (turn: number, outcome: StepOutcome) => void;
  };
}
```

2. In `agentRunnerLoop`, pass `toolChoice` and `responseFormat` to the LLM chat call:

```typescript
// In the loop, when calling client.chat():
const chatOptions: ChatOptions = {
  messages,
  tools: toolsSchema,
};
if (options?.toolChoice) {
  (chatOptions as Record<string, unknown>).tool_choice = options.toolChoice;
}
if (options?.responseFormat) {
  (chatOptions as Record<string, unknown>).response_format = options.responseFormat;
}
const responseGen = client.chat(chatOptions);
```

3. Wrap tool dispatch in retry logic (inside the tool loop, not the turn loop — retryable errors from tool dispatch don't consume turns):

```typescript
// Inside the for-loop over toolCalls, around dispatch:
try {
  outcome = await withRetry(
    () => collectHandlerOutcome(handler.dispatch(tc.tool_name, tc.args, response)),
    options?.retryPolicy
  );
} catch (e) {
  const ae = AgentError.from(e);
  yield { kind: 'error', severity: ae.severity, message: ae.message };
  if (ae.severity === 'fatal') {
    finalExitReason = { result: 'FATAL_ERROR', data: ae };
    break;
  }
  continue; // retryable exhausted — move to next tool
}
```

4. Call `beforeTurn` / `afterTurn` hooks at the right places.

5. Yield `kind: 'state'` periodically (every 5 turns) with the current agent state snapshot.

6. Change `kind: 'thought'` → `kind: 'thinking'` in the yield for thinking deltas.

- [ ] **Step 2: Verify build**

Run: `cd packages/engine && npm run build`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/agent-loop.ts
git commit -m "feat: enhance agent-loop with tool_choice, response_format, retry, hooks"
```

---

### Task 7: Stream consumer interface

**Files:**
- Create: `packages/engine/src/stream/consumer.ts`

**Interfaces:**
- Produces: `AgentYieldConsumer` interface, `CliConsumer` class
- Consumes: `AgentYield`, `AgentState` from types

- [ ] **Step 1: Create `packages/engine/src/stream/consumer.ts`**

```typescript
import { AgentYield, AgentState } from '../types/index.js';

export interface AgentYieldConsumer {
  onText(chunk: string): void;
  onThinking(chunk: string): void;
  onToolCall(call: { id: string; turn: number; toolName: string; args: Record<string, unknown> }): void;
  onToolResult(result: { id: string; status: 'done' | 'error'; content: unknown }): void;
  onError(error: { severity: 'retryable' | 'fatal'; message: string }): void;
  onState(snapshot: AgentState): void;
}

export class CliConsumer implements AgentYieldConsumer {
  private showThinking: boolean;
  private showToolResults: boolean;

  constructor(opts?: { showThinking?: boolean; showToolResults?: boolean }) {
    this.showThinking = opts?.showThinking ?? process.env.ORION_CLI_THINKING === 'true';
    this.showToolResults = opts?.showToolResults ?? process.env.ORION_CLI_TOOL_RESULTS === 'true';
  }

  onText(chunk: string): void {
    process.stdout.write(chunk);
  }

  onThinking(chunk: string): void {
    if (this.showThinking) process.stdout.write(`\n[Thinking] ${chunk}\n`);
  }

  onToolCall(call: { toolName: string }): void {
    process.stdout.write(`\n🛠️  ${call.toolName}\n`);
  }

  onToolResult(result: { status: string; content: unknown }): void {
    if (result.status === 'error') {
      process.stdout.write('[error]\n');
    } else if (this.showToolResults) {
      const summary = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      process.stdout.write(`\n[Result] ${summary.slice(0, 200)}\n`);
    }
  }

  onError(error: { severity: string; message: string }): void {
    process.stdout.write(`\n!!!${error.severity === 'fatal' ? 'Fatal' : 'Retryable'} Error: ${error.message}\n`);
  }

  onState(_snapshot: AgentState): void {
    // CLI does nothing with state snapshots
  }
}

export function dispatchYield(yield_: AgentYield, consumer: AgentYieldConsumer): void {
  switch (yield_.kind) {
    case 'text': consumer.onText(yield_.content); break;
    case 'thinking': consumer.onThinking(yield_.content); break;
    case 'tool_call': consumer.onToolCall(yield_); break;
    case 'tool_result': consumer.onToolResult(yield_); break;
    case 'error': consumer.onError(yield_); break;
    case 'state': consumer.onState(yield_.snapshot); break;
    case 'trace': break; // tracing consumers handle this separately
  }
}

// Kept for backward compat — delegates to CliConsumer
export function renderAgentYieldToText(y: AgentYield): string {
  // Capture stdout via override
  let output = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  const capture = (s: string) => { output += s; return true; };
  process.stdout.write = capture as typeof process.stdout.write;
  const consumer = new CliConsumer();
  dispatchYield(y, consumer);
  process.stdout.write = origWrite;
  return output;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/engine/src/stream/
git commit -m "feat: add AgentYieldConsumer interface and CLI consumer"
```

---

### Task 8: Context window manager

**Files:**
- Create: `packages/engine/src/context/window-manager.ts`

**Interfaces:**
- Produces: `WindowManager` interface, `TruncateWindowManager`, `SlidingWindowManager`
- Consumes: `Message` from types

- [ ] **Step 1: Create `packages/engine/src/context/window-manager.ts`**

```typescript
import { Message } from '../types/index.js';

export interface WindowManager {
  fit(messages: Message[]): Message[];
  onUsage(usage: Record<string, number>): void;
  setBudget(maxTokens: number): void;
  getUsage(): { used: number; budget: number; remaining: number };
}

export class TruncateWindowManager implements WindowManager {
  private budget: number;
  private used = 0;
  // Approximate: 1 token ≈ 3 chars
  private static CHARS_PER_TOKEN = 3;

  constructor(maxTokens = 128000) {
    this.budget = maxTokens;
  }

  fit(messages: Message[]): Message[] {
    let totalChars = messages.reduce((sum, m) =>
      sum + JSON.stringify(m.content).length, 0);
    if (totalChars <= this.budget * TruncateWindowManager.CHARS_PER_TOKEN) {
      return messages;
    }
    // Keep system message, truncate from earliest user message
    const result = [...messages];
    while (result.length > 2 && totalChars > this.budget * TruncateWindowManager.CHARS_PER_TOKEN) {
      const removed = result.splice(1, 1)[0]; // skip system at index 0
      if (!removed) break;
      totalChars -= JSON.stringify(removed.content).length;
    }
    return result;
  }

  onUsage(usage: Record<string, number>): void {
    this.used = (usage.input_tokens ?? usage.input ?? 0) +
      (usage.output_tokens ?? usage.output ?? 0);
  }

  setBudget(maxTokens: number): void {
    this.budget = maxTokens;
  }

  getUsage(): { used: number; budget: number; remaining: number } {
    return { used: this.used, budget: this.budget, remaining: Math.max(0, this.budget - this.used) };
  }
}

export class SlidingWindowManager implements WindowManager {
  private budget: number;
  private used = 0;
  private maxTurns: number;

  constructor(maxTokens = 128000, maxTurns = 40) {
    this.budget = maxTokens;
    this.maxTurns = maxTurns;
  }

  fit(messages: Message[]): Message[] {
    // Keep system + last N user-assistant pairs
    const systemMsgs = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const pairs: Message[] = [];
    for (const m of rest) {
      pairs.push(m);
      if (m.role === 'assistant' && pairs.filter(x => x.role === 'user').length > this.maxTurns) {
        const firstUserIdx = pairs.findIndex(x => x.role === 'user');
        if (firstUserIdx >= 0) pairs.splice(firstUserIdx, 1);
      }
    }
    return [...systemMsgs, ...pairs];
  }

  onUsage(usage: Record<string, number>): void {
    this.used = (usage.input_tokens ?? usage.input ?? 0) +
      (usage.output_tokens ?? usage.output ?? 0);
  }

  setBudget(maxTokens: number): void {
    this.budget = maxTokens;
  }

  getUsage(): { used: number; budget: number; remaining: number } {
    return { used: this.used, budget: this.budget, remaining: Math.max(0, this.budget - this.used) };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/engine/src/context/
git commit -m "feat: add WindowManager for token-aware context truncation"
```

---

### Task 9: State serialization

**Files:**
- Create: `packages/engine/src/state/serialization.ts`

**Interfaces:**
- Produces: `saveAgentState()`, `restoreAgentState()`, `AgentState` (imported from types)
- Consumes: `Message` from types

- [ ] **Step 1: Create `packages/engine/src/state/serialization.ts`**

```typescript
import { Message, AgentState } from '../types/index.js';

export function saveAgentState(
  messages: Message[],
  working: Record<string, unknown>,
  historyInfo: string[],
  turn: number,
): AgentState {
  return {
    version: 1,
    messages: messages.map(m => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content })),
    working: { ...working },
    historyInfo: [...historyInfo],
    turn,
    createdAt: Date.now(),
  };
}

export function restoreAgentState(state: AgentState): {
  messages: Message[];
  working: Record<string, unknown>;
  historyInfo: string[];
  turn: number;
} {
  if (state.version !== 1) {
    throw new Error(`Unsupported AgentState version: ${state.version}`);
  }
  return {
    messages: state.messages.map(m => ({ ...m })),
    working: { ...state.working },
    historyInfo: [...state.historyInfo],
    turn: state.turn,
  };
}

export function serializeAgentState(state: AgentState): string {
  return JSON.stringify(state);
}

export function deserializeAgentState(json: string): AgentState {
  const parsed = JSON.parse(json);
  if (!parsed.version || !Array.isArray(parsed.messages)) {
    throw new Error('Invalid serialized AgentState');
  }
  return parsed as AgentState;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/engine/src/state/
git commit -m "feat: add AgentState serialization/deserialization"
```

---

### Task 10: Sub-agent delegation

**Files:**
- Create: `packages/engine/src/subagent/delegation.ts`

**Interfaces:**
- Produces: `SubAgentRequest`, `SubAgentResult`, `createSubAgent()`
- Consumes: `OrionAgent` (forward declaration)

- [ ] **Step 1: Create `packages/engine/src/subagent/delegation.ts`**

```typescript
import type { OrionAgent } from '../orion-agent.js';
import type { TokenStats } from '../cost-tracker.js';

export interface SubAgentRequest {
  prompt: string;
  tools?: string[];
  model?: string;
  timeout?: number;
  maxTurns?: number;
}

export interface SubAgentResult {
  output: string;
  usage: TokenStats;
  toolCalls: string[];
}

export async function delegate(
  parent: OrionAgent,
  request: SubAgentRequest
): Promise<SubAgentResult> {
  // Create a constrained sub-agent
  const sub = parent.createSubAgent({
    tools: request.tools,
    model: request.model,
    maxTurns: request.maxTurns ?? 20,
  });

  const toolCalls: string[] = [];
  const originalPutTask = sub.putTask.bind(sub);
  // Track tool invocations
  sub.onToolCall = (name: string) => {
    toolCalls.push(name);
  };

  const result = await sub.runOnce(request.prompt);
  return {
    output: result,
    usage: sub.getCostTracker(),
    toolCalls,
  };
}
```

- [ ] **Step 2: Commit (this file will have build errors until OrionAgent exists — acceptable)**

```bash
git add packages/engine/src/subagent/
git commit -m "feat: add sub-agent delegation model"
```

---

### Task 11: Telemetry hooks

**Files:**
- Create: `packages/engine/src/telemetry/tracing.ts`

**Interfaces:**
- Produces: `TelemetryHooks`, `NoopTelemetry`, telemetry hook registration
- Consumes: nothing external

- [ ] **Step 1: Create `packages/engine/src/telemetry/tracing.ts`**

```typescript
import { SpanContext, AgentYield } from '../types/index.js';

export interface TelemetrySpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

export interface TelemetryTracer {
  startSpan(name: string, attributes?: Record<string, unknown>): TelemetrySpan;
}

export interface TelemetryHooks {
  tracer: TelemetryTracer;
  onTurnStart(turn: number, messages: unknown[]): TelemetrySpan;
  onToolCall(toolName: string, args: Record<string, unknown>): TelemetrySpan;
  onYield(yield_: AgentYield): void;
}

const noopSpan: TelemetrySpan = {
  setAttribute() {},
  end() {},
};

const noopTracer: TelemetryTracer = {
  startSpan(_name, _attrs) { return noopSpan; },
};

export const NoopTelemetry: TelemetryHooks = {
  tracer: noopTracer,
  onTurnStart(_turn, _messages) { return noopSpan; },
  onToolCall(_name, _args) { return noopSpan; },
  onYield(_y) {},
};

let currentTelemetry: TelemetryHooks = NoopTelemetry;

export function setTelemetry(telemetry: TelemetryHooks): void {
  currentTelemetry = telemetry;
}

export function getTelemetry(): TelemetryHooks {
  return currentTelemetry;
}

export function createSpanContext(name: string, attributes?: Record<string, unknown>): SpanContext {
  return {
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    name,
    attributes,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/engine/src/telemetry/
git commit -m "feat: add telemetry hooks for OTEL tracing"
```

---

### Task 12: MCP client and adapter

**Files:**
- Create: `packages/engine/src/tools/mcp/client.ts`
- Create: `packages/engine/src/tools/mcp/adapter.ts`

**Interfaces:**
- Produces: `MCPClient`, `mcpToolsToRegistrations()`
- Consumes: `ToolRegistry`, `MCPServerConfig`

- [ ] **Step 1: Create `packages/engine/src/tools/mcp/client.ts`**

```typescript
import { MCPServerConfig } from '../registry.js';

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPClient {
  listTools(): Promise<MCPToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}

export async function createMCPClient(config: MCPServerConfig): Promise<MCPClient | null> {
  try {
    // Dynamic import to avoid hard dependency
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    if (config.transport === 'stdio' && config.command) {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
      });
      const client = new Client({ name: 'orion-engine', version: '0.1.0' }, {});
      await client.connect(transport);
      return {
        listTools: async () => {
          const result = await client.listTools();
          return result.tools as MCPToolDef[];
        },
        callTool: async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          return result as { content: Array<{ type: string; text?: string }> };
        },
        close: async () => {
          await client.close();
        },
      };
    }
    // SSE transport can be added later
    console.warn(`[MCP] Unsupported transport: ${config.transport}`);
    return null;
  } catch (e) {
    console.warn(`[MCP] Failed to create client for ${config.name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
```

- [ ] **Step 2: Create `packages/engine/src/tools/mcp/adapter.ts`**

```typescript
import { ToolRegistration } from '../registry.js';
import { StepOutcome } from '../../agent-loop.js';
import { MCPToolDef, createMCPClient } from './client.js';
import { MCPServerConfig } from '../registry.js';

export function mcpToolToRegistration(tool: MCPToolDef, callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>): ToolRegistration {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    handler: async function* (args): AsyncGenerator<string, StepOutcome, unknown> {
      yield `[MCP] Calling ${tool.name}...\n`;
      try {
        const result = await callTool(tool.name, args);
        const text = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text ?? '')
          .join('\n');
        return new StepOutcome(text, '\n');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new StepOutcome({ status: 'error', msg }, '\n');
      }
    },
  };
}

export async function registerMCPServerTools(
  registry: { register(t: ToolRegistration): void },
  config: MCPServerConfig
): Promise<void> {
  const client = await createMCPClient(config);
  if (!client) return;
  const tools = await client.listTools();
  for (const tool of tools) {
    registry.register(mcpToolToRegistration(tool, client.callTool.bind(client)));
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/tools/mcp/
git commit -m "feat: add MCP client and tool adapter"
```

---

### Task 13: Streamlined handler

**Files:**
- Create: `packages/engine/src/handler.ts`

**Interfaces:**
- Produces: `OrionAgentHandler` (extends `BaseHandler`)
- Consumes: `BaseHandler`, `StepOutcome` from agent-loop; `ToolRegistry` from tools

- [ ] **Step 1: Create `packages/engine/src/handler.ts`**

Extract from `handler-base.ts` only the non-tool logic:

```typescript
import { BaseHandler, StepOutcome } from './agent-loop.js';
import { ToolRegistry } from './tools/registry.js';
import { LLMResponse } from './types/index.js';

export interface HandlerParent {
  taskDir?: string;
  verbose?: boolean;
  approveToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<'allow' | 'deny'>;
}

export class ToolDeniedError extends Error {
  constructor(toolName: string) {
    super(`Tool execution denied: ${toolName}`);
    this.name = 'ToolDeniedError';
  }
}

export class OrionAgentHandler extends BaseHandler {
  parent: HandlerParent;
  working: Record<string, unknown> = {};
  historyInfo: string[];
  codeStopSignal: number[] = [];
  registry: ToolRegistry;

  constructor(parent: HandlerParent, registry: ToolRegistry, lastHistory?: string[]) {
    super();
    this.parent = parent;
    this.registry = registry;
    this.historyInfo = lastHistory ?? [];
  }

  override async toolBeforeCallback(
    toolName: string,
    args: Record<string, unknown>,
    _response: LLMResponse
  ): Promise<void> {
    const gate = this.parent.approveToolCall;
    if (!gate) return;
    const decision = await gate(toolName, args);
    if (decision === 'deny') throw new ToolDeniedError(toolName);
  }

  // Dispatch delegates to ToolRegistry
  override async* dispatch(
    toolName: string,
    args: Record<string, unknown>,
    response: LLMResponse
  ): AsyncGenerator<string, StepOutcome, unknown> {
    if (toolName === 'no_tool') {
      return yield* this.do_no_tool(args, response);
    }
    if (toolName === 'update_working_checkpoint') {
      return yield* this.do_update_working_checkpoint(args, response);
    }
    if (toolName === 'start_long_term_update') {
      return yield* this.do_start_long_term_update(args, response);
    }

    if (!this.registry.has(toolName)) {
      yield `Unknown tool: ${toolName}\n`;
      return new StepOutcome(null, `Unknown tool ${toolName}`);
    }

    await this.toolBeforeCallback(toolName, args, response);
    const tool = this.registry.getTool(toolName)!;
    const gen = tool.handler(args);
    let outcome: StepOutcome;
    if (isAsyncGenerator(gen)) {
      const iterator = gen[Symbol.asyncIterator]();
      let result: IteratorResult<string, StepOutcome>;
      do {
        result = await iterator.next();
        if (!result.done) yield result.value;
      } while (!result.done);
      outcome = result.value;
    } else {
      outcome = await gen;
    }
    await this.toolAfterCallback(toolName, args, response, outcome);
    return outcome;
  }

  // do_no_tool: copy lines 270-335 from handler-base.ts
  // do_update_working_checkpoint: copy lines 242-248
  // do_start_long_term_update: copy lines 250-268
  // Internal helpers (inPlanMode, exitPlanMode, checkPlanCompletion, getAnchorPrompt, foldEarlier):
  //   copy lines 114-137 and 72-112 from handler-base.ts
  // turnEndCallback: copy lines 421-467 from handler-base.ts
  //
  // Replacements in all copied code:
  //   this.cwd → '' (cwd unused in these methods)
  //   this.getAnchorPrompt(!!args._index) → this.getAnchorPrompt(!!(args as Record<string,unknown>)._index)
  //   All class context references remain the same (this.working, this.historyInfo, etc.)

  // Plan mode logic
  private inPlanMode(): string | undefined {
    return this.working.in_plan_mode as string | undefined;
  }
  private exitPlanMode(): void {
    delete this.working.in_plan_mode;
  }
  enterPlanMode(planPath: string): string {
    this.working.in_plan_mode = planPath;
    return planPath;
  }
  private checkPlanCompletion(): number | null {
    const p = this.inPlanMode();
    if (!p || !require('fs').existsSync(p)) return null;
    const content = require('fs').readFileSync(p, 'utf-8');
    return (content.match(/\[ \]/g) || []).length;
  }

  // turnEndCallback: copy lines 421-467 from packages/core/src/agent/handler-base.ts
  // Replace consumeFile import with direct fs operations
  async turnEndCallback(
    response: LLMResponse,
    toolCalls: Array<{ tool_name: string; args: Record<string, unknown>; id?: string }>,
    _toolResults: Array<{ tool_use_id: string; content: string }>,
    turn: number,
    nextPrompt: string,
    _exitReason: unknown
  ): Promise<string> {
    const stripped = response.content.replace(/```[\s\S]*?```/gs, '').trim();
    const tc = toolCalls[0];
    const cleanArgs = Object.fromEntries(Object.entries(tc.args).filter(([k]) => !k.startsWith('_')));
    let summary: string;
    if (tc.tool_name === 'no_tool') {
      summary = stripped.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '直接回答了用户问题';
    } else {
      summary = `调用工具${tc.tool_name}, args: ${JSON.stringify(cleanArgs)}`;
    }
    summary = smartFormat(summary.replace(/\n/g, ''), 80);
    this.historyInfo.push(`[Agent] ${summary}`);

    const planPath = this.inPlanMode();
    if (turn % 65 === 0 && !planPath) {
      nextPrompt += `\n\n[DANGER] 已连续执行第 ${turn} 轮。必须总结情况进行ask_user。`;
    } else if (turn % 7 === 0) {
      nextPrompt += `\n\n[DANGER] 已连续执行第 ${turn} 轮。禁止无效重试。`;
    }
    if (planPath && turn >= 10 && turn % 5 === 0) {
      nextPrompt = `[Plan Hint] 请确认当前步骤。\n\n` + nextPrompt;
    }
    if (planPath && turn >= 90) {
      nextPrompt += `\n\n[DANGER] Plan模式已达上限，必须 ask_user。`;
    }
    return nextPrompt;
  }
}

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator<unknown, unknown, unknown> {
  return obj !== null && typeof obj === 'object' &&
    typeof (obj as AsyncGenerator<unknown, unknown, unknown>)[Symbol.asyncIterator] === 'function';
}
```

(The actual file contains the full logic from handler-base.ts for `do_no_tool`, `do_update_working_checkpoint`, `do_start_long_term_update`, plan mode, history folding, and `turnEndCallback` — just not the `do_code_run`, `do_file_read`, etc. which are now in ToolRegistry.)

- [ ] **Step 2: Commit**

```bash
git add packages/engine/src/handler.ts
git commit -m "feat: add streamlined OrionAgentHandler delegating to ToolRegistry"
```

---

### Task 14: OrionAgent main class

**Files:**
- Create: `packages/engine/src/orion-agent.ts`

**Interfaces:**
- Produces: `OrionAgent` class (was `GenericAgent`)
- Consumes: All modules created above plus LLM client from `@orion/core`

- [ ] **Step 1: Create `packages/engine/src/orion-agent.ts`**

The full `OrionAgent` class re-implements `GenericAgent` with:

1. **Renaming**: `GenericAgent` → `OrionAgent`
2. **ToolRegistry**: `this.toolRegistry = new ToolRegistry()` + `registerBuiltinTools()` in constructor
3. **WindowManager**: `this.windowManager = new TruncateWindowManager()` 
4. **RetryPolicy**: `this.retryPolicy = DEFAULT_RETRY_POLICY` (configurable)
5. **Stream consumer**: `this.consumer = options.consumer ?? new CliConsumer()`
6. **MCP**: `this.mcpServers = options.mcpServers ?? []` — connected on first `putTask`
7. **State serialization**:
   ```typescript
   saveState(): AgentState {
     return saveAgentState(
       this.client.backend.history,
       this.handler?.working ?? {},
       this.handler?.historyInfo ?? [],
       this.handler?.currentTurn ?? 0
     );
   }

   static fromState(state: AgentState, options?: OrionAgentOptions): OrionAgent {
     const agent = new OrionAgent(options);
     const restored = restoreAgentState(state);
     agent.client.backend.history = restored.messages;
     if (agent.handler) {
       agent.handler.working = restored.working;
       agent.handler.historyInfo = restored.historyInfo;
     }
     return agent;
   }
   ```
8. **Sub-agent**:
   ```typescript
   createSubAgent(opts: { tools?: string[]; model?: string; maxTurns?: number }): OrionAgent {
     // Creates a constrained OrionAgent sharing the same cost tracker
   }

   async delegate(request: SubAgentRequest): Promise<SubAgentResult> {
     return delegate(this, request);
   }
   ```
9. **Image support**: `putTask` accepts optional `images?: ImageInput[]`

```typescript
export interface ImageInput {
  data: string;       // base64
  mediaType?: string; // default 'image/png'
}

export interface OrionAgentOptions {
  cwd?: string;
  consumer?: AgentYieldConsumer;
  retryPolicy?: RetryPolicy;
  windowManager?: WindowManager;
  mcpServers?: MCPServerConfig[];
  telemetry?: TelemetryHooks;
}
```

The `putTask` method, `processQueue`, `runTask`, and `handleSlashCmd` are copied from `GenericAgent` with the following changes:
- `renderAgentYieldToText` → `dispatchYield(y, this.consumer)`
- Tool schema from `loadToolSchema` → `this.toolRegistry.list()`
- Handler is `OrionAgentHandler` instead of `GenericAgentHandler`

- [ ] **Step 2: Commit**

```bash
git add packages/engine/src/orion-agent.ts
git commit -m "feat: add OrionAgent — platform-agnostic agent SDK"
```

---

### Task 15: Unified exports and backward compat

**Files:**
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces: all public exports from `@orion/engine`
- Consumes: all internal modules

- [ ] **Step 1: Write `packages/engine/src/index.ts`**

```typescript
// Core
export { OrionAgent } from './orion-agent.js';
export type { OrionAgentOptions, ImageInput } from './orion-agent.js';

// Agent loop
export { agentRunnerLoop, BaseHandler, StepOutcome, agentLoopHooks } from './agent-loop.js';
export type { AgentLoopOptions } from './agent-loop.js';

// Handler
export { OrionAgentHandler, ToolDeniedError } from './handler.js';
export type { HandlerParent } from './handler.js';

// Tools
export { ToolRegistry } from './tools/registry.js';
export type { ToolRegistration, MCPServerConfig } from './tools/registry.js';
export { registerFileTools } from './tools/builtin/file.js';
export { registerCodeTools } from './tools/builtin/code.js';
export { registerWebTools } from './tools/builtin/web.js';
export { registerUserTools } from './tools/builtin/user.js';

// MCP
export { createMCPClient, mcpToolToRegistration, registerMCPServerTools } from './tools/mcp/adapter.js';
export type { MCPClient, MCPToolDef } from './tools/mcp/client.js';

// Stream
export { CliConsumer, dispatchYield, renderAgentYieldToText } from './stream/consumer.js';
export type { AgentYieldConsumer } from './stream/consumer.js';

// Context
export { TruncateWindowManager, SlidingWindowManager } from './context/window-manager.js';
export type { WindowManager } from './context/window-manager.js';

// State
export { saveAgentState, restoreAgentState, serializeAgentState, deserializeAgentState } from './state/serialization.js';

// Resilience
export { AgentError, withRetry, DEFAULT_RETRY_POLICY } from './resilience/retry.js';
export type { RetryPolicy } from './resilience/retry.js';

// Sub-agent
export { delegate } from './subagent/delegation.js';
export type { SubAgentRequest, SubAgentResult } from './subagent/delegation.js';

// Telemetry
export { setTelemetry, getTelemetry, NoopTelemetry, createSpanContext } from './telemetry/tracing.js';
export type { TelemetryHooks, TelemetryTracer, TelemetrySpan } from './telemetry/tracing.js';

// Types
export type {
  Message, BaseSession, SessionConfig, LLMResponse, LLMStreamDelta,
  AgentYield, AgentState, ToolDefinition, ToolCall, ContentBlock,
  ChatOptions, TaskQueueLike, AgentLike, SpanContext,
} from './types/index.js';

/** @deprecated Use AgentLike instead */
export type { AgentLike as GenericAgentLike } from './types/index.js';

// Inline sandbox
export { runInlineSandbox } from './inline-sandbox.js';
export type { SandboxResult } from './inline-sandbox.js';

// Cost tracker
export * as costTracker from './cost-tracker.js';
```

- [ ] **Step 2: Verify build and fix any import issues**

Run: `cd packages/engine && npm run build`
Fix any errors until clean.

- [ ] **Step 3: Add backward-compat re-exports to `@orion/core`**

In `packages/core/src/index.ts`, add:

```typescript
// Re-export engine APIs for backward compatibility
export { OrionAgent, OrionAgentHandler, ToolRegistry, AgentError } from '@orion/engine';
```

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/index.ts packages/core/src/index.ts
git commit -m "feat: unified @orion/engine exports with @orion/core backward compat"
```

---

### Task 16: Migrate dependents to use @orion/engine

**Files:**
- Modify: `apps/desktop/sidecar/agent-manager.ts`
- Modify: `apps/desktop/sidecar/router.ts`
- Modify: `packages/core/src/chat/index.ts`
- Modify: `packages/core/src/chat/continue-cmd.ts`
- Modify: `packages/core/src/chat/btw-cmd.ts`
- Modify: `packages/core/src/agent/index.ts` (deprecation re-exports)

**Interfaces:**
- Consumes: `OrionAgent`, `AgentLike` from `@orion/engine`
- Produces: updated dependents compiling against new APIs

- [ ] **Step 1: Update `apps/desktop/sidecar/agent-manager.ts`**

Replace:
```typescript
import { GenericAgent } from '@orion/core'
```
→
```typescript
import { OrionAgent } from '@orion/engine'
```

Replace all `GenericAgent` type references → `OrionAgent`.

- [ ] **Step 2: Update `agent-manager.ts` function signatures**

```typescript
// was:
export let agent: GenericAgent | null = null
function createAgent(llmNo = 0, cwd?: string): GenericAgent { ... }
export function rebuildAgent(snapshot?: BackendSnapshot | null, cwd?: string): void { ... }
export function getAgent(): GenericAgent { ... }
// → replace GenericAgent with OrionAgent
```

- [ ] **Step 3: Update `packages/core/src/chat/index.ts`**

Import `OrionAgent`, `AgentLike` from `@orion/engine` instead of `../agent/index.js`. The `SseChatFrontend` in agent-manager.ts already composes `AgentChatMixin` which references `GenericAgentLike` → update to `AgentLike`.

- [ ] **Step 4: Update `packages/core/src/agent/index.ts`** to be a thin re-export shim:

```typescript
// @deprecated — use @orion/engine directly
export {
  OrionAgent as GenericAgent,
  OrionAgentHandler as GenericAgentHandler,
  ToolRegistry,
  AgentError,
  agentRunnerLoop,
  BaseHandler,
  StepOutcome,
  agentLoopHooks,
  CliConsumer,
  renderAgentYieldToText,
  // ... etc
} from '@orion/engine';
```

- [ ] **Step 5: Verify all packages build**

```bash
cd packages/engine && npm run build
Expected: success

cd ../../packages/core && npm run build
Expected: success — fix any TS errors by checking:
  - Import paths: @orion/engine exports match what's imported
  - GenericAgent → OrionAgent in all type annotations
  - GenericAgentHandler → OrionAgentHandler in all type annotations
  - renderAgentYieldToText is now from @orion/engine, not core/agent
```

- [ ] **Step 6: Commit**

```bash
git add apps/ packages/core/src/
git commit -m "refactor: migrate dependents to @orion/engine SDK"
```

---

### Task 17: Cleanup and final verification

**Files:**
- Remove: `packages/core/src/agent/handler-base.ts` (replaced by `packages/engine/src/handler.ts`)
- Remove: `packages/core/src/agent/agent-loop.ts` (moved to engine)
- Remove: `packages/core/src/agent/inline-sandbox.ts` (moved to engine)
- Remove: `packages/core/src/agent/cost-tracker.ts` (moved to engine)
- Scan: all files for remaining `GenericAgent` / `GenericAgentHandler` references

- [ ] **Step 1: Remove moved files from core**

```bash
rm packages/core/src/agent/handler-base.ts
rm packages/core/src/agent/agent-loop.ts
rm packages/core/src/agent/inline-sandbox.ts
rm packages/core/src/agent/cost-tracker.ts
```

- [ ] **Step 2: Scan for stale references**

```bash
rg "GenericAgent|GenericAgentHandler|from.*core/src/agent" packages/ apps/ --files-with-matches | grep -v node_modules
```

Update any remaining references to point to `@orion/engine`.

- [ ] **Step 3: Build and fix errors one by one**

```bash
cd packages/engine && npm run build 2>&1
# Fix: any module not found → check import path
# Fix: type mismatch → check AgentYield variants match consumer dispatch
cd ../core && npm run build 2>&1
# Fix: GenericAgent/GenericAgentHandler → OrionAgent/OrionAgentHandler
# Fix: import paths pointing to deleted core/agent files → @orion/engine
```

- [ ] **Step 4: Run existing tests if any**

```bash
npm test 2>&1 || echo "no tests configured yet"
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove migrated files from core, clean up stale references"
```
