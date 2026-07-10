import fs from 'fs';
import path from 'path';
import { workspacePath } from '@orion/shared';
import { batchProcess } from '@orion/memory';

export interface SchedulerTask {
  enabled?: boolean;
  repeat?: 'once' | 'daily' | 'weekday' | 'weekly' | 'monthly' | string;
  schedule?: string;
  max_delay_hours?: number;
  prompt?: string;
}

const DEFAULT_MAX_DELAY = 6;
let lastL4Time = 0;

function parseCooldown(repeat: string): number {
  const msPerHour = 60 * 60 * 1000;
  const msPerDay = 24 * msPerHour;
  if (repeat === 'once') return Number.MAX_SAFE_INTEGER;
  if (repeat === 'daily' || repeat === 'weekday') return 20 * msPerHour;
  if (repeat === 'weekly') return 6 * msPerDay;
  if (repeat === 'monthly') return 27 * msPerDay;
  if (repeat.startsWith('every_')) {
    try {
      const token = repeat.split('_')[1];
      const n = parseInt(token.slice(0, -1), 10);
      const unit = token.slice(-1);
      if (unit === 'h') return n * msPerHour;
      if (unit === 'm') return n * 60 * 1000;
      if (unit === 'd') return n * msPerDay;
    } catch {
      // fall through
    }
  }
  return 20 * msPerHour;
}

function lastRun(tid: string, doneFiles: string[]): Date | null {
  let latest: Date | null = null;
  for (const df of doneFiles) {
    if (!df.endsWith(`_${tid}.md`)) continue;
    try {
      const t = new Date(
        `${df.slice(0, 10).replace(/_/g, '-')}T${df.slice(11, 13)}:${df.slice(13, 15)}:00`
      );
      if (!isNaN(t.getTime()) && (latest === null || t > latest)) latest = t;
    } catch {
      continue;
    }
  }
  return latest;
}

export function check(projectRoot: string): string | null {
  // L4 archive cron (silent, every 12h)
  if (Date.now() - lastL4Time > 12 * 60 * 60 * 1000) {
    lastL4Time = Date.now();
    try {
      const rawDir = workspacePath('.orion', 'temp', 'model_responses');
      const r = batchProcess(rawDir, null, false);
      console.log(`[L4 cron] ${JSON.stringify(r)}`);
    } catch (e) {
      console.error('[L4 cron] failed:', e instanceof Error ? e.message : String(e));
    }
  }

  const tasksDir = workspacePath('.orion', 'sche_tasks');
  if (!fs.existsSync(tasksDir)) return null;

  const doneDir = path.join(tasksDir, 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  const doneFiles = fs.readdirSync(doneDir);

  const now = new Date();
  for (const f of fs.readdirSync(tasksDir).sort()) {
    if (!f.endsWith('.json')) continue;
    const tid = f.slice(0, -5);
    let task: SchedulerTask;
    try {
      task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8')) as SchedulerTask;
    } catch (e) {
      console.warn(`[Scheduler] skip malformed task file ${f}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (task.enabled === false) continue;

    const repeat = task.repeat || 'daily';
    const sched = task.schedule || '00:00';
    const parts = sched.split(':');
    const h = parseInt(parts[0] || '0', 10);
    const m = parseInt(parts[1] || '0', 10);
    if (isNaN(h) || isNaN(m)) continue;

    if (repeat === 'weekday' && (now.getDay() === 0 || now.getDay() >= 6)) continue;
    if (now.getHours() < h || (now.getHours() === h && now.getMinutes() < m)) continue;

    const maxDelay = task.max_delay_hours ?? DEFAULT_MAX_DELAY;
    const schedMinutes = h * 60 + m;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes - schedMinutes > maxDelay * 60) continue;

    const last = lastRun(tid, doneFiles);
    const cooldown = parseCooldown(repeat);
    if (last && now.getTime() - last.getTime() < cooldown) continue;

    const ts = `${now.toISOString().slice(0, 10).replace(/-/g, '_')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const rpt = path.join(doneDir, `${ts}_${tid}.md`);
    const prompt = task.prompt || '';
    return `[定时任务] ${tid}\n[报告路径] ${rpt}\n\n先读 scheduled_task_sop 了解执行流程，然后执行以下任务：\n\n${prompt}\n\n完成后将执行报告写入 ${rpt}。`;
  }
  return null;
}

export const INTERVAL = 120;
export const ONCE = false;
