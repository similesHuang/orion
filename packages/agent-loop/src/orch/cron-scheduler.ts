export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  createdAt: number;
}

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private fired: CronJob[] = [];
  private lastFired = new Map<string, string>();  // jobId → "YYYY-MM-DD HH:MM"

  schedule(cron: string, prompt: string, opts?: {
    recurring?: boolean;
    id?: string;
  }): CronJob {
    const err = this.validateCron(cron);
    if (err) throw new Error(`Invalid cron expression: ${err}`);

    const job: CronJob = {
      id: opts?.id ?? `cron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      cron,
      prompt,
      recurring: opts?.recurring ?? true,
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  cancel(jobId: string): boolean {
    return this.jobs.delete(jobId);
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /** 每秒调用，检查哪些 job 触发 */
  tick(): CronJob[] {
    const now = new Date();
    const marker = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const triggered: CronJob[] = [];

    for (const job of this.jobs.values()) {
      if (this.cronMatches(job.cron, now) && this.lastFired.get(job.id) !== marker) {
        triggered.push(job);
        this.lastFired.set(job.id, marker);
        if (!job.recurring) {
          this.jobs.delete(job.id);
        }
      }
    }

    return triggered;
  }

  /** 消费已触发 job */
  consumeFired(): CronJob[] {
    const fired = [...this.fired];
    this.fired = [];
    return fired;
  }

  /** tick 的别名：返回触发的 job */
  getFired(): CronJob[] {
    return this.tick();
  }

  // ── 内部：cron 匹配 ──
  private fieldMatches(field: string, value: number): boolean {
    if (field === '*') return true;
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2));
      return step > 0 && value % step === 0;
    }
    if (field.includes(',')) {
      return field.split(',').some(part => this.fieldMatches(part.trim(), value));
    }
    if (field.includes('-')) {
      const [lo, hi] = field.split('-', 2);
      return parseInt(lo) <= value && value <= parseInt(hi);
    }
    return parseInt(field) === value;
  }

  private cronMatches(expr: string, dt: Date): boolean {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return false;

    const [minute, hour, dom, month, dow] = fields;
    const dowVal = dt.getDay();
    const monthVal = dt.getMonth() + 1;

    return (
      this.fieldMatches(minute, dt.getMinutes()) &&
      this.fieldMatches(hour, dt.getHours()) &&
      this.fieldMatches(dom, dt.getDate()) &&
      this.fieldMatches(month, monthVal) &&
      this.fieldMatches(dow, dowVal)
    );
  }

  private validateCron(expr: string): string | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
    return null;
  }
}
