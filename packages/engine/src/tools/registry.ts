import { ToolDefinition, LLMResponse } from '../types/index.js';
import { StepOutcome } from '../agent-loop.js';

// ---------------------------------------------------------------------------
// Tool handler signature
// ---------------------------------------------------------------------------

export type ToolHandler = (
  args: Record<string, unknown>,
  response?: LLMResponse,
) => AsyncGenerator<string, StepOutcome, unknown>;

// ---------------------------------------------------------------------------
// Registered tool (internal representation)
// ---------------------------------------------------------------------------

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
}

// ---------------------------------------------------------------------------
// MCP server configuration
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  /** All locally registered tools (builtin + user-supplied). */
  private toolMap = new Map<string, RegisteredTool>();

  /** MCP server configurations registered but not yet connected. */
  private mcpServers = new Map<string, MCPServerConfig>();

  /** Whether MCP servers have been connected. */
  private mcpConnected = false;

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a single tool definition bound to a handler.
   * Re-registering the same name overwrites the previous entry.
   */
  register(tool: RegisteredTool): void {
    this.toolMap.set(tool.name, tool);
  }

  /**
   * Register an MCP server configuration.
   * Tools from this server won't appear in `list()` until `connectMCPAll()` is called.
   */
  registerMCP(serverName: string, config: MCPServerConfig): void {
    this.mcpServers.set(serverName, config);
    this.mcpConnected = false;
  }

  // -----------------------------------------------------------------------
  // MCP lifecycle
  // -----------------------------------------------------------------------

  /**
   * Connect to all registered MCP servers and register their tools.
   *
   * Currently a stub — the actual MCP client integration is implemented in
   * Task 11. When connected, each server's tool list is fetched and each
   * remote tool is registered with a proxy handler via `this.register()`.
   */
  async connectMCPAll(): Promise<void> {
    if (this.mcpConnected) return;

    // TODO: Task 11 — instantiate MCP client per server, list tools,
    // and register a proxy handler for each.

    this.mcpConnected = true;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Return tools in the OpenAI function-calling schema format.
   * MCP tools are only included after `connectMCPAll()` has completed.
   */
  list(): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const tool of this.toolMap.values()) {
      result.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return result;
  }

  /**
   * Look up a registered tool by name (includes MCP tools after connect).
   * Returns undefined when the tool is not found.
   */
  get(name: string): RegisteredTool | undefined {
    return this.toolMap.get(name);
  }

  // -----------------------------------------------------------------------
  // Introspection
  // -----------------------------------------------------------------------

  /** Number of registered tools (excluding unconnected MCP servers). */
  get size(): number {
    return this.toolMap.size;
  }

  /** Registered tool names. */
  get names(): string[] {
    return [...this.toolMap.keys()];
  }
}
