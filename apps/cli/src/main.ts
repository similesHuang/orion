#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { GenericAgent, costTracker } from '@orion/agent';
import {
  buildDoneText,
  formatRestore,
  handleBtwAsync,
  handleContinueFrontend,
  handleReviewFrontend,
  resetConversation,
} from '@orion/chat';
import { sleep } from '@orion/shared';
import type { AgentYield, GenericAgentLike } from '@orion/agent';

const projectRoot = process.cwd();

function getFlag(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function readTaskInput(taskDir: string): Promise<string> {
  const infile = path.join(taskDir, 'input.txt');
  if (!fs.existsSync(infile)) {
    throw new Error(`Task input not found: ${infile}`);
  }
  return fs.readFileSync(infile, 'utf-8');
}

function consumeFile(dir: string, name: string): string | undefined {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return undefined;
  try {
    const content = fs.readFileSync(p, 'utf-8');
    fs.unlinkSync(p);
    return content;
  } catch {
    return undefined;
  }
}

const FILE_HINT = 'If you need to show files to user, use [FILE:filepath] in your response.';

const CLI_HELP = `📖 CLI 命令
/help              显示帮助
/status            查看状态
/stop              停止当前任务
/new               开启新对话并清空上下文
/restore            恢复上次对话历史
/continue           列出可恢复会话
/continue [n]       恢复第 n 个会话
/btw <q>            临时插问，不打断主线
/review [scope]     审当前 git diff 或指定范围
/llm                查看模型列表
/llm [n]            切换到第 n 个模型
/cost               查看本次 token 消耗

其他输入直接交给 agent 执行。`;

function printLine(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function renderNonThoughtYield(y: AgentYield): string {
  switch (y.kind) {
    case 'text':
      return y.content;
    case 'tool_call':
      return `\n🛠️  ${y.toolName}\n`;
    case 'tool_result': {
      if (y.status === 'error') return '[error]\n';
      if (process.env.ORION_CLI_TOOL_RESULTS === 'true') {
        const summary = typeof y.content === 'string' ? y.content : JSON.stringify(y.content);
        return `\n[Result] ${summary.slice(0, 200)}\n`;
      }
      return '';
    }
    case 'error':
      return `\n!!!Error: ${y.message}\n`;
    default:
      return '';
  }
}

async function runCliAgent(agent: GenericAgentLike, text: string, signal: { stopped: boolean }): Promise<void> {
  const dq = agent.putTask(`${FILE_HINT}\n\n${text}`, 'cli');
  let thoughtBuf = '';
  let hasThought = false;
  const showThinking = process.env.ORION_CLI_THINKING === 'true';
  const flushThought = () => {
    if (!hasThought) return;
    const body = thoughtBuf.trim();
    if (body) printLine(`\n[思考] ${body}`);
    thoughtBuf = '';
    hasThought = false;
  };

  try {
    while (!signal.stopped) {
      const item = await dq.get(true, 3);
      if (!item) continue;
      if (item.next) {
        const y = item.next;
        if (y.kind === 'thought') {
          if (showThinking) {
            hasThought = true;
            thoughtBuf += y.content;
          }
        } else {
          flushThought();
          const out = renderNonThoughtYield(y);
          if (out) process.stdout.write(out);
        }
      }
      if (item.done) {
        flushThought();
        printLine(buildDoneText(item.done));
        break;
      }
    }
    if (signal.stopped) printLine('⏹️ 已停止');
  } catch (e) {
    printLine(`❌ 错误: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleCliCommand(
  agent: GenericAgentLike,
  cmd: string,
  signal: { stopped: boolean }
): Promise<void> {
  const parts = (cmd || '').split(/\s+/);
  const op = (parts[0] || '').toLowerCase();

  if (op === '/help') return printLine(CLI_HELP);
  if (op === '/status') {
    const llm = agent.client ? agent.llmName : '未配置';
    return printLine(`状态: ${agent.isRunning ? '🔴 运行中' : '🟢 空闲'}\nLLM: [${agent.llmNo}] ${llm}`);
  }
  if (op === '/stop') {
    signal.stopped = true;
    agent.abort();
    return printLine('⏹️ 正在停止...');
  }
  if (op === '/new') return printLine(resetConversation(agent));
  if (op === '/restore') {
    try {
      const result = formatRestore();
      if (result[0] === null) return printLine(result[1] || '❌ 恢复失败');
      const [restored, fname, count] = result as [string[], string, number];
      agent.abort();
      agent.history.push(...restored);
      return printLine(`✅ 已恢复 ${count} 轮对话\n来源: ${fname}\n(仅恢复上下文，请输入新问题继续)`);
    } catch (e) {
      return printLine(`❌ 恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (op === '/continue') return printLine(handleContinueFrontend(agent, cmd));
  if (op === '/btw') {
    const answer = await handleBtwAsync(agent, cmd);
    return printLine(answer);
  }
  if (op === '/review') {
    const prompt = handleReviewFrontend(agent, cmd);
    signal.stopped = false;
    return runCliAgent(agent, prompt, signal);
  }
  if (op === '/llm') {
    if (!agent.client) return printLine('❌ 当前没有可用的 LLM 配置');
    if (parts.length > 1) {
      try {
        agent.nextLlm(parseInt(parts[1], 10));
        return printLine(`✅ 已切换到 [${agent.llmNo}] ${agent.llmName}`);
      } catch {
        return printLine(`用法: /llm <0-${agent.listLlms().split('\n').length - 1}>`);
      }
    }
    return printLine(`LLMs:\n${agent.listLlms()}`);
  }
  if (op === '/cost') {
    return printLine(costTracker.formatCostReport('main', { includeSubagents: true }));
  }
  printLine(CLI_HELP);
}

async function main(): Promise<void> {
  costTracker.install();
  if (process.env.ORION_CLI_TOOL_RESULTS === undefined) process.env.ORION_CLI_TOOL_RESULTS = 'true';
  if (process.env.ORION_CLI_THINKING === undefined) process.env.ORION_CLI_THINKING = 'true';

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
      [path.resolve(projectRoot, 'apps', 'cli', 'dist', 'main.js'), ...childArgs],
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
    if (!flags.nolog) console.log(result);
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
    if (flags.input) fs.writeFileSync(infile, flags.input, 'utf-8');
    let raw = await readTaskInput(taskDir);
    let nround: number | '' = '';
    while (true) {
      const result = await agent.runOnce(raw);
      fs.writeFileSync(path.join(taskDir, `output${nround}.txt`), result + '\n\n[ROUND END]\n', 'utf-8');
      console.log(result);
      consumeFile(taskDir, '_stop');
      let reply: string | undefined;
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

  console.log(`Orion CLI | ${agent.llmName}`);
  console.log('Type /help for commands, or enter a task.');

  const signal = { stopped: false };
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

    try {
      signal.stopped = false;
      if (q.startsWith('/')) {
        await handleCliCommand(agent, q, signal);
      } else {
        await runCliAgent(agent, q, signal);
      }
    } catch (e) {
      console.error(`[CLI] error: ${e instanceof Error ? e.message : String(e)}`);
    }
    rl.prompt();
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
