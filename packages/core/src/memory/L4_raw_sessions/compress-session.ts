import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { isPathContained } from '../../shared/index.js';

const moduleDir = path.dirname(import.meta.url ? fileURLToPath(import.meta.url) : __filename);
export const L4_DIR = path.resolve(moduleDir, '..', '..', '..', 'memory', 'L4_raw_sessions');

const rePrompt = /^=== Prompt ===(?: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?/gm;
const reResponse = /^=== Response ===(?: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?/gm;
const reAnyMarker = /^=== (?:Prompt|Response|USER|ASSISTANT) ===(?:.*)?$/gm;

function tsFmt(ts: string): string | null {
  try {
    const d = new Date(ts.trim());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}${dd}_${hh}${mi}`;
  } catch {
    return null;
  }
}

function detectFormat(text: string): 'json' | 'raw' | 'unknown' {
  rePrompt.lastIndex = 0;
  const m = rePrompt.exec(text);
  if (!m) return 'unknown';
  return /^\s*\{/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 200)) ? 'json' : 'raw';
}

type Section = ['preamble' | 'prompt' | 'response' | 'user' | 'assistant', string, string];

function parseSections(text: string): Section[] {
  reAnyMarker.lastIndex = 0;
  const markers = [...text.matchAll(reAnyMarker)];
  if (!markers.length) return [['preamble', '', text]];
  const map: Record<string, Section[0]> = {
    '=== Prompt': 'prompt',
    '=== Response': 'response',
    '=== USER': 'user',
    '=== ASSISTANT': 'assistant',
  };
  const sections: Section[] = [];
  if (markers[0].index > 0) {
    sections.push(['preamble', '', text.slice(0, markers[0].index)]);
  }
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const line = m[0];
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const typ = Object.entries(map).find(([k]) => line.startsWith(k))?.[1];
    if (typ) sections.push([typ, line, text.slice(m.index + m[0].length, end)]);
  }
  return sections;
}

function compressRaw(text: string): string {
  const sections = parseSections(text);
  const out: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const [typ, line, body] = sections[i];
    if (typ === 'prompt') {
      out.push(line + '\n');
      if (!(i + 1 < sections.length && sections[i + 1][0] === 'user')) {
        out.push(body);
      }
    } else if (typ === 'user' || typ === 'response') {
      out.push(line + '\n');
      out.push(body);
    } else if (typ === 'preamble') {
      out.push(body);
    }
  }
  return out.join('');
}

export function compressSession(
  src: string,
  dstDir = L4_DIR
): [string | null, Record<string, unknown> | string] {
  const text = fs.readFileSync(src, 'utf-8');
  rePrompt.lastIndex = 0;
  let timestamps = [...text.matchAll(rePrompt)].map((m) => m[1]).filter(Boolean) as string[];
  if (!timestamps.length) {
    reResponse.lastIndex = 0;
    timestamps = [...text.matchAll(reResponse)].map((m) => m[1]).filter(Boolean) as string[];
  }
  if (!timestamps.length) return [null, 'no timestamps found'];
  const tsFirst = tsFmt(timestamps[0]);
  if (!tsFirst) return [null, 'bad timestamp format'];
  const tsLast = tsFmt(timestamps[timestamps.length - 1]);
  const name = `${tsFirst}-${tsLast || tsFirst}.txt`;
  const fmt = detectFormat(text);
  const compressed = fmt === 'raw' ? compressRaw(text) : text;
  if (Buffer.byteLength(compressed, 'utf-8') < 4500) {
    return [null, `too small after compress (${Buffer.byteLength(compressed, 'utf-8')}B)`];
  }
  if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, name);
  fs.writeFileSync(dst, compressed, 'utf-8');
  const origKb = Math.floor(fs.statSync(src).size / 1024);
  const newKb = Math.floor(fs.statSync(dst).size / 1024);
  const ratio = (1 - newKb / Math.max(origKb, 1)) * 100;
  return [
    dst,
    {
      src: path.basename(src),
      dst: name,
      fmt,
      orig_kb: origKb,
      new_kb: newKb,
      ratio: `${ratio.toFixed(0)}%`,
      year: timestamps[0].slice(0, 4),
    },
  ];
}

const reHistory = /<history>(.*?)\s*<\/history>/s;

function parseHistoryBlock(raw: string): string[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.filter((l) => l.startsWith('[USER]') || l.startsWith('[Agent]'));
  if (parsed.length >= 2) return parsed;
  const joined = raw.trim();
  if (joined.includes('\\n[USER]') || joined.includes('\\n[Agent]')) {
    const parts = joined.replace(/\\n/g, '\n').split('\n');
    const p = parts
      .map((p) => p.trim())
      .filter((p) => p && (p.startsWith('[USER]') || p.startsWith('[Agent]')));
    if (p.length) return p;
  }
  return parsed;
}

function mergeHistoryBlocks(allBlocks: string[][]): string[] {
  if (!allBlocks.length) return [];
  const acc = [...allBlocks[0]];
  for (const block of allBlocks.slice(1)) {
    if (!block.length) continue;
    if (!acc.length) {
      acc.push(...block);
      continue;
    }
    let best = 0;
    for (let k = 1; k <= Math.min(acc.length, block.length); k++) {
      if (acc.slice(-k).join('\n') === block.slice(0, k).join('\n')) best = k;
    }
    if (best > 0) {
      acc.push(...block.slice(best));
    } else if (acc.includes(block[0])) {
      const idx = acc.lastIndexOf(block[0]);
      let matchLen = 0;
      for (let j = 0; j < Math.min(block.length, acc.length - idx); j++) {
        if (acc[idx + j] === block[j]) matchLen = j + 1;
        else break;
      }
      acc.push(...block.slice(matchLen));
    } else {
      acc.push(...block);
    }
  }
  return acc;
}

export function extractHistory(src: string, _sessionName?: string): string[] {
  const text = fs.readFileSync(src, 'utf-8');
  const allBlocks = [...text.matchAll(reHistory)]
    .map((m) => parseHistoryBlock(m[1]))
    .filter((b) => b.length);
  if (allBlocks.length) return mergeHistoryBlocks(allBlocks);
  return [];
}

export function formatHistoryBlock(sessionName: string, historyLines: string[]): string {
  const sep = '='.repeat(60);
  return `${sep}\nSESSION: ${sessionName}\n${sep}\n` + historyLines.join('\n') + '\n';
}

function existingSessions(l4Dir: string): Set<string> {
  const histPath = path.join(l4Dir, 'all_histories.txt');
  if (!fs.existsSync(histPath)) return new Set();
  return new Set(
    fs
      .readFileSync(histPath, 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('SESSION: '))
      .map((l) => l.replace('SESSION: ', '').trim())
  );
}

function sortedGlob(dir: string, pattern: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.')).test(f))
    .map((f) => path.join(dir, f));
}

function resolveRawDir(src: string | string[]): string {
  if (Array.isArray(src)) {
    if (!src.length) return process.cwd();
    const dirs = src.map((s) => path.resolve(path.dirname(s)));
    return dirs[0];
  }
  const resolved = path.resolve(src);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  return path.resolve(path.dirname(resolved));
}

export function batchProcess(
  src: string | string[],
  l4Dir: string | null = null,
  dryRun = true
): Record<string, unknown> {
  const targetDir = path.normalize(l4Dir || L4_DIR);
  const rawDir = resolveRawDir(src);
  const rawFiles = Array.isArray(src)
    ? [...src].sort()
    : sortedGlob(src, 'model_responses_*.txt').sort();
  if (!rawFiles.length) {
    console.log('No raw files found');
    return { processed: 0, skipped: 0, errors: 0, new_sessions: 0 };
  }

  // Safety: reject any raw file outside the configured raw directory
  const safeRawFiles = rawFiles.filter((fp) => {
    const ok = isPathContained(rawDir, fp);
    if (!ok) console.log(`[SAFETY] skipping raw file outside source dir: ${fp}`);
    return ok;
  });

  const existing = existingSessions(targetDir);
  console.log(`Found ${safeRawFiles.length} raw, ${existing.size} existing in L4`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs_batch_'));
  const results: [string, string, string[], Record<string, unknown>, string][] = [];
  const skipped: [string, string][] = [];
  const errors: [string, string][] = [];
  const cutoff = Date.now() / 1000 - 7200;

  for (const fp of safeRawFiles) {
    const fname = path.basename(fp);
    if (fs.statSync(fp).mtimeMs / 1000 > cutoff) {
      skipped.push([fname, 'recent(<2h)']);
      continue;
    }
    try {
      const [dst, info] = compressSession(fp, tmpDir);
      if (dst === null) {
        skipped.push([fname, info as string]);
        continue;
      }
      const sn = path.basename(dst, path.extname(dst));
      if (existing.has(sn)) {
        skipped.push([fname, `dup:${sn}`]);
        fs.unlinkSync(dst);
        continue;
      }
      results.push([sn, dst, extractHistory(dst), info as Record<string, unknown>, fp]);
    } catch (e) {
      errors.push([fname, e instanceof Error ? e.message : String(e)]);
    }
  }
  results.sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\nP1: ${results.length} new, ${skipped.length} skip, ${errors.length} err`);
  for (const [f, r] of skipped.slice(0, 5)) console.log(`  SKIP ${f}: ${r}`);
  for (const [f, e] of errors.slice(0, 5)) console.log(`  ERR  ${f}: ${e}`);
  if (results.length) console.log(`  Range: ${results[0][0]} → ${results[results.length - 1][0]}`);

  if (dryRun) {
    console.log('\n[DRY RUN] Pass dryRun=false to execute.');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      processed: results.length,
      skipped: skipped.length,
      errors: errors.length,
      new_sessions: results.length,
      sessions: results.map((r) => r[0]),
    };
  }

  const histPath = path.join(targetDir, 'all_histories.txt');
  for (const [sn, , hist] of results) {
    if (hist.length) {
      fs.appendFileSync(histPath, '\n' + formatHistoryBlock(sn, hist), 'utf-8');
    }
  }
  console.log(`Appended ${results.length} sessions to all_histories.txt`);

  const byMonth: Record<string, [string, string][]> = {};
  for (const [sn, cpath, , info] of results) {
    const year = (info.year as string) || '2026';
    const mk = `${year}-${sn.slice(0, 2)}`;
    byMonth[mk] = byMonth[mk] || [];
    byMonth[mk].push([sn, cpath]);
  }

  for (const mk of Object.keys(byMonth).sort()) {
    const items = byMonth[mk];
    // Node.js 没有内置 zip 追加，这里简化为单独写每个压缩文件到目标目录
    for (const [sn, cp] of items) {
      const target = path.join(targetDir, `${sn}.txt`);
      if (!isPathContained(targetDir, target)) {
        console.error(`[SAFETY] refusing to copy outside target dir: ${target}`);
        continue;
      }
      fs.copyFileSync(cp, target);
    }
    console.log(`  ${mk}: +${items.length} archived`);
  }

  const toDel: string[] = results.map((r) => r[4]);
  for (const [fname, reason] of skipped) {
    if (reason.includes('recent')) continue;
    const m = safeRawFiles.find((f) => path.basename(f) === fname);
    if (m) toDel.push(m);
  }
  let deleted = 0;
  for (const rp of toDel) {
    if (!isPathContained(rawDir, rp)) {
      console.error(`[SAFETY] refusing to delete outside raw dir: ${rp}`);
      continue;
    }
    try {
      fs.unlinkSync(rp);
      deleted++;
    } catch {}
  }
  console.log(`Deleted ${deleted}/${toDel.length} raw files`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  const report = {
    processed: results.length,
    skipped: skipped.length,
    errors: errors.length,
    new_sessions: results.length,
    deleted_raw: deleted,
  };
  console.log(`\nDone: ${JSON.stringify(report)}`);
  return report;
}

export default {
  L4_DIR,
  compressSession,
  extractHistory,
  formatHistoryBlock,
  batchProcess,
};
