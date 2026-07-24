import fs from 'fs';
import path from 'path';

const PROJECT_MARKERS = ['assets', 'memory', 'package.json'];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findProjectRoot(startDir?: string): string {
  let dir = path.resolve(startDir || process.cwd());
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (PROJECT_MARKERS.every((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Check whether `target` is contained within `parent` after realpath resolution.
 * Both paths are normalized and resolved.
 */
export function isPathContained(parent: string, target: string): boolean {
  let resolvedParent: string;
  try {
    resolvedParent = fs.realpathSync(parent);
  } catch {
    resolvedParent = path.resolve(parent);
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = fs.realpathSync(target);
  } catch {
    resolvedTarget = path.resolve(target);
  }
  const rel = path.relative(resolvedParent, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `p` under `baseDir` and ensure it stays within `baseDir`.
 * Throws if the resolved path escapes the base directory.
 */
export function resolveAllowedPath(baseDir: string, p: string): string {
  if (path.isAbsolute(p)) {
    throw new Error(`Absolute paths are not allowed: ${p}`);
  }
  const resolved = path.resolve(baseDir, p);
  if (!isPathContained(baseDir, resolved)) {
    throw new Error(`Path escapes allowed directory: ${p}`);
  }
  return resolved;
}

export function smartFormat(data: unknown, maxStrLen = 100, omitStr = ' ... '): string {
  const s = typeof data === 'string' ? data : String(data);
  if (s.length < maxStrLen + omitStr.length * 2) return s;
  return `${s.slice(0, Math.floor(maxStrLen / 2))}${omitStr}${s.slice(-Math.floor(maxStrLen / 2))}`;
}

function getProjectRoot(): string {
  return findProjectRoot();
}

export function getGlobalMemory(): string {
  let prompt = '\n';
  try {
    const suffix = process.env.GA_LANG === 'en' ? '_en' : '';
    const insight = fs.readFileSync(path.join(getProjectRoot(), 'memory', 'global_mem_insight.txt'), 'utf-8');
    const structure = fs.readFileSync(path.join(getProjectRoot(), `assets/insight_fixed_structure${suffix}.txt`), 'utf-8');
    prompt += `cwd = ${path.join(getProjectRoot(), 'temp')} (./)\n`;
    prompt += '\n[Memory] (../memory)\n';
    prompt += structure + '\n../memory/global_mem_insight.txt:\n';
    prompt += insight + '\n';
  } catch {
    // ignore missing memory files
  }
  return prompt;
}
