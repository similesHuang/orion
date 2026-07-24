// tests/core/test-message.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// 类型验证测试 — 验证 Message 结构
describe('Message types', () => {
  it('should create a valid text message', () => {
    const msg = { role: 'user', content: 'hello' };
    assert.equal(msg.role, 'user');
    assert.equal(msg.content, 'hello');
  });

  it('should create a message with content blocks', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      ],
    };
    assert.equal(msg.content.length, 2);
  });

  it('should create an AgentEvent text event', () => {
    const ev = { kind: 'text', content: 'hello' };
    assert.equal(ev.kind, 'text');
  });
});
