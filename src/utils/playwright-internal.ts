/**
 * Centralized, typed access to playwright-core internals that are NOT part of
 * its public API.
 *
 * As of playwright-core 1.61 the granular internal module paths this project
 * used to import directly — `playwright-core/lib/utils`,
 * `playwright-core/lib/server`, `playwright-core/lib/server/registry/index` —
 * were removed from the package `exports` map and collapsed into the bundled
 * `playwright-core/lib/coreBundle` entry point. Importing the old paths now
 * fails at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * The bundle's shape is declared in `src/types/playwright-core-internal.d.ts`,
 * so the reach-throughs below are fully type-checked (no `@ts-expect-error`).
 * Keeping every internal access in this one file means a future upstream
 * reshuffle only has to be fixed here, not across the codebase.
 */
import coreBundle from 'playwright-core/lib/coreBundle';

/** Convert a resolved selector into a locator string for the given language. */
export function asLocator(language: string, selector: string): string {
  return coreBundle.iso.asLocator(language, selector);
}

/** Absolute path to playwright-core's browser/profile registry directory. */
export const registryDirectory = coreBundle.registry.registryDirectory;

/** The playwright-core browser registry singleton (used by the CDP relay). */
export const registry = coreBundle.registry.registry;

/** Start the Playwright trace viewer HTTP server. */
export const startTraceViewerServer = coreBundle.server.startTraceViewerServer;
