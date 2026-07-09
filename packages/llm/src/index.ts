import fs from 'fs';
import path from 'path';
import {
  BaseSession,
  ChatOptions,
  ContentBlock,
  ContentBlockToolResult,
  ContentBlockToolUse,
  LLMResponse,
  Message,
  SessionConfig,
  ToolCall,
  ToolDefinition,
} from '@orion/types';
import { envToSessionConfigs, loadEnv } from './env-config.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const llmLogHooks: Array<(label: 'Prompt' | 'Response', content: string) => void> = [];
export const llmUsageHooks: Array<(usage: Record<string, number>) => void> = [];

function emitUsage(usage: Record<string, number>): void {
  if (!Object.keys(usage).length) return;
  recordUsage(usage);
  for (const h of llmUsageHooks) {
    try {
      h(usage);
    } catch {
      // ignore plugin errors
    }
  }
}

function recordUsage(usage: Record<string, number>): void {
  if (!usage || !Object.keys(usage).length) return;
  const out = usage.output ?? usage.completion_tokens ?? 0;
  if (usage.cache_creation_input_tokens !== undefined || usage.cache_read_input_tokens !== undefined) {
    const inp = usage.input ?? usage.input_tokens ?? 0;
    const cc = usage.cache_creation_input_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? 0;
    console.log(`[Cache] input=${inp} creation=${cc} read=${cr}`);
  } else if (usage.input !== undefined || usage.input_tokens !== undefined) {
    const inp = usage.input ?? usage.input_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0;
    console.log(`[Cache] input=${inp} cached=${cr}`);
  }
  if (out) console.log(`[Output] tokens=${out}`);
}

function writeLlmLog(label: string, content: string): void {
  const logDir = path.join(process.cwd(), 'temp', 'model_responses');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `model_responses_${process.pid}.txt`);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(logPath, `=== ${label} === ${ts}\n${content}\n\n`, 'utf-8');
  for (const h of llmLogHooks) {
    try {
      h(label as 'Prompt' | 'Response', content);
    } catch {
      // ignore plugin errors
    }
  }
}

function autoMakeUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (b.endsWith('$')) return b.slice(0, -1).replace(/\/+$/, '');
  if (b.endsWith(p)) return b;
  return b.match(/\/v\d+(\/|$)/) ? `${b}/${p}` : `${b}/v1/${p}`;
}

function jsonSize(obj: unknown): number {
  return JSON.stringify(obj).length;
}

function compressHistoryTags(messages: Message[], keepRecent = 10, maxLen = 800): Message[] {
  const histPat = /<(history|key_info|earlier_context)>[\s\S]*?<\/\1>/g;
  const tagPats = ['thinking', 'think', 'tool_use', 'tool_result'].map(
    (tag) => ({
      tag,
      re: new RegExp(`(<${tag}>)([\\s\\S]*?)(<\\/${tag}>)`, 'g'),
    })
  );

  function truncStr(s: string): string {
    if (s.length <= maxLen) return s;
    return `${s.slice(0, Math.floor(maxLen / 2))}\n...[Truncated]...\n${s.slice(-Math.floor(maxLen / 2))}`;
  }

  function trunc(text: string): string {
    text = text.replace(histPat, '<$1>[...]</$1>');
    for (const { re } of tagPats) {
      text = text.replace(re, (_, open, body, close) => `${open}${truncStr(body)}${close}`);
    }
    return text;
  }

  const limit = messages.length - keepRecent;
  for (let i = 0; i < Math.max(0, limit); i++) {
    const msg = messages[i];
    const c = msg.content;
    if (typeof c === 'string') {
      msg.content = trunc(c);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && typeof b.text === 'string') b.text = trunc(b.text);
        else if (b.type === 'tool_result' && typeof b.content === 'string') b.content = truncStr(b.content);
        else if (b.type === 'tool_use' && typeof b.input === 'object' && b.input) {
          for (const [k, v] of Object.entries(b.input)) {
            if (typeof v === 'string') (b.input as Record<string, unknown>)[k] = truncStr(v);
          }
        }
      }
    }
  }
  return messages;
}

function sanitizeLeadingUserMsg(msg: Message): Message {
  const content = msg.content;
  if (!Array.isArray(content)) return msg;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const c = block.content;
      if (Array.isArray(c)) texts.push(...c.map((b) => (b as { text?: string }).text ?? '').filter(Boolean));
      else texts.push(String(c));
    } else if (block.type === 'text') {
      texts.push(block.text ?? '');
    }
  }
  return { ...msg, content: [{ type: 'text', text: texts.filter(Boolean).join('\n') }] };
}

export function trimMessagesHistory(history: Message[], contextWin: number): void {
  compressHistoryTags(history);
  let cost = history.reduce((sum, m) => sum + jsonSize(m), 0);
  if (cost <= contextWin * 3) return;
  compressHistoryTags(history, 4, 500);
  const target = contextWin * 3 * 0.6;
  while (history.length > 5 && cost > target) {
    history.shift();
    while (history.length && history[0].role !== 'user') history.shift();
    if (history.length && history[0].role === 'user') {
      history[0] = sanitizeLeadingUserMsg(history[0]);
    }
    cost = history.reduce((sum, m) => sum + jsonSize(m), 0);
  }
}

async function* streamWithRetry(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  maxRetries: number,
  connectTimeout: number
): AsyncGenerator<string, Response, unknown> {
  const retryable = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), connectTimeout * 1000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        if (retryable.has(resp.status) && attempt < maxRetries) {
          const delay = Math.min(30, 1.5 * 2 ** attempt);
          console.log(`[LLM Retry] HTTP ${resp.status}, retry in ${delay.toFixed(1)}s (${attempt + 1}/${maxRetries + 1})`);
          await sleep(delay * 1000);
          continue;
        }
        const err = `!!!Error: HTTP ${resp.status}${body ? `: ${body.slice(0, 500)}` : ''}`;
        yield err;
        throw new Error(err);
      }
      return resp;
    } catch (e) {
      clearTimeout(timeoutId);
      const errName = e instanceof Error ? e.name : String(e);
      const errMsg = e instanceof Error ? e.message : String(e);
      const isRetryableNetwork =
        errName === 'AbortError' ||
        errName === 'TypeError' ||
        /network|fetch|timeout|connection|abort|chunked|reset/i.test(errMsg);
      if (isRetryableNetwork && attempt < maxRetries) {
        const delay = Math.min(30, 1.5 * 2 ** attempt);
        console.log(`[LLM Retry] ${errName}, retry in ${delay.toFixed(1)}s (${attempt + 1}/${maxRetries + 1})`);
        await sleep(delay * 1000);
        continue;
      }
      if (errName.startsWith('!!!Error:')) throw e;
      yield `!!!Error: ${errName}`;
      throw e;
    }
  }
  throw new Error('Max retries exceeded');
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw.trim().replace(/^`+/, '').replace(/`+$/, '').replace(/^json\n?/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      if (cleaned.endsWith(',')) try { return JSON.parse(cleaned.slice(0, -1)); } catch {}
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace > 0) try { return JSON.parse(cleaned.slice(0, lastBrace + 1)); } catch {}
    }
  }
  throw new Error('JSON parse failed');
}

async function* sseLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line) yield line;
      }
    }
    const rest = buffer.trim();
    if (rest) yield rest;
  } catch (e) {
    yield `data: {"type":"error","error":{"message":"${String(e)}"}}`;
  }
}

async function* parseOpenAISSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  apiMode: 'chat_completions' | 'responses'
): AsyncGenerator<string, LLMResponse, unknown> {
  const tcBuf: Record<number, { id: string; name: string; args: string }> = {};
  const fcBuf: Record<number, { id: string; name: string; args: string }> = {};
  let currentFcIdx = 0;
  let contentText = '';
  let reasoningText = '';
  let warn = '';
  const usage: Record<string, number> = {};

  for await (const line of sseLines(reader)) {
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trim();
    if (dataStr === '[DONE]') break;
    try {
      const evt = JSON.parse(dataStr);
      const us = evt.usage || evt.response?.usage;
      if (us) {
        if (us.prompt_tokens) usage.input = us.prompt_tokens;
        if (us.input_tokens) usage.input = us.input_tokens;
        if (us.completion_tokens) usage.output = us.completion_tokens;
        if (us.output_tokens) usage.output = us.output_tokens;
        const cr = us.prompt_tokens_details?.cached_tokens || us.cached_tokens;
        if (cr) usage.cache_read_input_tokens = cr;
        if (us.cache_creation_input_tokens) usage.cache_creation_input_tokens = us.cache_creation_input_tokens;
        if (us.cache_read_input_tokens) usage.cache_read_input_tokens = us.cache_read_input_tokens;
      }
      if (apiMode === 'responses') {
        const etype = evt.type;
        if (etype === 'response.output_text.delta') {
          contentText += evt.delta ?? '';
          if (evt.delta) yield evt.delta;
        } else if (etype === 'response.output_text.done' && !contentText) {
          contentText += evt.text ?? '';
          if (evt.text) yield evt.text;
        } else if (etype === 'response.output_item.added') {
          const item = evt.item ?? {};
          if (item.type === 'function_call') {
            const idx = evt.output_index ?? 0;
            fcBuf[idx] = { id: item.call_id || item.id || '', name: item.name || '', args: '' };
            currentFcIdx = idx;
          }
        } else if (etype === 'response.function_call_arguments.delta') {
          const idx = evt.output_index ?? currentFcIdx ?? 0;
          if (idx in fcBuf) fcBuf[idx].args += evt.delta ?? '';
        } else if (etype === 'response.function_call_arguments.done') {
          const idx = evt.output_index ?? currentFcIdx ?? 0;
          if (idx in fcBuf) fcBuf[idx].args = evt.arguments ?? fcBuf[idx].args;
        } else if (etype === 'error') {
          const emsg = evt.error?.message || String(evt.error || '');
          if (emsg) {
            contentText += `!!!Error: ${emsg}`;
            yield `!!!Error: ${emsg}`;
          }
          warn = `!!!Error: ${emsg}`;
          break;
        }
      } else {
        const choices = evt.choices || [{}];
        const ch = choices[0];
        const delta = ch?.delta || {};
        if (delta.reasoning_content) reasoningText += delta.reasoning_content;
        if (delta.content) {
          contentText += delta.content;
          yield delta.content;
        }
        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? 0;
          const hasName = !!tc.function?.name;
          if (!(idx in tcBuf)) {
            if (hasName || Object.keys(tcBuf).length === 0) {
              tcBuf[idx] = { id: tc.id || '', name: '', args: '' };
            } else {
              continue;
            }
          }
          if (hasName) tcBuf[idx].name = tc.function.name;
          if (tc.function?.arguments) tcBuf[idx].args += tc.function.arguments;
          if (tc.id && !tcBuf[idx].id) tcBuf[idx].id = tc.id;
        }
      }
    } catch (e) {
      console.log(`[SSE] JSON parse error: ${e}, line: ${dataStr.slice(0, 200)}`);
    }
  }

  const toolCalls: ToolCall[] = [];
  const buf = apiMode === 'responses' ? fcBuf : tcBuf;
  for (const idx of Object.keys(buf).map(Number).sort((a, b) => a - b)) {
    const fc = buf[idx];
    let args: Record<string, unknown> = {};
    try {
      args = (tryParseJson(fc.args) as Record<string, unknown>) ?? {};
    } catch {
      args = { _raw: fc.args };
    }
    toolCalls.push({
      id: fc.id || `call_${idx}`,
      type: 'function',
      function: { name: fc.name, arguments: JSON.stringify(args) },
    });
  }

  emitUsage(usage);
  return {
    content: contentText + warn,
    thinking: reasoningText,
    tool_calls: toolCalls,
    raw: contentText + warn + (toolCalls.length ? JSON.stringify(toolCalls) : ''),
    stop_reason: toolCalls.length ? 'tool_use' : 'end_turn',
    usage,
  };
}

async function* parseClaudeSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string, LLMResponse, unknown> {
  const blocks: ContentBlock[] = [];
  let currentBlock: ContentBlock | null = null;
  let toolJsonBuf = '';
  let stopReason: string | null = null;
  let gotMessageStop = false;
  let warn = '';
  const usage: Record<string, number> = {};

  for await (const line of sseLines(reader)) {
    if (!line.startsWith('data:')) continue;
    const dataStr = line.slice(5).trim();
    if (dataStr === '[DONE]') break;
    try {
      const evt = JSON.parse(dataStr);
      const etype = evt.type;
      if (etype === 'message_start') {
        const us = evt.message?.usage;
        if (us) {
          if (us.input_tokens) usage.input = us.input_tokens;
          if (us.cache_creation_input_tokens) usage.cache_creation_input_tokens = us.cache_creation_input_tokens;
          if (us.cache_read_input_tokens) usage.cache_read_input_tokens = us.cache_read_input_tokens;
        }
      } else if (etype === 'content_block_start') {
        const block = evt.content_block || {};
        if (block.type === 'text') currentBlock = { type: 'text', text: '' };
        else if (block.type === 'thinking') currentBlock = { type: 'thinking', thinking: '', signature: '' };
        else if (block.type === 'tool_use') {
          currentBlock = { type: 'tool_use', id: block.id || `toolu_${cryptoRandom(16)}`, name: block.name || '', input: {} };
          toolJsonBuf = '';
        }
      } else if (etype === 'content_block_delta') {
        const delta = evt.delta || {};
        if (!currentBlock) continue;
        if (delta.type === 'text_delta' && currentBlock.type === 'text') {
          currentBlock.text += delta.text || '';
          if (delta.text) yield delta.text;
        } else if (delta.type === 'thinking_delta' && currentBlock.type === 'thinking') {
          currentBlock.thinking += delta.thinking || '';
        } else if (delta.type === 'signature_delta' && currentBlock.type === 'thinking') {
          currentBlock.signature = (currentBlock.signature || '') + delta.signature;
        } else if (delta.type === 'input_json_delta' && currentBlock.type === 'tool_use') {
          toolJsonBuf += delta.partial_json || '';
        }
      } else if (etype === 'content_block_stop') {
        if (currentBlock && currentBlock.type === 'tool_use') {
          try {
            currentBlock.input = toolJsonBuf ? (JSON.parse(toolJsonBuf) as Record<string, unknown>) : {};
          } catch {
            currentBlock.input = { _raw: toolJsonBuf };
          }
        }
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = null;
      } else if (etype === 'message_delta') {
        stopReason = evt.delta?.stop_reason || stopReason;
        const us = evt.usage;
        if (us) {
          if (us.output_tokens) usage.output = us.output_tokens;
          if (us.input_tokens) usage.input = us.input_tokens;
        }
      } else if (etype === 'message_stop') {
        gotMessageStop = true;
      } else if (etype === 'error') {
        const emsg = evt.error?.message || String(evt.error || '');
        warn = `\n\n!!!Error: SSE ${emsg}`;
        break;
      }
    } catch (e) {
      console.log(`[SSE] JSON parse error: ${e}, line: ${dataStr.slice(0, 200)}`);
    }
  }

  if (currentBlock) {
    if (currentBlock.type === 'tool_use') {
      try {
        currentBlock.input = toolJsonBuf ? (JSON.parse(toolJsonBuf) as Record<string, unknown>) : {};
      } catch {
        currentBlock.input = { _raw: toolJsonBuf };
      }
    }
    blocks.push(currentBlock);
  }
  if (!gotMessageStop && !stopReason) warn = '\n\n[!!! 流异常中断，未收到完整响应 !!!]';
  else if (stopReason === 'max_tokens') warn = '\n\n[!!! Response truncated: max_tokens !!!]';

  const content = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const thinking = blocks
    .filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('');
  const toolCalls: ToolCall[] = blocks
    .filter((b): b is ContentBlockToolUse => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

  emitUsage(usage);
  return {
    content: content + warn,
    thinking,
    tool_calls: toolCalls,
    raw: JSON.stringify(blocks) + warn,
    stop_reason: toolCalls.length ? 'tool_use' : stopReason || 'end_turn',
    usage,
  };
}

function stampCacheMarkers(messages: Message[], model: string): void {
  const ml = model.toLowerCase();
  if (!ml.includes('claude') && !ml.includes('anthropic')) return;
  const userIdxs = messages
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);
  for (const idx of userIdxs.slice(-2)) {
    const c = messages[idx].content;
    if (typeof c === 'string') {
      messages[idx].content = [{ type: 'text', text: c, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(c) && c.length) {
      const last = c[c.length - 1];
      if (typeof last === 'object' && last) {
        (last as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      }
    }
  }
}

function openaiToolsToClaude(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => {
    const fn = t.function as unknown as Record<string, unknown>;
    if ('input_schema' in fn) return fn;
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters,
    };
  });
}

function prepareOAITools(tools: ToolDefinition[], apiMode: 'chat_completions' | 'responses'): unknown[] {
  if (apiMode === 'responses') {
    return tools.map((t) => {
      if (t.type === 'function' && 'function' in t) {
        return { type: 'function', ...t.function };
      }
      return t;
    });
  }
  return tools;
}

function toTextBlock(b: { type: 'text'; text: string }): ContentBlock {
  return { type: 'text', text: b.text };
}

function msgsClaude2Oai(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const role = msg.role;
    const blocks: ContentBlock[] = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: String(msg.content) }];
    if (role === 'assistant') {
      const textParts: ContentBlock[] = [];
      const toolCalls: ToolCall[] = [];
      let reasoning = '';
      for (const b of blocks) {
        if (b.type === 'thinking' && b.thinking) reasoning = b.thinking;
        else if (b.type === 'text' && b.text) textParts.push(toTextBlock(b));
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || '',
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const m: Message = { role: 'assistant', content: textParts };
      if (reasoning) m.reasoning_content = reasoning;
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (!textParts.length && !toolCalls.length && reasoning) m.content = '.';
      result.push(m);
    } else if (role === 'user') {
      const textParts: ContentBlock[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          if (textParts.length) {
            result.push({ role: 'user', content: [...textParts] });
            textParts.length = 0;
          }
          const tr = b.content;
          const trText = Array.isArray(tr) ? tr.map((x) => (x as { text?: string }).text ?? '').join('\n') : String(tr);
          result.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: trText });
        } else if (b.type === 'image') {
          if (b.source.type === 'base64' && b.source.data) {
            textParts.push({
              type: 'image_url',
              image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` },
            });
          }
        } else if (b.type === 'image_url') {
          textParts.push(b);
        } else if (b.type === 'text' && b.text) {
          textParts.push(toTextBlock(b));
        }
      }
      if (textParts.length) result.push({ role: 'user', content: [...textParts] });
    } else {
      result.push(msg);
    }
  }
  return result;
}

function cryptoRandom(len: number): string {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function fixMessages(messages: Message[]): Message[] {
  if (!messages.length) return messages;
  const wrap = (c: unknown): ContentBlock[] => (Array.isArray(c) ? c : [{ type: 'text' as const, text: String(c) }]) as ContentBlock[];
  const fixed: Message[] = [];
  for (const m of messages) {
    if (fixed.length && m.role === fixed[fixed.length - 1].role) {
      const last = fixed[fixed.length - 1];
      last.content = [...wrap(last.content), { type: 'text', text: '\n' }, ...wrap(m.content)];
      continue;
    }
    if (fixed.length && fixed[fixed.length - 1].role === 'assistant' && m.role === 'user') {
      const last = fixed[fixed.length - 1];
      const lastBlocks = wrap(last.content);
      const uses = lastBlocks
        .filter((b): b is ContentBlockToolUse => b.type === 'tool_use')
        .map((b) => b.id);
      const userBlocks = wrap(m.content);
      const has = new Set(
        userBlocks
          .filter((b): b is ContentBlockToolResult => b.type === 'tool_result')
          .map((b) => b.tool_use_id)
      );
      const miss = uses.filter((id) => !has.has(id));
      if (miss.length) {
        m.content = [
          ...miss.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '(error)' } as ContentBlock)),
          ...userBlocks,
        ];
      }
    }
    fixed.push(m);
  }
  while (fixed.length && fixed[0].role !== 'user') fixed.shift();
  return fixed;
}

function dropUnsignedThinking(messages: Message[]): Message[] {
  return messages.map((m) => {
    const c = m.content;
    if (Array.isArray(c)) {
      return { ...m, content: c.filter((b) => !(b.type === 'thinking' && !b.signature)) };
    }
    return m;
  });
}

function ensureThinkingBlocks(messages: Message[], model: string): Message[] {
  if (!model.toLowerCase().includes('deepseek')) return messages;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (!Array.isArray(c)) continue;
    const hasThinking = c.some((b) => b.type === 'thinking');
    if (!hasThinking) {
      m.content = [{ type: 'thinking', thinking: '...', signature: 'placeholder' }, ...c];
    }
  }
  return messages;
}

export class OpenAISession extends BaseSession {
  constructor(cfg: SessionConfig) {
    super(cfg);
  }

  async* ask(prompt: Message | string): AsyncGenerator<string, LLMResponse, unknown> {
    const userMsg: Message = typeof prompt === 'string' ? { role: 'user', content: prompt } : prompt;
    this.history.push(userMsg);
    trimMessagesHistory(this.history, this.contextWin);
    const messages = this.makeMessages(this.history);
    const gen = this.rawAsk(messages);
    let resp: LLMResponse | undefined;
    try {
      while (true) {
        const chunk = await gen.next();
        if (chunk.done) {
          resp = chunk.value;
          break;
        }
        yield chunk.value;
      }
    } catch (e) {
      const err = `!!!Error: ${e instanceof Error ? e.message : String(e)}`;
      yield err;
      resp = { content: err, thinking: '', tool_calls: [], raw: err, stop_reason: 'error' };
    }
    if (resp && !resp.content.startsWith('!!!Error:')) {
      this.history.push({ role: 'assistant', content: resp.content });
    }
    return resp!;
  }

  makeMessages(rawList: Message[]): Message[] {
    return msgsClaude2Oai(rawList);
  }

  async* rawAsk(messages: Message[]): AsyncGenerator<string, LLMResponse, unknown> {
    const model = this.model;
    let temperature = this.temperature;
    const ml = model.toLowerCase();
    if (ml.includes('kimi') || ml.includes('moonshot')) temperature = 1;
    if (ml.includes('minimax')) temperature = Math.max(0.01, Math.min(temperature, 1));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    let url: string;
    let payload: Record<string, unknown>;
    if (this.apiMode === 'responses') {
      url = autoMakeUrl(this.apiBase, 'responses');
      payload = {
        model,
        input: toResponsesInput(messages),
        stream: this.stream,
        instructions: this.system || 'You are an Omnipotent Executor.',
      };
      if (this.maxTokens) payload.max_output_tokens = this.maxTokens;
      if (this.reasoningEffort) payload.reasoning = { effort: this.reasoningEffort };
    } else {
      url = autoMakeUrl(this.apiBase, 'chat/completions');
      const msgs: Message[] = this.system
        ? [{ role: 'system', content: this.system }, ...messages]
        : messages;
      stampCacheMarkers(msgs, model);
      payload = { model, messages: msgs, stream: this.stream };
      if (this.stream) payload.stream_options = { include_usage: true };
      if (temperature !== 1) payload.temperature = temperature;
      if (this.maxTokens) {
        const key = /^gpt-5|^o[1-4]/.test(ml) ? 'max_completion_tokens' : 'max_tokens';
        payload[key] = this.maxTokens;
      }
      if (this.reasoningEffort) payload.reasoning_effort = this.reasoningEffort;
    }
    if (this.tools) payload.tools = prepareOAITools(this.tools, this.apiMode);

    const resp = yield* streamWithRetry(url, headers, payload, this.maxRetries, this.connectTimeout);
    if (typeof resp === 'object' && resp.body) {
      const reader = resp.body.getReader();
      return yield* parseOpenAISSE(reader, this.apiMode);
    }
    const err = '!!!Error: empty response body';
    yield err;
    return { content: err, thinking: '', tool_calls: [], raw: err, stop_reason: 'error' };
  }
}

function toResponsesInput(messages: Message[]): unknown[] {
  const result: unknown[] = [];
  const pending: string[] = [];
  for (const msg of messages) {
    const role = (msg.role || 'user').toLowerCase();
    if (role === 'tool') {
      const cid = msg.tool_call_id || (pending.shift() ?? `call_${cryptoRandom(8)}`);
      result.push({ type: 'function_call_output', call_id: cid, output: String(msg.content || '') });
      continue;
    }
    const validRole = ['user', 'assistant', 'system', 'developer'].includes(role) ? role : 'user';
    const textRole = validRole === 'system' ? 'developer' : validRole;
    const parts: unknown[] = [];
    const content = msg.content;
    const textType = textRole === 'assistant' ? 'output_text' : 'input_text';
    if (typeof content === 'string') {
      if (content) parts.push({ type: textType, text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text' && part.text) parts.push({ type: textType, text: part.text });
        else if (part.type === 'image_url' && textRole !== 'assistant') {
          const url = (part.image_url as { url?: string }).url || '';
          if (url) parts.push({ type: 'input_image', image_url: url });
        }
      }
    }
    if (!parts.length) parts.push({ type: textType, text: '[empty]' });
    result.push({ role: textRole, content: parts });
    pending.length = 0;
    for (const tc of msg.tool_calls || []) {
      const cid = tc.id || `call_${cryptoRandom(8)}`;
      pending.push(cid);
      result.push({ type: 'function_call', call_id: cid, name: tc.function.name, arguments: tc.function.arguments });
    }
  }
  return result;
}

export class AnthropicSession extends BaseSession {
  private fakeCcSystemPrompt: boolean;
  private userAgent: string;
  private sessionId: string;
  private accountUuid: string;
  private deviceId: string;

  constructor(cfg: SessionConfig) {
    super(cfg);
    this.fakeCcSystemPrompt = cfg.fake_cc_system_prompt ?? false;
    this.userAgent = cfg.user_agent ?? 'claude-cli/2.1.113 (external, cli)';
    this.sessionId = cryptoRandom(32);
    this.accountUuid = cryptoRandom(32);
    this.deviceId = cryptoRandom(64);
  }

  async* ask(prompt: Message | string): AsyncGenerator<string, LLMResponse, unknown> {
    const userMsg: Message = typeof prompt === 'string' ? { role: 'user', content: prompt } : prompt;
    this.history.push(userMsg);
    trimMessagesHistory(this.history, this.contextWin);
    const messages = this.makeMessages(this.history);
    const gen = this.rawAsk(messages);
    let resp: LLMResponse | undefined;
    try {
      while (true) {
        const chunk = await gen.next();
        if (chunk.done) {
          resp = chunk.value;
          break;
        }
        yield chunk.value;
      }
    } catch (e) {
      const err = `!!!Error: ${e instanceof Error ? e.message : String(e)}`;
      yield err;
      resp = { content: err, thinking: '', tool_calls: [], raw: err, stop_reason: 'error' };
    }
    if (resp && !resp.content.startsWith('!!!Error:')) {
      const assistantContent: ContentBlock[] = [];
      if (resp.content) assistantContent.push({ type: 'text', text: resp.content });
      for (const tc of resp.tool_calls || []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = { _raw: tc.function.arguments };
        }
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      this.history.push({
        role: 'assistant',
        content: assistantContent.length === 1 && assistantContent[0].type === 'text'
          ? assistantContent[0].text
          : assistantContent,
      });
    }
    return resp!;
  }

  makeMessages(rawList: Message[]): Message[] {
    const msgs = dropUnsignedThinking(
      rawList.map((m) => ({ role: m.role, content: Array.isArray(m.content) ? [...m.content] : m.content }))
    );
    const userIdxs = msgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    for (const idx of userIdxs.slice(-2)) {
      const c = msgs[idx].content;
      if (Array.isArray(c) && c.length) {
        const last = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
        msgs[idx].content = [...c.slice(0, -1), last];
      }
    }
    return msgs;
  }

  private applyClaudeThinking(payload: Record<string, unknown>): void {
    if (this.thinkingType) {
      const thinking: Record<string, unknown> = { type: this.thinkingType };
      if (this.thinkingType === 'enabled') {
        if (this.thinkingBudgetTokens == null) {
          console.log("[WARN] thinking_type='enabled' requires thinking_budget_tokens, ignored.");
        } else {
          thinking.budget_tokens = this.thinkingBudgetTokens;
          payload.thinking = thinking;
        }
      } else {
        payload.thinking = thinking;
      }
    }
    if (this.reasoningEffort) {
      const effort = { low: 'low', medium: 'medium', high: 'high', xhigh: 'max' }[this.reasoningEffort];
      if (effort) payload.output_config = { effort };
    }
  }

  async* rawAsk(messages: Message[]): AsyncGenerator<string, LLMResponse, unknown> {
    const msgs = ensureThinkingBlocks(fixMessages(dropUnsignedThinking(messages)), this.model);
    const maxTokens = this.maxTokens ?? 8192;
    let model = this.model;
    const betaParts = [
      'claude-code-20250219',
      'interleaved-thinking-2025-05-14',
      'redact-thinking-2026-02-12',
      'prompt-caching-scope-2026-01-05',
    ];
    if (model.toLowerCase().includes('[1m]')) {
      betaParts.splice(1, 0, 'context-1m-2025-08-07');
      model = model.replace(/\[1m\]/gi, '');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': betaParts.join(','),
      'anthropic-dangerous-direct-browser-access': 'true',
      'user-agent': this.userAgent,
      'x-app': 'cli',
    };
    if (this.apiKey.startsWith('sk-ant-')) headers['x-api-key'] = this.apiKey;
    else headers['authorization'] = `Bearer ${this.apiKey}`;

    const payload: Record<string, unknown> = {
      model,
      messages: msgs,
      max_tokens: maxTokens,
      stream: this.stream,
    };
    if (this.temperature !== 1) payload.temperature = this.temperature;
    this.applyClaudeThinking(payload);
    payload.metadata = {
      user_id: JSON.stringify({
        device_id: this.deviceId,
        account_uuid: this.accountUuid,
        session_id: this.sessionId,
      }),
    };
    if (this.tools) {
      const claudeTools = openaiToolsToClaude(this.tools);
      const tools = claudeTools.map((t) => ({ ...t }));
      if (tools.length) (tools[tools.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      payload.tools = tools;
    }
    payload.system = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
    ];
    if (this.system) {
      if (this.fakeCcSystemPrompt) {
        const first = msgs[0];
        if (first && Array.isArray(first.content)) {
          first.content.unshift({ type: 'text', text: this.system });
        }
      } else {
        payload.system = [{ type: 'text', text: this.system }];
      }
    }

    const url = `${autoMakeUrl(this.apiBase, 'messages')}?beta=true`;
    const resp = yield* streamWithRetry(url, headers, payload, this.maxRetries, this.connectTimeout);
    if (typeof resp === 'object' && resp.body) {
      const reader = resp.body.getReader();
      return yield* parseClaudeSSE(reader);
    }
    const err = '!!!Error: empty response body';
    yield err;
    return { content: err, thinking: '', tool_calls: [], raw: err, stop_reason: 'error' };
  }
}

export class MixinSession extends BaseSession {
  private sessions: BaseSession[];
  private retries: number;
  private baseDelay: number;
  private springSec: number;
  private curIdx = 0;
  private switchedAt = 0;
  private origAsks: Array<(messages: Message[]) => AsyncGenerator<string, LLMResponse, unknown>> = [];

  constructor(allSessions: BaseSession[], cfg: SessionConfig) {
    super(cfg);
    const llmNos = cfg.llm_nos ?? [];
    this.sessions = llmNos.map((i) => {
      if (typeof i === 'number') return allSessions[i];
      const found = allSessions.find((s) => s.name === i);
      if (!found) throw new Error(`MixinSession: session ${i} not found`);
      return found;
    });
    if (this.sessions.length === 0) throw new Error('MixinSession: no sessions');
    this.retries = cfg.max_retries ?? 3;
    this.baseDelay = cfg.base_delay ?? 1.5;
    this.springSec = cfg.spring_back ?? 300;
    this.name = this.sessions.map((s) => s.name).join('|');
    this.model = this.sessions[0].model;
  }

  async* ask(prompt: Message | string): AsyncGenerator<string, LLMResponse, unknown> {
    return yield* this.sessions[0].ask(prompt);
  }

  makeMessages(rawList: Message[]): Message[] {
    return this.sessions[0].makeMessages(rawList);
  }

  async* rawAsk(messages: Message[]): AsyncGenerator<string, LLMResponse, unknown> {
    if (!this.origAsks.length) {
      this.origAsks = this.sessions.map((s) => s.rawAsk.bind(s));
    }
    const base = this.pick();
    const n = this.sessions.length;
    const testError = (x: string) => x.trim().startsWith('!!!Error:') || x.trim().startsWith('[Error:');

    const attempt = async function* (
      this: MixinSession,
      attemptNo: number
    ): AsyncGenerator<string, LLMResponse, unknown> {
      const idx = (base + attemptNo) % n;
      const gen = this.origAsks[idx](messages);
      console.log(`[MixinSession] Using session (${this.sessions[idx].name})`);
      let lastChunk = '';
      let yielded = false;
      let returnVal: LLMResponse | undefined;
      try {
        while (true) {
          const { done, value } = await gen.next();
          if (done) {
            returnVal = value;
            break;
          }
          lastChunk = value;
          if (!yielded && testError(value)) continue;
          yielded = true;
          yield value;
        }
      } catch (e) {
        lastChunk = `!!!Error: ${e instanceof Error ? e.message : String(e)}`;
      }
      const err = testError(lastChunk);
      if (!err) {
        if (attemptNo > 0) {
          this.curIdx = idx;
          this.switchedAt = Date.now() / 1000;
        } else if (lastChunk.includes('[!!! 流异常中断') && n > 1) {
          this.curIdx = (idx + 1) % n;
          this.switchedAt = Date.now() / 1000;
          console.log(`[MixinSession] Partial failure, next call → s${this.curIdx} (${this.sessions[this.curIdx].name})`);
        }
        return returnVal!;
      }
      if (attemptNo >= this.retries) {
        yield lastChunk;
        return returnVal ?? { content: lastChunk, thinking: '', tool_calls: [], raw: lastChunk, stop_reason: 'error' };
      }
      const nxt = (base + attemptNo + 1) % n;
      if (nxt === base) {
        const rnd = Math.floor((attemptNo + 1) / n);
        const delay = Math.min(30, this.baseDelay * 1.5 ** rnd);
        console.log(`[MixinSession] ${lastChunk.slice(0, 80)}, round ${rnd} exhausted, retry in ${delay.toFixed(1)}s`);
        await sleep(delay * 1000);
      } else {
        console.log(`[MixinSession] ${lastChunk.slice(0, 80)}, retry ${attemptNo + 1}/${this.retries} (s${idx}→s${nxt})`);
      }
      return yield* attempt.call(this, attemptNo + 1);
    };

    return yield* attempt.call(this, 0);
  }

  private pick(): number {
    if (this.curIdx && Date.now() / 1000 - this.switchedAt > this.springSec) this.curIdx = 0;
    return this.curIdx;
  }
}

export class ToolClient {
  backend: BaseSession;
  name: string;
  private lastTools = '';
  private totalCdTokens = 0;

  constructor(backend: BaseSession) {
    this.backend = backend;
    this.name = backend.name;
  }

  async* chat(options: ChatOptions): AsyncGenerator<string, LLMResponse, unknown> {
    const tools = options.tools ? JSON.parse(JSON.stringify(options.tools)) as ToolDefinition[] : undefined;
    if (tools) {
      for (const t of tools) {
        if (t.function.name === 'file_write') {
          const props = (t.function.parameters as { properties?: Record<string, unknown> }).properties;
          if (props) delete props.content;
          const extra = '. Content must be placed in <file_content> tags in reply body, not in args';
          if (!t.function.description.includes(extra)) t.function.description += extra;
        }
      }
    }
    const fullPrompt = this.buildProtocolPrompt(options.messages, tools);
    writeLlmLog('Prompt', fullPrompt);
    console.log('Full prompt length:', fullPrompt.length, 'chars');
    const gen = this.backend.ask(fullPrompt);
    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        writeLlmLog('Response', JSON.stringify(value, null, 2));
        return value;
      }
      yield value;
    }
  }

  private prepareToolInstruction(tools?: ToolDefinition[]): string {
    if (!tools) return '';
    const toolsJson = JSON.stringify(tools, null, 0);
    const lang = process.env.GA_LANG || 'zh';
    let instruction = '';
    if (lang === 'en') {
      instruction = `### Interaction Protocol (must follow strictly, always in effect)\n1. **Think**: Analyze inside <thinking>.\n2. **Summarize**: One-line (<30 words) snapshot in <summary>.\n3. **Act**: Output <tool_use> blocks after reply.\n`;
    } else {
      instruction = `### 交互协议（必须严格遵守，持续有效）\n1. **思考**: 在 <thinking> 中先思考。\n2. **总结**: 在 <summary> 中输出极简单行（<30字）物理快照。\n3. **行动**: 如需调用工具，输出 <tool_use> 块。\n`;
    }
    instruction += `\nFormat: \`\`\`<tool_use>{"name": "tool_name", "arguments": {...}}</tool_use>\`\`\`\n\n### Tools:\n${toolsJson}\n`;
    if (this.lastTools === toolsJson) {
      instruction = lang === 'en'
        ? '\n### Tools: still active, ready to call.\n'
        : '\n### 工具库持续有效，可正常调用。\n';
    } else {
      this.totalCdTokens = 0;
    }
    this.lastTools = toolsJson;
    return instruction;
  }

  private buildProtocolPrompt(messages: Message[], tools?: ToolDefinition[]): string {
    const systemContent = messages.find((m) => m.role.toLowerCase() === 'system')?.content || '';
    const history = messages.filter((m) => m.role.toLowerCase() !== 'system');
    const toolInstruction = this.prepareToolInstruction(tools);
    let system = '';
    if (typeof systemContent === 'string' && systemContent) system = `${systemContent}\n`;
    system += toolInstruction;
    let user = '';
    for (const m of history) {
      const role = m.role === 'user' ? 'USER' : 'ASSISTANT';
      user += `=== ${role} ===\n`;
      for (const tr of m.tool_results || []) user += `<tool_result>${tr.content}</tool_result>\n`;
      user += String(m.content) + '\n';
      this.totalCdTokens += user.length / 3;
    }
    if (this.totalCdTokens > 9000) this.lastTools = '';
    user += '=== ASSISTANT ===\n';
    return system + user;
  }
}

export class NativeToolClient {
  backend: BaseSession;
  name: string;
  private pendingToolIds: string[] = [];

  constructor(backend: BaseSession) {
    this.backend = backend;
    this.name = backend.name;
  }

  async* chat(options: ChatOptions): AsyncGenerator<string, LLMResponse, unknown> {
    if (options.tools) this.backend.tools = options.tools;
    if (!this.backend.history.length) this.pendingToolIds = [];
    const combinedContent: ContentBlock[] = [];
    let toolResults: Array<{ tool_use_id: string; content: string }> = [];
    const lastUser = [...options.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const c = lastUser.content;
      if (typeof c === 'string') combinedContent.push({ type: 'text', text: c });
      else if (Array.isArray(c)) combinedContent.push(...c);
      if (lastUser.tool_results) toolResults = lastUser.tool_results;
    }
    const trIdSet = new Set<string>();
    const toolResultBlocks: ContentBlock[] = [];
    for (const tr of toolResults) {
      trIdSet.add(tr.tool_use_id);
      if (tr.tool_use_id) {
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tr.tool_use_id, content: tr.content });
      } else {
        combinedContent.unshift({ type: 'text', text: `<tool_result>${tr.content}</tool_result>` });
      }
    }
    for (const tid of this.pendingToolIds) {
      if (!trIdSet.has(tid)) toolResultBlocks.push({ type: 'tool_result', tool_use_id: tid, content: '' });
    }
    this.pendingToolIds = [];
    const merged: Message = { role: 'user', content: [...toolResultBlocks, ...combinedContent] };
    writeLlmLog('Prompt', JSON.stringify(merged, null, 2));
    const gen = this.backend.ask(merged);
    let resp: LLMResponse | undefined;
    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        resp = value;
        break;
      }
      yield value;
    }
    if (resp?.tool_calls?.length) {
      this.pendingToolIds = resp.tool_calls.map((tc) => tc.id);
    }
    if (resp) writeLlmLog('Response', JSON.stringify(resp, null, 2));
    return resp!;
  }
}

export function loadSessions(configPath: string): BaseSession[] {
  const text = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(text) as Record<string, SessionConfig | unknown>;
  const sessions: BaseSession[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (!v || typeof v !== 'object') continue;
    if (!k.includes('api') && !k.includes('config') && !k.includes('cookie')) continue;
    const cfgItem = v as SessionConfig;
    if (k.includes('native') && k.includes('claude')) sessions.push(new AnthropicSession(cfgItem));
    else if (k.includes('native') && k.includes('oai')) sessions.push(new OpenAISession(cfgItem));
    else if (k.includes('claude')) sessions.push(new AnthropicSession(cfgItem));
    else if (k.includes('oai')) sessions.push(new OpenAISession(cfgItem));
    else if (k.includes('mixin')) sessions.push(new MixinSession(sessions, cfgItem));
  }
  return sessions;
}

function inferSessionType(type: string | undefined, model: string, apibase: string): 'claude' | 'oai' | 'mixin' {
  if (type) {
    const t = type.toLowerCase();
    if (t === 'mixin') return 'mixin';
    if (t === 'claude' || t === 'anthropic') return 'claude';
    return 'oai';
  }
  const ml = model.toLowerCase();
  const bl = apibase.toLowerCase();
  if (ml.includes('claude') || bl.includes('anthropic') || bl.includes('claude')) return 'claude';
  return 'oai';
}

export function loadSessionsFromEnv(dotenvPath?: string): BaseSession[] {
  const env = loadEnv(dotenvPath);
  const configs = envToSessionConfigs(env);
  const sessions: BaseSession[] = [];
  for (const { cfg, type } of Object.values(configs)) {
    const t = inferSessionType(type, cfg.model, cfg.apibase);
    if (t === 'mixin') sessions.push(new MixinSession(sessions, cfg));
    else if (t === 'claude') sessions.push(new AnthropicSession(cfg));
    else sessions.push(new OpenAISession(cfg));
  }
  return sessions;
}

export function createClient(sessions: BaseSession[], index = 0): ToolClient | NativeToolClient {
  const backend = sessions[index % sessions.length];
  const isNative = backend instanceof AnthropicSession || backend instanceof OpenAISession;
  return isNative ? new NativeToolClient(backend) : new ToolClient(backend);
}
