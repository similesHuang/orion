import { RegisteredTool } from '../registry.js';
import { StepOutcome } from '../../agent-loop.js';
import { MCPToolDef, createMCPClient } from './client.js';
import { MCPServerConfig } from '../registry.js';
import type { ToolRegistry } from '../registry.js';

export function mcpToolToRegistration(
  tool: MCPToolDef,
  callTool: (name: string, args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>
): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    handler: async function* (args): AsyncGenerator<string, StepOutcome, unknown> {
      yield `[MCP] Calling ${tool.name}...\n`;
      try {
        const result = await callTool(tool.name, args);
        const text = result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
        return new StepOutcome(text, '\n');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new StepOutcome({ status: 'error', msg }, '\n');
      }
    },
  };
}

export async function registerMCPServerTools(
  registry: ToolRegistry,
  config: MCPServerConfig
): Promise<void> {
  const client = await createMCPClient(config);
  if (!client) return;
  const tools = await client.listTools();
  for (const tool of tools) {
    registry.register(mcpToolToRegistration(tool, (name, args) => client.callTool(name, args)));
  }
}
