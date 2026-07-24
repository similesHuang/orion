export interface InboxMessage {
  from: string;
  content: string;
  type: string;
  requestId?: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export type SendOptions = {
  type?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

export class MessageBus {
  private mailboxes = new Map<string, InboxMessage[]>();

  send(from: string, to: string, content: string, opts?: SendOptions): void {
    const msg: InboxMessage = {
      from,
      content,
      type: opts?.type ?? 'message',
      requestId: opts?.requestId,
      metadata: opts?.metadata ?? {},
      timestamp: Date.now(),
    };
    const inbox = this.mailboxes.get(to);
    if (inbox) {
      inbox.push(msg);
    } else {
      this.mailboxes.set(to, [msg]);
    }
  }

  /** 读取并清空收件箱 */
  readInbox(agent: string): InboxMessage[] {
    const inbox = this.mailboxes.get(agent);
    if (!inbox) return [];
    this.mailboxes.delete(agent);
    return inbox;
  }

  /** 查看不消费 */
  peek(agent: string): InboxMessage[] {
    return this.mailboxes.get(agent) ?? [];
  }

  /** 清空所有邮箱 */
  clear(): void {
    this.mailboxes.clear();
  }
}
