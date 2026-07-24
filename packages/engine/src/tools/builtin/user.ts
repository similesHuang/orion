import { ToolRegistry } from '../registry.js';
import { LLMResponse } from '../../types/index.js';
import { StepOutcome } from '../../agent-loop.js';

export function registerUserTools(registry: ToolRegistry): void {
  registry.register({
    name: 'ask_user',
    description: 'Ask the user a question and wait for input',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        candidates: { type: 'array', items: { type: 'string' }, description: 'Possible answers' },
      },
      required: ['question'],
    },
    handler: async function* (args: Record<string, unknown>, _response?: LLMResponse) {
      const question = (args.question as string) || 'Please provide input:';
      const candidates = (args.candidates as string[]) || [];
      yield 'Waiting for your answer...\n';
      return new StepOutcome(
        { status: 'INTERRUPT', intent: 'HUMAN_INTERVENTION', data: { question, candidates } },
        '', true
      );
    },
  });
}
