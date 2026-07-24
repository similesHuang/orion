import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { TaskStore } from '../../dist/orch/task-store.js';

const TEST_DIR = '.test_tasks';

describe('TaskStore', () => {
  before(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR);
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('should create a task', () => {
    const store = new TaskStore(TEST_DIR);
    const task = store.create({ subject: 'Test task', description: 'A test' });
    assert.ok(task.id.startsWith('task_'));
    assert.equal(task.subject, 'Test task');
    assert.equal(task.status, 'pending');
    assert.equal(task.owner, null);
  });

  it('should retrieve a task by id', () => {
    const store = new TaskStore(TEST_DIR);
    const created = store.create({ subject: 'find me' });
    const found = store.get(created.id);
    assert.ok(found);
    assert.equal(found.subject, 'find me');
  });

  it('should list tasks with filter', () => {
    const store = new TaskStore(TEST_DIR);
    store.create({ subject: 'a' });
    store.create({ subject: 'b' });
    const all = store.list();
    assert.ok(all.length >= 2);
  });

  it('should claim a pending task', () => {
    const store = new TaskStore(TEST_DIR);
    const task = store.create({ subject: 'claimable' });
    const claimed = store.claim(task.id, 'worker1');
    assert.ok(claimed);
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.owner, 'worker1');
  });

  it('should reject double claim', () => {
    const store = new TaskStore(TEST_DIR);
    const task = store.create({ subject: 'double claim' });
    store.claim(task.id, 'a');
    const result = store.claim(task.id, 'b');
    assert.equal(result, null);
  });

  it('should complete a claimed task', () => {
    const store = new TaskStore(TEST_DIR);
    const task = store.create({ subject: 'complete me' });
    store.claim(task.id, 'me');
    const completed = store.complete(task.id);
    assert.equal(completed.status, 'completed');
  });

  it('should enforce dependencies via canStart', () => {
    const store = new TaskStore(TEST_DIR);
    const dep = store.create({ subject: 'dependency' });
    const task = store.create({ subject: 'dependent', blockedBy: [dep.id] });
    const { ok, blockers } = store.canStart(task.id);
    assert.equal(ok, false);
    assert.ok(blockers.length > 0);
  });

  it('should fail a task', () => {
    const store = new TaskStore(TEST_DIR);
    const task = store.create({ subject: 'fail me' });
    // must claim before failing
    store.claim(task.id, 'me');
    const failed = store.fail(task.id, 'something broke');
    assert.equal(failed.status, 'failed');
  });

  it('should delete a task', () => {
    const store = new TaskStore(TEST_DIR);
    const task = store.create({ subject: 'delete me' });
    store.delete(task.id);
    assert.equal(store.get(task.id), null);
  });
});
