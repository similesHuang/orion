import { TMWebDriver, type TabInfo } from './tmwebdriver.js';

export interface WebScanResult {
  status: string;
  tabs: TabInfo[];
  current_tab: string;
  url: string;
  title: string;
  content: string;
  truncated?: boolean;
}

export interface WebExecuteResult {
  status: string;
  js_return: unknown;
  tab_id: string;
  saved_to?: string;
  error?: string;
  reloaded?: boolean;
  newTabs?: TabInfo[];
  transients?: string[];
  diff?: string;
  suggestion?: string;
}

export interface WebNavigateResult {
  status: string;
  url: string;
  title: string;
  tab_id: string;
  error?: string;
}

const driver = new TMWebDriver('127.0.0.1', 18765);
let started = false;

async function ensureStarted(): Promise<void> {
  if (started) return;
  await driver.start();
  started = true;
}

function toTabId(switch_tab_id?: string): string | undefined {
  if (!switch_tab_id) return undefined;
  return switch_tab_id.startsWith('tab_') ? switch_tab_id : `tab_${switch_tab_id}`;
}

export async function webScan(
  options: {
    tabs_only?: boolean;
    switch_tab_id?: string;
    text_only?: boolean;
    max_chars?: number;
    cutlist?: boolean;
  } = {}
): Promise<WebScanResult> {
  try {
    await ensureStarted();
    const sessionId = toTabId(options.switch_tab_id);
    const tabs = await driver.getTabs();
    const target = sessionId ? tabs.find((t) => t.id === sessionId) : tabs.find((t) => t.active) || tabs[tabs.length - 1];
    const currentTabId = target?.id ?? '';
    if (options.tabs_only) {
      return {
        status: 'success',
        tabs,
        current_tab: currentTabId,
        url: target?.url ?? '',
        title: target?.title ?? '',
        content: '',
      };
    }
    const scan = await driver.scan(sessionId, !!options.text_only);
    return {
      status: 'success',
      tabs: scan.tabs,
      current_tab: scan.current_tab,
      url: scan.url,
      title: scan.title,
      content: scan.content,
    };
  } catch (e) {
    return {
      status: 'error',
      tabs: [],
      current_tab: '',
      url: '',
      title: '',
      content: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function webExecuteJs(
  options: {
    script?: string;
    save_to_file?: string;
    switch_tab_id?: string;
    no_monitor?: boolean;
  } = {}
): Promise<WebExecuteResult> {
  try {
    await ensureStarted();
    const sessionId = toTabId(options.switch_tab_id);
    const code = options.script || '';
    if (!code.trim()) {
      return { status: 'error', js_return: null, tab_id: sessionId || '', error: 'Empty script' };
    }
    const result = await driver.execute_js(code, 15, sessionId);
    let savedTo: string | undefined;
    if (options.save_to_file && result.data !== undefined) {
      const fs = await import('fs');
      const path = await import('path');
      const dir = path.dirname(options.save_to_file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(options.save_to_file, String(result.data), 'utf-8');
      savedTo = options.save_to_file;
    }
    return {
      status: 'success',
      js_return: result.data,
      tab_id: sessionId || driver.get_all_sessions().find((t) => t.active)?.id || '',
      saved_to: savedTo,
      newTabs: result.newTabs,
    };
  } catch (e) {
    return {
      status: 'error',
      js_return: null,
      tab_id: options.switch_tab_id || '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function webNavigate(
  options: {
    url: string;
    switch_tab_id?: string;
    new_tab?: boolean;
  }
): Promise<WebNavigateResult> {
  try {
    await ensureStarted();
    const sessionId = toTabId(options.switch_tab_id);
    let targetId = sessionId;
    if (options.new_tab) {
      const openRes = await driver.execute_js(`window.open(${JSON.stringify(options.url)}, '_blank')`, 15, sessionId);
      if (openRes.newTabs?.length) {
        targetId = openRes.newTabs[0].id;
      }
      const tabs = await driver.getTabs();
      const target = targetId ? tabs.find((t) => t.id === targetId) : tabs[tabs.length - 1];
      return {
        status: 'success',
        url: target?.url ?? options.url,
        title: target?.title ?? '',
        tab_id: target?.id ?? targetId ?? '',
      };
    }
    await driver.jump(options.url, 10);
    const tabs = await driver.getTabs();
    const target = targetId ? tabs.find((t) => t.id === targetId) : tabs.find((t) => t.active) || tabs[tabs.length - 1];
    return {
      status: 'success',
      url: target?.url ?? options.url,
      title: target?.title ?? '',
      tab_id: target?.id ?? '',
    };
  } catch (e) {
    return {
      status: 'error',
      url: '',
      title: '',
      tab_id: options.switch_tab_id || '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function closeBrowser(): Promise<void> {
  await driver.stop();
  started = false;
}
