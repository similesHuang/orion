// tests/runtime/test-retry-policy.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentError } from '../../dist/runtime/agent-error.js';
import { RetryPolicy, withRetry, DEFAULT_RETRY_POLICY } from '../../dist/runtime/retry-policy.js';

describe('RetryPolicy', () => {
  it('should compute exponential delay', () => {
    const policy = new RetryPolicy({ baseDelayMs: 1000, jitter: 0 });
    assert.ok(policy.delayMs(0) >= 1000);
    assert.ok(policy.delayMs(1) >= 2000);
    assert.ok(policy.delayMs(5) >= 32000, 'should cap at maxDelayMs');
  });

  it('should retry on retryable errors', async () => {
    let attempts = 0;
    const policy = new RetryPolicy({ maxRetries: 2, baseDelayMs: 10, jitter: 0 });
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        throw new AgentError('rate limit', 'retryable', 429);
      }, policy),
      { message: 'rate limit' }
    );
    assert.equal(attempts, 3); // 1 initial + 2 retries
  });

  it('should not retry fatal errors', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        throw new AgentError('auth failed', 'fatal');
      }, DEFAULT_RETRY_POLICY),
      { message: 'auth failed' }
    );
    assert.equal(attempts, 1);
  });
});
