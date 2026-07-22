/** Process memory scanner stub.
 *  The Python version uses ctypes + yara on Windows to scan process memory.
 *  Node.js has no portable equivalent; this module exposes the same API but
 *  only delegates to the Python script on Windows when available.
 */
import path from 'path';
import { globalPath, runPythonArgsAsync } from '../shared/index.js';

// Python fallback script is not currently bundled; path is kept consistent with global assets.
const PY_SCRIPT = globalPath('assets', 'python', 'procmem_scanner.py');

export interface MemoryHit {
  address: string;
  offset: string;
  hex: string;
  ascii: string;
  hit_pos: number;
}

export async function scanMemory(
  pid: number,
  pattern: string,
  _contextSize = 256,
  mode: 'auto' | 'hex' | 'text' = 'auto',
  llmMode = false
): Promise<MemoryHit[] | string[]> {
  if (process.platform !== 'win32') {
    throw new Error('scanMemory is only supported on Windows');
  }
  const args = [PY_SCRIPT, String(pid), pattern, '--mode', mode];
  if (llmMode) args.push('--llm');
  const r = await runPythonArgsAsync(args, { timeout: 300000 });
  if (r.status !== 0) throw new Error(`procmem_scanner failed: ${r.stderr || r.stdout}`);
  const line = r.stdout.split('\n').reverse().find((l: string) => l.trim().startsWith(llmMode ? '[' : 'Matches:'));
  if (!line) return [];
  if (llmMode) return JSON.parse(line) as MemoryHit[];
  return [line];
}
