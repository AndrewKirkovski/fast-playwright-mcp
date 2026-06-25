import type * as playwright from 'playwright';
import type * as actions from './actions.js';
import { BatchExecutor } from './batch/batch-executor.js';
import type {
  BrowserContextFactory,
  ClientInfo,
} from './browser-context-factory.js';
import type { FullConfig } from './config.js';
import { outputFile } from './config.js';
import type { SessionLog } from './session-log.js';
import { Tab } from './tab.js';
import type { Tool } from './tools/tool.js';
import type { BatchContext } from './types/batch.js';
import { contextDebug, logUnhandledError, testDebug } from './utils/log.js';

type ContextOptions = {
  tools: Tool[];
  config: FullConfig;
  browserContextFactory: BrowserContextFactory;
  sessionLog: SessionLog | undefined;
  clientInfo: ClientInfo;
};
export type RouteEntry = {
  pattern: string;
  abort?: boolean;
  abortErrorCode?: string;
  status?: number;
  body?: string;
  contentType?: string;
  responseHeaders?: Record<string, string>;
  modifyResponse?: boolean;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  handler: (route: playwright.Route) => Promise<void>;
};

/** CDP network throttling profile (bytes/sec, ms). Chromium-only. */
export type NetworkConditions = {
  downloadThroughput: number;
  uploadThroughput: number;
  latency: number;
};

// Top-level regex literals (Biome: declare regex at top level).
const REGEX_SPECIAL_CHARS = /[.+?^${}()|[\]\\]/g;
const GLOB_STAR = /\*/g;
/** Build a host matcher for an origin pattern, mirroring the `*://${origin}/**`
 *  globs used in _setupRequestInterception (`*` matches any chars except `/`).
 *  Origins are operator-supplied (CLI/env), so dynamic RegExp is safe here. */
function originHostRegExp(origin: string): RegExp {
  const escaped = origin
    .replace(REGEX_SPECIAL_CHARS, '\\$&')
    .replace(GLOB_STAR, '[^/]*');
  return new RegExp(`^${escaped}$`);
}
export class Context {
  readonly tools: Tool[];
  readonly config: FullConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _browserContextPromise:
    | Promise<{
        browserContext: playwright.BrowserContext;
        close: () => Promise<void>;
      }>
    | undefined;
  private readonly _browserContextFactory: BrowserContextFactory;
  private readonly _tabs: Tab[] = [];
  private readonly _routes: RouteEntry[] = [];
  private _interactiveTracing = false;
  private _offline = false;
  // CDP-backed network state (Chromium-only). Persisted on the Context so it
  // survives the tab-close -> lazy-recreate cycle and applies to new pages.
  private _cacheDisabled = false;
  private _networkConditions: NetworkConditions | undefined;
  private readonly _cdpSessions = new WeakMap<
    playwright.Page,
    Promise<playwright.CDPSession>
  >();
  private _currentTab: Tab | undefined;
  private readonly _clientInfo: ClientInfo;
  private _batchExecutor: BatchExecutor | undefined;
  private static readonly _allContexts: Set<Context> = new Set();
  private _closeBrowserContextPromise: Promise<void> | undefined;
  private _isRunningTool = false;
  private readonly _abortController = new AbortController();
  batchContext?: BatchContext;
  constructor(options: ContextOptions) {
    this.tools = options.tools;
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.options = options;
    this._browserContextFactory = options.browserContextFactory;
    this._clientInfo = options.clientInfo;
    testDebug('create context');
    Context._allContexts.add(this);
  }
  static async disposeAll() {
    await Promise.all(
      [...Context._allContexts].map((context) => context.dispose())
    );
  }
  tabs(): Tab[] {
    return this._tabs;
  }
  currentTab(): Tab | undefined {
    return this._currentTab;
  }
  currentTabOrDie(): Tab {
    if (!this._currentTab) {
      throw new Error(
        'No open pages available. Use the "browser_navigate" tool to navigate to a page first.'
      );
    }
    return this._currentTab;
  }
  async newTab(): Promise<Tab> {
    contextDebug('Creating new tab');
    const { browserContext } = await this._ensureBrowserContext();
    const page = await browserContext.newPage();
    const tab = this._tabs.find((t) => t.page === page);
    if (!tab) {
      throw new Error('Failed to create tab: tab not found after creation');
    }
    this._currentTab = tab;
    // Apply CDP network state before returning (the _onPageCreated hook also
    // fires it, but unawaited) so a navigate on this fresh tab is deterministically
    // throttled / cache-disabled. Re-sending is idempotent.
    if (this._hasCdpNetworkState()) {
      await this._applyCdpNetworkStateToPage(page);
    }
    contextDebug('New tab created successfully');
    return this._currentTab;
  }
  async selectTab(index: number) {
    const tab = this._tabs[index];
    if (!tab) {
      throw new Error(`Tab ${index} not found`);
    }
    await tab.page.bringToFront();
    this._currentTab = tab;
    return tab;
  }
  async ensureTab(): Promise<Tab> {
    const { browserContext } = await this._ensureBrowserContext();
    if (!this._currentTab) {
      await browserContext.newPage();
    }
    if (!this._currentTab) {
      throw new Error(
        'Failed to ensure tab: current tab is null after creating page'
      );
    }
    if (this._hasCdpNetworkState()) {
      await this._applyCdpNetworkStateToPage(this._currentTab.page);
    }
    return this._currentTab;
  }
  async ensureBrowserContext(): Promise<playwright.BrowserContext> {
    const { browserContext } = await this._ensureBrowserContext();
    return browserContext;
  }
  async addRoute(entry: RouteEntry): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await browserContext.route(entry.pattern, entry.handler);
    this._routes.push(entry);
  }
  routes(): RouteEntry[] {
    return this._routes;
  }
  async removeRoute(pattern?: string): Promise<number> {
    const toRemove = pattern
      ? this._routes.filter((r) => r.pattern === pattern)
      : this._routes.slice();
    // Only unroute on a live context; if it was torn down the routes are already
    // gone — just reconcile the in-memory registry (avoids recreating a context).
    if (this._browserContextPromise && toRemove.length > 0) {
      const browserContext = await this.ensureBrowserContext();
      await Promise.all(
        toRemove.map((entry) =>
          browserContext.unroute(entry.pattern, entry.handler)
        )
      );
    }
    const keep = pattern
      ? this._routes.filter((r) => r.pattern !== pattern)
      : [];
    this._routes.length = 0;
    this._routes.push(...keep);
    return toRemove.length;
  }
  async setOffline(offline: boolean): Promise<void> {
    this._offline = offline;
    const browserContext = await this.ensureBrowserContext();
    await browserContext.setOffline(offline);
  }
  /** Enable/disable the HTTP cache via CDP (Chromium-only). */
  async setCacheEnabled(enabled: boolean): Promise<void> {
    this._cacheDisabled = !enabled;
    await this._applyCdpNetworkStateToAllPages();
  }
  /** Set (or clear, with `undefined`) network throttling via CDP (Chromium-only). */
  async setNetworkConditions(
    conditions: NetworkConditions | undefined
  ): Promise<void> {
    this._networkConditions = conditions;
    await this._applyCdpNetworkStateToAllPages();
  }
  /** Whether a request URL must be blocked under the configured
   *  allowed/blocked-origins policy. Mirrors `_setupRequestInterception` so
   *  tools that fetch server-side (browser_route modifyResponse) can't bypass
   *  the route-based origin guard. */
  isRequestBlockedByPolicy(url: string): boolean {
    const allowed = this.config.network?.allowedOrigins;
    const blocked = this.config.network?.blockedOrigins;
    if (!(allowed?.length || blocked?.length)) {
      return false;
    }
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      // Unparseable URL — let Playwright's own handling deal with it.
      return false;
    }
    const matchesAny = (origins: string[] | undefined): boolean =>
      origins?.some((origin) => originHostRegExp(origin).test(host)) ?? false;
    if (matchesAny(blocked)) {
      return true;
    }
    // When an allow-list is set, anything not on it is blocked (default-deny).
    if (allowed?.length) {
      return !matchesAny(allowed);
    }
    return false;
  }
  /** Clear all network customizations: routes, cache override, throttling, and
   *  offline. Useful because cache/throttle/offline persist across the
   *  tab-close -> lazy-recreate cycle. */
  async resetNetwork(): Promise<void> {
    const hadCdpState = this._hasCdpNetworkState();
    this._cacheDisabled = false;
    this._networkConditions = undefined;
    this._offline = false;
    await this.removeRoute();
    // Don't spin up a torn-down context just to reset it; cleared flags above
    // already take effect on the next lazy-recreate.
    if (!this._browserContextPromise) {
      return;
    }
    const browserContext = await this.ensureBrowserContext();
    await browserContext.setOffline(false);
    if (hadCdpState) {
      // Push the cleared CDP state (cache on, no throttle) to all pages.
      await this._applyCdpNetworkStateToAllPages();
    }
  }
  /** True when per-page CDP network state (cache off / throttle) is active and
   *  must be (re)applied to new/recreated pages. Only ever true on Chromium
   *  (the cache/throttle tools are chromiumOnly). */
  private _hasCdpNetworkState(): boolean {
    return this._cacheDisabled || this._networkConditions !== undefined;
  }
  /** Lazily open (and cache) one CDP session per page. Throws a friendly error
   *  on non-Chromium browsers where newCDPSession is unavailable. */
  private _cdpSessionForPage(
    page: playwright.Page
  ): Promise<playwright.CDPSession> {
    let session = this._cdpSessions.get(page);
    if (!session) {
      session = page
        .context()
        .newCDPSession(page)
        .then(async (client) => {
          await client.send('Network.enable');
          return client;
        })
        .catch((error: unknown) => {
          // Don't keep a rejected promise cached — let the next call retry.
          this._cdpSessions.delete(page);
          throw new Error(
            'Cache/throttle control requires a Chromium-based browser ' +
              '(Chrome/Edge); CDP is unavailable on this browser. ' +
              `Original error: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      this._cdpSessions.set(page, session);
    }
    return session;
  }
  /** Push the current cache + throttle state to one page over CDP. */
  private async _applyCdpNetworkStateToPage(
    page: playwright.Page
  ): Promise<void> {
    const client = await this._cdpSessionForPage(page);
    await client.send('Network.setCacheDisabled', {
      cacheDisabled: this._cacheDisabled,
    });
    // Cache/throttle are online-only concerns and do NOT manage offline (that's
    // browser_network_state_set, via Playwright's setOffline). `offline: false`
    // here. Negative throughput / zero latency disables throttling (CDP). These
    // two mechanisms are not designed to be combined — see the tool docs.
    await client.send(
      'Network.emulateNetworkConditions',
      this._networkConditions
        ? { offline: false, ...this._networkConditions }
        : {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          }
    );
  }
  private async _applyCdpNetworkStateToAllPages(): Promise<void> {
    const browserContext = await this.ensureBrowserContext();
    await Promise.all(
      browserContext
        .pages()
        .map((page) => this._applyCdpNetworkStateToPage(page))
    );
  }
  async startTracing(): Promise<void> {
    if (this.config.saveTrace) {
      throw new Error(
        'Cannot start interactive tracing while --save-trace is enabled; the session is already being traced.'
      );
    }
    if (this._interactiveTracing) {
      throw new Error('Tracing is already started');
    }
    const browserContext = await this.ensureBrowserContext();
    this._interactiveTracing = true;
    try {
      await browserContext.tracing.start({
        screenshots: true,
        snapshots: true,
      });
    } catch (error) {
      this._interactiveTracing = false;
      throw error;
    }
  }
  async stopTracing(path: string): Promise<void> {
    if (!this._interactiveTracing) {
      throw new Error('Tracing is not started');
    }
    const browserContext = await this.ensureBrowserContext();
    try {
      await browserContext.tracing.stop({ path });
    } finally {
      this._interactiveTracing = false;
    }
  }
  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab) {
      throw new Error(`Tab ${index} not found`);
    }
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }
  outputFile(name: string): Promise<string> {
    return outputFile(this.config, this._clientInfo.rootPath, name);
  }
  private _onPageCreated(page: playwright.Page) {
    const newTab = new Tab(this, page, (closedTab) =>
      this._onPageClosed(closedTab)
    );
    this._tabs.push(newTab);
    this._currentTab ??= newTab;
    // Re-apply CDP network state (cache off / throttle) to pages that appear
    // after it was set — new tabs and pages of a lazily-recreated context.
    if (this._hasCdpNetworkState()) {
      this._applyCdpNetworkStateToPage(page).catch(logUnhandledError);
    }
  }
  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1) {
      return;
    }
    this._tabs.splice(index, 1);
    if (this._currentTab === tab) {
      this._currentTab = this._tabs[Math.min(index, this._tabs.length - 1)];
    }
    if (!this._tabs.length) {
      contextDebug('No tabs remaining, closing browser context');
      this.closeBrowserContext().catch((error) => {
        // Error is handled by logUnhandledError in closeBrowserContext
        contextDebug('Error closing browser context:', error);
      });
    }
  }
  async closeBrowserContext() {
    contextDebug('Closing browser context');
    this._closeBrowserContextPromise ??= this._closeBrowserContextImpl().catch(
      (error) => {
        contextDebug('Failed to close browser context:', error);
        logUnhandledError(error);
      }
    );
    await this._closeBrowserContextPromise;
    this._closeBrowserContextPromise = undefined;
    contextDebug('Browser context closed');
  }
  isRunningTool() {
    return this._isRunningTool;
  }
  setRunningTool(isRunningTool: boolean) {
    this._isRunningTool = isRunningTool;
  }
  /**
   * Gets or creates the batch executor for this context
   */
  getBatchExecutor(): BatchExecutor {
    this._batchExecutor ??= (() => {
      // Create tool registry from available tools
      const toolRegistry = new Map();
      for (const tool of this.tools) {
        toolRegistry.set(tool.schema.name, tool);
      }
      return new BatchExecutor(this, toolRegistry);
    })();
    return this._batchExecutor;
  }
  private async _closeBrowserContextImpl() {
    if (!this._browserContextPromise) {
      return;
    }
    testDebug('close context');
    const promise = this._browserContextPromise;
    this._browserContextPromise = undefined;
    await promise.then(async ({ browserContext, close }) => {
      if (this.config.saveTrace) {
        await browserContext.tracing.stop();
      }
      if (this._interactiveTracing) {
        // Best-effort: discard the in-progress interactive trace when the
        // context is torn down (e.g. last tab closed) so state stays consistent.
        await browserContext.tracing.stop().catch(() => {
          // ignore
        });
        this._interactiveTracing = false;
      }
      await close();
    });
  }
  async dispose() {
    this._abortController.abort('MCP context disposed');
    await this.closeBrowserContext();
    Context._allContexts.delete(this);
  }
  private async _setupRequestInterception(context: playwright.BrowserContext) {
    if (this.config.network?.allowedOrigins?.length) {
      await context.route('**', (route) => route.abort('blockedbyclient'));
      await Promise.all(
        this.config.network.allowedOrigins.map((origin) =>
          context.route(`*://${origin}/**`, (route) => route.continue())
        )
      );
    }
    if (this.config.network?.blockedOrigins?.length) {
      await Promise.all(
        this.config.network.blockedOrigins.map((origin) =>
          context.route(`*://${origin}/**`, (route) =>
            route.abort('blockedbyclient')
          )
        )
      );
    }
  }
  private _ensureBrowserContext() {
    this._browserContextPromise ??= (() => {
      contextDebug('Ensuring browser context exists');
      const promise = this._setupBrowserContext();
      promise.catch((error) => {
        contextDebug('Failed to setup browser context:', error);
        this._browserContextPromise = undefined;
      });
      return promise;
    })();
    return this._browserContextPromise;
  }
  private async _setupBrowserContext(): Promise<{
    browserContext: playwright.BrowserContext;
    close: () => Promise<void>;
  }> {
    if (this._closeBrowserContextPromise) {
      throw new Error('Another browser context is being closed.');
    }
    contextDebug('Setting up new browser context');
    const result = await this._browserContextFactory.createContext(
      this._clientInfo,
      this._abortController.signal
    );
    const { browserContext } = result;
    await this._setupRequestInterception(browserContext);
    // Re-apply user routes and offline state so they survive a tab-close ->
    // lazy-recreate cycle (the browser context is rebuilt, but Context persists).
    await Promise.all(
      this._routes.map((entry) =>
        browserContext.route(entry.pattern, entry.handler)
      )
    );
    if (this._offline) {
      await browserContext.setOffline(true);
    }
    if (this.sessionLog) {
      await InputRecorder.create(this, browserContext);
    }
    for (const page of browserContext.pages()) {
      this._onPageCreated(page);
    }
    browserContext.on('page', (page) => this._onPageCreated(page));
    if (this.config.saveTrace) {
      await browserContext.tracing.start({
        name: 'trace',
        screenshots: false,
        snapshots: true,
        sources: false,
      });
    }
    return result;
  }
}
export class InputRecorder {
  private readonly _context: Context;
  private readonly _browserContext: playwright.BrowserContext;
  private constructor(
    context: Context,
    browserContext: playwright.BrowserContext
  ) {
    this._context = context;
    this._browserContext = browserContext;
  }
  static async create(
    context: Context,
    browserContext: playwright.BrowserContext
  ) {
    const recorder = new InputRecorder(context, browserContext);
    await recorder._initialize();
    return recorder;
  }
  private async _initialize() {
    const sessionLog = this._context.sessionLog;
    if (!sessionLog) {
      throw new Error('Session log is required for recorder initialization');
    }
    await (
      this._browserContext as unknown as {
        _enableRecorder: (config: unknown, handlers: unknown) => Promise<void>;
      }
    )._enableRecorder(
      {
        mode: 'recording',
        recorderMode: 'api',
      },
      {
        actionAdded: (
          page: playwright.Page,
          data: actions.ActionInContext,
          code: string
        ) => {
          if (this._context.isRunningTool()) {
            return;
          }
          const tab = Tab.forPage(page);
          if (tab) {
            sessionLog.logUserAction(data.action, tab, code, false);
          }
        },
        actionUpdated: (
          page: playwright.Page,
          data: actions.ActionInContext,
          code: string
        ) => {
          if (this._context.isRunningTool()) {
            return;
          }
          const tab = Tab.forPage(page);
          if (tab) {
            sessionLog.logUserAction(data.action, tab, code, true);
          }
        },
        signalAdded: (page: playwright.Page, data: actions.SignalInContext) => {
          if (this._context.isRunningTool()) {
            return;
          }
          if (data.signal.name !== 'navigation') {
            return;
          }
          const tab = Tab.forPage(page);
          const navigateAction: actions.Action = {
            name: 'navigate',
            url: data.signal.url,
            signals: [],
          };
          if (tab) {
            sessionLog.logUserAction(
              navigateAction,
              tab,
              `await page.goto('${data.signal.url}');`,
              false
            );
          }
        },
      }
    );
  }
}
