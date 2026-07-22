import { SessionConfig } from '../types/index.js';
import { loadEnvFile } from '../shared/index.js';

function toBool(v: string): boolean | undefined {
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return undefined;
}

function toNumber(v: string): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toJsonArray(v: string): Array<string | number> | undefined {
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed as Array<string | number>;
  } catch {}
  return undefined;
}

function parseSessionConfig(
  env: Record<string, string>,
  prefix: string
): { key: string; cfg: SessionConfig; type?: string } | null {
  const get = (k: string): string | undefined => env[`${prefix}${k}`];
  const apikey = get('APIKEY');
  const apibase = get('APIBASE');
  const model = get('MODEL');
  if (!apikey || !apibase || !model) return null;

  const cfg: SessionConfig = {
    apikey,
    apibase,
    model,
    name: get('NAME'),
  };

  const num = (k: string): number | undefined => {
    const v = get(k);
    if (!v) return undefined;
    return toNumber(v);
  };

  const bool = (k: string): boolean | undefined => {
    const v = get(k);
    if (!v) return undefined;
    return toBool(v);
  };

  const contextWin = num('CONTEXT_WIN');
  if (contextWin !== undefined) cfg.context_win = contextWin;

  if (get('PROXY')) cfg.proxy = get('PROXY');

  const maxRetries = num('MAX_RETRIES');
  if (maxRetries !== undefined) cfg.max_retries = maxRetries;

  const verify = bool('VERIFY');
  if (verify !== undefined) cfg.verify = verify;

  const stream = bool('STREAM');
  if (stream !== undefined) cfg.stream = stream;

  const timeout = num('TIMEOUT');
  if (timeout !== undefined) cfg.timeout = timeout;

  const readTimeout = num('READ_TIMEOUT');
  if (readTimeout !== undefined) cfg.read_timeout = readTimeout;

  if (get('REASONING_EFFORT')) cfg.reasoning_effort = get('REASONING_EFFORT') as SessionConfig['reasoning_effort'];
  if (get('THINKING_TYPE')) cfg.thinking_type = get('THINKING_TYPE') as SessionConfig['thinking_type'];

  const thinkingBudget = num('THINKING_BUDGET_TOKENS');
  if (thinkingBudget !== undefined) cfg.thinking_budget_tokens = thinkingBudget;

  if (get('API_MODE')) cfg.api_mode = get('API_MODE') as SessionConfig['api_mode'];

  const temperature = num('TEMPERATURE');
  if (temperature !== undefined) cfg.temperature = temperature;

  const maxTokens = num('MAX_TOKENS');
  if (maxTokens !== undefined) cfg.max_tokens = maxTokens;

  const fakeCc = bool('FAKE_CC_SYSTEM_PROMPT');
  if (fakeCc !== undefined) cfg.fake_cc_system_prompt = fakeCc;

  if (get('USER_AGENT')) cfg.user_agent = get('USER_AGENT');

  const llmNosRaw = get('LLM_NOS');
  if (llmNosRaw) {
    const llmNos = toJsonArray(llmNosRaw);
    if (llmNos !== undefined) cfg.llm_nos = llmNos;
  }

  const baseDelay = num('BASE_DELAY');
  if (baseDelay !== undefined) cfg.base_delay = baseDelay;

  const springBack = num('SPRING_BACK');
  if (springBack !== undefined) cfg.spring_back = springBack;

  const key = get('NAME') || (prefix === 'LLM_' ? 'llm' : prefix.replace(/_$/, '').toLowerCase());
  return { key, cfg, type: get('TYPE') };
}

export function envToSessionConfigs(env: Record<string, string>): Record<string, { cfg: SessionConfig; type?: string }> {
  const configs: Record<string, { cfg: SessionConfig; type?: string }> = {};

  // Single config: LLM_*
  const single = parseSessionConfig(env, 'LLM_');
  if (single) configs[single.key] = { cfg: single.cfg, type: single.type };

  // Indexed configs: LLM_0_*, LLM_1_*, ...
  const indexedPrefixes = new Set<string>();
  for (const key of Object.keys(env)) {
    const m = key.match(/^(LLM_\d+)_/);
    if (m) indexedPrefixes.add(m[1] + '_');
  }
  for (const prefix of Array.from(indexedPrefixes).sort()) {
    const item = parseSessionConfig(env, prefix);
    if (item) configs[item.key] = { cfg: item.cfg, type: item.type };
  }

  return configs;
}

export function loadEnv(dotenvPath?: string): Record<string, string> {
  return { ...loadEnvFile(dotenvPath), ...process.env } as Record<string, string>;
}
