import type { Message } from './message.js';
import { AgentLoop, type AgentLoopOptions } from './agent-loop.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';

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

  static saveToFile(loop: AgentLoop, path: string): void {
    const state = this.serialize(loop);
    // 文件写入在 Node.js 环境中
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  }

  static loadFromFile(path: string): AgentState {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as AgentState;
  }

  static deserialize(state: AgentState): { messages: Message[]; turn: number } {
    return {
      messages: state.messages,
      turn: state.turn,
    };
  }
}
