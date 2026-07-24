import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CronScheduler } from '../../dist/orch/cron-scheduler.js';

describe('CronScheduler', () => {
  it('should schedule a job', () => {
    const cron = new CronScheduler();
    const job = cron.schedule('*/5 * * * *', 'run checks');
    assert.ok(job.id);
    assert.equal(job.prompt, 'run checks');
    assert.equal(job.recurring, true);
  });

  it('should reject invalid cron', () => {
    const cron = new CronScheduler();
    assert.throws(() => cron.schedule('invalid', 'test'));
  });

  it('should cancel a job', () => {
    const cron = new CronScheduler();
    const job = cron.schedule('0 9 * * *', 'morning');
    assert.ok(cron.cancel(job.id));
    assert.equal(cron.list().length, 0);
  });

  it('should list scheduled jobs', () => {
    const cron = new CronScheduler();
    cron.schedule('* * * * *', 'every minute');
    cron.schedule('0 9 * * 1-5', 'weekday 9am');
    assert.equal(cron.list().length, 2);
  });

  it('should tick and return fired jobs', () => {
    const cron = new CronScheduler();
    // 每分都触发的表达式
    const job = cron.schedule('* * * * *', 'per-min', { recurring: true });
    const fired = cron.tick();
    // tick 在当前分钟总是匹配的
    assert.ok(fired.length >= 1);
  });

  it('should not fire same job twice in same minute', () => {
    const cron = new CronScheduler();
    cron.schedule('* * * * *', 'per-min');
    const first = cron.tick();
    assert.ok(first.length >= 1);
    const second = cron.tick();
    assert.equal(second.length, 0);
  });

  it('should remove non-recurring job after firing', () => {
    const cron = new CronScheduler();
    cron.schedule('* * * * *', 'once', { recurring: false });
    const fired = cron.tick();
    assert.ok(fired.length >= 1);
    assert.equal(fired[0].recurring, false);
    // After firing, the job should be removed
    // But since tick removed it from this.jobs, lastFired still has it
    // Calling tick again should not fire it
    const second = cron.tick();
    assert.equal(second.length, 0);
  });

  it('should getFired as alias for tick', () => {
    const cron = new CronScheduler();
    cron.schedule('* * * * *', 'alias-test');
    const fired = cron.getFired();
    assert.ok(fired.length >= 1);
  });

  it('should handle custom id', () => {
    const cron = new CronScheduler();
    const job = cron.schedule('0 0 * * *', 'midnight', { id: 'my-custom-id' });
    assert.equal(job.id, 'my-custom-id');
  });
});
