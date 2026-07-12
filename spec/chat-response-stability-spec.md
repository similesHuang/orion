# Spec：稳定化桌面端 `/chat` 模型响应格式（v3：保留 thinking，按真实顺序流式输出）

## Context

桌面端 `GET /chat`（`apps/desktop/sidecar/chat-sidecar.ts:574`）返回 SSE 流，事件类型包括 `text`、`thought`、`tool_call`、`tool_result`、`error`、`done`。用户反馈模型输出“不稳定”：文本流中突然混入 `thought` 事件，且 thinking 内容有时在正文结束后才出现，导致 UI 抖动、最终展示不可预测。

技术调研确认：thinking 是模型原生输出，不是自定义协议。Kimi / DeepSeek / GLM 等国内厂商在 OpenAI Chat Completions 兼容响应里通过 `reasoning_content` 返回；Claude 通过 Messages API 的 `thinking` 原生块返回。模型会自己吐出思考内容，**不应被丢弃**。

真正需要解决的问题是：**thinking 在 SSE 流中的顺序不对**。当前实现把 thinking 攒到 LLM 响应末尾才一次性 yield，导致 thought 事件在正文结束后才到达前端。本 spec 的目标是让 thinking 按它在模型输出中的真实顺序流式到达前端，并作为独立块展示，不与正文混排。

## Decision：保留 thinking，按真实顺序输出

1. **LLM 层**：Claude native 的 `thinking_delta`、OpenAI 兼容后端的 `reasoning_content` 边收边 yield，不攒到末尾。
2. **Agent 层**：`agentRunnerLoop` 消费结构化 delta，按真实顺序 yield `{ kind: 'thought' }` 和 `{ kind: 'text' }`；删除流结束后补发 `response.thinking` 的逻辑。
3. **Sidecar 层**：`consumeYield` 的 `case 'thought'` 默认 emit SSE，不再丢弃。
4. **前端**：`thought` 事件渲染为独立、可折叠的思考块，放在正文上方或侧边，不混入正文流。
5. **History**：下一轮发送给 LLM 的 assistant message 仍只包含正文 + tool_calls，不包含 thinking（thinking 是展示层数据，不是对话上下文）。

## Root Causes

当前不稳定来自以下三层问题：

1. **LLM 层把 thinking 攒到最后**：
   - Claude native 的 `thinking_delta` 被累积到 `currentBlock.thinking`，没有 yield（`packages/llm/src/index.ts:393-407`）。
   - OpenAI/兼容接口的 `reasoning_content` 被累积到 `reasoningText`，只 yield `delta.content`（`packages/llm/src/index.ts:312`）。
2. **Agent-loop 事后补发 thought**：`agentRunnerLoop` 在流结束后若发现 `response.thinking` 非空，再补一个 `thought` yield（`packages/agent/src/agent-loop.ts:152-154`）。该事件到达前端时正文往往已输出完毕，产生抖动。
3. **前端缺少 thought 独立渲染**：当前 thought 事件没有独立容器，可能被直接追加到正文附近，导致视觉跳动。

## Goals

1. **真实顺序**：text 和 thinking 在 SSE 流中按模型实际输出顺序到达。
2. **独立渲染**：thinking 默认以独立折叠块展示，不混入正文，避免 UI 抖动。
3. **完整保留**：不丢失模型推理信息，便于调试和未来产品化。
4. **协议向后兼容**：SSE 事件格式不变（`text`/`thought`/`tool_call`/...），前端/网关无需改动事件解析。
5. **History 干净**：assistant message 历史记录只含正文 + tool_calls，thinking 不进入 LLM 上下文。

## Recommended Approach

### 0. 核心原则：thinking 是独立流，与 text 并列

LLM 层负责把 Claude / OpenAI 后端的 thinking 和 text 都流式产出为统一 delta：

```ts
export type LLMStreamDelta =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'error'; message: string };
```

`BaseSession.ask()` / `rawAsk()` / `NativeToolClient.chat()` 统一返回：

```ts
AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>
```

Agent-loop 只负责按顺序把 `thinking` delta 转发为 `AgentYield.thought`，`text` delta 直接转发为 `AgentYield.text`。

### 1. LLM 层：流式 yield thinking delta

#### OpenAI / 兼容接口（含 Kimi）

`parseOpenAISSE` 中：

```ts
if (delta.reasoning_content) {
  reasoningText += delta.reasoning_content;
  yield { kind: 'thinking', delta: delta.reasoning_content };
}
if (delta.content) {
  contentText += delta.content;
  yield { kind: 'text', delta: delta.content };
}
```

#### Claude native

`parseClaudeSSE` 中：

```ts
} else if (delta.type === 'thinking_delta' && currentBlock.type === 'thinking') {
  const t = delta.thinking || '';
  currentBlock.thinking += t;
  yield { kind: 'thinking', delta: t };
}
```

### 2. Agent-loop：消费有序 delta，删除事后补发

`agentRunnerLoop` 消费 `LLMStreamDelta`：

```ts
for await (const value of responseGen) {
  if (value.kind === 'text') {
    yield { kind: 'text', content: value.delta };
  } else if (value.kind === 'thinking') {
    yield { kind: 'thought', content: value.delta };
  } else if (value.kind === 'error') {
    yield { kind: 'error', message: value.message };
  }
}

// 删除以下事后补发逻辑
// if (response.thinking) {
//   yield { kind: 'thought', content: response.thinking };
// }
```

删除 `packages/agent/src/agent-loop.ts:152-154` 的 `response.thinking` 事后补发。

### 3. Sidecar：默认透传 thought

`consumeYield` 中恢复 thought 透传：

```ts
case 'thought':
  emit('thought', JSON.stringify({ delta: y.content }));
  break;
```

`fullText` 只累计 `text` 内容，不累计 `thought`。`done` 事件中的完整回复仍只包含正文。

### 4. 前端：独立折叠块渲染

`thought` 事件不再追加到正文文本，而是进入独立的 `thoughts` 数组：

```ts
// store / state 中
thoughts: string[];

// 收到 thought 事件时
thoughts[thoughts.length - 1] += delta;
```

UI 渲染：

- 一个可折叠面板（默认折叠），标题为“思考过程”或“Reasoning”；
- 位于正文上方或右侧边栏，不随正文滚动跳动；
- 展开时显示累积的 thought 文本；
- text 事件继续按原逻辑进入 `streamBuffer` 和正文渲染。

`streamBuffer` 无需再为 thought 事件 flush；工具事件仍可能触发 flush，按 Phase 2 单独优化。

### 5. 可选：内部调试日志

虽然 thinking 已经通过 SSE 暴露，但如果需要更完整的原始推理日志，可增加 opt-in 日志：

```ts
if (process.env.ORION_DEBUG_THINKING === 'true' && accumulatedThinking) {
  logger.debug('[LLM thinking] %s', accumulatedThinking.slice(0, 500));
}
```

### 7. 响应校验与修复（可选增强）

在 `ProtocolNormalizer.finish()` 后增加 `validateAndRepair()`：

- 检查 `tool_use` 块中的 JSON 是否可解析；
- 检查是否有 `text` 块中包含 `<thinking>`、`<tool_use>` 等残留标签；
- 记录修复动作到日志。

该部分属于二阶段增强，本阶段可先不实现。

## Critical Files to Modify

| File | Change |
|------|--------|
| `packages/types/src/index.ts` | 新增 `LLMStreamDelta`；保留 `LLMResponse` 做兼容。 |
| `packages/llm/src/index.ts` | `parseClaudeSSE` / `parseOpenAISSE` 输出 `LLMStreamDelta`；`BaseSession.ask` / `rawAsk` 及 `NativeToolClient.chat` 返回 `AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>`。 |
| `packages/agent/src/agent-loop.ts` | `agentRunnerLoop` 消费 `LLMStreamDelta`；删除 `response.thinking` 事后补发；删除 `StreamingTagParser`。 |
| `packages/agent/src/index.ts` | `GenericAgent.client` 类型改为 `NativeToolClient`；`fullResp` 只累计 `text`。 |
| `apps/desktop/sidecar/chat-sidecar.ts` | `consumeYield` 的 `case 'thought'` 恢复 emit；`fullText` 不累计 thought。 |
| `apps/desktop/ui/src/utils.ts` | `streamBuffer` 不再为 thought flush。 |

## New Files

本阶段未新增文件。`LLMStreamDelta` 直接加在 `packages/types/src/index.ts`。

## Implementation Phases

### Phase 1：LLM 层流式输出 thinking delta（已完成）

1. `packages/types/src/index.ts`：新增 `LLMStreamDelta`。
2. `packages/llm/src/index.ts`：
   - `parseOpenAISSE` 遇到 `delta.reasoning_content` 时 yield `{ kind: 'thinking', delta }`。
   - `parseClaudeSSE` 遇到 `thinking_delta` 时 yield `{ kind: 'thinking', delta }`。
   - `BaseSession.ask` / `rawAsk` 及 `NativeToolClient.chat` 返回类型改为 `AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>`。
   - 删除 `ToolClient` 类；`createClient` 永远返回 `NativeToolClient`。
3. `packages/agent/src/agent-loop.ts`：
   - 消费 `LLMStreamDelta`，按 kind 路由为 `AgentYield.text` / `AgentYield.thought` / `AgentYield.error`。
   - 删除 `response.thinking` 事后补发。
   - 删除 `StreamingTagParser` 内联类及相关标签解析逻辑。
4. `packages/agent/src/index.ts`：`GenericAgent.client` 类型改为 `NativeToolClient`；`fullResp` 只累计 `text`。
5. `packages/core/src/index.ts`：移除 `ToolClient` 的 re-export。
6. `apps/desktop/sidecar/chat-sidecar.ts`：恢复 `case 'thought'` emit。
7. `apps/desktop/ui/src/utils.ts`：`streamBuffer` 不再为 thought flush。
8. 验证：Kimi / Claude 后端都能按顺序收到 `thought` 事件，不再最后补发。

### Phase 2：响应校验与可观测性（可选，1-2 天）

1. 增加 `LLMResponse` / `LLMStreamDelta` 的轻度校验日志。
2. 增加 `reasoning_content` 占比、text/thinking chunk 数等指标。
3. 在 sidecar `/api/diagnostics` 暴露累计指标。

### Phase 3：清理与文档（0.5 天）

1. 更新本 spec 为已落地状态。
2. 补充 `.env.example` 中的 `ORION_DEBUG_THINKING` 说明。
3. 更新 README 中 LLM 客户端相关描述，移除 `ToolClient`。

## Verification Plan

1. **SSE 顺序验证**：调用 `/chat`，确认 `thought` 事件出现在正文之前或之中，而不是所有 `text` 结束后。
2. **OpenAI/Kimi 测试**：使用支持 `reasoning_content` 的模型，确认 reasoning 内容按 chunk 顺序到达。
3. **Claude native 测试**：使用 Claude 3.7 Sonnet thinking 模型，确认 `thinking_delta` 按顺序到达。
4. **History 一致性**：多轮对话后，发送给 LLM 的 assistant message 中不包含上一轮的 thinking 内容。
5. **前端稳定性**：长文本 + 工具调用场景下，正文连续刷新，thought 面板不引起跳动。

## Migration Notes

- `AgentYield` 类型保持不变；`thought` 事件恢复为正常产出。
- `LLMResponse` 保留做兼容，但 `agentRunnerLoop` 不再依赖其 `thinking` 字段做主要决策。
- 前端 `thought` 展示逻辑需要新增独立折叠块；若旧 UI 把 thought 直接追加到正文，需要调整。
- 若某些后端模型不返回 thinking，则不会产出 `thought` 事件，行为与之前一致。

## Future Work（远期）

- `CHAT_EXPOSE_THINKING` 开关：当前默认始终暴露 thought；未来可增加 UI 级开关让用户选择是否显示思考过程。
- Protocol metrics：`reasoning_content` 占比、text/thinking chunk 数等可观测性指标。
