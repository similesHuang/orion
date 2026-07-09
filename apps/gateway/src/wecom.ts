import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet, createWebhookServer } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

interface WeComMessage {
  FromUserName?: string;
  MsgType?: string;
  Content?: string;
  ChatId?: string;
}

class WeComFrontend extends AgentChatMixin {
  label = 'WeCom';
  source = 'wecom';
  splitLimit = 2000;
  private botId: string;
  private secret: string;
  private accessToken: string | null = null;
  private tokenExpire = 0;

  constructor(agent: GenericAgentLike, botId: string, secret: string, allowed: Set<string>) {
    super(agent, new Map());
    this.botId = botId;
    this.secret = secret;
    this.allowed = allowed;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpire) return this.accessToken;
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.botId)}&corpsecret=${encodeURIComponent(this.secret)}`);
    if (!res.ok) {
      console.error(`[WeCom] token fetch failed: HTTP ${res.status}`);
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
    const token = await this.getAccessToken();
    if (!token) return;
    for (const part of this.splitText(content, this.splitLimit)) {
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: chatId, msgtype: 'text', text: { content: part } }),
      });
    }
  }

  handleWebhook(body: Record<string, unknown>): void {
    const msg = body as unknown as WeComMessage;
    const userId = msg.FromUserName || '';
    const chatId = userId;
    const text = msg.Content || '';
    if (!this.checkAllowed(userId)) return;
    if (text.startsWith('/')) {
      void this.handleCommand(chatId, text);
    } else {
      void this.runAgent(chatId, text);
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19531, 'WeCom');
  const keys = loadMykey(__filename);
  const botId = String(keys.wecom_bot_id || '');
  const secret = String(keys.wecom_secret || '');
  const allowed = toAllowedSet(keys.wecom_allowed_users);
  requireRuntime({} as GenericAgentLike, 'WeCom', { wecom_bot_id: botId, wecom_secret: secret });

  const agent = new GenericAgent();
  agent.verbose = false;
  const frontend = new WeComFrontend(agent, botId, secret, allowed);
  const port = Number(process.env.WECOM_PORT || 8080);
  createWebhookServer(frontend, port);
}
export { main }
