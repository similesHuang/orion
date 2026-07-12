# Orion 桌面端产品重设计 Spec：向 Codex 演进的本地 Agent IDE

> 版本：v0.1  
> 日期：2026-07-12  
> 目标读者：产品、前端、sidecar 后端  
> 关键词：Codex / Agent IDE / 任务流 / Diff / 计划 / 审批 / Checkpoint

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

> 用户在一个 Project 工作区里下达任务，Orion 像一位结对程序员一样**计划、探索、修改、运行、验证**，并把每一步可视化出来。

参考对象：

- **OpenAI Codex CLI / Codex Desktop**：Plan → Approve → Execute → Diff → Checkpoint 的完整闭环。
- **Claude Code**：透明 tool-use、可编辑 plan、文件变更实时展示。
- **Cursor Composer**：Project-aware、上下文引用、代码优先。

## 3. 设计原则

1. **Code-first surface**  
   文件、代码、diff、终端输出是主角；文本解释只是辅助说明。

2. **Transparency by default**  
   计划、思考、工具调用、文件变更、命令结果全部默认可见（至少是可一键展开的）。

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
│  Project        │  │  Task Feed (Plan / Diff / Terminal / Text)  │ │
│   ├─ Session    │  │                                               │ │
│  独立会话        │  │  ┌─ Plan Card                                 │ │
│                 │  │  ├─ Tool Timeline                             │ │
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

右侧可选抽屉（Context / Plan / Files）在窄屏或不需要时收起。

## 5. 核心用户流程

### 5.1 新建任务

1. 用户选择 Project（或创建新 Project）。
2. 用户在 Composer 输入任务，可附带上下文引用（`@file.ts`、`#session`）。
3. 提交后进入 **Task 视图**，不再追加到传统消息列表。

### 5.2 Agent 计划阶段

1. Agent 先输出 `plan` 事件，UI 渲染为 **Plan Card**。
2. Plan Card 列出步骤、预估影响文件、操作类型（read / write / run / search）。
3. 用户可：
   - 点击 **开始执行**；
   - 编辑计划（增删改步骤）；
   - 切换为 **Ask / Plan only** 模式只获取建议。

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

- 位置：Task Feed 顶部。
- 内容：
  - 任务目标摘要；
  - 步骤列表，每项含图标（read/write/run/search）、目标文件/命令、状态（pending/running/done/error）；
  - 底部操作：执行 / 编辑 / 取消。
- 交互：
  - 步骤可拖动重排、删除；
  - 点击步骤可展开 Agent 对该步骤的说明。

```text
┌─ Plan ─────────────────────────────────┐
│ 目标：给 user service 添加单元测试        │
│                                        │
│ ○ 读取 packages/user/src/index.ts      │
│ ○ 读取 packages/user/tests/setup.ts    │
│ ○ 写入 packages/user/tests/user.test.ts│
│ ○ 运行 pnpm test --filter @orion/user  │
│                                        │
│ [编辑] [开始执行]                       │
└────────────────────────────────────────┘
```

### 6.2 Reasoning Stream（思考流）

- 位置：右侧抽屉或 Plan Card 下方的可折叠面板。
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
- 自动识别“这是 Plan 中引用的上下文” vs “Agent 主动读取的上下文”。

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
| 模式切换 | Ask（只回答）、Plan（只给计划）、Do（计划+执行） |
| 附件 | 拖拽文件、粘贴图片、选择代码片段 |
| Follow-up chips | 任务结束后推荐下一步操作 |
| 发送历史 | ↑/↓ 浏览最近发送过的消息 |

Composer 区域常驻显示当前 Project、分支、模式，避免用户忘记上下文。

## 8. Project / Session / Task 模型调整

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

建议引入 **Task** 作为一级实体，Session 作为 Task 的容器：

```ts
interface Task {
  id: string
  sessionId: string
  projectId: string | null
  status: 'planning' | 'running' | 'paused' | 'done' | 'error'
  plan?: Plan
  turns: Turn[]
  checkpointId?: string
  createdAt: number
  updatedAt: number
}

interface Turn {
  id: string
  role: 'user' | 'assistant'
  // 不再是简单 text，而是由多个 Block 组成
  blocks: Block[]
}

type Block =
  | { kind: 'text'; content: string }
  | { kind: 'thought'; content: string }
  | { kind: 'plan'; plan: Plan }
  | { kind: 'tool'; step: TimelineStep }
  | { kind: 'diff'; change: FileChange }
  | { kind: 'terminal'; command: string; output: string; exitCode: number }
  | { kind: 'summary'; summary: Summary }
```

UI Store 从 `message-centric` 逐步迁移到 `task-centric`，但保持旧数据兼容（migrations）。

## 9. Sidecar 协议扩展

### 9.1 SSE 事件扩展

在现有 `text / thought / tool_call / tool_result / error / done` 基础上新增：

| 事件 | 说明 |
|------|------|
| `plan` | Agent 生成的计划 |
| `plan_step_update` | 计划步骤状态更新 |
| `file_change` | 文件新增/修改/删除，携带 before/after 或 diff |
| `terminal_output` | 命令实时输出（chunk） |
| `checkpoint` | checkpoint 已创建 |
| `approval_request` | 请求用户审批 |

### 9.2 REST API 扩展

| 端点 | 说明 |
|------|------|
| `POST /api/approve` | 批准当前待审批操作 |
| `POST /api/reject` | 拒绝当前待审批操作 |
| `POST /api/checkpoint` | 手动创建 checkpoint |
| `POST /api/checkpoint/{id}/restore` | 恢复到指定 checkpoint |
| `GET /api/files/changes` | 获取当前工作区变更列表 |
| `GET /api/files/diff?path=...` | 获取指定文件 diff |

### 9.3 审批模型

Sidecar 在执行写操作前检查配置：

- `AUTO`：直接执行；
- `ASK`：发送 `approval_request` 事件并暂停，等待用户响应；
- `READ_ONLY`：拒绝写操作，返回错误给 Agent。

## 10. 技术实现建议

### 10.1 推荐库/组件

| 功能 | 候选方案 |
|------|---------|
| Diff 视图 | `react-diff-viewer-continued` 或自研基于 `diff-match-patch` |
| 终端渲染 | `xterm.js`（轻量场景）或自研 ANSI 着色 |
| 代码高亮 | 继续用 Shiki，diff 块需自定义 line decoration |
| 大列表虚拟化 | `react-window` 或 `react-virtuoso` |
| 文件预览 | 默认只读 code block；高级场景可嵌入 Monaco Editor |
| 状态管理 | 当前 `useReducer` 足够，可引入 Zustand 作为 Task 层状态 |

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

## 11. 里程碑（MVP → 完整）

### Phase 1：布局与 Task Feed 骨架（2 周）

- [ ] 三栏布局落地。
- [ ] 引入 `Task` / `Turn` / `Block` 数据模型。
- [ ] 把现有 `Bubble.List` 替换为 `TaskFeed`。
- [ ] Plan Card 只读展示。

### Phase 2：工具可视化（2 周）

- [ ] Tool Timeline 替代 `ToolGroup`。
- [ ] Terminal Block 渲染 `code_run` 输出。
- [ ] File Preview 渲染 `file_read`。

### Phase 3：Diff 与审批（3 周）

- [ ] Diff Block 组件及 Apply/Reject 交互。
- [ ] `file_change` SSE 事件与 `file_write/file_patch` 映射。
- [ ] Approval 模式（Auto/Ask/Read-only）。
- [ ] `/api/approve`、`/api/reject` 端点。

### Phase 4：Checkpoint 与恢复（2 周）

- [ ] `/api/checkpoint` 系列端点。
- [ ] 切换 session 时保存/恢复 snapshot。
- [ ] Summary Card 与回滚入口。

### Phase 5：Composer 增强与打磨（2 周）

- [ ] `@` / `#` / `/` 提及面板。
- [ ] 模式切换（Ask/Plan/Do）。
- [ ] 命令面板（Cmd+K）、快捷键。
- [ ] 空状态引导、新手教程。

## 12. 成功指标

- 用户能一眼看到 Agent 正在改哪些文件。
- 用户能在不展开折叠的情况下看到最近 3 步工具调用结果。
- 写文件操作在 Ask 模式下必须经用户确认才能生效。
- 任务中断后，90% 以上场景能从 checkpoint 恢复。

## 13. 待决策事项

1. **Diff 组件选型**：自研还是引入 `react-diff-viewer-continued`？
2. **Checkpoint 粒度**：按任务结束生成，还是每步成功都生成？
3. **审批默认值**：对新用户默认 `ASK` 还是 `AUTO`？
4. **Monaco 依赖**：是否在桌面端嵌入完整 Monaco，还是先用轻量 code block？
5. **多文件 diff 合并展示**：是否支持“统一查看所有变更”的 PR-like 视图？

## 14. 附录：SSE 事件示例

```text
event: plan
data: {"steps":[{"id":"s1","type":"read","target":"packages/user/src/index.ts"},{"id":"s2","type":"write","target":"packages/user/tests/user.test.ts"},{"id":"s3","type":"run","command":"pnpm test --filter @orion/user"}]}

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
| `ThoughtBubble` / `ToolGroup` | 升级为 `ReasoningStream` / `ToolTimeline` |
| `apps/desktop/ui/src/store.ts` 的 `UiMessage` | 迁移到 `Task / Turn / Block` 模型，保留迁移逻辑 |
| `apps/desktop/sidecar/chat-sidecar.ts` 的 SSE 事件 | 增加 `plan`、`file_change`、`terminal_output`、`checkpoint`、`approval_request` |
| `packages/tools/src/handler.ts` 的 `fileWrite` / `code_run` | 返回结构增加 diff 所需字段，供 sidecar 生成 `file_change` 事件 |

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
