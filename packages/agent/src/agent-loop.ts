import { LLMResponse, Message } from '@orion/types';

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

function getPrettyJson(data: unknown): string {
  if (data && typeof data === 'object' && 'script' in data) {
    const copy = { ...data } as Record<string, unknown>;
    copy.script = String(copy.script).replace(/; /g, ';\n  ');
    return JSON.stringify(copy, null, 2).replace(/\\n/g, '\n');
  }
  return JSON.stringify(data, null, 2);
}

function compactToolArgs(name: string, args: Record<string, unknown>): string {
  const a = { ...args };
  delete a._index;
  if ('path' in a) a.path = String(a.path).split('/').pop() || String(a.path);
  if (name === 'update_working_checkpoint') {
    const s = String(a.key_info ?? '');
    return s.length > 60 ? `${s.slice(0, 60)}...` : s;
  }
  if (name === 'ask_user') {
    const q = String(a.question ?? '');
    const cs = (a.candidates as string[]) ?? [];
    if (cs.length) return `${q}\ncandidates:\n${cs.map((c) => `- ${c}`).join('\n')}`;
    return q;
  }
  const s = JSON.stringify(a, null, 0);
  return s.length > 120 ? `${s.slice(0, 120)}...` : s;
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
  client: { chat(options: { messages: Message[]; tools?: unknown[] }): AsyncGenerator<string, LLMResponse, unknown> },
  systemPrompt: string,
  userInput: string,
  handler: BaseHandler,
  toolsSchema: unknown[],
  maxTurns = 40,
  verbose = true,
  initialUserContent?: string
): AsyncGenerator<string, { result: string; data?: unknown }, unknown> {
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
    const turnStr = `**LLM Running (Turn ${turn}) ...**`;
    yield `\n\n${turnStr}\n\n`;

    const responseGen = client.chat({ messages, tools: toolsSchema });
    let response: LLMResponse | undefined;
    if (verbose) {
      const iterator = responseGen[Symbol.asyncIterator]();
      while (true) {
        const { done, value } = await iterator.next();
        if (done) {
          response = value;
          break;
        }
        if (typeof value === 'string') {
          yield value;
        } else {
          response = value;
        }
      }
      yield '\n\n';
    } else {
      response = await exhaust(responseGen);
      const cleaned = cleanContent(response.content);
      if (cleaned) yield cleaned + '\n';
    }
    if (!response) response = { content: '', thinking: '', tool_calls: [], raw: '', stop_reason: 'end_turn' };

    const toolCalls = response.tool_calls?.length
      ? response.tool_calls.map((tc) => ({
          tool_name: tc.function.name,
          args: parseToolArgs(tc.function.arguments),
          id: tc.id,
        }))
      : [{ tool_name: 'no_tool', args: {}, id: '' }];

    const toolResults: Array<{ tool_use_id: string; content: string }> = [];
    const nextPrompts = new Set<string>();
    let exitReason: { result: string; data?: unknown } | null = null;

    for (let ii = 0; ii < toolCalls.length; ii++) {
      const tc = toolCalls[ii];
      if (tc.tool_name === 'no_tool') {
        // nothing
      } else {
        if (verbose) {
          yield `🛠️ Tool: \`${tc.tool_name}\`  📥 args:\n\`\`\`\`text\n${getPrettyJson(tc.args)}\n\`\`\`\`\n`;
        } else {
          yield `🛠️ ${tc.tool_name}(${compactToolArgs(tc.tool_name, tc.args)})\n\n\n`;
        }
      }

      const gen = handler.dispatch(tc.tool_name, tc.args, response);
      try {
        const iterator = gen[Symbol.asyncIterator]();
        let result: IteratorResult<string, StepOutcome>;
        do {
          result = await iterator.next();
          if (!result.done && verbose) yield result.value;
        } while (!result.done);
        const outcome = result.value;

        if (outcome.shouldExit) {
          exitReason = { result: 'EXITED', data: outcome.data };
          break;
        }
        if (outcome.nextPrompt === null || outcome.nextPrompt === undefined) {
          exitReason = { result: 'CURRENT_TASK_DONE', data: outcome.data };
          break;
        }
        if (outcome.nextPrompt.startsWith('Unknown tool')) {
          // reset tools hint
        }
        if (outcome.data !== null && tc.tool_name !== 'no_tool') {
          const dataStr =
            typeof outcome.data === 'object'
              ? JSON.stringify(outcome.data, null, 0)
              : String(outcome.data);
          toolResults.push({ tool_use_id: tc.id || '', content: dataStr });
        }
        nextPrompts.add(outcome.nextPrompt);
      } catch (e) {
        const err = `Tool ${tc.tool_name} error: ${e instanceof Error ? e.message : String(e)}`;
        yield err + '\n';
        nextPrompts.add(err);
      }
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

async function exhaust<T, R>(gen: AsyncGenerator<T, R, unknown>): Promise<R> {
  let last: R | undefined;
  const iterator = gen[Symbol.asyncIterator]();
  while (true) {
    const { done, value } = await iterator.next();
    if (done) {
      last = value;
      break;
    }
  }
  return last!;
}

function cleanContent(text: string): string {
  if (!text) return '';
  function shrinkCode(match: string): string {
    const lines = match.split('\n');
    const lang = lines[0].replace(/```/, '').trim();
    const body = lines.slice(1, -1).filter((l) => l.trim());
    if (body.length <= 6) return match;
    return `\`\`\`${lang}\n${body.slice(0, 5).join('\n')}\n  ... (${body.length} lines)\n\`\`\``;
  }
  text = text.replace(/```[\s\S]*?```/g, shrinkCode);
  for (const p of [
    /<file_content>[\s\S]*?<\/file_content>/g,
    /<tool_(?:use|call)>[\s\S]*?<\/tool_(?:use|call)>/g,
    /(\r?\n){3,}/g,
  ]) {
    text = text.replace(p, '\n\n');
  }
  return text.trim();
}
