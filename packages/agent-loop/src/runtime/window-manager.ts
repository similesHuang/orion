import type { Message } from '../core/message.js';

// ── Helper Functions ──
function estimateSize(msg: Message): number {
  if (typeof msg.content === 'string') return msg.content.length;
  return JSON.stringify(msg.content).length;
}

function estimateTotalSize(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateSize(m), 0);
}

function isToolResultMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(b => b.type === 'tool_result');
}

function hasToolUse(msg: Message): boolean {
  if (msg.role !== 'assistant') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(b => b.type === 'tool_use');
}

// ── WindowManager Abstract Class ──
export abstract class WindowManager {
  abstract compress(messages: Message[]): Message[];
  abstract estimateTokenCount(messages: Message[]): number;
}

// ── TruncateWindow ──
export interface TruncateOptions {
  maxMessages?: number;  // default 50
  headCount?: number;    // default 3 (system + first 2)
}

export class TruncateWindow extends WindowManager {
  private maxMessages: number;
  private headCount: number;

  constructor(opts?: TruncateOptions) {
    super();
    this.maxMessages = opts?.maxMessages ?? 50;
    this.headCount = opts?.headCount ?? 3;
  }

  compress(messages: Message[]): Message[] {
    if (messages.length <= this.maxMessages) return messages;

    const tailCount = this.maxMessages - this.headCount;
    if (tailCount <= 0) return messages.slice(0, this.maxMessages);

    // Ensure we don't split in the middle of a tool_use/tool_result pair
    let headEnd = this.headCount;
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) {
      headEnd++;
    }

    let tailStart = Math.max(headEnd, messages.length - tailCount);
    while (tailStart < messages.length && isToolResultMessage(messages[tailStart])) {
      tailStart++;
    }
    // If the step above pushed us forward, go back to keep the pair intact
    if (tailStart > headEnd && tailStart < messages.length && hasToolUse(messages[tailStart - 1])) {
      tailStart--;
    }

    if (headEnd >= tailStart) return messages;

    const snipped = tailStart - headEnd;
    return [
      ...messages.slice(0, headEnd),
      { role: 'user', content: `[snipped ${snipped} messages]` } as Message,
      ...messages.slice(tailStart),
    ];
  }

  estimateTokenCount(messages: Message[]): number {
    // Rough estimate: 4 chars ≈ 1 token
    return Math.ceil(estimateTotalSize(messages) / 4);
  }
}

// ── SlidingWindow ──
export interface SlidingOptions {
  maxTokens: number;       // default 80000
  systemAlways?: boolean;  // default true
}

export class SlidingWindow extends WindowManager {
  private maxTokens: number;
  private systemAlways: boolean;

  constructor(opts?: SlidingOptions) {
    super();
    this.maxTokens = opts?.maxTokens ?? 80000;
    this.systemAlways = opts?.systemAlways ?? true;
  }

  compress(messages: Message[]): Message[] {
    const tokens = this.estimateTokenCount(messages);
    if (tokens <= this.maxTokens) return messages;

    // Keep system message, slide from the second message
    let startIdx = this.systemAlways ? 1 : 0;
    while (startIdx < messages.length) {
      const sliced = this.systemAlways
        ? [messages[0], ...messages.slice(startIdx)]
        : messages.slice(startIdx);
      if (this.estimateTokenCount(sliced) <= this.maxTokens) {
        return sliced;
      }
      startIdx++;
    }
    return messages.slice(-Math.ceil(this.maxTokens / 100));
  }

  estimateTokenCount(messages: Message[]): number {
    return Math.ceil(estimateTotalSize(messages) / 4);
  }
}

// ── SummaryWindow ──
export interface SummaryOptions {
  maxMessagesBeforeSummary: number;
  keepRecentTurns: number;
  summarizeFn: (conversation: string) => Promise<string>;
}

export class SummaryWindow extends WindowManager {
  private maxMessagesBeforeSummary: number;
  private keepRecentTurns: number;
  private summarizeFn: (conversation: string) => Promise<string>;

  constructor(opts: SummaryOptions) {
    super();
    this.maxMessagesBeforeSummary = opts.maxMessagesBeforeSummary;
    this.keepRecentTurns = opts.keepRecentTurns;
    this.summarizeFn = opts.summarizeFn;
  }

  async compressAsync(messages: Message[]): Promise<Message[]> {
    if (messages.length <= this.maxMessagesBeforeSummary) return messages;

    const summaryPoint = messages.length - this.keepRecentTurns * 2;
    if (summaryPoint <= 0) return messages;

    const toSummarize = messages.slice(0, summaryPoint);
    const recent = messages.slice(summaryPoint);

    const conversation = JSON.stringify(toSummarize);
    const summary = await this.summarizeFn(conversation);

    return [
      { role: 'system', content: `[Summary of earlier conversation]\n${summary}` } as Message,
      ...recent,
    ];
  }

  compress(messages: Message[]): Message[] {
    // Sync version just returns as-is; async compression requires explicit compressAsync call
    return messages;
  }

  estimateTokenCount(messages: Message[]): number {
    return Math.ceil(estimateTotalSize(messages) / 4);
  }
}
