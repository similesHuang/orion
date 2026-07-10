import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { getStorage, getWorkspaceRoot, ensureStorageDirs, seedGlobalAssets, markGlobalInitialized } from './storage.js';

export * from './run-python.js';
export * from './storage.js';

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

export function loadSettings(): Record<string, unknown> {
  const { globalPath } = getStorage();
  const settingsFile = globalPath('config', 'settings.yaml');
  if (fs.existsSync(settingsFile)) {
    try {
      const content = fs.readFileSync(settingsFile, 'utf-8');
      return (yaml.load(content) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }
  // Fallback: merge legacy .env and mykey.json during transition.
  const env = loadEnvFile(getWorkspaceRoot());
  const mykey = loadMykey(getWorkspaceRoot());
  return { ...env, ...mykey };
}

export function saveSettings(settings: Record<string, unknown>): void {
  const { globalPath } = getStorage();
  const configDir = globalPath('config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    globalPath('config', 'settings.yaml'),
    yaml.dump(settings, { indent: 2, lineWidth: 120 }),
    'utf-8'
  );
}

export function applySettingsToEnv(settings?: Record<string, unknown>): Record<string, unknown> {
  const s = settings ?? loadSettings();
  for (const [key, value] of Object.entries(s)) {
    if (process.env[key] !== undefined) continue;
    if (typeof value === 'string') {
      process.env[key] = value;
    } else if (value !== undefined && value !== null) {
      process.env[key] = JSON.stringify(value);
    }
  }
  return s;
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (!fs.existsSync(dstPath)) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

export function migrateFromLegacy(sourceDir?: string): void {
  const src = path.resolve(sourceDir ?? getWorkspaceRoot());
  const s = getStorage();

  ensureStorageDirs();

  const assetsSrc = path.join(src, 'assets');
  const memorySrc = path.join(src, 'memory');
  const envPath = path.join(src, '.env');
  const mykeyPath = path.join(src, 'mykey.json');

  if (fs.existsSync(assetsSrc)) {
    copyDirRecursive(assetsSrc, s.globalPath('assets'));
  }
  if (fs.existsSync(memorySrc)) {
    copyDirRecursive(memorySrc, s.globalPath('memory'));
  }

  const env = fs.existsSync(envPath) ? loadEnvFile(src) : {};
  const mykey = fs.existsSync(mykeyPath) ? loadMykey(src) : {};
  const merged = { ...env, ...mykey };

  const settingsFile = s.globalPath('config', 'settings.yaml');
  if (Object.keys(merged).length > 0) {
    if (fs.existsSync(settingsFile)) {
      console.warn('[orion] settings.yaml already exists, skipping config migration');
    } else {
      saveSettings(merged);
    }
  }

  seedGlobalAssets();
  markGlobalInitialized();
  console.log(`[orion] migrated data from ${src} to ${s.globalRoot}`);
}
