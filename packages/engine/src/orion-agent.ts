import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Core LLM client (stays in @orion/core for now)
// ---------------------------------------------------------------------------
import { createClient, loadSessionsFromEnv, NativeToolClient, costTracker } from '@orion/core';
import type { BaseSession, Message } from '@orion/core';

// ---------------------------------------------------------------------------
// Engine: agent loop
// ---------------------------------------------------------------------------
import { agentRunnerLoop } from './agent-loop.js';
import type { AgentLoopOptions } from './agent-loop.js';

// ---------------------------------------------------------------------------
// Engine: handler
// ---------------------------------------------------------------------------
import { OrionAgentHandler } from './handler.js';
import type { HandlerParent } from './handler.js';

// ---------------------------------------------------------------------------
// Engine: tools
// ---------------------------------------------------------------------------
import { ToolRegistry } from './tools/registry.js';
import type { MCPServerConfig } from './tools/registry.js';
import { registerFileTools } from './tools/builtin/file.js';
import { registerCodeTools } from './tools/builtin/code.js';
import { registerWebTools } from './tools/builtin/web.js';
import { registerUserTools } from './tools/builtin/user.js';

// ---------------------------------------------------------------------------
// Engine: stream
// ---------------------------------------------------------------------------
import { AgentYieldConsumer, CliConsumer, dispatchYield } from './stream/consumer.js';

// ---------------------------------------------------------------------------
// Engine: context
// ---------------------------------------------------------------------------
import { WindowManager, TruncateWindowManager } from './context/window-manager.js';

// ---------------------------------------------------------------------------
// Engine: resilience
// ---------------------------------------------------------------------------
import { RetryPolicy, DEFAULT_RETRY_POLICY } from './resilience/retry.js';

// ---------------------------------------------------------------------------
// Engine: state
// ---------------------------------------------------------------------------
import { saveAgentState, restoreAgentState } from './state/serialization.js';

// ---------------------------------------------------------------------------
// Engine: telemetry
// ---------------------------------------------------------------------------
import { TelemetryHooks, getTelemetry } from './telemetry/tracing.js';

// ---------------------------------------------------------------------------
// Engine: shared
// ---------------------------------------------------------------------------
import { findProjectRoot, getGlobalMemory } from './shared/index.js';

// ---------------------------------------------------------------------------
// Engine: types
// ---------------------------------------------------------------------------
import type { AgentYield, AgentState, TaskQueueLike, ToolDefinition } from './types/index.js';

// ===========================================================================
// Exported types
// ===========================================================================

export interface OrionAgentOptions {
  cwd?: string;
  consumer?: AgentYieldConsumer;
  retryPolicy?: RetryPolicy;
  windowManager?: WindowManager;
  mcpServers?: MCPServerConfig[];
  telemetry?: TelemetryHooks;
}

export type ToolApprovalDecision = 'allow' | 'deny';

export type ToolApprovalFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<ToolApprovalDecision>;

export interface SubAgentRequest {
  prompt: string;
}

export interface SubAgentResult {
  output: string;
  usage: ReturnType<typeof costTracker.getTracker>;
  toolCalls: unknown[];
}

// ===========================================================================
// Internal types
// ===========================================================================

type TaskItem = {
  query: string;
  source: string;
  cwd?: string;
  output: { next?: AgentYield; done?: string; source: string }[];
};

interface RestoredState {
  working: Record<string, unknown>;
  historyInfo: string[];
  turn: number;
}

// ===========================================================================
// Helpers (adapted from GenericAgent)
// ===========================================================================

function isZhLocale(): boolean {
  const loc = (process.env.LANG || process.env.LC_ALL || '').toLowerCase();
  return loc.includes('zh') || loc.includes('chinese');
}

const GA_LANG = process.env.GA_LANG || (isZhLocale() ? 'zh' : 'en');
process.env.GA_LANG = GA_LANG;

function projectRoot(): string {
  return findProjectRoot();
}

function readUserName(): string | undefined {
  try {
    const text = fs.readFileSync(path.join(projectRoot(), 'memory', 'global_mem.txt'), 'utf-8');
    return text.match(/用户姓名[：:]\s*(.+)/)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function getSystemPrompt(cwd: string): string {
  const suffix = GA_LANG === 'en' ? '_en' : '';
  const p = path.join(projectRoot(), 'assets', `sys_prompt${suffix}.txt`);
  let prompt: string;
  try {
    prompt = fs.readFileSync(p, 'utf-8');
  } catch {
    prompt = 'You are an AI assistant.';
  }
  const now = new Date();
  const weekdays =
    GA_LANG === 'en'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  prompt += `\nToday: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${weekdays[now.getDay()]}\n`;
  prompt += getGlobalMemory();
  return prompt;
}

function ensureMemoryFiles(): void {
  const memDir = path.join(projectRoot(), 'memory');
  if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
  const globalMem = path.join(memDir, 'global_mem.txt');
  if (!fs.existsSync(globalMem)) {
    fs.writeFileSync(globalMem, '# [Global Memory - L2]\n', 'utf-8');
  }
  const insight = path.join(memDir, 'global_mem_insight.txt');
  if (!fs.existsSync(insight)) {
    const suffix = GA_LANG === 'en' ? '_en' : '';
    const tpl = path.join(projectRoot(), 'assets', `global_mem_insight_template${suffix}.txt`);
    if (fs.existsSync(tpl)) {
      fs.writeFileSync(insight, fs.readFileSync(tpl, 'utf-8'), 'utf-8');
    } else {
      fs.writeFileSync(insight, '', 'utf-8');
    }
  }
}

function findConfigPath(): { path: string } | null {
  const envPath = path.join(projectRoot(), '.env');
  if (fs.existsSync(envPath)) return { path: envPath };
  return null;
}

function loadSessionsFresh(keepHistory?: Message[]): BaseSession[] {
  const cfg = findConfigPath();
  if (!cfg) throw new Error('No .env found. Please copy .env.example to .env and configure your LLM.');
  const sessions = loadSessionsFromEnv(cfg.path);
  if (keepHistory && sessions.length) {
    sessions[0].history = keepHistory;
  }
  return sessions;
}

// ===========================================================================
// OrionAgent
// ===========================================================================

export class OrionAgent {
  // --- Public properties (backward compat with GenericAgent) ---
  sessions: BaseSession[] = [];
  client: NativeToolClient;
  cwd: string;
  llmNo = 0;
  verbose = true;
  peerHint = true;
  isRunning = false;
  stopSig = false;
  handler?: OrionAgentHandler;
  taskDir?: string;
  history: string[] = [];
  taskQueue: TaskItem[] = [];
  processing = false;
  bannedTools: string[] = [];
  approveToolCall?: ToolApprovalFn;

  // --- Engine-managed dependencies ---
  readonly toolRegistry: ToolRegistry;
  readonly windowManager: WindowManager;
  readonly consumer: AgentYieldConsumer;
  readonly retryPolicy: RetryPolicy;
  readonly mcpServers: MCPServerConfig[];

  // --- Private internals ---
  private _telemetry: TelemetryHooks;
  private _mcpReady = false;
  private _codeStopSignal: number[] = [];
  private _resumeState?: RestoredState;

  constructor(options?: OrionAgentOptions) {
    ensureMemoryFiles();
    this.sessions = loadSessionsFresh();
    this.cwd = options?.cwd ?? path.join(projectRoot(), 'temp');
    this.client = createClient(this.sessions, this.llmNo, this.cwd);
    if (!fs.existsSync(this.cwd)) {
      fs.mkdirSync(this.cwd, { recursive: true });
    }

    // Wire up engine dependencies
    this.toolRegistry = new ToolRegistry();
    this.windowManager = options?.windowManager ?? new TruncateWindowManager();
    this.consumer = options?.consumer ?? new CliConsumer();
    this.retryPolicy = options?.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this._telemetry = options?.telemetry ?? getTelemetry();
    this.mcpServers = options?.mcpServers ?? [];

    // Register builtin tools
    registerFileTools(this.toolRegistry, this.cwd);
    registerCodeTools(this.toolRegistry, this.cwd, this._codeStopSignal);
    registerWebTools(this.toolRegistry, this.cwd);
    registerUserTools(this.toolRegistry);
  }

  // =========================================================================
  // Public API (backward compat with GenericAgent)
  // =========================================================================

  get llmName(): string {
    const b = this.client.backend;
    return `${b.constructor.name}/${b.name}`;
  }

  nextLlm(n = -1): void {
    this.sessions = loadSessionsFresh(this.client.backend.history);
    this.llmNo = (n < 0 ? this.llmNo + 1 : n) % this.sessions.length;
    this.client = createClient(this.sessions, this.llmNo, this.cwd);
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
    this._codeStopSignal.push(1);
    if (this.handler) this.handler.codeStopSignal.push(1);
  }

  handleSlashCmd(raw: string): string | null {
    if (!raw.startsWith('/')) return raw;
    const m = raw.trim().match(/^\/session\.(\w+)=(.*)$/);
    if (m) {
      const [, k, v] = m;
      let val: unknown = v;
      const vfile = path.join(projectRoot(), 'temp', v);
      if (fs.existsSync(vfile)) val = fs.readFileSync(vfile, 'utf-8').trim();
      try {
        val = JSON.parse(val as string);
      } catch {
        // keep as string
      }
      (this.client.backend as unknown as Record<string, unknown>)[k] = val;
      console.log(`session.${k} = ${JSON.stringify(val).slice(0, 500)}`);
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

  putTask(query: string, source = 'user', cwd?: string): TaskQueueLike {
    const item: TaskItem = { query, source, cwd, output: [] };
    const pending: Array<(value: { done?: string; next?: AgentYield; source?: string } | null) => void> = [];
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
      get: async (block?: boolean, timeout?: number) => {
        if (item.output.length) return item.output.shift() || null;
        if (block === false) return null;
        return new Promise<{ done?: string; next?: AgentYield; source?: string } | null>((resolve) => {
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
    // ---- Handle slash commands ----
    const raw = this.handleSlashCmd(task.query);
    if (raw === null) return;

    this.isRunning = true;
    this.stopSig = false;
    const rquery = raw.replace(/\n/g, ' ').slice(0, 200);
    this.history.push(`[USER]: ${rquery}`);

    const taskCwd = task.cwd ?? path.join(projectRoot(), 'temp');

    // ---- Build system prompt ----
    let sysPrompt = getSystemPrompt(taskCwd);
    const extra = (this.client.backend as unknown as Record<string, unknown>).extra_sys_prompt;
    if (typeof extra === 'string') sysPrompt += extra;
    if (this.peerHint) {
      sysPrompt += '\n[Peer] 用户提及其他会话/后台任务状态时: temp/model_responses/ (只找近期修改的文件尾部)\n';
    }

    const userName = readUserName();
    const userContent = userName
      ? `[User Profile]\n- 姓名：${userName}\n\n用户当前消息：${raw}`
      : raw;

    // ---- MCP initialization (lazy, before first agent run) ----
    if (this.mcpServers.length && !this._mcpReady) {
      const { registerMCPServerTools } = await import('./tools/mcp/adapter.js');
      for (const cfg of this.mcpServers) {
        await registerMCPServerTools(this.toolRegistry, cfg);
      }
      this._mcpReady = true;
    }

    // ---- Window management hint ----
    const usage = this.windowManager.getUsage();
    if (usage.remaining < usage.budget * 0.2) {
      // Near limit — window manager will trim on next cycle
      if (this.verbose) {
        console.log(`[Window] Near token limit (${usage.used}/${usage.budget}), window manager will trim.`);
      }
    }

    // ---- Create handler ----
    const parent: HandlerParent = {
      taskDir: this.taskDir,
      verbose: this.verbose,
      approveToolCall: this.approveToolCall,
    };
    const handler = new OrionAgentHandler(parent, this.toolRegistry, this.history);
    handler.codeStopSignal = this._codeStopSignal;

    // Resume from saved state if available
    if (this._resumeState) {
      handler.working = { ...this._resumeState.working };
      this.history = [...this._resumeState.historyInfo];
      handler.currentTurn = this._resumeState.turn;
      this._resumeState = undefined;
    } else if (this.handler?.working.key_info) {
      // Carry forward key_info from previous handler (backward compat)
      const ki = String(this.handler.working.key_info).replace(
        /\n\[SYSTEM\] 此为.*?工作记忆[。\n]*/g,
        '',
      );
      const ps = (Number(this.handler.working.passed_sessions) || 0) + 1;
      handler.working.passed_sessions = ps;
      handler.working.key_info =
        ki +
        `\n[SYSTEM] 此为 ${ps} 个对话前设置的key_info，若已在新任务，先更新或清除工作记忆。\n`;
    }

    this.handler = handler;

    // ---- Build tools schema from registry ----
    let toolsSchema = this.toolRegistry.list();
    if (this.bannedTools.length) {
      toolsSchema = toolsSchema.filter((t: ToolDefinition) => !this.bannedTools.includes(t.function.name));
    }

    // ---- Build AgentLoopOptions ----
    const loopOptions: AgentLoopOptions = {
      maxTurns: 70,
      retryPolicy: this.retryPolicy,
      hooks: {
        beforeTurn: (turn, _messages) => {
          this._telemetry.onTurnStart(turn, _messages);
        },
        afterTurn: (_turn, response, toolResults) => {
          if (response.usage) {
            this.windowManager.onUsage(response.usage);
          }
        },
      },
    };

    // ---- Run agent loop ----
    const gen = agentRunnerLoop(
      this.client,
      sysPrompt,
      raw,
      handler,
      toolsSchema,
      70,
      userContent,
      loopOptions,
    );

    let fullResp = '';
    try {
      for await (const chunk of gen) {
        if (this.stopSig) break;
        if (chunk.kind === 'text') {
          fullResp += chunk.content;
        }
        // Dispatch to consumer for rendering
        dispatchYield(chunk, this.consumer);
        // Push to task output queue (backward compat)
        task.output.push({ next: chunk, source: task.source });
      }
      if (fullResp.includes('</summary>')) {
        fullResp = fullResp.replace(/<\/summary>/g, '</summary>\n\n');
      }
      task.output.push({ done: fullResp, source: task.source });
      this.history = handler.historyInfo;
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`Backend Error: ${err}`);
      const doneText = fullResp + (fullResp ? '\n\n' : '') + `\`\`\`\n${err}\n\`\`\``;
      task.output.push({ done: doneText, source: task.source });
      task.output.push({ next: { kind: 'error', severity: 'fatal', message: err }, source: task.source });
    } finally {
      this.isRunning = false;
      this.stopSig = false;
      this._codeStopSignal.push(1);
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

  // =========================================================================
  // State serialization
  // =========================================================================

  saveState(): AgentState {
    return saveAgentState(
      this.client.backend.history,
      this.handler?.working ?? {},
      this.history,
      this.handler?.currentTurn ?? 0,
    );
  }

  static fromState(state: AgentState, options?: OrionAgentOptions): OrionAgent {
    const agent = new OrionAgent(options);
    const restored = restoreAgentState(state);
    agent.client.backend.history = restored.messages;
    agent._resumeState = {
      working: restored.working,
      historyInfo: restored.historyInfo,
      turn: restored.turn,
    };
    return agent;
  }

  // =========================================================================
  // Sub-agent delegation
  // =========================================================================

  async delegate(request: SubAgentRequest): Promise<SubAgentResult> {
    // Snapshot parent usage before sub-agent runs so we can compute delta
    const before = { ...costTracker.getTracker('main') };

    const sub = new OrionAgent({ cwd: this.cwd });
    sub.verbose = false;
    sub.peerHint = false;
    sub.bannedTools = ['ask_user', 'start_long_term_update'];
    const result = await sub.runOnce(request.prompt);

    // Compute delta: tokens consumed by the sub-agent only
    const after = costTracker.getTracker('main');
    const delta = {
      ...costTracker.emptyStats(),
      input: after.input - before.input,
      output: after.output - before.output,
      cacheCreate: after.cacheCreate - before.cacheCreate,
      cacheRead: after.cacheRead - before.cacheRead,
    };

    return {
      output: result,
      usage: delta,
      toolCalls: [],
    };
  }
}
