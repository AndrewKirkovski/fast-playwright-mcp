import {
  closeSync,
  promises as fsPromises,
  openSync,
  readlinkSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { join as pathJoin } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  firefox,
  webkit,
} from 'playwright';
//
// @ts-expect-error - Type definitions for playwright-core internal registry are not available
import { registryDirectory } from 'playwright-core/lib/server/registry/index';
import type { FullConfig } from './config.js';
import { outputFile } from './config.js';
import { createHash } from './utils/guid.js';
import { browserDebug, logUnhandledError, testDebug } from './utils/log.js';

function getBrowserType(browserName: string): BrowserType {
  switch (browserName) {
    case 'chromium':
      return chromium;
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
    default:
      throw new Error(`Unsupported browser: ${browserName}`);
  }
}

export function contextFactory(config: FullConfig): BrowserContextFactory {
  if (config.browser.remoteEndpoint) {
    return new RemoteContextFactory(config);
  }
  if (config.browser.cdpEndpoint) {
    return new CdpContextFactory(config);
  }
  if (config.browser.isolated) {
    return new IsolatedContextFactory(config);
  }
  return new PersistentContextFactory(config);
}
export type ClientInfo = { name?: string; version?: string; rootPath?: string };
export interface BrowserContextFactory {
  readonly name: string;
  readonly description: string;
  createContext(
    clientInfo: ClientInfo,
    abortSignal: AbortSignal
  ): Promise<{
    browserContext: BrowserContext;
    close: () => Promise<void>;
  }>;
}
class BaseContextFactory implements BrowserContextFactory {
  readonly name: string;
  readonly description: string;
  readonly config: FullConfig;
  protected _browserPromise: Promise<Browser> | undefined;
  protected _tracesDir: string | undefined;
  constructor(name: string, description: string, config: FullConfig) {
    this.name = name;
    this.description = description;
    this.config = config;
  }
  protected _obtainBrowser(): Promise<Browser> {
    if (this._browserPromise) {
      return this._browserPromise;
    }
    testDebug(`obtain browser (${this.name})`);
    this._browserPromise = this._doObtainBrowser();
    this._browserPromise
      .then((browser) => {
        browser.on('disconnected', () => {
          this._browserPromise = undefined;
        });
      })
      .catch((error) => {
        browserDebug('Browser connection failed:', error);
        this._browserPromise = undefined;
      });
    return this._browserPromise;
  }
  protected _doObtainBrowser(): Promise<Browser> {
    throw new Error('Not implemented');
  }
  async createContext(clientInfo: ClientInfo): Promise<{
    browserContext: BrowserContext;
    close: () => Promise<void>;
  }> {
    if (this.config.saveTrace) {
      this._tracesDir = await outputFile(
        this.config,
        clientInfo.rootPath,
        `traces-${Date.now()}`
      );
    }
    testDebug(`create browser context (${this.name})`);
    const browser = await this._obtainBrowser();
    const browserContext = await this._doCreateContext(browser);
    return {
      browserContext,
      close: () => this._closeBrowserContext(browserContext, browser),
    };
  }
  protected _doCreateContext(_browser: Browser): Promise<BrowserContext> {
    throw new Error('Not implemented');
  }
  private async _closeBrowserContext(
    browserContext: BrowserContext,
    browser: Browser
  ) {
    testDebug(`close browser context (${this.name})`);
    if (browser.contexts().length === 1) {
      this._browserPromise = undefined;
    }
    await browserContext.close().catch(logUnhandledError);
    if (browser.contexts().length === 0) {
      testDebug(`close browser (${this.name})`);
      await browser.close().catch(logUnhandledError);
    }
  }
}
class IsolatedContextFactory extends BaseContextFactory {
  constructor(config: FullConfig) {
    super('isolated', 'Create a new isolated browser context', config);
  }
  protected override async _doObtainBrowser(): Promise<Browser> {
    await injectCdpPort(this.config.browser);
    const browserType = getBrowserType(this.config.browser.browserName);
    return browserType
      .launch({
        tracesDir: this._tracesDir,
        ...this.config.browser.launchOptions,
        handleSIGINT: false,
        handleSIGTERM: false,
      })
      .catch((error) => {
        if (error.message.includes("Executable doesn't exist")) {
          throw new Error(
            'Browser specified in your config is not installed. Either install it (likely) or change the config.'
          );
        }
        throw error;
      });
  }
  protected override _doCreateContext(
    browser: Browser
  ): Promise<BrowserContext> {
    return browser.newContext(this.config.browser.contextOptions);
  }
}
class CdpContextFactory extends BaseContextFactory {
  constructor(config: FullConfig) {
    super('cdp', 'Connect to a browser over CDP', config);
  }
  protected override _doObtainBrowser(): Promise<Browser> {
    return chromium.connectOverCDP(this.config.browser.cdpEndpoint as string);
  }
  protected override async _doCreateContext(
    browser: Browser
  ): Promise<BrowserContext> {
    return this.config.browser.isolated
      ? await browser.newContext()
      : browser.contexts()[0];
  }
}
class RemoteContextFactory extends BaseContextFactory {
  constructor(config: FullConfig) {
    super('remote', 'Connect to a browser using a remote endpoint', config);
  }
  protected override _doObtainBrowser(): Promise<Browser> {
    const url = new URL(this.config.browser.remoteEndpoint as string);
    url.searchParams.set('browser', this.config.browser.browserName);
    if (this.config.browser.launchOptions) {
      url.searchParams.set(
        'launch-options',
        JSON.stringify(this.config.browser.launchOptions)
      );
    }
    return getBrowserType(this.config.browser.browserName).connect(String(url));
  }
  protected override _doCreateContext(
    browser: Browser
  ): Promise<BrowserContext> {
    return browser.newContext();
  }
}
class PersistentContextFactory implements BrowserContextFactory {
  readonly config: FullConfig;
  readonly name = 'persistent';
  readonly description = 'Create a new persistent browser context';
  private readonly _userDataDirs = new Set<string>();
  constructor(config: FullConfig) {
    this.config = config;
  }
  async createContext(clientInfo: ClientInfo): Promise<{
    browserContext: BrowserContext;
    close: () => Promise<void>;
  }> {
    await injectCdpPort(this.config.browser);
    testDebug('create browser context (persistent)');
    const userDataDir =
      this.config.browser.userDataDir ??
      (await this._createUserDataDir(clientInfo.rootPath));
    let tracesDir: string | undefined;
    if (this.config.saveTrace) {
      tracesDir = await outputFile(
        this.config,
        clientInfo.rootPath,
        `traces-${Date.now()}`
      );
    }
    this._userDataDirs.add(userDataDir);
    testDebug('lock user data dir', userDataDir);

    // Pre-check the profile lockfile before invoking Chromium. If we skipped
    // this and called launchPersistentContext directly, Chromium's
    // ProcessSingleton IPC would deflect the launch to any already-running
    // Chrome holding the profile — which opens an extra `about:blank` tab in
    // the neighbour browser *and* fails the launch call. See upstream
    // microsoft/playwright packages/playwright-core/src/tools/mcp/browserFactory.ts.
    if (await isProfileLocked5Times(userDataDir)) {
      throw new Error(
        `Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`
      );
    }

    const browserType = getBrowserType(this.config.browser.browserName);
    try {
      const browserContext = await browserType.launchPersistentContext(
        userDataDir,
        {
          tracesDir,
          ...this.config.browser.launchOptions,
          ...this.config.browser.contextOptions,
          handleSIGINT: false,
          handleSIGTERM: false,
        }
      );
      const close = () =>
        this._closeBrowserContext(browserContext, userDataDir);
      return { browserContext, close };
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes("Executable doesn't exist")
      ) {
        throw new Error(
          'Browser specified in your config is not installed. Either install it (likely) or change the config.'
        );
      }
      if (
        error instanceof Error &&
        (error.message.includes('ProcessSingleton') ||
          error.message.includes('exitCode=21'))
      ) {
        // Profile lock was acquired between precheck and launch (race).
        // No retry — retrying recursively leaks about:blank tabs into the
        // already-running Chrome via ProcessSingleton deflection.
        throw new Error(
          `Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`
        );
      }
      throw error;
    }
  }
  private async _closeBrowserContext(
    browserContext: BrowserContext,
    userDataDir: string
  ) {
    testDebug('close browser context (persistent)');
    testDebug('release user data dir', userDataDir);
    await browserContext.close().catch((error) => {
      browserDebug('Failed to close browser context:', error);
    });
    this._userDataDirs.delete(userDataDir);
    testDebug('close browser context complete (persistent)');
  }
  private async _createUserDataDir(rootPath: string | undefined) {
    const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory;
    const browserToken =
      this.config.browser.launchOptions?.channel ??
      this.config.browser?.browserName;
    // Always hash a per-workspace token so different Claude Code sessions
    // (or any MCP client) in different project directories get isolated
    // profiles. If the client does not pass rootPath, fall back to the
    // server process cwd — still deterministic per workspace, and avoids
    // the previous collision where rootPath-less clients all collapsed
    // onto a single shared `mcp-chrome` profile.
    const rootPathToken = `-${createHash(rootPath ?? process.cwd())}`;
    const result = pathJoin(dir, `mcp-${browserToken}${rootPathToken}`);
    await fsPromises.mkdir(result, { recursive: true });
    return result;
  }
}

// Ported from upstream:
// microsoft/playwright packages/playwright-core/src/tools/mcp/browserFactory.ts
// (isProfileLocked / isProfileLocked5Times). Used to detect a locked user
// data dir BEFORE invoking Chromium, so we never trigger ProcessSingleton
// deflection into a neighbour browser.
function isProfileLocked5Times(userDataDir: string): Promise<boolean> {
  // Sequential poll with 1s delay between attempts. Implemented recursively
  // instead of a for/await loop to satisfy the noAwaitInLoop rule, matching
  // the pattern used in element-discovery.ts (processStrategiesSequentially).
  const checkAttempt = async (remaining: number): Promise<boolean> => {
    if (!isProfileLocked(userDataDir)) {
      return false;
    }
    if (remaining <= 1) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return checkAttempt(remaining - 1);
  };
  return checkAttempt(5);
}

export function isProfileLocked(userDataDir: string): boolean {
  const lockFile = process.platform === 'win32' ? 'lockfile' : 'SingletonLock';
  const lockPath = pathJoin(userDataDir, lockFile);

  if (process.platform === 'win32') {
    try {
      const fd = openSync(lockPath, 'r+');
      closeSync(fd);
      return false;
    } catch (e: unknown) {
      return (e as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  try {
    const target = readlinkSync(lockPath);
    const pid = Number.parseInt(target.split('-').pop() ?? '', 10);
    if (Number.isNaN(pid)) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function injectCdpPort(browserConfig: FullConfig['browser']) {
  if (browserConfig.browserName === 'chromium') {
    (browserConfig.launchOptions as { cdpPort?: number }).cdpPort =
      await findFreePort();
  }
}
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
