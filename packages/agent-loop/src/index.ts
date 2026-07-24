// @orion/agent-loop — Agent Loop SDK

// ── Core ──
export { AgentLoop } from './core/agent-loop.js';
export type { AgentLoopOptions } from './core/agent-loop.js';
export { ToolRegistry } from './core/tool-registry.js';
export type { ToolRegistration, ToolResult } from './core/tool-registry.js';
export { SubAgentPool, createSubAgent } from './core/sub-agent.js';
export type { SubAgentRequest, SubAgentResult } from './core/sub-agent.js';
export { StateSerializer } from './core/state.js';
export type { AgentState } from './core/state.js';

// ── Core Types ──
export type {
  Message, ContentBlock, ToolResultBlock,
  AgentEvent, ToolDef, ToolCall, TokenCost,
} from './core/message.js';

// ── LLM ──
export type {
  LLMProvider, LLMEvent, LLMResponse, ChatOptions,
} from './core/llm-provider.js';

// ── Runtime ──
export { AgentError } from './runtime/agent-error.js';
export type { ErrorSeverity } from './runtime/agent-error.js';
export { RetryPolicy, withRetry, DEFAULT_RETRY_POLICY } from './runtime/retry-policy.js';
export type { RetryPolicyOptions, ErrorMatcher, FallbackDecision } from './runtime/retry-policy.js';
export { HookPipeline } from './runtime/hook-pipeline.js';
export type {
  HookPhase, HookHandler, HookResult, HookContext,
  BeforeToolContext, AfterToolContext, BeforeLLMContext, AfterLLMContext,
  TurnContext, ErrorContext, StopContext,
} from './runtime/hook-pipeline.js';
export { WindowManager, TruncateWindow, SlidingWindow, SummaryWindow } from './runtime/window-manager.js';
export type { TruncateOptions, SlidingOptions, SummaryOptions } from './runtime/window-manager.js';
export { InMemoryStore } from './runtime/memory-store.js';
export type { MemoryStore, MemoryItem } from './runtime/memory-store.js';
export { SkillLoader } from './runtime/skill-loader.js';
export type { SkillManifest, Skill } from './runtime/skill-loader.js';

// ── Orch ──
export { TaskStore } from './orch/task-store.js';
export type { Task, TaskCreateOptions, TaskFilter } from './orch/task-store.js';
export { CronScheduler } from './orch/cron-scheduler.js';
export type { CronJob } from './orch/cron-scheduler.js';
export { BackgroundTaskRunner } from './orch/background.js';
export type { BackgroundTask, BackgroundNotification } from './orch/background.js';
export { MessageBus } from './orch/message-bus.js';
export type { InboxMessage, SendOptions } from './orch/message-bus.js';
export { ProtocolManager } from './orch/protocol.js';
export type { ProtocolState } from './orch/protocol.js';
export { Teammate } from './orch/teammate.js';
export type { TeammateOptions, TeammateStatus } from './orch/teammate.js';
export { TeamOrchestrator } from './orch/orchestrator.js';
export type { TeamConfig, TeamSnapshot } from './orch/orchestrator.js';
export { MCPAdapter, buildMCPToolName } from './orch/mcp-adapter.js';
export type { MCPClientConfig, MCPTransportType } from './orch/mcp-adapter.js';
export { WorktreeManager } from './orch/worktree.js';
export type { WorktreeInfo, CreateResult, RemoveResult } from './orch/worktree.js';

// ── CLI ──
export { CliConsumer } from './cli/cli-consumer.js';
