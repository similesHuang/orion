// tests/orch/test-message-bus.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBus } from '../../dist/orch/message-bus.js';
import { ProtocolManager } from '../../dist/orch/protocol.js';

describe('MessageBus', () => {
  it('should send and receive messages', () => {
    const bus = new MessageBus();
    bus.send('alice', 'bob', 'hello');
    const inbox = bus.readInbox('bob');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, 'alice');
    assert.equal(inbox[0].content, 'hello');
  });

  it('should clear inbox after read', () => {
    const bus = new MessageBus();
    bus.send('alice', 'bob', 'msg1');
    bus.readInbox('bob');
    assert.equal(bus.readInbox('bob').length, 0);
  });

  it('should peek without consuming', () => {
    const bus = new MessageBus();
    bus.send('alice', 'bob', 'peek');
    const peeked = bus.peek('bob');
    assert.equal(peeked.length, 1);
    // 再次读取仍然有
    assert.equal(bus.readInbox('bob').length, 1);
  });

  it('should handle multiple recipients', () => {
    const bus = new MessageBus();
    bus.send('alice', 'bob', 'hi');
    bus.send('alice', 'charlie', 'hello');
    assert.equal(bus.readInbox('bob').length, 1);
    assert.equal(bus.readInbox('charlie').length, 1);
  });
});

describe('ProtocolManager', () => {
  it('should create and track a plan approval request', () => {
    const bus = new MessageBus();
    const protocol = new ProtocolManager(bus);
    const reqId = protocol.submitPlan('worker1', 'Plan: build feature X');
    assert.ok(reqId.startsWith('req_'));

    const state = protocol.getPending(reqId);
    assert.ok(state);
    assert.equal(state.status, 'pending');
  });

  it('should approve a plan', () => {
    const bus = new MessageBus();
    const protocol = new ProtocolManager(bus);
    const reqId = protocol.submitPlan('worker1', 'my plan');
    protocol.reviewPlan(reqId, true, 'Looks good');
    const state = protocol.getPending(reqId);
    assert.equal(state.status, 'approved');
  });
});
