import { Message, AgentState } from '../types/index.js';

export function saveAgentState(
  messages: Message[],
  working: Record<string, unknown>,
  historyInfo: string[],
  turn: number,
): AgentState {
  return {
    version: 1,
    messages: messages.map(m => ({
      ...m,
      content: Array.isArray(m.content) ? [...m.content] : m.content,
    })),
    working: { ...working },
    historyInfo: [...historyInfo],
    turn,
    createdAt: Date.now(),
  };
}

export function restoreAgentState(state: AgentState): {
  messages: Message[];
  working: Record<string, unknown>;
  historyInfo: string[];
  turn: number;
} {
  if (state.version !== 1) {
    throw new Error(`Unsupported AgentState version: ${state.version}`);
  }
  return {
    messages: state.messages.map(m => ({ ...m })),
    working: { ...state.working },
    historyInfo: [...state.historyInfo],
    turn: state.turn,
  };
}

export function serializeAgentState(state: AgentState): string {
  return JSON.stringify(state);
}

export function deserializeAgentState(json: string): AgentState {
  const parsed = JSON.parse(json);
  if (!parsed.version || !Array.isArray(parsed.messages)) {
    throw new Error('Invalid serialized AgentState');
  }
  return parsed as AgentState;
}
