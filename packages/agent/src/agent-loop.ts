import { AgentYield, LLMResponse, LLMStreamDelta, Message } from '@orion/types';

export interface AgentLoopHook {
  onStart(input: { userInput: string }): unknown;
  onEnd(ctx: unknown, output: unknown): void;
}
export const agentLoopHooks: AgentLoopHook[] = [];

export interface StepOutcomeData {
  data: unknown;
  next_prompt?: string;
  should_exit?: boolean;
}

export class StepOutcome {
  data: unknown;
  nextPrompt: string | null;
  shouldExit: boolean;

  constructor(data: unknown, nextPrompt: string | null = null, shouldExit = false) {
    this.data = data;
    this.nextPrompt = nextPrompt;
    this.shouldExit = shouldExit;
  }
}

export class BaseHandler {
  currentTurn = 0;
  _doneHooks: string[] = [];

  addDoneHook(hook: string): void {
    this._doneHooks.push(hook);
  }

  async toolBeforeCallback(_toolName: string, _args: Record<string, unknown>, _response: LLMResponse): Promise<void> {}
  async toolAfterCallback(_toolName: string, _args: Record<string, unknown>, _response: LLMResponse, _ret: StepOutcome): Promise<void> {}

  async turnEndCallback(
    _response: LLMResponse,
    _toolCalls: Array<{ tool_name: string; args: Record<string, unknown>; id?: string }>,
    _toolResults: Array<{ tool_use_id: string; content: string }>,
    _turn: number,
    nextPrompt: string,
    _exitReason: unknown
  ): Promise<string> {
    return nextPrompt;
  }

  async* dispatch(toolName: string, args: Record<string, unknown>, response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    const methodName = `do_${toolName}` as keyof this;
    if (typeof this[methodName] === 'function') {
      args._index = (args._index as number) ?? 0;
      await this.toolBeforeCallback(toolName, args, response);
      const ret = (this[methodName] as GeneratorFn).call(this, args, response);
      let outcome: StepOutcome;
      if (isAsyncGenerator(ret)) {
        const iterator = ret[Symbol.asyncIterator]();
        let result: IteratorResult<string, StepOutcome>;
        do {
          result = await iterator.next();
          if (!result.done) yield result.value;
        } while (!result.done);
        outcome = result.value;
      } else {
        outcome = ret;
      }
      await this.toolAfterCallback(toolName, args, response, outcome);
      return outcome;
    } else if (toolName === 'bad_json') {
      return new StepOutcome(null, args.msg as string);
    }
    yield `Unknown tool: ${toolName}\n`;
    return new StepOutcome(null, `Unknown tool ${toolName}`);
  }
}

type GeneratorFn = (
  this: BaseHandler,
  args: Record<string, unknown>,
  response: LLMResponse
) => StepOutcome | AsyncGenerator<string, StepOutcome, unknown>;

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator<unknown, unknown, unknown> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as AsyncGenerator<unknown, unknown, unknown>)[Symbol.asyncIterator] === 'function' &&
    typeof (obj as AsyncGenerator<unknown, unknown, unknown>).next === 'function'
  );
}

export async function* agentRunnerLoop(
  client: { chat(options: { messages: Message[]; tools?: unknown[] }): AsyncGenerator<LLMStreamDelta, LLMResponse, unknown> },
  systemPrompt: string,
  userInput: string,
  handler: BaseHandler,
  toolsSchema: unknown[],
  maxTurns = 40,
  initialUserContent?: string
): AsyncGenerator<AgentYield, { result: string; data?: unknown }, unknown> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUserContent ?? userInput },
  ];
  const hookCtxs = agentLoopHooks.map((h) => h.onStart({ userInput }));
  let turn = 0;
  handler.currentTurn = 0;
  let finalExitReason: { result: string; data?: unknown } | null = null;

  while (turn < maxTurns) {
    turn += 1;
    handler.currentTurn = turn;
    let stepSeq = 0;

    const responseGen = client.chat({ messages, tools: toolsSchema });
    let response: LLMResponse | undefined;

    const iterator = responseGen[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await iterator.next();
      if (done) {
        response = value;
        break;
      }
      if (value.kind === 'text') {
        yield { kind: 'text', content: value.delta };
      } else if (value.kind === 'thinking') {
        yield { kind: 'thought', content: value.delta };
      } else if (value.kind === 'error') {
        yield { kind: 'error', message: value.message };
      }
    }

    if (!response) response = { content: '', thinking: '', tool_calls: [], raw: '', stop_reason: 'end_turn' };

    const toolCalls = (response.tool_calls || []).map((tc) => ({
      tool_name: tc.function.name,
      args: parseToolArgs(tc.function.arguments),
      id: tc.id,
    }));
    if (toolCalls.length === 0) {
      toolCalls.push({ tool_name: 'no_tool', args: {}, id: '' });
    }

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];
    const nextPrompts = new Set<string>();
    let exitReason: { result: string; data?: unknown } | null = null;

    for (let ii = 0; ii < toolCalls.length; ii++) {
      const tc = toolCalls[ii];
      if (tc.tool_name !== 'no_tool') {
        if (!tc.id) tc.id = `step-${++stepSeq}`;
        yield { kind: 'tool_call', id: tc.id, turn, toolName: tc.tool_name, args: tc.args };
      }

      const gen = handler.dispatch(tc.tool_name, tc.args, response);
      let outcome: StepOutcome;
      try {
        outcome = await collectHandlerOutcome(gen);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (tc.tool_name !== 'no_tool') {
          yield { kind: 'tool_result', id: tc.id, status: 'error', content: errMsg };
        }
        nextPrompts.add(`Tool ${tc.tool_name} error: ${errMsg}`);
        continue;
      }

      if (outcome.shouldExit) {
        if (tc.tool_name !== 'no_tool') {
          yield { kind: 'tool_result', id: tc.id, status: 'done', content: outcome.data };
        }
        exitReason = { result: 'EXITED', data: outcome.data };
        break;
      }
      if (outcome.nextPrompt === null || outcome.nextPrompt === undefined) {
        if (tc.tool_name !== 'no_tool') {
          yield { kind: 'tool_result', id: tc.id, status: 'done', content: outcome.data };
        }
        exitReason = { result: 'CURRENT_TASK_DONE', data: outcome.data };
        break;
      }
      if (outcome.nextPrompt.startsWith('Unknown tool')) {
        // reset tools hint
      }

      const status: 'done' | 'error' = isErrorOutcome(outcome) ? 'error' : 'done';
      if (tc.tool_name !== 'no_tool') {
        yield { kind: 'tool_result', id: tc.id, status, content: outcome.data };
      }

      if (outcome.data !== null && tc.tool_name !== 'no_tool') {
        const dataStr =
          typeof outcome.data === 'object'
            ? JSON.stringify(outcome.data, null, 0)
            : String(outcome.data);
        toolResults.push({ tool_use_id: tc.id || '', content: dataStr });
      }
      nextPrompts.add(outcome.nextPrompt);
    }

    if (nextPrompts.size === 0 || exitReason) {
      if (exitReason?.result === 'EXITED' || handler._doneHooks.length === 0) {
        finalExitReason = exitReason ?? { result: 'MAX_TURNS_EXCEEDED' };
        break;
      }
      nextPrompts.add(handler._doneHooks.shift()!);
    }

    const nextPrompt = await handler.turnEndCallback(
      response,
      toolCalls,
      toolResults,
      turn,
      Array.from(nextPrompts).join('\n'),
      exitReason
    );
    messages.push({ role: 'user', content: nextPrompt, tool_results: toolResults });
  }

  for (let i = 0; i < agentLoopHooks.length; i++) {
    try {
      agentLoopHooks[i].onEnd(hookCtxs[i], finalExitReason);
    } catch {
      // ignore plugin errors
    }
  }
  return finalExitReason ?? { result: 'MAX_TURNS_EXCEEDED' };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const parts = raw.split(/(?<=\})(?=\{)/);
    if (parts.length > 1) {
      for (const p of parts) {
        try {
          return JSON.parse(p) as Record<string, unknown>;
        } catch {}
      }
    }
    return { _raw: raw };
  }
}

async function collectHandlerOutcome<T>(gen: AsyncGenerator<string, T, unknown>): Promise<T> {
  const iterator = gen[Symbol.asyncIterator]();
  while (true) {
    const { done, value } = await iterator.next();
    if (done) return value;
    // intermediate execution logs are intentionally discarded
  }
}

function isErrorOutcome(outcome: StepOutcome): boolean {
  const data = outcome.data;
  if (data && typeof data === 'object' && 'status' in data && (data as { status?: unknown }).status === 'error') {
    return true;
  }
  if (typeof data === 'string' && /^error[:\s]/i.test(data.trim())) {
    return true;
  }
  return false;
}

