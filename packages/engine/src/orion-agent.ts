import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Engine: agent loop & handler
// ---------------------------------------------------------------------------
import { agentRunnerLoop } from './agent-loop.js';
import type { AgentLoopOptions } from './agent-loop.js';
import { OrionAgentHandler } from './handler.js';
import type { HandlerParent } from './handler.js';

// ---------------------------------------------------------------------------
// Engine: interfaces (DI)
// ---------------------------------------------------------------------------
import type { LLMProvider } from './llm/provider.js';
import type { CodeExecutor } from './tools/executor.js';
import type { WebAutomation } from './web/automation.js';
import type { ConfigProvider } from './config/provider.js';

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
// Engine: cost tracker
// ---------------------------------------------------------------------------
import * as costTracker from './cost-tracker.js';

// ---------------------------------------------------------------------------
// Engine: shared
// ---------------------------------------------------------------------------
import { findProjectRoot } from './shared/index.js';

// ---------------------------------------------------------------------------
// Engine: types
// ---------------------------------------------------------------------------
import type { AgentYield, AgentState, TaskQueueLike, ToolDefinition } from './types/index.js';

// ===========================================================================
// Exported types
// ===========================================================================

export interface OrionAgentOptions {
  /** Required: LLM provider for chat completion. */
  llmProvider: LLMProvider;

  /** Optional: code execution backend. When absent, code_run returns "not available". */
  codeExecutor?: CodeExecutor;

  /** Optional: web automation backend. When absent, web_* returns "not available". */
  webAutomation?: WebAutomation;

  /** Optional: config provider. When absent, /cost etc. rely on manual cost-tracker calls. */
  configProvider?: ConfigProvider;

  /** Working directory for file operations (default: projectRoot/temp). */
  cwd?: string;

  /** System prompt prepended to each agent turn. */
  systemPrompt?: string;

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
// OrionAgent
// ===========================================================================

export class OrionAgent {
  // --- Injected dependencies ---
  /** The LLM provider used for chat completions. */
  llmProvider: LLMProvider;

  /** Optional code executor (code_run tool). */
  codeExecutor?: CodeExecutor;

  /** Optional web automation (web_* tools). */
  webAutomation?: WebAutomation;

  /** Optional config provider. */
  configProvider?: ConfigProvider;

  // --- Public properties ---
  systemPrompt: string;
  cwd: string;
  verbose = true;
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

  constructor(options: OrionAgentOptions) {
    this.llmProvider = options.llmProvider;
    this.codeExecutor = options.codeExecutor;
    this.webAutomation = options.webAutomation;
    this.configProvider = options.configProvider;
    this.systemPrompt = options.systemPrompt ?? 'You are an AI assistant.';

    this.cwd = options?.cwd ?? findProjectRoot();
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
    registerCodeTools(this.toolRegistry, this.cwd, this._codeStopSignal, this.codeExecutor);
    registerWebTools(this.toolRegistry, this.webAutomation);
    registerUserTools(this.toolRegistry);
  }

  /** Return the underlying LLM provider name + model for display. */
  get llmName(): string {
    return `${this.llmProvider.name}/${this.llmProvider.model}`;
  }

  abort(): void {
    if (!this.isRunning) return;
    console.log('Abort current task...');
    this.stopSig = true;
    this._codeStopSignal.push(1);
    if (this.handler) this.handler.codeStopSignal.push(1);
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
    this._codeStopSignal = [];
    const rquery = raw.replace(/\n/g, ' ').slice(0, 200);
    this.history.push(`[USER]: ${rquery}`);

    const taskCwd = task.cwd ?? this.cwd;

    // ---- Build system prompt ----
    let sysPrompt = this.systemPrompt;

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
        afterTurn: (_turn, response, _toolResults) => {
          if (response.usage) {
            this.windowManager.onUsage(response.usage);
          }
        },
      },
    };

    // ---- Run agent loop ----
    const gen = agentRunnerLoop(
      this.llmProvider,
      sysPrompt,
      raw,
      handler,
      toolsSchema,
      70,
      raw,
      loopOptions,
    );

    let fullResp = '';
    try {
      for await (const chunk of gen) {
        if (this.stopSig) break;
        if (chunk.kind === 'text') {
          fullResp += chunk.content;
        }
        dispatchYield(chunk, this.consumer);
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
      [],
      this.handler?.working ?? {},
      this.history,
      this.handler?.currentTurn ?? 0,
    );
  }

  static fromState(state: AgentState, options: OrionAgentOptions): OrionAgent {
    const agent = new OrionAgent(options);
    const restored = restoreAgentState(state);
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
    const before = { ...costTracker.getTracker('main') };

    const sub = new OrionAgent({
      llmProvider: this.llmProvider,
      codeExecutor: this.codeExecutor,
      webAutomation: this.webAutomation,
      configProvider: this.configProvider,
      cwd: this.cwd,
    });
    sub.verbose = false;
    sub.bannedTools = ['ask_user', 'start_long_term_update'];
    const result = await sub.runOnce(request.prompt);

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

  // =========================================================================
  // Built-in slash command handling
  // =========================================================================

  private handleSlashCmd(raw: string): string | null {
    if (!raw.startsWith('/')) return raw;
    if (raw.trim() === '/cost') {
      console.log(costTracker.formatCostReport('main'));
      return null;
    }
    if (raw.trim() === '/help') {
      console.log(`Commands:
  /cost   show token cost report
  /help   show this help`);
      return null;
    }
    // Unknown slash command — pass through so the agent can handle it
    return raw;
  }
}
