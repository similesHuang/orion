import type { Message, LLMResponse, LLMStreamDelta, ToolDefinition } from '../types/index.js';

// ---------------------------------------------------------------------------
// ChatOptions
// ---------------------------------------------------------------------------

export interface ChatOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  tool_choice?: unknown;
  response_format?: unknown;
}

// ---------------------------------------------------------------------------
// LLMProvider
// ---------------------------------------------------------------------------

/**
 * Pluggable LLM provider interface.
 *
 * Implementations handle the actual HTTP/streaming logic for different
 * LLM backends (OpenAI, Anthropic, etc.). OrionAgent receives an
 * LLMProvider via dependency injection and calls `chat()` for each turn.
 */
export interface LLMProvider {
  /** Human-readable provider name (e.g. "gpt-4o", "claude-sonnet-5"). */
  readonly name: string;

  /** Model identifier (e.g. "gpt-4o", "claude-sonnet-5-20250101"). */
  readonly model: string;

  /**
   * Send a message list (and optional tools) to the LLM and stream the
   * response back. The generator yields stream deltas and returns the
   * complete LLMResponse when done.
   */
  chat(options: ChatOptions): AsyncGenerator<LLMStreamDelta, LLMResponse, unknown>;
}
