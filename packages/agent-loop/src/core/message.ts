// ── ContentBlock ──
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean };

// ── Message ──
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
  tool_results?: ToolResultBlock[];
}

export interface ToolResultBlock {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ── AgentEvent（AgentLoop.run() 的输出事件）──
export type AgentEvent =
  | { kind: 'text'; content: string }
  | { kind: 'thinking'; content: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'tool_result'; id: string; status: 'done' | 'error'; content: unknown }
  | { kind: 'error'; severity: 'warn' | 'fatal'; message: string }
  | { kind: 'done'; result: string; data?: unknown };

// ── ToolDef（发送给 LLM 的工具 Schema）──
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ── ToolCall（LLM 返回的工具调用）──
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

// ── TokenCost ──
export interface TokenCost {
  input: number;
  output: number;
  total: number;
}
