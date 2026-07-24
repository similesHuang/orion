import type { OrionAgent } from '../orion-agent.js';
import type { TokenStats } from '../cost-tracker.js';

export interface SubAgentRequest {
  prompt: string;
}

export interface SubAgentResult {
  output: string;
  usage: TokenStats;
  toolCalls: string[];
}

export async function delegate(
  parent: OrionAgent,
  request: SubAgentRequest
): Promise<SubAgentResult> {
  const result = await parent.delegate(request);
  return {
    output: result.output,
    usage: result.usage,
    toolCalls: result.toolCalls as string[],
  };
}
