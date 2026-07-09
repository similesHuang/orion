#!/usr/bin/env node
/** Desktop Pet — cross-platform GUI port using Playwright/Chromium.
 *  Equivalent to desktop_pet.pyw / desktop_pet_v2.pyw (skin system + HTTP toast).
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import { chromium, Browser, Page } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(__filename);
const skinsDir = path.join(scriptDir, 'skins');
const PORT = Number(process.env.PET_PORT || 41983);

interface SkinConfig {
  size?: { width?: number; height?: number };
  animations: Record<string, {
    file: string;
    sprite: {
      frameWidth: number;
      frameHeight: number;
      frameCount: number;
      columns: number;
      startFrame?: number;
      fps?: number;
    };
  }>;
}

function listSkins(): string[] {
  if (!fs.existsSync(skinsDir)) return [];
  return fs.readdirSync(skinsDir).filter((name) => {
    const p = path.join(skinsDir, name);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'skin.json'));
  });
}

function loadSkinConfig(name: string): { name: string; config: SkinConfig; dir: string } | null {
  const dir = path.join(skinsDir, name);
  const cfgPath = path.join(dir, 'skin.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    return { name, config: JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as SkinConfig, dir };
  } catch {
    return null;
  }
}

function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

function safeSkinName(name?: string): string {
  const skins = listSkins();
  if (name && skins.includes(name)) return name;
  return skins[0] || '';
}

const PET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Desktop Pet</title>
  <style>
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; overflow:hidden; background:#fff; user-select:none; }
    #wrap { position:relative; width:100%; height:100%; }
    canvas { display:block; width:100%; height:100%; }
    #toast {
      position:absolute; top:8px; left:8px; right:8px;
      background:rgba(255,253,231,.96); color:#333; border:1px solid #888;
      border-radius:10px; padding:8px 10px; font:13px/1.4 system-ui,sans-serif;
      box-shadow:0 2px 8px rgba(0,0,0,.15); display:none; word-break:break-word;
    }
    #controls {
      position:absolute; bottom:4px; right:4px; display:flex; gap:4px; opacity:.25;
    }
    #controls:hover { opacity:1; }
    button { font-size:11px; padding:2px 6px; cursor:pointer; }
  </style>
</head>
<body>
  <div id="wrap">
    <div id="toast"></div>
    <canvas id="pet"></canvas>
    <div id="controls">
      <button id="prev">◀</button>
      <button id="next">▶</button>
      <button id="quit">✕</button>
    </div>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    const skinName = params.get('skin') || 'vita';
    const canvas = document.getElementById('pet');
    const ctx = canvas.getContext('2d');
    const toast = document.getElementById('toast');
    let config = null, img = null, animName = 'idle', frameIdx = 0;
    let timer = null, toastTimer = null;

    async function loadSkin(name) {
      const r = await fetch('/skin/' + encodeURIComponent(name) + '/skin.json');
      config = await r.json();
      const size = config.size || { width: 128, height: 128 };
      canvas.width = size.width; canvas.height = size.height;
      document.body.style.width = size.width + 'px';
      document.body.style.height = size.height + 'px';
      img = new Image();
      img.src = '/skin/' + encodeURIComponent(name) + '/' + encodeURIComponent(config.animations[animName].file);
      await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; });
      frameIdx = 0; startAnim();
    }

    function draw() {
      if (!config || !img) return;
      const anim = config.animations[animName];
      const sp = anim.sprite;
      const idx = (sp.startFrame || 0) + (frameIdx % sp.frameCount);
      const col = idx % sp.columns;
      const row = Math.floor(idx / sp.columns);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, col * sp.frameWidth, row * sp.frameHeight, sp.frameWidth, sp.frameHeight, 0, 0, canvas.width, canvas.height);
    }

    function startAnim() {
      if (timer) clearInterval(timer);
      const fps = (config.animations[animName].sprite.fps || 6);
      timer = setInterval(() => { frameIdx++; draw(); }, 1000 / fps);
      draw();
    }

    function setState(state) {
      if (!config || !config.animations[state]) return;
      animName = state; frameIdx = 0;
      const anim = config.animations[state];
      img.src = '/skin/' + encodeURIComponent(skinName) + '/' + encodeURIComponent(anim.file);
      startAnim();
    }

    function showToast(msg) {
      toast.textContent = msg;
      toast.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
    }

    window.pet = { setState, showToast };
    document.getElementById('prev').onclick = () => {
      const states = Object.keys(config.animations);
      const i = states.indexOf(animName);
      setState(states[(i - 1 + states.length) % states.length]);
    };
    document.getElementById('next').onclick = () => {
      const states = Object.keys(config.animations);
      const i = states.indexOf(animName);
      setState(states[(i + 1) % states.length]);
    };
    document.getElementById('quit').onclick = () => fetch('/api/quit', {method:'POST'});
    loadSkin(skinName).catch(e => console.error(e));
  </script>
</body>
</html>`;

class DesktopPet {
  private browser?: Browser;
  private page?: Page;
  private server?: http.Server;

  async start(): Promise<void> {
    const lock = await this.acquireSingleton();
    if (!lock) {
      console.log(`[DesktopPet] another instance is already running on port ${PORT}`);
      process.exit(0);
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve) => this.server!.listen(PORT, '127.0.0.1', resolve));
    console.log(`[DesktopPet] control server at http://127.0.0.1:${PORT}`);

    const skin = safeSkinName(process.env.PET_SKIN);
    const cfg = skin ? loadSkinConfig(skin) : null;
    const size = cfg?.config.size || { width: 128, height: 128 };
    const url = `http://127.0.0.1:${PORT}/pet.html?skin=${encodeURIComponent(skin)}`;

    this.browser = await chromium.launch({
      headless: false,
      args: [
        `--app=${url}`,
        `--window-size=${size.width},${size.height}`,
        '--window-position=1200,600',
        '--disable-infobars',
      ],
    });
    // Attach to the page created by --app; fallback to a new page.
    let pages = this.browser.contexts().flatMap((c) => c.pages());
    if (!pages.length) {
      await new Promise((r) => setTimeout(r, 300));
      pages = this.browser.contexts().flatMap((c) => c.pages());
    }
    this.page = pages[0] || (await this.browser.newPage());
    if (!pages.length) await this.page.goto(url);
    console.log(`[DesktopPet] window opened with skin: ${skin}`);

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private acquireSingleton(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.createConnection(PORT, '127.0.0.1');
      s.on('connect', () => {
        s.destroy();
        resolve(false);
      });
      s.on('error', () => resolve(true));
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/pet.html' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PET_HTML);
        return;
      }
      if (url.pathname === '/skins' && req.method === 'GET') {
        sendJson(res, 200, listSkins());
        return;
      }
      const skinMatch = url.pathname.match(/^\/skin\/([^/]+)\/skin\.json$/);
      if (skinMatch) {
        const cfg = loadSkinConfig(decodeURIComponent(skinMatch[1]));
        if (!cfg) { sendText(res, 404, 'skin not found'); return; }
        sendJson(res, 200, cfg.config);
        return;
      }
      const fileMatch = url.pathname.match(/^\/skin\/([^/]+)\/(.+)$/);
      if (fileMatch) {
        const cfg = loadSkinConfig(decodeURIComponent(fileMatch[1]));
        if (!cfg) { sendText(res, 404, 'skin not found'); return; }
        const resolvedDir = path.resolve(cfg.dir);
        const filePath = path.resolve(resolvedDir, decodeURIComponent(fileMatch[2]));
        if (filePath !== resolvedDir && !filePath.startsWith(resolvedDir + path.sep)) {
          sendText(res, 403, 'forbidden');
          return;
        }
        sendFile(res, filePath);
        return;
      }
      if (url.pathname === '/api/toast' && req.method === 'GET') {
        const msg = url.searchParams.get('msg') || '';
        if (msg) {
          await this.page?.evaluate((m) => (globalThis as unknown as { pet?: { showToast(s: string): void } }).pet?.showToast(m), msg);
          sendText(res, 200, 'ok');
        } else {
          sendText(res, 400, '?msg=xxx');
        }
        return;
      }
      if (url.pathname === '/api/toast' && req.method === 'POST') {
        const body = await readText(req);
        if (body) {
          await this.page?.evaluate((m) => (globalThis as unknown as { pet?: { showToast(s: string): void } }).pet?.showToast(m), body);
          sendText(res, 200, 'ok');
        } else {
          sendText(res, 400, 'empty body');
        }
        return;
      }
      if (url.pathname === '/api/state') {
        const state = url.searchParams.get('state') || '';
        if (state) {
          await this.page?.evaluate((s) => (globalThis as unknown as { pet?: { setState(s: string): void } }).pet?.setState(s), state);
          sendText(res, 200, 'ok');
        } else {
          sendText(res, 400, '?state=idle/walk/...');
        }
        return;
      }
      if (url.pathname === '/api/quit' && req.method === 'POST') {
        sendText(res, 200, 'ok');
        this.shutdown();
        return;
      }
      sendText(res, 404, 'Not Found');
    } catch (e) {
      sendText(res, 500, e instanceof Error ? e.message : String(e));
    }
  }

  private async shutdown(): Promise<void> {
    const serverClose = new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve())
      } else {
        resolve()
      }
    })
    await serverClose
    if (this.browser) {
      try {
        await this.browser.close()
      } catch (e) {
        console.error('[DesktopPet] browser close error:', e instanceof Error ? e.message : String(e))
      }
    }
    process.exit(0)
  }
}

function readText(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'not found');
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      sendText(res, 403, 'forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': guessMime(filePath), 'Content-Length': stat.size });
    fs.createReadStream(filePath).on('error', (e) => {
      console.error('[DesktopPet] sendFile error:', e.message);
      if (!res.writableEnded) res.end();
    }).pipe(res);
  } catch (e) {
    sendText(res, 500, e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  const pet = new DesktopPet();
  await pet.start();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

