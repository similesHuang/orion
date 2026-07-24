import type { Message, ToolDef } from './message.js';

// ── ChatOptions ──
export interface ChatOptions {
  maxTokens?: number;
  toolChoice?: 'auto' | 'any' | 'none' | { type: 'tool'; name: string };
  responseFormat?: unknown;
  abortSignal?: AbortSignal;
}

// ── LLMEvent（流式响应的事件）──
export type LLMEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'response'; response: LLMResponse }
  | { kind: 'error'; message: string };

// ── LLMResponse ──
export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
  usage?: { input: number; output: number };
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

// ── LLMProvider 接口 ──
export interface LLMProvider {
  readonly modelId: string;
  chat(
    messages: readonly Message[],
    tools?: readonly ToolDef[],
    options?: ChatOptions
  ): AsyncGenerator<LLMEvent>;

  // 可选：用于 context 压缩时的摘要生成
  summarize?(conversation: string): Promise<string>;
}
