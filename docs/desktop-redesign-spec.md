# Orion 桌面端产品重设计 Spec：向 Codex 演进的本地 Agent IDE

> 版本：v0.1  
> 日期：2026-07-14  
> 目标读者：产品、前端、sidecar 后端  
> 关键词：Codex / Agent IDE / 任务流 / Diff / 审批 / Checkpoint

---

## 1. 背景与问题

当前 Orion 桌面端本质上是一个**聊天客户端**：

- 左侧是 Project / Session 列表；
- 中间是 `Bubble.List` 消息列表；
- 底部是 Sender 输入框；
- LLM 的思考、工具调用、运行结果被折叠在消息气泡的次级组件里（`ThoughtBubble`、`ToolGroup`）。

这种设计对“问答”尚可，但对**代码 Agent** 存在明显缺陷：

| 缺陷 | 当前表现 | 用户痛点 |
|------|---------|---------|
| 不透明 | 工具调用折叠在 “Turn N · X 次操作” 中 | 用户不知道 Agent 在改什么、运行了什么命令 |
| 无法审批 | 写文件、跑命令直接执行 | 用户失去对危险操作的掌控 |
| 代码难读 | 代码块以 Markdown 形式内嵌在气泡 | 无法看清修改范围、缺少 diff 对比 |
| 无 checkpoint | 每次对话只是消息堆叠 | 任务中断后无法像 Codex 一样“恢复/重做/回滚” |
| 项目感弱 | Project 只是会话分组 | 没有把“工作区变更”作为核心对象 |
| 键盘效率低 | 缺乏命令面板、上下文引用、快捷模式 | 高级用户操作路径长 |

## 2. 产品定位

把 Orion 桌面端从**“聊天机器人”**重新定位为**“本地 Agent IDE / 任务控制台”**。

核心隐喻：

> 用户在一个 Project 工作区里下达任务，Orion 像一位结对程序员一样**探索、修改、运行、验证**，并把每一步可视化出来。

参考对象：

- **OpenAI Codex CLI / Codex Desktop**：透明执行、Diff、Checkpoint 的完整闭环。
- **Claude Code**：透明 tool-use、文件变更实时展示。
- **Cursor Composer**：Project-aware、上下文引用、代码优先。

## 3. 设计原则

1. **Code-first surface**  
   文件、代码、diff、终端输出是主角；文本解释只是辅助说明。

2. **Transparency by default**  
   思考、工具调用、文件变更、命令结果全部默认可见（至少是可一键展开的）。

3. **Approval & control**  
   对文件写操作、外部命令、网络请求等可配置为 **Auto / Ask / Read-only** 三档。

4. **Project-centric**  
   所有任务都绑定 Project；会话状态 = 工作区状态 + Agent 历史。

5. **Keyboard-driven**  
   命令面板（Cmd+K）、快捷键、@/# 引用、模式切换。

6. **Resumable**  
   每个任务结束自动生成 checkpoint；任务可中断、恢复、重做、回滚。

## 4. 信息架构（目标布局）

采用 **三栏 + 底部 Composer** 布局：

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Sidebar        │  Main Workspace                                  │
│  ─────────────  │  ┌─────────────────────────────────────────────┐ │
│  Project        │  │  Context Bar (Project / Branch / Mode)      │ │
│   ├─ Session    │  ├─────────────────────────────────────────────┤ │
│   ├─ Session    │  │                                               │ │
│  Project        │  │  Task Feed (Diff / Terminal / Tool / Text)  │ │
│   ├─ Session    │  │                                               │ │
│  独立会话        │  │  ┌─ Tool Timeline                             │ │
│                 │  │  ├─ Diff Block                                │ │
│                 │  │  ├─ Terminal Block                            │ │
│                 │  │  └─ Summary Card                              │ │
│                 │  │                                               │ │
│                 │  └─────────────────────────────────────────────┘ │
│                 │  ┌─────────────────────────────────────────────┐ │
│                 │  │  Composer (@ / # / mode / submit)           │ │
│                 │  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

右侧可选抽屉（Context / Files）在窄屏或不需要时收起。桌面端 **不引入 Plan Card**，严格按 `agent-loop` 现有能力（一轮一轮 tool_call）可视化。未来如需结构化计划，再单独评估。

## 5. 核心用户流程

### 5.1 新建任务

1. 用户选择 Project（或创建新 Project），也可以从**独立会话**开始任务。
2. 用户在 Composer 输入任务，可附带上下文引用（`@file.ts`、`#session`）。
3. 提交后创建一个新的 **Task**，进入 **Task 视图**。
4. 同一会话中，只有当前 Task 结束后，下一条消息才会创建新 Task；Task 运行中发送的消息视为对当前 Task 的追问。
5. 未绑定 Project 的任务使用 sidecar 启动目录作为 `cwd`，不生成工作区 checkpoint，但仍可保存 Agent 历史快照。

### 5.2 Agent 启动阶段

1. 用户提交任务后，Task 状态变为 `running`；
2. Agent 立即进入 `agentRunnerLoop`，开始调用工具；
3. 第一个 tool_call 出现前，UI 显示“思考中…”或 `thought` Block；
4. 桌面端 **不引入独立的 Plan Card**，Agent 的“计划”通过其连续的工具调用自然呈现。

### 5.3 执行阶段

1. 每步工具调用以 **Tool Timeline Card** 实时展示。
2. 文件变更立即渲染为 **Diff Block**。
3. 命令输出以 **Terminal Block** 流式追加。
4. 思考过程以半透明轨道实时滚动，不干扰主内容。

### 5.4 结束阶段

1. Agent 输出总结，UI 渲染 **Summary Card**：结果摘要、修改文件列表、耗时、token 消耗。
2. 自动对工作区 + Agent 历史生成 **Checkpoint**。
3. 用户可选择：
   - 接受全部变更；
   - 回滚到 checkpoint；
   - 继续追问（同一 Task 内开启下一轮）。

### 5.5 中断与恢复

- 用户点击 Stop：当前工具执行被中止，已产生的 diff 仍保留为“待处理变更”。
- 切换 Session：自动保存当前 checkpoint，加载目标 session 的工作区快照。
- 重启应用：从最后一个 checkpoint 恢复。

## 6. LLM 回复 UI 重设计（核心）

### 6.1 Plan Card（计划卡）

**桌面端 Phase 1 不实现 Plan Card。**

原因：当前 `packages/agent/src/agent-loop.ts` 没有结构化 plan 输出能力，Agent 是边想边做、一轮一轮调用工具。强行做 Plan Card 需要改 Agent 核心循环或 prompt，超出桌面端范围。

替代方案：用 **Tool Timeline（6.3）** 展示 Agent 实际执行的操作序列，用户能清楚看到 Agent 在改什么、运行了什么命令。如果未来 Agent 层增加了 plan 输出能力，再评估是否接入 Plan Card。

### 6.2 Reasoning Stream（思考流）

- 位置：右侧抽屉或 Task Feed 顶部的可折叠面板。
- 默认折叠，显示“🧠 思考中…”提示；展开后实时滚动。
- 不再作为 message 的一部分 flush 到主文本流，避免消息碎片化。

### 6.3 Tool Timeline（工具时间线）

替换现有的 `ToolGroup` 折叠组件：

- 每个 tool_call / tool_result 是一条时间线卡片。
- 卡片内容：
  - 工具名 + 运行时长；
  - 参数摘要（可展开）；
  - 结果摘要（`exit_code`、`writed_bytes`、文件行数等）；
  - 状态色条：running（蓝）、done（绿）、error（红）。
- 支持的视图：
  - **Summary**：只显示工具名和结果；
  - **Detail**：展开显示完整参数和原始输出；
  - **Raw**：可直接复制 JSON。

### 6.4 Code Diff Block（代码差异块）

所有 `file_write`、`file_patch`、`file_edit` 结果统一渲染为 diff：

- 顶部：文件路径 + 操作类型（新增/修改/删除）+ Apply/Reject/Edit 按钮。
- 主体：分栏 diff（旧版在左，新版在右），带语法高亮和行号。
- 当多文件时，提供“全部接受 / 全部拒绝 / 逐个查看”。
- 对小型 inline patch，可折叠为统一 diff 视图。
- Apply/Reject 语义取决于审批模式：
  - **ASK 模式**：Diff 是 preview，Apply = 执行写入，Reject = 取消操作；
  - **AUTO 模式**：Diff 是已发生的真实变更，Apply = 确认保留，Reject = 回滚该文件。
- **Phase 5 之前不实现“统一查看所有变更”的 PR-like 视图**，多文件按文件分块展示；未来可在 Summary Card 增加“Review all changes”入口聚合所有 `file_change`。

```text
┌─ packages/user/tests/user.test.ts (新增) ─────────┐
│ [Apply] [Reject] [在编辑器打开]                    │
│                                                   │
│  1 │ import { describe, it, expect } from 'vitest'│
│  2 │ import { createUser } from '../src/index'    │
│  3 │                                              │
│  4 │ describe('createUser', () => {               │
│  5 │   it('creates a user', () => {               │
│ ...                                               │
└───────────────────────────────────────────────────┘
```

### 6.5 Terminal Block（终端输出块）

`code_run` 结果渲染为类终端卡片：

- 支持 ANSI 颜色、搜索、复制全部输出；
- 顶部显示命令本身和 `exit_code`；
- 输出过长时默认折叠，显示前 N 行 + “展开剩余 X 行”。

### 6.6 File Preview（文件预览）

`file_read` 结果不再只是文本摘要，而是：

- 以内联代码框展示，带文件路径标题；
- 支持语法高亮；
- 点击路径在系统默认编辑器打开；
- 自动识别“这是用户主动引用的上下文” vs “Agent 主动读取的上下文”。

### 6.7 Summary Card（总结卡）

任务完成后置顶（或置底）显示：

- 任务是否成功；
- 修改文件列表 + diff 快速入口；
- 运行过的命令及结果；
- 耗时、token 消耗；
- 操作：完成 / 继续追问 / 回滚。

### 6.8 Streaming Text（流式文本）

- 解释性文本不再以聊天气泡追加，而是作为 **Task Feed 中的 narrative 段落**流式输出。
- 使用轻量 Markdown 渲染，段落之间自然衔接。
- 保留 `streaming-cursor` 仅在文本流末尾显示。

## 7. Composer / Input 重设计

当前 Sender 只是一个文本框。目标 Composer 应具备：

| 能力 | 说明 |
|------|------|
| `@` 引用 | `@file.ts`、`@dir/`、@ 最近修改的文件 |
| `#` 引用 | `#session`、`#checkpoint`、`#last-task` |
| `/` 命令 | `/help`、`/new`、`/restore`、`/review`、`/llm`、`/cost` |
| 模式切换 | Ask（只回答）、Do（执行） |
| 附件 | 拖拽文件、粘贴图片、选择代码片段 |
| Follow-up chips | 任务结束后推荐下一步操作 |
| 发送历史 | ↑/↓ 浏览最近发送过的消息 |

**@ / # 引用协议**：前端解析为结构化 `context` 数组传给 sidecar，而不是展开成纯文本塞进 `q`。

```ts
interface ComposerSubmit {
  query: string
  context: ContextItem[]
  mode: 'ask' | 'do'
}

type ContextItem =
  | { type: 'file'; path: string }
  | { type: 'dir'; path: string }
  | { type: 'session'; id: string }
  | { type: 'checkpoint'; id: string }
  | { type: 'task'; id: string }
```

- `@file.ts` / `@dir/` 解析为 `file` / `dir`；
- `#session` / `#checkpoint` / `#last-task` 解析为 `session` / `checkpoint` / `task`；
- sidecar 收到后按类型解析路径、读取内容、注入 Agent prompt；
- 前端保留 mention chips 展示，便于用户删除或调整上下文。

Composer 区域常驻显示当前 Project、分支、模式，避免用户忘记上下文。

## 8. Project / Session / Task 模型调整

### 8.0 什么是 Task

**Task 是用户交给 Agent 的一次完整工作单元**。

当前桌面端是“聊天客户端”：用户提问、Agent 回复、用户追问，所有内容堆叠在一个 Session 的消息列表里。这种模式适合问答，但不适合代码 Agent，因为无法区分“哪段对话属于同一件工作”，也无法对一次完整工作做接受、回滚或 checkpoint。

引入 Task 后：

- 用户在 Composer 输入一个指令，就创建一个新的 Task；
- Agent 为这个 Task 调用工具、修改文件、运行命令、输出总结；
- Task 结束时会自动生成 checkpoint；
- 用户可以在 Task 级别审批、回滚、继续追问。

**示例**：

> 用户说：“给 user service 添加单元测试”

这是一个 Task。Agent 会：

1. 读取 `packages/user/src/index.ts`
2. 读取 `packages/user/tests/setup.ts`
3. 写入 `packages/user/tests/user.test.ts`
4. 运行 `pnpm test --filter @orion/user`
5. 输出总结

这些步骤属于同一个 Task，UI 把它们组织在 Task Feed 中展示。

**Task / Session / Project 关系**：

```text
Project（工作区）
  └── Session（对话容器）
        ├── Task 1: "添加单元测试"
        ├── Task 2: "修复 login 接口"
        └── Task 3: "优化日志格式"

独立 Session（不绑定 Project）
  ├── Task 1: "解释这段代码"
  └── Task 2: "帮我写个正则"
```

- **Project**：对应一个代码目录，是所有 Task 的工作区；
- **Session**：Task 的容器，可以包含多个 Task；
- **Task**：一次完整的用户指令 + Agent 执行记录。

### 8.1 Project

新增字段：

```ts
interface Project {
  id: string
  name: string
  path: string
  gitBranch: string | null
  updatedAt: number
  // 新增
  lastCheckpointId: string | null
  pendingChanges: FileChange[]
}
```

### 8.2 Session → Task/Run

建议引入 **Task** 作为一级实体，Session 作为 Task 的容器。**独立会话继续保留**，未绑定 Project 的 Session 其 Task 的 `projectId` 为 `null`，`cwd` 使用 sidecar 启动目录。

#### Task 生命周期

```text
用户提交指令
    │
    ▼
创建 Task（status='running'）
    │
    ▼
Agent 进入 agentRunnerLoop，先输出 thought/text
    │
    ▼
开始执行工具：tool_call → tool_result → file_change / terminal_output
    │
    ├─ 遇到 ASK 审批 ──▶ status='paused'，等待 approval_request
    │
    ├─ 用户点击 Stop ──▶ status='paused'，保留已产生变更
    │
    └─ 正常完成 ───────▶ status='done'
           │
           ▼
   生成 Summary Card
   创建 checkpoint
   Task 结束
```

**Task 边界规则**：
- 用户在 Composer 输入的每条独立指令创建一个新 Task；
- 同一会话内，只有当前 Task 处于 `done` / `error` / `paused` 时，用户发送新消息才会创建新 Task；
- 如果当前 Task 正在 `running`，用户发送新消息视为对当前 Task 的追问（追加到同一 Task）；
- Task 结束后，用户点击“继续追问”可在同一 Session 内开启下一个 Task。

```ts
interface Task {
  id: string
  sessionId: string
  projectId: string | null
  status: 'running' | 'paused' | 'done' | 'error'
  mode: 'ask' | 'do'
  turns: Turn[]
  checkpointId?: string
  pendingApprovalId?: string
  // 本 Task 完成后的 Agent 状态快照；Task 之间通过它实现恢复/回滚
  backendSnapshot?: BackendSnapshot
  // 本 Task 启动时克隆的上一个 Task 的快照 ID，用于追踪状态血缘
  parentSnapshotId?: string
  createdAt: number
  updatedAt: number
}

interface Turn {
  id: string
  role: 'user' | 'assistant'
  blocks: Block[]
}

type Block =
  | { kind: 'text'; id: string; content: string; streaming?: boolean }
  | { kind: 'thought'; id: string; content: string }
  | { kind: 'tool'; id: string; step: TimelineStep }
  | { kind: 'diff'; id: string; change: FileChange }
  | { kind: 'terminal'; id: string; command: string; output: string; exitCode: number }
  | { kind: 'summary'; id: string; summary: Summary }
  | { kind: 'error'; id: string; message: string }

interface FileChange {
  path: string
  op: 'add' | 'modify' | 'delete'
  before: string | null
  after: string | null
}
```

UI Store 从 `message-centric` 逐步迁移到 `task-centric`。旧数据迁移路径（Phase 1 暂不考虑，沿用现有 Bubble.List 兼容展示或延后处理）：
- `ChatSession.messages` → `Task`
- `UiMessage.text` → `Block.text`
- `UiMessage.thoughts` → `Block.thought`
- `RenderUnit.tool`（按 `turn` 分组）→ 每个 `tool` Block + 对应的 `diff` / `terminal` Block

> ~~待决策：旧 Session 中的历史消息是原地迁移为 Task Feed 展示，还是先保留旧 Bubble.List 兼容展示？~~ **Phase 1 暂不考虑，保留旧 Bubble.List 兼容展示。**

### 8.3 Checkpoint（文件快照）

Checkpoint 采用**文件快照**实现，不依赖 Git。每个 Checkpoint 同时保存两部分：

1. **工作区文件状态**（`files`）
2. **Agent 后端状态**（`agentSnapshot`，即 BackendSnapshot）

```ts
interface Checkpoint {
  id: string
  taskId: string
  createdAt: number
  agentSnapshot: BackendSnapshot
  files: FileSnapshot[]
}

interface FileSnapshot {
  path: string
  op: 'add' | 'modify' | 'delete'
  content: string | null
}

interface BackendSnapshot {
  // 各 LLM session 的完整消息历史
  sessions: Array<{
    name: string
    model: string
    history: Message[]
  }>
  // 当前选中的 session 索引
  currentSessionIndex: number
  // GenericAgent 的 history 字符串数组
  agentHistory: string[]
  // Handler 工作记忆（可选）
  workingMemory?: Record<string, unknown>
  // 被禁用的工具列表
  bannedTools?: string[]
}
```

**BackendSnapshot 归属：Task 级别，而非 Session 级别。**

原因：
- 回滚的粒度是 Task。如果所有 Task 共享同一个 Session 级 snapshot，回滚到某个 Task 会把之后 Task 的 Agent 历史也一并抹掉，无法独立恢复单个任务。
- Task 级 snapshot 让 Session 的“当前状态”等价于最后一个已完成 Task 的 `backendSnapshot`，逻辑简单清晰。
- `GenericAgent` 本身就在 Task 之间累积状态（`history`、`handler.working`），在 Task 边界保存快照是自然的扩展。

存储路径：`{projectRoot}/.orion/checkpoints/{checkpointId}.json`，文件内容以相对路径记录。

生成时机：
- 任务开始时自动生成一次 **baseline checkpoint**（克隆上一个已完成 Task 的最终 snapshot，或 Session 初始状态）；
- 任务成功结束后生成 **final checkpoint**（保存本 Task 运行后的 snapshot）；
- 用户可手动调用 `POST /api/checkpoint` 生成。

Checkpoint 粒度：
- **默认按 Task 边界生成**（baseline + final），不对每一步工具调用都生成 checkpoint；
- 长任务中用户可手动触发 checkpoint；
- 若任务中途失败或被 Stop，用户可回滚到 baseline checkpoint。

快照规则：
- 新建 Task 时，sidecar 从当前 Session 最后一个已完成 Task 的 `backendSnapshot` 克隆一份作为工作快照；
- Task 运行期间，Agent 直接修改这份工作快照；
- Task 结束时，工作快照被冻结并保存为该 Task 的 `backendSnapshot`，同时生成 final checkpoint；
- Session 本身不单独维护 BackendSnapshot，它的“当前状态”就是最后一个已完成 Task 的 `backendSnapshot`。

回滚行为：
- Agent 历史：通过 `/api/checkpoint/{id}/restore` 将 `agentSnapshot` 导入当前 agent，恢复对应 Task 完成时的消息历史；
- 工作区文件：按 `files` 数组逐条恢复（新增的文件删除、修改的文件写回旧内容、删除的文件重新创建）；
- 回滚后，该 checkpoint 之后的 Task 标记为 `stale`（不可再恢复），因为 Agent 状态已经分叉。

## 9. Sidecar 协议扩展

### 9.1 SSE 事件扩展

在现有 `text / thought / tool_call / tool_result / error / done` 基础上新增：

| 事件 | 说明 |
|------|------|
| `file_change` | 文件新增/修改/删除，携带 `before` / `after`；ASK 模式下可由 `approval_request` 的 `previewChange` 提前预览，AUTO 模式下为工具执行后的真实变更 |
| `terminal_output` | 命令实时输出（chunk） |
| `checkpoint` | checkpoint 已创建 |
| `approval_request` | 请求用户审批，文件写操作可携带 `previewChange` |

桌面端 **不新增 `plan` / `plan_step_update` 事件**，因为 `agent-loop` 没有结构化 plan 输出能力。Agent 的意图通过 `thought` + 连续 `tool_call` 自然呈现。

`file_change` 由 sidecar 在收到工具返回后生成（AUTO 模式）：
- `file_write` / `file_patch` 工具需要返回 `{ path, before, after }`；
- `file_delete` 工具返回 `{ path, before, after: null }`；
- sidecar 读取当前磁盘文件作为 `before`，工具执行成功后读取新文件作为 `after`；
- 前端收到 `file_change` 后渲染 Diff Block；ASK 模式下 Diff Block 在 Approval Card 内作为 preview 先展示。

### 9.2 REST API 扩展

| 端点 | 请求体 | 说明 |
|------|--------|------|
| `POST /api/approve` | `{ approvalId: string }` | 批准指定审批操作 |
| `POST /api/reject` | `{ approvalId: string }` | 拒绝指定审批操作 |
| `POST /api/checkpoint` | `{}` | 手动创建 checkpoint |
| `POST /api/checkpoint/{id}/restore` | `{}` | 恢复到指定 checkpoint |
| `GET /api/files/changes` | - | 获取当前工作区变更列表 |
| `GET /api/files/diff?path=...` | - | 获取指定文件 diff |

### 9.3 审批系统详细设计

#### 9.3.1 设计目标

- 对危险操作（写文件、执行命令等）提供 `AUTO / ASK / READ_ONLY` 三档控制；
- 用户能在不中断上下文的情况下快速批准或拒绝；
- 审批状态与 Agent loop 强绑定，避免竞态和漏批；
- 前端可展示“待审批”卡片，支持键盘快捷键。

#### 9.3.2 配置模型

审批配置分三级，优先级：**单次覆盖 > 项目级 > 全局默认**。

```ts
// 全局默认值，存在 sidecar 配置或 .env 中
interface ApprovalConfig {
  default: 'auto' | 'ask' | 'read-only'
  // 按工具名覆盖 default
  tools: Record<string, 'auto' | 'ask' | 'read-only'>
}

// 项目级覆盖，存在 Project 对象里
interface Project {
  // ...其他字段
  approvalConfig?: Partial<ApprovalConfig>
}

// 单次任务覆盖，可在 Composer 模式切换时设置
interface Task {
  // ...其他字段
  approvalOverride?: Partial<ApprovalConfig>
}
```

默认策略建议：

| 工具 | 默认级别 | 说明 |
|------|---------|------|
| `file_read` / `web_scan` / `search` | `auto` | 只读操作无需审批 |
| `file_write` / `file_patch` / `file_delete` | `ask` | 默认需要确认 |
| `code_run` | `ask` | 执行外部命令需要确认 |
| `web_navigate` / `web_execute_js` | `ask` | 涉及外部系统操作 |

**新用户默认：`ASK`。** 文件写操作和外部命令默认需要用户确认，建立信任后再切换到 `AUTO`。全局 `default` 可设为 `ask`，仅只读工具按上表覆盖为 `auto`。

#### 9.3.3 状态机

每个运行中的请求维护一个 `ApprovalState`：

```ts
interface ApprovalState {
  id: string
  requestId: string        // sidecar 请求 ID
  toolCallId: string       // Agent 侧 tool_call id
  toolName: string
  args: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  requestedAt: number
  resolvedAt?: number
  resolvedBy?: 'user' | 'timeout'
}
```

状态流转：

```text
工具调用前
    │
    ▼
获取 effectiveApprovalConfig(toolName)
    │
    ├─ AUTO ───────────────▶ 执行工具，不产生 ApprovalState
    │
    ├─ READ_ONLY ──────────▶ 返回错误给 Agent（该工具被禁止）
    │
    └─ ASK ────────────────▶ 创建 ApprovalState(status='pending')
           │
           ▼
    发送 approval_request SSE
    Agent loop 阻塞在 await resolveApproval(state.id)
           │
           ├─ 用户 POST /api/approve ──▶ status='approved' ──▶ 执行工具
           │
           ├─ 用户 POST /api/reject ───▶ status='rejected' ──▶ 返回错误给 Agent
           │
           └─ 10 分钟无响应 ───────────▶ status='timeout' ───▶ 返回错误给 Agent
```

#### 9.3.4 Agent loop 集成

在 `packages/agent/src/agent-loop.ts` 的工具调用入口增加审批钩子：

```ts
async function executeToolWithApproval(
  ctx: AgentContext,
  toolCall: ToolCall,
): Promise<ToolResult> {
  const config = getEffectiveApprovalConfig(ctx, toolCall.toolName)

  if (config === 'read-only') {
    return { status: 'error', content: `Tool ${toolCall.toolName} is in read-only mode.` }
  }

  if (config === 'auto') {
    return executeTool(ctx, toolCall)
  }

  // ASK 模式
  const approval = await ctx.requestApproval(toolCall)

  if (approval.status === 'approved') {
    return executeTool(ctx, toolCall)
  }

  const reason = approval.status === 'timeout'
    ? 'Approval timeout (10 minutes).'
    : 'User rejected this operation.'
  return { status: 'error', content: reason }
}
```

`ctx.requestApproval` 的实现：

```ts
requestApproval(toolCall: ToolCall): Promise<ApprovalState> {
  return new Promise((resolve) => {
    const approval = createApprovalState(toolCall)
    this.pendingApprovals.set(approval.id, { approval, resolve })
    this.emit('approval_request', approval)

    // 10 分钟超时
    approval.timeoutTimer = setTimeout(() => {
      approval.status = 'timeout'
      approval.resolvedBy = 'timeout'
      approval.resolvedAt = Date.now()
      this.pendingApprovals.delete(approval.id)
      resolve(approval)
    }, 10 * 60 * 1000)
  })
}

resolveApproval(id: string, decision: 'approved' | 'rejected'): void {
  const pending = this.pendingApprovals.get(id)
  if (!pending) return
  clearTimeout(pending.approval.timeoutTimer)
  pending.approval.status = decision
  pending.approval.resolvedBy = 'user'
  pending.approval.resolvedAt = Date.now()
  this.pendingApprovals.delete(id)
  pending.resolve(pending.approval)
}
```

#### 9.3.5 Sidecar 协议

**SSE 事件：approval_request**

```json
{
  "id": "appr-abc123",
  "toolCallId": "call_001",
  "toolName": "file_write",
  "args": {
    "path": "packages/user/tests/user.test.ts",
    "content": "..."
  },
  "requestedAt": 1720800000000,
  "previewChange": {
    "path": "packages/user/tests/user.test.ts",
    "op": "add",
    "before": null,
    "after": "import { describe, it, expect }..."
  }
}
```

- 对文件写操作，`previewChange` 由 sidecar 根据当前磁盘内容 + 工具参数提前计算，供 Approval Card 内嵌 Diff Block 展示；
- 对 `code_run` 等无法 preview 的工具，`previewChange` 为 `null`；
- 无论是否携带 `previewChange`，真正的工具执行都等到用户 `/api/approve` 后才发生。

**REST API**

| 端点 | 请求体 | 说明 |
|------|--------|------|
| `POST /api/approve` | `{ approvalId: string }` | 批准指定审批 |
| `POST /api/reject` | `{ approvalId: string }` | 拒绝指定审批 |

端点查找对应 `ActiveRequestState`，调用 `requestAgent.resolveApproval(approvalId, ...)`。

#### 9.3.6 UI 流程

1. 前端收到 `approval_request` SSE；
2. 在对应 Task Feed 顶部渲染 **Approval Card**：
   - 标题：待审批操作（如“写入文件 packages/user/tests/user.test.ts”）；
   - 参数摘要（可展开）；
   - 若携带 `previewChange`，在 Approval Card 内渲染 **Diff Block 预览**；
   - 操作按钮：**允许 (Y)** / **拒绝 (N)**；
3. 用户点击按钮后调用 `/api/approve` 或 `/api/reject`；
4. Approval Card 状态更新为“已允许”或“已拒绝”，Agent 继续执行。

全局兜底：
- 如果用户切换到别的 Task，在全局状态栏显示“有 X 个待审批操作”提示；
- 点击提示可快速跳回对应 Task。

#### 9.3.7 边界情况

| 场景 | 处理 |
|------|------|
| 用户点击 Stop | 所有 pending approval 自动 reject，Agent 停止 |
| 用户切换 Session | 当前 Session 的 pending approval 仍保留；切换前提示用户 |
| sidecar 重启 | pending approval 丢失，对应 Agent loop 因连接中断终止 |
| 多个 approval 排队 | 串行处理：一个 approval 解决后 Agent 才会遇到下一个 |
| 审批超时 | 自动 reject，Agent 收到错误，可能重试或终止 |
| 拒绝后 Agent 重试 | Agent 自行决定策略；若同一操作再次被 ask，用户仍需确认 |

#### 9.3.8 Apply / Reject 语义

Diff Block 顶部的 **Apply / Reject** 在不同审批模式下含义不同，必须统一以避免用户混淆。

**ASK 模式（预执行审批）**

- sidecar 在真正执行工具前，先根据当前磁盘内容 + 工具参数计算出一个 **preview diff**；
- 通过 `approval_request` SSE 把 preview diff 推给前端，UI 渲染 Approval Card + Diff Block；
- 此时文件**尚未写入**磁盘；
- 用户点击 **Apply / 允许**：sidecar 执行工具，文件才真正写入；Diff Block 状态变为 `applied`；
- 用户点击 **Reject / 拒绝**：sidecar 不执行工具，直接返回错误给 Agent；Diff Block 状态变为 `rejected`。

适用于：`file_write`、`file_patch`、`file_delete` 等文件写操作。

> 对 `code_run` 等无法生成 preview diff 的工具，Approval Card 只展示命令本身；Apply = 执行命令，Reject = 跳过并返回错误。

**AUTO 模式（执行后确认 / 便利回滚）**

- 工具直接执行，无需等待审批；
- `file_change` 事件携带的是**真实变更**，Diff Block 显示实际 diff；
- 用户点击 **Apply**：仅作为 UI 层面的“已确认”，文件系统不再变动；
- 用户点击 **Reject**：把该文件回滚到本次变更前的状态（来源可以是 baseline checkpoint，也可以是 `file_change` 事件自带的 `before`）。

AUTO 模式下的 Reject 是一种**事后回滚**，不是审批。它依赖 Task 启动时的 baseline checkpoint 或 sidecar 缓存的 `before` 内容。

**READ_ONLY 模式**

- 所有文件写操作和外部命令在工具调用前直接返回错误，不产生 ApprovalState，也不渲染 Diff Block 的 Apply/Reject。

**统一规则**

| 模式 | Apply | Reject |
|------|-------|--------|
| ASK | 先同意后执行 | 不执行，返回错误 |
| AUTO | 已执行，仅确认 | 已执行，回滚该文件 |
| READ_ONLY | 不出现 | 不出现 |

#### 9.3.9 类型补充

在 `packages/types/src/index.ts` 增加：

```ts
export type ApprovalMode = 'auto' | 'ask' | 'read-only'

export interface ApprovalConfig {
  default: ApprovalMode
  tools: Record<string, ApprovalMode>
}

export interface ApprovalState {
  id: string
  requestId: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  requestedAt: number
  resolvedAt?: number
  resolvedBy?: 'user' | 'timeout'
  // ASK 模式下文件写操作的预览变更；非文件操作可为 undefined
  previewChange?: FileChange
}
```

在 UI 侧 `apps/desktop/ui/src/types.ts` 复用 `@orion/types` 导出的类型。在 `Task` 中保留 `pendingApprovalId?: string` 用于快速定位当前待审批。

## 10. 技术实现建议

### 10.1 推荐库/组件

| 功能 | 候选方案 | 决策 |
|------|---------|------|
| Diff 视图 | `react-diff-viewer-continued` 或自研基于 `diff-match-patch` | **`react-diff-viewer-continued`**。Phase 2-3 先用成熟库支撑 split/inline、行号、语法高亮；超大 diff 通过“折叠未变更区域 + 按需拉取”规避。若后续需要内联编辑或更高级能力，再评估 Monaco diff 或自研。 |
| 终端渲染 | `xterm.js`（轻量场景）或自研 ANSI 着色 | 自研 ANSI 着色。`xterm.js` 对静态输出偏重，先自研高亮 + 折叠策略。 |
| 代码高亮 | 继续用 Shiki，diff 块需自定义 line decoration | 继续 Shiki。 |
| 大列表虚拟化 | `react-window` 或 `react-virtuoso` | `react-virtuoso`。Task Feed 滚动场景更自然。 |
| 文件预览 / 编辑器 | 默认只读 code block；高级场景可嵌入 Monaco Editor | **轻量 code block（Shiki）**。Monaco 体积大、启动重，Phase 4-5 先不引入；只有未来需要内联编辑时再评估。 |
| 状态管理 | 当前 `useReducer` 足够，可引入 Zustand 作为 Task 层状态 | 保持 `useReducer` 到 Phase 2，若 Task 层逻辑继续膨胀再引入 Zustand。 |

### 10.2 样式/主题

- 继续沿用深色主题，但增加 **“编辑器密度”** 变量（紧凑/舒适）。
- 关键颜色语义：
  - 成功/通过：绿色；
  - 错误/失败：红色；
  - 警告/待审批：琥珀色；
  - 运行中：蓝色脉冲。

### 10.3 性能注意

- Diff 块和终端输出可能很大，需要虚拟化或“展开剩余”策略。
- 频繁 SSE 更新应合并渲染帧，避免每帧重渲染整个 Task Feed。
- 文件快照避免全量存储在 localStorage，改存磁盘并只保留引用。

### 10.4 大输出处理

对于 `code_run` / `file_read` 可能产生的大输出：

- **Terminal Block**：
  - 首包直接渲染，后续 chunk 通过 `terminal_output` SSE 事件追加；
  - 总输出超过 500 行或 256KB 时，默认折叠为“显示前 100 行 + 展开剩余”；
  - 单条 chunk 上限 64KB，超出在 sidecar 端分片发送；
  - UI 不保留完整 ANSI 转义序列，只保留颜色样式标记。

- **Diff Block**：
  - 单文件 diff 超过 500 行时，只渲染变更行附近的上下文（折叠未变更区域）；
  - 多文件 diff 默认按文件分块，提供“全部展开/收起”切换；
  - diff 全文不进入 UI state，只保留 `path` 和 `op`，展示时按需从 sidecar 拉取 `/api/files/diff?path=...`。

## 11. 里程碑（MVP → 完整）

### Phase 1：布局与 Task Feed 骨架（2 周）

- [ ] 三栏布局落地。
- [ ] 引入 `Task` / `Turn` / `Block` 数据模型。
- [ ] 把现有 `Bubble.List` 替换为 `TaskFeed`。
- [ ] Tool Timeline 骨架展示（先有 UI 结构，细节在 Phase 2）。

**最小可交付**：Task Feed 能把 `text` / `thought` / `tool` / `diff` / `terminal` / `summary` / `error` 几类 Block 渲染出来；历史消息迁移可延后。

### Phase 2：工具可视化（2 周）

- [ ] Tool Timeline 替代 `ToolGroup`。
- [ ] Terminal Block 渲染 `code_run` 输出。
- [ ] File Preview 渲染 `file_read`。

**可砍掉范围**：Terminal 的 ANSI 颜色渲染、File Preview 的语法高亮可先不做。

### Phase 3：Diff 与审批（3 周）

- [ ] Diff Block 组件及 Apply/Reject 交互。
- [ ] `file_change` SSE 事件与 `file_write/file_patch` 映射。
- [ ] Approval 状态机与 Agent loop 阻塞。
- [ ] `/api/approve`、`/api/reject` 端点。

**可砍掉范围**：Phase 3 先只支持单文件 Apply/Reject；多文件批量操作和 PR-like 视图放到 Phase 5。

### Phase 4：Checkpoint 与恢复（2 周）

- [ ] `/api/checkpoint` 系列端点。
- [ ] 切换 session 时保存/恢复 snapshot。
- [ ] Summary Card 与回滚入口。

**最小可交付**：先实现任务结束后的 checkpoint 生成与回滚；任务中途 checkpoint 可延后。

### Phase 5：Composer 增强与打磨（2 周）

- [ ] `@` / `#` / `/` 提及面板。
- [ ] 模式切换（Ask / Do）。
- [ ] 命令面板（Cmd+K）、快捷键；范围覆盖聊天命令 + 常见 UI 操作（切换 session、打开设置等）。
- [ ] 空状态引导、新手教程。

**可砍掉范围**：Cmd+K 命令面板可延后，先做 Composer 内的 `/` 命令和模式切换；PR-like 统一 diff 视图延后，Phase 5 先保留单文件 Diff Block。

## 12. 成功指标

- 用户能一眼看到 Agent 正在改哪些文件。
- 用户能在不展开折叠的情况下看到最近 3 步工具调用结果。
- 写文件操作在 Ask 模式下必须经用户确认才能生效。
- 任务中断后，90% 以上场景能从 checkpoint 恢复。

## 13. 待决策事项

已决策：

1. ✅ **独立会话**：保留，未绑定 Project 的 Task `projectId` 为 `null`。
2. ✅ **Checkpoint 实现**：采用文件快照，存储在 `{projectRoot}/.orion/checkpoints/`。
3. ✅ **审批机制**：采用状态机，Agent loop 阻塞等待 `/api/approve` 或 `/api/reject`。
4. ✅ **Diff 数据来源**：工具返回 `before` / `after`，sidecar 生成 `file_change` 事件。
5. ✅ **大输出处理**：Terminal 流式 chunk + 折叠；Diff 按文件分块 + 按需拉取。
6. ✅ **Plan 机制**：桌面端不引入 Plan Card / plan SSE / plan 编辑。严格按 `agent-loop` 现有能力，一轮一轮展示 `tool_call`，用 Tool Timeline 替代 Plan Card。
7. ✅ **旧数据迁移**：Phase 1 暂不考虑，沿用现有 Bubble.List 兼容展示或延后迁移。
8. ✅ **BackendSnapshot 归属**：Task 级别。每个 Task 保存自己的 `backendSnapshot`，Session 的当前状态等于最后一个已完成 Task 的快照。
9. ✅ **Apply / Reject 语义**：ASK 模式为预执行审批；AUTO 模式为事后回滚。
10. ✅ **Diff 组件选型**：`react-diff-viewer-continued`。
11. ✅ **Checkpoint 粒度**：按 Task 边界生成（baseline + final），支持手动触发，不按每步生成。
12. ✅ **审批默认值**：新用户默认 `ASK`。
13. ✅ **@ / # 引用协议**：前端解析为结构化 `context` 数组传给 sidecar。
14. ✅ **Monaco 依赖**：Phase 4-5 不引入完整 Monaco，先用轻量 Shiki code block。
15. ✅ **多文件 diff 合并展示**：Phase 5 先不支持 PR-like 统一视图，保留单文件 Diff Block；统一视图放到后续版本。
16. ✅ **命令面板范围**：Cmd+K 覆盖聊天命令 + 常见 UI 操作。

## 14. 附录：SSE 事件示例

```text
event: file_change
data: {"path":"packages/user/tests/user.test.ts","op":"add","before":null,"after":"import { describe, it, expect }..."}

event: terminal_output
data: {"command":"pnpm test --filter @orion/user","chunk":" PASS  packages/user/tests/user.test.ts\n","exitCode":0}

event: checkpoint
data: {"id":"cp-123","createdAt":1720800000000,"filesChanged":["packages/user/tests/user.test.ts"]}

event: done
data: {"text":"已完成：为 user service 添加了单元测试并通过测试。"}
```

---

## 15. 与当前代码的对应关系

| 当前代码 | 目标变化 |
|---------|---------|
| `apps/desktop/ui/src/App.tsx` 的 `Bubble.List` | 替换为 `TaskFeed`，`renderMessageContent` 升级为按 Block 类型分发 |
| `ThoughtBubble` / `ToolGroup` | 升级为 `ReasoningStream` / `ToolTimeline`；Diff Block 使用 `react-diff-viewer-continued` |
| `apps/desktop/ui/src/store.ts` 的 `UiMessage` | 迁移到 `Task / Turn / Block` 模型，`loadState`/`saveState` 增加迁移逻辑 |
| `apps/desktop/ui/src/types.ts` 的 `RenderUnit` | 扩展为 `Block`，新增 `id`、`streaming`、`error` 等字段 |
| `apps/desktop/ui/src/App.tsx` 的 Composer | `@` / `#` 解析为结构化 `context` 数组随 `query` 一起提交；`Cmd+K` 支持聊天命令 + 常见 UI 操作 |
| `apps/desktop/sidecar/chat-sidecar.ts` 的 SSE 事件 | 在 `consumeYield` 中增加 `file_change`、`terminal_output`、`checkpoint`、`approval_request` 的处理；**不新增 `plan` 事件** |
| `apps/desktop/sidecar/chat-sidecar.ts` 的 REST 路由 | 新增 `/api/approve`、`/api/reject`、`/api/checkpoint`、`/api/checkpoint/{id}/restore`、`/api/files/changes`、`/api/files/diff` |
| `packages/agent/src/index.ts` 的 `GenericAgent` 状态 | 在 Task 边界保存 `BackendSnapshot`（Task 级归属），Session 当前状态等于最后一个已完成 Task 的快照 |
| `packages/tools/src/handler.ts` 的 `fileWrite` / `file_patch` | ASK 模式先返回 preview diff（不写入磁盘），等 `/api/approve` 后再执行；AUTO 模式直接写入并返回实际 `file_change` |
| `packages/tools/src/handler.ts` 的 `code_run` | 返回完整输出或流式 chunk，供 sidecar 生成 `terminal_output` 事件 |
| `packages/agent/src/agent-loop.ts` | 在工具调用前插入 `requestApproval()`，实现 ASK 模式阻塞；**不改动循环结构来输出 plan** |
| `packages/chat/src/index.ts` 的 `handleCommand` | `/review`、`/cost`、`/llm` 等命令可在新 Composer 的 `/` 命令面板直接复用 |

---

## 16. 附录：Orion Agent 现有能力清单（可接入桌面端）

> 以下能力已存在于 CLI / SOP / 代码层，但多数未在桌面端 UI 暴露。重设计时可按优先级选择性接入。

### 16.1 Agent 核心运行时

- **多 LLM 会话切换**：`GenericAgent.nextLlm()`、`/next`、`/llms`；切换时保留 history。
- **任务队列**：`putTask` / `processQueue`；CLI 支持 `--task`、`--func`、`--input`、`--reflect`。
- **中断机制**：`abort()` + `stopSig` + `codeStopSignal`。
- **Hooks / 扩展点**：`agentLoopHooks`、`toolBeforeCallback` / `toolAfterCallback`、`turnEndCallback`、`_turnEndHooks`。
- **Working Memory**：`working.key_info`、`related_sop`、`passed_sessions`、`_empty_ct`。
- **轮次保护**：第 7/10/65 轮自动注入危险提示，防止死循环。
- **History 折叠**：保留最近 30 轮，更早历史折叠为摘要。
- **Inline Eval 沙箱**：Python `inline_eval` 在独立子进程执行，仅返回 `_r`。
- **Token 成本追踪**：`costTracker` 支持子 agent 回溯和 `/cost` 报告。

### 16.2 工具层（`@orion/tools`）

- **文件工具**：`file_read`（关键词/行号/截断/`did you mean`）、`file_write`（overwrite/append/prepend）、`file_patch`（唯一块替换）、`expandFileRefs`。
- **代码执行**：`code_run` 支持 Python / PowerShell / Bash（Bash 需 `ORION_ALLOW_SHELL=true`），带 timeout、stop signal、流式状态。
- **网页/浏览器工具**：`web_scan`、`web_navigate`、`web_execute_js`。
- **TMWebDriver**：本地 WebSocket/CDP 桥，tab/session 管理、JS 执行、页面扫描、跳转；配套 Chrome 扩展在 `assets/tmwd_cdp_bridge/`。
- **格式辅助**：`smartFormat`、`formatError`、`extractCodeBlock`、`extractRobustContent`。

### 16.3 记忆系统

- **分层记忆架构**：L0（元 SOP）、L1（insight/index）、L2（用户事实 `global_mem.txt`）、L3（领域 SOP）、L4（原始会话压缩）。
- **长期记忆更新**：`start_long_term_update` 触发，只写回“验证成功”的信息。
- **记忆清理**：ROI 压缩、L1 行数限制、patch-only 编辑。
- **用户身份**：自动读取 `global_mem.txt` 中的用户姓名注入 prompt。
- **密钥管理**：`packages/memory/src/keychain.ts` 的 `SecretStr` / `getKey` / `setKey` / `listKeys`。

### 16.4 子任务与并发（UltraPlan）

- `plan(rundir)`：初始化 UltraPlan session。
- `phase(name, fn)`：带嵌套和计时的阶段执行。
- `parallel(tasks, maxWorkers)`：worker-pool 并行 subagent。
- `mapchain(items, steps)`：Map + 多步链式 subagent。
- `runSubagent()`：派生新 `GenericAgent`，禁止 `ask_user` / `start_long_term_update`。
- **UltraPlan daemon**：HTTP 服务（默认 47831），带 dashboard、`/state`、`/exec`。

### 16.5 桌面 / 聊天 / 网关

- **聊天命令**：`/help`、`/status`、`/stop`、`/new`、`/restore`、`/continue`、`/btw`（插问）、`/review`（审 diff）、`/llm`、`/cost`。
- **Telegram 菜单**：同样命令的无 `/` 版本。
- **会话恢复**：从 `temp/model_responses_*.txt` 恢复、列出、快照。
- **Sidecar REST**：diagnostics、settings、llms、session export/import/reset、reinject、stop、`/chat` SSE。
- **SSE 事件**：`text`、`thought`、`tool_call`、`tool_result`、`error`、`done`、`stop`、`:ping`。
- **飞书 Gateway**：`FEISHU_PORT` + `fs_app_id`/`fs_app_secret`/`fs_allowed_users`。

### 16.6 自动化 / 视觉 / 扫描（未注册为 Agent tool，可被 `code_run`/subagent 调用）

- **UI 检测**：`detectUiElements`（YOLO/ONNX 目标检测）、`visualize`（`packages/memory/src/ui-detect.ts`）。
- **OCR**：`ocrImage`、`ocrScreen`、`ocrWindow`（`packages/memory/src/ocr-utils.ts`）。
- **Windows 后台操控（ljq-ctrl）**：窗口列表/查找、后台截图 `grabWindowBg`、后台点击/按键/输入文本。
- **ADB UI**：`ui()` 节点树、`tap()`（`packages/memory/src/adb-ui.ts`）。
- **视觉 API**：`askVision()`（`packages/memory/src/vision-api.ts`）。
- **进程内存扫描**：`scanMemory()`（`packages/memory/src/procmem-scanner.ts`）。
- **技能语义搜索**：`search()` 105K+ skill cards，带环境检测和评分（`packages/memory/src/skill-search/`）。
- **自主任务 API**：`getTodo` / `setTodoPath` / `completeTask` / `getHistory`（`packages/memory/src/autonomous-task.ts`）。

### 16.7 配套资产

- `assets/sys_prompt.txt` / `sys_prompt_en.txt`：中英文基础系统提示。
- `assets/tools_schema.json` / `tools_schema_cn.json`：工具 schema。
- `assets/code_run_header.py`：代码执行自动注入的运行头。
- `assets/tmwd_cdp_bridge/`：Chrome MV3 扩展，提供 CDP 桥接。

---

*本 Spec 为方向性文档，具体实现细节可在各 Phase 开始前进一步细化。*
