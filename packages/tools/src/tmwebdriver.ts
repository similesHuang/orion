import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket as WS } from 'ws';

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active?: boolean;
}

interface InternalTab extends TabInfo {
  active?: boolean;
}

interface BridgeRequest {
  id: string;
  code: string | Record<string, unknown>;
  tabId?: number;
}

interface BridgeMessage {
  type: 'ext_ready' | 'tabs_update' | 'result' | 'error' | 'ping';
  id?: string;
  result?: unknown;
  error?: unknown;
  tabs?: Array<{ id: number; url: string; title: string; active?: boolean }>;
  newTabs?: Array<{ id: number; url: string; title: string }>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class TMWebDriver {
  host: string;
  port: number;
  private server?: WebSocketServer;
  private socket?: WS;
  private pending = new Map<string, PendingRequest>();
  private _tabs: InternalTab[] = [];
  private ready = false;
  private waiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  private events = new EventEmitter();

  constructor(host = '127.0.0.1', port = 18765) {
    this.host = host;
    this.port = port;
  }

  async start(): Promise<void> {
    if (this.server) return;
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ host: this.host, port: this.port });
      this.server = server;
      server.on('error', (err) => {
        this.server = undefined;
        reject(err);
      });
      server.on('listening', () => {
        server.off('error', reject);
        resolve();
      });
      server.on('connection', (ws) => this.onConnection(ws));
    });
  }

  async stop(): Promise<void> {
    this.rejectAll(new Error('WebDriver stopped'));
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = undefined;
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = undefined;
          resolve();
        });
      });
    }
  }

  get_all_sessions(): TabInfo[] {
    return this._tabs.map(({ id, url, title }) => ({ id, url, title }));
  }

  get_session_dict(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of this._tabs) out[t.id] = t.url;
    return out;
  }

  find_session(url_pattern: string): Array<[string, TabInfo]> {
    if (url_pattern === '') {
      const active = this._tabs.find((t) => t.active);
      const latest = active || this._tabs[this._tabs.length - 1];
      return latest ? [[latest.id, latest]] : [];
    }
    const out: Array<[string, TabInfo]> = [];
    for (const t of this._tabs) {
      if (t.url.includes(url_pattern)) out.push([t.id, t]);
    }
    return out;
  }

  set_session(url_pattern: string): string | false {
    const matched = this.find_session(url_pattern);
    if (!matched.length) {
      console.log(`警告: 未找到URL包含 '${url_pattern}' 的会话`);
      return false;
    }
    if (matched.length > 1) {
      console.log(`警告: 找到多个URL包含 '${url_pattern}' 的会话，选择第一个`);
    }
    const [sid] = matched[0];
    console.log(`成功设置默认会话: ${sid}: ${matched[0][1].url}`);
    return sid;
  }

  private parseId(sid: string | number | undefined): number | undefined {
    if (sid === undefined) return undefined;
    const n = typeof sid === 'number' ? sid : parseInt(String(sid).replace(/^tab_/, ''), 10);
    return isNaN(n) ? undefined : n;
  }

  private async waitForTabs(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._tabs.length > 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this._tabs.length > 0) return;
    throw new Error('No browser tabs available');
  }

  private async getTargetTabId(session_id?: string | number): Promise<number | undefined> {
    if (session_id !== undefined) return this.parseId(session_id);
    await this.waitForTabs(5000);
    const active = this._tabs.find((t) => t.active);
    return active ? this.parseId(active.id) : (this._tabs[0] ? this.parseId(this._tabs[0].id) : undefined);
  }

  async execute_js(code: string, _timeout = 15, session_id?: string | number): Promise<{ data: unknown; newTabs?: TabInfo[] }> {
    await this.start();
    const tabId = await this.getTargetTabId(session_id);
    const res = (await this.send({ id: randomUUID(), code, tabId })) as { ok?: boolean; data?: unknown; error?: unknown; newTabs?: Array<{ id: number; url: string; title: string }> };
    if (!res || res.ok === false) {
      throw new Error(typeof res?.error === 'string' ? res.error : JSON.stringify(res?.error ?? 'execute_js failed'));
    }
    const rr: { data: unknown; newTabs?: TabInfo[] } = { data: res.data };
    if (res.newTabs?.length) {
      rr.newTabs = res.newTabs.map((t) => ({ id: `tab_${t.id}`, url: t.url, title: t.title }));
    }
    return rr;
  }

  async jump(url: string, timeout = 10): Promise<void> {
    await this.start();
    const tabId = await this.getTargetTabId();
    const res = await this.send({
      id: randomUUID(),
      code: { cmd: 'cdp', method: 'Page.navigate', params: { url } },
      tabId,
    }, timeout * 1000);
    if (res && (res as { ok?: boolean }).ok === false) {
      throw new Error(JSON.stringify((res as { error?: unknown }).error ?? 'navigation failed'));
    }
  }

  async getTabs(): Promise<TabInfo[]> {
    await this.start();
    const res = (await this.send({ id: randomUUID(), code: { cmd: 'tabs' } })) as { ok?: boolean; data?: Array<{ id: number; url: string; title: string }> };
    if (res?.ok && Array.isArray(res.data)) {
      this.updateTabs(res.data.map((t) => ({ ...t, active: false })));
    }
    return this.get_all_sessions();
  }

  async scan(session_id?: string | number, text_only = false): Promise<{ url: string; title: string; content: string; tabs: TabInfo[]; current_tab: string }> {
    await this.start();
    const tabId = await this.getTargetTabId(session_id);
    if (!tabId) throw new Error('No browser tab available');
    const extractScript = buildExtractScript(text_only);
    const res = (await this.send({ id: randomUUID(), code: extractScript, tabId })) as { ok?: boolean; data?: string; error?: unknown };
    if (!res || res.ok === false) {
      throw new Error(typeof res?.error === 'string' ? res.error : JSON.stringify(res?.error ?? 'scan failed'));
    }
    const target = this._tabs.find((t) => t.id === String(tabId)) || this._tabs[0];
    const content = String(res.data ?? '');
    return {
      url: target?.url ?? '',
      title: target?.title ?? '',
      content,
      tabs: this.get_all_sessions(),
      current_tab: target ? target.id : '',
    };
  }

  private async send(req: BridgeRequest, timeoutMs = 30000): Promise<unknown> {
    await this.ensureReady(timeoutMs);
    const socket = this.socket;
    if (!socket || socket.readyState !== WS.OPEN) throw new Error('Extension not connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        reject(new Error(`Request ${req.id} timed out`));
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify(req));
      } catch (e) {
        this.pending.delete(req.id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  private onConnection(ws: WS) {
    if (this.socket && this.socket !== ws) {
      try { this.socket.close(); } catch {}
    }
    this.socket = ws;
    this.ready = false;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = undefined;
        this.ready = false;
      }
    });
    ws.on('error', (err) => {
      console.error('[TMWebDriver] WS error:', err.message);
    });
  }

  private onMessage(data: WS.Data) {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf-8');
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf-8');
    else text = Buffer.concat(data).toString('utf-8');

    let msg: BridgeMessage;
    try {
      msg = JSON.parse(text) as BridgeMessage;
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      if (this.socket?.readyState === WS.OPEN) {
        try { this.socket.send(JSON.stringify({ type: 'pong' })); } catch {}
      }
      return;
    }

    if (msg.type === 'ext_ready' || msg.type === 'tabs_update') {
      if (msg.tabs) this.updateTabs(msg.tabs);
      if (msg.type === 'ext_ready') {
        this.ready = true;
        this.drainWaiters();
      }
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.type === 'error') {
        p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error ?? 'unknown error')));
      } else {
        p.resolve(msg.result ?? { ok: true });
      }
    }
  }

  private updateTabs(raw: Array<{ id: number; url: string; title: string; active?: boolean }>) {
    this._tabs = raw.map((t) => ({ id: `tab_${t.id}`, url: t.url ?? '', title: t.title ?? '', active: !!t.active }));
  }

  private async ensureReady(timeoutMs: number): Promise<void> {
    await this.start();
    if (this.ready && this.socket?.readyState === WS.OPEN) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(resolve);
        reject(new Error('Extension did not connect to CDP bridge'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private removeWaiter(resolve: () => void) {
    this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
  }

  private drainWaiters() {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.waiters = [];
  }

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
  }
}

function buildExtractScript(text_only: boolean): string {
  return `(function(){
    if (${text_only ? 'true' : 'false'}) {
      return (document.body ? document.body.innerText : document.documentElement.innerText) || '';
    }
    const root = document.documentElement;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,link[rel="stylesheet"],meta,iframe').forEach(e => e.remove());
    function removeHidden(el) {
      for (const c of [...el.children]) {
        const s = window.getComputedStyle(c);
        if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
          c.remove();
        } else {
          removeHidden(c);
        }
      }
    }
    removeHidden(clone);
    return clone.outerHTML;
  })()`;
}
