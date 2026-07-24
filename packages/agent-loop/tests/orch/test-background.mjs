import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTaskRunner } from '../../dist/orch/background.js';

describe('BackgroundTaskRunner', () => {
  it('should start a background task and complete it', async () => {
    const runner = new BackgroundTaskRunner();
    const id = await runner.start('echo', { msg: 'hello' }, async (args) => {
      await new Promise(r => setTimeout(r, 50));
      return { success: true, data: args.msg };
    });
    assert.ok(id.startsWith('bg_'));

    // 等待完成
    const result = await runner.awaitTask(id, 5000);
    assert.equal(result, 'hello');
  });

  it('should collect completed notifications', async () => {
    const runner = new BackgroundTaskRunner();
    await runner.start('fast', {}, async () => {
      return { success: true, data: 'done' };
    });

    // 等待短暂时间让任务完成
    await new Promise(r => setTimeout(r, 100));
    const notifications = runner.collect();
    assert.ok(notifications.length >= 1);
  });

  it('should track active count', async () => {
    const runner = new BackgroundTaskRunner(2);
    assert.equal(runner.getActiveCount(), 0);
    await runner.start('slow', {}, async () => {
      await new Promise(r => setTimeout(r, 200));
      return { success: true, data: 'ok' };
    });
    // 只有 running 状态时 active 才 +1
    await new Promise(r => setTimeout(r, 50));
    assert.equal(runner.getActiveCount(), 1);
  });

  it('should enforce max concurrent limit', async () => {
    const runner = new BackgroundTaskRunner(1);
    await runner.start('a', {}, async () => {
      await new Promise(r => setTimeout(r, 200));
      return { success: true, data: 'a' };
    });
    await assert.rejects(
      () => runner.start('b', {}, async () => ({ success: true, data: 'b' })),
      /Max concurrent/
    );
  });

  it('should handle task failure', async () => {
    const runner = new BackgroundTaskRunner();
    const id = await runner.start('failing', {}, async () => {
      return { success: false, error: 'Something went wrong' };
    });
    await assert.rejects(
      () => runner.awaitTask(id, 5000),
      /Something went wrong/
    );
  });

  it('should return null for unknown task getResult', () => {
    const runner = new BackgroundTaskRunner();
    assert.equal(runner.getResult('nonexistent'), null);
  });

  it('should throw on timeout', async () => {
    const runner = new BackgroundTaskRunner();
    const id = await runner.start('slow', {}, async () => {
      await new Promise(r => setTimeout(r, 5000));
      return { success: true, data: 'too late' };
    });
    await assert.rejects(
      () => runner.awaitTask(id, 100),
      /timed out/
    );
  });

  it('should collect failed task notification', async () => {
    const runner = new BackgroundTaskRunner();
    await runner.start('fail-collect', {}, async () => {
      return { success: false, error: 'fail msg' };
    });
    await new Promise(r => setTimeout(r, 100));
    const notifications = runner.collect();
    assert.ok(notifications.length >= 1);
    assert.ok(notifications[0].content.includes('failed'));
    assert.equal(notifications[0].summary, 'fail msg');
  });
});
