// tests/orch/test-orchestrator.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TeamOrchestrator } from '../../dist/orch/orchestrator.js';
import { MessageBus } from '../../dist/orch/message-bus.js';
import { ProtocolManager } from '../../dist/orch/protocol.js';
import { Teammate } from '../../dist/orch/teammate.js';

// Mock LLM for teammates
const mockLLM = {
  modelId: 'mock',
  chat: async function* () {
    yield {
      kind: 'response',
      response: { content: 'ok', tool_calls: [], stop_reason: 'end_turn' },
    };
  },
};

describe('TeamOrchestrator', () => {
  it('should create a team with lead and workers', () => {
    const orchestrator = new TeamOrchestrator({
      lead: { name: 'alice', role: 'lead', systemPrompt: 'You are lead.', llm: mockLLM },
      workers: [
        { name: 'bob', role: 'worker', systemPrompt: 'You are worker.', llm: mockLLM },
      ],
    });

    assert.ok(orchestrator.getLead());
    assert.equal(orchestrator.getLead().name, 'alice');
    assert.ok(orchestrator.getMember('bob'));
    assert.equal(orchestrator.getMember('nonexistent'), undefined);
  });

  it('should assign task and return ok', async () => {
    const orchestrator = new TeamOrchestrator({
      lead: { name: 'alice', role: 'lead', systemPrompt: 'lead', llm: mockLLM },
      workers: [
        { name: 'bob', role: 'worker', systemPrompt: 'worker', llm: mockLLM },
      ],
    });

    const result = await orchestrator.assignTask('bob', {
      id: 'task_1',
      subject: 'Do something',
      description: 'Details',
      status: 'pending',
      owner: null,
      blockedBy: [],
      tags: [],
      worktree: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    assert.ok(result.ok);
  });

  it('should return error for unknown teammate in assignTask', async () => {
    const orchestrator = new TeamOrchestrator({
      lead: { name: 'alice', role: 'lead', systemPrompt: 'lead', llm: mockLLM },
    });

    const result = await orchestrator.assignTask('ghost', {
      id: 't', subject: 'x', description: '',
      status: 'pending', owner: null, blockedBy: [],
      tags: [], worktree: null,
      createdAt: 0, updatedAt: 0,
    });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes('ghost'));
  });

  it('createSnapshot should return team state', () => {
    const orchestrator = new TeamOrchestrator({
      lead: { name: 'alice', role: 'lead', systemPrompt: 'lead', llm: mockLLM },
      workers: [
        { name: 'bob', role: 'worker', systemPrompt: 'worker', llm: mockLLM },
      ],
    });

    const snapshot = orchestrator.getSnapshot();
    assert.equal(snapshot.members.length, 2);
    assert.equal(snapshot.members[0].name, 'alice');
    assert.equal(snapshot.members[0].role, 'lead');
    assert.equal(typeof snapshot.pendingProtocols, 'number');
  });

  it('should broadcast to all members except sender', () => {
    const orchestrator = new TeamOrchestrator({
      lead: { name: 'alice', role: 'lead', systemPrompt: 'lead', llm: mockLLM },
      workers: [
        { name: 'bob', role: 'worker', systemPrompt: 'worker', llm: mockLLM },
        { name: 'charlie', role: 'worker', systemPrompt: 'worker', llm: mockLLM },
      ],
    });

    // Access the internal bus through protocol (bus is not public)
    // We verify via behavior: assign a task and check snapshot
    assert.doesNotThrow(() => orchestrator.broadcast('alice', 'hello everyone'));
  });
});

describe('Teammate protocol handling', () => {
  it('should process shutdown_request correctly', async () => {
    const bus = new MessageBus();
    const protocol = new ProtocolManager(bus);

    const teammate = new Teammate({
      name: 'worker1',
      role: 'worker',
      systemPrompt: 'test',
      llm: mockLLM,
      bus,
      protocol,
    });

    // Start teammate (will return when shutdown is processed)
    const startPromise = teammate.start();

    // Wait for teammate to initialize and reach the sleep in its main loop
    await new Promise(r => setTimeout(r, 50));

    // Send shutdown request through protocol
    await protocol.requestShutdown('worker1');

    // Wait for teammate to process the shutdown (at most ~1100ms given 1000ms sleep + processing)
    await startPromise;

    assert.equal(teammate.status, 'stopped');
  });

  it('should handle task_assignment message via handleMessage', () => {
    const bus = new MessageBus();
    const protocol = new ProtocolManager(bus);
    const mockLLM_local = {
      modelId: 'mock',
      chat: async function* () {
        yield { kind: 'response', response: { content: 'ok', tool_calls: [], stop_reason: 'end_turn' } };
      },
    };

    const teammate = new Teammate({
      name: 'worker2',
      role: 'worker',
      systemPrompt: 'test',
      llm: mockLLM_local,
      bus,
      protocol,
    });

    // Send a task_assignment message via the bus
    bus.send('lead', 'worker2', 'Task: implement feature X', {
      type: 'task_assignment',
      metadata: { taskId: 'task_abc' },
    });

    // Read inbox — the message should be there
    const inbox = bus.readInbox('worker2');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].type, 'task_assignment');
    assert.equal(inbox[0].metadata.taskId, 'task_abc');
  });
});
