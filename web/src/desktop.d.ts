export interface DesktopPaths {
  userData: string;
  stateDir: string;
  configPath: string;
  logsDir: string;
  runtimeLog: string;
  logsHint?: string;
}

export interface RuntimeDiedInfo {
  code: number | null;
  signal: string | null;
  runtimeLog?: string;
  logsDir?: string;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  isLoading?: boolean;
  active?: boolean;
}

export interface BrowserNavState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  visible?: boolean;
  tabId?: string | null;
  isLoading?: boolean;
  zoomFactor?: number;
  secure?: boolean;
  certError?: boolean;
  tabs?: BrowserTabInfo[];
  activeTabId?: string | null;
}

export interface BrowserAskSelection {
  text: string;
  url?: string;
  title?: string;
}

export interface BrowserFailLoad {
  tabId?: string;
  url: string;
  errorCode: number;
  errorDescription: string;
}

export interface BrowserDownloadEvent {
  id: string;
  filename: string;
  state: string;
  received: number;
  total: number;
  savePath?: string;
}

export interface BrowserSiteInfo {
  ok: boolean;
  tabId?: string | null;
  url?: string;
  origin?: string;
  title?: string;
  secure?: boolean;
  certError?: boolean;
  permissions?: { permission: string; allow: boolean }[];
}

export interface DesktopBrowserApi {
  show: (bounds?: BrowserBounds | null) => Promise<{ ok: boolean; error?: string; activeTabId?: string | null }>;
  hide: () => Promise<{ ok: boolean }>;
  /** Reclaim keyboard focus from BrowserView after hide / before typing in the shell composer. */
  restoreShellFocus: () => Promise<{ ok: boolean; error?: string }>;
  setBounds: (bounds: BrowserBounds) => Promise<{ ok: boolean; error?: string }>;
  /** Floating history FAB over the page (does not reserve a panel strip). */
  setHistoryFabVisible?: (visible: boolean) => Promise<{ ok: boolean; visible?: boolean }>;
  /** Each chat owns its own browser tab set. */
  setWorkspace?: (
    chatId: string
  ) => Promise<{ ok: boolean; chatId?: string; reused?: boolean; tabCount?: number; error?: string }>;
  /** Drop parked BrowserView workspace snapshot when a chat is deleted. */
  forgetWorkspace?: (chatId: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenHistoryOverlay?: (handler: () => void) => () => void;
  navigate: (
    url: string,
    opts?: { allowSearchFallback?: boolean }
  ) => Promise<{ ok: boolean; url?: string; error?: string; tabId?: string | null }>;
  goBack: () => Promise<{ ok: boolean }>;
  goForward: () => Promise<{ ok: boolean }>;
  reload: (ignoreCache?: boolean) => Promise<{ ok: boolean }>;
  stop: () => Promise<{ ok: boolean }>;
  /** Page snapshot for frosted-glass answer overlay. */
  capture: () => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  /** Atomic show→capture→hide (preferred for overlay). */
  captureForOverlay?: (
    bounds?: BrowserBounds | null
  ) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  getState: () => Promise<BrowserNavState>;
  createTab: (url?: string) => Promise<{ ok: boolean; tabId?: string; url?: string; error?: string }>;
  switchTab: (tabId: string) => Promise<{ ok: boolean; tabId?: string; error?: string }>;
  closeTab: (tabId: string) => Promise<{ ok: boolean; error?: string }>;
  setZoom: (factor: number) => Promise<{ ok: boolean; zoomFactor?: number }>;
  adjustZoom: (delta: number) => Promise<{ ok: boolean; zoomFactor?: number }>;
  findInPage: (
    text: string,
    opts?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
  ) => Promise<{ ok: boolean; requestId?: number; cleared?: boolean }>;
  stopFindInPage: () => Promise<{ ok: boolean }>;
  print: () => Promise<{ ok: boolean }>;
  getSiteInfo: () => Promise<BrowserSiteInfo>;
  clearSiteData: (origin: string) => Promise<{ ok: boolean; error?: string }>;
  proceedInsecure: (url?: string) => Promise<{ ok: boolean; url?: string }>;
  showItemInFolder: (filePath: string) => Promise<{ ok: boolean }>;
  /** Save link as… (Chromium download UI). */
  downloadUrl: (url: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
  /** Rendered plain text from the active tab (JS already executed). */
  getPageText?: () => Promise<{
    ok: boolean;
    url?: string;
    title?: string;
    text?: string;
    truncated?: boolean;
    totalChars?: number;
    error?: string;
  }>;
  /** Headless load: hidden window, does not switch to W / show SERP. */
  loadPageText?: (
    url: string,
    opts?: { timeoutMs?: number }
  ) => Promise<{
    ok: boolean;
    url?: string;
    title?: string;
    text?: string;
    truncated?: boolean;
    totalChars?: number;
    error?: string;
  }>;
  onNavChanged: (handler: (state: BrowserNavState) => void) => () => void;
  onTabsChanged: (handler: (payload: { tabs: BrowserTabInfo[]; activeTabId: string | null }) => void) => () => void;
  onAskSelection: (handler: (payload: BrowserAskSelection) => void) => () => void;
  onFailLoad: (handler: (payload: BrowserFailLoad) => void) => () => void;
  onDownload: (handler: (payload: BrowserDownloadEvent) => void) => () => void;
  onCertError: (handler: (payload: { tabId?: string; url: string }) => void) => () => void;
}

export interface DesktopApi {
  getVersion: () => Promise<string>;
  getPaths: () => Promise<DesktopPaths>;
  openPath: (target: string) => Promise<{ ok: boolean; error?: string }>;
  /** Launch at login (background / tray). */
  getOpenAtLogin?: () => Promise<boolean>;
  setOpenAtLogin?: (enabled: boolean) => Promise<boolean>;
  /** Close (×) hides to tray; minimize stays on the taskbar. */
  hideToTray?: () => Promise<{ ok: boolean }>;
  showFromTray?: () => Promise<{ ok: boolean }>;
  pickFile: (opts?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
  pickDirectory: (opts?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
  restartRuntime: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  onRuntimeDied: (handler: (info: RuntimeDiedInfo) => void) => () => void;
  onRuntimeReady: (handler: (info: { url?: string }) => void) => () => void;
  onMenu: (channel: "new-chat" | "settings", handler: () => void) => () => void;
  browser?: DesktopBrowserApi;
}

declare global {
  interface Window {
    claw2Desktop?: DesktopApi;
  }
}

export {};
