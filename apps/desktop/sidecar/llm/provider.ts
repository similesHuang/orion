/**
 * LLMProvider adapter for the desktop sidecar.
 *
 * Wraps @orion/core's loadSessionsFromEnv + NativeToolClient into the
 * engine's LLMProvider interface. This file is a bridge until the LLM
 * session implementations are moved out of @orion/core into the sidecar.
 */
import { loadSessionsFromEnv, createClient } from '@orion/core';
import type { NativeToolClient, BaseSession } from '@orion/core';
import type { LLMProvider, ChatOptions } from '@orion/engine';
import type { LLMStreamDelta, LLMResponse } from '@orion/engine';

/** Sessions cache to support LLM switching. */
let _sessions: BaseSession[] | null = null;
let _client: NativeToolClient | null = null;
let _index = 0;

export function getSessionCount(): number {
  if (!_sessions) return 0;
  return _sessions.length;
}

export function getCurrentIndex(): number {
  return _index;
}

export function switchSession(deltaOrIndex: number): string {
  if (!_sessions) return 'No sessions loaded';
  if (deltaOrIndex >= 0 && deltaOrIndex < _sessions.length) {
    _index = deltaOrIndex;
  } else {
    _index = (_index + 1) % _sessions.length;
  }
  _client = createClient(_sessions, _index);
  const session = _sessions[_index];
  return `${session.constructor.name}/${session.name}`;
}

export function listSessions(): string {
  if (!_sessions) return 'No sessions loaded';
  return _sessions
    .map((s: BaseSession, i: number) => `${i}: ${s.constructor.name}/${s.name}${i === _index ? ' *' : ''}`)
    .join('\n');
}

export function getBackendSnapshot(): unknown[][] {
  if (!_sessions) return [];
  return _sessions.map((s: BaseSession) => s.history as unknown[]);
}

export function restoreBackendSnapshot(histories: unknown[][]): void {
  if (!_sessions) return;
  histories.forEach((history, idx) => {
    const session = _sessions![idx];
    if (session) {
      session.history = JSON.parse(JSON.stringify(history));
    }
  });
  if (_sessions[_index]) {
    (_client as unknown as Record<string, unknown>).backend = _sessions[_index];
  }
}

/**
 * Create an LLMProvider by loading sessions from .env.
 * Returns null if no valid config is found.
 */
export function createDesktopProvider(dotenvPath?: string): LLMProvider | null {
  try {
    _sessions = loadSessionsFromEnv(dotenvPath);
    if (!_sessions.length) return null;
    _client = createClient(_sessions, 0);
    _index = 0;
  } catch {
    return null;
  }

  return {
    get name(): string {
      return _client?.name ?? 'unknown';
    },
    get model(): string {
      return _client?.backend.model ?? 'unknown';
    },
    chat(options: ChatOptions) {
      if (!_client) throw new Error('LLM not initialized');
      return _client.chat(options as Parameters<typeof _client.chat>[0]);
    },
  };
}
