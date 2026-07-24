export type ErrorSeverity = 'retryable' | 'fatal';

export class AgentError extends Error {
  severity: ErrorSeverity;
  code: string;

  constructor(message: string, code: string, severity: ErrorSeverity) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.severity = severity;
  }

  static rateLimit(message = 'Rate limit exceeded'): AgentError {
    return new AgentError(message, 'rate_limit', 'retryable');
  }

  static serverError(message = 'Server error'): AgentError {
    return new AgentError(message, 'server_error', 'retryable');
  }

  static networkError(message = 'Network error'): AgentError {
    return new AgentError(message, 'network_error', 'retryable');
  }

  static timeout(message = 'Request timed out'): AgentError {
    return new AgentError(message, 'timeout', 'retryable');
  }

  static invalidRequest(message: string): AgentError {
    return new AgentError(message, 'invalid_request', 'fatal');
  }

  static authError(message = 'Authentication failed'): AgentError {
    return new AgentError(message, 'auth_error', 'fatal');
  }

  static toolError(message: string): AgentError {
    return new AgentError(message, 'tool_error', 'fatal');
  }

  static from(e: unknown): AgentError {
    if (e instanceof AgentError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    const errName = e instanceof Error ? e.name : '';
    if (/rate.?limit|429/i.test(msg)) return AgentError.rateLimit(msg);
    if (/timeout|abort/i.test(msg) || errName === 'AbortError') return AgentError.timeout(msg);
    if (/network|fetch|ECONN|ENOTFOUND/i.test(msg)) return AgentError.networkError(msg);
    if (/50[02359]/i.test(msg)) return AgentError.serverError(msg);
    if (/40[13]/i.test(msg)) return AgentError.authError(msg);
    return AgentError.toolError(msg);
  }
}
