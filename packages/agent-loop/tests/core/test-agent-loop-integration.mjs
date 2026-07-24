// tests/core/test-agent-loop-integration.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, ToolRegistry } from '../../dist/index.js';

// 完整集成测试：AgentLoop + ToolRegistry + HookPipeline
describe('AgentLoop Integration', () => {
  it('should work with hooks and memory store', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Echo back the message',
      schema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: [],
      },
      handler: async (args) => ({ success: true, data: args.msg ?? 'echo' }),
    });

    const llm = {
      modelId: 'test',
      chat: async function* (_messages, tools) {
        // 发送一个工具调用
        yield {
          kind: 'response',
          response: {
            content: 'Using echo',
            tool_calls: [{ id: 'tc_echo', function: { name: 'echo', arguments: '{"msg":"hi"}' } }],
            stop_reason: 'tool_use',
          },
        };
      },
    };

    const loop = new AgentLoop({
      llm,
      systemPrompt: 'Test agent',
      tools: registry,
      maxTurns: 5,
    });

    // 注册一个 hook
    const hookCalls = [];
    loop.getHookPipeline().register('beforeTool', (ctx) => {
      hookCalls.push(ctx.toolName);
      return null;
    });

    const events = [];
    for await (const ev of loop.run('test')) {
      events.push(ev);
    }

    assert.ok(hookCalls.includes('echo'));
    const toolResults = events.filter(e => e.kind === 'tool_result');
    assert.ok(toolResults.length > 0);
  });
});
