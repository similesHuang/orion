import { AgentLoop } from '../core/agent-loop.js';
import { ToolRegistry } from '../core/tool-registry.js';
import type { LLMProvider } from '../core/llm-provider.js';
import type { Message } from '../core/message.js';
import { MessageBus, type InboxMessage } from './message-bus.js';
import { ProtocolManager } from './protocol.js';
import { TaskStore } from './task-store.js';

export type TeammateStatus = 'idle' | 'working' | 'waiting_approval' | 'stopped';

export interface TeammateOptions {
  name: string;
  role: 'lead' | 'worker' | 'observer';
  systemPrompt: string;
  llm: LLMProvider;
  tools?: ToolRegistry;
  bus: MessageBus;
  protocol: ProtocolManager;
  taskStore?: TaskStore;
}

export class Teammate {
  readonly name: string;
  readonly role: string;
  private loop: AgentLoop;
  private bus: MessageBus;
  private protocol: ProtocolManager;
  private taskStore?: TaskStore;
  private _status: TeammateStatus = 'idle';
  private onShutdown?: () => void;

  constructor(opts: TeammateOptions) {
    this.name = opts.name;
    this.role = opts.role;
    this.bus = opts.bus;
    this.protocol = opts.protocol;
    this.taskStore = opts.taskStore;

    this.loop = new AgentLoop({
      llm: opts.llm,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
      maxTurns: 30,
    });
  }

  get status(): TeammateStatus {
    return this._status;
  }

  get agentLoop(): AgentLoop {
    return this.loop;
  }

  /** 启动队友的主循环 */
  async start(): Promise<void> {
    this._status = 'working';

    while ((this._status as TeammateStatus) !== 'stopped') {
      // 检查收件箱
      const inbox = this.bus.readInbox(this.name);

      // 处理协议消息
      let shutdownRequested = false;
      for (const msg of inbox) {
        const handled = this.handleMessage(msg);
        if (handled === 'shutdown') {
          shutdownRequested = true;
          break;
        }
      }

      if (shutdownRequested) {
        this._status = 'stopped';
        this.onShutdown?.();
        return;
      }

      // 检查是否有协议等待（plan approval gate）
      if ((this._status as TeammateStatus) === 'waiting_approval') {
        await this.sleep(500);
        continue;
      }

      // 检查是否有未领取的任务
      if (this.taskStore && this.role === 'worker') {
        const pendingTasks = this.taskStore.list({ status: 'pending' });
        for (const task of pendingTasks) {
          const { ok } = this.taskStore.canStart(task.id);
          if (ok) {
            const claimed = this.taskStore.claim(task.id, this.name);
            if (claimed) {
              this._status = 'working';
              // 在 AgentLoop 中执行任务
              for await (const _event of this.loop.run(
                `Task: ${task.subject}\n${task.description}`
              )) {
                // 流式事件可在此处理
              }
              this.taskStore.complete(task.id);
            }
          }
        }
      }

      // 空闲时休眠
      if (this._status === 'working') {
        this._status = 'idle';
      }
      await this.sleep(1000);
    }
  }

  private handleMessage(msg: InboxMessage): 'shutdown' | 'continue' {
    const meta = msg.metadata ?? {};
    const reqId = msg.requestId;

    switch (msg.type) {
      case 'shutdown_request':
        this.bus.send(this.name, 'lead', 'Shutting down.', {
          type: 'shutdown_response',
          requestId: reqId,
          metadata: { approve: true },
        });
        return 'shutdown';

      case 'plan_approval_response':
        this._status = msg.metadata?.approve ? 'working' : 'working';
        return 'continue';

      case 'plan_request':
        // Teammate 通过 submitPlan 响应
        this.protocol.submitPlan(this.name, `Plan for: ${msg.content}`);
        this._status = 'waiting_approval';
        return 'continue';

      case 'task_assignment': {
        // 任务分配：注入到 AgentLoop 上下文
        const taskId = msg.metadata?.taskId ?? 'unknown';
        (this.loop.getMessages() as Message[]).push({
          role: 'user',
          content: `<task_assignment id="${taskId}">${msg.content}</task_assignment>`,
        });
        return 'continue';
      }

      default:
        // 其他消息追加到 AgentLoop 上下文
        (this.loop.getMessages() as Message[]).push({
          role: 'user',
          content: `<inbox>${JSON.stringify(msg)}</inbox>`,
        });
        return 'continue';
    }
  }

  async shutdown(): Promise<void> {
    this._status = 'stopped';
    this.loop.stop();
  }

  getSummary(): string {
    const msgs = this.loop.getMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        return msg.content;
      }
    }
    return '(no output)';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
