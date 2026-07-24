// tests/runtime/test-agent-error.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentError } from '../../dist/runtime/agent-error.js';

describe('AgentError', () => {
  it('should classify 429 as retryable', () => {
    const err = AgentError.from(new Error('RateLimit: 429 Too Many Requests'));
    assert.equal(err.severity, 'retryable');
    assert.equal(err.retryable, true);
    assert.equal(err.statusCode, 429);
  });

  it('should classify auth errors as fatal', () => {
    const err = AgentError.from(new Error('401 Unauthorized'));
    assert.equal(err.severity, 'fatal');
    assert.equal(err.retryable, false);
  });

  it('should classify context overflow', () => {
    const err = AgentError.from(new Error('context_length_exceeded'));
    assert.equal(err.severity, 'context_overflow');
  });

  it('should wrap an unknown error as retryable', () => {
    const err = AgentError.from('network disconnected');
    assert.equal(err.severity, 'retryable');
  });

  it('should preserve original AgentError', () => {
    const original = new AgentError('custom', 'fatal');
    const wrapped = AgentError.from(original);
    assert.equal(wrapped, original);
  });
});
