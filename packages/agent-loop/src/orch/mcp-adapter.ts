import { ToolRegistry, type ToolRegistration } from '../core/tool-registry.js';

export type MCPTransportType = 'stdio' | 'sse';

export interface MCPClientConfig {
  type: MCPTransportType;
  command?: string;   // stdio
  args?: string[];
  url?: string;       // sse
  env?: Record<string, string>;
}

/** MCP 工具注册到 ToolRegistry 时自动前缀隔离 */
export function buildMCPToolName(server: string, tool: string): string {
  // 只保留字母数字下划线横线
  const safeServer = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${safeServer}__${safeTool}`;
}

export class MCPAdapter {
  private static connections = new Map<string, MCPClientConfig>();

  /** 连接 MCP 服务器并将工具注册到 ToolRegistry */
  static async connect(
    registry: ToolRegistry,
    serverName: string,
    config: MCPClientConfig
  ): Promise<void> {
    if (this.connections.has(serverName)) {
      throw new Error(`MCP server already connected: ${serverName}`);
    }

    this.connections.set(serverName, config);

    // 模拟工具发现（实际项目中通过 MCP SDK 发现）
    // 占位：这里将由 MCP 协议的工具发现机制替换
    const discoveredTools: ToolRegistration[] = [];

    // 注册工具
    for (const tool of discoveredTools) {
      const prefixedName = buildMCPToolName(serverName, tool.name);
      registry.register({
        ...tool,
        name: prefixedName,
        category: 'mcp',
      });
    }
  }

  /** 断开 MCP 服务器并移除所有该服务器的工具 */
  static disconnect(registry: ToolRegistry, serverName: string): void {
    const prefix = `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__`;
    const toRemove = registry.getAll()
      .filter(t => t.name.startsWith(prefix))
      .map(t => t.name);

    for (const name of toRemove) {
      registry.remove(name);
    }

    this.connections.delete(serverName);
  }

  /** 列出所有已连接的 MCP 源 */
  static listMCPSources(): string[] {
    return Array.from(this.connections.keys());
  }

  /** 检查某个工具是否是 MCP 工具 */
  static isMCPTool(toolName: string): boolean {
    return isMCPTool(toolName);
  }

  /** 从 MCP 工具名解析服务器和原始工具名 */
  static parseMCPToolName(toolName: string): { server: string; tool: string } | null {
    return parseMCPToolName(toolName);
  }
}

/** 检查某个工具名称是否是 MCP 工具 */
export function isMCPTool(toolName: string): boolean {
  return toolName.startsWith('mcp__');
}

/** 从 MCP 工具名解析服务器和原始工具名 */
export function parseMCPToolName(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  return { server: parts[1], tool: parts.slice(2).join('__') };
}
