import fs from 'fs';
import path from 'path';
import { getWorkspaceRoot, globalPath } from '@orion/shared';

const PROMPT_DIR = 'review_sop';
const INLINE_PROMPT_ZH = 'review_inline_prompt.txt';
const INLINE_PROMPT_EN = 'review_inline_prompt.en.txt';

const STUB_FALLBACK =
  '[/review in-session] (⚠️ prompt 文件缺失: {fpath} → {err})\n\n' +
  '# 本轮用户请求\n{user_request}\n\n' +
  '请按 memory/code_review_principles.md 评审,直接 echo 报告到对话。\n' +
  '不要写 review.md,不要打 [ROUND END]。';

function projectRoot(): string {
  return getWorkspaceRoot();
}

function renderPrompt(userRequest: string): string {
  const lang = (process.env.GA_LANG || '').trim().toLowerCase();
  const fname = lang === 'en' ? INLINE_PROMPT_EN : INLINE_PROMPT_ZH;
  const fpath = globalPath('memory', PROMPT_DIR, fname);
  const gaRoot = projectRoot().replace(/\\/g, '/');
  try {
    return fs.readFileSync(fpath, 'utf-8').replace(/\{user_request\}/g, userRequest).replace(/\{ga_root\}/g, gaRoot);
  } catch (e) {
    return STUB_FALLBACK
      .replace(/\{fpath\}/g, fpath)
      .replace(/\{err\}/g, e instanceof Error ? e.message : String(e))
      .replace(/\{user_request\}/g, userRequest);
  }
}

function helpText(): string {
  return (
    '**/review 用法**: in-session adversarial code reviewer\n\n' +
    '`/review                  ` # 默认审本次 uncommitted 改动(主 agent 跑 git diff)\n' +
    '`/review <自然语言请求>   ` # 主 agent 按你描述的范围去审\n\n' +
    '例:\n' +
    '  `/review`\n' +
    '  `/review 我刚改了 review_cmd.py 和 tuiapp_v2.py,关注 prompt 注入`\n' +
    '  `/review 审 frontends 目录下所有改过的文件`\n\n' +
    '产出:直接对话 markdown(不写文件、不开 subagent)。\n' +
    '协议: `memory/review_sop/review_inline_prompt.txt` + `memory/code_review_principles.md`'
  );
}

function defaultRequest(): string {
  const en = process.env.GA_LANG === 'en';
  return en
    ? '(no specific request — default to uncommitted diff: run `git diff --stat HEAD` and `git diff HEAD`)'
    : '(无具体请求 — 默认审本次 uncommitted 改动:用 code_run 跑 `git diff --stat HEAD` 与 `git diff HEAD`)';
}

function header(): string {
  return process.env.GA_LANG === 'en'
    ? '> 🔍 /review (in-session) → main agent reviews here, echoes the report inline\n\n'
    : '> 🔍 /review (in-session) → 主 agent 当场审,直接 echo 报告\n\n';
}

export function handleReviewFrontend(_agent: unknown, query: string): string {
  const body = (query || '').trim().replace(/^\/review\s*/, '').trim();
  if (['help', '?', '-h', '--help'].includes(body)) {
    return helpText();
  }
  const userRequest = body || defaultRequest();
  return header() + renderPrompt(userRequest);
}
