import { Teammate, type TeammateOptions, type TeammateStatus } from './teammate.js';
import { MessageBus } from './message-bus.js';
import { ProtocolManager } from './protocol.js';
import { TaskStore, type Task } from './task-store.js';
import type { SubAgentResult } from '../core/sub-agent.js';

export interface TeamSnapshot {
  members: Array<{
    name: string;
    role: string;
    status: TeammateStatus;
    currentTask?: string;
  }>;
  pendingProtocols: number;
}

export interface TeamConfig {
  lead: TeammateOptions;
  workers?: TeammateOptions[];
}

export class TeamOrchestrator {
  private members = new Map<string, Teammate>();
  private bus: MessageBus;
  private protocol: ProtocolManager;
  private taskStore?: TaskStore;
  private lead: Teammate;

  constructor(config: TeamConfig, taskStore?: TaskStore) {
    this.bus = new MessageBus();
    this.protocol = new ProtocolManager(this.bus);
    this.taskStore = taskStore;

    // 创建 lead
    const leadOpts = { ...config.lead, bus: this.bus, protocol: this.protocol, taskStore: this.taskStore };
    this.lead = new Teammate(leadOpts);
    this.members.set(leadOpts.name, this.lead);

    // 创建 workers
    for (const opts of config.workers ?? []) {
      const workerOpts = { ...opts, bus: this.bus, protocol: this.protocol, taskStore: this.taskStore };
      this.addMember(new Teammate(workerOpts));
    }
  }

  getLead(): Teammate {
    return this.lead;
  }

  addMember(teammate: Teammate): void {
    this.members.set(teammate.name, teammate);
  }

  removeMember(name: string): boolean {
    return this.members.delete(name);
  }

  getMember(name: string): Teammate | undefined {
    return this.members.get(name);
  }

  /** 异步启动所有成员 */
  async startAll(): Promise<void> {
    const startPromises: Promise<void>[] = [];
    for (const member of this.members.values()) {
      startPromises.push(member.start());
    }
    await Promise.all(startPromises);
  }

  /** 派发任务给指定队友 */
  async assignTask(teammateName: string, task: Task): Promise<{ ok: boolean; error?: string }> {
    const teammate = this.members.get(teammateName);
    if (!teammate) return { ok: false, error: `Teammate not found: ${teammateName}` };

    this.bus.send('lead', teammateName, `New task: ${task.subject}\n${task.description}`, {
      type: 'task_assignment',
      metadata: { taskId: task.id },
    });

    return { ok: true };
  }

  /** 广播消息给所有成员 */
  broadcast(from: string, content: string): void {
    for (const [name] of this.members) {
      if (name !== from) {
        this.bus.send(from, name, content);
      }
    }
  }

  /** 获取团队快照 */
  getSnapshot(): TeamSnapshot {
    return {
      members: Array.from(this.members.values()).map(m => ({
        name: m.name,
        role: m.role,
        status: m.status,
      })),
      pendingProtocols: this.protocol.listPending().length,
    };
  }

  /** 关闭整个团队 */
  async disband(): Promise<void> {
    const shutdowns: Promise<void>[] = [];
    for (const member of this.members.values()) {
      shutdowns.push(member.shutdown());
    }
    await Promise.all(shutdowns);
    this.members.clear();
    this.bus.clear();
  }
}
