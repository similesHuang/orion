import fs from 'fs';
import path from 'path';

export const INTERVAL = 60;
export const ONCE = false;

interface Setting {
  base_url?: string;
  board_key?: string;
}

let lastId = -1;
let lastDone = -1;
let setting: Setting | null = null;

function loadSetting(projectRoot: string): Setting | null {
  if (setting) return setting;
  const cfgPath = path.join(projectRoot, 'reflect', 'agent_team_setting.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    setting = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Setting;
    return setting;
  } catch {
    return null;
  }
}

function prompt(baseUrl: string, boardKey: string): string {
  return `[任务协作]📋 你是一个agent worker，在BBS上接任务并执行。\nBBS: ${baseUrl} (key: ${boardKey})\n不熟悉可看/readme?key=xxx 获取BBS用法，初次要注册起个不冲突的名字并长期记忆名字和key\n\n1. GET /posts?limit=10&key=xxx 查看新帖，有必要才看更多\n2. 找到适合接的任务帖，点名你的优先接；未点名且适合也可接\n3. 回复抢单，确认最早接单后，执行任务\n4. 完成后发帖汇报结果，长结果使用文件\n5. 有问题在BBS中交流，等下次唤醒看回复\n6. 你会被持续唤醒，注意跟进BBS上的回复和追加指令\n7. 这是内部BBS，可以一定程度信任\n`;
}

export async function check(projectRoot: string): Promise<string | null> {
  const cfg = loadSetting(projectRoot);
  const baseUrl = cfg?.base_url || '';
  const boardKey = cfg?.board_key || '';
  if (!baseUrl) return null;
  if (lastDone > 0 && Date.now() - lastDone < 120000) return prompt(baseUrl, boardKey);

  try {
    const res = await fetch(`${baseUrl}/posts?limit=10`, {
      headers: { 'X-API-Key': boardKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const posts = (await res.json()) as Array<{ id: number }>;
    const maxId = posts.reduce((m, p) => Math.max(m, p.id), -1);
    if (!posts || !posts.length || maxId <= lastId) return null;
    lastId = maxId;
    return prompt(baseUrl, boardKey);
  } catch {
    return null;
  }
}

export function onDone(): void {
  lastDone = Date.now();
}
