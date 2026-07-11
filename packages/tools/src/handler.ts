import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { LLMResponse } from '@orion/types';
import { getWorkspaceRoot, globalPath } from '@orion/shared';

export function smartFormat(data: unknown, maxStrLen = 100, omitStr = ' ... '): string {
  const s = typeof data === 'string' ? data : String(data);
  if (s.length < maxStrLen + omitStr.length * 2) return s;
  return `${s.slice(0, Math.floor(maxStrLen / 2))}${omitStr}${s.slice(-Math.floor(maxStrLen / 2))}`;
}

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

export function logMemoryAccess(filePath: string): void {
  if (!filePath.includes('memory')) return;
  const statsFile = globalPath('memory', 'file_access_stats.json');
  let stats: Record<string, { count: number; last: string }> = {};
  try {
    stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
  } catch {
    stats = {};
  }
  const fname = path.basename(filePath);
  stats[fname] = {
    count: (stats[fname]?.count ?? 0) + 1,
    last: new Date().toISOString().slice(0, 10),
  };
  try {
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf-8');
  } catch {}
}

export function getProjectRoot(): string {
  return getWorkspaceRoot();
}

export function expandFileRefs(text: string, baseDir?: string): string {
  const pattern = /\{\{file:(.+?):(\d+):(\d+)\}\}/g;
  return text.replace(pattern, (_match, filePath, startStr, endStr) => {
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    const resolved = path.resolve(baseDir || '.', filePath);
    if (!fs.existsSync(resolved)) throw new Error(`引用文件不存在: ${resolved}`);
    const lines = fs.readFileSync(resolved, 'utf-8').split('\n');
    if (start < 1 || end > lines.length || start > end) {
      throw new Error(`行号越界: ${resolved} 共${lines.length}行, 请求${start}-${end}`);
    }
    return lines.slice(start - 1, end).join('\n');
  });
}

export async function* codeRun(
  code: string,
  codeType: string,
  timeoutSec: number,
  cwd: string,
  codeCwd?: string,
  stopSignal?: number[]
): AsyncGenerator<string, { status: string; stdout: string; exit_code: number | null; msg?: string }, unknown> {
  const preview = code.length > 60 ? `${code.slice(0, 60).replace(/\n/g, ' ')}...` : code.trim();
  yield `[Action] Running ${codeType} in ${path.basename(cwd)}: ${preview}\n`;

  let tmpPath: string | null = null;
  let cmd: string[];
  const actualCwd = cwd || getWorkspaceRoot();

  if (codeType === 'python' || codeType === 'py') {
    const headerPath = globalPath('assets', 'code_run_header.py');
    let header = '';
    if (fs.existsSync(headerPath)) header = fs.readFileSync(headerPath, 'utf-8');
    const dir = codeCwd || actualCwd;
    tmpPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.ai.py`);
    fs.writeFileSync(tmpPath, header + code, 'utf-8');
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    cmd = [pythonCmd, '-u', tmpPath];
  } else if (['powershell', 'bash', 'sh', 'shell', 'ps1', 'pwsh'].includes(codeType)) {
    if (process.platform === 'win32') cmd = ['powershell', '-NoProfile', '-NonInteractive', '-Command', code];
    else cmd = ['bash', '-c', code];
  } else {
    return { status: 'error', stdout: '', exit_code: null, msg: `不支持的类型: ${codeType}` };
  }

  const logs: string[] = [];
  let exitCode: number | null = null;
  let killed = false;
  const startTime = Date.now();

  const proc = spawn(cmd[0], cmd.slice(1), {
    cwd: actualCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const collect = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    stream.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf-8');
      logs.push(line);
    });
  };
  collect(proc.stdout);
  collect(proc.stderr);

  const finished = new Promise<number | null>((resolve) => {
    proc.on('close', (code) => resolve(code));
    proc.on('error', () => resolve(null));
  });

  const interval = setInterval(() => {
    const timedOut = (Date.now() - startTime) / 1000 > timeoutSec;
    const stopped = stopSignal && stopSignal.length > 0;
    if ((timedOut || stopped) && !killed) {
      proc.kill('SIGKILL');
      killed = true;
      if (timedOut) logs.push('\n[Timeout Error] 超时强制终止');
      else logs.push('\n[Stopped] 用户强制终止');
    }
  }, 500);

  exitCode = await finished;
  clearInterval(interval);

  const stdoutStr = logs.join('');
  const status = exitCode === 0 ? 'success' : 'error';
  const statusIcon = exitCode === 0 ? '✅' : exitCode === null ? '⏳' : '❌';
  const outputSnippet = smartFormat(stdoutStr, 600, '\n\n[omitted long output]\n\n');
  yield `[Status] ${statusIcon} Exit Code: ${exitCode}\n[Stdout]\n${outputSnippet}\n`;

  if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  return {
    status,
    stdout: smartFormat(stdoutStr, 10000, '\n\n[omitted long output]\n\n'),
    exit_code: exitCode,
  };
}

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
  showLinenos = true
): string {
  try {
    const content = fs.readFileSync(filePath, { encoding: 'utf-8', flag: 'r' });
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
          filePath,
          start,
          undefined,
          count,
          showLinenos
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
    readDirs.add(path.dirname(path.resolve(filePath)));
    logMemoryAccess(filePath);

    if (showLinenos) return totalTag + body;
    if (partial) return body + `\n\n[FILE PARTIAL: showing ${realCount}/${tlStr} lines; assess need for more]`;
    return body;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      let msg = `Error: File not found: ${filePath}`;
      try {
        const target = path.basename(filePath);
        const dir = path.dirname(path.dirname(path.resolve(filePath)));
        const roots = new Set([dir, ...[...readDirs].filter((d) => !d.startsWith(dir))]);
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
        // ignore suggestion errors
      }
      return msg;
    }
    return `Error: ${formatError(e)}`;
  }
}

export function filePatch(filePath: string, oldContent: string, newContent: string): { status: string; msg: string } {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { status: 'error', msg: '文件不存在' };
    if (!oldContent) return { status: 'error', msg: 'old_content 为空，请确认 arguments' };
    const fullText = fs.readFileSync(resolved, 'utf-8');
    const count = fullText.split(oldContent).length - 1;
    if (count === 0) {
      return {
        status: 'error',
        msg: '未找到匹配的旧文本块，建议：先用 file_read 确认当前内容，再分小段进行 patch。若多次失败则询问用户，严禁自行使用 overwrite 或代码替换。',
      };
    }
    if (count > 1) {
      return {
        status: 'error',
        msg: `找到 ${count} 处匹配，无法确定唯一位置。请提供更长、更具体的旧文本块以确保唯一性。建议：包含上下文行来增强特征，或分小段逐个修改。`,
      };
    }
    fs.writeFileSync(resolved, fullText.replace(oldContent, newContent), 'utf-8');
    return { status: 'success', msg: '文件局部修改成功' };
  } catch (e) {
    return { status: 'error', msg: formatError(e) };
  }
}

export function fileWrite(filePath: string, content: string, mode: string): { status: string; writed_bytes: number; msg?: string } {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (mode === 'prepend') {
      const old = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      fs.writeFileSync(filePath, content + old, 'utf-8');
    } else {
      fs.writeFileSync(filePath, content, mode === 'append' ? { flag: 'a' } : undefined);
    }
    return { status: 'success', writed_bytes: content.length };
  } catch (e) {
    return { status: 'error', writed_bytes: 0, msg: formatError(e) };
  }
}

export function extractRobustContent(text: string): string | null {
  const tagMatch = text.match(/<file_content[^>]*>([\s\S]*?)<\/file_content>/g);
  if (tagMatch) return tagMatch[tagMatch.length - 1].replace(/<file_content[^>]*>|<\/file_content>/g, '').trim();
  const blockMatch = text.match(/```[^\n]*\n([\s\S]*?)```/g);
  if (blockMatch) {
    const last = blockMatch[blockMatch.length - 1];
    const inner = last.match(/```[^\n]*\n([\s\S]*?)```/);
    if (inner) return inner[1].trim();
  }
  return null;
}

export function extractCodeBlock(response: LLMResponse, codeType: string): string | null {
  const altMap: Record<string, string> = {
    python: 'python|py',
    py: 'python|py',
    powershell: 'powershell|ps1|pwsh',
    ps1: 'powershell|ps1|pwsh',
    pwsh: 'powershell|ps1|pwsh',
    bash: 'bash|sh|shell',
    sh: 'bash|sh|shell',
    shell: 'bash|sh|shell',
    javascript: 'javascript|js',
    js: 'javascript|js',
  };
  const alt = altMap[codeType] || codeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\\`\\\`\\\`(?:${alt})\\n([\\s\\S]*?)\\n\\\`\\\`\\\``, 'g');
  const matches = [...response.content.matchAll(pattern)];
  return matches.length ? matches[matches.length - 1][1].trim() : null;
}

export function getGlobalMemory(): string {
  let prompt = '\n';
  try {
    const suffix = process.env.GA_LANG === 'en' ? '_en' : '';
    const insight = fs.readFileSync(globalPath('memory', 'global_mem_insight.txt'), 'utf-8');
    const structure = fs.readFileSync(globalPath('assets', `insight_fixed_structure${suffix}.txt`), 'utf-8');
    prompt += `cwd = ${getWorkspaceRoot()} (./)\n`;
    prompt += '\n[Memory] (../memory)\n';
    prompt += structure + '\n../memory/global_mem_insight.txt:\n';
    prompt += insight + '\n';
  } catch {
    // ignore missing memory files
  }
  return prompt;
}

export function consumeFile(dir: string | undefined, file: string): string | undefined {
  if (!dir) return undefined;
  const fp = path.join(dir, file);
  if (!fs.existsSync(fp)) return undefined;
  const content = fs.readFileSync(fp, { encoding: 'utf-8', flag: 'r' });
  try {
    fs.unlinkSync(fp);
  } catch {}
  return content;
}
