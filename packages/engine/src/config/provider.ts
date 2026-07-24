// ---------------------------------------------------------------------------
// LLMSessionConfig
// ---------------------------------------------------------------------------

/**
 * Minimal LLM session configuration returned by a ConfigProvider.
 * This replaces the old SessionConfig from @orion/core.
 */
export interface LLMSessionConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  name?: string;
  contextWin?: number;
  proxy?: string;
  maxRetries?: number;
  stream?: boolean;
  timeout?: number;
  readTimeout?: number;
  reasoningEffort?: string;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  apiMode?: 'chat_completions' | 'responses';
  temperature?: number;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// ConfigProvider
// ---------------------------------------------------------------------------

/**
 * Pluggable configuration provider interface.
 *
 * Implementations determine how LLM credentials and model settings are
 * loaded (e.g. from .env file, environment variables, or a secrets store).
 */
export interface ConfigProvider {
  /** Return all configured LLM sessions. */
  loadSessions(): LLMSessionConfig[];
}
