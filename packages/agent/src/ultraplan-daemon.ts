#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

export interface TaskInfo {
  desc: string;
  status: 'run' | 'done' | 'fail';
}

export interface PhaseInfo {
  name: string;
  desc: string;
  status: 'run' | 'done' | 'fail';
  on: boolean;
  children: PhaseInfo[];
  tasks: TaskInfo[];
  ops: string[];
}

export interface SessionState {
  rundir: string;
  current: string;
  phases: PhaseInfo[];
  tasks: TaskInfo[];
  events: string[];
}

const PORT = parseInt(process.env.GA_ULTRAPLAN_PORT || '47831', 10);
const IDLE_TIMEOUT_MS = 3600 * 1000;
const sessions = new Map<string, SessionState>();
let lastActivity = Date.now();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function phaseLines(nodes: PhaseInfo[], depth = 0): string[] {
  const out: string[] = [];
  for (const p of nodes) {
    const pre = '  '.repeat(depth);
    const mark = p.on ? '>>' : '  ';
    out.push(`${pre}${mark} ${p.status.padEnd(7)} ${p.name}${p.desc ? ` - ${p.desc}` : ''}`);
    for (const op of p.ops.slice(-8)) out.push(`${pre}   | ${op}`);
    for (const t of p.tasks.slice(-20)) out.push(`${pre}   - ${t.status.padEnd(5)} ${t.desc}`);
    out.push(...phaseLines(p.children, depth + 1));
  }
  return out;
}

function renderPage(): string {
  const lines = ['GA UltraPlan'];
  if (!sessions.size) {
    lines.push('', '(no sessions)');
  } else {
    for (const [key, s] of sessions) {
      lines.push('', `== ${path.basename(key) || key} ==`, `rundir: ${key}`, `current: ${s.current}`, '', 'phases:');
      lines.push(...(phaseLines(s.phases).length ? phaseLines(s.phases) : ['(none)']));
      lines.push('', 'recent tasks:');
      lines.push(...(s.tasks.slice(-12).map((t) => `${t.status.padEnd(7)} ${t.desc}`).length ? s.tasks.slice(-12).map((t) => `${t.status.padEnd(7)} ${t.desc}`) : ['(none)']));
      lines.push('', 'events:', ...s.events.slice(-30));
    }
  }
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>GA UltraPlan</title></head>
<body><pre>${escapeHtml(lines.join('\n'))}</pre></body>
</html>`;
}

function updateSession(rundir: string, patch: Partial<SessionState>): void {
  const key = path.resolve(rundir);
  const existing = sessions.get(key);
  if (existing) {
    if (patch.phases) existing.phases = patch.phases;
    if (patch.tasks) existing.tasks = patch.tasks;
    if (patch.current) existing.current = patch.current;
    if (patch.events) existing.events = patch.events;
  } else {
    sessions.set(key, {
      rundir: key,
      current: patch.current || 'idle',
      phases: patch.phases || [],
      tasks: patch.tasks || [],
      events: patch.events || [],
    });
  }
  lastActivity = Date.now();
}

function execScript(reqBody: { path?: string; cwd?: string; rundir?: string; code?: string; task?: string }): Promise<{ returncode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cwd = reqBody.cwd || process.cwd();
    const env: Record<string, string | undefined> = { ...process.env, GA_ULTRAPLAN_DAEMON: '1', GA_ULTRAPLAN_PORT: String(PORT) };
    if (reqBody.rundir) env.GA_ULTRAPLAN_RUNDIR = reqBody.rundir;
    if (reqBody.task) env.GA_ULTRAPLAN_TASK = reqBody.task;

    const code = reqBody.code || '';
    const isTs = (reqBody.path || '').endsWith('.ts') || code.includes('import ');
    const runner = isTs && process.env.PATH ? 'tsx' : process.execPath;
    const args: string[] = [];
    if (isTs && runner === 'tsx') {
      if (reqBody.path) args.push(reqBody.path);
      else {
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ultra-')), 'script.ts');
        fs.writeFileSync(tmp, code, 'utf-8');
        args.push(tmp);
      }
    } else {
      if (reqBody.path) args.push(reqBody.path);
      else {
        const tmp = path.join(os.tmpdir(), `ultra-${Date.now()}.mjs`);
        fs.writeFileSync(tmp, code, 'utf-8');
        args.push(tmp);
      }
    }

    const proc = spawn(runner, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout?.on('data', (c) => stdout.push(c));
    proc.stderr?.on('data', (c) => stderr.push(c));
    proc.on('close', (returncode) => {
      resolve({
        returncode: returncode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      });
    });
    proc.on('error', (e) => {
      resolve({ returncode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    });
  });
}

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  if (req.method === 'GET' && req.url === '/') {
    const body = renderPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && req.url === '/state') {
    const payload = Object.fromEntries(sessions);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (req.method === 'POST' && req.url === '/state') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as { rundir?: string } & Partial<SessionState>;
        if (body.rundir) updateSession(body.rundir, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/exec') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw) as { path?: string; cwd?: string; rundir?: string; code?: string; task?: string };
        const result = await execScript(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ returncode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

function pingDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 500 }, (res) => {
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

async function main(): Promise<void> {
  const isDaemon = process.argv.includes('--daemon');
  if (!isDaemon) {
    const alreadyRunning = await pingDaemon(PORT);
    if (alreadyRunning) {
      console.log(`[ultraplan] daemon already running on http://127.0.0.1:${PORT}/`);
      return;
    }
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[ultraplan] dashboard http://127.0.0.1:${PORT}/`);
  });

  const interval = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      console.log('[ultraplan] idle timeout, exiting');
      clearInterval(interval);
      server.close();
      process.exit(0);
    }
  }, 60000);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

export { pingDaemon, PORT };
