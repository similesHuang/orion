import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet, createWebhookServer } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

class DingTalkFrontend extends AgentChatMixin {
  label = 'DingTalk';
  source = 'dingtalk';
  splitLimit = 2000;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpire = 0;

  constructor(agent: GenericAgentLike, clientId: string, clientSecret: string, allowed: Set<string>) {
    super(agent, new Map());
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.allowed = allowed;
  }

  private async getToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpire) return this.accessToken;
    const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
    });
    if (!res.ok) {
      console.error(`[DingTalk] token fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { accessToken?: string; expireIn?: number };
    if (data.accessToken) {
      this.accessToken = data.accessToken;
      this.tokenExpire = Date.now() + (data.expireIn || 7200) * 1000 - 60000;
    }
    return this.accessToken || null;
  }

  async sendText(chatId: string, content: string): Promise<void> {
    const token = await this.getToken();
    if (!token) return;
    for (const part of this.splitText(content, this.splitLimit)) {
      await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
        body: JSON.stringify({ robotCode: this.clientId, userIds: [chatId], msgKey: 'sampleText', msgParam: JSON.stringify({ content: part }) }),
      });
    }
  }

  handleWebhook(body: Record<string, unknown>): void {
    const userId = String(body.senderStaffId || body.senderUnionId || '');
    const chatId = userId;
    const text = String((body.content as Record<string, string>)?.text || body.text || '');
    if (!this.checkAllowed(userId)) return;
    if (text.startsWith('/')) {
      void this.handleCommand(chatId, text);
    } else {
      void this.runAgent(chatId, text);
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19530, 'DingTalk');
  const keys = loadMykey(__filename);
  const clientId = String(keys.dingtalk_client_id || '');
  const clientSecret = String(keys.dingtalk_client_secret || '');
  const allowed = toAllowedSet(keys.dingtalk_allowed_users);
  requireRuntime({} as GenericAgentLike, 'DingTalk', { dingtalk_client_id: clientId, dingtalk_client_secret: clientSecret });

  const agent = new GenericAgent();
  agent.verbose = false;
  const frontend = new DingTalkFrontend(agent, clientId, clientSecret, allowed);
  const port = Number(process.env.DINGTALK_PORT || 8084);
  createWebhookServer(frontend, port);
}
export { main }
