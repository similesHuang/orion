// tests/runtime/test-memory-store.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../../dist/runtime/memory-store.js';

describe('InMemoryStore', () => {
  it('should store and retrieve memories', async () => {
    const store = new InMemoryStore();
    const id = await store.store({ content: 'user prefers TypeScript', type: 'user_fact', tags: ['preference'] });
    assert.ok(id.startsWith('mem_'));
    const results = await store.retrieve('');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'user prefers TypeScript');
  });

  it('should limit retrieve results', async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 10; i++) {
      await store.store({ content: `item ${i}`, type: 'reference', tags: [] });
    }
    const results = await store.retrieve('', 3);
    assert.equal(results.length, 3);
  });

  it('should forget a memory', async () => {
    const store = new InMemoryStore();
    const id = await store.store({ content: 'temp', type: 'user_fact', tags: [] });
    await store.forget(id);
    assert.equal(store.count(), 0);
  });

  it('should clear all memories', async () => {
    const store = new InMemoryStore();
    await store.store({ content: 'a', type: 'user_fact', tags: [] });
    await store.store({ content: 'b', type: 'reference', tags: [] });
    await store.clear();
    assert.equal(store.count(), 0);
  });
});
