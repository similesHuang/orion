// ---------------------------------------------------------------------------
// TabInfo
// ---------------------------------------------------------------------------

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Scan / Navigate / Execute options & results
// ---------------------------------------------------------------------------

export interface ScanOptions {
  tabs_only?: boolean;
  switch_tab_id?: string;
  text_only?: boolean;
  max_chars?: number;
}

export interface ScanResult {
  status: string;
  tabs: TabInfo[];
  current_tab: string;
  url: string;
  title: string;
  content: string;
  truncated?: boolean;
}

export interface NavigateOptions {
  switch_tab_id?: string;
  new_tab?: boolean;
}

export interface NavigateResult {
  status: string;
  url: string;
  title: string;
  tab_id: string;
  error?: string;
}

export interface ExecuteOptions {
  switch_tab_id?: string;
  save_to_file?: string;
  no_monitor?: boolean;
}

export interface ExecuteResult {
  status: string;
  js_return: unknown;
  tab_id: string;
  error?: string;
  saved_to?: string;
}

// ---------------------------------------------------------------------------
// WebAutomation
// ---------------------------------------------------------------------------

/**
 * Pluggable web browser automation interface.
 *
 * Implementations handle the actual browser connection (e.g. TMWebDriver
 * via Chrome extension WebSocket bridge). When no implementation is
 * provided, web tools return a "not available" message.
 */
export interface WebAutomation {
  scan(options?: ScanOptions): Promise<ScanResult>;
  navigate(url: string, options?: NavigateOptions): Promise<NavigateResult>;
  executeJs(script: string, options?: ExecuteOptions): Promise<ExecuteResult>;
  close(): Promise<void>;
}
