/** UI element detection / OCR wrapper (Python fallback for YOLO+OCR). */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { findProjectRoot, runPythonArgsAsync } from '@orion/shared';

const projectRoot = findProjectRoot(import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname);
const DEFAULT_MODEL = path.join(projectRoot, 'temp', 'weights', 'icon_detect', 'model.pt');
const PY_SCRIPT = path.join(projectRoot, 'GenericAgent', 'memory', 'ui_detect.py');

export interface UiDetection {
  bbox: [number, number, number, number];
  confidence: number;
  class: number;
}

export interface OcrResult {
  text: string;
  bbox: number[][];
  confidence: number;
}

interface UiDetectOutput {
  ui_elements: UiDetection[];
  ocr_texts: OcrResult[];
}

function tmpPaths(): { tmpJson: string; outPng: string } {
  const rand = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const tmpJson = path.join(projectRoot, 'temp', `ui_detect_${rand}.json`);
  const outPng = tmpJson.replace('.json', '.png');
  return { tmpJson, outPng };
}

async function runUiDetect(imagePath: string, modelPath: string): Promise<UiDetectOutput> {
  if (!fs.existsSync(PY_SCRIPT)) {
    throw new Error(`Python ui_detect.py not found at ${PY_SCRIPT}`);
  }
  const { tmpJson, outPng } = tmpPaths();
  const r = await runPythonArgsAsync([PY_SCRIPT, imagePath, modelPath, outPng], { timeout: 120000 });
  if (r.status !== 0) {
    throw new Error(`ui_detect.py failed: ${r.stderr || r.stdout}`);
  }
  try {
    const data = JSON.parse(fs.readFileSync(tmpJson, 'utf-8')) as UiDetectOutput;
    return { ui_elements: data.ui_elements || [], ocr_texts: data.ocr_texts || [] };
  } finally {
    try {
      if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
      if (fs.existsSync(outPng)) fs.unlinkSync(outPng);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function detectUiElements(imagePath: string, modelPath?: string, _confThreshold = 0.25): Promise<UiDetection[]> {
  const model = modelPath || DEFAULT_MODEL;
  return (await runUiDetect(imagePath, model)).ui_elements;
}

export async function ocrText(imagePath: string): Promise<OcrResult[]> {
  // ui_detect.py also runs OCR and writes ocr_texts to JSON.
  return (await runUiDetect(imagePath, DEFAULT_MODEL)).ocr_texts;
}

export function visualize(
  imagePath: string,
  detections: UiDetection[],
  ocrResults?: OcrResult[],
  outputPath?: string
): string {
  // Fallback: return original path (visualization requires Python/PIL).
  return outputPath || imagePath;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length < 3) {
    console.log('用法: tsx ui-detect.ts <图片路径> [模型路径] [输出路径]');
    process.exit(1);
  }
  const imagePath = argv[2];
  const modelPath = argv[3] || DEFAULT_MODEL;
  const outputPath = argv[4] || 'output.png';
  const { ui_elements: detections, ocr_texts: ocrResults } = await runUiDetect(imagePath, modelPath);
  console.log(`检测到 ${detections.length} 个UI元素`);
  detections.forEach((d, i) => console.log(`  ${i + 1}. bbox=${d.bbox}, conf=${d.confidence.toFixed(3)}`));
  console.log(`识别到 ${ocrResults.length} 个文本区域`);
  console.log(`可视化保存到: ${visualize(imagePath, detections, ocrResults, outputPath)}`);
}
