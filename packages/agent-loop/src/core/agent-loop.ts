import type { Message, AgentEvent, ToolDef } from './message.js';
import type { LLMProvider, LLMEvent, ChatOptions } from './llm-provider.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolResult } from './tool-registry.js';
import { RetryPolicy, withRetry, DEFAULT_RETRY_POLICY } from '../runtime/retry-policy.js';
import { AgentError } from '../runtime/agent-error.js';
import type { WindowManager } from '../runtime/window-manager.js';
import type { MemoryStore } from '../runtime/memory-store.js';
import type { SkillLoader } from '../runtime/skill-loader.js';
import { HookPipeline } from '../runtime/hook-pipeline.js';
import type { BeforeToolContext, AfterToolContext, StopContext, TurnContext, ErrorContext } from '../runtime/hook-pipeline.js';

// ── AgentLoopOptions ──
export interface AgentLoopOptions {
  llm: LLMProvider;
  systemPrompt: string;
  tools?: ToolRegistry;
  toolChoice?: ChatOptions['toolChoice'];
  maxTurns?: number;
  maxTokens?: number;
  retryPolicy?: RetryPolicy;
  windowManager?: WindowManager;
  memoryStore?: MemoryStore;
  skillLoader?: SkillLoader;
  hooks?: {
    onTurnStart?: (turn: number) => void;
    onTurnEnd?: (turn: number, stats: { toolCalls: number; errors: number }) => void;
    onToken?: (delta: string) => void;
  };
}

// ── AgentLoop ──
export class AgentLoop {
  private llm: LLMProvider;
  private systemPrompt: string;
  private tools: ToolRegistry;
  private toolChoice?: ChatOptions['toolChoice'];
  private maxTurns: number;
  private maxTokens: number;
  private retryPolicy: RetryPolicy;
  private windowManager?: WindowManager;
  private memoryStore?: MemoryStore;
  private skillLoader?: SkillLoader;
  private hookPipeline: HookPipeline;
  private userHooks: NonNullable<AgentLoopOptions['hooks']>;

  private messages: Message[] = [];
  private turn = 0;
  private running = false;
  private paused = false;
  private resumePromise?: { resolve: () => void; reject: (e: Error) => void };

  constructor(options: AgentLoopOptions) {
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.tools = options.tools ?? new ToolRegistry();
    this.toolChoice = options.toolChoice;
    this.maxTurns = options.maxTurns ?? 40;
    this.maxTokens = options.maxTokens ?? 8000;
    this.retryPolicy = (options.retryPolicy ?? DEFAULT_RETRY_POLICY).clone();
    this.windowManager = options.windowManager;
    this.memoryStore = options.memoryStore;
    this.skillLoader = options.skillLoader;
    this.hookPipeline = new HookPipeline();
    this.userHooks = options.hooks ?? {};

    // 添加初始 system prompt
    this.messages.push({ role: 'system', content: this.systemPrompt });
  }

  getHookPipeline(): HookPipeline {
    return this.hookPipeline;
  }

  /** 暴露 LLMProvider，供 SubAgentPool 等子组件使用 */
  getLLMProvider(): LLMProvider {
    return this.llm;
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  getTurn(): number {
    return this.turn;
  }

  /** 主入口：运行 Agent 循环 */
  async *run(input: string): AsyncGenerator<AgentEvent> {
    this.running = true;
    this.paused = false;
    this.messages.push({ role: 'user', content: input });

    while (this.running && this.turn < this.maxTurns) {
      // 暂停检查
      if (this.paused) {
        yield { kind: 'text', content: '[Agent paused]' };
        await new Promise<void>((resolve, reject) => {
          this.resumePromise = { resolve, reject };
        });
        this.resumePromise = undefined;
        this.paused = false;
        yield { kind: 'text', content: '[Agent resumed]' };
      }

      this.turn++;

      // ---- beforeTurn hook ----
      this.userHooks.onTurnStart?.(this.turn);
      const turnCtx: TurnContext = { turn: this.turn, messages: this.messages };
      await this.hookPipeline.run('beforeTurn', turnCtx);

      // ---- 上下文管理 ----
      let activeMessages = this.messages;

      // 窗口压缩
      if (this.windowManager) {
        activeMessages = await this.windowManager.compress(activeMessages);
      }

      // 记忆注入
      let memorySnippet = '';
      if (this.memoryStore) {
        const latestContext = this.messages.slice(-4)
          .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          .join('\n');
        const memories = await this.memoryStore.retrieve(latestContext || input);
        if (memories.length > 0) {
          memorySnippet = '\nRelevant memories:\n' + memories.map(m => `- ${m.content}`).join('\n');
        }
      }

      // 技能目录注入
      let skillsSnippet = '';
      if (this.skillLoader) {
        const catalog = this.skillLoader.renderCatalog();
        if (catalog) {
          skillsSnippet = '\nAvailable skills:\n' + catalog + '\nUse load_skill(name) when relevant.';
        }
      }

      // 构造 system prompt
      const effectiveSystem = this.systemPrompt + memorySnippet + skillsSnippet;
      if (activeMessages[0]?.role === 'system') {
        activeMessages = [{ role: 'system', content: effectiveSystem }, ...activeMessages.slice(1)];
      } else {
        activeMessages = [{ role: 'system', content: effectiveSystem }, ...activeMessages];
      }

      // 获取工具 schemas
      const tools = this.tools.getSchemas() as ToolDef[];

      // ---- LLM 调用 ----
      let response: Awaited<ReturnType<typeof this.callLLM>>;
      try {
        await this.hookPipeline.run('beforeLLM', { messages: activeMessages, turn: this.turn });
        response = await this.callLLM(activeMessages, tools);
        await this.hookPipeline.run('afterLLM', {
          response: { content: response.content, tool_calls: response.tool_calls ?? [] },
          turn: this.turn,
        });
      } catch (err) {
        const ae = AgentError.from(err);
        yield { kind: 'error', severity: ae.retryable ? 'warn' : 'fatal', message: ae.message };

        if (ae.severity === 'context_overflow' && this.windowManager) {
          // 上下文溢出时的紧急压缩
          activeMessages = activeMessages.slice(-10);
          continue;
        }

        const errCtx: ErrorContext = { error: ae, turn: this.turn };
        await this.hookPipeline.run('onError', errCtx);

        if (!ae.retryable) break;
        continue;
      }

      // ---- 处理响应 ----
      yield { kind: 'text', content: response.content };

      // 无 tool_call → 结束
      if (!response.tool_calls || response.tool_calls.length === 0) {
        this.messages.push({ role: 'assistant', content: response.content });

        // 统计实际 tool_use 调用次数
        let totalCalls = 0;
        for (const m of this.messages) {
          if (m.role === 'assistant' && Array.isArray(m.content)) {
            totalCalls += m.content.filter(b => (b as { type?: string }).type === 'tool_use').length;
          }
        }
        await this.hookPipeline.run('onStop', { turn: this.turn, totalToolCalls: totalCalls, reason: 'no_tool_use' } as StopContext);

        this.running = false;
        yield { kind: 'done', result: response.content };
        return;
      }

      // ---- 执行工具调用 ----
      let toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
      let errorCount = 0;

      for (const tc of response.tool_calls) {
        const toolId = tc.id;
        const parsedArgs = this.parseToolArgs(tc.function.arguments);
        yield { kind: 'tool_call', id: toolId, name: tc.function.name, args: parsedArgs };

        // beforeTool hook
        const beforeCtx: BeforeToolContext = {
          toolName: tc.function.name,
          args: parsedArgs,
          registration: this.tools.get(tc.function.name),
        };
        const hookResult = await this.hookPipeline.run('beforeTool', beforeCtx);
        if (hookResult) {
          yield { kind: 'tool_result', id: toolId, status: 'error', content: hookResult.reason };
          toolResults.push({ tool_use_id: toolId, content: hookResult.reason });
          continue;
        }

        // 执行工具
        let result: ToolResult;
        try {
          result = await withRetry(
            () => this.tools.execute(tc.function.name, parsedArgs),
            this.retryPolicy
          );
        } catch (err) {
          errorCount++;
          const errMsg = String(err);
          yield { kind: 'tool_result', id: toolId, status: 'error', content: errMsg };
          toolResults.push({ tool_use_id: toolId, content: `Error: ${errMsg}`, is_error: true });
          continue;
        }

        // afterTool hook
        const afterCtx: AfterToolContext = {
          toolName: tc.function.name,
          args: parsedArgs,
          result: result.data,
        };
        await this.hookPipeline.run('afterTool', afterCtx);

        const status = result.success ? 'done' : 'error';
        if (!result.success) errorCount++;
        yield { kind: 'tool_result', id: toolId, status, content: result.data ?? result.error };

        const dataStr = typeof result.data === 'object' ? JSON.stringify(result.data) : String(result.data ?? '');
        toolResults.push({ tool_use_id: toolId, content: dataStr, is_error: !result.success });
      }

      // 追加 assistant 消息和 tool_results
      const assistantBlock = {
        type: 'text' as const,
        text: response.content,
      };
      const toolUseBlocks = response.tool_calls.map(tc => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.function.name,
        input: tc.function.arguments,
      }));
      this.messages.push({
        role: 'assistant',
        content: [assistantBlock, ...toolUseBlocks],
        tool_results: toolResults,
      });

      // 将 tool_results 也作为 user 消息追加（LLM 协议格式）
      const resultBlocks = toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.tool_use_id,
        content: tr.content,
      }));
      this.messages.push({ role: 'user', content: resultBlocks });

      // ---- afterTurn hook ----
      const stats = { toolCalls: response.tool_calls.length, errors: errorCount };
      this.userHooks.onTurnEnd?.(this.turn, stats);
      await this.hookPipeline.run('afterTurn', turnCtx);
    }

    // max turns 到达
    this.running = false;
    yield { kind: 'done', result: 'MAX_TURNS_EXCEEDED' };
  }

  private parseToolArgs(args: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private async callLLM(messages: Message[], tools: ToolDef[]) {
    let collectedContent = '';
    const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

    const options: ChatOptions = {};
    if (this.toolChoice) options.toolChoice = this.toolChoice;

    const eventGen = this.llm.chat(messages, tools, options);

    for await (const event of eventGen) {
      switch (event.kind) {
        case 'text':
          collectedContent += event.delta;
          this.userHooks.onToken?.(event.delta);
          break;
        case 'thinking':
          // 可扩展：yield thinking 事件
          break;
        case 'response':
          if (event.response.tool_calls) {
            toolCalls.push(...event.response.tool_calls);
          }
          return {
            content: collectedContent || event.response.content,
            tool_calls: toolCalls.length > 0 ? toolCalls : event.response.tool_calls,
            stop_reason: event.response.stop_reason,
          };
        case 'error':
          throw new Error(event.message);
      }
    }

    return { content: collectedContent, tool_calls: toolCalls, stop_reason: 'end_turn' as const };
  }

  /** 暂停循环 */
  pause(): void {
    this.paused = true;
  }

  /** 恢复循环 */
  resume(): void {
    this.paused = false;
    if (this.resumePromise) {
      this.resumePromise.resolve();
    }
  }

  /** 停止循环 */
  stop(): void {
    this.running = false;
    if (this.resumePromise) {
      this.resumePromise.resolve();
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}
