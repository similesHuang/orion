// tests/core/test-sub-agent.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'fs';
import { createSubAgent, SubAgentPool, StateSerializer, AgentLoop } from '../../dist/index.js';

describe('SubAgentPool', () => {
  it('should create a sub-agent and return result', async () => {
    // 使用 mock LLM
    const mockLLM = {
      modelId: 'mock',
      chat: async function* () {
        yield {
          kind: 'response',
          response: {
            content: 'Task complete. Found the answer: 42.',
            tool_calls: [],
            stop_reason: 'end_turn',
          },
        };
      },
    };

    const result = await createSubAgent(mockLLM, {
      description: 'What is the meaning of life?',
      systemPrompt: 'You are a philosopher.',
    });

    assert.ok(result.summary.includes('42'));
  });

  it('should return cost tracking interface', () => {
    // SubAgentPool 需要 AgentLoop 实例
    const llm = {
      modelId: 'mock',
      chat: async function* () {
        yield { kind: 'response', response: { content: 'ok', tool_calls: [], stop_reason: 'end_turn' } };
      },
    };
    const loop = new AgentLoop({ llm, systemPrompt: 'test' });
    const pool = new SubAgentPool(loop);
    const cost = pool.getTotalCost();
    assert.equal(typeof cost.total, 'number');
  });
});

describe('StateSerializer', () => {
  it('should serialize agent state', () => {
    const llm = {
      modelId: 'mock',
      chat: async function* () {
        yield { kind: 'response', response: { content: 'ok', tool_calls: [], stop_reason: 'end_turn' } };
      },
    };
    const loop = new AgentLoop({ llm, systemPrompt: 'test' });
    const state = StateSerializer.serialize(loop);
    assert.equal(state.version, '0.1.0');
    assert.equal(state.turn, 0);
    assert.ok(state.messages.length > 0);
    assert.equal(state.messages[0].role, 'system');
  });

  it('should deserialize state', () => {
    const state = {
      version: '0.1.0',
      messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'hi' }],
      turn: 3,
      timestamp: Date.now(),
    };
    const { messages, turn } = StateSerializer.deserialize(state);
    assert.equal(messages.length, 2);
    assert.equal(turn, 3);
  });

  it('should save and load from file', async () => {
    const llm = {
      modelId: 'mock',
      chat: async function* () {
        yield { kind: 'response', response: { content: 'ok', tool_calls: [], stop_reason: 'end_turn' } };
      },
    };
    const loop = new AgentLoop({ llm, systemPrompt: 'test' });
    const tmpPath = '/tmp/test-agent-state.json';
    await StateSerializer.saveToFile(loop, tmpPath);
    const loaded = await StateSerializer.loadFromFile(tmpPath);
    assert.equal(loaded.version, '0.1.0');
    unlinkSync(tmpPath);
  });
});
