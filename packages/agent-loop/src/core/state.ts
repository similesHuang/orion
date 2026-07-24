import type { Message } from './message.js';
import { AgentLoop, type AgentLoopOptions } from './agent-loop.js';
import { writeFile, readFile } from 'fs/promises';

export interface AgentState {
  version: string;
  messages: Message[];
  turn: number;
  timestamp: number;
}

export class StateSerializer {
  static serialize(loop: AgentLoop): AgentState {
    return {
      version: '0.1.0',
      messages: [...loop.getMessages()],
      turn: loop.getTurn(),
      timestamp: Date.now(),
    };
  }

  static async saveToFile(loop: AgentLoop, path: string): Promise<void> {
    const state = this.serialize(loop);
    await writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
  }

  static async loadFromFile(path: string): Promise<AgentState> {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as AgentState;
  }

  static deserialize(state: AgentState): { messages: Message[]; turn: number } {
    return {
      messages: state.messages,
      turn: state.turn,
    };
  }
}
