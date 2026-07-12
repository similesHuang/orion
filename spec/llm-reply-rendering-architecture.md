# LLM 回复渲染与工具调用展示架构设计文档

## 背景与问题

当前 Orion Desktop 的聊天界面在工具调用后经常出现“渲染花了”的情况，典型表现：

1. **机器 trace 和 LLM 文本混在一起**：后端把 `**LLM Running (Turn N)...**`、`🛠️ code_run(...)` 等机器标记直接塞进 SSE 文本流。
2. **前端被迫做字符串切割**：`App.tsx` 里用正则拆分、识别 `🛠️`、再决定渲染成 Markdown 还是工具卡片。这种“打补丁”方式脆弱，后端格式一变就崩。
3. **Markdown 解析污染工具轨迹**：工具参数里的 `*`、`` ` ``、`[` 等字符被 `react-markdown` 解释成排版，出现空粗体行、错乱列表。
4. **职责不清**：文本流既承担“给人看的回答”，又承担“给 UI 看的工具过程”。

目标：建立一套**前后端职责清晰、可扩展、不依赖正则打补丁**的 LLM 回复渲染协议。

---

## 目标

1. **文本流只包含 LLM 最终输出**：不再出现 `LLM Running`、`🛠️` 等机器标记。
2. **工具调用过程走独立结构化通道**：由 `event: tool_call` / `tool_result` 提供，前端以 `ToolGroup` / `InlineToolCard` 形式 inline 展示。
3. **前端不做文本切割**：消息内容按 `RenderUnit` 序列渲染，无需 `parseMessageSegments`。
4. **支持思考-行动-观察-反思（可选）**：如果需要显式展示 LLM 的思考/反思过程，有明确的结构化字段，而不是从文本里正则提取。
5. **可扩展**：未来加入多 Agent、子任务、代码 diff、图片等类型时，不需要再改字符串解析逻辑。

---

## 非目标

- 本次不改造为多 Agent 常驻架构。
- 不要求 LLM 返回 JSON/结构化输出。
- 不追求一次迁移完成：允许分阶段从当前补丁状态过渡到目标架构。

---

## 方案：结构化 SSE 协议 + 自然渲染层

最终采用**结构化 SSE 协议**作为前后端通信层，并在此之上叠加**自然渲染层**，让 LLM 回复和工具调用像真人对话一样自然。

### SSE 事件协议

重新定义 sidecar 到 UI 的 SSE 事件类型：

```
event: text
data: {"delta": "当前项目目录结构如下..."}

event: thought
data: {"delta": "让我先检查一下项目结构..."}

event: tool_call
data: {"id":"step-1","turn":2,"toolName":"code_run","args":{...}}

event: tool_result
data: {"id":"step-1","status":"success","summary":"..."}

event: done
data: {"text": "最终完整回复"}

event: error
data: {"message": "..."}

event: stop
data: {"reason": "user"}
```

### 后端改造

- `agent-loop.ts` 不再 `yield` 机器标记字符串。
- 新增 `yield` 类型区分：
  - `text`：LLM 生成的可展示文本。
  - `thought`：LLM 的 CoT/反思内容。
  - `tool_call`：工具调用元数据，生成 `tool` unit。
  - `tool_result`：工具返回结果，更新对应 `tool` unit。
- sidecar 把这些原语翻译成对应 SSE 事件。

### AgentYield 消费路径

`AgentYield` 是 `packages/agent/src/agent-loop.ts` 内部产出的结构化原语，不会直接暴露给前端。它需要先经过 `GenericAgent.runTask` 和 `AgentChatMixin` / `chat-sidecar.ts` 两层消费，再变成 SSE 事件。

#### `GenericAgent.runTask`（`packages/agent/src/index.ts`）

当前实现：

```ts
for await (const chunk of gen) {
  if (this.stopSig) break;
  fullResp += chunk;
  task.output.push({ next: chunk, source: task.source });
}
```

迁移后：

```ts
for await (const y of gen) {
  if (this.stopSig) break;

  if (y.kind === 'text' || y.kind === 'thought') {
    fullResp += y.content;
  }

  task.output.push({ next: y, source: task.source });
}
```

要点：
- `task.output[i].next` 的类型从 `string` 改为 `AgentYield`。
- `fullResp` 只累积 `text` / `thought` 内容，用于 `done` 事件和 CLI 文本回显。
- `tool_call` / `tool_result` 原封不动推进队列，由下层翻译。

#### `AgentChatMixin` / `chat-sidecar.ts`

桌面端 `chat-sidecar.ts` 从 task queue 读取 `AgentYield`，翻译成 SSE 事件：

```ts
for await (const item of task.output) {
  if (item.next) {
    const y = item.next;
    if (y.kind === 'text')        sendSse('text', { delta: y.content });
    else if (y.kind === 'thought') sendSse('thought', { delta: y.content });
    else if (y.kind === 'tool_call') sendSse('tool_call', { ...y });
    else if (y.kind === 'tool_result') sendSse('tool_result', { ...y, summary: summarizeToolResult(y) });
  }
  if (item.done) sendSse('done', { text: item.done });
}
```

CLI / gateway 如需文本，可在同一队列上把 `AgentYield` 渲染回文本，无需改动 `agent-loop.ts`。

### 前端改造

- 按事件类型更新状态：
  - `text` → 追加到 assistant message.text。
  - `thought` → 追加到 message.thoughts。
  - `tool_call` / `tool_result` → 生成或更新 `RenderUnit` 中的 `tool` unit。
- `<MarkdownStream>` 只渲染文本 unit，永远不会遇到机器标记。
- 工具调用以 `ToolGroup` / `InlineToolCard` 形式 inline 展示在消息流中。

---

## 关于“思考、行动、观察、反思”

不需要 LangGraph 也能实现这个范式：

| 阶段 | 事件类型 | UI 展示 |
|------|---------|---------|
| 思考 (Think) | `event: thought` | `ThoughtBubble`（默认折叠） |
| 行动 (Act) | `event: tool_call` | `ToolGroup` 中 running 状态 |
| 观察 (Observe) | `event: tool_result` | `ToolGroup` 展开后显示结果摘要 |
| 反思 (Reflect) | `event: thought` 或 `event: text` | 思考气泡或正文 |

如果 LLM 本身不输出 CoT，可以把 `thought` 事件留空；如果以后换用支持 reasoning 的模型（如 Claude 的 thinking 块），直接映射到 `event: thought` 即可。

---

## 数据模型变更

### UiMessage

```ts
export interface UiMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string           // 完整累积文本（纯 Markdown），用于复制/持久化/LLM 历史
  thoughts: string[]     // 思考原文数组
  units: RenderUnit[]    // 按时间顺序排列的渲染单元，前端据此决定展示顺序
  createdAt: number
}
```

`units` 由前端 reducer 根据 SSE 事件实时生成，不依赖后端发送；它把文本、思考和工具调用按发生顺序穿插起来，实现“执行到哪展示到哪”。

### RenderUnit

```ts
type TimelineStep = {
  id: string
  toolName: string
  turn: number
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  resultSummary?: string
}

type RenderUnit =
  | { kind: 'text'; content: string }
  | { kind: 'thought'; content: string }
  | { kind: 'tool'; step: TimelineStep }
```

### SSE 事件协议

```ts
// event: text
type TextEvent = { delta: string }

// event: thought
type ThoughtEvent = { delta: string }

// event: tool_call
type ToolCallEvent = {
  id: string              // 同一请求内唯一，与 tool_result.id 匹配
  turn: number            // Agent 当前回合序号，用于同回合多次工具调用折叠分组
  toolName: string
  args: Record<string, unknown>
}

// event: tool_result
type ToolResultEvent = {
  id: string              // 与对应 tool_call.id 匹配
  status: 'done' | 'error'
  summary?: string        // sidecar 对工具返回结果的简短摘要，用于 ToolGroup/InlineToolCard 展示
}

// event: done
type DoneEvent = { text: string }

// event: error
type ErrorEvent = { message: string }

// event: stop
type StopEvent = { reason: 'user' | 'timeout' | 'error' }
```

### agent-loop yield 类型

```ts
type AgentYield =
  | { kind: 'text'; content: string }
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; id: string; turn: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; status: 'done' | 'error'; content: unknown }
```

字段含义与 `ToolCallEvent` / `ToolResultEvent` 一致：`id` 用于匹配，`turn` 用于分组。

---

## LLM 原始输出解析

`agent-loop.ts` 不能直接把模型返回的原始 token 当 `text` 发送，因为不同 LLM 客户端会把思考、工具调用、最终文本混在一起。需要新增一个解析层，把原始输出拆成 `AgentYield`。

### 输入来源

**NativeToolClient**：`LLMResponse` 提供：
- `content` → 最终文本
- `thinking` → 思考
- `tool_calls` → 原生工具调用

流式阶段通过 `LLMStreamDelta` 直接产出 `text` / `thinking` / `error` delta，`agent-loop.ts` 按 kind 转发为 `AgentYield`。

### 解析策略

```ts
function* parseModelOutput(raw: string, response: LLMResponse): Generator<AgentYield> {
  // 1. 流式阶段已经产出 text / thinking delta
  // 2. 从 LLMResponse 提取 tool_calls，生成 tool_call
  // 3. 剩余文本作为 text
}
```

注意：
- 解析应在 `agent-loop.ts` 内部完成，sidecar 和前端只接收已经拆分好的事件。

## 工具结果摘要

`ToolResultEvent.summary` 由 sidecar 或 `agent-loop.ts` 生成，用于 `ToolGroup` 折叠态展示。策略：

- 错误优先：`status === 'error'` 时，summary = 错误信息。
- 截断：超过 240 字符截断，追加 `...`。
- 压缩：把换行、多余空格压成单行。
- 按工具定制：
  - `file_read`：显示读取字节数 / 行数。
  - `code_run`：显示退出码、标准输出前 120 字符。
  - `file_write`：显示写入路径与大小。

## 工具执行日志

`packages/agent/src/handler-base.ts` 中的工具方法目前会 yield 执行日志字符串，例如：

```ts
yield `\n[Action] Reading file: ${filePath}\n`;
yield `[Status] ✅ ...\n`;
```

在新协议下，这些日志不应进入 `text` 事件，因为 `text` 只应包含 LLM 最终输出。处理方式：

- 直接删除或抑制这些字符串 yield。
- 工具执行进度由 `ToolGroup` 的 `running` 状态表示。
- 如果确实需要展示，可作为 `tool` unit 的 `progress` 字段，不走高频文本通道。

## 错误事件转换

`packages/llm/src/index.ts` 目前遇到错误时会 yield `!!!Error: ...` 字符串。新协议下，这类错误应被翻译为 `event: error`，而不是混在文本流里。

转换点可以放在 `agent-loop.ts` 或 sidecar 层：检测到 `!!!Error:` 前缀时，直接 emit `ErrorEvent`；其余内容才作为 `text`。

## 特殊工具说明

- `ask_user` 工具会触发人机干预并终止当前 agent loop。桌面端应把它渲染为需要用户输入的特殊状态（如暂停输入框或专用卡片），而不是普通 `ToolGroup`。
- 本次先保持现有中断语义，UI 层面后续再单独优化。

---

## 实现阶段

### 阶段 1：协议设计 + 基础改造（1-2 天）

1. 安装依赖：在 `apps/desktop/ui` 中添加 `@ant-design/x-markdown`。
2. 确定 SSE 事件类型、TypeScript 类型与 `RenderUnit` 模型。
3. 前端删掉 `parseMessageSegments`；接入 `@ant-design/x-markdown` 替换 `react-markdown`；实现 `StreamBuffer`。
4. 后端 `agent-loop.ts` 开始 yield 结构化 `AgentYield`，sidecar 映射为 SSE 事件。

### 阶段 2：后端协议化（3-5 天）

1. 修改 `packages/agent/src/agent-loop.ts`：
   - 不再 yield `**LLM Running...**`。
   - 不再 yield `🛠️ ...` 字符串。
   - 新增 `parseModelOutput` 解析层，处理 `NativeToolClient` 的 `LLMResponse`，拆出 `text` / `thought` / `tool_call`。
   - yield 结构化 `AgentYield`。
2. 修改 `packages/agent/src/handler-base.ts`：
   - 删除或抑制 `[Action]` / `[Status]` 等执行日志字符串，避免污染 `text` 流。
3. 修改 `packages/chat/src/index.ts` 和 sidecar：
   - 消费 `AgentYield`。
   - 映射为 SSE `text` / `thought` / `tool_call` / `tool_result` 事件。
4. 保持向后兼容：CLI / gateway 如需要文本标记，可在 chat mixin 层把结构化事件渲染回文本。

### 阶段 3：前端协议化 + 自然渲染（2-3 天）

1. `parseSse` 支持 `text` / `thought` / `tool_call` / `tool_result` 事件。
2. `store.ts` 新增 `appendText`、`appendThought`、`addToolUnit`、`updateToolUnit` actions，维护 `message.units`。
3. `renderMessageContent` 按 `units` 顺序渲染：`text` → `MarkdownStream`，`thought` → `ThoughtBubble`，`tool` → `ToolGroup`。
4. 接入 `StreamBuffer`，控制流式节奏。
5. 可折叠思考气泡与工具调用 inline 卡片。

### 阶段 4：清理与 polish（1-2 天）

1. 统一错误、超时、停止状态的 SSE 事件。
2. 接入 `RenderUnit` 渲染管线：`ToolGroup` / `InlineToolCard` / `ThoughtBubble`。
3. 测试工具调用、代码执行、长文本流式输出、中断/超时场景。

---

## 相关文件

- `packages/agent/src/index.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/handler-base.ts`
- `packages/llm/src/index.ts`
- `packages/chat/src/index.ts`
- `apps/desktop/sidecar/chat-sidecar.ts`
- `apps/desktop/ui/src/App.tsx`
- `apps/desktop/ui/src/store.ts`
- `apps/desktop/ui/src/types.ts`
- `apps/desktop/ui/src/utils.ts`
- `apps/desktop/ui/src/markdown.tsx`

---

## 自然渲染层设计（Natural Rendering Layer）

在“结构化 SSE 协议”之上，再叠加一层**自然渲染层**：协议负责“后端给了什么”，渲染层负责“让用户感觉像一个人在打字”。本节记录已确认的结论。

### 关键决策

1. **废弃 LangGraph 方案**  
   当前阶段不引入 LangGraph。单 Agent、工具数量可控，自研 `agent-loop` 足够；LangGraph 作为未来多 Agent / human-in-the-loop 时的可选项。

2. **Markdown 渲染：使用 `@ant-design/x-markdown`**  
   - 用 `@ant-design/x-markdown` 替换当前 `react-markdown`，与 `Bubble.streaming` 配合实现流式 Markdown。  
   - 它基于 `marked`，支持代码高亮、公式、Mermaid 等，接入成本低。  
   - 其内部策略是“全量重解析 + regex 修补”，非真正的 block-level 增量；若后续长回复出现性能瓶颈，再评估 Incremark 或自研 block-level 方案。

3. **流式节奏：前端 `StreamBuffer`**  
   - 后端保持细粒度 `text` / `thought` 事件快速 emit。  
   - 前端在 `consumeStream` 与 `dispatch` 之间加缓冲，按以下条件 flush：  
     - 时间窗口：最多 hold 30~50ms；  
     - 字符阈值：累计 8~16 个字符；  
     - 语义边界：尽量在空格、标点、换行处切断。  
   - 收到 `tool_call` / `tool_result` / `done` / `error` / `stop` 等非文本事件时，必须**立即 flush** 当前缓冲区，避免文本跑到工具调用后面。  
   - 这样可以减少 React 重渲染和 Markdown 反复解析带来的闪烁，同时保持“打字”感。

   `StreamBuffer` 不是全局 store，而是 `App.tsx` 里 `consumeStream` 中的一个异步生成器包装：

   ```ts
   async function* streamBuffer(source: AsyncIterable<SseEvent>): AsyncIterable<SseEvent> {
     let buffer = '';

     for await (const ev of source) {
       if (ev.event !== 'text') {
         if (buffer) {
           yield { event: 'text', data: { delta: buffer } };
           buffer = '';
         }
         yield ev;
         continue;
       }

       buffer += ev.data.delta;

       if (shouldFlush(buffer)) {
         yield { event: 'text', data: { delta: buffer } };
         buffer = '';
       }
     }

     if (buffer) {
       yield { event: 'text', data: { delta: buffer } };
     }
   }
   ```


4. **工具调用：执行到哪，展示哪，同 Turn 折叠成组**  
   - 工具调用以 `InlineToolCard` 形式出现在消息正文流中，紧跟在触发它的文本之后。  
   - 同一个 `turn` 内的多次 tool call 折叠进 `ToolGroup`，默认显示 `Turn N · k 次操作 · 状态`，点击展开查看每次调用详情。  
   - `ToolGroup` 折叠时，若其中任意 step 仍在 `running`，标题旁显示 loading spinner，保证用户能感知执行进度。  
   - `ToolGroup` 与 `InlineToolCard` 直接从 `tool` unit 里的 `step` 取数据渲染；如果未来需要独立的执行轨迹视图，可以从 `units` 中的 `tool` unit 派生。

5. **思考过程：默认折叠的 `ThoughtBubble`**  
   - `thought` 事件独立走 SSE，不混在 `text` 中。  
   - 渲染为半透明、小字号、可折叠的气泡，默认只显示一行“思考中…”。  
   - 后端支持 thinking 字段时直接映射；不支持时可由 `agent-loop` 在 turn 关键节点（如工具调用前规划、工具结果后反思）输出规划/反思摘要作为 `thought`。  
   - thought 在 `RenderUnit` 序列中按实际发生顺序出现，允许“规划 → 工具 → 反思”这种符合人类思维的流程。

### 渲染单元（RenderUnit）

`UiMessage` 不再只有 `text`，而是维护一个按时间顺序排列的渲染单元序列：

```ts
type RenderUnit =
  | { kind: 'text'; content: string }
  | { kind: 'thought'; content: string }
  | { kind: 'tool'; step: TimelineStep }

interface UiMessage {
  id: string
  role: Role
  text: string                    // 完整累积文本，用于复制/持久化/回退
  thoughts: string[]              // 思考原文数组
  units: RenderUnit[]             // 实际渲染顺序
  createdAt: number
}
```

- `text` delta：追加到最后一个 `text` unit，若不存在或上一个 unit 是 `tool`/`thought` 则新建。  
- `thought` delta：追加到最后一个 `thought` unit，否则新建。  
- `tool_call`：先“封存”当前 `text` unit，再 push `{ kind: 'tool', step: runningStep }`。  
- `tool_result`：在 `units` 中找到对应 `id` 的 `tool` unit，更新其 `step` 状态，`tool` unit 自动重新渲染。  
- `done`：收尾，确保所有 unit 都已封存。

### 事件映射到渲染单元

结构化事件如何生成 `RenderUnit`：

- `text` delta → 追加到最后一个 `text` unit，不存在或上一个 unit 是 `tool`/`thought` 则新建。  
- `thought` delta → 追加到最后一个 `thought` unit，否则新建。  
- `tool_call` → 先“封存”当前 `text` unit，再 push `{ kind: 'tool', step: runningStep }`。  
- `tool_result` → 在 `units` 中找到对应 `id` 的 `tool` unit，更新其 `step` 状态。  
- `done` → 收尾，确保所有 unit 都已封存。

> SSE 事件类型的权威定义见上文“数据模型变更”。

### 后端 `AgentYield` 协议化

`packages/agent/src/agent-loop.ts` 不再 yield `**LLM Running...**`、`🛠️ ...` 等机器标记字符串，而是 yield 结构化 `AgentYield`（类型见上文“数据模型变更”）。其中 `tool_call.id` 由 `agent-loop.ts` 生成，保证同一请求内唯一；`tool_call.turn` 为当前 Agent 回合序号，用于把同回合的多次工具调用折叠成一组。

`chat-sidecar.ts` / `packages/chat/src/index.ts` 负责把 `AgentYield` 映射为 SSE 事件。其他消费者（如 CLI）如需文本标记，可自行把结构化事件渲染回文本。

### 组件草图

#### `MarkdownStream`

```tsx
import { XMarkdown } from '@ant-design/x-markdown'

function MarkdownStream({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  return (
    <div className="markdown-body">
      <XMarkdown>{text}</XMarkdown>
      {isStreaming && <span className="streaming-cursor">▌</span>}
    </div>
  )
}
```

#### `ThoughtBubble`

```tsx
function ThoughtBubble({ children }: { children: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thought-bubble">
      <button className="thought-toggle" onClick={() => setOpen(v => !v)}>
        {open ? '隐藏思考' : '思考中…'}
      </button>
      {open && <div className="thought-content">{children}</div>}
    </div>
  )
}
```

#### `ToolGroup` + `InlineToolCard`

```tsx
function ToolGroup({ turn, steps }: { turn: number; steps: TimelineStep[] }) {
  const [open, setOpen] = useState(false)
  const running = steps.some(s => s.status === 'running')
  const done = steps.every(s => s.status === 'done')
  const status = running ? 'running' : done ? 'done' : 'error'
  return (
    <div className={`tool-group tool-group--${status}`}>
      <button className="tool-group-toggle" onClick={() => setOpen(v => !v)}>
        Turn {turn} · {steps.length} 次操作 · {status}
      </button>
      {open && (
        <div className="tool-group-body">
          {steps.map(step => <InlineToolCard key={step.id} step={step} />)}
        </div>
      )}
    </div>
  )
}
```

渲染时，`renderMessageContent` 遍历 `units`，对连续的同 turn `tool` unit 聚合成 `ToolGroup`。

### 实现建议

1. **当前**：直接按最终目标实现：结构化 SSE + `RenderUnit` + `InlineToolCard` + `ToolGroup` + `ThoughtBubble` + `StreamBuffer` + `@ant-design/x-markdown`。  
2. **未来**：若 `@ant-design/x-markdown` 在长回复下出现性能瓶颈，再迁移到自研 block-level 增量渲染或 Incremark。
