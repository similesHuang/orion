import type { Message } from '../agent/index.js';
import type { BaseSession, LLMResponse, LLMStreamDelta } from '../types/index.js';
import type { AgentLike } from './index.js';

const WRAPPER_ZH = `<system-reminder>
这是用户的临时插问 (side question)。主 agent 仍在后台运行，**不会被打断**。

身份与边界：
- 你是一个独立的轻量 sub-agent
- 上下文里能看到主 agent 与用户的完整对话、最近的工具调用与结果
- 用户在问当前进展或顺便确认某事——基于已有信息**一次性**作答
- 没有任何工具可用：不要"让我查一下" / "我去试试" / 任何承诺动作
- 信息不足就坦白说"基于目前对话我不知道"

侧问内容如下：
</system-reminder>

{question}`;

const WRAPPER_EN = `<system-reminder>
This is a side question from the user. The main agent is NOT interrupted — it continues in the background.

Identity & boundaries:
- You are an independent lightweight sub-agent
- You can see the full conversation between the main agent and the user, plus recent tool calls/results
- The user is asking about current progress or a quick aside — answer in **one shot** from existing info
- You have NO tools — never say "let me check" / "I'll try" / any action promise
- If info is missing, just say "based on the conversation I don't know"

Question:
</system-reminder>

{question}`;

const TIMEOUT_SEC = 120;

function wrapper(): string {
  return process.env.GA_LANG === 'en' ? WRAPPER_EN : WRAPPER_ZH;
}

function stripCmd(query: string): string {
  const s = (query || '').trim();
  return s.startsWith('/btw') ? s.slice(4).trim() : s;
}

function helpText(): string {
  return (
    '**/btw 用法**：side question — 临时问主 agent 当前进展，不打断主线\n\n' +
    '`/btw <你的问题>`\n\n' +
    '行为：抓取当前对话上下文 → 单轮纯文本作答（无工具）→ 主 agent 历史不变。'
  );
}

function formatResult(question: string, body: string, took: number): string {
  const head = `> 🟡 /btw ${question}\n\n`;
  return head + (body.trim() || '*(空回复)*') + `\n\n*(${took.toFixed(1)}s)*`;
}

async function snapshotHistory(backend: { history: Message[]; lock?: unknown }): Promise<Message[]> {
  return JSON.parse(JSON.stringify(backend.history)) as Message[];
}

async function askSide(agent: AgentLike, question: string, deadline: number): Promise<string> {
  const backend = agent.client.backend as BaseSession;
  const userMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: wrapper().replace('{question}', question) }],
  };
  const history = await snapshotHistory(backend);
  const msgs = backend.makeMessages([...history, userMsg]);
  const gen = backend.rawAsk(msgs);
  let text = '';
  let timedOut = false;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        gen.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('/btw timeout')), Math.max(1, remaining))
        ),
      ]);
      if (chunk.done) break;
      const value = chunk.value as LLMStreamDelta;
      if (value.kind === 'text') text += value.delta;
      else if (value.kind === 'thinking') text += value.delta;
    }
    if (Date.now() >= deadline) {
      timedOut = true;
      text += '\n\n⚠️ /btw 超时，仅返回部分回复。';
    }
  } catch (e) {
    if (timedOut || (e instanceof Error && e.message === '/btw timeout')) {
      text += '\n\n⚠️ /btw 超时，仅返回部分回复。';
    } else {
      return `❌ /btw 失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  } finally {
    if (timedOut) {
      try {
        const dummyResponse: LLMResponse = { content: '', thinking: '', tool_calls: [], raw: '', stop_reason: 'stop' };
        await gen.return(dummyResponse);
      } catch {
        // ignore cleanup errors
      }
    }
  }
  return text;
}

export function handleBtwFrontend(agent: AgentLike, query: string): string {
  const question = stripCmd(query);
  if (!question || ['help', '?', '-h', '--help'].includes(question)) {
    return helpText();
  }
  // Synchronous return not possible for async; callers should await.
  return `(async /btw result pending — use handleBtwAsync instead)`;
}

export async function handleBtwAsync(agent: AgentLike, query: string): Promise<string> {
  const question = stripCmd(query);
  if (!question || ['help', '?', '-h', '--help'].includes(question)) {
    return helpText();
  }
  const started = Date.now();
  const deadline = started + TIMEOUT_SEC * 1000;
  const body = await askSide(agent, question, deadline);
  return formatResult(question, body, (Date.now() - started) / 1000);
}
