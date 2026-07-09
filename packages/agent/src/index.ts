import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { findProjectRoot } from '@orion/shared';
import { agentRunnerLoop } from './agent-loop.js';
import {
  createClient,
  loadSessions,
  loadSessionsFromEnv,
  NativeToolClient,
  ToolClient,
} from '@orion/llm';
import { BaseSession, Message, TaskQueueLike } from '@orion/types';
import * as costTracker from './cost-tracker.js';
import { GenericAgentHandler, HandlerParent } from './handler-base.js';

export type { BaseSession, Message, TaskQueueLike, GenericAgentLike } from '@orion/types';
export { GenericAgentHandler, HandlerParent } from './handler-base.js';
export { agentRunnerLoop, BaseHandler, StepOutcome, agentLoopHooks } from './agent-loop.js';
export * as ultraplan from './ultraplan.js';
export * as costTracker from './cost-tracker.js';


const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);

const projectRoot = findProjectRoot(scriptDir);

const GA_LANG = process.env.GA_LANG || (isZhLocale() ? 'zh' : 'en');
process.env.GA_LANG = GA_LANG;

function isZhLocale(): boolean {
  const loc = (process.env.LANG || process.env.LC_ALL || '').toLowerCase();
  return loc.includes('zh') || loc.includes('chinese');
}

function loadToolSchema(suffix = '', bannedTools: string[] = []): Record<string, unknown>[] {
  const p = path.join(projectRoot, 'assets', `tools_schema${suffix}.json`);
  let text = fs.readFileSync(p, 'utf-8');
  if (process.platform !== 'win32') text = text.replace(/powershell/g, 'bash');
  const schema = JSON.parse(text) as Record<string, unknown>[];
  if (!bannedTools.length) return schema;
  return schema.filter((t) => {
    const fn = (t.function as Record<string, unknown>) || {};
    return !bannedTools.includes(String(fn.name));
  });
}

function ensureMemoryFiles(): void {
  const memDir = path.join(projectRoot, 'memory');
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
  const globalMem = path.join(memDir, 'global_mem.txt');
  if (!fs.existsSync(globalMem)) {
    fs.writeFileSync(globalMem, '# [Global Memory - L2]\n', 'utf-8');
  }
  const insight = path.join(memDir, 'global_mem_insight.txt');
  if (!fs.existsSync(insight)) {
    const suffix = GA_LANG === 'en' ? '_en' : '';
    const tpl = path.join(projectRoot, 'assets', `global_mem_insight_template${suffix}.txt`);
    if (fs.existsSync(tpl)) {
      fs.writeFileSync(insight, fs.readFileSync(tpl, 'utf-8'), 'utf-8');
    } else {
      fs.writeFileSync(insight, '', 'utf-8');
    }
  }
}

function getGlobalMemory(): string {
  let prompt = '\n';
  try {
    const suffix = GA_LANG === 'en' ? '_en' : '';
    const insight = fs.readFileSync(path.join(projectRoot, 'memory', 'global_mem_insight.txt'), 'utf-8');
    const structure = fs.readFileSync(path.join(projectRoot, `assets/insight_fixed_structure${suffix}.txt`), 'utf-8');
    const globalMem = fs.readFileSync(path.join(projectRoot, 'memory', 'global_mem.txt'), 'utf-8');
    const userName = readUserName();
    prompt += `cwd = ${path.join(projectRoot, 'temp')} (./)\n`;
    prompt += '\n[Memory] (../memory)\n';
    if (userName) prompt += `[Current User] 用户姓名：${userName}\n\n`;
    prompt += structure + '\n../memory/global_mem_insight.txt:\n';
    prompt += insight + '\n';
    prompt += '../memory/global_mem.txt (L2 facts):\n';
    prompt += globalMem + '\n';
  } catch {
    // ignore missing memory files
  }
  return prompt;
}

function readUserName(): string | undefined {
  try {
    const text = fs.readFileSync(path.join(projectRoot, 'memory', 'global_mem.txt'), 'utf-8');
    return text.match(/用户姓名[：:]\s*(.+)/)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function getSystemPrompt(): string {
  const suffix = GA_LANG === 'en' ? '_en' : '';
  const p = path.join(projectRoot, 'assets', `sys_prompt${suffix}.txt`);
  let prompt = fs.readFileSync(p, 'utf-8');
  const now = new Date();
  const weekdays = GA_LANG === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  prompt += `\nToday: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekdays[now.getDay()]}\n`;
  prompt += getGlobalMemory();
  return prompt;
}

function findConfigPath(): { kind: 'env'; path: string } | { kind: 'json'; path: string } | null {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) return { kind: 'env', path: envPath };
  const jsonCandidates = [
    path.join(projectRoot, 'mykey.json'),
    path.join(projectRoot, 'mykey.template.json'),
  ];
  for (const p of jsonCandidates) {
    if (fs.existsSync(p)) return { kind: 'json', path: p };
  }
  return null;
}

function loadSessionsFresh(keepHistory?: Message[]): BaseSession[] {
  const cfg = findConfigPath();
  if (!cfg) throw new Error('No .env, mykey.json or mykey.template.json found.');
  const sessions = cfg.kind === 'env'
    ? loadSessionsFromEnv(cfg.path)
    : loadSessions(cfg.path);
  if (keepHistory && sessions.length) {
    sessions[0].history = keepHistory;
  }
  return sessions;
}

type TaskItem = {
  query: string;
  source: string;
  output: { next?: string; done?: string; source: string }[];
};

export class GenericAgent {
  sessions: BaseSession[] = [];
  client: ToolClient | NativeToolClient;
  llmNo = 0;
  verbose = true;
  peerHint = true;
  isRunning = false;
  stopSig = false;
  handler?: GenericAgentHandler;
  taskDir?: string;
  history: string[] = [];
  taskQueue: TaskItem[] = [];
  processing = false;
  bannedTools: string[] = [];

  constructor() {
    this.sessions = loadSessionsFresh();
    this.client = createClient(this.sessions, this.llmNo);
    if (!fs.existsSync(path.join(projectRoot, 'temp'))) {
      fs.mkdirSync(path.join(projectRoot, 'temp'), { recursive: true });
    }
  }

  get llmName(): string {
    const b = this.client.backend;
    return `${b.constructor.name}/${b.name}`;
  }

  nextLlm(n = -1): void {
    this.sessions = loadSessionsFresh(this.client.backend.history);
    this.llmNo = (n < 0 ? this.llmNo + 1 : n) % this.sessions.length;
    this.client = createClient(this.sessions, this.llmNo);
    const name = this.client.backend.model.toLowerCase();
    try {
      loadToolSchema(name.includes('glm') || name.includes('minimax') || name.includes('kimi') ? '_cn' : '');
    } catch {
      // ignore schema reload errors
    }
    console.log(`[LLM] switched to ${this.llmName}`);
  }

  listLlms(): string {
    this.sessions = loadSessionsFresh(this.client.backend.history);
    return this.sessions
      .map((s, i) => `${i}: ${s.constructor.name}/${s.name}${i === this.llmNo ? ' *' : ''}`)
      .join('\n');
  }

  abort(): void {
    if (!this.isRunning) return;
    console.log('Abort current task...');
    this.stopSig = true;
    if (this.handler) this.handler.codeStopSignal.push(1);
  }

  handleSlashCmd(raw: string): string | null {
    if (!raw.startsWith('/')) return raw;
    const m = raw.trim().match(/^\/session\.(\w+)=(.*)$/);
    if (m) {
      const [, k, v] = m;
      let val: unknown = v;
      const vfile = path.join(projectRoot, 'temp', v);
      if (fs.existsSync(vfile)) val = fs.readFileSync(vfile, 'utf-8').trim();
      try {
        val = JSON.parse(val as string);
      } catch {
        // keep as string
      }
      (this.client.backend as unknown as Record<string, unknown>)[k] = val;
      console.log(`✅ session.${k} = ${JSON.stringify(val).slice(0, 500)}`);
      return null;
    }
    if (raw.trim() === '/next') {
      this.nextLlm();
      return null;
    }
    if (raw.trim() === '/llms') {
      console.log(this.listLlms());
      return null;
    }
    if (raw.trim() === '/resume') {
      return '帮我看看最近有哪些会话可以恢复。读model_responses/目录，按修改时间取最近10个文件，从每个文件里找最后一个<history>...</history>块，用一句话总结每个会话在聊什么，列表给我选。注意读文件后要把字面的\\n替换成真换行才能正确匹配。';
    }
    if (raw.trim() === '/cost') {
      console.log(costTracker.formatCostReport('main', { includeSubagents: true }));
      return null;
    }
    if (raw.trim() === '/help') {
      console.log(`Commands:
  /session.key=value   update backend session config
  /next                switch to next LLM session
  /llms                list available sessions
  /resume              list recent sessions to resume
  /cost                show token cost report
  /help                show this help`);
      return null;
    }
    return raw;
  }

  putTask(query: string, source = 'user'): TaskQueueLike {
    const item: TaskItem = { query, source, output: [] };
    const pending: Array<(value: { done?: string; next?: string } | null) => void> = [];
    const resolveOne = () => {
      while (pending.length && item.output.length) {
        const resolve = pending.shift()!;
        resolve(item.output.shift() || null);
      }
    };
    const origPush = item.output.push.bind(item.output);
    item.output.push = (...args) => {
      const r = origPush(...args);
      resolveOne();
      return r;
    };
    this.taskQueue.push(item);
    if (!this.processing) void this.processQueue();
    return {
      get: async (_block?: boolean, timeout?: number) => {
        if (item.output.length) return item.output.shift() || null;
        return new Promise<{ done?: string; next?: string } | null>((resolve) => {
          pending.push(resolve);
          if (timeout !== undefined) {
            setTimeout(() => {
              const idx = pending.indexOf(resolve);
              if (idx >= 0) {
                pending.splice(idx, 1);
                resolve(null);
              }
            }, timeout * 1000);
          }
        });
      },
    };
  }

  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.taskQueue.length) {
        const task = this.taskQueue.shift()!;
        try {
          await this.runTask(task);
        } catch (e) {
          const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          console.error(`[TaskQueue] runTask failed: ${err}`);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async runTask(task: TaskItem): Promise<void> {
    const raw = this.handleSlashCmd(task.query);
    if (raw === null) return;
    this.isRunning = true;
    this.stopSig = false;
    const rquery = raw.replace(/\n/g, ' ').slice(0, 200);
    this.history.push(`[USER]: ${rquery}`);

    let sysPrompt = getSystemPrompt();
    const extra = (this.client.backend as unknown as Record<string, unknown>).extra_sys_prompt;
    if (typeof extra === 'string') sysPrompt += extra;
    if (this.peerHint) sysPrompt += '\n[Peer] 用户提及其他会话/后台任务状态时: temp/model_responses/ (只找近期修改的文件尾部)\n';

    const userName = readUserName();
    const userContent = userName ? `[User Profile]\n- 姓名：${userName}\n\n用户当前消息：${raw}` : raw;

    const parent: HandlerParent = {
      taskDir: this.taskDir,
      verbose: this.verbose,
    };
    const handler = new GenericAgentHandler(parent, this.history, path.join(projectRoot, 'temp'));
    if (this.handler?.working.key_info) {
      const ki = String(this.handler.working.key_info).replace(/\n\[SYSTEM\] 此为.*?工作记忆[。\n]*/g, '');
      const ps = (Number(this.handler.working.passed_sessions) || 0) + 1;
      handler.working.passed_sessions = ps;
      handler.working.key_info = ki + `\n[SYSTEM] 此为 ${ps} 个对话前设置的key_info，若已在新任务，先更新或清除工作记忆。\n`;
    }
    this.handler = handler;

    const toolsSchema = loadToolSchema('', this.bannedTools);
    const gen = agentRunnerLoop(
      this.client,
      sysPrompt,
      raw,
      handler,
      toolsSchema,
      70,
      this.verbose,
      userContent
    );

    let fullResp = '';
    try {
      for await (const chunk of gen) {
        if (this.stopSig) break;
        fullResp += chunk;
        task.output.push({ next: chunk, source: task.source });
      }
      if (fullResp.includes('</summary>')) fullResp = fullResp.replace(/<\/summary>/g, '</summary>\n\n');
      task.output.push({ done: fullResp, source: task.source });
      this.history = handler.historyInfo;
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`Backend Error: ${err}`);
      task.output.push({ done: fullResp + `\n\`\`\`\n${err}\n\`\`\``, source: task.source });
    } finally {
      this.isRunning = false;
      this.stopSig = false;
      if (this.handler) this.handler.codeStopSignal.push(1);
    }
  }

  async runOnce(input: string): Promise<string> {
    const dq = this.putTask(input, 'cli');
    return new Promise((resolve) => {
      const check = async () => {
        const item = await dq.get(true, 0.1);
        if (item?.done) {
          resolve(item.done || '');
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }
}

async function readTaskInput(taskDir: string): Promise<string> {
  const infile = path.join(taskDir, 'input.txt');
  if (!fs.existsSync(infile)) {
    throw new Error(`Task input not found: ${infile}`);
  }
  return fs.readFileSync(infile, 'utf-8');
}

function consumeFile(dir: string, name: string): string | null {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, 'utf-8');
    fs.unlinkSync(p);
    return content;
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  ensureMemoryFiles();
  costTracker.install();
  const args = process.argv.slice(2);
  const flags = {
    task: getFlag(args, '--task'),
    func: getFlag(args, '--func'),
    input: getFlag(args, '--input'),
    reflect: getFlag(args, '--reflect'),
    bg: args.includes('--bg'),
    nobg: args.includes('--nobg'),
    nolog: args.includes('--nolog'),
    noUserTools: args.includes('--no-user-tools'),
    llmNo: parseInt(getFlag(args, '--llm_no') || '0', 10) || 0,
    verbose: args.includes('--verbose'),
  };

  if (flags.bg) {
    const taskName = flags.task || 'reflect_bg';
    const logDir = path.join(projectRoot, 'temp', taskName);
    fs.mkdirSync(logDir, { recursive: true });
    const childArgs = args.filter((a) => a !== '--bg');
    const child = spawn(
      process.execPath,
      [path.resolve(projectRoot, 'dist', 'agent.js'), ...childArgs],
      {
        detached: true,
        stdio: [
          'ignore',
          fs.openSync(path.join(logDir, 'stdout.log'), 'w'),
          fs.openSync(path.join(logDir, 'stderr.log'), 'w'),
        ],
        cwd: projectRoot,
      }
    );
    child.unref();
    console.log(child.pid);
    process.exit(0);
  }

  const agent = new GenericAgent();
  agent.verbose = flags.verbose;
  agent.nextLlm(flags.llmNo);
  if (flags.noUserTools) {
    agent.bannedTools = ['ask_user', 'start_long_term_update'];
  }

  if (flags.func) {
    agent.peerHint = false;
    const funcPath = path.resolve(flags.func);
    if (!fs.existsSync(funcPath)) {
      console.error(`Func file not found: ${funcPath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(funcPath, 'utf-8');
    const result = await agent.runOnce(raw);
    const outPath = path.join(path.dirname(funcPath), `${path.basename(funcPath, path.extname(funcPath))}.out.txt`);
    fs.writeFileSync(outPath, result, 'utf-8');
    if (!flags.nolog) {
      console.log(result);
    }
    process.exit(0);
  }

  if (flags.input && !flags.task) {
    const result = await agent.runOnce(flags.input);
    console.log(result);
    process.exit(0);
  }

  if (flags.reflect) {
    agent.peerHint = false;
    const reflectPath = path.resolve(flags.reflect);
    if (!fs.existsSync(reflectPath)) {
      console.error(`Reflect script not found: ${reflectPath}`);
      process.exit(1);
    }
    let mtime = fs.statSync(reflectPath).mtimeMs;
    let mod: Record<string, unknown> = await import(reflectPath);
    console.log(`[Reflect] loaded ${reflectPath}`);

    while (true) {
      try {
        const stat = fs.statSync(reflectPath);
        if (stat.mtimeMs !== mtime) {
          try {
            mod = await import(`${reflectPath}?t=${Date.now()}`);
            mtime = stat.mtimeMs;
            console.log('[Reflect] reloaded');
          } catch (e) {
            console.error(`[Reflect] reload error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const interval = (typeof mod.INTERVAL === 'number' ? mod.INTERVAL : 5) * 1000;
        await sleep(interval);
        const checkFn = mod.check as (projectRoot: string) => unknown | Promise<unknown>;
        const task = await Promise.resolve(checkFn(projectRoot));
        if (task == null) continue;
        console.log(`[Reflect] triggered: ${String(task).slice(0, 80)}`);
        const result = await agent.runOnce(String(task));
        console.log(result);
        const logDir = path.join(projectRoot, 'temp', 'reflect_logs');
        fs.mkdirSync(logDir, { recursive: true });
        const scriptName = path.basename(reflectPath, path.extname(reflectPath));
        const logPath = path.join(logDir, `${scriptName}_${new Date().toISOString().slice(0, 10)}.log`);
        fs.appendFileSync(logPath, `[${new Date().toLocaleString()}]\n${result}\n\n`, 'utf-8');
        if (typeof mod.on_done === 'function') {
          try {
            mod.on_done(result);
          } catch (e) {
            console.error(`[Reflect] on_done error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (mod.ONCE === true) {
          console.log('[Reflect] ONCE=true, exiting.');
          break;
        }
      } catch (e) {
        console.error(`[Reflect] error: ${e instanceof Error ? e.message : String(e)}`);
        if (mod.ONCE === true) break;
        await sleep(5000);
      }
    }
    process.exit(0);
  }

  if (flags.task) {
    agent.peerHint = false;
    const taskDir = path.join(projectRoot, 'temp', flags.task);
    if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });
    agent.taskDir = taskDir;
    const infile = path.join(taskDir, 'input.txt');
    if (flags.input) {
      fs.writeFileSync(infile, flags.input, 'utf-8');
    }
    let raw = await readTaskInput(taskDir);
    let nround: number | '' = '';
    while (true) {
      const result = await agent.runOnce(raw);
      fs.writeFileSync(path.join(taskDir, `output${nround}.txt`), result + '\n\n[ROUND END]\n', 'utf-8');
      console.log(result);
      consumeFile(taskDir, '_stop');
      let reply: string | null = null;
      for (let i = 0; i < 300; i++) {
        await sleep(2000);
        reply = consumeFile(taskDir, 'reply.txt');
        if (reply) break;
      }
      if (!reply) break;
      raw = reply;
      nround = typeof nround === 'number' ? nround + 1 : 1;
    }
    process.exit(0);
  }

  console.log(`Orion | ${agent.llmName} | lang=${GA_LANG}`);
  console.log('Type /help for commands, or enter a task.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });
  rl.prompt();

  rl.on('line', async (line) => {
    const q = line.trim();
    if (!q) {
      rl.prompt();
      return;
    }
    const dq = agent.putTask(q, 'user');
    const check = async () => {
      while (true) {
        const item = await dq.get(true, 0);
        if (!item) break;
        if (item.next) process.stdout.write(item.next);
        if (item.done) {
          process.stdout.write(item.done);
          console.log();
          rl.prompt();
          return;
        }
      }
      setTimeout(check, 100);
    };
    check();
  });

  rl.on('SIGINT', () => {
    agent.abort();
    rl.close();
  });

  rl.on('close', () => {
    console.log('\n[exit]');
    process.exit(0);
  });
}

function getFlag(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
