/** Opt-in Langfuse tracing plugin.
 *  Self-activates on import if `langfuse_config` exists in .env or mykey.json.
 *  Hooks into core via the public hook registries.
 */
import { BaseHandler, agentLoopHooks } from '@orion/agent';
import { llmLogHooks, llmUsageHooks } from '@orion/llm';
import { loadEnvFile, loadMykey } from '@orion/shared';

function findLangfuseConfig(): Record<string, unknown> | undefined {
  const env = loadEnvFile();
  const envCfg = env.LANGFUSE_CONFIG;
  if (envCfg) {
    try {
      return JSON.parse(envCfg) as Record<string, unknown>;
    } catch {
      // fallthrough
    }
  }
  const keys = loadMykey();
  return keys.langfuse_config as Record<string, unknown> | undefined;
}

interface LangfuseLike {
  trace: (args: Record<string, unknown>) => Record<string, (...args: unknown[]) => unknown>;
  generation: (args: Record<string, unknown>) => Record<string, (...args: unknown[]) => unknown>;
  span: (args: Record<string, unknown>) => Record<string, (...args: unknown[]) => unknown>;
  flushAsync: () => Promise<void>;
}

let langfuse: LangfuseLike | null = null;
let active = false;

const genStack: Array<{ observation: Record<string, (...args: unknown[]) => unknown>; usage?: Record<string, number> }> = [];
const toolStack: Array<Record<string, (...args: unknown[]) => unknown>> = [];
let agentTrace: Record<string, (...args: unknown[]) => unknown> | null = null;

function safeCall(obj: Record<string, (...args: unknown[]) => unknown> | null | undefined, method: string, ...args: unknown[]): void {
  if (!obj) return;
  try {
    const fn = obj[method];
    if (typeof fn === 'function') fn.apply(obj, args);
  } catch {
    // ignore
  }
}

function onLlmLog(label: 'Prompt' | 'Response', content: string): void {
  if (!langfuse) return;
  if (label === 'Prompt') {
    try {
      const gen = langfuse.generation({ name: 'llm.chat', input: content.slice(0, 20000) });
      genStack.push({ observation: gen });
    } catch {
      // ignore
    }
  } else if (label === 'Response') {
    const top = genStack.pop();
    if (!top) return;
    try {
      const out: Record<string, unknown> = { output: content.slice(0, 20000) };
      if (top.usage) out.usageDetails = top.usage;
      safeCall(top.observation, 'update', out);
      safeCall(top.observation, 'end');
    } catch {
      // ignore
    }
  }
}

function onLlmUsage(usage: Record<string, number>): void {
  const top = genStack[genStack.length - 1];
  if (top) top.usage = usage;
}

function onAgentStart(input: { userInput: string }): unknown {
  if (!langfuse) return null;
  try {
    agentTrace = langfuse.trace({ name: 'agent.task', input });
    return agentTrace;
  } catch {
    return null;
  }
}

function onAgentEnd(_ctx: unknown, output: unknown): void {
  if (!agentTrace) return;
  try {
    safeCall(agentTrace, 'update', { output });
  } catch {
    // ignore
  }
  try {
    if (langfuse) langfuse.flushAsync().catch(() => {});
  } catch {
    // ignore
  }
  agentTrace = null;
}

function patchToolCallbacks(): void {
  const proto = BaseHandler.prototype;
  const origBefore = proto.toolBeforeCallback;
  const origAfter = proto.toolAfterCallback;

  proto.toolBeforeCallback = async function (
    toolName: string,
    args: Record<string, unknown>,
    response: unknown
  ): Promise<void> {
    if (langfuse) {
      try {
        const input = Object.fromEntries(Object.entries(args).filter(([k]) => !k.startsWith('_')));
        const sp = langfuse.span({ name: toolName, input });
        toolStack.push(sp);
      } catch {
        // ignore
      }
    }
    return origBefore.call(this, toolName, args, response as any);
  };

  proto.toolAfterCallback = async function (
    toolName: string,
    args: Record<string, unknown>,
    response: unknown,
    ret: { data?: unknown; nextPrompt?: string | null; shouldExit?: boolean }
  ): Promise<void> {
    const sp = toolStack.pop();
    if (sp && langfuse) {
      try {
        safeCall(sp, 'update', {
          output: { data: ret?.data, nextPrompt: ret?.nextPrompt, shouldExit: ret?.shouldExit },
        });
        safeCall(sp, 'end');
      } catch {
        // ignore
      }
    }
    return origAfter.call(this, toolName, args, response as any, ret as any);
  };
}

export async function init(): Promise<void> {
  if (active) return;
  const cfg = findLangfuseConfig();
  if (!cfg) return;

  let LangfuseCtor: new (cfg: Record<string, unknown>) => LangfuseLike;
  try {
    // @ts-ignore optional dependency
    const mod = (await import('langfuse')) as { Langfuse: new (cfg: Record<string, unknown>) => LangfuseLike };
    LangfuseCtor = mod.Langfuse;
  } catch (e) {
    console.log(`[langfuse_tracing] Langfuse SDK not installed or import failed: ${e instanceof Error ? e.message : String(e)}`);
    console.log('[langfuse_tracing] Install with: npm install langfuse');
    return;
  }

  try {
    langfuse = new LangfuseCtor(cfg);
  } catch (e) {
    console.log(`[langfuse_tracing] Failed to initialize Langfuse: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  llmLogHooks.push(onLlmLog);
  llmUsageHooks.push(onLlmUsage);
  agentLoopHooks.push({ onStart: onAgentStart, onEnd: onAgentEnd });
  patchToolCallbacks();
  active = true;
  console.log('[langfuse_tracing] Tracing enabled.');
}

// Self-activate on import if config is present.
init().catch(() => {});
