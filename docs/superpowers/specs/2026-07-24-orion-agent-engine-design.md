# Orion Agent Engine — SDK 重构设计

## 目标

将 `packages/core/src/agent` 重构为 `packages/engine`，使 `OrionAgent` 成为一个平台无关的 agent SDK，供桌面端、CLI、API 等多种上层消费。

## 改动总览

| # | 模块 | 改动 |
|---|------|------|
| 1 | 命名 | `GenericAgent` → `OrionAgent`，`packages/core` → `packages/engine` |
| 2 | 核心 loop | `tool_choice`/`response_format`、错误分级 yield、before/after turn hooks |
| 3 | 流抽象 | `AgentYieldConsumer` 接口，渲染逻辑移出核心 |
| 4 | 工具系统 | `ToolRegistry` 编程式注册，内置工具拆出 handler |
| 5 | MCP | MCP client + adapter，自动注册外部 tools |
| 6 | Context | `WindowManager` — token 感知截断/压缩/滑动窗口 |
| 7 | 状态 | `saveState()` / `fromState()` 序列化恢复 |
| 8 | Sub-agent | `delegate()` 受限子 agent，共享 cost tracker |
| 9 | 重试 | `AgentError` 分级 + `RetryPolicy` 退避 |

---

## 1. 目录结构

```
packages/engine/src/
├── orion-agent.ts           # OrionAgent 主入口
├── agent-loop.ts            # 核心 Agent Loop（增强）
├── handler.ts               # OrionAgentHandler（精简，只保留调度/计划/memory）
├── tools/
│   ├── registry.ts          # ToolRegistry
│   ├── builtin/
│   │   ├── file.ts          # file_read / file_write / file_patch
│   │   ├── code.ts          # code_run
│   │   ├── web.ts           # web_scan / web_navigate / web_execute_js
│   │   └── user.ts          # ask_user
│   └── mcp/
│       ├── client.ts        # MCP transport + protocol
│       └── adapter.ts       # MCP tool → ToolRegistration
├── context/
│   └── window-manager.ts    # Token 感知的截断/压缩策略
├── state/
│   └── serialization.ts     # AgentState 保存/恢复
├── resilience/
│   ├── errors.ts            # AgentError 分级
│   └── retry.ts             # RetryPolicy + 退避执行
├── stream/
│   └── consumer.ts          # AgentYieldConsumer 接口 + CLI 实现
├── subagent/
│   └── delegation.ts        # 父子 agent 委托模型
├── telemetry/
│   └── tracing.ts           # OTEL tracing + 结构化日志 hooks
├── cost-tracker.ts          # 保留
├── inline-sandbox.ts        # 保留
├── ultraplan.ts             # 保留
├── ultraplan-daemon.ts      # 保留
└── index.ts                 # 统一导出
```

---

## 2. 核心 Loop 增强

### AgentYield 扩展

```typescript
type AgentYield =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }              // 统一 thinking 命名
  | { kind: 'tool_call'; id: string; turn: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; status: 'done' | 'error'; content: unknown }
  | { kind: 'error'; severity: 'retryable' | 'fatal'; message: string }   // 新增
  | { kind: 'state'; snapshot: AgentState }                                // 新增
  | { kind: 'trace'; span: SpanContext }                                   // 新增
```

### agentRunnerLoop 增强

```typescript
interface AgentLoopOptions {
  maxTurns?: number;
  toolChoice?: 'auto' | 'required' | { name: string };
  responseFormat?: { type: 'json_object' } | { type: 'json_schema'; schema: Record<string, unknown> };
  retryPolicy?: RetryPolicy;
  hooks?: {
    beforeTurn?: (turn: number) => void;
    afterTurn?: (turn: number, outcome: StepOutcome) => void;
  };
}
```

### Stream Consumer

```typescript
interface AgentYieldConsumer {
  onText(chunk: string): void;
  onThinking(chunk: string): void;
  onToolCall(call: { id: string; turn: number; toolName: string; args: Record<string, unknown> }): void;
  onToolResult(result: { id: string; status: 'done' | 'error'; content: unknown }): void;
  onError(error: { severity: 'retryable' | 'fatal'; message: string }): void;
  onState(snapshot: AgentState): void;
}
```

`renderAgentYieldToText` 从 agent 核心移除，作为 CLI consumer 实现放到 `stream/cli-consumer.ts`。桌面端实现自己的 consumer。

---

## 3. 工具系统

### ToolRegistry

```typescript
interface ToolRegistration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => AsyncGenerator<string, StepOutcome, unknown>;
}

class ToolRegistry {
  register(tool: ToolRegistration): void;
  registerMCP(server: MCPServerConfig): Promise<void>;
  unregister(name: string): void;
  list(): ToolDefinition[];
  dispatch(name: string, args: Record<string, unknown>): AsyncGenerator<string, StepOutcome, unknown>;
}
```

### 内置工具拆分

`handler-base.ts`（约 470 行）中工具实现拆到 `tools/builtin/` 独立文件。handler 仅保留：

- `dispatch` — 委托给 `ToolRegistry.dispatch`
- 计划模式逻辑（enter/exit/check plan）
- 工作记忆管理（key_info, related_sop）
- turnEndCallback

---

## 4. MCP 支持

- `tools/mcp/client.ts` — 基于 `@modelcontextprotocol/sdk`，支持 stdio / SSE transport
- `tools/mcp/adapter.ts` — MCP `listTools()` → `ToolRegistration[]`，`callTool()` → 适配 handler 返回值
- `OrionAgent` 构造时接收 `mcpServers: MCPServerConfig[]`，启动时自动连接并注册

```typescript
interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;    // stdio
  args?: string[];
  url?: string;        // SSE
}
```

---

## 5. Context Window 管理

```typescript
interface WindowManager {
  fit(messages: Message[]): Message[];      // 返回适合窗口的消息
  onUsage(usage: Record<string, number>): void;
  setBudget(maxTokens: number): void;
  getUsage(): { used: number; budget: number; remaining: number };
}
```

内置三种策略：
- **truncate** — 从最早消息开始裁除，保留 system prompt
- **summarize** — 将老旧消息压缩为一行摘要注入
- **sliding** — 保留最近 N 轮，超出丢弃

```

---

## 6. 状态序列化

```typescript
interface AgentState {
  version: number;
  messages: Message[];
  working: Record<string, unknown>;
  historyInfo: string[];
  turn: number;
  createdAt: number;
}

class OrionAgent {
  saveState(): AgentState;
  static fromState(state: AgentState, options?: OrionAgentOptions): OrionAgent;
}
```

恢复时自动重放 necessary context，新的 `putTask` 在恢复后的 conversation 上继续。

---

## 7. Sub-agent 委托

```typescript
interface SubAgentRequest {
  prompt: string;
  tools?: string[];        // 工具白名单
  model?: string;
  timeout?: number;
  maxTurns?: number;
}

interface SubAgentResult {
  output: string;
  usage: TokenStats;
  toolCalls: string[];
}

class OrionAgent {
  async delegate(request: SubAgentRequest): Promise<SubAgentResult>;
}
```

父子 agent 共享 cost tracker。子 agent 为受限实例：不可 `ask_user`、不可继续委托。ultraplan 的 `runSubagent` 改为调用 `delegate`。

---

## 8. 错误分级与重试

```typescript
class AgentError extends Error {
  severity: 'retryable' | 'fatal';
  code: string;
}

interface RetryPolicy {
  maxRetries: number;       // 默认 3
  baseDelay: number;        // 默认 1000ms
  backoff: 'exponential' | 'linear';
  retryOn: string[];        // 默认 ['rate_limit', 'server_error', 'network_error']
}
```

`agentRunnerLoop` 内捕获 `retryable` 错误时按 `RetryPolicy` 退避后重入，不消耗额外 turn。
