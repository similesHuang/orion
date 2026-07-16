import fs from 'fs';
import path from 'path';
import { LLMResponse } from '@orion/types';
import { findProjectRoot, resolveAllowedPath } from '@orion/shared';
import {
  codeRun,
  consumeFile,
  expandFileRefs,
  extractCodeBlock,
  extractRobustContent,
  filePatch,
  fileRead,
  fileWrite,
  formatError,
  getGlobalMemory,
  smartFormat,
  webExecuteJs,
  webNavigate,
  webScan,
} from '@orion/tools';
import { runInlineSandbox } from './inline-sandbox.js';
import { BaseHandler, StepOutcome } from './agent-loop.js';

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

export class GenericAgentHandler extends BaseHandler {
  parent: HandlerParent;
  working: Record<string, unknown> = {};
  cwd: string;
  historyInfo: string[];
  codeStopSignal: number[] = [];

  constructor(parent: HandlerParent, lastHistory: string[] = [], cwd = './temp') {
    super();
    this.parent = parent;
    this.cwd = cwd;
    this.historyInfo = lastHistory;
  }

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

  private getAbsPath(p: string): string {
    if (!p) return '';
    return resolveAllowedPath(this.cwd, p);
  }

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

  async* do_code_run(args: Record<string, unknown>, response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    const codeType = (args.type as string) || 'python';
    let code: string | null = (args.code as string) || (args.script as string);
    if (!code) {
      code = extractCodeBlock(response, codeType);
      if (!code) {
        return new StepOutcome('[Error] Code missing. Must use reply code block or script arg.', '\n');
      }
    }
    const timeout = parseInt(String(args.timeout ?? 60), 10) || 60;
    const rawPath = path.join(this.cwd, String(args.cwd || './'));
    const cwd = path.normalize(path.resolve(rawPath));
    const codeCwd = path.normalize(this.cwd);

    if (codeType === 'python' && args.inline_eval) {
      // SECURITY: inline_eval is now executed in a separate child_process sandbox
      // without access to the agent handler or parent context. Code can only return
      // a value via the `_r` variable. This prevents LLM-generated code from
      // accessing the filesystem, network, or environment of the main process.
      const result = await runInlineSandbox(code, timeout * 1000, cwd);
      if (result.error) {
        return new StepOutcome(`Error: ${result.error}`, this.getAnchorPrompt(!!args._index));
      }
      return new StepOutcome(result.result, this.getAnchorPrompt(!!args._index));
    }

    const result = yield* codeRun(code, codeType, timeout, cwd, codeCwd, this.codeStopSignal);
    return new StepOutcome(result, this.getAnchorPrompt(!!args._index));
  }

  async* do_ask_user(args: Record<string, unknown>, _response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    const question = (args.question as string) || '请提供输入：';
    const candidates = (args.candidates as string[]) || [];
    const result = { status: 'INTERRUPT', intent: 'HUMAN_INTERVENTION', data: { question, candidates } };
    yield 'Waiting for your answer ...\n';
    return new StepOutcome(result, '', true);
  }

  async* do_file_patch(args: Record<string, unknown>, _response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    const filePath = String(args.path || '');
    yield `[Action] Patching file: ${path.basename(filePath)}\n`;
    const oldContent = String(args.old_content || '');
    let newContent = String(args.new_content || '');
    try {
      newContent = expandFileRefs(newContent, this.cwd);
    } catch (e) {
      yield `[Status] ❌ 引用展开失败: ${formatError(e)}\n`;
      return new StepOutcome({ status: 'error', msg: formatError(e) }, '\n');
    }
    const result = filePatch(filePath, oldContent, newContent, this.cwd);
    yield `\n${JSON.stringify(result)}\n`;
    return new StepOutcome(result, this.getAnchorPrompt(!!args._index));
  }

  async* do_file_write(args: Record<string, unknown>, response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    const filePath = String(args.path || '');
    const mode = (args.mode as string) || 'overwrite';
    const actionStr = { prepend: 'Prepending to', append: 'Appending to' }[mode] || 'Overwriting';
    yield `[Action] ${actionStr} file: ${path.basename(filePath)}\n`;

    let content = (args.content as string) || extractRobustContent(response.content);
    if (!content) {
      yield `[Status] ❌ 失败: 未提供文件内容（请通过 content 参数或代码块传入）\n`;
      return new StepOutcome(
        {
          status: 'error',
          msg: 'No content found. Provide content via the content argument or a fenced code block.',
        },
        '\n'
      );
    }
    try {
      content = expandFileRefs(content, this.cwd);
      const result = fileWrite(filePath, content, mode, this.cwd);
      yield `[Status] ✅ ${mode.charAt(0).toUpperCase() + mode.slice(1)} 成功 (${content.length} bytes)\n`;
      return new StepOutcome(result, this.getAnchorPrompt(!!args._index));
    } catch (e) {
      yield `[Status] ❌ 写入异常: ${formatError(e)}\n`;
      return new StepOutcome({ status: 'error', msg: formatError(e) }, '\n');
    }
  }

  async* do_file_read(args: Record<string, unknown>): AsyncGenerator<string, StepOutcome, unknown> {
    const filePath = String(args.path || '');
    const resolvedPath = this.getAbsPath(filePath);
    yield `\n[Action] Reading file: ${resolvedPath}\n`;
    const start = parseInt(String(args.start ?? 1), 10);
    const count = parseInt(String(args.count ?? 200), 10);
    const keyword = args.keyword as string | undefined;
    const showLinenos = args.show_linenos !== false;
    let result = fileRead(filePath, start, keyword, count, showLinenos, this.cwd);
    if (result.includes(' ... [TRUNCATED]')) {
      result += '\n\n（某些行被截断，如需完整内容可改用 code_run 读取）';
    }
    result = smartFormat(result, 20000, '\n\n[omitted long content]\n\n');
    let nextPrompt = this.getAnchorPrompt(!!args._index);
    if (resolvedPath.includes('memory') || resolvedPath.includes('sop')) {
      nextPrompt +=
        '\n[SYSTEM TIPS] 正在读取记忆或SOP文件，若决定按sop执行请提取sop中的关键点（特别是靠后的）update working memory.';
    }
    return new StepOutcome(result, nextPrompt);
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
    const projectRoot = findProjectRoot(this.cwd);
    const result = fs.existsSync(path.resolve(projectRoot, sopPath))
      ? 'This is L0:\n' + fileRead(sopPath, 1, undefined, 200, false, projectRoot)
      : 'Memory Management SOP not found. Do not update memory.';
    return new StepOutcome(result, prompt);
  }

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

    const codeBlockPattern = /```[a-zA-Z0-9_]*\n[\s\S]{50,}?```/;
    const blocks = content.match(new RegExp(codeBlockPattern, 'g')) || [];
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

  async* do_web_scan(args: Record<string, unknown>, _response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    yield '[Action] Scanning web page...\n';
    const result = await webScan({
      tabs_only: args.tabs_only === true,
      switch_tab_id: args.switch_tab_id as string | undefined,
      text_only: args.text_only === true,
      max_chars: args.max_chars ? parseInt(String(args.max_chars), 10) : undefined,
    });
    const content = result.content;
    const metadata = {
      status: result.status,
      metadata: {
        tabs_count: result.tabs.length,
        tabs: result.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        active_tab: result.current_tab,
      },
    };
    let output: string;
    if (result.status !== 'success') {
      output = `Error: ${result.content}`;
    } else {
      const metaJson = JSON.stringify(metadata, null, 2);
      const shownContent = args.text_only === true ? smartFormat(content, 10000, '\n\n[omitted long content]\n\n') : content;
      output = `${metaJson}\n\n\`\`\`html\n${shownContent}\n\`\`\``;
    }
    yield `${output}\n`;
    return new StepOutcome(smartFormat(output, 8000), this.getAnchorPrompt(!!args._index));
  }

  async* do_web_navigate(args: Record<string, unknown>): AsyncGenerator<string, StepOutcome, unknown> {
    const url = String(args.url || '');
    if (!url) {
      return new StepOutcome({ status: 'error', error: 'No URL provided.' }, '\n');
    }
    yield `[Action] Navigating to: ${url}\n`;
    const result = await webNavigate({
      url,
      switch_tab_id: args.switch_tab_id as string | undefined,
      new_tab: args.new_tab === true,
    });
    const summary = result.status === 'success' ? `Loaded: ${result.url} (${result.title})` : `Error: ${result.error}`;
    yield `${summary}\n`;
    return new StepOutcome(result, this.getAnchorPrompt(!!args._index));
  }

  async* do_web_execute_js(args: Record<string, unknown>, response: LLMResponse): AsyncGenerator<string, StepOutcome, unknown> {
    let script = (args.script as string) || '';
    if (!script) {
      const codeBlock = response.content.match(/```(?:javascript|js)\n([\s\S]*?)\n```/);
      script = codeBlock ? codeBlock[1].trim() : '';
    }
    if (!script) {
      return new StepOutcome({ status: 'error', error: 'No script provided.' }, '\n');
    }
    const absPath = this.getAbsPath(script.trim());
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      script = fs.readFileSync(absPath, 'utf-8');
    }
    yield '[Action] Executing JS in browser...\n';
    const result = await webExecuteJs({
      script,
      save_to_file: args.save_to_file as string | undefined,
      switch_tab_id: args.switch_tab_id as string | undefined,
      no_monitor: args.no_monitor === true,
    });
    if (args.save_to_file && result.js_return !== undefined) {
      const content = String(result.js_return ?? '');
      const outPath = this.getAbsPath(String(args.save_to_file));
      result.js_return = smartFormat(content, 170);
      try {
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(outPath, content, 'utf-8');
        result.js_return += `\n\n[已保存完整内容到 ${outPath}]`;
      } catch {
        result.js_return += `\n\n[保存失败，无法写入文件 ${outPath}]`;
      }
    }
    const show = smartFormat(JSON.stringify(result, null, 2), 300);
    console.log('Web Execute JS Result:', show);
    yield `JS 执行结果:\n${show}\n`;
    return new StepOutcome(smartFormat(JSON.stringify(result), 8000), this.getAnchorPrompt(!!args._index));
  }

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
