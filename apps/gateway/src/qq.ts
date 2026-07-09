import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet, createWebhookServer } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

class QQFrontend extends AgentChatMixin {
  label = 'QQ';
  source = 'qq';
  splitLimit = 2000;
  private appId: string;
  private appSecret: string;
  private accessToken: string | null = null;
  private tokenExpire = 0;
  private msgSeq = 1;

  constructor(agent: GenericAgentLike, appId: string, appSecret: string, allowed: Set<string>) {
    super(agent, new Map());
    this.appId = appId;
    this.appSecret = appSecret;
    this.allowed = allowed;
  }

  private async getToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpire) return this.accessToken;
    const params = new URLSearchParams();
    params.append('appid', this.appId);
    params.append('client_secret', this.appSecret);
    params.append('grant_type', 'client_credentials');
    const res = await fetch(`https://bots.qq.com/app/getAppAccessToken?${params.toString()}`);
    if (!res.ok) {
      console.error(`[QQ] token fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (data.access_token) {
      this.accessToken = data.access_token;
      this.tokenExpire = Date.now() + (data.expires_in || 7200) * 1000 - 60000;
    }
    return this.accessToken || null;
  }

  async sendText(chatId: string, content: string): Promise<void> {
    const token = await this.getToken();
    if (!token) return;
    for (const part of this.splitText(content, this.splitLimit)) {
      await fetch('https://api.sgroup.qq.com/v2/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
        body: JSON.stringify({ openid: chatId, msg_type: 0, content: part, msg_seq: this.msgSeq++ }),
      });
    }
  }

  handleWebhook(body: Record<string, unknown>): void {
    const author = (body.author || {}) as Record<string, unknown>;
    const userId = String(author.id || body.d_author_id || '');
    const chatId = String(author.id || body.group_openid || '');
    const text = String(body.content || '');
    if (!this.checkAllowed(userId)) return;
    if (text.startsWith('/')) {
      void this.handleCommand(chatId, text);
    } else {
      void this.runAgent(chatId, text);
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19528, 'QQ');
  const keys = loadMykey(__filename);
  const appId = String(keys.qq_app_id || '');
  const appSecret = String(keys.qq_app_secret || '');
  const allowed = toAllowedSet(keys.qq_allowed_users);
  requireRuntime({} as GenericAgentLike, 'QQ', { qq_app_id: appId, qq_app_secret: appSecret });

  const agent = new GenericAgent();
  agent.verbose = false;
  const frontend = new QQFrontend(agent, appId, appSecret, allowed);
  const port = Number(process.env.QQ_PORT || 8085);
  createWebhookServer(frontend, port);
}
export { main }
