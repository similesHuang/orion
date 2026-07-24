// Module exports — only LLM, tools, shared, and types remain.
// agent, chat, memory, and reflect have moved to apps/desktop/sidecar/.
export * from './types/index.js'
export * from './shared/index.js'
export * from './llm/index.js'
export * from './tools/index.js'

// Backward compat — re-export from @orion/engine
export { OrionAgent, OrionAgentHandler, ToolRegistry, AgentError, agentRunnerLoop } from '@orion/engine';
