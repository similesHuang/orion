export interface BackgroundTask {
  id: string;
  status: 'running' | 'completed' | 'failed';
  toolName: string;
  result?: unknown;
  error?: string;
  createdAt: number;
}

export interface BackgroundNotification {
  content: string;
  taskId: string;
  summary: string;
}

export class BackgroundTaskRunner {
  private tasks = new Map<string, BackgroundTask>();
  private maxConcurrent: number;
  private counter = 0;
  private running = 0;

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  async start<T>(
    toolName: string,
    args: T,
    handler: (args: T) => Promise<{ success: boolean; data?: unknown; error?: string }>
  ): Promise<string> {
    if (this.running >= this.maxConcurrent) {
      throw new Error(`Max concurrent tasks reached: ${this.maxConcurrent}`);
    }

    const id = `bg_${++this.counter}`;
    this.tasks.set(id, {
      id,
      status: 'running',
      toolName,
      createdAt: Date.now(),
    });
    this.running++;

    // 异步执行
    handler(args)
      .then(result => {
        const task = this.tasks.get(id)!;
        task.status = result.success ? 'completed' : 'failed';
        task.result = result.data;
        task.error = result.error;
        this.running--;
      })
      .catch(err => {
        const task = this.tasks.get(id)!;
        task.status = 'failed';
        task.error = String(err);
        this.running--;
      });

    return id;
  }

  getResult(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** 收集已完成的结果（消费模式） */
  collect(): BackgroundNotification[] {
    const notifications: BackgroundNotification[] = [];
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed') {
        notifications.push({
          content: task.status === 'completed' ? `Background task ${id} completed.` : `Background task ${id} failed: ${task.error}`,
          taskId: id,
          summary: task.status === 'completed' ? String(task.result ?? '') : (task.error ?? ''),
        });
        this.tasks.delete(id);
      }
    }
    return notifications;
  }

  /** 等待特定任务完成 */
  async awaitTask(taskId: string, timeoutMs = 30000): Promise<unknown> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status === 'completed') return task.result;
      if (task.status === 'failed') throw new Error(task.error ?? 'Task failed');
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms`);
  }

  getActiveCount(): number {
    return this.running;
  }
}
