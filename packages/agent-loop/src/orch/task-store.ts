import { randomBytes } from 'crypto';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  owner: string | null;
  blockedBy: string[];
  tags: string[];
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskCreateOptions {
  subject: string;
  description?: string;
  blockedBy?: string[];
  tags?: string[];
  worktree?: string;
}

export interface TaskFilter {
  status?: Task['status'];
  owner?: string;
  tags?: string[];
}

function generateId(): string {
  return `task_${Date.now()}_${randomBytes(2).toString('hex')}`;
}

export class TaskStore {
  private basePath: string;
  private cache: Map<string, Task> = new Map();

  constructor(basePath?: string) {
    this.basePath = basePath ?? '.tasks';
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
    this.loadAll();
  }

  create(opts: TaskCreateOptions): Task {
    const task: Task = {
      id: generateId(),
      subject: opts.subject,
      description: opts.description ?? '',
      status: 'pending',
      owner: null,
      blockedBy: opts.blockedBy ?? [],
      tags: opts.tags ?? [],
      worktree: opts.worktree ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.cache.set(task.id, task);
    this.persist(task);
    return task;
  }

  get(id: string): Task | null {
    return this.cache.get(id) ?? null;
  }

  list(filter?: TaskFilter): Task[] {
    let tasks = Array.from(this.cache.values());
    if (filter) {
      if (filter.status) tasks = tasks.filter(t => t.status === filter.status);
      if (filter.owner) tasks = tasks.filter(t => t.owner === filter.owner);
      if (filter.tags) tasks = tasks.filter(t => filter.tags!.some(tag => t.tags.includes(tag)));
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  update(id: string, changes: Partial<Task>): Task {
    const task = this.cache.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    Object.assign(task, changes, { updatedAt: Date.now() });
    this.persist(task);
    return task;
  }

  canStart(id: string): { ok: boolean; blockers: string[] } {
    const task = this.cache.get(id);
    if (!task) return { ok: false, blockers: ['task not found'] };
    const blockers = task.blockedBy
      .map(bid => this.cache.get(bid))
      .filter(t => !t || t.status !== 'completed')
      .map(t => t?.subject ?? '(deleted)');
    return { ok: blockers.length === 0, blockers };
  }

  claim(id: string, owner: string): Task | null {
    const task = this.cache.get(id);
    if (!task) return null;
    if (task.status !== 'pending') return null;
    if (task.owner) return null;
    const { ok } = this.canStart(id);
    if (!ok) return null;
    task.status = 'in_progress';
    task.owner = owner;
    task.updatedAt = Date.now();
    this.persist(task);
    return task;
  }

  complete(id: string): Task {
    const task = this.cache.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (task.status !== 'in_progress') throw new Error(`Task ${id} is ${task.status}, cannot complete`);
    task.status = 'completed';
    task.updatedAt = Date.now();
    this.persist(task);
    return task;
  }

  fail(id: string, reason: string): Task {
    const task = this.cache.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = 'failed';
    task.description += `\n[Failed] ${reason}`;
    task.updatedAt = Date.now();
    this.persist(task);
    return task;
  }

  delete(id: string): void {
    this.cache.delete(id);
    const path = this.taskPath(id);
    if (existsSync(path)) unlinkSync(path);
  }

  private taskPath(id: string): string {
    return join(this.basePath, `${id}.json`);
  }

  private persist(task: Task): void {
    writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), 'utf-8');
  }

  private loadAll(): void {
    if (!existsSync(this.basePath)) return;
    const files = readdirSync(this.basePath).filter(f => f.startsWith('task_') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(this.basePath, file), 'utf-8')) as Task;
        this.cache.set(task.id, task);
      } catch {
        // skip corrupted files
      }
    }
  }
}
