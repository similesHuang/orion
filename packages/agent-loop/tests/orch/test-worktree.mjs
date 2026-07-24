// tests/orch/test-worktree.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorktreeManager } from '../../dist/orch/worktree.js';

describe('WorktreeManager', () => {
  it('should validate names', () => {
    assert.ok(WorktreeManager.validateName('feature-x'));
    assert.ok(WorktreeManager.validateName('fix_123'));
    assert.equal(WorktreeManager.validateName(''), false);
    assert.equal(WorktreeManager.validateName('.'), false);
    assert.equal(WorktreeManager.validateName('..'), false);
    assert.equal(WorktreeManager.validateName('name with spaces'), false);
  });

  it('should list worktrees', () => {
    const mgr = new WorktreeManager('.test_worktrees');
    const list = mgr.list();
    assert.ok(Array.isArray(list));
  });
});
