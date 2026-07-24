import { AgentError } from './agent-error.js';

export type ErrorMatcher =
  | { type: 'statusCode'; code: number }
  | { type: 'nameMatch'; pattern: RegExp }
  | { type: 'messageMatch'; pattern: RegExp };

export class RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
  readonly fallbackModel?: string;
  readonly retryableErrors: ErrorMatcher[];
  consecutive529: number = 0;
  currentModel: string;

  constructor(options?: Partial<RetryPolicyOptions>) {
    const opts = options ?? {};
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 32000;
    this.jitter = opts.jitter ?? 0.25;
    this.fallbackModel = opts.fallbackModel;
    this.retryableErrors = opts.retryableErrors ?? [];
    this.currentModel = opts.initialModel ?? 'default';
  }

  delayMs(attempt: number): number {
    const exponential = Math.min(this.baseDelayMs * (2 ** attempt), this.maxDelayMs);
    const jitterAmount = exponential * this.jitter * (Math.random() * 2 - 1);
    return Math.max(1, Math.round(exponential + jitterAmount));
  }

  shouldFallback(error: AgentError): boolean {
    if (error.statusCode === 529 && this.fallbackModel) {
      this.consecutive529++;
      if (this.consecutive529 >= 2) {
        this.currentModel = this.fallbackModel;
        this.consecutive529 = 0;
        return true;
      }
    } else {
      this.consecutive529 = 0;
    }
    return false;
  }

  isRetryable(error: AgentError): boolean {
    if (!error.retryable) return false;
    // 自定义匹配器
    for (const m of this.retryableErrors) {
      if (m.type === 'statusCode' && error.statusCode === m.code) return true;
      if (m.type === 'nameMatch' && m.pattern.test(error.name)) return true;
      if (m.type === 'messageMatch' && m.pattern.test(error.message)) return true;
    }
    // 默认：retryable severity 且非 context_overflow 就重试
    return error.severity !== 'context_overflow';
  }
}

export interface RetryPolicyOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  fallbackModel?: string;
  initialModel?: string;
  retryableErrors: ErrorMatcher[];
}

export const DEFAULT_RETRY_POLICY = new RetryPolicy();

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  onRetry?: (attempt: number, error: AgentError, delayMs: number) => void
): Promise<T> {
  let lastError: AgentError | null = null;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = AgentError.from(err);

      if (policy.shouldFallback(lastError)) {
        // fallback model 切换后重试
        continue;
      }

      if (!policy.isRetryable(lastError) || attempt === policy.maxRetries) {
        throw lastError;
      }

      const delay = policy.delayMs(attempt);
      onRetry?.(attempt, lastError, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new AgentError('Max retries exceeded', 'fatal');
}
