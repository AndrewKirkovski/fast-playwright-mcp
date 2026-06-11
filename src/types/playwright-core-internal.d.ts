/**
 * Minimal, hand-written type declarations for the playwright-core internals this
 * project reaches into via the bundled `coreBundle` entry point.
 *
 * These symbols are NOT part of playwright-core's public API. As of
 * playwright-core 1.61 the granular internal module paths (`lib/utils`,
 * `lib/server`, `lib/server/registry/index`) were dropped from the package
 * `exports` map and collapsed into `lib/coreBundle`. Declaring the bundle's
 * shape here lets TypeScript type-check our usage instead of suppressing it with
 * `@ts-expect-error`. The shapes below cover only what we use; extend them if we
 * start consuming more, and revisit when upstream reshuffles internals.
 *
 * All consumption goes through `src/utils/playwright-internal.ts`.
 */
declare module 'playwright-core/lib/coreBundle' {
  /** Bundled `@isomorphic/locatorGenerators` namespace. */
  interface IsoLocators {
    asLocator(language: string, selector: string): string;
  }

  /** A browser executable resolved from the registry. */
  interface RegistryExecutable {
    executablePath(): string | undefined;
  }

  /** The playwright-core browser registry singleton. */
  interface BrowserRegistry {
    findExecutable(channel: string): RegistryExecutable | undefined;
  }

  /** Bundled `server/registry/index` namespace. */
  interface RegistryModule {
    registryDirectory: string;
    registry: BrowserRegistry;
  }

  /** Handle for a running trace viewer HTTP server. */
  interface TraceViewerServer {
    urlPrefix(purpose: 'human-readable' | 'precise'): string;
  }

  /** Bundled `server/index` namespace. */
  interface ServerModule {
    startTraceViewerServer(): Promise<TraceViewerServer>;
  }

  interface CoreBundle {
    iso: IsoLocators;
    registry: RegistryModule;
    server: ServerModule;
  }

  const coreBundle: CoreBundle;
  export default coreBundle;
}
