import fs from 'fs';
import path from 'path';
import { workspacePath } from '../shared/index.js';
import http from 'http';
import https from 'https';

export const INTERVAL = 60;
export const ONCE = false;

let folder = '';
let lastPostId = -1;

function loadState(): Record<string, unknown> | null {
  const p = path.join(folder, 'state.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function pollBbs(data: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const bbs = data.bbs as { url?: string; key?: string } | undefined;
  if (!bbs) return [];
  const url = bbs.url;
  const key = bbs.key;
  if (!url) return [];
  try {
    const posts = (await fetchJson(`${url}/posts?limit=20&key=${encodeURIComponent(key || '')}`)) as Array<Record<string, unknown>>;
    if (!Array.isArray(posts) || !posts.length) return [];
    const maxId = posts.reduce((m, p) => Math.max(m, p.id as number), -1);
    const newPosts = posts.filter((p) => (p.id as number) > lastPostId);
    lastPostId = maxId;
    return newPosts;
  } catch {
    return [];
  }
}

function promptText(data: Record<string, unknown>, newPosts: Array<Record<string, unknown>>): string {
  const bbs = data.bbs as { url?: string; key?: string } | undefined;
  const goal = String(data.goal || '');
  const mode = bbs ? 'mapreduce' : 'checklist';
  const tasks = (data.tasks as Array<{ result?: unknown }>) || [];
  let trigger: string;
  if (newPosts.length) {
    trigger = '有新回帖，去BBS查看并验收';
  } else if (tasks.some((t) => t.result == null)) {
    trigger = bbs ? '有未完成任务，继续执行' : '有未完成任务，派发';
  } else {
    trigger = '无未完成任务，该plan下一步了';
  }
  const lines = [`你是 Checklist Master（${mode}模式）。阅读 checklist_sop.md 21行之后按 Master 行事。`];
  if (bbs?.url) lines.push(`BBS API文档（requests）: GET ${bbs.url}/readme?key=${bbs.key || ''}`);
  lines.push(`目标: ${goal}`);
  lines.push(`唤醒原因: ${trigger}`);
  lines.push(`用 checklist_helper 的 CL("${folder}") 管理状态（look/add/mark/close）。按决策树行动。`);
  if (bbs) lines.push('【禁止】你只负责派发+轮询+验收，绝不自己执行任务。');
  return lines.join('\n');
}

let checkTimes = 0;

export function init(args: { mr_folder?: string }): void {
  folder = args.mr_folder || '';
}

export async function check(projectRoot: string): Promise<string | null> {
  checkTimes += 1;
  if (checkTimes > 1000) return '/exit';
  if (!folder) folder = workspacePath('.orion', 'state');
  const data = loadState();
  if (!data || data.closed) return '/exit';
  const bbs = data.bbs as { url?: string } | undefined;
  if (!bbs) return promptText(data, []);
  const newPosts = await pollBbs(data);
  const tasks = (data.tasks as Array<{ result?: unknown }>) || [];
  const hasOpen = tasks.some((t) => t.result == null);
  if (newPosts.length && hasOpen) return promptText(data, newPosts);
  if (!hasOpen && (!tasks.length || Math.random() < 0.2)) return promptText(data, newPosts);
  return null;
}
