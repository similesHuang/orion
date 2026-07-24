import {
  fileRead,
  fileWrite,
  filePatch,
  expandFileRefs,
  extractRobustContent,
  formatError,
  resolveAllowedPath,
  smartFormat,
} from '../../compat.js';
import { ToolRegistry } from '../registry.js';
import { LLMResponse } from '../../types/index.js';
import { StepOutcome } from '../../agent-loop.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absPath(cwd: string, p: string): string {
  if (!p) return '';
  return resolveAllowedPath(cwd, p);
}

// ---------------------------------------------------------------------------
// do_file_read
// ---------------------------------------------------------------------------

async function* do_file_read(
  args: Record<string, unknown>,
  cwd: string,
): AsyncGenerator<string, StepOutcome, unknown> {
  const filePath = String(args.path || '');
  const resolvedPath = absPath(cwd, filePath);
  yield `\n[Action] Reading file: ${resolvedPath}\n`;
  const start = parseInt(String(args.start ?? 1), 10);
  const count = parseInt(String(args.count ?? 200), 10);
  const keyword = args.keyword as string | undefined;
  const showLinenos = args.show_linenos !== false;
  let result = fileRead(filePath, start, keyword, count, showLinenos, cwd);
  if (result.includes(' ... [TRUNCATED]')) {
    result += '\n\n（某些行被截断，如需完整内容可改用 code_run 读取）';
  }
  result = smartFormat(result, 20000, '\n\n[omitted long content]\n\n');
  return new StepOutcome(result, '\n');
}

// ---------------------------------------------------------------------------
// do_file_write
// ---------------------------------------------------------------------------

async function* do_file_write(
  args: Record<string, unknown>,
  response: LLMResponse,
  cwd: string,
): AsyncGenerator<string, StepOutcome, unknown> {
  const filePath = String(args.path || '');
  const mode = (args.mode as string) || 'overwrite';
  yield `[Action] ${mode.charAt(0).toUpperCase() + mode.slice(1)} file: ${filePath}\n`;

  let content = (args.content as string) || extractRobustContent(response.content);
  if (!content) {
    yield `[Status] Failed: No content provided (use content arg or code block)\n`;
    return new StepOutcome(
      {
        status: 'error',
        msg: 'No content found. Provide content via the content argument or a fenced code block.',
      },
      '\n'
    );
  }
  try {
    content = expandFileRefs(content, cwd);
    const result = fileWrite(filePath, content, mode, cwd);
    yield `[Status] ${mode.charAt(0).toUpperCase() + mode.slice(1)} succeeded (${content.length} bytes)\n`;
    return new StepOutcome(result, '\n');
  } catch (e) {
    yield `[Status] Write error: ${formatError(e)}\n`;
    return new StepOutcome({ status: 'error', msg: formatError(e) }, '\n');
  }
}

// ---------------------------------------------------------------------------
// do_file_patch
// ---------------------------------------------------------------------------

async function* do_file_patch(
  args: Record<string, unknown>,
  cwd: string,
): AsyncGenerator<string, StepOutcome, unknown> {
  const filePath = String(args.path || '');
  yield `[Action] Patching file: ${filePath}\n`;
  const oldContent = String(args.old_content || '');
  let newContent = String(args.new_content || '');
  try {
    newContent = expandFileRefs(newContent, cwd);
  } catch (e) {
    yield `[Status] Reference expansion failed: ${formatError(e)}\n`;
    return new StepOutcome({ status: 'error', msg: formatError(e) }, '\n');
  }
  const result = filePatch(filePath, oldContent, newContent, cwd);
  yield `\n${JSON.stringify(result)}\n`;
  return new StepOutcome(result, '\n');
}

// ---------------------------------------------------------------------------
// registerFileTools
// ---------------------------------------------------------------------------

export function registerFileTools(registry: ToolRegistry, cwd: string): void {
  registry.register({
    name: 'file_read',
    description:
      'Read a file from the filesystem. Supports starting line, keyword search, and line count.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        start: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        count: { type: 'number', description: 'Number of lines to read (default: 200)' },
        keyword: { type: 'string', description: 'Keyword to search for in the file' },
        show_linenos: { type: 'boolean', description: 'Show line numbers (default: true)' },
      },
      required: ['path'],
    },
    handler: (args: Record<string, unknown>) => do_file_read(args, cwd),
  });

  registry.register({
    name: 'file_write',
    description: 'Write content to a file. Supports overwrite, append, and prepend modes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the output file' },
        content: { type: 'string', description: 'Content to write (or use code block)' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append', 'prepend'],
          description: 'Write mode (default: overwrite)',
        },
      },
      required: ['path'],
    },
    handler: (args: Record<string, unknown>, response?: LLMResponse) =>
      do_file_write(args, response!, cwd),
  });

  registry.register({
    name: 'file_patch',
    description: 'Apply a targeted text replacement (find and replace) within a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to patch' },
        old_content: { type: 'string', description: 'Exact text to find and replace' },
        new_content: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_content', 'new_content'],
    },
    handler: (args: Record<string, unknown>) => do_file_patch(args, cwd),
  });
}
