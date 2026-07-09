import path from 'path';
import fs from 'fs';
import { findProjectRoot, runPythonArgsAsync } from '@orion/shared';

const projectRoot = findProjectRoot(import.meta.url ? path.dirname(new URL(import.meta.url).pathname) : __dirname);
const BRIDGE = path.join(projectRoot, 'GenericAgent', 'memory', 'ljqctrl_bg_bridge.py');

function findGenericRoot(): string {
  const candidates = [
    path.resolve(projectRoot, '..', 'GenericAgent'),
    path.resolve(projectRoot, '..', '..', 'GenericAgent'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'memory', 'ljqCtrlBg.py'))) return dir;
  }
  return path.resolve(projectRoot, '..', 'GenericAgent');
}

async function runPy(args: string[]): Promise<unknown> {
  if (process.platform !== 'win32') {
    throw new Error('ljqCtrlBg background window control is only supported on Windows');
  }
  const genericRoot = findGenericRoot();
  const cmdArgs = ['--generic-root', genericRoot, ...args];
  const r = await runPythonArgsAsync([BRIDGE, ...cmdArgs], { timeout: 60000 });
  if (r.status !== 0) throw new Error(`ljqCtrlBg bridge failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout || '{}');
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  class: string;
  rect: [number, number, number, number];
  visible: boolean;
}

export interface CaptureResult {
  imageBase64: string;
  hwnd: number;
  backend: string;
  clientOrigin: [number, number];
  clientSize: [number, number];
}

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  coords?: 'client' | 'screen';
  targetChild?: boolean;
}

export async function listWindows(visibleOnly = true): Promise<WindowInfo[]> {
  return runPy(['list_windows', `--visible-only=${visibleOnly}`]) as Promise<WindowInfo[]>;
}

export async function findWindow(name: string, exact = false, className?: string, visibleOnly = true): Promise<number> {
  const args = ['find_window', name, `--exact=${exact}`, `--visible-only=${visibleOnly}`];
  if (className) args.push(`--class-name=${className}`);
  return runPy(args) as Promise<number>;
}

export async function clientSize(hwnd: number): Promise<[number, number]> {
  return runPy(['client_size', String(hwnd)]) as Promise<[number, number]>;
}

export async function clientOrigin(hwnd: number): Promise<[number, number]> {
  return runPy(['client_origin', String(hwnd)]) as Promise<[number, number]>;
}

export async function grabWindowBg(hwnd: number, backend: 'auto' | 'wgc' | 'printwindow' = 'auto', timeout = 3.0): Promise<CaptureResult> {
  return runPy(['grab_window', String(hwnd), `--backend=${backend}`, `--timeout=${timeout}`]) as Promise<CaptureResult>;
}

export async function clickBg(hwnd: number, x: number, y: number, options: ClickOptions = {}): Promise<boolean> {
  const { button = 'left', coords = 'client', targetChild = true } = options;
  return runPy([
    'click', String(hwnd), String(x), String(y),
    `--button=${button}`, `--coords=${coords}`, `--target-child=${targetChild}`,
  ]) as Promise<boolean>;
}

export async function pressBg(hwnd: number, key: string, modifiers?: string[]): Promise<boolean> {
  const args = ['press', String(hwnd), key];
  if (modifiers?.length) args.push('--modifiers', ...modifiers);
  return runPy(args) as Promise<boolean>;
}

export async function typeTextBg(hwnd: number, text: string): Promise<boolean> {
  return runPy(['type_text', String(hwnd), text]) as Promise<boolean>;
}

export async function setTextBg(hwnd: number, text: string): Promise<boolean> {
  return runPy(['set_text', String(hwnd), text]) as Promise<boolean>;
}

export async function getTextBg(hwnd: number): Promise<string> {
  return runPy(['get_text', String(hwnd)]) as Promise<string>;
}

// Legacy stubs for API compatibility
export const dpiScale = 1;
export function mouseDown(): void { throw new Error('mouseDown not implemented in TS port'); }
export function mouseUp(): void { throw new Error('mouseUp not implemented in TS port'); }
export function mouseClick(_stayTime = 0.05): void { throw new Error('mouseClick not implemented in TS port'); }
export function mouseDClick(_stayTime = 0.05): void { throw new Error('mouseDClick not implemented in TS port'); }
export function setCursorPos(_z: [number, number]): void { throw new Error('setCursorPos not implemented in TS port'); }
export function click(x: number | [number, number], y?: number): void {
  if (Array.isArray(x)) {
    click(x[0], x[1]);
    return;
  }
  if (y === undefined) throw new Error('click requires x and y');
  setCursorPos([x, y]);
  mouseClick();
}
export const clickAlias = click;
export function press(_cmd: string | string[], _stayTime = 0): void { throw new Error('press not implemented in TS port'); }
export const pressAlias = press;
export function grabWindow(_hwnd: number): never { throw new Error('grabWindow not implemented in TS port'); }
export function imshow(_mt: unknown, _sec = 0): void { throw new Error('imshow not implemented in TS port'); }
export function getWRect(_sr: string): number[] { throw new Error('getWRect not implemented in TS port'); }
export function findBlock(
  _fn: string | unknown,
  _wrect?: string | number[] | unknown,
  _verbose = 0,
  _threshold = 0.8
): [{ x: number; y: number }, boolean] { throw new Error('findBlock not implemented in TS port'); }
