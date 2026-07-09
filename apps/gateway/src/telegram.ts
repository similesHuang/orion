import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string };
  };
}

class TelegramFrontend extends AgentChatMixin {
  label = 'Telegram';
  source = 'telegram';
  splitLimit = 4000;
  private token: string;
  private baseUrl: string;
  private offset = 0;

  constructor(agent: GenericAgentLike, token: string, allowed: Set<string>, baseUrl = 'https://api.telegram.org') {
    super(agent, new Map());
    this.token = token;
    this.allowed = allowed;
    this.baseUrl = baseUrl;
  }

  private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async sendText(chatId: string, content: string): Promise<void> {
    for (const part of this.splitText(content, this.splitLimit)) {
      await this.api('sendMessage', { chat_id: Number(chatId), text: part });
    }
  }

  async poll(): Promise<void> {
    let consecutiveErrors = 0;
    while (true) {
      try {
        const data = (await this.api('getUpdates', { offset: this.offset, limit: 10, timeout: 30 })) as { result?: TelegramUpdate[] };
        consecutiveErrors = 0;
        for (const update of data.result || []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const chatId = String(update.message?.chat.id);
          const text = update.message?.text || '';
          const userId = String(update.message?.from?.id || '');
          const username = update.message?.from?.username || '';
          if (!chatId || !this.checkAllowed([userId, username])) continue;
          if (text.startsWith('/')) {
            await this.handleCommand(chatId, text);
          } else {
            void this.runAgent(chatId, text);
          }
        }
      } catch (e) {
        consecutiveErrors++;
        const delay = Math.min(30000, 5000 * Math.min(consecutiveErrors, 6));
        console.error(`[Telegram] poll error: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19527, 'Telegram');
  const keys = loadMykey(__filename);
  const token = String(keys.tg_bot_token || '');
  const allowed = toAllowedSet(keys.tg_allowed_users);
  requireRuntime({} as GenericAgentLike, 'Telegram', { tg_bot_token: token });

  const agent = new GenericAgent();
  agent.verbose = false;
  const frontend = new TelegramFrontend(agent, token, allowed);
  console.log('[Telegram] polling started');
  await frontend.poll();
}
export { main }
