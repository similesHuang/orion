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
  if (usage.cache_creation_input_tokens !== undefined || usage.cache_read_input_tokens !== undefined) {
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
): string {
  const main = getTracker(threadName);
  return formatStats(threadName, main);
}
