import { spawn, spawnSync } from 'child_process';

export interface RunPythonOptions {
  timeout?: number;
  cwd?: string;
}

export interface RunPythonResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export function runPythonArgs(args: string[], options?: RunPythonOptions): RunPythonResult {
  const timeout = options?.timeout ?? 60000;
  const r = spawnSync('python3', args, { encoding: 'utf-8', timeout, cwd: options?.cwd });
  if (r.status === null && r.error) {
    const r2 = spawnSync('python', args, { encoding: 'utf-8', timeout, cwd: options?.cwd });
    return { stdout: r2.stdout || '', stderr: r2.stderr || '', status: r2.status, error: r2.error || r.error };
  }
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, error: r.error };
}

export function runPythonCode(code: string, options?: RunPythonOptions): RunPythonResult {
  return runPythonArgs(['-c', code], options);
}

export async function runPythonArgsAsync(args: string[], options?: RunPythonOptions): Promise<RunPythonResult> {
  const timeout = options?.timeout ?? 60000;

  async function tryRunner(binary: string): Promise<RunPythonResult> {
    return new Promise((resolve) => {
      const proc = spawn(binary, args, { cwd: options?.cwd });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeout);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, status: null, error });
      });
      proc.on('close', (status) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, status: killed ? null : status });
      });
    });
  }

  const r = await tryRunner('python3');
  if (r.status === null && r.error) return tryRunner('python');
  return r;
}

export async function runPythonCodeAsync(code: string, options?: RunPythonOptions): Promise<RunPythonResult> {
  return runPythonArgsAsync(['-c', code], options);
}
