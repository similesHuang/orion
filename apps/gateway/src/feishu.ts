import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { AgentChatMixin, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet, createWebhookServer, OrionAgent } from '@orion/core';
import type { AgentLike } from '@orion/core';

const __filename = fileURLToPath(import.meta.url);

class FeishuFrontend extends AgentChatMixin {
  label = 'Feishu';
  source = 'feishu';
  splitLimit = 2000;
  private appId: string;
  private appSecret: string;
  private tenantToken: string | null = null;
  private tokenExpire = 0;

  constructor(agent: AgentLike, appId: string, appSecret: string, allowed: Set<string>) {
    super(agent, new Map());
    this.appId = appId;
    this.appSecret = appSecret;
    this.allowed = allowed;
  }

  private async getTenantToken(): Promise<string | null> {
    if (this.tenantToken && Date.now() < this.tokenExpire) return this.tenantToken;
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!res.ok) {
      console.error(`[Feishu] token fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { tenant_access_token?: string; expire?: number };
    if (data.tenant_access_token) {
      this.tenantToken = data.tenant_access_token;
      this.tokenExpire = Date.now() + (data.expire || 7200) * 1000 - 60000;
    }
    return this.tenantToken || null;
  }

  async sendText(chatId: string, content: string): Promise<void> {
    const token = await this.getTenantToken();
    if (!token) return;
    for (const part of this.splitText(content, this.splitLimit)) {
      const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: chatId, content: JSON.stringify({ text: part }), msg_type: 'text' }),
      });
      if (!resp.ok) {
        console.error(`[Feishu] send message failed: HTTP ${resp.status}`);
      }
    }
  }

  private verifySignature(body: string, timestamp: string, nonce: string, signature: string): boolean {
    const payload = `${timestamp}\n${nonce}\n${body}`;
    const expected = crypto.createHmac('sha256', this.appSecret).update(payload).digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  handleWebhook(body: Record<string, unknown>, rawBody?: string, headers?: Record<string, string | string[] | undefined>): void {
    const timestamp = String(headers?.['x-lark-request-timestamp'] || headers?.['X-Lark-Request-Timestamp'] || body?.timestamp || '');
    const nonce = String(headers?.['x-lark-request-nonce'] || headers?.['X-Lark-Request-Nonce'] || body?.nonce || '');
    const signature = String(headers?.['x-lark-signature'] || headers?.['X-Lark-Signature'] || '');
    if (!signature || !this.verifySignature(rawBody || JSON.stringify(body), timestamp, nonce, signature)) {
      console.error('[Feishu] webhook signature verification failed');
      throw new Error('Invalid signature');
    }

    const event = (body.event || body) as Record<string, unknown>;
    const senderObj = (event.sender || {}) as Record<string, unknown>;
    const sender = String(senderObj.user_id || event.user_id || '');
    const chatId = String(event.open_chat_id || event.open_id || sender);
    const text = String(event.text || event.content || '');
    if (!this.checkAllowed(sender)) return;
    if (text.startsWith('/')) {
      void this.handleCommand(chatId, text);
    } else {
      void this.runAgent(chatId, text);
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19534, 'Feishu');
  const keys = loadMykey(__filename);
  const appId = String(keys.fs_app_id || '');
  const appSecret = String(keys.fs_app_secret || '');
  const allowed = toAllowedSet(keys.fs_allowed_users);
  requireRuntime({} as AgentLike, 'Feishu', { fs_app_id: appId, fs_app_secret: appSecret });

  const agent = new OrionAgent();
  agent.verbose = false;
  const frontend = new FeishuFrontend(agent, appId, appSecret, allowed);
  const port = Number(process.env.FEISHU_PORT || 8083);
  const host = process.env.FEISHU_HOST || '127.0.0.1';
  createWebhookServer(frontend, port, '{"challenge":""}', host);
}
export { main }
