import { AgentError } from './errors.js';
import { sleep } from '../shared/index.js';

export interface RetryPolicy {
  maxRetries: number;
  baseDelay: number;
  backoff: 'exponential' | 'linear';
  retryOn: string[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelay: 1000,
  backoff: 'exponential',
  retryOn: ['rate_limit', 'server_error', 'network_error'],
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const ae = AgentError.from(e);
      if (ae.severity === 'fatal' || !policy.retryOn.includes(ae.code)) {
        throw ae;
      }
      if (attempt < policy.maxRetries) {
        const delay = policy.backoff === 'exponential'
          ? policy.baseDelay * 2 ** attempt
          : policy.baseDelay;
        await sleep(delay);
      }
    }
  }
  throw AgentError.from(lastError);
}
