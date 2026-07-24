import fs from 'fs';
import path from 'path';
import { resolveAllowedPath, isPathContained, findProjectRoot, smartFormat } from '../shared/index.js';

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function formatError(e: unknown): string {
  if (e instanceof Error) {
    const stack = e.stack || '';
    const frames = stack.split('\n').slice(1);
    const lastFrame = frames.reverse().find((l) => l.includes(' at '));
    const loc = lastFrame ? lastFrame.trim().replace(/^at /, '') : '';
    return `${e.name}: ${e.message}${loc ? ` @ ${loc}` : ''}`;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// expandFileRefs — replace {{file:path:start:end}} with actual file content
// ---------------------------------------------------------------------------

export function expandFileRefs(text: string, baseDir?: string): string {
  const pattern = /\{\{file:(.+?):(\d+):(\d+)\}\}/g;
  return text.replace(pattern, (_match, filePath, startStr, endStr) => {
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    const resolved = resolveAllowedPath(baseDir || process.cwd(), filePath);
    if (!fs.existsSync(resolved)) throw new Error(`引用文件不存在: ${resolved}`);
    const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
    if (start < 1 || end > lines.length || start > end) {
      throw new Error(`行号越界: ${resolved} 共${lines.length}行, 请求${start}-${end}`);
    }
    return lines.slice(start - 1, end).join('\n');
  });
}

// ---------------------------------------------------------------------------
// extractRobustContent — extract content from response text
// ---------------------------------------------------------------------------

export function extractRobustContent(text: string): string | null {
  if (!text) return null;
  const startTag = '<文件内容>';
  const endTag = '</文件内容>';
  const startIdx = text.indexOf(startTag);
  const endIdx = text.indexOf(endTag);
  if (startIdx >= 0 && endIdx > startIdx) {
    return text.slice(startIdx + startTag.length, endIdx).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractCodeBlock — extract a fenced code block from LLM response
// ---------------------------------------------------------------------------

export function extractCodeBlock(response: { content: string }, codeType: string): string | null {
  const pattern = codeType === 'python' || codeType === 'py'
    ? /```(?:python|py)\n([\s\S]*?)```/
    : new RegExp(`\`\`\`(?:${escapeRegex(codeType)})\\n([\\s\\S]*?)\`\`\``);
  const m = response.content.match(pattern);
  return m ? m[1].trim() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// consumeFile — read and delete a file atomically
// ---------------------------------------------------------------------------

export function consumeFile(dir: string | undefined, file: string): string | undefined {
  if (!dir) return undefined;
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return undefined;
  try {
    const content = fs.readFileSync(p, 'utf-8');
    fs.unlinkSync(p);
    return content;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// fileRead
// ---------------------------------------------------------------------------

const readDirs = new Set<string>();

function scanFiles(base: string, depth = 2): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      if (entry.isFile()) out.push([entry.name, full]);
      else if (depth > 0 && entry.isDirectory()) out.push(...scanFiles(full, depth - 1));
    }
  } catch {
    // ignore permission errors
  }
  return out;
}

function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarityRatio(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const lcs = lcsLength(al, bl);
  return (2 * lcs) / (al.length + bl.length);
}

export function fileRead(
  filePath: string,
  start = 1,
  keyword?: string,
  count = 200,
  showLinenos = true,
  cwd?: string
): string {
  const allowedBase = cwd || findProjectRoot();
  let resolved: string;
  try {
    resolved = resolveAllowedPath(allowedBase, filePath);
  } catch (e) {
    return `Error: ${formatError(e)}`;
  }

  try {
    const content = fs.readFileSync(resolved, { encoding: 'utf-8', flag: 'r' });
    const allLines = content.split('\n');
    const lines = allLines.map((l, i) => [i + 1, l] as [number, string]);

    let selected: [number, string][] = [];
    const startIdx = Math.max(0, start - 1);
    if (keyword) {
      const before: [number, string][] = [];
      const maxBefore = Math.floor(count / 3);
      let found = false;
      for (let idx = startIdx; idx < lines.length; idx++) {
        const item = lines[idx];
        if (item[1].toLowerCase().includes(keyword.toLowerCase())) {
          const afterCount = count - before.length - 1;
          selected = [...before, item, ...lines.slice(idx + 1, idx + 1 + afterCount)];
          found = true;
          break;
        }
        before.push(item);
        if (before.length > maxBefore) before.shift();
      }
      if (!found) {
        return `Keyword '${keyword}' not found after line ${start}. Falling back to content from line ${start}:\n\n${fileRead(
          filePath, start, undefined, count, showLinenos, cwd
        )}`;
      }
    } else {
      selected = lines.slice(startIdx, startIdx + count);
    }

    const realCount = selected.length;
    const L_MAX = Math.min(Math.max(100, Math.floor(256000 / Math.max(realCount, 1))), 8000);
    const TAG = ' ... [TRUNCATED]';
    const lastLine = selected[selected.length - 1]?.[0] ?? start - 1;
    const remaining = Math.min(allLines.length - lastLine, 5000);
    const totalLines = (selected[0]?.[0] ?? start) - 1 + realCount + remaining;
    const partial = totalLines > realCount;
    const tlStr = remaining >= 5000 ? `${totalLines}+` : String(totalLines);
    const totalTag = `[FILE] ${tlStr} lines` + (partial ? ` | PARTIAL showing ${realCount}; assess need for more` : '') + '\n';

    const truncated = selected.map(([i, l]) => [i, l.length <= L_MAX ? l : `${l.slice(0, L_MAX)}${TAG}`] as [number, string]);
    const body = truncated.map(([i, l]) => (showLinenos ? `${i}|${l}` : l)).join('\n');
    readDirs.add(path.dirname(resolved));

    if (showLinenos) return totalTag + body;
    if (partial) return body + `\n\n[FILE PARTIAL: showing ${realCount}/${tlStr} lines; assess need for more]`;
    return body;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      let msg = `Error: File not found: ${filePath}`;
      try {
        const target = path.basename(resolved);
        const roots = new Set([allowedBase, ...[...readDirs].filter((d) => isPathContained(allowedBase, d))]);
        const cands: Array<[string, string]> = [];
        for (const r of roots) {
          cands.push(...scanFiles(r));
          if (cands.length >= 2000) break;
        }
        const scored = cands
          .map((c) => [similarityRatio(target, c[0]), c] as [number, [string, string]])
          .filter(([s]) => s > 0.3)
          .sort((a, b) => b[0] - a[0])
          .slice(0, 5);
        if (scored.length) {
          msg += '\n\nDid you mean:\n' + scored.map(([s, c]) => `  ${c[1]}  (${Math.round(s * 100)}%)`).join('\n');
        }
      } catch {
        // ignore
      }
      return msg;
    }
    return `Error: ${formatError(e)}`;
  }
}

// ---------------------------------------------------------------------------
// filePatch
// ---------------------------------------------------------------------------

export function filePatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  cwd?: string
): { status: string; msg: string } {
  const allowedBase = cwd || findProjectRoot();
  let resolved: string;
  try {
    resolved = resolveAllowedPath(allowedBase, filePath);
  } catch (e) {
    return { status: 'error', msg: formatError(e) };
  }
  try {
    if (!fs.existsSync(resolved)) return { status: 'error', msg: '文件不存在' };
    if (!oldContent) return { status: 'error', msg: 'old_content 为空，请确认 arguments' };
    const fullText = fs.readFileSync(resolved, 'utf-8');
    const count = fullText.split(oldContent).length - 1;
    if (count === 0) {
      return { status: 'error', msg: '未找到匹配的旧文本块，建议：先用 file_read 确认当前内容，再分小段进行 patch。若多次失败则询问用户，严禁自行使用 overwrite 或代码替换。' };
    }
    if (count > 1) {
      return { status: 'error', msg: `找到 ${count} 处匹配，无法确定唯一位置。请提供更长、更具体的旧文本块以确保唯一性。` };
    }
    fs.writeFileSync(resolved, fullText.replace(oldContent, newContent), 'utf-8');
    return { status: 'success', msg: '文件局部修改成功' };
  } catch (e) {
    return { status: 'error', msg: formatError(e) };
  }
}

// ---------------------------------------------------------------------------
// fileWrite
// ---------------------------------------------------------------------------

export function fileWrite(
  filePath: string,
  content: string,
  mode: string,
  cwd?: string
): { status: string; writed_bytes: number; msg?: string } {
  const allowedBase = cwd || findProjectRoot();
  let resolved: string;
  try {
    resolved = resolveAllowedPath(allowedBase, filePath);
  } catch (e) {
    return { status: 'error', writed_bytes: 0, msg: formatError(e) };
  }
  try {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (mode === 'append') {
      fs.appendFileSync(resolved, content, 'utf-8');
      return { status: 'success', writed_bytes: content.length, msg: `Appended to ${filePath}` };
    }
    if (mode === 'prepend') {
      const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';
      fs.writeFileSync(resolved, content + existing, 'utf-8');
      return { status: 'success', writed_bytes: content.length, msg: `Prepended to ${filePath}` };
    }
    // overwrite (default)
    fs.writeFileSync(resolved, content, 'utf-8');
    return { status: 'success', writed_bytes: content.length, msg: `Written to ${filePath}` };
  } catch (e) {
    return { status: 'error', writed_bytes: 0, msg: formatError(e) };
  }
}
