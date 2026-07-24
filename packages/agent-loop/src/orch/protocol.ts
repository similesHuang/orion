import { MessageBus } from './message-bus.js';

export interface ProtocolState {
  requestId: string;
  type: string;
  sender: string;
  target: string;
  status: 'pending' | 'approved' | 'rejected';
  payload: string;
  createdAt: number;
}

export class ProtocolManager {
  private pending = new Map<string, ProtocolState>();
  private bus: MessageBus;

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  private newRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Lead → Teammate: request shutdown */
  async requestShutdown(teammate: string): Promise<void> {
    const reqId = this.newRequestId();
    this.pending.set(reqId, {
      requestId: reqId,
      type: 'shutdown',
      sender: 'lead',
      target: teammate,
      status: 'pending',
      payload: '',
      createdAt: Date.now(),
    });
    this.bus.send('lead', teammate, 'Shut down.', {
      type: 'shutdown_request',
      requestId: reqId,
    });
  }

  /** Lead → Teammate: request a plan */
  async requestPlan(teammate: string, task: string): Promise<string> {
    const reqId = this.newRequestId();
    this.pending.set(reqId, {
      requestId: reqId,
      type: 'plan_approval',
      sender: 'lead',
      target: teammate,
      status: 'pending',
      payload: task,
      createdAt: Date.now(),
    });
    this.bus.send('lead', teammate, `Submit plan for: ${task}`, {
      type: 'plan_request',
      requestId: reqId,
    });
    return reqId;
  }

  /** Lead reviews a plan */
  reviewPlan(requestId: string, approve: boolean, feedback?: string): void {
    const state = this.pending.get(requestId);
    if (!state) throw new Error(`Request ${requestId} not found`);
    state.status = approve ? 'approved' : 'rejected';
    this.bus.send('lead', state.sender, feedback ?? (approve ? 'Approved' : 'Rejected'), {
      type: 'plan_approval_response',
      requestId,
      metadata: { approve },
    });
  }

  /** Teammate → Lead: submit a plan */
  submitPlan(from: string, plan: string): string {
    const reqId = this.newRequestId();
    this.pending.set(reqId, {
      requestId: reqId,
      type: 'plan_approval',
      sender: from,
      target: 'lead',
      status: 'pending',
      payload: plan,
      createdAt: Date.now(),
    });
    this.bus.send(from, 'lead', plan, {
      type: 'plan_approval_request',
      requestId: reqId,
    });
    return reqId;
  }

  /** 处理协议响应 */
  matchResponse(type: string, requestId: string, approve: boolean): void {
    const state = this.pending.get(requestId);
    if (!state) return;
    if (state.type === 'shutdown' && type !== 'shutdown_response') return;
    if (state.type === 'plan_approval' && type !== 'plan_approval_response') return;
    state.status = approve ? 'approved' : 'rejected';
  }

  getPending(requestId: string): ProtocolState | undefined {
    return this.pending.get(requestId);
  }

  listPending(): ProtocolState[] {
    return Array.from(this.pending.values()).filter(s => s.status === 'pending');
  }
}
