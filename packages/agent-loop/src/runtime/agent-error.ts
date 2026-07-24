export type ErrorSeverity = 'retryable' | 'fatal' | 'context_overflow';

export class AgentError extends Error {
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(message: string, severity: ErrorSeverity, statusCode?: number) {
    super(message);
    this.name = 'AgentError';
    this.severity = severity;
    this.retryable = severity === 'retryable';
    this.statusCode = statusCode;
  }

  static from(error: unknown): AgentError {
    if (error instanceof AgentError) return error;

    const msg = String(error);
    const lower = msg.toLowerCase();

    // 429 RateLimit
    if (lower.includes('ratelimit') || lower.includes('429')) {
      return new AgentError(msg, 'retryable', 429);
    }
    // 529 Overloaded
    if (lower.includes('overloaded') || lower.includes('529')) {
      return new AgentError(msg, 'retryable', 529);
    }
    // Context overflow
    if (lower.includes('context_length_exceeded') || lower.includes('max_context_window') || (lower.includes('prompt') && lower.includes('long'))) {
      return new AgentError(msg, 'context_overflow');
    }
    // Auth errors — fatal
    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('authentication error') || lower.includes('authorization error') || /\bauth\b/i.test(lower)) {
      return new AgentError(msg, 'fatal');
    }
    // Default: retryable（网络错误等）
    return new AgentError(msg, 'retryable');
  }
}
