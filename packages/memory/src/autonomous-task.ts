import fs from 'fs';
import path from 'path';

const moduleDir = path.dirname(import.meta.url ? fileURLToPath(import.meta.url) : __filename);
const tempDir = path.resolve(moduleDir, '..', '..', '..', 'temp');
const reportsDir = path.join(tempDir, 'autonomous_reports');
const historyFile = path.join(reportsDir, 'history.txt');
const todoFile = path.join(tempDir, 'TODO.txt');

import { fileURLToPath } from 'url';

function nextReportNumber(): number {
  if (!fs.existsSync(historyFile)) return 1;
  const content = fs.readFileSync(historyFile, 'utf-8');
  const nums = [...content.matchAll(/R(\d+)/g)].map((m) => parseInt(m[1], 10));
  if (!nums.length) return 1;
  return Math.max(...nums) + 1;
}

export function getTodo(): string {
  if (!fs.existsSync(todoFile)) return `[autonomous_task] TODO.txt 不存在，路径: ${todoFile}`;
  return fs.readFileSync(todoFile, 'utf-8');
}

export function getHistory(n = 20): string {
  if (!fs.existsSync(historyFile)) return `[autonomous_task] history.txt 不存在，路径: ${historyFile}`;
  const lines = fs.readFileSync(historyFile, 'utf-8').split('\n');
  return lines.slice(-n).join('\n');
}

export function setTodoPath(): string {
  return `路径: ${todoFile}`;
}

export function completeTask(taskname: string, historyline: string, reportPath: string): string {
  if (historyline.trim().includes('\n')) {
    return '[ERROR] historyline 必须是单行，不能包含换行符';
  }

  const report = path.resolve(reportPath);
  if (!fs.existsSync(report)) return `[ERROR] 报告文件不存在: ${reportPath}`;

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const rnum = nextReportNumber();
  const safeName = taskname.replace(/[<>:"/\\|?*]/g, '_').trim();
  const destName = `R${rnum}_${safeName}.md`;
  const destPath = path.join(reportsDir, destName);

  try {
    fs.renameSync(report, destPath);
  } catch (e) {
    return `[ERROR] 移动报告失败: ${e instanceof Error ? e.message : String(e)}`;
  }

  let line = historyline.trim();
  line = line.replace(/^R\d+\s*\|\s*/, '');
  line = line.replace(/^\d{4}-\d{2}-\d{2}\s*\|\s*/, '');
  const today = new Date().toISOString().slice(0, 10);
  line = `R${rnum} | ${today} | ${line}`;

  try {
    const existing = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf-8') : '';
    fs.writeFileSync(historyFile, `${line}\n${existing}`, 'utf-8');
  } catch (e) {
    try {
      fs.renameSync(destPath, report);
    } catch {}
    return `[ERROR] 写入 history 失败: ${e instanceof Error ? e.message : String(e)}（报告已回滚）`;
  }

  return (
    `✅ 完成！报告已保存: ${destName}\n` +
    `历史已记录: ${line}\n` +
    `👉 请在 ${todoFile} 中将对应任务标记为 [x] R${rnum}，然后结束，**其他TODO下次再干**`
  );
}

export default {
  getTodo,
  getHistory,
  setTodoPath,
  completeTask,
};
