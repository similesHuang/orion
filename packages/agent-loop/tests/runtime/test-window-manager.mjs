// tests/runtime/test-window-manager.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TruncateWindow, SlidingWindow } from '../../dist/runtime/window-manager.js';

function textMsg(role, content) {
  return { role, content };
}

function toolResultMsg() {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] };
}

function toolUseMsg() {
  return { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] };
}

describe('TruncateWindow', () => {
  it('should keep messages under limit unchanged', () => {
    const w = new TruncateWindow({ maxMessages: 10 });
    const msgs = [textMsg('system', 'you are'), textMsg('user', 'hi')];
    assert.equal(w.compress(msgs).length, 2);
  });

  it('should truncate when over limit', () => {
    const w = new TruncateWindow({ maxMessages: 5, headCount: 2 });
    const msgs = Array.from({ length: 10 }, (_, i) => textMsg('user', `msg ${i}`));
    const result = w.compress(msgs);
    assert.ok(result.length <= 5);
    assert.ok(result.some(m => typeof m.content === 'string' && m.content.includes('snipped')));
  });

  it('should estimate token count', () => {
    const w = new TruncateWindow();
    const msgs = [textMsg('user', 'hello world')]; // 11 chars ≈ 3 tokens
    assert.ok(w.estimateTokenCount(msgs) > 0);
  });
});

describe('SlidingWindow', () => {
  it('should slide when over token budget', () => {
    const w = new SlidingWindow({ maxTokens: 10, systemAlways: true });
    const msgs = [
      textMsg('system', 'xyz'),
      textMsg('user', 'hello world this is a long message that should push us over'),
      textMsg('user', 'more content'),
    ];
    const result = w.compress(msgs);
    assert.ok(result.length < msgs.length, 'should reduce message count');
    // system message stays
    assert.equal(result[0].role, 'system');
  });
});
