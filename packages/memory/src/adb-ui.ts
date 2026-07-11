/** Android UI dump + interaction wrapper (adb / uiautomator2 via Python fallback). */
import { spawnSync } from 'child_process';
import path from 'path';
import { globalPath, runPythonCodeAsync } from '@orion/shared';

// Python fallback script is not currently bundled; path is kept consistent with global assets.
const PY_SCRIPT = globalPath('assets', 'python', 'adb_ui.py');

export interface UiNode {
  text: string;
  click: boolean;
  edit: boolean;
  cx: number;
  cy: number;
  cls: string;
  rid: string;
}

function adbPath(): string {
  const r = spawnSync('command', ['-v', 'adb'], { encoding: 'utf-8', shell: true });
  return r.status === 0 ? (r.stdout.trim() || 'adb') : 'adb';
}

export async function ui(keyword?: string, clickableOnly = false, raw = false): Promise<UiNode[]> {
  if (!PY_SCRIPT) throw new Error('adb_ui.py path not set');
  const scriptDir = path.dirname(PY_SCRIPT);
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(scriptDir)})
from adb_ui import ui
nodes = ui(keyword=${JSON.stringify(keyword ?? null)}, clickable_only=${clickableOnly}, raw=True)
print(json.dumps(nodes, ensure_ascii=False))
`;
  const r = await runPythonCodeAsync(code, { timeout: 60000 });
  if (r.status !== 0) throw new Error(`adb_ui.ui failed: ${r.stderr || r.stdout}`);
  const line = r.stdout.split('\n').reverse().find((l: string) => l.trim().startsWith('['));
  const nodes = line ? (JSON.parse(line) as UiNode[]) : [];
  if (!raw) {
    for (const n of nodes) {
      const flag = n.edit ? 'E' : n.click ? 'Y' : ' ';
      const coord = n.cx ? `(${n.cx},${n.cy})` : '';
      const display = n.text || `<${n.rid.split('/').pop() || n.cls || 'icon'}>`;
      console.log(`[${flag}] ${display}  ${coord}`);
    }
    console.log(`\ntotal: ${nodes.length} nodes`);
  }
  return nodes;
}

export async function tap(x: number, y: number): Promise<void> {
  const adb = adbPath();
  const r = spawnSync(adb, ['shell', 'input', 'tap', String(x), String(y)], { encoding: 'utf-8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`adb tap failed: ${r.stderr || r.stdout}`);
  console.log(`tap(${x},${y}) ok`);
}
