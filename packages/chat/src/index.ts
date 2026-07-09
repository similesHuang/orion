import fs from 'fs';
import net from 'net';
import path from 'path';
import type { GenericAgentLike } from '@orion/agent';
import { costTracker } from '@orion/agent';
import { handleContinueFrontend, resetConversation } from './continue-cmd.js';
import { handleBtwAsync } from './btw-cmd.js';
import { handleReviewFrontend } from './review-cmd.js';
import {
  extractAssistantSummary,
  extractHistoryLines,
  extractNativeUserLine,
  extractUserText,
  parseModelResponsePairs,
  parseNativePrompt,
} from './history-utils.js';
export { costTracker } from '@orion/agent';
export { handleBtwAsync, handleReviewFrontend };
export { loadMykey, projectRootFrom } from '@orion/shared';
export { createWebhookServer } from './gateway-utils.js';

export const HELP_COMMANDS: Array<[string, string]> = [
  ['/help', '显示帮助'],
  ['/status', '查看状态'],
  ['/stop', '停止当前任务'],
  ['/new', '开启新对话并清空当前上下文'],
  ['/restore', '恢复上次对话历史'],
  ['/continue', '列出可恢复会话'],
  ['/continue [n]', '恢复第 n 个会话'],
  ['/btw <q>', 'side question — 临时插问主 agent 进展，不打断主线'],
  ['/review [scope]', 'in-session code review; 默认审当前 git diff'],
  ['/llm', '查看当前模型列表'],
  ['/llm [n]', '切换到第 n 个模型'],
  ['/cost', '查看本次 token 消耗'],
];

export const TELEGRAM_MENU_COMMANDS: Array<[string, string]> = [
  ['help', '显示帮助'],
  ['status', '查看状态'],
  ['stop', '停止当前任务'],
  ['new', '开启新对话并清空当前上下文'],
  ['restore', '恢复上次对话历史'],
  ['continue', '列出可恢复会话；/continue n 恢复第 n 个'],
  ['btw', '临时插问主 agent 进展，不打断主线'],
  ['review', 'in-session code review；/review scope 指定范围'],
  ['llm', '查看模型列表；/llm n 切换到指定模型'],
  ['cost', '查看本次 token 消耗'],
];

export function buildHelpText(commands = HELP_COMMANDS): string {
  return '📖 命令列表:\n' + commands.map(([cmd, desc]) => `${cmd} - ${desc}`).join('\n');
}

export const HELP_TEXT = buildHelpText();
export const FILE_HINT = 'If you need to show files to user, use [FILE:filepath] in your response.';

const TAG_PATS = ['thinking', 'summary', 'tool_use', 'file_content'].map(
  (tag) => new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')
);

export function cleanReply(text: string): string {
  for (const pat of TAG_PATS) {
    text = text.replace(pat, '');
  }
  return text.replace(/\n{3,}/g, '\n\n').trim() || '...';
}

export function extractFiles(text: string): string[] {
  return [...(text || '').matchAll(/\[FILE:([^\]]+)\]/g)].map((m) => m[1]);
}

export function stripFiles(text: string): string {
  return (text || '').replace(/\[FILE:[^\]]+\]/g, '').trim();
}

export function splitText(text: string, limit: number): string[] {
  text = (text || '').trim() || '...';
  const parts: string[] = [];
  while (text.length > limit) {
    let cut = text.lastIndexOf('\n', limit);
    if (cut < limit * 0.6) cut = limit;
    parts.push(text.slice(0, cut).trimEnd());
    text = text.slice(cut).trimStart();
  }
  if (text) parts.push(text);
  return parts.length ? parts : ['...'];
}

export interface SessionInfo {
  path: string;
  mtime: number;
  preview: string;
  rounds: number;
}

const RESTORE_GLOBS = [
  path.join(process.cwd(), 'temp', 'model_responses', 'model_responses_*.txt'),
  path.join(process.cwd(), 'temp', 'model_responses_*.txt'),
];

function restoreNativeHistory(content: string): string[] {
  const pairs = parseModelResponsePairs(content);
  if (!pairs.length) return [];
  for (const { prompt: promptBody, response: responseBody } of [...pairs].reverse()) {
    const prompt = parseNativePrompt(promptBody);
    if (!prompt) continue;
    const promptText = extractUserText(promptBody);
    const restored = extractHistoryLines(promptText);
    if (restored.length) {
      const summary = extractAssistantSummary(responseBody);
      const summaryLine = summary ? `[Agent] ${summary}` : '';
      if (summaryLine && restored[restored.length - 1] !== summaryLine) restored.push(summaryLine);
      return restored;
    }
    const userLine = extractNativeUserLine(promptText);
    const summary = extractAssistantSummary(responseBody);
    if (userLine && summary) return [`[USER]: ${userLine}`, `[Agent] ${summary}`];
  }
  return [];
}

export function formatRestore(): [string[], string, number] | [null, string, null] {
  const files: string[] = [];
  for (const g of RESTORE_GLOBS) {
    const dir = path.dirname(g);
    const pat = path.basename(g).replace(/\*/g, '.*').replace(/\?/g, '.');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (new RegExp(`^${pat}$`).test(f)) files.push(path.join(dir, f));
    }
  }
  if (!files.length) return [null, '❌ 没有找到历史记录', null];
  const latest = files.reduce((a, b) => (fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs ? a : b));
  const content = fs.readFileSync(latest, 'utf-8');
  const textPairs = parseModelResponsePairs(content).map((p) => [`[USER]: ${p.prompt.slice(0, 500)}`, `[Agent] ${p.response.slice(0, 500)}`]).flat();
  const restored = textPairs.length ? textPairs : restoreNativeHistory(content);
  if (!restored.length) return [null, '❌ 历史记录里没有可恢复内容', null];
  const count = restored.filter((l) => l.startsWith('[USER]: ')).length;
  return [restored, path.basename(latest), count];
}

function currentLogPath(pid = process.pid): string {
  return path.join(path.dirname(RESTORE_GLOBS[0]), `model_responses_${pid}.txt`);
}

export function snapshotCurrentLog(pid = process.pid): string | null {
  const logPath = currentLogPath(pid);
  if (!fs.existsSync(logPath)) return null;
  const content = fs.readFileSync(logPath, 'utf-8');
  if (!parseModelResponsePairs(content).length) return null;
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshot = path.join(dir, `model_responses_snapshot_${pid}_${stamp}_${Date.now()}.txt`);
  fs.writeFileSync(snapshot, content, 'utf-8');
  fs.writeFileSync(logPath, '', 'utf-8');
  return snapshot;
}

export function listSessions(excludePid = process.pid): SessionInfo[] {
  const dir = path.dirname(RESTORE_GLOBS[0]);
  if (!fs.existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('model_responses_') || !f.endsWith('.txt')) continue;
    const m = f.match(/model_responses_(\d+)\.txt$/);
    if (!m || Number(m[1]) === excludePid) continue;
    const full = path.join(dir, f);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      const pairs = parseModelResponsePairs(content);
      if (!pairs.length) continue;
      const preview = extractAssistantSummary(pairs[pairs.length - 1].response) || pairs[pairs.length - 1].prompt.slice(0, 60);
      out.push({ path: full, mtime: Math.floor(fs.statSync(full).mtimeMs / 1000), preview, rounds: pairs.length });
    } catch {
      // ignore unreadable files
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function buildDoneText(rawText: string): string {
  const files = extractFiles(rawText).filter((p) => fs.existsSync(p));
  let body = stripFiles(cleanReply(rawText));
  if (files.length) {
    body = (body ? body + '\n\n' : '') + files.map((p) => `生成文件: ${p}`).join('\n');
  }
  return body || '...';
}

export function publicAccess(allowed: Set<string> | string[] | undefined): boolean {
  if (!allowed) return true;
  const arr = Array.isArray(allowed) ? allowed : [...allowed];
  return arr.length === 0 || arr.includes('*');
}

export function toAllowedSet(value: unknown): Set<string> {
  if (value == null) return new Set();
  const arr = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return new Set(arr.map((x) => String(x).trim()).filter(Boolean));
}

export function allowedLabel(allowed: Set<string> | string[] | undefined): string {
  return publicAccess(allowed) ? 'public' : (Array.isArray(allowed) ? allowed : [...(allowed || [])]).sort().join(', ');
}

export function ensureSingleInstance(port: number, label: string): net.Server {
  const srv = net.createServer();
  srv.once('error', () => {
    console.log(`[${label}] Another instance is already running, skipping...`);
    process.exit(1);
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

export function requireRuntime(agent: GenericAgentLike, label: string, required: Record<string, unknown>): void {
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`[${label}] ERROR: please set ${missing.join(', ')} in .env or mykey.json`);
    process.exit(1);
  }
  if (Object.keys(agent).length && !agent.client) {
    console.error(`[${label}] ERROR: no usable LLM backend found in .env or mykey.json`);
    process.exit(1);
  }
}

export function redirectLog(scriptFile: string, logName: string, label: string, allowed: Set<string>): void {
  const logDir = path.join(path.dirname(path.dirname(path.resolve(scriptFile))), 'temp');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, logName);
  const logf = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf-8' });
  const write = (chunk: string) => logf.write(chunk);
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  console.log(`[NEW] ${label} process starting, the above are history infos ...`);
  console.log(`[${label}] allow list: ${allowedLabel(allowed)}`);
}

export type { GenericAgentLike, TaskQueueLike } from '@orion/agent';

export interface AgentChatCtx {
  [key: string]: unknown;
}

export class AgentChatMixin {
  label = 'Chat';
  source = 'chat';
  splitLimit = 1500;
  pingInterval = 20;
  agent: GenericAgentLike;
  userTasks: Map<string, { running: boolean }>;
  allowed: Set<string> = new Set();

  constructor(agent: GenericAgentLike, userTasks: Map<string, { running: boolean }>) {
    this.agent = agent;
    this.userTasks = userTasks;
  }

  async sendText(_chatId: string, _content: string, _ctx?: AgentChatCtx): Promise<void> {
    throw new Error('Not implemented');
  }

  handleWebhook(_body: Record<string, unknown>): void {
    throw new Error('Not implemented');
  }

  splitText(text: string, limit: number): string[] {
    return splitText(text, limit);
  }

  protected checkAllowed(identifier: string | string[] | undefined): boolean {
    if (!this.allowed.size) return true;
    if (!identifier) return false;
    const ids = Array.isArray(identifier) ? identifier : [identifier];
    return ids.some((id) => this.allowed.has(id));
  }

  async sendDone(chatId: string, rawText: string, ctx?: AgentChatCtx): Promise<void> {
    await this.sendText(chatId, buildDoneText(rawText), ctx);
  }

  async handleCommand(chatId: string, cmd: string, ctx?: AgentChatCtx): Promise<void> {
    const parts = (cmd || '').split(/\s+/);
    const op = (parts[0] || '').toLowerCase();
    if (op === '/help') return this.sendText(chatId, HELP_TEXT, ctx);
    if (op === '/stop') {
      const state = this.userTasks.get(chatId);
      if (state) state.running = false;
      this.agent.abort();
      return this.sendText(chatId, '⏹️ 正在停止...', ctx);
    }
    if (op === '/status') {
      const llm = this.agent.client ? this.agent.llmName : '未配置';
      return this.sendText(chatId, `状态: ${this.agent.isRunning ? '🔴 运行中' : '🟢 空闲'}\nLLM: [${this.agent.llmNo}] ${llm}`, ctx);
    }
    if (op === '/llm') {
      if (!this.agent.client) return this.sendText(chatId, '❌ 当前没有可用的 LLM 配置', ctx);
      if (parts.length > 1) {
        try {
          this.agent.nextLlm(parseInt(parts[1], 10));
          return this.sendText(chatId, `✅ 已切换到 [${this.agent.llmNo}] ${this.agent.llmName}`, ctx);
        } catch {
          return this.sendText(chatId, `用法: /llm <0-${this.agent.listLlms().split('\n').length - 1}>`, ctx);
        }
      }
      return this.sendText(chatId, `LLMs:\n${this.agent.listLlms()}`, ctx);
    }
    if (op === '/restore') {
      try {
        const result = formatRestore();
        if (result[0] === null) return this.sendText(chatId, result[1] || '❌ 恢复失败', ctx);
        const [restored, fname, count] = result as [string[], string, number];
        this.agent.abort();
        this.agent.history.push(...restored);
        return this.sendText(chatId, `✅ 已恢复 ${count} 轮对话\n来源: ${fname}\n(仅恢复上下文，请输入新问题继续)`, ctx);
      } catch (e) {
        return this.sendText(chatId, `❌ 恢复失败: ${e instanceof Error ? e.message : String(e)}`, ctx);
      }
    }
    if (op === '/continue') return this.sendText(chatId, handleContinueFrontend(this.agent, cmd), ctx);
    if (op === '/new') return this.sendText(chatId, resetConversation(this.agent), ctx);
    if (op === '/btw') {
      const answer = await handleBtwAsync(this.agent, cmd);
      return this.sendText(chatId, answer, ctx);
    }
    if (op === '/review') {
      const prompt = handleReviewFrontend(this.agent, cmd);
      return this.runAgent(chatId, prompt, ctx);
    }
    if (op === '/cost') {
      return this.sendText(chatId, costTracker.formatCostReport('main', { includeSubagents: true }), ctx);
    }
    return this.sendText(chatId, HELP_TEXT, ctx);
  }

  async runAgent(chatId: string, text: string, ctx?: AgentChatCtx): Promise<void> {
    const state = { running: true };
    this.userTasks.set(chatId, state);
    try {
      await this.sendText(chatId, '思考中...', ctx);
      const dq = this.agent.putTask(`${FILE_HINT}\n\n${text}`, this.source);
      let lastPing = Date.now();
      while (state.running) {
        const item = await dq.get(true, 3);
        if (!item) {
          if (this.agent.isRunning && Date.now() - lastPing > this.pingInterval * 1000) {
            await this.sendText(chatId, '⏳ 还在处理中，请稍等...', ctx);
            lastPing = Date.now();
          }
          continue;
        }
        if (item.done) {
          await this.sendDone(chatId, item.done, ctx);
          break;
        }
      }
      if (!state.running) await this.sendText(chatId, '⏹️ 已停止', ctx);
    } catch (e) {
      console.error(`[${this.label}] runAgent error: ${e instanceof Error ? e.message : String(e)}`);
      await this.sendText(chatId, `❌ 错误: ${e instanceof Error ? e.message : String(e)}`, ctx);
    } finally {
      this.userTasks.delete(chatId);
    }
  }
}
