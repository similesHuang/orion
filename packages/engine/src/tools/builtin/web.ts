import fs from 'fs';
import path from 'path';
import { resolveAllowedPath, smartFormat } from '../../shared/index.js';
import { ToolRegistry } from '../registry.js';
import { LLMResponse } from '../../types/index.js';
import { StepOutcome } from '../../agent-loop.js';
import type { WebAutomation } from '../../web/automation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absPath(cwd: string, p: string): string {
  if (!p) return '';
  return resolveAllowedPath(cwd, p);
}

// ---------------------------------------------------------------------------
// do_web_scan
// ---------------------------------------------------------------------------

async function* do_web_scan(
  args: Record<string, unknown>,
  webAutomation?: WebAutomation,
): AsyncGenerator<string, StepOutcome, unknown> {
  if (!webAutomation) {
    return new StepOutcome(
      { status: 'error', error: 'Web automation is not available — no WebAutomation provided.' },
      '\n'
    );
  }
  yield '[Action] Scanning web page...\n';
  const result = await webAutomation.scan({
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
      tabs: result.tabs.map((t: { id: string; url: string; title: string }) => ({ id: t.id, url: t.url, title: t.title })),
      active_tab: result.current_tab,
    },
  };
  let output: string;
  if (result.status !== 'success') {
    output = `Error: ${result.content}`;
  } else {
    const metaJson = JSON.stringify(metadata, null, 2);
    const shownContent =
      args.text_only === true
        ? smartFormat(content, 10000, '\n\n[omitted long content]\n\n')
        : content;
    output = `${metaJson}\n\n\`\`\`html\n${shownContent}\n\`\`\``;
  }
  yield `${output}\n`;
  return new StepOutcome(smartFormat(output, 8000), '\n');
}

// ---------------------------------------------------------------------------
// do_web_navigate
// ---------------------------------------------------------------------------

async function* do_web_navigate(
  args: Record<string, unknown>,
  webAutomation?: WebAutomation,
): AsyncGenerator<string, StepOutcome, unknown> {
  if (!webAutomation) {
    return new StepOutcome(
      { status: 'error', error: 'Web automation is not available — no WebAutomation provided.' },
      '\n'
    );
  }
  const url = String(args.url || '');
  if (!url) {
    return new StepOutcome({ status: 'error', error: 'No URL provided.' }, '\n');
  }
  yield `[Action] Navigating to: ${url}\n`;
  const result = await webAutomation.navigate(url, {
    switch_tab_id: args.switch_tab_id as string | undefined,
    new_tab: args.new_tab === true,
  });
  const summary =
    result.status === 'success'
      ? `Loaded: ${result.url} (${result.title})`
      : `Error: ${result.error}`;
  yield `${summary}\n`;
  return new StepOutcome(result, '\n');
}

// ---------------------------------------------------------------------------
// do_web_execute_js
// ---------------------------------------------------------------------------

async function* do_web_execute_js(
  args: Record<string, unknown>,
  response: LLMResponse,
  cwd: string,
  webAutomation?: WebAutomation,
): AsyncGenerator<string, StepOutcome, unknown> {
  if (!webAutomation) {
    return new StepOutcome(
      { status: 'error', error: 'Web automation is not available — no WebAutomation provided.' },
      '\n'
    );
  }
  let script = (args.script as string) || '';
  if (!script) {
    const codeBlock = response.content.match(/```(?:javascript|js)\n([\s\S]*?)\n```/);
    script = codeBlock ? codeBlock[1].trim() : '';
  }
  if (!script) {
    return new StepOutcome({ status: 'error', error: 'No script provided.' }, '\n');
  }
  const resolvedScriptPath = absPath(cwd, script.trim());
  if (fs.existsSync(resolvedScriptPath) && fs.statSync(resolvedScriptPath).isFile()) {
    script = fs.readFileSync(resolvedScriptPath, 'utf-8');
  }
  yield '[Action] Executing JS in browser...\n';
  const result = await webAutomation.executeJs(script, {
    save_to_file: args.save_to_file as string | undefined,
    switch_tab_id: args.switch_tab_id as string | undefined,
    no_monitor: args.no_monitor === true,
  });
  if (args.save_to_file && result.js_return !== undefined) {
    const content = String(result.js_return ?? '');
    const outPath = absPath(cwd, String(args.save_to_file));
    result.js_return = smartFormat(content, 170);
    try {
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, content, 'utf-8');
      result.js_return += `\n\n[Saved full content to ${outPath}]`;
    } catch {
      result.js_return += `\n\n[Save failed, could not write to ${outPath}]`;
    }
  }
  yield `JS result:\n${JSON.stringify(result, null, 2)}\n`;
  return new StepOutcome(smartFormat(JSON.stringify(result), 8000), '\n');
}

// ---------------------------------------------------------------------------
// registerWebTools
// ---------------------------------------------------------------------------

export function registerWebTools(registry: ToolRegistry, webAutomation?: WebAutomation): void {
  const cwd = process.cwd();
  registry.register({
    name: 'web_scan',
    description:
      'Scan the currently opened web page in the browser. Returns page content, metadata, and tab information.',
    parameters: {
      type: 'object',
      properties: {
        tabs_only: { type: 'boolean', description: 'Only return tab metadata, not page content' },
        switch_tab_id: { type: 'string', description: 'Switch to a specific tab before scanning' },
        text_only: { type: 'boolean', description: 'Extract text only (no HTML)' },
        max_chars: { type: 'number', description: 'Maximum characters to return' },
      },
      required: [],
    },
    handler: (args: Record<string, unknown>) => do_web_scan(args, webAutomation),
  });

  registry.register({
    name: 'web_navigate',
    description: 'Navigate the browser to a given URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        switch_tab_id: { type: 'string', description: 'Target tab ID' },
        new_tab: { type: 'boolean', description: 'Open in a new tab' },
      },
      required: ['url'],
    },
    handler: (args: Record<string, unknown>) => do_web_navigate(args, webAutomation),
  });

  registry.register({
    name: 'web_execute_js',
    description:
      'Execute JavaScript in the browser context. Script can be provided directly or via a code block.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute (or use code block)' },
        save_to_file: { type: 'string', description: 'Save the JS return value to a file' },
        switch_tab_id: { type: 'string', description: 'Target tab ID' },
        no_monitor: { type: 'boolean', description: 'Disable monitoring' },
      },
      required: [],
    },
    handler: (args: Record<string, unknown>, response?: LLMResponse) =>
      do_web_execute_js(args, response!, cwd, webAutomation),
  });
}
