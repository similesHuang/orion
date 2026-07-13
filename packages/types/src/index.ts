export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ContentBlockText {
  type: 'text';
  text: string;
  cache_control?: { type: string };
}

export interface ContentBlockThinking {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlockText[];
}

export interface ContentBlockImage {
  type: 'image';
  source: {
    type: 'base64';
    media_type?: string;
    data: string;
  };
}

export interface ContentBlockImageUrl {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult
  | ContentBlockImage
  | ContentBlockImageUrl;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_results?: Array<{ tool_use_id: string; content: string }>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface SessionConfig {
  apikey: string;
  apibase: string;
  model: string;
  name?: string;
  context_win?: number;
  proxy?: string;
  max_retries?: number;
  verify?: boolean;
  stream?: boolean;
  timeout?: number;
  read_timeout?: number;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  thinking_type?: 'adaptive' | 'enabled' | 'disabled';
  thinking_budget_tokens?: number;
  api_mode?: 'chat_completions' | 'responses';
  temperature?: number;
  max_tokens?: number;
  fake_cc_system_prompt?: boolean;
  user_agent?: string;
  // MixinSession fields
  llm_nos?: Array<number | string>;
  base_delay?: number;
  spring_back?: number;
}

export interface LLMResponse {
  content: string;
  thinking: string;
  tool_calls: ToolCall[];
  raw: string;
  stop_reason: string;
  usage?: Record<string, number>;
}

export type LLMStreamDelta =
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'error'; message: string };

export interface ChatOptions {
  messages: Message[];
  tools?: ToolDefinition[];
}

export abstract class BaseSession {
  apiKey: string;
  apiBase: string;
  model: string;
  contextWin: number;
  history: Message[] = [];
  system = '';
  name: string;
  proxies?: { http?: string; https?: string };
  maxRetries: number;
  verify: boolean;
  stream: boolean;
  connectTimeout: number;
  readTimeout: number;
  reasoningEffort?: string;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  apiMode: 'chat_completions' | 'responses';
  temperature: number;
  maxTokens?: number;
  tools?: ToolDefinition[];

  constructor(cfg: SessionConfig) {
    this.apiKey = cfg.apikey;
    this.apiBase = cfg.apibase.replace(/\/$/, '');
    this.model = cfg.model;
    this.contextWin = cfg.context_win ?? 28000;
    this.name = cfg.name ?? this.model;
    this.proxies = cfg.proxy ? { http: cfg.proxy, https: cfg.proxy } : undefined;
    this.maxRetries = Math.max(0, cfg.max_retries ?? 4);
    this.verify = cfg.verify ?? true;
    this.stream = cfg.stream ?? true;
    this.connectTimeout = Math.max(1, cfg.timeout ?? (this.stream ? 5 : 10));
    this.readTimeout = Math.max(5, cfg.read_timeout ?? (this.stream ? 30 : 240));
    this.reasoningEffort = cfg.reasoning_effort;
    this.thinkingType = cfg.thinking_type;
    this.thinkingBudgetTokens = cfg.thinking_budget_tokens;
    this.apiMode = cfg.api_mode === 'responses' ? 'responses' : 'chat_completions';
    this.temperature = cfg.temperature ?? 1;
    this.maxTokens = cfg.max_tokens;
  }

  abstract ask(prompt: Message | string): AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>;

  abstract makeMessages(rawList: Message[]): Message[];

  abstract rawAsk(messages: Message[]): AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>;
}

export type AgentYield =
  | { kind: 'text'; content: string }
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; id: string; turn: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; status: 'done' | 'error'; content: unknown }
  | { kind: 'error'; message: string };

export interface TaskQueueLike {
  get(block?: boolean, timeout?: number): Promise<{ done?: string; next?: AgentYield; source?: string } | null>;
}

export interface GenericAgentLike {
  verbose: boolean;
  llmNo: number;
  client: { name: string; backend: { name: string; model: string } };
  isRunning: boolean;
  history: string[];
  abort(): void;
  putTask(query: string, source?: string, cwd?: string): TaskQueueLike;
  nextLlm(n?: number): void;
  listLlms(): string;
  llmName: string;
}

