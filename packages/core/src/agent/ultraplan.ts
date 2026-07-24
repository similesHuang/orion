import fs from 'fs';
import path from 'path';
import http from 'http';
import { OrionAgent } from '@orion/engine';

export interface PhaseInfo {
  name: string;
  desc: string;
  status: 'run' | 'done' | 'fail';
  children: PhaseInfo[];
  tasks: TaskInfo[];
  ops: string[];
}

export interface TaskInfo {
  desc: string;
  status: 'run' | 'done' | 'fail';
}

interface UltraPlanSession {
  rundir: string;
  phases: PhaseInfo[];
  phaseStack: PhaseInfo[];
  tasks: TaskInfo[];
  current: string;
  events: string[];
  funcSeq: number;
  taskSlug: string;
}

interface DaemonSession {
  rundir: string;
  current: string;
  phases: PhaseInfo[];
  tasks: TaskInfo[];
  events: string[];
}

const sessions = new Map<string, UltraPlanSession>();
let planned = false;
let currentSession: string | null = null;

const PORT = parseInt(process.env.GA_ULTRAPLAN_PORT || '47831', 10);

function slug(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'task';
}

function taskSlug(filePath?: string): string {
  if (!filePath) return 'task';
  const stem = path.basename(filePath, path.extname(filePath));
  const parts = stem.split(/[_\-]+/).map(slug);
  const stop = new Set(['ultra', 'ultraplan', 'script', 'boot', 'build', 'test', 'debug', 'verify', 'explore', 'reduce', 'phase']);
  const filtered = parts.filter((p) => p && !/^\d+$/.test(p) && !stop.has(p));
  return filtered.join('_') || slug(stem);
}

function note(session: UltraPlanSession, s: string): void {
  const t = Date.now();
  session.events.push(`${(t / 1000).toFixed(1)}s  ${s}`);
  if (session.events.length > 60) session.events.shift();
  reportState(session);
}

function getSession(): UltraPlanSession {
  if (!currentSession) throw new Error('call plan(rundir) first');
  return sessions.get(currentSession)!;
}

function pingDaemon(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/`, { timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function reportState(session: UltraPlanSession): void {
  if (process.env.GA_ULTRAPLAN_DAEMON !== '1' && !process.env.GA_ULTRAPLAN_PORT) return;
  const payload: DaemonSession = {
    rundir: session.rundir,
    current: session.current,
    phases: session.phases,
    tasks: session.tasks,
    events: session.events,
  };
  const data = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/state',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 1000,
    },
    (res) => res.resume()
  );
  req.on('error', () => {});
  req.write(data);
  req.end();
}

function execViaDaemon(scriptPath: string, rundir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const code = fs.readFileSync(scriptPath, 'utf-8');
    const data = JSON.stringify({
      path: scriptPath,
      cwd: process.cwd(),
      rundir,
      task: taskSlug(scriptPath),
      code,
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/exec',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 86400 * 1000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            const result = JSON.parse(raw) as { returncode: number; stdout: string; stderr: string };
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.returncode === 0) resolve();
            else reject(new Error(`ultraplan exec returned ${result.returncode}`));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function plan(rundir: string): UltraPlanSession {
  if (planned) {
    const key = path.resolve(rundir);
    const existing = sessions.get(key);
    if (existing) {
      currentSession = key;
      return existing;
    }
  }
  planned = true;
  const key = path.resolve(rundir);
  fs.mkdirSync(key, { recursive: true });
  const session: UltraPlanSession = sessions.get(key) || {
    rundir: key,
    phases: [],
    phaseStack: [],
    tasks: [],
    current: 'idle',
    events: [],
    funcSeq: 0,
    taskSlug: 'task',
  };
  sessions.set(key, session);
  currentSession = key;

  if (process.env.GA_ULTRAPLAN_DAEMON === '1') {
    reportState(session);
    return session;
  }

  // If a daemon is reachable and this is the top-level script, delegate execution.
  const scriptPath = process.argv[1];
  if (scriptPath) {
    void pingDaemon().then((alive) => {
      if (alive) {
        console.log(`[ultraplan] delegating to daemon http://127.0.0.1:${PORT}/`);
        execViaDaemon(scriptPath, key)
          .then(() => process.exit(0))
          .catch((e) => {
            console.error(e instanceof Error ? e.message : String(e));
            process.exit(1);
          });
      }
    });
  }
  return session;
}

export async function phase<T>(name: string, fn: () => T | Promise<T>, desc = ''): Promise<T> {
  if (!planned) throw new Error('call plan(rundir) first');
  const session = getSession();
  const phaseInfo: PhaseInfo = {
    name,
    desc,
    status: 'run',
    children: [],
    tasks: [],
    ops: [],
  };
  const parent = session.phaseStack[session.phaseStack.length - 1];
  (parent ? parent.children : session.phases).push(phaseInfo);
  session.phaseStack.push(phaseInfo);
  session.current = `phase: ${name}`;
  console.log(`[phase] ${name}${desc ? ` - ${desc}` : ''}`);
  note(session, `phase start: ${name}`);
  const start = Date.now();
  let failed = false;
  try {
    return await fn();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const dt = (Date.now() - start) / 1000;
    phaseInfo.status = failed ? 'fail' : 'done';
    session.phaseStack.pop();
    session.current = session.phaseStack.length
      ? `phase: ${session.phaseStack[session.phaseStack.length - 1].name}`
      : `${failed ? 'failed' : 'all phases done'}; last: ${name} (${dt.toFixed(1)}s)`;
    console.log(`[${phaseInfo.status}] ${name} (${dt.toFixed(1)}s)`);
    note(session, `phase ${phaseInfo.status}: ${name} (${dt.toFixed(1)}s)`);
  }
}

function addTask(session: UltraPlanSession, desc: string, status: TaskInfo['status'] = 'run'): TaskInfo {
  const t: TaskInfo = { desc, status };
  session.tasks.push(t);
  if (session.tasks.length > 80) session.tasks.shift();
  const parent = session.phaseStack[session.phaseStack.length - 1];
  if (parent) parent.tasks.push(t);
  reportState(session);
  return t;
}

function setTaskStatus(t: TaskInfo, status: TaskInfo['status'], session: UltraPlanSession): void {
  t.status = status;
  reportState(session);
}

async function runSubagent(desc: string, prompt: string, options: SubagentOptions = {}): Promise<string> {
  const session = getSession();
  session.funcSeq += 1;
  const slugName = slug(desc);
  const filePath = path.join(session.rundir, `${session.funcSeq.toString().padStart(3, '0')}_${session.taskSlug}_${slugName}.txt`);
  fs.writeFileSync(filePath, prompt, 'utf-8');
  console.log(`[subagent] ${desc} -> ${filePath}`);
  note(session, `agent: ${desc}`);
  const agent = new OrionAgent();
  agent.verbose = false;
  agent.peerHint = false;
  agent.bannedTools = ['ask_user', 'start_long_term_update'];
  agent.nextLlm(options.llmNo ?? 0);
  const result = await agent.runOnce(prompt);
  const outPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.out.txt`);
  fs.writeFileSync(outPath, result, 'utf-8');
  return outPath;
}

export interface SubagentOptions {
  llmNo?: number;
  timeout?: number;
}

export type TaskLike =
  | string
  | [string, string]
  | { desc: string; prompt?: string; llmNo?: number; timeout?: number; data?: Record<string, unknown> }
  | ((item?: unknown) => TaskLike | Promise<TaskLike>);

async function runTask(task: TaskLike, data: Record<string, unknown>): Promise<unknown> {
  while (typeof task === 'function') {
    task = await task(data.item);
  }
  const session = getSession();
  if (Array.isArray(task)) {
    const desc = task[0].replace(/\{([^}]+)\}/g, (_, k) => String(data[k] ?? ''));
    const prompt = (task[1] ?? task[0]).replace(/\{([^}]+)\}/g, (_, k) => String(data[k] ?? ''));
    const t = addTask(session, desc);
    try {
      const out = await runSubagent(desc, prompt, { llmNo: Number(data.llmNo ?? 0), timeout: Number(data.timeout ?? 3600) });
      setTaskStatus(t, 'done', session);
      return out;
    } catch (e) {
      setTaskStatus(t, 'fail', session);
      throw e;
    }
  }
  if (typeof task === 'object' && task !== null) {
    const d = { ...data, ...(task.data || {}) };
    const desc = (task.desc ?? 'task').replace(/\{([^}]+)\}/g, (_, k) => String(d[k] ?? ''));
    const prompt = (task.prompt ?? task.desc ?? 'task').replace(/\{([^}]+)\}/g, (_, k) => String(d[k] ?? ''));
    const t = addTask(session, desc);
    try {
      const out = await runSubagent(desc, prompt, { llmNo: Number(task.llmNo ?? d.llmNo ?? 0), timeout: Number(task.timeout ?? d.timeout ?? 3600) });
      setTaskStatus(t, 'done', session);
      return out;
    } catch (e) {
      setTaskStatus(t, 'fail', session);
      throw e;
    }
  }
  return task;
}

export async function parallel(tasks: TaskLike[], maxWorkers = 3, data: Record<string, unknown> = {}): Promise<unknown[]> {
  if (!planned) throw new Error('call plan(rundir) first');
  const session = getSession();
  const label = `parallel: ${tasks.length} tasks`;
  session.current = label;
  console.log(`[parallel] ${label}`);
  note(session, label);
  const limit = Math.max(1, Math.min(maxWorkers || 3, tasks.length || 1));
  const results: unknown[] = [];
  const queue = tasks.map((t, i) => ({ task: t, index: i }));
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const { task, index } = queue.shift()!;
      results[index] = await runTask(task, data);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function mapchain(
  items: unknown[],
  steps: TaskLike[],
  maxWorkers = 3,
  data: Record<string, unknown> = {}
): Promise<unknown[]> {
  if (!planned) throw new Error('call plan(rundir) first');
  const session = getSession();
  const label = `mapchain: ${items.length} items x ${steps.length} steps`;
  session.current = label;
  console.log(`[mapchain] ${label}`);
  note(session, label);
  return parallel(
    items.map((item): TaskLike => async () => {
      let x: unknown = item;
      for (const step of steps) {
        const d = { ...data, item: x, previous: x };
        x = await runTask(typeof step === 'function' ? await step(x) : step, d);
      }
      return x as TaskLike;
    }),
    maxWorkers,
    data
  );
}

export function getState(): Readonly<UltraPlanSession> {
  return Object.freeze({ ...getSession() });
}
