import fs from 'fs';
import path from 'path';
import type { Message } from '../agent/index.js';
import type { GenericAgentLike, SessionInfo } from './index.js';
import { listSessions, snapshotCurrentLog } from './index.js';
import {
  extractAssistantSummary,
  extractAssistantText,
  extractUserText,
  parseModelResponsePairs,
  readFileSafe,
  relTime,
} from './history-utils.js';

function previewText(pairsList: ReturnType<typeof parseModelResponsePairs>): string {
  for (const { response } of [...pairsList].reverse()) {
    const summary = extractAssistantSummary(response);
    if (summary) return summary;
  }
  return extractUserText(pairsList[0]?.prompt || '');
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_\[\]])/g, '\\$1');
}

function parseNativeHistory(pairsList: ReturnType<typeof parseModelResponsePairs>): Message[] | null {
  const history: Message[] = [];
  for (const { prompt, response } of pairsList) {
    try {
      const userMsg = JSON.parse(prompt) as Message;
      const blocks = JSON.parse(response) as Message['content'];
      if (userMsg.role !== 'user') return null;
      if (!Array.isArray(blocks)) return null;
      history.push(userMsg);
      history.push({ role: 'assistant', content: blocks });
    } catch {
      return null;
    }
  }
  return history;
}

function agentClients(agent: GenericAgentLike): Array<{ backend?: { history?: Message[] }; lastTools?: string }> {
  const clients: Array<{ backend?: { history?: Message[] }; lastTools?: string }> = [];
  if ('llmclients' in agent && Array.isArray((agent as unknown as { llmclients?: unknown[] }).llmclients)) {
    for (const c of (agent as unknown as { llmclients: Array<{ backend?: { history?: Message[] } }> }).llmclients) {
      if (!clients.includes(c)) clients.push(c);
    }
  }
  if (agent.client && !clients.includes(agent.client as unknown as { backend?: { history?: Message[] } })) {
    clients.unshift(agent.client as unknown as { backend?: { history?: Message[] } });
  }
  return clients;
}

export function listSessionsFull(excludePid = process.pid): SessionInfo[] {
  return listSessions(excludePid).map((s) => {
    const content = readFileSafe(s.path);
    if (content === null) return s;
    const p = parseModelResponsePairs(content);
    const preview = previewText(p);
    return { ...s, preview };
  });
}

export function formatSessionList(sessions: SessionInfo[], limit = 20): string {
  if (!sessions.length) return '❌ 没有可恢复的历史会话';
  const lines = ['**可恢复会话**（输入 `/continue N` 恢复第 N 个）：', ''];
  for (let i = 0; i < Math.min(sessions.length, limit); i++) {
    const s = sessions[i];
    const preview = escapeMd((s.preview || '（无法预览）').replace(/\n/g, ' ').slice(0, 60));
    lines.push(`${i + 1}. \`${relTime(s.mtime)}\` · **${s.rounds} 轮** · ${preview}`);
  }
  return lines.join('\n');
}

export function restoreSession(agent: GenericAgentLike, sessionPath: string): [string, boolean] {
  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const p = parseModelResponsePairs(content);
    if (!p.length) return [`❌ ${path.basename(sessionPath)} 为空或格式不符`, false];
    const history = parseNativeHistory(p);
    const name = path.basename(sessionPath);
    if (history !== null) {
      agent.abort();
      const backend = (agent.client as unknown as { backend?: { history?: Message[] } })?.backend;
      if (backend) backend.history = history;
      return [`✅ 已恢复 ${p.length} 轮完整对话（${name}）\n(已写入 backend.history，可直接继续)`, true];
    }
    const summary = restoreTextHistory(content);
    if (!summary) return [`❌ ${name} 无法解析（非 native 且无摘要可提取）`, false];
    agent.abort();
    agent.history.push(...summary);
    const n = summary.filter((l) => l.startsWith('[USER]: ')).length;
    return [`⚠️ 非 native 格式，已降级恢复 ${n} 轮摘要（${name}）\n(请输入新问题继续)`, false];
  } catch (e) {
    return [`❌ 读取失败: ${e instanceof Error ? e.message : String(e)}`, false];
  }
}

function restoreTextHistory(content: string): string[] {
  const out: string[] = [];
  for (const { prompt, response } of parseModelResponsePairs(content)) {
    const u = extractUserText(prompt);
    if (u) out.push(`[USER]: ${u.slice(0, 500)}`);
    const a = extractAssistantText(response).slice(0, 500);
    if (a) out.push(`[Agent] ${a}`);
  }
  return out;
}

export function extractUiMessages(sessionPath: string): Array<{ role: string; content: string }> {
  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const p = parseModelResponsePairs(content);
    const rounds: Array<[string, string[]]> = [];
    for (const { prompt, response } of p) {
      const user = extractUserText(prompt);
      if (user || !rounds.length) rounds.push([user, []]);
      rounds[rounds.length - 1][1].push(extractAssistantText(response));
    }
    const out: Array<{ role: string; content: string }> = [];
    for (const [user, turns] of rounds) {
      if (!user || !turns.some((t) => t)) continue;
      const body = turns
        .map((t, i) => (i === 0 ? t : `**LLM Running (Turn ${i + 1}) ...**\n\n${t}`))
        .join('\n\n');
      out.push({ role: 'user', content: user });
      out.push({ role: 'assistant', content: body });
    }
    return out;
  } catch {
    return [];
  }
}

export function handleContinueFrontend(agent: GenericAgentLike, cmd: string): string {
  const s = cmd.trim();
  const excludePid = process.pid;
  if (s === '/continue') {
    return formatSessionList(listSessionsFull(excludePid));
  }
  const m = s.match(/^\/continue\s+(\d+)\s*$/);
  if (!m) return '用法: /continue 或 /continue N';
  const sessions = listSessionsFull(excludePid);
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= sessions.length) {
    return `❌ 索引越界（有效范围 1-${sessions.length}）`;
  }
  resetConversation(agent, null);
  const [msg] = restoreSession(agent, sessions[idx].path);
  return msg;
}

export function resetConversation(agent: GenericAgentLike, message: string | null = '🆕 已开启新对话，当前上下文已清空'): string {
  try {
    agent.abort();
  } catch {}
  snapshotCurrentLog(process.pid);
  agent.history.length = 0;
  for (const client of agentClients(agent)) {
    if (client.backend?.history) client.backend.history = [];
    if (client.lastTools !== undefined) client.lastTools = '';
  }
  if ('handler' in agent) (agent as unknown as { handler?: unknown }).handler = null;
  return message ?? '';
}

export function installContinue(_agentClass: new () => GenericAgentLike): void {
  // No-op: TS GenericAgent already exposes history/abort via class interface.
}
