import type { ToolDef } from './message.js';

// ── ToolResult ──
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── ToolRegistration ──
export interface ToolRegistration {
  name: string;
  description: string;
  schema: Record<string, unknown>;  // JSON Schema
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  category?: 'builtin' | 'mcp' | 'custom';
  hidden?: boolean;
  slow?: boolean;
  timeout?: number; // ms
}

// ── ToolRegistry ──
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  register(def: ToolRegistration): this {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
    return this;
  }

  registerTools(defs: ToolRegistration[]): this {
    for (const def of defs) this.register(def);
    return this;
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolRegistration[] {
    return Array.from(this.tools.values());
  }

  /** 返回发送给 LLM 的 tool schema 列表（跳过 hidden 工具） */
  getSchemas(): ToolDef[] {
    return this.getAll()
      .filter(t => !t.hidden)
      .map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema as ToolDef['input_schema'],
      }));
  }

  /** 执行工具（含 schema 校验） */
  async execute(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }
    try {
      const parsed = args as Record<string, unknown>;
      const result = await tool.handler(parsed);
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }

  get size(): number {
    return this.tools.size;
  }
}
