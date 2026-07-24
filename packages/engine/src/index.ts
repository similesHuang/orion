// Orion Agent Engine SDK
export {
  OrionAgent,
  OrionAgentOptions,
  ToolApprovalDecision,
  ToolApprovalFn,
} from './orion-agent.js';

export { ToolRegistry, RegisteredTool, ToolHandler, MCPServerConfig } from './tools/registry.js';
export { registerFileTools } from './tools/builtin/file.js';
export { registerCodeTools } from './tools/builtin/code.js';
export { registerWebTools } from './tools/builtin/web.js';
export { registerUserTools } from './tools/builtin/user.js';

export { OrionAgentHandler, HandlerParent, ToolDeniedError } from './handler.js';
export { agentRunnerLoop, BaseHandler, StepOutcome, agentLoopHooks } from './agent-loop.js';
export type { AgentLoopOptions } from './agent-loop.js';

export { AgentYieldConsumer, CliConsumer, dispatchYield, renderAgentYieldToText } from './stream/consumer.js';
export { WindowManager, TruncateWindowManager, SlidingWindowManager } from './context/window-manager.js';
export { RetryPolicy, DEFAULT_RETRY_POLICY, withRetry } from './resilience/retry.js';
export { AgentError } from './resilience/errors.js';
export { saveAgentState, restoreAgentState, serializeAgentState, deserializeAgentState } from './state/serialization.js';
export { TelemetryHooks, TelemetrySpan, TelemetryTracer, NoopTelemetry, setTelemetry, getTelemetry, createSpanContext } from './telemetry/tracing.js';

export type { AgentYield, AgentState, Message, BaseSession, TaskQueueLike, ToolDefinition, LLMResponse, LLMStreamDelta } from './types/index.js';

// MCP
export { mcpToolToRegistration, registerMCPServerTools } from './tools/mcp/adapter.js';
export { createMCPClient } from './tools/mcp/client.js';
export type { MCPClient, MCPToolDef } from './tools/mcp/client.js';

// Sub-agent
export { delegate } from './subagent/delegation.js';
export type { SubAgentRequest, SubAgentResult } from './subagent/delegation.js';

// Inline sandbox
export { runInlineSandbox } from './inline-sandbox.js';
export type { SandboxResult } from './inline-sandbox.js';

// Cost tracker
export * as costTracker from './cost-tracker.js';

// Types — add AgentLike and deprecated alias
export type { AgentLike } from './types/index.js';
/** @deprecated Use AgentLike instead */
export type { AgentLike as GenericAgentLike } from './types/index.js';

// SpanContext
export type { SpanContext } from './types/index.js';
