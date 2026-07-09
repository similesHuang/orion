import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet, createWebhookServer } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

class WeChatFrontend extends AgentChatMixin {
  label = 'WeChat';
  source = 'wechat';
  splitLimit = 2000;
  private token: string;
  private baseUrl = 'https://ilinkai.weixin.qq.com';

  constructor(agent: GenericAgentLike, token: string, allowed: Set<string>) {
    super(agent, new Map());
    this.token = token;
    this.allowed = allowed;
  }

  private async api(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async sendText(chatId: string, content: string): Promise<void> {
    for (const part of this.splitText(content, this.splitLimit)) {
      await this.api('/api/v1/sendmessage', { to_user: chatId, text: part });
    }
  }

  handleWebhook(body: Record<string, unknown>): void {
    const userId = String(body.from_user || '');
    const text = String(body.text || '');
    if (!this.checkAllowed(userId)) return;
    if (text.startsWith('/')) {
      void this.handleCommand(userId, text);
    } else {
      void this.runAgent(userId, text);
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19533, 'WeChat');
  const keys = loadMykey(__filename);
  const token = String(keys.wx_bot_token || '');
  const allowed = toAllowedSet(keys.wx_allowed_users);
  requireRuntime({} as GenericAgentLike, 'WeChat', { wx_bot_token: token });

  const agent = new GenericAgent();
  agent.verbose = false;
  const frontend = new WeChatFrontend(agent, token, allowed);
  const port = Number(process.env.WECHAT_PORT || 8082);
  createWebhookServer(frontend, port);
}
export { main }
