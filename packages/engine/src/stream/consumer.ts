import { AgentYield, AgentState } from '../types/index.js';

export interface AgentYieldConsumer {
  onText(chunk: string): void;
  onThinking(chunk: string): void;
  onToolCall(call: { id: string; turn: number; toolName: string; args: Record<string, unknown> }): void;
  onToolResult(result: { id: string; status: 'done' | 'error'; content: unknown }): void;
  onError(error: { severity: 'retryable' | 'fatal'; message: string }): void;
  onState(snapshot: AgentState): void;
}

export class CliConsumer implements AgentYieldConsumer {
  private showThinking: boolean;
  private showToolResults: boolean;

  constructor(opts?: { showThinking?: boolean; showToolResults?: boolean }) {
    this.showThinking = opts?.showThinking ?? process.env.ORION_CLI_THINKING === 'true';
    this.showToolResults = opts?.showToolResults ?? process.env.ORION_CLI_TOOL_RESULTS === 'true';
  }

  onText(chunk: string): void { process.stdout.write(chunk); }
  onThinking(chunk: string): void {
    if (this.showThinking) process.stdout.write(`\n[Thinking] ${chunk}\n`);
  }
  onToolCall(call: { toolName: string }): void {
    process.stdout.write(`\n🛠️  ${call.toolName}\n`);
  }
  onToolResult(result: { status: string; content: unknown }): void {
    if (result.status === 'error') { process.stdout.write('[error]\n'); return; }
    if (this.showToolResults) {
      const s = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      process.stdout.write(`\n[Result] ${s.slice(0, 200)}\n`);
    }
  }
  onError(error: { severity: string; message: string }): void {
    process.stdout.write(`\n!!!${error.severity === 'fatal' ? 'Fatal' : 'Retryable'} Error: ${error.message}\n`);
  }
  onState(_snapshot: AgentState): void { /* CLI no-op */ }
}

export function dispatchYield(y: AgentYield, consumer: AgentYieldConsumer): void {
  switch (y.kind) {
    case 'text': consumer.onText(y.content); break;
    case 'thinking': consumer.onThinking(y.content); break;
    case 'tool_call': consumer.onToolCall(y); break;
    case 'tool_result': consumer.onToolResult(y); break;
    case 'error': consumer.onError(y); break;
    case 'state': consumer.onState(y.snapshot); break;
    case 'trace': break;
  }
}

// Backward compat — kept for migration period
export function renderAgentYieldToText(y: AgentYield): string {
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  const c = new CliConsumer();
  dispatchYield(y, c);
  process.stdout.write = orig;
  return out;
}
