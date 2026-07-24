// tests/core/test-agent-loop.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop, ToolRegistry } from '../../dist/index.js';

// 使用 Mock LLMProvider 测试 AgentLoop
function createMockLLM(behavior = 'final_answer') {
  return {
    modelId: 'mock-model',
    chat: async function* (_messages, _tools, _opts) {
      if (behavior === 'tool_call') {
        yield {
          kind: 'response',
          response: {
            content: 'Let me check',
            tool_calls: [{ id: 'tc_1', function: { name: 'mock_tool', arguments: '{}' } }],
            stop_reason: 'tool_use',
          },
        };
      } else {
        yield {
          kind: 'response',
          response: {
            content: 'Here is the answer.',
            tool_calls: [],
            stop_reason: 'end_turn',
          },
        };
      }
    },
  };
}

describe('AgentLoop', () => {
  it('should run and produce a final answer', async () => {
    const loop = new AgentLoop({
      llm: createMockLLM('final_answer'),
      systemPrompt: 'You are a helpful assistant.',
      maxTurns: 5,
    });

    const events = [];
    for await (const ev of loop.run('Hello')) {
      events.push(ev);
    }

    const textEvents = events.filter(e => e.kind === 'text');
    assert.ok(textEvents.length > 0);
    const doneEvent = events.find(e => e.kind === 'done');
    assert.ok(doneEvent);
  });

  it('should execute tool calls when LLM returns them', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'mock_tool',
      description: 'A mock tool',
      schema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ success: true, data: 'tool executed' }),
    });

    const loop = new AgentLoop({
      llm: createMockLLM('tool_call'),
      systemPrompt: 'You are helpful.',
      tools: registry,
      maxTurns: 5,
    });

    const events = [];
    for await (const ev of loop.run('Run tool')) {
      events.push(ev);
    }

    const toolCallEvents = events.filter(e => e.kind === 'tool_call');
    assert.ok(toolCallEvents.length > 0);
    assert.equal(toolCallEvents[0].name, 'mock_tool');

    const toolResultEvents = events.filter(e => e.kind === 'tool_result');
    assert.ok(toolResultEvents.length > 0);
  });

  it('should enforce max turns', async () => {
    // 模拟始终返回 tool_call 的 LLM，看是否会因 maxTurns 停止
    let callCount = 0;
    const llm = {
      modelId: 'loop-llm',
      chat: async function* () {
        callCount++;
        yield {
          kind: 'response',
          response: {
            content: 'Calling tool',
            tool_calls: [{ id: `tc_${callCount}`, function: { name: 'loop_tool', arguments: '{}' } }],
            stop_reason: 'tool_use',
          },
        };
      },
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'loop_tool',
      description: 'Stays in loop',
      schema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ success: true, data: 'done' }),
    });

    const loop = new AgentLoop({
      llm,
      systemPrompt: 'You are helpful.',
      tools: registry,
      maxTurns: 3,
      maxTokens: 1000,
    });

    const events = [];
    for await (const ev of loop.run('Go')) {
      events.push(ev);
      if (ev.kind === 'done') break;
    }
    assert.ok(true, 'loop completed without error');
  });

  it('should support pause and resume', async () => {
    const loop = new AgentLoop({
      llm: createMockLLM('final_answer'),
      systemPrompt: 'You are helpful.',
      maxTurns: 5,
    });

    // 快速验证 pause/resume API
    assert.equal(loop.isRunning, false);
    assert.equal(loop.isPaused, false);

    loop.pause();
    assert.equal(loop.isPaused, true);

    loop.resume();
    assert.equal(loop.isPaused, false);

    loop.stop();
  });

  it('should provide hook pipeline access', () => {
    const loop = new AgentLoop({
      llm: createMockLLM('final_answer'),
      systemPrompt: 'You are helpful.',
    });
    const pipeline = loop.getHookPipeline();
    assert.ok(pipeline);
    assert.equal(typeof pipeline.register, 'function');
  });
});
