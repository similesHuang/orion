import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet, createWebhookServer } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

class FeishuFrontend extends AgentChatMixin {
  label = 'Feishu';
  source = 'feishu';
  splitLimit = 2000;
  private appId: string;
  private appSecret: string;
  private tenantToken: string | null = null;
  private tokenExpire = 0;

  constructor(agent: GenericAgentLike, appId: string, appSecret: string, allowed: Set<string>) {
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
      await fetch('https://open.feishu.cn/open-apis/im/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: chatId, content: JSON.stringify({ text: part }), msg_type: 'text' }),
      });
    }
  }

  handleWebhook(body: Record<string, unknown>): void {
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
  requireRuntime({} as GenericAgentLike, 'Feishu', { fs_app_id: appId, fs_app_secret: appSecret });

  const agent = new GenericAgent();
  agent.verbose = false;
  const frontend = new FeishuFrontend(agent, appId, appSecret, allowed);
  const port = Number(process.env.FEISHU_PORT || 8083);
  createWebhookServer(frontend, port, '{"challenge":""}');
}
export { main }
