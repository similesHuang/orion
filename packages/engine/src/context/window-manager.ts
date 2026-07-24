import { Message } from '../types/index.js';

export interface WindowManager {
  fit(messages: Message[]): Message[];
  onUsage(usage: Record<string, number>): void;
  setBudget(maxTokens: number): void;
  getUsage(): { used: number; budget: number; remaining: number };
}

export class TruncateWindowManager implements WindowManager {
  private budget: number;
  private used = 0;
  private static CHARS_PER_TOKEN = 3;

  constructor(maxTokens = 128000) {
    this.budget = maxTokens;
  }

  fit(messages: Message[]): Message[] {
    let total = messages.reduce((s, m) => s + JSON.stringify(m.content).length, 0);
    if (total <= this.budget * TruncateWindowManager.CHARS_PER_TOKEN) return messages;
    const result = [...messages];
    while (result.length > 2 && total > this.budget * TruncateWindowManager.CHARS_PER_TOKEN) {
      const removed = result.splice(1, 1)[0];
      if (!removed) break;
      total -= JSON.stringify(removed.content).length;
    }
    return result;
  }

  onUsage(usage: Record<string, number>): void {
    this.used = (usage.input_tokens ?? usage.input ?? 0) +
      (usage.output_tokens ?? usage.output ?? 0);
  }

  setBudget(maxTokens: number): void { this.budget = maxTokens; }

  getUsage(): { used: number; budget: number; remaining: number } {
    return { used: this.used, budget: this.budget, remaining: Math.max(0, this.budget - this.used) };
  }
}

export class SlidingWindowManager implements WindowManager {
  private budget: number;
  private used = 0;
  private maxTurns: number;

  constructor(maxTokens = 128000, maxTurns = 40) {
    this.budget = maxTokens;
    this.maxTurns = maxTurns;
  }

  fit(messages: Message[]): Message[] {
    const system = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    const pairs: Message[] = [];
    for (const m of rest) {
      pairs.push(m);
      if (m.role === 'assistant' && pairs.filter(x => x.role === 'user').length > this.maxTurns) {
        const fi = pairs.findIndex(x => x.role === 'user');
        if (fi >= 0) pairs.splice(fi, 1);
      }
    }
    return [...system, ...pairs];
  }

  onUsage(usage: Record<string, number>): void {
    this.used = (usage.input_tokens ?? usage.input ?? 0) +
      (usage.output_tokens ?? usage.output ?? 0);
  }

  setBudget(maxTokens: number): void { this.budget = maxTokens; }

  getUsage(): { used: number; budget: number; remaining: number } {
    return { used: this.used, budget: this.budget, remaining: Math.max(0, this.budget - this.used) };
  }
}
