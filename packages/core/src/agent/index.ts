import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { findProjectRoot, sleep } from '../shared/index.js';
import { loadSessionsFromEnv } from '../llm/index.js';
import type { AgentYield as EngineAgentYield, Message } from '../types/index.js';
import type { AgentYield } from '@orion/engine';
import * as localCostTracker from './cost-tracker.js';

// =========================================================================
// Backward-compat re-exports from @orion/engine
// =========================================================================
export { OrionAgent, OrionAgentOptions, ToolRegistry } from '@orion/engine';
export { OrionAgentHandler, HandlerParent, ToolDeniedError } from '@orion/engine';
export { agentRunnerLoop, BaseHandler, StepOutcome, agentLoopHooks } from '@orion/engine';
export type { AgentState, AgentLike } from '@orion/engine';

// Re-export shared types from core's types (not engine, to avoid type conflicts)
export type { Message, AgentYield, TaskQueueLike } from '../types/index.js';

// Deprecated aliases
/** @deprecated Use OrionAgent instead */
export { OrionAgent as GenericAgent } from '@orion/engine';
/** @deprecated Use OrionAgentHandler instead */
export { OrionAgentHandler as GenericAgentHandler } from '@orion/engine';

export { costTracker } from '@orion/engine';
export * as ultraplan from './ultraplan.js';

// =========================================================================
// Local type exports
// =========================================================================
export type ToolApprovalDecision = 'allow' | 'deny';
export type ToolApprovalFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<ToolApprovalDecision>;

// =========================================================================
// CLI helpers (kept for main() entry point)
// =========================================================================

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

function getGlobalMemory(cwd: string): string {
  let prompt = '\n';
  try {
    const suffix = GA_LANG === 'en' ? '_en' : '';
    const insight = fs.readFileSync(path.join(projectRoot, 'memory', 'global_mem_insight.txt'), 'utf-8');
    const structure = fs.readFileSync(path.join(projectRoot, `assets/insight_fixed_structure${suffix}.txt`), 'utf-8');
    const globalMem = fs.readFileSync(path.join(projectRoot, 'memory', 'global_mem.txt'), 'utf-8');
    const userName = readUserName();
    prompt += `cwd = ${cwd} (./)\n`;
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

function getSystemPrompt(cwd: string): string {
  const suffix = GA_LANG === 'en' ? '_en' : '';
  const p = path.join(projectRoot, 'assets', `sys_prompt${suffix}.txt`);
  let prompt = fs.readFileSync(p, 'utf-8');
  const now = new Date();
  const weekdays = GA_LANG === 'en'
    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  prompt += `\nToday: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekdays[now.getDay()]}\n`;
  prompt += getGlobalMemory(cwd);
  return prompt;
}

function findConfigPath(): { path: string } | null {
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) return { path: envPath };
  return null;
}

function loadSessionsFresh(keepHistory?: Message[]): import('../types/index.js').BaseSession[] {
  const cfg = findConfigPath();
  if (!cfg) throw new Error('No .env found. Please copy .env.example to .env and configure your LLM.');
  const sessions = loadSessionsFromEnv(cfg.path);
  if (keepHistory && sessions.length) {
    sessions[0].history = keepHistory;
  }
  return sessions;
}

// =========================================================================
// renderAgentYieldToText — kept for CLI rendering
// =========================================================================

export function renderAgentYieldToText(y: AgentYield): string {
  const showThinking = process.env.ORION_CLI_THINKING === 'true';
  const showToolResults = process.env.ORION_CLI_TOOL_RESULTS === 'true';
  switch (y.kind) {
    case 'text':
      return y.content;
    case 'thinking':
      return showThinking ? `\n[Thought] ${y.content}\n` : '';
    case 'tool_call':
      return `\n🛠️  ${y.toolName}\n`;
    case 'tool_result':
      if (y.status === 'error') return '[error]\n';
      if (showToolResults) {
        const summary = typeof y.content === 'string' ? y.content : JSON.stringify(y.content);
        return `\n[Result] ${summary.slice(0, 200)}\n`;
      }
      return '';
    case 'error':
      return `\n!!!Error: ${y.message}\n`;
    case 'state':
    case 'trace':
      return '';
    default:
      return '';
  }
}

// =========================================================================
// main() — CLI entry point
// =========================================================================

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
  // Dynamic import to avoid circular dependency at module load time
  const { OrionAgent } = await import('@orion/engine');

  ensureMemoryFiles();
  localCostTracker.install();
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

  const agent = new OrionAgent();
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
        if (item.next) process.stdout.write(renderAgentYieldToText(item.next));
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
