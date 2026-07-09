import fs from 'fs';
import path from 'path';
import { llmUsageHooks } from '@orion/llm';

export interface TokenStats {
  requests: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  lastInput: number;
  lastOutput: number;
  startedAt: number;
}

export function emptyStats(startedAt = Date.now()): TokenStats {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    lastInput: 0,
    lastOutput: 0,
    startedAt,
  };
}

function totalInputSide(s: TokenStats): number {
  return s.input + s.cacheCreate + s.cacheRead;
}

export function totalTokens(s: TokenStats): number {
  return s.input + s.output + s.cacheCreate + s.cacheRead;
}

export function cacheHitRate(s: TokenStats): number {
  const side = totalInputSide(s);
  return side ? (s.cacheRead / side) * 100 : 0;
}

export function elapsedSeconds(s: TokenStats): number {
  return Math.max(0, (Date.now() - s.startedAt) / 1000);
}

const trackers = new Map<string, TokenStats>();
const lock = {
  run: <T>(fn: () => T): T => fn(),
};

const OUT_RE = /\[Output\]\s+tokens=(\d+)/;
const CACHE_RE_NEW = /\[Cache\]\s+input=(\d+)\s+creation=(\d+)\s+read=(\d+)/;
const CACHE_RE_OLD = /\[Cache\]\s+input=(\d+)\s+cached=(\d+)/;

let installed = false;

export function getTracker(threadName: string): TokenStats {
  return lock.run(() => {
    if (!trackers.has(threadName)) trackers.set(threadName, emptyStats());
    return trackers.get(threadName)!;
  });
}

export function resetTracker(threadName: string): void {
  lock.run(() => trackers.delete(threadName));
}

export function allTrackers(): Map<string, TokenStats> {
  return lock.run(() => new Map(trackers));
}

export function recordUsage(usage: Record<string, number>, threadName: string): void {
  const t = getTracker(threadName);
  if (!usage) return;
  t.requests += 1;
  const apiMode = (usage.api_mode as unknown as string) || undefined;
  if (apiMode === 'messages' || usage.cache_creation_input_tokens !== undefined || usage.cache_read_input_tokens !== undefined) {
    const inp = usage.input_tokens ?? usage.input ?? 0;
    const cc = usage.cache_creation_input_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0;
    const out = usage.output_tokens ?? usage.output ?? 0;
    t.input += inp;
    t.cacheCreate += cc;
    t.cacheRead += cr;
    if (out > 1) t.output += out;
    t.lastInput = inp + cc + cr;
    t.lastOutput = out > 1 ? out : t.lastOutput;
  } else {
    const cached = usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
    const inp = (usage.input_tokens ?? usage.input ?? usage.prompt_tokens ?? 0) - cached;
    const out = usage.output_tokens ?? usage.output ?? usage.completion_tokens ?? 0;
    t.input += Math.max(0, inp);
    t.cacheRead += cached;
    t.lastInput = inp + cached;
    if (out) {
      t.output += out;
      t.lastOutput = out;
    }
  }
}

export function scanSubagentLogs(since = 0, root?: string): TokenStats {
  const out = emptyStats(since > 0 ? since : Date.now());
  // Simple glob: list temp dirs and check stdout.log
  const base = root || process.cwd();
  const tempDir = path.join(base, 'temp');
  if (!fs.existsSync(tempDir)) return out;
  for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(tempDir, entry.name, 'stdout.log');
    if (!fs.existsSync(p)) continue;
    if (since && fs.statSync(p).mtimeMs < since) continue;
    try {
      const text = fs.readFileSync(p, 'utf-8');
      for (const line of text.split('\n')) {
        if (!line.startsWith('[Output]') && !line.startsWith('[Cache]')) continue;
        const om = line.match(OUT_RE);
        if (om) {
          out.output += parseInt(om[1], 10);
          out.requests += 1;
          continue;
        }
        const nm = line.match(CACHE_RE_NEW);
        if (nm) {
          out.input += parseInt(nm[1], 10);
          out.cacheCreate += parseInt(nm[2], 10);
          out.cacheRead += parseInt(nm[3], 10);
          continue;
        }
        const om2 = line.match(CACHE_RE_OLD);
        if (om2) {
          out.input += Math.max(0, parseInt(om2[1], 10) - parseInt(om2[2], 10));
          out.cacheRead += parseInt(om2[2], 10);
        }
      }
    } catch {
      // ignore bad logs
    }
  }
  return out;
}

export function formatStats(name: string, s: TokenStats): string {
  const side = totalInputSide(s);
  const total = totalTokens(s);
  const rate = cacheHitRate(s);
  const elapsed = elapsedSeconds(s);
  return (
    `${name}: ↑${side.toLocaleString()} ↓${s.output.toLocaleString()} = ${total.toLocaleString()} tokens ` +
    `| ${s.requests} reqs | cache ${rate.toFixed(1)}% | ${(elapsed / 60).toFixed(1)}min`
  );
}

export function formatCostReport(
  threadName = 'main',
  opts: { includeSubagents?: boolean; since?: number; root?: string } = {}
): string {
  const lines: string[] = [];
  const main = getTracker(threadName);
  lines.push(formatStats(threadName, main));
  if (opts.includeSubagents) {
    const sub = scanSubagentLogs(opts.since || main.startedAt, opts.root);
    if (sub.requests || sub.output || sub.input) {
      lines.push(formatStats('subagents', sub));
      const combined: TokenStats = {
        requests: main.requests + sub.requests,
        input: main.input + sub.input,
        output: main.output + sub.output,
        cacheCreate: main.cacheCreate + sub.cacheCreate,
        cacheRead: main.cacheRead + sub.cacheRead,
        lastInput: main.lastInput,
        lastOutput: main.lastOutput,
        startedAt: Math.min(main.startedAt, sub.startedAt),
      };
      lines.push(formatStats('total', combined));
    }
  }
  return lines.join('\n');
}

export function install(agent?: { onUsage?: (fn: (usage: Record<string, number>) => void) => void }): void {
  if (installed) return;
  if (agent && typeof agent.onUsage === 'function') {
    agent.onUsage((usage) => recordUsage(usage, 'main'));
  }
  llmUsageHooks.push((usage) => recordUsage(usage, 'main'));
  installed = true;
}
