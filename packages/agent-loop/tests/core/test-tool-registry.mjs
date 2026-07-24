// tests/core/test-tool-registry.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../dist/core/tool-registry.js';

describe('ToolRegistry', () => {
  it('should register and retrieve a tool', () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'bash',
      description: 'Run a shell command',
      schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      handler: async (args) => ({ success: true, data: `ran: ${args.command}` }),
    });
    assert.ok(reg.get('bash'));
    assert.equal(reg.size, 1);
  });

  it('should throw on duplicate registration', () => {
    const reg = new ToolRegistry();
    reg.register({ name: 'x', description: '', schema: {}, handler: async () => ({ success: true, data: null }) });
    assert.throws(() => reg.register({ name: 'x', description: '', schema: {}, handler: async () => ({ success: true, data: null }) }));
  });

  it('should chain registerTools', () => {
    const reg = new ToolRegistry();
    reg.registerTools([
      { name: 'a', description: '', schema: {}, handler: async () => ({ success: true, data: null }) },
      { name: 'b', description: '', schema: {}, handler: async () => ({ success: true, data: null }) },
    ]);
    assert.equal(reg.size, 2);
  });

  it('should generate LLM schemas excluding hidden', () => {
    const reg = new ToolRegistry();
    reg.register({ name: 'visible', description: 'shown', schema: { type: 'object', properties: {} }, handler: async () => ({ success: true, data: null }) });
    reg.register({ name: 'hidden', description: 'internal', schema: { type: 'object', properties: {} }, handler: async () => ({ success: true, data: null }), hidden: true });
    const schemas = reg.getSchemas();
    assert.equal(schemas.length, 1);
    assert.equal(schemas[0].name, 'visible');
  });

  it('should execute a tool and return result', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'echo', description: '', schema: { type: 'object', properties: { msg: { type: 'string' } }, required: [] },
      handler: async (args) => ({ success: true, data: (args).msg ?? 'ok' }),
    });
    const result = await reg.execute('echo', { msg: 'hello' });
    assert.equal(result.success, true);
    assert.equal(result.data, 'hello');
  });

  it('should return error for unknown tool', async () => {
    const reg = new ToolRegistry();
    const result = await reg.execute('nope', {});
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Unknown'));
  });

  it('should handle handler rejection gracefully', async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: 'fail', description: '', schema: {},
      handler: async () => { throw new Error('oops'); },
    });
    const result = await reg.execute('fail', {});
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('oops'));
  });

  it('should remove a tool', () => {
    const reg = new ToolRegistry();
    reg.register({ name: 'tmp', description: '', schema: {}, handler: async () => ({ success: true, data: null }) });
    assert.ok(reg.remove('tmp'));
    assert.equal(reg.size, 0);
  });

  it('should clear all tools', () => {
    const reg = new ToolRegistry();
    reg.register({ name: 'a', description: '', schema: {}, handler: async () => ({ success: true, data: null }) });
    reg.register({ name: 'b', description: '', schema: {}, handler: async () => ({ success: true, data: null }) });
    assert.equal(reg.size, 2);
    reg.clear();
    assert.equal(reg.size, 0);
  });
});
