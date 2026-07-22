import fs from 'fs';

const BLOCK_RE = /^=== (Prompt|Response) ===.*?\n(.*?)(?=^=== (?:Prompt|Response) ===|\Z)/gms;
const HISTORY_RE = /<history>\s*(.*?)\s*<\/history>/s;
const FILE_HINT = 'If you need to show files to user, use [FILE:filepath] in your response.';

export interface ModelResponsePair {
  prompt: string;
  response: string;
}

export function parseModelResponsePairs(content: string): ModelResponsePair[] {
  const blocks = [...content.matchAll(BLOCK_RE)];
  const out: ModelResponsePair[] = [];
  let pending: string | null = null;
  for (const [, label, body] of blocks) {
    if (label === 'Prompt') pending = body.trim();
    else if (pending !== null) {
      out.push({ prompt: pending, response: body.trim() });
      pending = null;
    }
  }
  return out;
}

export function relTime(mtime: number): string {
  const d = Math.floor(Date.now() / 1000 - mtime);
  if (d < 60) return `${d}秒前`;
  if (d < 3600) return `${Math.floor(d / 60)}分前`;
  if (d < 86400) return `${Math.floor(d / 3600)}小时前`;
  return `${Math.floor(d / 86400)}天前`;
}

export interface NativePromptMessage {
  role: string;
  content: Array<{ type?: string; text?: string }>;
}

export function parseNativePrompt(promptBody: string): NativePromptMessage | null {
  try {
    const prompt = JSON.parse(promptBody) as NativePromptMessage;
    if (prompt.role !== 'user' || !Array.isArray(prompt.content)) return null;
    return prompt;
  } catch {
    return null;
  }
}

export function extractUserText(promptBody: string): string {
  const native = parseNativePrompt(promptBody);
  if (native) {
    for (const blk of native.content) {
      if (blk.type === 'text') {
        const t = (blk.text || '').trim();
        if (t && !t.startsWith('### [WORKING MEMORY]')) return t;
      }
    }
    return '';
  }
  for (const line of promptBody.split('\n')) {
    const s = line.trim();
    if (s && !s.startsWith('###')) return s;
  }
  return '';
}

export function extractNativeUserLine(promptText: string): string {
  let text = promptText.trim();
  if (!text || text.includes('<history>') || text.startsWith('### [WORKING MEMORY]')) return '';
  if (text.startsWith(FILE_HINT)) text = text.slice(FILE_HINT.length).trim();
  if (text.includes('### 用户当前消息')) text = text.split('### 用户当前消息', 2)[1]?.trim() || '';
  return text;
}

export function extractHistoryLines(promptText: string): string[] {
  const m = promptText.match(HISTORY_RE);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('[USER]: ') || l.startsWith('[Agent] '));
}

export function extractAssistantText(responseBody: string): string {
  try {
    const blocks = JSON.parse(responseBody) as Array<{ type?: string; text?: string }>;
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
      .map((b) => b.text)
      .join('\n');
  } catch {
    return '';
  }
}

export function extractAssistantSummary(responseBody: string): string {
  const text = extractAssistantText(responseBody);
  const stripped = text.replace(/```[\s\S]*?```/g, ' ').trim();
  const firstLine = stripped.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  return firstLine.slice(0, 500);
}

export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
