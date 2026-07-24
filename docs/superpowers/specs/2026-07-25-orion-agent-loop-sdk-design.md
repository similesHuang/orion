# @orion/agent-loop SDK 设计文档

> 设计日期: 2026-07-25
> 状态: 设计已批准，待实现
> 参考: claudecode.py（Python Agent Loop 教学实现）

## 概述

`@orion/agent-loop` 是一个 TypeScript Agent Loop SDK，面向 Node.js 22+ 服务端和 CLI 环境。
提供从核心 Agent Loop 到多 Agent 团队协作的全链路能力。

**设计原则：**
- 3 层架构：CORE → RUNTIME → ORCH，依赖单向向下
- Class-based API，通过构造函数注入依赖
- 多 LLM Provider 自设计始即支持
- 所有模块 tree-shakeable 导出

## 目录结构

```
@orion/agent-loop/
├── src/
│   ├── core/                  # Layer 1: 核心循环
│   │   ├── agent-loop.ts      # AgentLoop 主类
│   │   ├── llm-provider.ts    # LLMProvider 接口
│   │   ├── tool-registry.ts   # ToolRegistry
│   │   ├── sub-agent.ts       # SubAgentPool
│   │   ├── message.ts         # Message 类型系统
│   │   └── state.ts           # AgentState 序列化
│   │
│   ├── runtime/               # Layer 2: 运行时
│   │   ├── window-manager.ts  # 上下文窗口策略
│   │   ├── memory-store.ts    # 记忆系统
│   │   ├── skill-loader.ts    # Skill 加载器
│   │   ├── hook-pipeline.ts   # 钩子管道
│   │   ├── retry-policy.ts    # 重试策略
│   │   └── agent-error.ts     # 错误分级
│   │
│   ├── orch/                  # Layer 3: 编排层
│   │   ├── task-store.ts      # 任务系统
│   │   ├── message-bus.ts     # 团队通信总线
│   │   ├── protocol.ts        # 协议管理
│   │   ├── teammate.ts        # Agent 团队成员
│   │   ├── orchestrator.ts    # 团队编排
│   │   ├── cron-scheduler.ts  # 定时调度
│   │   ├── background.ts      # 后台任务执行
│   │   ├── mcp-adapter.ts     # MCP 集成
│   │   └── worktree.ts        # Git 工作树管理
│   │
│   ├── cli/                   # CLI 周边
│   │   ├── cli-consumer.ts    # CLI 事件消费
│   │   └── prompt.ts          # 交互式输入
│   │
│   └── index.ts               # 统一导出入口
│
├── package.json
├── tsconfig.json
└── README.md
```

## CORE 层

### AgentLoop

Agent Loop 主类，管理一次完整 Agent 会话的生命周期。

```typescript
class AgentLoop {
  constructor(options: AgentLoopOptions);
  run(input: string): AsyncGenerator<AgentEvent>;
  pause(): AgentState;
  resume(state: AgentState): void;
  stop(): void;
}

interface AgentLoopOptions {
  llm: LLMProvider;
  systemPrompt: string;
  tools?: ToolRegistry;
  toolChoice?: 'auto' | 'any' | 'none';
  maxTurns?: number;            // default 40
  maxTokens?: number;
  retryPolicy?: RetryPolicy;
  windowManager?: WindowManager;
  memoryStore?: MemoryStore;
  skillLoader?: SkillLoader;
  hooks?: {
    onTurnStart?: (turn: number) => void;
    onTurnEnd?: (turn: number, stats: TurnStats) => void;
    onToken?: (delta: string) => void;
  };
}

type AgentEvent =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'tool_result'; id: string; status: 'done' | 'error'; content: unknown }
  | { kind: 'error'; severity: 'warn' | 'fatal'; message: string }
  | { kind: 'done'; result: string; data?: unknown };
```

**核心循环逻辑：**

```
1. 检查 cron 触发 & 后台任务完成 → 注入消息
2. windowManager.compress(messages)  → 上下文预算
3. 从 memoryStore 检索相关记忆
4. skillLoader.renderCatalog() → 拼入 system prompt
5. hookPipeline.run('beforeTurn')
6. llm.chat(messages, tools) → 流式响应
7. 解析 tool_calls
8. 对每个 tool_call:
   a. hookPipeline.run('beforeTool') → 阻断？
   b. tool.slow ? 走后台执行 : 直接执行
   c. hookPipeline.run('afterTool')
9. 追加 tool_results 到消息列表
10. hookPipeline.run('afterTurn')
11. 重复 6-10 直到：无 tool_call | max_turns | 主动 exit
```

### LLMProvider

```typescript
interface LLMProvider {
  readonly modelId: string;
  chat(
    messages: readonly Message[],
    tools?: readonly ToolDef[],
    options?: ChatOptions
  ): AsyncGenerator<LLMEvent>;
  summarize?(conversation: string): Promise<string>;
}

type LLMEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'response'; response: LLMResponse }
  | { kind: 'error'; message: string };

interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
  usage?: { input: number; output: number };
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
}
```

### ToolRegistry

```typescript
class ToolRegistry {
  register(def: ToolRegistration): this;
  registerTools(defs: ToolRegistration[]): this;
  get(name: string): ToolRegistration | undefined;
  getAll(): ToolRegistration[];
  getSchemas(): ToolDef[];
  execute(name: string, args: unknown): Promise<ToolResult>;
  async connectMCPServer(name: string, config: MCPConfig): Promise<void>;
}

interface ToolRegistration {
  name: string;
  description: string;
  schema: JSONSchema;
  handler: (args: unknown) => Promise<ToolResult>;
  category?: 'builtin' | 'mcp' | 'custom';
  hidden?: boolean;
  slow?: boolean;          // 标记为慢工具 → 自动走后台执行
  timeout?: number;        // 超时（ms）
}

interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}
```

注意：在 `beforeTool` hook 中，`ToolRegistration` 透传给 handler，使其可以检查工具的 `category`、`slow` 等元数据进行权限判断。

### SubAgentPool

```typescript
class SubAgentPool {
  constructor(parent: AgentLoop);
  delegate(request: SubAgentRequest): Promise<SubAgentResult>;
  getTotalCost(): TokenCost;
}

interface SubAgentRequest {
  description: string;
  tools?: ToolRegistry;
  maxTurns?: number;
}

interface SubAgentResult {
  summary: string;
  output: unknown;
  cost: TokenCost;
}
```

SubAgentPool 内部创建新的 `AgentLoop` 实例（共享 `LLMProvider`），执行完任务后销毁。

## RUNTIME 层

### WindowManager（策略模式）

```typescript
abstract class WindowManager {
  abstract compress(messages: Message[]): Message[];
  abstract estimateTokens(messages: Message[]): number;
}

class TruncateWindow extends WindowManager { /* 截断策略 */ }
class SlidingWindow extends WindowManager  { /* 滑动窗口 */ }
class SummaryWindow extends WindowManager  { /* 摘要压缩 */ }
```

压缩管道执行顺序：
1. `tool_result_budget` — 缩减超大的 tool_result 体积
2. `snip_compact` — 按消息数量截断
3. `micro_compact` — 压缩旧 tool_result（保留最近 KEEP_RECENT_TOOL_RESULTS 个）
4. 如果仍然超 token 预算 → 调用 `summaryWindow`（LLM 摘要压缩）

### MemoryStore

```typescript
interface MemoryStore {
  retrieve(context: string, limit?: number): Promise<MemoryItem[]>;
  store(item: Omit<MemoryItem, 'id' | 'ts'>): Promise<void>;
  forget(id: string): Promise<void>;
  save?(): Promise<void>;
  load?(): Promise<void>;
}

interface MemoryItem {
  id: string;
  content: string;
  type: 'user_fact' | 'feedback' | 'project_knowledge' | 'reference';
  tags: string[];
  ts: number;
}

class FileMemoryStore implements MemoryStore { /* 文件系统实现 */ }
class InMemoryStore implements MemoryStore { /* 内存实现 */ }
```

### SkillLoader

```typescript
class SkillLoader {
  constructor(skillsDir?: string);
  scan(): Promise<SkillManifest[]>;
  load(name: string): Promise<Skill | null>;
  renderCatalog(): string;
}

interface Skill {
  manifest: SkillManifest;
  content: string;
  frontmatter: Record<string, unknown>;
  tools?: ToolRegistration[];
  systemPromptOverrides?: string;
}
```

### HookPipeline

```typescript
type HookPhase =
  | 'beforeTurn' | 'afterTurn'
  | 'beforeTool' | 'afterTool'
  | 'beforeLLM'  | 'afterLLM'
  | 'onError'    | 'onStop';

class HookPipeline {
  register(phase: HookPhase, handler: HookHandler): void;
  unregister(phase: HookPhase, handler: HookHandler): void;
  async run<T>(phase: HookPhase, context: T): Promise<HookResult | null>;
}

// 返回值
type HookResult = { denied: true; reason: string } | null;
```

默认注册的 hooks：

| Hook | 用途 | 实现 |
|------|------|------|
| `beforeTool` | 权限白名单/黑名单 | `DenyListHook` |
| `beforeTool` | MCP 高危操作审批 | `ApprovalHook` |
| `afterTool` | 大输出检测 | `LargeOutputHook` |
| `onStop` | 会话摘要统计 | `SessionSummaryHook` |

### RetryPolicy & AgentError

```typescript
class RetryPolicy {
  maxRetries: number;         // default 3
  baseDelayMs: number;        // default 500
  maxDelayMs: number;         // default 32000
  jitter: number;             // default 0.25
  fallbackModel?: string;
  retryableErrors: ErrorMatcher[];
}

class AgentError extends Error {
  readonly severity: 'retryable' | 'fatal' | 'context_overflow';
  readonly retryable: boolean;
  readonly statusCode?: number;
  static from(error: unknown): AgentError;
}
```

## ORCH 层

### TaskStore

```typescript
class TaskStore {
  constructor(basePath?: string);
  create(opts: TaskCreateOptions): Task;
  get(id: string): Task | null;
  list(filter?: TaskFilter): Task[];
  update(id: string, changes: Partial<Task>): Task;
  claim(id: string, owner: string): Task | null;
  complete(id: string): Task;
  fail(id: string, reason: string): Task;
}

interface Task {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  owner: string | null;
  blockedBy: string[];
  tags: string[];
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
}
```

依赖解析：`canStart(task, store) → { ok, blockers }` 由 `claim()` 内部调用。

### MessageBus & ProtocolManager

```typescript
class MessageBus {
  constructor(mailboxDir?: string);
  send(from: string, to: string, content: string, opts?: {
    type?: string; requestId?: string; metadata?: Record<string, unknown>;
  }): void;
  readInbox(agent: string): InboxMessage[];
  peek(agent: string): InboxMessage[];
}

interface ProtocolManager {
  // Lead → Teammate
  requestShutdown(teammate: string): Promise<void>;
  requestPlan(teammate: string, task: string): Promise<string>;
  reviewPlan(requestId: string, approve: boolean, feedback?: string): void;
  // Teammate → Lead
  submitPlan(from: string, plan: string): string;
}
```

### Teammate

```typescript
class Teammate {
  private loop: AgentLoop;
  constructor(opts: TeammateOptions);
  start(): void;
  async shutdown(): Promise<void>;
  getStatus(): 'idle' | 'working' | 'waiting_approval' | 'stopped';
  getSummary(): string;
}

interface TeammateOptions {
  name: string;
  role: 'lead' | 'worker' | 'observer';
  systemPrompt: string;
  llm: LLMProvider;
  tools?: ToolRegistry;
  taskStore?: TaskStore;
  bus: MessageBus;
  protocol: ProtocolManager;
}
```

每个 `Teammate` 内部持有独立的 `AgentLoop` 实例。

### TeamOrchestrator

```typescript
class TeamOrchestrator {
  private members: Map<string, Teammate>;
  private bus: MessageBus;
  private lead: Teammate;
  constructor(config: TeamConfig);
  addMember(teammate: Teammate): void;
  removeMember(name: string): void;
  assignTask(teammate: string, task: Task): Promise<SubAgentResult>;
  broadcast(from: string, content: string): void;
  getSnapshot(): TeamSnapshot;
  async disband(): Promise<void>;
}
```

### BackgoundTaskRunner

```typescript
class BackgroundTaskRunner {
  constructor(maxConcurrent?: number);
  start(toolName: string, args: unknown, handler: HandlerFn): string;
  getResult(taskId: string): BackgroundStatus | null;
  collect(): BackgroundNotification[];
  await(taskId: string, timeout?: number): Promise<ToolResult>;
}
```

触发条件：`ToolRegistration.slow === true` 或者工具名 + 参数匹配慢操作模式。

### CronScheduler

```typescript
class CronScheduler {
  constructor(jobPath?: string);
  schedule(cron: string, prompt: string, opts?: {
    recurring?: boolean; durable?: boolean; id?: string;
  }): CronJob;
  cancel(jobId: string): boolean;
  list(): CronJob[];
  getFired(): CronJob[];
}
```

AgentLoop 每轮循环开始时检查 `getFired()`。

### MCPAdapter

```typescript
class MCPAdapter {
  static async connect(registry: ToolRegistry, server: string, config: MCPClientConfig): Promise<void>;
  static disconnect(registry: ToolRegistry, server: string): void;
}
```

MCP 工具注册后自动获得 `mcp__{server}__{tool}` 前缀名。

### WorktreeManager

```typescript
class WorktreeManager {
  constructor(baseDir?: string);
  create(name: string, taskId?: string): Promise<CreateResult>;
  remove(name: string, opts?: { force?: boolean }): Promise<RemoveResult>;
  keep(name: string): void;
  getPath(name: string): string | null;
  list(): WorktreeInfo[];
  static validateName(name: string): boolean;
}
```

## 类型系统总览

```
AgentEvent            ── AgentLoop.run() 的输出事件联合类型
AgentLoopOptions      ── AgentLoop 构造参数
LLMProvider           ── LLM 提供者接口
LLMEvent              ── LLM.chat() 的输出事件联合类型
LLMResponse           ── LLM 完整响应
ToolRegistration      ── 工具注册元数据
ToolResult            ── 工具执行结果
Message               ── 消息（role + content）
AgentState            ── 序列化状态快照
AgentError            ── 分级错误
RetryPolicy           ── 重试策略
WindowManager         ── 上下文窗口管理抽象类
MemoryItem            ── 记忆项
Skill                 ── 技能容器
HookPhase             ── 钩子阶段枚举
Task                  ── 任务项
InboxMessage          ── 收件箱消息
TeammateOptions       ── 队友配置
TeamConfig            ── 团队配置
CronJob               ── 定时任务项
```

## 与 claudecode.py 的关键差异

| 方面 | Python 版 | TS 版 |
|------|-----------|-------|
| 全局状态 | ~50 个模块级全局变量 | 所有状态封装在 Class 实例中 |
| 工具注册 | 扁平 dict[str, callable] | ToolRegistry，带 schema 校验和元数据 |
| 错误处理 | 字符串模式匹配 | AgentError 分级：retryable / fatal / context_overflow |
| 上下文管理 | 函数式管道 | 策略模式：Truncate / Sliding / Summary |
| 线程模型 | Python threading + 轮询 | async/await + 事件驱动 |
| 子 Agent | 简单循环 | SubAgentPool 实例化独立 AgentLoop |
| 团队协议 | 线程 + JSONL 文件 | MessageBus + ProtocolManager |
| 模块组织 | 单文件 1780 行 | 分层目录，单一职责文件 |

## 未涵盖（未来设计）

以下功能在 claudecode.py 中已有初步实现，但未纳入此设计的第一版：

- **持久化任务状态（Durable jobs）**：跨会话持久化的 cron 和任务状态，在 CronScheduler 中已预留 `durable` 标记，第一版仅内存 + JSON 文件
- **内联沙箱（Inline Sandbox）**：Python 子解释器执行代码，TS 版可由 `CodeExecutor` 接口替代
- **Web 自动化**：不属于 Agent Loop SDK 核心，留给宿主应用实现

## 附录：claudecode.py 设计缺陷总结（供实现参考）

1. **全局状态**：~50 个模块级变量，无法测试和并行——TS 版全部封装在类实例中
2. **模块导入即启动**：`cron_scheduler_loop` 线程在 import 时启动——TS 版将启动交给用户 `agentLoop.run()`
3. **JSON 文件作为数据库**：无并发控制——TS 版 TaskStore 使用原子写入 JSON，但设计为接口，可替换为 SQLite/Redis
4. **忙等待轮询**：`time.sleep(5)` 的空闲检测——TS 版使用事件触发 + Promise
5. **字符串模式匹配做错误分类**：脆弱的 `if "ratelimit" in str(error).lower()`——TS 版用 `AgentError` 结构化分级
6. **扁平工具注册**：dict + 命名约定——TS 版用 `ToolRegistry` + 前缀隔离（`mcp__{server}__{tool}`）
7. **类型安全为零**：`call_tool_handler(handler, args, name)` 中 `args` 是裸 dict——TS 版用 JSONSchema 校验 + 强类型
