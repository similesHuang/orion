# Desktop 接入 Reflect 模块设计文档

## 背景

`packages/reflect` 目前只在 CLI 的 `--reflect` 模式下使用，提供 Goal Mode、定时任务、自主运行、Checklist Master、Agent Team Worker 等能力。这些能力本质上是**长周期、后台化、可重复的 Agent 任务**，与桌面端的聊天 UI 并不冲突，反而可以互补：

- 聊天 UI 适合：用户主动提问、单次任务、即时反馈。
- Reflect 适合：用户设定目标后离开，Agent 在后台持续优化；定时巡检； checklist 跟踪；多 Agent 协作。

把 Reflect 接入桌面端，可以让 Orion Desktop 从“纯聊天工具”升级为“主动型 Agent 工作台”。

---

## 目标

1. 桌面端可以**创建、启动、停止、查看** Reflect 任务（Goal / Scheduler / Autonomous / Checklist / Agent Team）。
2. Reflect 任务在 sidecar 后台运行，不阻塞正常聊天。
3. Reflect 任务的输出（日志、轮次、结果）可以在桌面端可视化。
4. 保留 CLI `--reflect` 的兼容性，同一套脚本可以在 CLI 和桌面端复用。
5. Reflect 任务的状态持久化，sidecar 重启后可以恢复。

---

## 非目标

1. 本次不改造 Reflect 脚本本身的逻辑，只增加“被桌面端调度”的能力。
2. 不要求所有 Reflect 模块一次性接入，优先接入 **Goal Mode** 和 **Scheduler**。
3. 不实现跨设备同步 Reflect 状态。
4. 不实现 Reflect 任务的资源隔离（后续可扩展）。

---

## 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Desktop UI (React)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ 聊天会话    │  │ Reflect 面板 │  │ Goal / 定时任务管理  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP / SSE
┌────────────────────────────▼────────────────────────────────┐
│                   chat-sidecar (Node)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ /chat 路由  │  │ Reflect 调度 │  │ 状态持久化 / 日志    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ import
┌────────────────────────────▼────────────────────────────────┐
│              packages/reflect (现有脚本)                      │
│        goal-mode / scheduler / autonomous / ...             │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据模型

### ReflectTask（新增）

```ts
export type ReflectTaskType = 'goal' | 'scheduler' | 'autonomous' | 'checklist' | 'agent-team'

export type ReflectTaskStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error'

export interface ReflectTask {
  id: string
  type: ReflectTaskType
  name: string                // 用户可读名称，例如 "优化 landing page"
  scriptPath: string          // reflect 脚本路径，例如 "reflect/goal-mode.ts"
  config: Record<string, unknown>  // 该任务专属配置
  status: ReflectTaskStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  lastRunAt?: number
  nextRunAt?: number          // 对 scheduler 有用
  errorMessage?: string
  sessionId?: string | null   // 关联的聊天会话，可选
}

export interface ReflectTaskLog {
  id: string
  taskId: string
  turn?: number
  level: 'info' | 'error' | 'result'
  content: string
  timestamp: number
}
```

### GoalState（复用并扩展现有 goal_state.json）

```ts
export interface GoalState {
  id: string
  taskId: string
  objective: string
  budgetSeconds: number
  maxTurns: number
  status: 'running' | 'wrapping_up' | 'done_budget' | 'stopped'
  turnsUsed: number
  startTime: number
  endTime?: number
  donePrompt?: string
  workingDir?: string
}
```

---

## 后端 API 设计

### 1. 任务管理

```ts
// GET /api/reflect/tasks
// 列出所有 Reflect 任务
response: { tasks: ReflectTask[] }

// POST /api/reflect/tasks
// 创建任务
body: { type: ReflectTaskType, name: string, config: Record<string, unknown> }
response: { task: ReflectTask }

// GET /api/reflect/tasks/:id
// 获取单个任务详情
response: { task: ReflectTask, logs: ReflectTaskLog[], goalState?: GoalState }

// POST /api/reflect/tasks/:id/start
// 启动任务
response: { task: ReflectTask }

// POST /api/reflect/tasks/:id/stop
// 停止任务
response: { task: ReflectTask }

// POST /api/reflect/tasks/:id/pause
// 暂停任务（可选）
response: { task: ReflectTask }

// DELETE /api/reflect/tasks/:id
// 删除任务及历史日志
response: { success: boolean }
```

### 2. 日志流

```ts
// GET /api/reflect/tasks/:id/logs?since=<timestamp>
// 获取任务日志（分页或增量）
response: { logs: ReflectTaskLog[] }

// SSE /api/reflect/tasks/:id/stream
// 实时推送任务日志、状态变化、goal 进度
// events: log | status | goal | done
```

### 3. 脚本发现

```ts
// GET /api/reflect/scripts
// 返回可用的 reflect 脚本模板
response: {
  scripts: Array<{
    type: ReflectTaskType
    name: string
    description: string
    scriptPath: string
    defaultInterval: number
    schema: Record<string, unknown>   // config 的 JSON Schema
  }>
}
```

---

## Reflect 调度器设计（sidecar 新增）

新增 `ReflectScheduler` 类，职责：

1. **加载任务**：从 `PROJECT_ROOT/temp/reflect_tasks.json` 读取持久化任务列表。
2. **加载脚本**：动态 `import(reflectScriptPath)`，复用现有 CLI 脚本。
3. **运行循环**：
   - 每个 running 的任务独立维护一个 timer。
   - timer 触发时调用 `script.check(projectRoot)`。
   - 返回非空 prompt 时，调用 `agent.runOnce(prompt)` 执行。
   - 执行过程中通过 SSE 向前端推送日志。
4. **状态更新**：
   - 启动、停止、完成、出错时更新 `ReflectTask.status`。
   - Goal Mode 的状态需要特殊处理：读取/写入 `goal_state.json`。
5. **持久化**：任务列表和日志定期写回磁盘。

### 运行模型

```ts
class ReflectScheduler {
  private tasks: Map<string, ReflectTaskRuntime>

  async load(): Promise<void>
  async save(): Promise<void>

  createTask(type: ReflectTaskType, name: string, config: unknown): ReflectTask
  async startTask(id: string): Promise<void>
  async stopTask(id: string): Promise<void>
  async deleteTask(id: string): Promise<void>

  // 内部：为 running 任务调度下一次 check
  private scheduleNext(task: ReflectTaskRuntime): void

  // 内部：执行一次 check + runOnce
  private async runIteration(task: ReflectTaskRuntime): Promise<void>

  // 每个任务有独立 agent
  private createAgentForTask(task: ReflectTask, snapshot?: BackendSnapshot): GenericAgent

  // 供 sidecar SSE 使用
  onLog(callback: (taskId: string, log: ReflectTaskLog) => void): void
  onStatusChange(callback: (taskId: string, status: ReflectTaskStatus) => void): void
}
```

### Agent 隔离细节

- **创建**：任务启动时，调用 `createAgentForTask()`，传入可选的 `BackendSnapshot`（来自关联会话）。
- **配置**：Reflect agent 使用与聊天相同的 `.env` / `mykey.json` 配置，但 LLM 索引可以独立指定。
- **执行**：`task.agent.runOnce(prompt)` 在独立上下文中运行。
- **停止**：调用 `task.agent.abort()`，然后清理资源。
- **快照**：任务停止或完成时，可导出该任务的 snapshot，方便后续恢复或迁移到聊天会话。

### 与 Agent 的关系（隔离方案）

- Reflect 任务**拥有独立的 GenericAgent 实例**，与聊天用的全局 `agent` 完全隔离。
- 每个 Reflect 任务创建时，根据当前会话的 backend snapshot 初始化自己的 agent（可选继承上下文）。
- Reflect 任务的 agent 单独维护 LLM 索引、历史记录、工具调用状态。
- 聊天和 Reflect 可以并发执行，互不阻塞。
- sidecar 需要管理多个 agent 生命周期：创建、运行、销毁、snapshot 导出/导入。

---

## UI 设计

### 左侧边栏新增入口

```
┌────────────────────┐
│ Orion              │
├────────────────────┤
│ 💬 会话             │
│ 🎯 Reflect 任务     │  ← 新增
├────────────────────┤
│ ⚙️ 设置             │
└────────────────────┘
```

### Reflect 面板

```
┌────────────────────────────────────────────────────────────┐
│ 🎯 Reflect 任务                                    [+ 新建] │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ ┌────────────────────┐  ┌──────────────────────────────┐  │
│ │ 任务列表            │  │ 任务详情 / 日志               │  │
│ │                    │  │                              │  │
│ │ ▶ 优化 landing     │  │ 名称：优化 landing page      │  │
│ │    goal · running  │  │ 类型：Goal Mode              │  │
│ │                    │  │ 状态：运行中                  │  │
│ │ ● 定时巡检代码      │  │ 已用轮次：3 / 20             │  │
│ │    scheduler       │  │ 剩余时间：12m / 30m          │  │
│ │                    │  │                              │  │
│ │ ○ checklist-demo   │  │ [停止] [暂停] [查看会话]      │  │
│ │    checklist       │  │                              │  │
│ │                    │  │ ── 日志 ──                   │  │
│ └────────────────────┘  │ [12:01] 第 3 轮开始          │  │
│                         │ [12:03] 执行 code_run...     │  │
│                         │ [12:04] 工具返回：success    │  │
│                         │ [12:05] 生成改进报告...      │  │
│                         │                              │  │
│                         └──────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 新建任务弹窗

根据选择的类型显示不同配置表单：

**Goal Mode：**
- 目标描述（objective）
- 预算时间（分钟）
- 最大轮次
- 是否关联当前会话

**Scheduler：**
- 任务名称
- 执行频率（once / daily / weekday / weekly / every_1h ...）
- 执行时间（HH:MM）
- Prompt 内容

**Autonomous / Checklist / Agent Team：**
- 选择脚本路径
- 必要配置（如 checklist 的 folder、agent team 的 bbs url）

---

## 状态持久化

### 文件位置

```
PROJECT_ROOT/
├── temp/
│   ├── reflect_tasks.json        # 任务列表
│   ├── reflect_logs/             # 任务日志
│   │   ├── task-<id>.log
│   │   └── ...
│   ├── goal_state.json           # Goal Mode 状态（兼容现有 CLI）
│   └── scheduler_state/          # Scheduler 状态（兼容现有 CLI）
│       └── done/
```

### 持久化策略

- 任务列表：每次创建/更新/删除时立即写回 `reflect_tasks.json`。
- 日志：内存中保留最近 100 条，其余按任务写入 `reflect_logs/task-<id>.log`。
- Goal 状态：复用现有 `goal_state.json`，由 `goal-mode.ts` 自己维护。

---

## 与现有聊天会话的联动

### 方案 A：Reflect 任务生成独立会话（推荐）

- 每个 Reflect 任务启动时，可选创建一个关联的 `ChatSession`。
- Reflect 每轮执行的结果作为 assistant 消息写入该会话。
- 用户可以在聊天列表里看到“Goal: 优化 landing page”这样的会话，点进去能看完整过程。

**优点：** 自然融入现有聊天模型，用户熟悉。  
**缺点：** 长任务会产生大量消息。

### 方案 B：Reflect 面板与聊天会话分离

- Reflect 任务有自己的展示空间，不生成聊天消息。
- 只在任务完成时，把最终结果作为一条消息推送到用户指定的会话。

**优点：** 聊天列表更干净。  
**缺点：** 用户需要切到 Reflect 面板看过程。

**建议：** 先用方案 A，因为 Reflect 的本质就是多轮对话，复用会话模型最自然。未来如果消息过多，再提供“归档”或“仅显示最终结果”的开关。

---

## 实现阶段

### 阶段 1：基础调度器 + Goal Mode（1 周）

1. sidecar 新增 `ReflectScheduler` 类。
2. 新增 `/api/reflect/*` 路由。
3. 接入 `goal-mode.ts`：
   - 创建 Goal 任务时写 `goal_state.json`。
   - 启动任务后按 `INTERVAL` 循环调用 `goalMode.check()`。
   - 执行结果通过 SSE 推送。
4. UI 新增 Reflect 面板，支持创建/停止 Goal 任务、查看日志。

### 阶段 2：Scheduler + Autonomous（2-3 天）

1. 接入 `scheduler.ts` 和 `autonomous.ts`。
2. UI 支持配置定时任务、自主运行开关。
3. 持久化 scheduler 的 done 记录。

### 阶段 3：Checklist + Agent Team（2-3 天）

1. 接入 `checklist-master.ts` 和 `agent-team-worker.ts`。
2. 这些模块依赖外部 folder / BBS，需要在 UI 里配置对应参数。
3. 提供状态可视化（checklist 完成进度、agent team 任务板）。

### 阶段 4： polish（2-3 天）

1. Reflect 任务与聊天会话关联。
2. 通知/ badge：Reflect 任务有新进展时提示用户。
3. 日志搜索、过滤、导出。
4. 任务失败重试、邮件/IM 通知（可选）。

---

## 依赖变更

### `apps/desktop/sidecar/package.json`

已经是 workspace，通过 `packages/chat` 间接依赖 `@orion/agent`，可以直接 `import` reflect 脚本。

### `apps/desktop/ui/package.json`

无需新增依赖，使用现有 Ant Design X / antd 组件。

---

## 边界情况

| 场景 | 行为 |
|------|------|
| sidecar 重启 | 从 `reflect_tasks.json` 恢复任务，running 状态的任务自动重新启动 |
| Reflect 执行中用户发送聊天消息 | 互不阻塞：聊天走全局 agent，Reflect 走独立 agent |
| Reflect 任务出错 | 记录错误日志，状态变为 `error`，不自动重试（阶段 4 再加） |
| Goal 预算耗尽 | `goal-mode.ts` 返回收口 prompt，执行后状态变为 `completed` |
| 用户删除运行中任务 | 先停止，再删除日志和状态文件 |
| 脚本文件不存在 | 创建任务时校验，失败返回 400 |

---

## 待决定事项

1. **Reflect 任务是否必须关联会话？** 建议可选，默认关联当前活跃会话。
2. **Agent 实例是否隔离？** ✅ 已决定：隔离。每个 Reflect 任务拥有独立 `GenericAgent` 实例。
3. **Reflect 日志保留多久？** 建议默认 7 天，可配置。
4. **是否支持 Reflect 任务触发系统通知？** 阶段 4 再考虑，需要 Tauri 通知权限。

---

## 相关文件

- `packages/reflect/src/*`
- `packages/agent/src/index.ts`
- `apps/desktop/sidecar/chat-sidecar.ts`
- `apps/desktop/ui/src/App.tsx`
- `apps/desktop/ui/src/store.ts`
- `apps/desktop/ui/src/types.ts`
- `apps/desktop/ui/src/api.ts`

---

## 建议的下一步

先按 **阶段 1** 实现 Goal Mode 接入：

1. 在 sidecar 里新增 `ReflectScheduler` 和 `/api/reflect/*` 路由。
2. UI 左侧加 "Reflect" 入口，面板支持创建 Goal 任务。
3. 验证 Goal Mode 能在桌面端后台运行，并实时推送日志。

Goal Mode 跑通后，Scheduler 和 Autonomous 是类似的接入模式，可以快速复制。
