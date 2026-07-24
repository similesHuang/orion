// ── MemoryItem ──
export interface MemoryItem {
  id: string;
  content: string;
  type: 'user_fact' | 'feedback' | 'project_knowledge' | 'reference';
  tags: string[];
  ts: number;
}

// ── MemoryStore 接口 ──
export interface MemoryStore {
  retrieve(context: string, limit?: number): Promise<MemoryItem[]>;
  store(item: Omit<MemoryItem, 'id' | 'ts'>): Promise<string>;
  forget(id: string): Promise<void>;
  save?(): Promise<void>;
  load?(): Promise<void>;
  clear(): Promise<void>;
}

// ── InMemoryStore ──
export class InMemoryStore implements MemoryStore {
  private items: MemoryItem[] = [];
  private counter = 0;

  async retrieve(_context: string, limit = 5): Promise<MemoryItem[]> {
    // 按时间降序，取最新的 limit 条
    return this.items
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  async store(item: Omit<MemoryItem, 'id' | 'ts'>): Promise<string> {
    const id = `mem_${++this.counter}`;
    this.items.push({ ...item, id, ts: Date.now() });
    return id;
  }

  async forget(id: string): Promise<void> {
    this.items = this.items.filter(i => i.id !== id);
  }

  async clear(): Promise<void> {
    this.items = [];
  }

  count(): number {
    return this.items.length;
  }
}
