import { AgentError } from './agent-error.js';

export type ErrorMatcher =
  | { type: 'statusCode'; code: number }
  | { type: 'nameMatch'; pattern: RegExp }
  | { type: 'messageMatch'; pattern: RegExp };

export interface FallbackDecision {
  needsFallback: boolean;
  consecutive529: number;
  currentModel: string;
}

export class RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
  readonly fallbackModel?: string;
  readonly retryableErrors: ErrorMatcher[];
  private _consecutive529: number = 0;
  private _currentModel: string;

  constructor(options?: Partial<RetryPolicyOptions>) {
    const opts = options ?? {};
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 32000;
    this.jitter = opts.jitter ?? 0.25;
    this.fallbackModel = opts.fallbackModel;
    this.retryableErrors = opts.retryableErrors ?? [];
    this._currentModel = opts.initialModel ?? 'default';
  }

  get consecutive529(): number { return this._consecutive529; }
  get currentModel(): string { return this._currentModel; }

  delayMs(attempt: number): number {
    const exponential = Math.min(this.baseDelayMs * (2 ** attempt), this.maxDelayMs);
    const jitterAmount = exponential * this.jitter * (Math.random() * 2 - 1);
    return Math.max(1, Math.round(exponential + jitterAmount));
  }

  /** Pure: does not mutate. Returns a FallbackDecision to be applied via applyFallback(). */
  shouldFallback(error: AgentError): FallbackDecision {
    if (error.statusCode === 529 && this.fallbackModel) {
      const newCount = this._consecutive529 + 1;
      if (newCount >= 2) {
        return {
          needsFallback: true,
          consecutive529: 0,
          currentModel: this.fallbackModel,
        };
      }
      return {
        needsFallback: false,
        consecutive529: newCount,
        currentModel: this._currentModel,
      };
    }
    return {
      needsFallback: false,
      consecutive529: 0,
      currentModel: this._currentModel,
    };
  }

  /** Apply a FallbackDecision returned by shouldFallback(). */
  applyFallback(decision: FallbackDecision): void {
    this._consecutive529 = decision.consecutive529;
    this._currentModel = decision.currentModel;
  }

  /** Create a fresh copy with the same configuration but independent state. */
  clone(): RetryPolicy {
    const cloned = new RetryPolicy({
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      jitter: this.jitter,
      fallbackModel: this.fallbackModel,
      initialModel: this._currentModel,
      retryableErrors: [...this.retryableErrors],
    });
    return cloned;
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

/**
 * Shared default retry policy — mutable state is NOT shared-safe.
 * Each AgentLoop or withRetry consumer MUST clone() before use.
 */
export const DEFAULT_RETRY_POLICY = new RetryPolicy();

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  onRetry?: (attempt: number, error: AgentError, delayMs: number) => void
): Promise<T> {
  // Clone to isolate state (the policy may be the shared DEFAULT_RETRY_POLICY)
  const activePolicy = policy.clone();
  let lastError: AgentError | null = null;

  for (let attempt = 0; attempt <= activePolicy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = AgentError.from(err);

      const decision = activePolicy.shouldFallback(lastError);
      activePolicy.applyFallback(decision);

      if (decision.needsFallback) {
        // fallback model 切换后重试
        continue;
      }

      if (!activePolicy.isRetryable(lastError) || attempt === activePolicy.maxRetries) {
        throw lastError;
      }

      const delay = activePolicy.delayMs(attempt);
      onRetry?.(attempt, lastError, delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new AgentError('Max retries exceeded', 'fatal');
}
