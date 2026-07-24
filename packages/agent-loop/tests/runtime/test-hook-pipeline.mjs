// tests/runtime/test-hook-pipeline.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HookPipeline } from '../../dist/runtime/hook-pipeline.js';

describe('HookPipeline', () => {
  it('should register and run a beforeTool handler', async () => {
    const pipeline = new HookPipeline();
    const calls = [];
    pipeline.register('beforeTool', (ctx) => {
      calls.push(ctx.toolName);
      return null;
    });
    await pipeline.run('beforeTool', { toolName: 'bash', args: {} });
    assert.deepEqual(calls, ['bash']);
  });

  it('should block when handler returns denied', async () => {
    const pipeline = new HookPipeline();
    pipeline.register('beforeTool', () => ({ denied: true, reason: 'blocked by policy' }));
    const result = await pipeline.run('beforeTool', { toolName: 'rm', args: {} });
    assert.notEqual(result, null);
    assert.equal(result.denied, true);
    assert.equal(result.reason, 'blocked by policy');
  });

  it('should stop on first denial', async () => {
    const pipeline = new HookPipeline();
    const calls = [];
    pipeline.register('beforeTool', () => { calls.push('a'); return null; });
    pipeline.register('beforeTool', () => { calls.push('b'); return { denied: true, reason: 'no' }; });
    pipeline.register('beforeTool', () => { calls.push('c'); return null; });
    await pipeline.run('beforeTool', { toolName: 'x', args: {} });
    assert.deepEqual(calls, ['a', 'b']); // 'c' not called
  });

  it('should unregister a handler', () => {
    const pipeline = new HookPipeline();
    const h = () => null;
    pipeline.register('beforeTool', h);
    assert.equal(pipeline.count('beforeTool'), 1);
    pipeline.unregister('beforeTool', h);
    assert.equal(pipeline.count('beforeTool'), 0);
  });

  it('should clear all handlers for a phase', () => {
    const pipeline = new HookPipeline();
    pipeline.register('beforeTool', () => null);
    pipeline.register('afterTool', () => null);
    pipeline.clear('beforeTool');
    assert.equal(pipeline.count('beforeTool'), 0);
    assert.equal(pipeline.count('afterTool'), 1);
  });

  it('should do nothing when no handlers registered', async () => {
    const pipeline = new HookPipeline();
    const result = await pipeline.run('onError', { error: new Error('test'), turn: 1 });
    assert.equal(result, null);
  });
});
