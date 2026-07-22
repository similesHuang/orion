import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export interface OrionStorage {
  globalRoot: string;
  workspaceRoot: string;
  globalPath(...parts: string[]): string;
  workspacePath(...parts: string[]): string;
}

let storage: OrionStorage | null = null;

function isWindows(): boolean {
  return process.platform === 'win32';
}

export function getDefaultGlobalRoot(): string {
  const explicit = process.env.ORION_GLOBAL_DIR;
  if (explicit) return path.resolve(explicit);

  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return path.join(localAppData, 'orion');
    const userProfile = process.env.USERPROFILE;
    if (userProfile) return path.join(userProfile, '.orion');
    return path.join(os.homedir(), '.orion');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'orion');
  }

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'orion');
  return path.join(os.homedir(), '.orion');
}

export function findWorkspaceRoot(startDir?: string): string {
  const explicit = process.env.ORION_WORKSPACE_DIR;
  if (explicit) return path.resolve(explicit);

  let dir = startDir ? path.resolve(startDir) : process.cwd();
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (
      ['.git', 'package.json', '.orion'].some((m) =>
        fs.existsSync(path.join(dir, m))
      )
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export { findWorkspaceRoot as findProjectRoot };

export function initStorage(options?: {
  workspaceRoot?: string;
  globalRoot?: string;
}): OrionStorage {
  const globalRoot = path.resolve(options?.globalRoot ?? getDefaultGlobalRoot());
  const workspaceRoot = path.resolve(
    options?.workspaceRoot ?? findWorkspaceRoot()
  );

  storage = {
    globalRoot,
    workspaceRoot,
    globalPath(...parts: string[]) {
      return path.join(globalRoot, ...parts);
    },
    workspacePath(...parts: string[]) {
      return path.join(workspaceRoot, ...parts);
    },
  };

  return storage;
}

export function getStorage(): OrionStorage {
  if (!storage) {
    return initStorage();
  }
  return storage;
}

export function setStorage(s: OrionStorage): void {
  storage = s;
}

export function getGlobalRoot(): string {
  return getStorage().globalRoot;
}

export function getWorkspaceRoot(): string {
  return getStorage().workspaceRoot;
}

export function globalPath(...parts: string[]): string {
  return getStorage().globalPath(...parts);
}

export function workspacePath(...parts: string[]): string {
  return getStorage().workspacePath(...parts);
}

const GLOBAL_DIRS = ['assets', 'memory', 'config', 'skills', 'cache'];
const WORKSPACE_DIRS = ['.orion/temp', '.orion/state'];

export function ensureStorageDirs(): void {
  const s = getStorage();
  for (const d of GLOBAL_DIRS) {
    fs.mkdirSync(s.globalPath(d), { recursive: true });
  }
  for (const d of WORKSPACE_DIRS) {
    fs.mkdirSync(s.workspacePath(d), { recursive: true });
  }
}

function findRepoAssetsSeed(): string | null {
  try {
    const meta = import.meta.url;
    const thisFile = meta ? fileURLToPath(meta) : __filename;
    const thisDir = path.dirname(thisFile);
    // packages/shared/src/storage.ts  -> up 3 = repo root
    // packages/shared/dist/storage.js -> up 3 = repo root
    const candidate = path.resolve(thisDir, '..', '..', '..', 'assets');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // ignore
  }
  return null;
}

export function getAssetSeedDir(): string | null {
  const env = process.env.ORION_ASSETS_SEED_DIR;
  if (env) return path.resolve(env);
  return findRepoAssetsSeed();
}

export function seedGlobalAssets(seedDir?: string): void {
  const s = getStorage();
  const src = seedDir ? path.resolve(seedDir) : getAssetSeedDir();
  if (!src || !fs.existsSync(src)) {
    console.warn('[orion] asset seed dir not found, skipping asset seeding');
    return;
  }
  const dst = s.globalPath('assets');
  fs.mkdirSync(dst, { recursive: true });

  function copyRecursive(from: string, to: string) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const srcPath = path.join(from, entry.name);
      const dstPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        copyRecursive(srcPath, dstPath);
      } else if (!fs.existsSync(dstPath)) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  copyRecursive(src, dst);
}

export function isGlobalInitialized(): boolean {
  return fs.existsSync(getStorage().globalPath('.initialized'));
}

export function markGlobalInitialized(): void {
  fs.writeFileSync(
    getStorage().globalPath('.initialized'),
    new Date().toISOString() + '\n'
  );
}
