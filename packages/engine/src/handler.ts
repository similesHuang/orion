import fs from 'fs';
import path from 'path';
import { LLMResponse } from './types/index.js';
import { BaseHandler, StepOutcome, isAsyncGenerator } from './agent-loop.js';
import { ToolRegistry } from './tools/registry.js';
import { findProjectRoot, smartFormat, getGlobalMemory } from './shared/index.js';
import { fileRead, consumeFile } from './tools/file-utils.js';

// ---------------------------------------------------------------------------
// HandlerParent
// ---------------------------------------------------------------------------

export interface HandlerParent {
  taskDir?: string;
  verbose?: boolean;
  _turnEndHooks?: Record<string, (ctx: Record<string, unknown>) => void>;
  approveToolCall?: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<'allow' | 'deny'>;
}

/** Thrown by toolBeforeCallback when the user declines a tool call. */
export class ToolDeniedError extends Error {
  constructor(toolName: string) {
    super(`用户拒绝执行工具 ${toolName}`);
    this.name = 'ToolDeniedError';
  }
}

// ---------------------------------------------------------------------------
// OrionAgentHandler
// ---------------------------------------------------------------------------

export class OrionAgentHandler extends BaseHandler {
  parent: HandlerParent;
  registry: ToolRegistry;
  working: Record<string, unknown> = {};
  historyInfo: string[];
  codeStopSignal: number[] = [];

  constructor(
    parent: HandlerParent,
    registry: ToolRegistry,
    lastHistory?: string[],
  ) {
    super();
    this.parent = parent;
    this.registry = registry;
    this.historyInfo = lastHistory ?? [];
  }

  // -----------------------------------------------------------------------
  // Approval gate
  // -----------------------------------------------------------------------

  override async toolBeforeCallback(
    toolName: string,
    args: Record<string, unknown>,
    _response: LLMResponse
  ): Promise<void> {
    const gate = this.parent.approveToolCall;
    if (!gate) return;
    const decision = await gate(toolName, args);
    if (decision === 'deny') throw new ToolDeniedError(toolName);
  }

  // -----------------------------------------------------------------------
  // Plan mode
  // -----------------------------------------------------------------------

  private inPlanMode(): string | undefined {
    return this.working.in_plan_mode as string | undefined;
  }

  private exitPlanMode(): void {
    delete this.working.in_plan_mode;
  }

  enterPlanMode(planPath: string): string {
    this.working.in_plan_mode = planPath;
    console.log(`[Info] Entered plan mode with plan file: ${planPath}`);
    return planPath;
  }

  private checkPlanCompletion(): number | null {
    const p = this.inPlanMode();
    if (!p || !fs.existsSync(p)) return null;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return (content.match(/\[ \]/g) || []).length;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Anchor / fold
  // -----------------------------------------------------------------------

  private getAnchorPrompt(skip = false): string {
    if (skip) return '\n';
    const W = 30;
    const earlier =
      this.historyInfo.length > W
        ? `<earlier_context>\n${this.foldEarlier(this.historyInfo.slice(0, -W)).join('\n')}\n</earlier_context>\n`
        : '';
    const hStr = this.historyInfo.slice(-W).join('\n');
    let prompt = `\n### [WORKING MEMORY]\n${earlier}<history>\n${hStr}\n</history>`;
    prompt += `\nCurrent turn: ${this.currentTurn}\n`;
    if (this.working.key_info) prompt += `\n<key_info>${this.working.key_info}</key_info>`;
    if (this.working.related_sop) prompt += `\n有不清晰的地方请再次读取${this.working.related_sop}`;
    if (this.parent.verbose) console.log(prompt);
    return prompt;
  }

  private foldEarlier(lines: string[]): string[] {
    const FALLBACK = '直接回答了用户问题';
    const parts: string[] = [];
    let cnt = 0;
    let last = '';
    const flush = () => {
      if (cnt) {
        if (last.includes(FALLBACK)) parts.push(`[Agent]（${cnt} turns）`);
        else parts.push(`${last}（${cnt} turns）`);
      }
    };
    for (const line of lines) {
      if (line.startsWith('[USER]')) {
        flush();
        parts.push(line);
        cnt = 0;
        last = '';
      } else {
        cnt += 1;
        last = line;
      }
    }
    flush();
    return parts.slice(-150);
  }

  // -----------------------------------------------------------------------
  // Core agent tools (handled directly, NOT in ToolRegistry)
  // -----------------------------------------------------------------------

  async* do_no_tool(args: Record<string, unknown>, response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    const content = response.content || '';
    const thinking = response.thinking || '';
    if (!content.trim() && !thinking.trim()) {
      const emptyCt = ((this.working._empty_ct as number) || 0) + 1;
      this.working._empty_ct = emptyCt;
      if (emptyCt >= 3) return new StepOutcome({}, null, true);
      yield '[Warn] LLM returned an empty response. Retrying...\n';
      return new StepOutcome({}, '[System] Blank response, regenerate and tooluse');
    }

    if (content.length > 50) {
      const tail = content.slice(-100);
      if (tail.includes('[!!! 流异常中断') || tail.includes('!!!Error:')) {
        return new StepOutcome({}, '[System] Incomplete response. Regenerate and tooluse.');
      }
      if (tail.includes('max_tokens !!!]')) {
        return new StepOutcome({}, '[System] max_tokens limit reached. Use multi small steps to do it.');
      }
    }

    if (this.inPlanMode() && /任务完成|全部完成|已完成所有|🏁/.test(content)) {
      if (!content.includes('VERDICT') && !content.includes('[VERIFY]') && !content.includes('验证subagent')) {
        yield '[Warn] Plan模式完成声明拦截。\n';
        return new StepOutcome(
          {},
          '⛔ [验证拦截] 检测到你在plan模式下声称完成，但未执行[VERIFY]验证步骤。请先按plan_sop §四启动验证subagent，获得VERDICT后才能声称完成。'
        );
      }
    }

    const codeBlockPattern = /```[a-zA-Z0-9_]*\n[\s\S]{50,}?```/g;
    const blocks = content.match(codeBlockPattern) || [];
    if (blocks.length === 1) {
      const m = content.match(codeBlockPattern);
      if (m) {
        const afterBlock = content.slice(m.index! + m[0].length);
        if (!afterBlock.trim()) {
          let residual = content.replace(m[0], '');
          const cleanResidual = residual.replace(/\s+/g, '');
          if (cleanResidual.length <= 30) {
            yield '[Info] Detected large code block without tool call and no extra natural language. Requesting clarification.\n';
            return new StepOutcome(
              {},
              '[System] 检测到你在上一轮回复中主要内容是较大代码块，且本轮未调用任何工具。' +
                '如果这些代码需要执行、写入文件或进一步分析，请重新组织回复并显式调用相应工具' +
                '（例如：code_run、file_write、file_patch 等）；\n' +
                '如果只是向用户展示或讲解代码片段，请在回复中补充自然语言说明，' +
                '并明确是否还需要额外的实际操作。'
            );
          }
        }
      }
    }

    if (this.inPlanMode()) {
      const remaining = this.checkPlanCompletion();
      if (remaining === 0) {
        this.exitPlanMode();
        yield '[Info] Plan完成：plan.md中0个[ ]残留，退出plan模式。\n';
      }
    }

    yield '[Info] Final response to user.\n';
    return new StepOutcome(response, null);
  }

  async* do_update_working_checkpoint(args: Record<string, unknown>, _response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    if (args.key_info !== undefined) this.working.key_info = args.key_info;
    if (args.related_sop !== undefined) this.working.related_sop = args.related_sop;
    this.working.passed_sessions = 0;
    yield '[Info] Updated key_info and related_sop.\n';
    return new StepOutcome({ result: 'working key_info updated' }, this.getAnchorPrompt(!!args._index));
  }

  async* do_start_long_term_update(_args: Record<string, unknown>): AsyncGenerator<string, StepOutcome, unknown> {
    const prompt =
      `### [总结提炼经验] 既然你觉得当前任务有重要信息需要记忆，请提取最近一次任务中【事实验证成功且长期有效】的环境事实、用户偏好、重要步骤，更新记忆。\n` +
      `本工具是标记开启结算过程，若已在更新记忆过程或没有值得记忆的点，忽略本次调用。\n` +
      `**如果没有经验证的，未来能用上的信息，忽略本次调用！**\n` +
      `**只能提取行动验证成功的信息**：\n` +
      `- **环境事实**（路径/凭证/配置）→ \`file_patch\` 更新 L2，同步 L1\n` +
      `- **复杂任务经验**（关键坑点/前置条件/重要步骤）→ L3 精简 SOP（只记你被坑得多次重试的核心要点）\n` +
      `**禁止**：临时变量、具体推理过程、未验证信息、通用常识、你可以轻松复现的细节、只是做了但没有验证的信息\n` +
      `**操作**：严格遵循提供的L0的记忆更新SOP。先 \`file_read\` 看现有 → 判断类型 → 最小化更新 → 无新内容跳过，保证对记忆库最小局部修改。\n\n` +
      getGlobalMemory();
    yield '[Info] Start distilling good memory for long-term storage.\n';
    const sopPath = './memory/memory_management_sop.md';
    const projectRoot = findProjectRoot();
    const result = fs.existsSync(path.resolve(projectRoot, sopPath))
      ? 'This is L0:\n' + fileRead(sopPath, 1, undefined, 200, false, projectRoot)
      : 'Memory Management SOP not found. Do not update memory.';
    return new StepOutcome(result, prompt);
  }

  // -----------------------------------------------------------------------
  // dispatch — routes to core tools or delegates to ToolRegistry
  // -----------------------------------------------------------------------

  override async* dispatch(
    toolName: string,
    args: Record<string, unknown>,
    response: LLMResponse
  ): AsyncGenerator<string, StepOutcome, unknown> {
    // Core agent tools — handled directly
    if (toolName === 'no_tool') return yield* this.do_no_tool(args, response);
    if (toolName === 'update_working_checkpoint') return yield* this.do_update_working_checkpoint(args, response);
    if (toolName === 'start_long_term_update') return yield* this.do_start_long_term_update(args);
    if (toolName === 'bad_json') return new StepOutcome(null, args.msg as string);

    // Delegate to ToolRegistry
    const registration = this.registry.get(toolName);
    if (!registration) {
      yield `Unknown tool: ${toolName}\n`;
      return new StepOutcome(null, `Unknown tool ${toolName}`);
    }

    await this.toolBeforeCallback(toolName, args, response);
    const gen = registration.handler(args);
    let outcome: StepOutcome;
    if (isAsyncGenerator(gen)) {
      const iterator = gen[Symbol.asyncIterator]();
      let result: IteratorResult<string, StepOutcome>;
      do {
        result = await iterator.next();
        if (!result.done) yield result.value;
      } while (!result.done);
      outcome = result.value;
    } else {
      outcome = await gen;
    }
    await this.toolAfterCallback(toolName, args, response, outcome);
    return outcome;
  }

  // -----------------------------------------------------------------------
  // turnEndCallback
  // -----------------------------------------------------------------------

  async turnEndCallback(
    response: LLMResponse,
    toolCalls: Array<{ tool_name: string; args: Record<string, unknown>; id?: string }>,
    _toolResults: Array<{ tool_use_id: string; content: string }>,
    turn: number,
    nextPrompt: string,
    _exitReason: unknown
  ): Promise<string> {
    const stripped = response.content.replace(/```[\s\S]*?```/gs, '').trim();
    const tc = toolCalls[0];
    const cleanArgs = Object.fromEntries(Object.entries(tc.args).filter(([k]) => !k.startsWith('_')));
    let summary: string;
    if (tc.tool_name === 'no_tool') {
      summary = stripped.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '直接回答了用户问题';
    } else {
      summary = `调用工具${tc.tool_name}, args: ${JSON.stringify(cleanArgs)}`;
    }
    summary = smartFormat(summary.replace(/\n/g, ''), 80);
    this.historyInfo.push(`[Agent] ${summary}`);

    const planPath = this.inPlanMode();
    if (turn % 65 === 0 && !planPath) {
      nextPrompt += `\n\n[DANGER] 已连续执行第 ${turn} 轮。必须总结情况进行ask_user，不允许继续重试。`;
    } else if (turn % 7 === 0) {
      nextPrompt += `\n\n[DANGER] 已连续执行第 ${turn} 轮。禁止无效重试。若无有效进展，必须切换策略：1. 探测物理边界 2. 请求用户协助。如有需要，可调用 update_working_checkpoint 保存关键上下文。`;
    } else if (turn % 10 === 0) {
      nextPrompt += getGlobalMemory();
    }

    if (planPath && turn >= 10 && turn % 5 === 0) {
      nextPrompt = `[Plan Hint] 正在计划模式。必须 file_read(${planPath}) 确认当前步骤，回复开头引用：📌 当前步骤：...\n\n` + nextPrompt;
    }
    if (planPath && turn >= 90) {
      nextPrompt += `\n\n[DANGER] Plan模式已运行 ${turn} 轮，已达上限。必须 ask_user 汇报进度并确认是否继续。`;
    }

    const injKeyInfo = consumeFile(this.parent.taskDir, '_keyinfo');
    const injPrompt = consumeFile(this.parent.taskDir, '_intervene');
    if (injKeyInfo) this.working.key_info = String(this.working.key_info || '') + `\n[MASTER] ${injKeyInfo}`;
    if (injPrompt) nextPrompt += `\n\n[MASTER] ${injPrompt}\n`;

    for (const hook of Object.values(this.parent._turnEndHooks || {})) {
      hook({ response, toolCalls, _toolResults, turn, nextPrompt, _exitReason, handler: this });
    }

    return nextPrompt;
  }
}
