import { AgentLoop, type AgentLoopOptions } from './agent-loop.js';
import { ToolRegistry } from './tool-registry.js';
import type { LLMProvider } from './llm-provider.js';

export interface SubAgentRequest {
  description: string;
  tools?: ToolRegistry;
  maxTurns?: number;
}

export interface SubAgentResult {
  summary: string;
  output: unknown;
  cost: { input: number; output: number; total: number };
}

export class SubAgentPool {
  private parent: AgentLoop;
  private totalInputCost = 0;
  private totalOutputCost = 0;

  constructor(parent: AgentLoop) {
    this.parent = parent;
  }

  async delegate(request: SubAgentRequest): Promise<SubAgentResult> {
    const llm = this.parent.getLLMProvider();
    const result = await createSubAgent(llm, {
      description: request.description,
      systemPrompt: undefined,
      tools: request.tools,
      maxTurns: request.maxTurns,
    });
    this.totalInputCost += result.cost.input;
    this.totalOutputCost += result.cost.output;
    return result;
  }

  getTotalCost(): { input: number; output: number; total: number } {
    return {
      input: this.totalInputCost,
      output: this.totalOutputCost,
      total: this.totalInputCost + this.totalOutputCost,
    };
  }
}

/**
 * 创建一个独立的子 AgentLoop 执行任务并返回结果
 */
export async function createSubAgent(
  llm: LLMProvider,
  options: {
    description: string;
    systemPrompt?: string;
    tools?: ToolRegistry;
    maxTurns?: number;
  }
): Promise<SubAgentResult> {
  const loop = new AgentLoop({
    llm,
    systemPrompt: options.systemPrompt ?? 'You are a focused sub-agent. Complete the task and return a concise summary.',
    tools: options.tools ?? new ToolRegistry(),
    maxTurns: options.maxTurns ?? 10,
  });

  let summary = '';
  let finalOutput: unknown = null;

  for await (const event of loop.run(options.description)) {
    if (event.kind === 'text') {
      summary += event.content;
    }
    if (event.kind === 'done') {
      finalOutput = event.data ?? event.result;
    }
  }

  return {
    summary: summary || String(finalOutput || ''),
    output: finalOutput,
    cost: { input: 0, output: 0, total: 0 },
  };
}
