/** Skill 检索引擎 — API 客户端（含数据模型与环境检测） */
import { execSync } from 'child_process';
import os from 'os';

export interface SkillIndex {
  key: string;
  name: string;
  description: string;
  one_line_summary: string;
  category: string;
  tags: string[];
  language: string;
  os: string[];
  shell: string[];
  runtimes: string[];
  tools: string[];
  services: string[];
  needs_tool_calling: boolean;
  needs_reasoning: boolean;
  min_context_window: string;
  decay_risk: string;
  clarity: number;
  completeness: number;
  actionability: number;
  autonomous_safe: boolean;
  blast_radius: string;
  requires_credentials: boolean;
  data_exposure: string;
  effect_scope: string;
  form: string;
  estimated_tokens: string;
  capabilities: string[];
  github_stars: number;
  github_url: string;
}

export interface SearchResult {
  skill: SkillIndex;
  relevance: number;
  quality: number;
  final_score: number;
  match_reasons: string[];
  warnings: string[];
}

export function skillIndexFromDict(d: Record<string, unknown>): SkillIndex {
  return {
    key: String(d.key || ''),
    name: String(d.name || ''),
    description: String(d.description || ''),
    one_line_summary: String(d.one_line_summary || ''),
    category: String(d.category || ''),
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    language: String(d.language || 'en'),
    os: Array.isArray(d.os) ? d.os.map(String) : [],
    shell: Array.isArray(d.shell) ? d.shell.map(String) : [],
    runtimes: Array.isArray(d.runtimes) ? d.runtimes.map(String) : [],
    tools: Array.isArray(d.tools) ? d.tools.map(String) : [],
    services: Array.isArray(d.services) ? d.services.map(String) : [],
    needs_tool_calling: !!d.needs_tool_calling,
    needs_reasoning: !!d.needs_reasoning,
    min_context_window: String(d.min_context_window || 'standard'),
    decay_risk: String(d.decay_risk || 'low'),
    clarity: Number(d.clarity || 0),
    completeness: Number(d.completeness || 0),
    actionability: Number(d.actionability || 0),
    autonomous_safe: d.autonomous_safe !== false,
    blast_radius: String(d.blast_radius || 'low'),
    requires_credentials: !!d.requires_credentials,
    data_exposure: String(d.data_exposure || 'none'),
    effect_scope: String(d.effect_scope || 'local'),
    form: String(d.form || ''),
    estimated_tokens: String(d.estimated_tokens || 'medium'),
    capabilities: Array.isArray(d.capabilities) ? d.capabilities.map(String) : [],
    github_stars: Number(d.github_stars || 0),
    github_url: String(d.github_url || ''),
  };
}

export function searchResultFromDict(d: Record<string, unknown>): SearchResult {
  const rawSkill = (d.skill as Record<string, unknown>) || d;
  return {
    skill: skillIndexFromDict(rawSkill),
    relevance: Number(d.relevance || 0),
    quality: Number(d.quality || 0),
    final_score: Number(d.final_score || 0),
    match_reasons: Array.isArray(d.match_reasons) ? d.match_reasons.map(String) : [],
    warnings: Array.isArray(d.warnings) ? d.warnings.map(String) : [],
  };
}

function which(cmd: string): boolean {
  try {
    const shell = process.platform === 'win32' ? 'cmd' : 'bash';
    const check = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(`${check} >/dev/null 2>&1`, { shell, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function detectOs(): string {
  const s = os.platform().toLowerCase();
  return { darwin: 'macos', linux: 'linux', win32: 'windows' }[s] || s;
}

function detectShell(): string {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (process.platform === 'win32') return 'powershell';
  return shell ? pathBasename(shell) : 'unknown';
}

function pathBasename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || '';
}

function detectRuntimes(): string[] {
  const checks: Record<string, string[]> = {
    python: ['python3', 'python'],
    node: ['node'],
    go: ['go'],
    rust: ['rustc'],
    java: ['java'],
    ruby: ['ruby'],
    php: ['php'],
    dotnet: ['dotnet'],
  };
  const found: string[] = [];
  for (const [name, cmds] of Object.entries(checks)) {
    if (cmds.some(which)) found.push(name);
  }
  return found;
}

function detectTools(): string[] {
  const tools = [
    'git',
    'docker',
    'npm',
    'pip',
    'curl',
    'wget',
    'kubectl',
    'terraform',
    'aws',
    'gcloud',
    'az',
    'brew',
    'cargo',
    'make',
    'cmake',
  ];
  return tools.filter(which);
}

export interface EnvironmentInfo {
  os: string;
  shell: string;
  runtimes: string[];
  tools: string[];
  model: {
    tool_calling: boolean;
    reasoning: boolean;
    context_window: string;
  };
}

export function detectEnvironment(): EnvironmentInfo {
  return {
    os: detectOs(),
    shell: detectShell(),
    runtimes: detectRuntimes(),
    tools: detectTools(),
    model: { tool_calling: true, reasoning: true, context_window: 'large' },
  };
}

const DEFAULT_API_URL = 'https://www.fudankw.cn:58787';

function getApiUrl(): string {
  return process.env.SKILL_SEARCH_API || DEFAULT_API_URL;
}

function getApiKey(): string | undefined {
  return process.env.SKILL_SEARCH_KEY;
}

export class SkillSearchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SkillSearchError';
  }
}

async function apiRequest(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${getApiUrl()}/${endpoint}`;
  const parsedUrl = new URL(url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) {
    if (parsedUrl.protocol !== 'https:') {
      if (process.env.SKILL_SEARCH_ALLOW_HTTP === 'true') {
        console.warn('[skill-search] sending API key over plain HTTP because SKILL_SEARCH_ALLOW_HTTP=true');
      } else {
        throw new SkillSearchError('Refusing to send API key over plain HTTP. Use HTTPS or set SKILL_SEARCH_ALLOW_HTTP=true.');
      }
    }
    headers.Authorization = `Bearer ${key}`;
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new SkillSearchError(`API 错误 ${resp.status}: ${body}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SkillSearchError) throw e;
    throw new SkillSearchError(`请求失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function search(
  query: string,
  env?: EnvironmentInfo,
  category?: string,
  topK = 10
): Promise<SearchResult[]> {
  const payload: Record<string, unknown> = { query, env: env || detectEnvironment(), top_k: topK };
  if (category) payload.category = category;
  const resp = await apiRequest('search', payload);
  const results = Array.isArray(resp.results) ? resp.results : [];
  return results.map((r) => searchResultFromDict(r as Record<string, unknown>));
}

export async function getStats(env?: EnvironmentInfo): Promise<Record<string, unknown>> {
  return apiRequest('stats', { env: env || detectEnvironment() });
}
