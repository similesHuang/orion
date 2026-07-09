import fs from 'fs';
import path from 'path';

export * from './run-python.js';

export function loadMykey(scriptFile?: string): Record<string, unknown> {
  let dir = scriptFile ? path.dirname(scriptFile) : process.cwd();
  if (dir.endsWith('dist') || dir.includes(`${path.sep}dist${path.sep}`) || dir.endsWith('src') || dir.includes(`${path.sep}src${path.sep}`)) {
    dir = path.resolve(dir, '..');
  }
  while (true) {
    for (const name of ['mykey.json', 'mykey.template.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[2];
    let value = m[3].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFile(startDir?: string): Record<string, string> {
  let dir = startDir ? path.resolve(startDir) : process.cwd();
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) {
      try {
        return parseEnvFile(fs.readFileSync(p, 'utf-8'));
      } catch {
        return {};
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

export function projectRootFrom(scriptFile?: string): string {
  let dir = scriptFile ? path.dirname(scriptFile) : process.cwd();
  if (dir.endsWith('dist') || dir.includes(`${path.sep}dist${path.sep}`) || dir.endsWith('src') || dir.includes(`${path.sep}src${path.sep}`)) {
    dir = path.resolve(dir, '..');
  }
  return dir;
}

const PROJECT_MARKERS = ['assets', 'memory', 'package.json'];

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
