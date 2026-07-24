import { MCPServerConfig } from '../registry.js';

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPClient {
  listTools(): Promise<MCPToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
  close(): Promise<void>;
}

export async function createMCPClient(config: MCPServerConfig): Promise<MCPClient | null> {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = config.transport ?? 'stdio';
    if (transport === 'stdio' && config.command) {
      const stdioTransport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env,
        cwd: config.cwd,
      });
      const client = new Client(
        { name: 'orion-engine', version: '0.1.0' },
        { capabilities: {} }
      );
      await client.connect(stdioTransport);
      return {
        listTools: async () => {
          const result = await client.listTools();
          return (result.tools as MCPToolDef[]) ?? [];
        },
        callTool: async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          return result as { content: Array<{ type: string; text?: string }> };
        },
        close: async () => {
          await client.close();
        },
      };
    }

    console.warn(`[MCP] Unsupported transport: ${transport}`);
    return null;
  } catch (e) {
    console.warn(
      `[MCP] Failed to create client for ${config.name ?? config.command}: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}
