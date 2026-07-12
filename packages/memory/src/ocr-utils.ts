/** Local OCR wrapper (rapidocr via Python fallback). */
import fs from 'fs';
import path from 'path';
import { globalPath, runPythonCodeAsync } from '@orion/shared';

// Python fallback script is not currently bundled; path is kept consistent with global assets.
const PY_SCRIPT = globalPath('assets', 'python', 'ocr_utils.py');

export interface OcrDetail {
  bbox: number[][];
  text: string;
  conf: number;
}

export interface OcrOutput {
  text: string;
  lines: string[];
  details: OcrDetail[];
}

async function ocrViaPython(imagePath: string, enhance = false): Promise<OcrOutput> {
  if (!fs.existsSync(PY_SCRIPT)) {
    throw new Error(`Python ocr_utils.py not found at ${PY_SCRIPT}`);
  }
  const scriptDir = path.dirname(PY_SCRIPT);
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(scriptDir)})
from ocr_utils import ocr_image
result = ocr_image(${JSON.stringify(imagePath)}, enhance=${enhance})
print(json.dumps(result, ensure_ascii=False))
`;
  const r = await runPythonCodeAsync(code, { timeout: 60000 });
  if (r.status !== 0) throw new Error(`ocr_image failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.split('\n').reverse().find((l: string) => l.trim().startsWith('{')) || '{}') as OcrOutput;
}

export async function ocrImage(imageInput: string, _lang?: string, enhance = false, _engine?: string): Promise<OcrOutput> {
  if (typeof imageInput !== 'string') throw new Error('Only file-path input is supported in TS wrapper');
  return ocrViaPython(imageInput, enhance);
}

export async function ocrScreen(bbox?: [number, number, number, number], lang?: string, enhance = false, engine?: string): Promise<OcrOutput> {
  // Best-effort screenshot via Python ImageGrab
  const scriptDir = path.dirname(PY_SCRIPT);
  const code = `
import sys, json, tempfile
sys.path.insert(0, ${JSON.stringify(scriptDir)})
from ocr_utils import ocr_screen
bbox = ${bbox ? JSON.stringify(bbox) : 'None'}
result = ocr_screen(bbox, lang=${JSON.stringify(lang || 'zh-Hans-CN')}, enhance=${enhance}, engine=${engine ? JSON.stringify(engine) : 'None'})
print(json.dumps(result, ensure_ascii=False))
`;
  const r = await runPythonCodeAsync(code, { timeout: 60000 });
  if (r.status !== 0) throw new Error(`ocr_screen failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.split('\n').reverse().find((l: string) => l.trim().startsWith('{')) || '{}') as OcrOutput;
}

export async function ocrWindow(hwnd: number, lang?: string, enhance = false, engine?: string): Promise<OcrOutput> {
  const scriptDir = path.dirname(PY_SCRIPT);
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(scriptDir)})
from ocr_utils import ocr_window
result = ocr_window(${hwnd}, lang=${JSON.stringify(lang || 'zh-Hans-CN')}, enhance=${enhance}, engine=${engine ? JSON.stringify(engine) : 'None'})
print(json.dumps(result, ensure_ascii=False))
`;
  const r = await runPythonCodeAsync(code, { timeout: 60000 });
  if (r.status !== 0) throw new Error(`ocr_window failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.split('\n').reverse().find((l: string) => l.trim().startsWith('{')) || '{}') as OcrOutput;
}
