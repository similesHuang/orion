// ---------------------------------------------------------------------------
// CodeExecutor
// ---------------------------------------------------------------------------

export interface CodeExecutionResult {
  status: 'success' | 'error';
  stdout: string;
  exit_code: number | null;
  msg?: string;
}

/**
 * Pluggable code executor interface.
 *
 * Implementations handle the actual spawning of child processes and
 * execution of user-provided code. This allows different backends
 * (local spawn, container, remote sandbox) without changing the agent.
 */
export interface CodeExecutor {
  run(
    code: string,
    codeType: string,
    timeoutSec: number,
    cwd: string,
    codeCwd?: string,
    stopSignal?: number[],
  ): AsyncGenerator<string, CodeExecutionResult, unknown>;
}
