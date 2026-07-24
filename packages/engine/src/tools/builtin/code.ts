import path from 'path';
import { codeRun, extractCodeBlock } from '../../compat.js';
import { runInlineSandbox } from '../../inline-sandbox.js';
import { ToolRegistry } from '../registry.js';
import { LLMResponse } from '../../types/index.js';
import { StepOutcome } from '../../agent-loop.js';

// ---------------------------------------------------------------------------
// do_code_run
// ---------------------------------------------------------------------------

async function* do_code_run(
  args: Record<string, unknown>,
  response: LLMResponse,
  cwd: string,
  stopSignal: number[],
): AsyncGenerator<string, StepOutcome, unknown> {
  const codeType = (args.type as string) || 'python';
  let code: string | null = (args.code as string) || (args.script as string);
  if (!code) {
    code = extractCodeBlock(response, codeType);
    if (!code) {
      return new StepOutcome('[Error] Code missing. Must use reply code block or script arg.', '\n');
    }
  }
  const timeout = parseInt(String(args.timeout ?? 60), 10) || 60;
  const rawPath = path.join(cwd, String(args.cwd || './'));
  const codeWorkDir = path.normalize(path.resolve(rawPath));
  const codeCwd = path.normalize(cwd);

  if (codeType === 'python' && args.inline_eval) {
    // SECURITY: inline_eval is now executed in a separate child_process sandbox
    // without access to the agent handler or parent context. Code can only return
    // a value via the `_r` variable. This prevents LLM-generated code from
    // accessing the filesystem, network, or environment of the main process.
    const result = await runInlineSandbox(code, timeout * 1000, cwd);
    if (result.error) {
      return new StepOutcome(`Error: ${result.error}`, '\n');
    }
    return new StepOutcome(result.result, '\n');
  }

  const result = yield* codeRun(code, codeType, timeout, codeWorkDir, codeCwd, stopSignal);
  return new StepOutcome(result, '\n');
}

// ---------------------------------------------------------------------------
// registerCodeTools
// ---------------------------------------------------------------------------

export function registerCodeTools(
  registry: ToolRegistry,
  cwd: string,
  stopSignal: number[],
): void {
  registry.register({
    name: 'code_run',
    description:
      'Execute code in a sandboxed environment. Supports python, bash, and other shell types. ' +
      'For inline python evaluation without side effects, use inline_eval=true.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['python', 'py', 'bash', 'sh', 'shell', 'powershell', 'ps1', 'pwsh'],
          description: 'Code language / runtime (default: python)',
        },
        code: { type: 'string', description: 'Code to execute (or use a code block in reply)' },
        script: { type: 'string', description: 'Alias for code' },
        cwd: { type: 'string', description: 'Working directory for execution (default: ./)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 60)' },
        inline_eval: {
          type: 'boolean',
          description: 'Evaluate in a sandboxed VM and return _r (python only)',
        },
      },
      required: [],
    },
    handler: (args: Record<string, unknown>, response?: LLMResponse) =>
      do_code_run(args, response!, cwd, stopSignal),
  });
}
