# @orion/agent-loop

A TypeScript Agent Loop SDK — multi-provider, tool registry, team orchestration, and more.

## Architecture

Three-layer architecture with strict one-way dependency:

```
ORCH: Task · Team · Cron · Background · MCP · Worktree
  ↓
RUNTIME: Window · Memory · Skill · Hook · Retry/Error
  ↓
CORE: AgentLoop · LLMProvider · ToolRegistry · SubAgent · State
```

## Features

| Layer | Module | Description |
|-------|--------|-------------|
| **CORE** | `AgentLoop` | AsyncGenerator-based turn loop with pause/resume/stop |
| | `LLMProvider` | Provider interface — design for Anthropic, OpenAI, etc. |
| | `ToolRegistry` | Structured tool registration, schema export, execution |
| | `SubAgentPool` | Delegated sub-agent execution with cost tracking |
| | `StateSerializer` | Serialize/deserialize full agent state |
| **RUNTIME** | `WindowManager` | Context window strategies: Truncate, Sliding, Summary |
| | `MemoryStore` | Memory retrieval and storage (InMemoryStore) |
| | `SkillLoader` | Skill loading and catalog rendering |
| | `HookPipeline` | 8 lifecycle phases: beforeTurn, afterTurn, beforeTool, afterTool, beforeLLM, afterLLM, onError, onStop |
| | `RetryPolicy` | Exponential backoff, jitter, model fallback, error classification |
| | `AgentError` | Error grading: retryable / fatal / context_overflow |
| **ORCH** | `TaskStore` | File-backed task persistence with dependency resolution |
| | `MessageBus` | In-memory agent communication bus |
| | `ProtocolManager` | Plan approval and shutdown protocol |
| | `Teammate` | Autonomous agent participant |
| | `TeamOrchestrator` | Multi-agent team lifecycle management |
| | `CronScheduler` | 5-field cron scheduling engine |
| | `BackgroundTaskRunner` | Max-concurrency async task execution |
| | `MCPAdapter` | MCP server tool discovery and prefix isolation |
| | `WorktreeManager` | Git worktree lifecycle management |
| **CLI** | `CliConsumer` | Terminal event output with ANSI coloring |

## Quick Start

```typescript
import { AgentLoop, ToolRegistry } from '@orion/agent-loop';

// Create tool registry
const tools = new ToolRegistry();
tools.register({
  name: 'echo',
  description: 'Echo a message',
  schema: { type: 'object', properties: { msg: { type: 'string' } } },
  handler: async (args) => ({ success: true, data: args.msg }),
});

// Create agent loop
const loop = new AgentLoop({
  llm: myLLMProvider,                 // Your LLMProvider implementation
  systemPrompt: 'You are a helpful agent.',
  tools,
  maxTurns: 20,
});

// Run and consume events
for await (const event of loop.run('Hello!')) {
  switch (event.kind) {
    case 'text': process.stdout.write(event.content); break;
    case 'tool_call': console.log(`\n> ${event.name}`); break;
    case 'tool_result': console.log(event.content); break;
    case 'done': console.log('\nDone:', event.result); break;
  }
}
```

## Build

```bash
npm run build    # tsc
npm test         # node --test (95 tests, 20 suites)
```

## Tech Stack

- TypeScript 5.5+ (strict mode)
- Node.js 22+ (ESM)
- Zero external runtime dependencies
- Testing: `node:test` + `node:assert`

## License

MIT
