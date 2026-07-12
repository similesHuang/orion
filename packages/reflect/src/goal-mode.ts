import fs from 'fs';
import path from 'path';
import { workspacePath } from '@orion/shared';

export const INTERVAL = 5;
export const ONCE = false;

let stateFile = '';

function resolveStateFile(projectRoot: string, explicit?: string): string {
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(projectRoot, explicit);
  return workspacePath('.orion', 'state', 'goal_state.json');
}

function loadState(): Record<string, unknown> | null {
  if (!stateFile || !fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function saveState(state: Record<string, unknown>): void {
  if (!stateFile) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

const CONTINUATION_PROMPT = `[Goal Mode — 持续优化]

<objective>
{objective}
</objective>

⏱ 已用 {elapsed_min:.0f} 分钟，剩余约 {remaining_min:.0f} 分钟。第 {turn} 次唤醒。

你正在 Goal Mode 下工作：无法宣告完成，你会被无法阻止地持续唤醒直到预算耗尽
唤醒后流程（3选1）：
1. 创造阶段(第一次唤醒)：分析objective，在cwd建工作文件夹，严格按照objective执行
2. 检验阶段：从不同视角检验创造结果，产出检验报告
    - 换身份查看（读者/受众/用户/测试工程师/领导） | 设计未跑过的更难测例 | 查素材/事实/引用的真实性与数量/说服力 | 代码质量/产物格式/美观 | 实测验证(亲自执行/模拟用户操作)
    - 按任务类型**轮换**选用合适的角色和方法
    - 在遵循原始需求约束下追求超预期，拒绝保守和平庸，必须提出“不够出色”的点
    - 先保及格线（无事实错误/乱码/格式错误，能运行，过基础测例，遵循用户约束），及格同时追求出色
3. 改进阶段：针对检验报告优化改进交付物，必须实质性改进

原则：
1. 每次唤醒**交替**进行检验阶段和改进阶段，保留每次的检验报告和改进changelog。
2. 除非发现严重问题，不要对创造结果进行完全重写，而是改进
3. 严格区分交付物和进度报告，交付物中不要混入\`已检验\`等中间信息
4. 若检验都是无关紧要问题，下次升级检验（要求更出色产物/更苛刻视角/更难测试/对照原始需求重审/开subagent第三方评审）
5. 改进阶段禁止产出"无改动"。若检验未发现值得改的点，说明检验标准太低——本轮产出"检验标准升级报告"，论证当前标准为何不够高并提出新标准，下轮按新标准重新检验。
6. 在工作文件夹中记录进度，不要更新全局记忆
7. 所有阶段都建议进行充分调研：web调研、查看记忆和相关SOP、获取用户倾向
8. 禁止进行sha1等无用验证，文件版本不会出错
`;

const BUDGET_LIMIT_PROMPT = `[Goal Mode — 预算耗尽，收口]

<objective>
{objective}
</objective>

⏱ 预算已耗尽（{budget_min:.0f} 分钟）。这是最后一轮。

请执行收口：
1. 总结本次 goal 的所有进展（列表）
2. 列出未完成的事项和建议的 next step
3. 确保工作文件夹中记录了关键成果
4. 清理一些确定无用的中间临时文件和不再用的进程
{done_prompt}
`;

export function init(args: { goal_state?: string }): void {
  // projectRoot is supplied at check time; init is optional and kept for API parity.
  stateFile = args.goal_state || '';
}

export function check(projectRoot: string): string {
  if (!stateFile) stateFile = resolveStateFile(projectRoot);
  const state = loadState();
  if (state === null) return '/exit';

  const status = state.status as string | undefined;
  if (status !== 'running') return '/exit';

  const startTime = (state.start_time as number) || Date.now() / 1000;
  const budgetSec = (state.budget_seconds as number) || 1800;
  const elapsed = Date.now() / 1000 - startTime;
  const remaining = budgetSec - elapsed;
  const turnsUsed = (state.turns_used as number) || 0;
  const turn = turnsUsed + 1;
  const maxTurns = (state.max_turns as number) || 50;

  if (remaining <= 0 || turn > maxTurns) {
    state.status = 'wrapping_up';
    saveState(state);
    return BUDGET_LIMIT_PROMPT
      .replace('{objective}', String(state.objective || ''))
      .replace('{budget_min}', (budgetSec / 60).toFixed(1))
      .replace('{done_prompt}', String(state.done_prompt || ''));
  }

  state.turns_used = turn;
  saveState(state);
  return CONTINUATION_PROMPT
    .replace('{objective}', String(state.objective || ''))
    .replace('{elapsed_min}', (elapsed / 60).toFixed(1))
    .replace('{remaining_min}', (remaining / 60).toFixed(1))
    .replace('{turn}', String(turn));
}

export function on_done(_result: string): void {
  const state = loadState();
  if (state === null) return;
  if (state.status === 'wrapping_up') {
    state.status = 'done_budget';
    state.end_time = Date.now() / 1000;
    saveState(state);
  }
}
