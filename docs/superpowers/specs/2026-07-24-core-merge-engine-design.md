# 删除 `@orion/core`，统一抽象到 `@orion/engine`

## 背景

当前 `@orion/core` 和 `@orion/engine` 存在**循环依赖**和**大量代码重复**：

| 函数 | engine 副本 | core 副本 |
|---|---|---|
| `findProjectRoot` | `shared/index.ts` | `shared/index.ts` |
| `sleep` | `shared/index.ts` | `shared/index.ts` |
| `resolveAllowedPath` | `shared/index.ts` | `shared/index.ts` |
| `smartFormat` | `shared/index.ts` | `tools/handler.ts` |
| `getGlobalMemory` | `shared/index.ts` | `agent/index.ts` |
| `getSystemPrompt` | `orion-agent.ts` | `agent/index.ts` |
| `ensureMemoryFiles` | `orion-agent.ts` | `agent/index.ts` |
| `loadSessionsFresh` | `orion-agent.ts` | `agent/index.ts` |

此外 `@orion/core` 包含大量业务逻辑（CLI main()，聊天系统，记忆系统，反思系统），这些不应在底层 engine 库中。

## 目标架构

```
@orion/engine                         packages/desktop (new, 来自 core)
  ├── interfaces/                       ├── LLM/ConcreteProvider
  │    ├── LLMProvider                  ├── CodeExecutor (spawn)
  │    ├── CodeExecutor                 ├── WebAutomation (TMWebDriver)
  │    ├── WebAutomation                ├── EnvConfigLoader
  │    └── ConfigLoader                 ├── CLI main() / Chat / Memory / Reflect
  ├── OrionAgent (DI)                   └── Langfuse tracing
  ├── agent-runner-loop
  ├── OrionAgentHandler
  ├── ToolRegistry + MCP
  ├── tools/builtin/file (concrete)
  ├── tools/builtin/user (concrete)
  ├── stream/consumer
  ├── context/window-manager
  ├── resilience/errors, retry
  ├── state/serialization
  ├── telemetry/tracing
  ├── cost-tracker
  └── shared/utilities
```

### 核心原则

1. **Engine 只保留抽象 + 通用工具实现** — 不依赖平台能力
2. **Engine 零循环依赖** — 不 import `@orion/core`，不 import 业务代码
3. **具体实现通过依赖注入传入** — `OrionAgentOptions` 接收 `LLMProvider`, `CodeExecutor`, `WebAutomation`, `ConfigProvider`
4. **Desktop 包提供所有具体实现** — 从 core 迁移进来或新建
5. **删除 `packages/core`** — 所有功能迁移或清理后删除

## 接口设计

### LLMProvider

```ts
// engine/src/llm/provider.ts
export interface LLMConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  // ... 从 SessionConfig 精简
}

export type LLMStreamDelta =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'error'; message: string };

export interface LLMResponse {
  content: string;
  thinking: string;
  tool_calls: ToolCall[];
  raw: string;
  stop_reason: string;
  usage?: Record<string, number>;
}

export interface ChatOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  response_format?: unknown;
}

export interface LLMProvider {
  chat(options: ChatOptions): AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>;
  readonly model: string;
  readonly name: string;
}
```

### CodeExecutor

```ts
// engine/src/tools/executor.ts
export interface CodeExecutionResult {
  status: 'success' | 'error';
  stdout: string;
  exit_code: number | null;
  msg?: string;
}

export interface CodeExecutor {
  run(
    code: string,
    codeType: string,
    timeoutSec: number,
    cwd: string,
    codeCwd?: string,
    stopSignal?: number[]
  ): AsyncGenerator<string, CodeExecutionResult, unknown>;
}
```

### WebAutomation

```ts
// engine/src/web/automation.ts
export interface ScanResult {
  status: string;
  tabs: TabInfo[];
  current_tab: string;
  url: string;
  title: string;
  content: string;
}

export interface NavigateResult {
  status: string;
  url: string;
  title: string;
  tab_id: string;
}

export interface ExecuteResult {
  status: string;
  js_return: unknown;
  tab_id: string;
  error?: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active?: boolean;
}

export interface WebAutomation {
  scan(options?: ScanOptions): Promise<ScanResult>;
  navigate(url: string, options?: NavigateOptions): Promise<NavigateResult>;
  executeJs(script: string, options?: ExecuteOptions): Promise<ExecuteResult>;
  close(): Promise<void>;
}
```

### ConfigProvider

```ts
// engine/src/config/provider.ts
export interface LLMSessionConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  name?: string;
  contextWin?: number;
  // ... 其他可选的会话参数
}

export interface ConfigProvider {
  loadSessions(): LLMSessionConfig[];
}
```

## Engine 改动清单

### 新增文件（接口）
| 文件 | 内容 |
|---|---|
| `src/llm/provider.ts` | `LLMProvider` 接口 + `ChatOptions` |
| `src/tools/executor.ts` | `CodeExecutor` 接口 |
| `src/web/automation.ts` | `WebAutomation` 接口 + 结果类型 |
| `src/config/provider.ts` | `ConfigProvider` 接口 |

### 修改文件
| 文件 | 改动 |
|---|---|
| `src/orion-agent.ts` | 移除 `@orion/core` 导入；改为接收 `LLMProvider` DI |
| `src/agent-loop.ts` | `client` 参数类型改为 `LLMProvider` 接口 |
| `src/handler.ts` | 无大改，参考 engine 自己的类型 |
| `src/tools/registry.ts` | 无大改 |
| `src/tools/builtin/code.ts` | 使用 `CodeExecutor` 接口替代直接 `codeRun` |
| `src/tools/builtin/web.ts` | 使用 `WebAutomation` 接口替代直接 `webScan` 等 |
| `src/tools/builtin/file.ts` | 保留具体实现（纯 fs，不需要抽象） |
| `src/tools/builtin/user.ts` | 保留具体实现 |
| `src/compat.ts` | 删除 — 不再需要桥接 |
| `src/cost-tracker.ts` | 移除 `getWorkspaceRoot` / `llmUsageHooks` 依赖；保留纯追踪逻辑；移除全局 `install()` |
| `src/shared/index.ts` | 合并 core 中有用的纯工具函数。移除 `getGlobalMemory()`（桌面专属） |
| `src/types/index.ts` | 合并 core 的类型差异。统一 `AgentYield`（保留 engine 版本） |
| `src/inline-sandbox.ts` | 使用 CodeExecutor 接口或拆出 |
| `src/subagent/delegation.ts` | 修复 `SubAgentRequest` 接口，移除虚假的 tools/model/timeout 字段 |

### 删除文件
| 文件 | 原因 |
|---|---|
| `src/compat.ts` | 不再需要桥接转发 |

### 保留不变的文件
| 文件 | 原因 |
|---|---|
| `src/stream/consumer.ts` | 纯接口 |
| `src/context/window-manager.ts` | 纯算法 |
| `src/resilience/` | 通用 |
| `src/state/serialization.ts` | 通用 |
| `src/telemetry/tracing.ts` | 通用 |
| `src/tools/mcp/` | 通用 |
| `src/tools/registry.ts` | 通用 |

### 依赖变化

**engine/package.json** 移除：
```diff
- "@orion/core": "workspace:*",
```

**engine/package.json** 保留或新增（MCP 已可选）：
```json
{
  "peerDependencies": {
    "@modelcontextprotocol/sdk": { "optional": true }
  }
}
```

## Desktop/CLI 包 — 从 core 迁移

具体实现不建新包，直接移入已有的 `apps/desktop/sidecar/`：

| 模块 | 来源 | 去向 |
|---|---|---|
| LLM 会话层 | `core/src/llm/` (全部) | `apps/desktop/sidecar/llm/` |
| 代码执行 | `core/src/tools/handler.ts` 的 `codeRun` | `apps/desktop/sidecar/executor/` |
| 浏览器自动化 | `core/src/tools/tmwebdriver.ts` + `web.ts` | `apps/desktop/sidecar/web/` |
| CLI main() 入口 | `core/src/agent/index.ts` | `apps/desktop/sidecar/cli/` |
| 聊天系统 | `core/src/chat/` 全部 | `apps/desktop/sidecar/chat/` |
| 反思系统 | `core/src/reflect/` 全部 | `apps/desktop/sidecar/reflect/` |
| 记忆系统 | `core/src/memory/` 全部 | `apps/desktop/sidecar/memory/` |
| Langfuse | `core/src/plugins/langfuse-tracing.ts` | `apps/desktop/sidecar/plugins/` |

`apps/desktop/package.json` 从 `@orion/core` 改为 `@orion/engine`：

```diff
- "@orion/core": "workspace:*",
+ "@orion/engine": "workspace:*",
```

## 迁移步骤

### Phase 1 — 接口抽象（无破坏性）
1. 在 engine 中创建 `src/llm/provider.ts` 等接口文件
2. 定义 `LLMProvider`, `CodeExecutor`, `WebAutomation`, `ConfigProvider` 接口
3. 统一 `AgentYield` 类型，删除 core 的类型副本

### Phase 2 — Engine 剥离 core 依赖
4. 修改 `agent-loop.ts`：`client` 参数类型从 NativeToolClient 变为 `LLMProvider` 接口
5. 修改 `orion-agent.ts`：接受 `LLMProvider` DI，移除 `@orion/core` 导入
6. 修改 `code.ts`：使用 `CodeExecutor` 接口
7. 修改 `web.ts`：使用 `WebAutomation` 接口
8. 删除 `compat.ts`
9. 清理 `cost-tracker.ts` 对 `@orion/core` 的依赖
10. 清理 `shared/index.ts`，合并类型

### Phase 3 — 删除 @orion/core
11. 创建 `packages/desktop`（或 apps/desktop 内子包）
12. 从 core 迁移 LLM 实现到 desktop
13. 从 core 迁移 CLI/chat/memory/reflect 到 desktop
14. 删除 `packages/core` 目录
15. 删除 pnpm-workspace.yaml 中对 core 的引用

### Phase 4 — 验证
16. 修复所有 import 路径
17. 构建验证
18. 功能回归测试

## 副作用与风险

| 风险 | 缓解 |
|---|---|
| 现有代码大量引用 `@orion/core` | core/index.ts 保留重新导出 `export * from '@orion/engine'` 确保向后兼容（此处是直接删除，但可以先让 core 变薄） |
| `loadSessionsFromEnv` 当前在 engine 的 `orion-agent.ts:7` 报错 "not exported" | 迁移后自然消失，因为 LLMProvider 由调用方注入 |
| 性能影响 | 无 — DI 和接口在运行时零成本 |
| TypeScript 编译失败 | Phase 3 完整编译验证后再合并 |

## 后续展望

- `@orion/engine` 可以发布为纯 npm 包（无平台依赖）
- Desktop/Backend 适配不同环境（Tauri, Electron, Node.js server）
- 测试更容易 — Provider 接口可 mock
