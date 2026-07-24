import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

export interface SandboxResult {
  result: unknown;
  error?: string;
}

function sandboxScript(code: string, timeoutMs: number, cwd: string): string {
  return `
const vm = require('vm');
const code = ${JSON.stringify(code)};
const ns = vm.createContext({ _r: undefined });
const oldCwd = process.cwd();
let result;
try {
  process.chdir(${JSON.stringify(cwd)});
  vm.runInContext(code, ns, { timeout: ${timeoutMs} });
  result = { result: ns._r ?? 'OK' };
} catch (e) {
  result = { error: e.name + ': ' + e.message };
} finally {
  try { process.chdir(oldCwd); } catch {}
}
process.stdout.write(JSON.stringify(result));
`;
}

export function runInlineSandbox(code: string, timeoutMs: number, cwd: string): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const script = sandboxScript(code, timeoutMs, cwd);
    const proc = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(__filename),
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeoutMs + 1000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve({ result: null, error: `${error.name}: ${error.message}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ result: null, error: 'Sandbox timeout' });
        return;
      }
      if (code !== 0) {
        resolve({ result: null, error: stderr || `Sandbox exited with code ${code}` });
        return;
      }
      try {
        resolve(JSON.parse(stdout) as SandboxResult);
      } catch {
        resolve({ result: stdout.trim(), error: stderr || undefined });
      }
    });
  });
}
