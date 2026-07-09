import { fileURLToPath } from 'url';
import { AgentChatMixin, GenericAgentLike, loadMykey, ensureSingleInstance, requireRuntime, toAllowedSet } from '@orion/chat';
import { GenericAgent } from '@orion/agent';

const __filename = fileURLToPath(import.meta.url);

interface DiscordMessage {
  id: string;
  channel_id: string;
  author?: { id: string; username: string; bot?: boolean };
  content?: string;
  guild_id?: string;
}

class DiscordFrontend extends AgentChatMixin {
  label = 'Discord';
  source = 'discord';
  splitLimit = 2000;
  private token: string;

  constructor(agent: GenericAgentLike, token: string, allowed: Set<string>) {
    super(agent, new Map());
    this.token = token;
    this.allowed = allowed;
  }

  private async api(path: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  async sendText(chatId: string, content: string): Promise<void> {
    for (const part of this.splitText(content, this.splitLimit)) {
      await this.api(`/channels/${chatId}/messages`, 'POST', { content: part });
    }
  }

  handleMessage(msg: DiscordMessage): void {
    const chatId = msg.channel_id;
    const text = msg.content || '';
    if (msg.author?.bot) return;
    if (!chatId || !this.checkAllowed([msg.author?.id || '', msg.author?.username || ''])) return;
    if (text.startsWith('/')) {
      void this.handleCommand(chatId, text);
    } else {
      void this.runAgent(chatId, text);
    }
  }
}

async function main(): Promise<void> {
  ensureSingleInstance(19532, 'Discord');
  const keys = loadMykey(__filename);
  const token = String(keys.discord_bot_token || '');
  const allowed = toAllowedSet(keys.discord_allowed_users);
  requireRuntime({} as GenericAgentLike, 'Discord', { discord_bot_token: token });

  const agent = new GenericAgent();
  agent.verbose = false;
  new DiscordFrontend(agent, token, allowed);
  console.log('[Discord] NOTE: gateway client not implemented; use Discord webhook/HTTP adapter or add discord.js.');
  console.log('[Discord] bot token validated; implement gateway listener to receive messages.');
}
export { main }
