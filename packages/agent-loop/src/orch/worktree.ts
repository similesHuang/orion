import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  createdAt: number;
  changes?: { files: number; commits: number };
}

export type CreateResult = { ok: true; path: string } | { ok: false; error: string };
export type RemoveResult = { ok: true } | { ok: false; error: string };

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export class WorktreeManager {
  private baseDir: string;
  private worktrees = new Map<string, WorktreeInfo>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? '.worktrees';
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  static validateName(name: string): boolean {
    return NAME_RE.test(name) && name !== '.' && name !== '..';
  }

  async create(name: string, _taskId?: string): Promise<CreateResult> {
    if (!WorktreeManager.validateName(name)) {
      return { ok: false, error: `Invalid worktree name: ${name}` };
    }

    const path = resolve(join(this.baseDir, name));
    if (existsSync(path)) {
      return { ok: false, error: `Worktree already exists: ${name}` };
    }

    try {
      execSync(`git worktree add "${path}" -b "wt/${name}" HEAD`, {
        stdio: 'pipe',
        timeout: 30000,
      });

      const info: WorktreeInfo = {
        name,
        path,
        branch: `wt/${name}`,
        createdAt: Date.now(),
      };
      this.worktrees.set(name, info);

      return { ok: true, path };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async remove(name: string, opts?: { force?: boolean }): Promise<RemoveResult> {
    const path = resolve(join(this.baseDir, name));
    if (!existsSync(path)) {
      return { ok: false, error: `Worktree not found: ${name}` };
    }

    try {
      const forceFlag = opts?.force ? '--force' : '';
      execSync(`git worktree remove "${path}" ${forceFlag}`.trim(), {
        stdio: 'pipe',
        timeout: 30000,
      });

      // 删除分支
      try {
        execSync(`git branch -D "wt/${name}"`, { stdio: 'pipe', timeout: 10000 });
      } catch {
        // 分支可能不存在
      }

      this.worktrees.delete(name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  keep(name: string): void {
    // 标记为"保留"，不自动清理
    // 当前为 no-op，将来可加入 keep list
  }

  getPath(name: string): string | null {
    return this.worktrees.get(name)?.path ?? null;
  }

  list(): WorktreeInfo[] {
    return Array.from(this.worktrees.values());
  }
}
