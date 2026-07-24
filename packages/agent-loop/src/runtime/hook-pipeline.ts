import type { ToolRegistration } from '../core/tool-registry.js';

// ── HookPhase ──
export type HookPhase =
  | 'beforeTurn' | 'afterTurn'
  | 'beforeTool' | 'afterTool'
  | 'beforeLLM' | 'afterLLM'
  | 'onError' | 'onStop';

// ── 上下文类型 ──
export interface BeforeToolContext {
  toolName: string;
  args: Record<string, unknown>;
  registration?: ToolRegistration;
}

export interface AfterToolContext {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface TurnContext {
  turn: number;
  messages: unknown[];
}

export interface ErrorContext {
  error: Error;
  turn: number;
}

export interface StopContext {
  turn: number;
  totalToolCalls: number;
  reason: string;
}

export interface BeforeLLMContext {
  messages: unknown[];
  turn: number;
}

export interface AfterLLMContext {
  response: { content: string; tool_calls: unknown[] };
  turn: number;
}

export type HookContext =
  | BeforeToolContext
  | AfterToolContext
  | TurnContext
  | ErrorContext
  | StopContext
  | BeforeLLMContext
  | AfterLLMContext;

// ── HookResult ──
export type HookResult = { denied: true; reason: string } | null;

// ── HookHandler ──
export type HookHandler = (context: HookContext) => HookResult | Promise<HookResult>;

// ── HookPipeline ──
export class HookPipeline {
  private handlers = new Map<HookPhase, HookHandler[]>();

  register(phase: HookPhase, handler: HookHandler): void {
    const list = this.handlers.get(phase);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(phase, [handler]);
    }
  }

  unregister(phase: HookPhase, handler: HookHandler): void {
    const list = this.handlers.get(phase);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** 串联执行所有 handler，任一返回非 null 则阻断 */
  async run<T extends HookContext>(phase: HookPhase, context: T): Promise<HookResult> {
    const list = this.handlers.get(phase);
    if (!list) return null;
    for (const handler of list) {
      const result = await handler(context);
      if (result !== null) return result;
    }
    return null;
  }

  /** 清除指定阶段的所有 handler */
  clear(phase?: HookPhase): void {
    if (phase) {
      this.handlers.delete(phase);
    } else {
      this.handlers.clear();
    }
  }

  /** 获取指定阶段的 handler 数量 */
  count(phase: HookPhase): number {
    return this.handlers.get(phase)?.length ?? 0;
  }
}
