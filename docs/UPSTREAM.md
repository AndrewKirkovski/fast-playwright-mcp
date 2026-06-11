# Tracking upstream

This fork descends from `microsoft/playwright-mcp` via the now-abandoned
`tontoko/fast-playwright-mcp`. Two facts govern how we stay current:

1. **`tontoko/fast-playwright-mcp` is abandoned** (last commit 2025-12-23). Nothing flows to us
   automatically.
2. **`microsoft/playwright-mcp` is now a thin wrapper.** Microsoft moved the MCP server **into the
   `microsoft/playwright` monorepo** at `packages/playwright-core/src/tools/` and ships it bundled in
   `playwright-core/lib/coreBundle`. The `playwright-mcp` repo's `index.js` just re-exports
   `createConnection` from that bundle.

**Consequence: there is no `git merge` from upstream.** Bringing features in means selective
reimplementation against our token-optimization layer. This doc is the process for doing that
sustainably.

## Where to look

- **Tools:** `microsoft/playwright` → `packages/playwright-core/src/tools/backend/*.ts` (one file per
  capability — `cookies.ts`, `storage.ts`, `route.ts`, `verify.ts`, `form.ts`, `devtools.ts`, …).
- **Infra:** `packages/playwright-core/src/tools/mcp/*.ts`.
- **Config surface:** `packages/playwright-core/src/tools/mcp/config.d.ts` — diffing this is the
  fastest way to spot new capabilities and config options.
- **NOT** `microsoft/playwright-mcp` (wrapper) and **NOT** `tontoko/fast-playwright-mcp` (dead).

A working clone for diffing lives at `.local/playwright-core-upstream/` (gitignored). Refresh before a
review: `git -C .local/playwright-core-upstream pull`.

## The sync unit is a Playwright version roll

We pin exact Playwright alpha versions. Each time we bump Playwright, treat it as the upstream sync:

1. **Bump the three pins** in `package.json`: `playwright`, `playwright-core`, `@playwright/test`.
2. **Run the internal-API audit.** Every reach into Playwright internals is migration debt that
   breaks when upstream reshuffles:
   ```bash
   grep -rnE '\._[a-zA-Z]|playwright-core/lib' src --include=*.ts
   ```
   Keep all such reaches centralized in `src/utils/playwright-internal.ts` (+ the ambient declaration
   `src/types/playwright-core-internal.d.ts`). Prefer public API whenever upstream exposes one
   (e.g. `page.ariaSnapshot({ mode: 'ai' })` replaced internal `_snapshotForAI`; `locator.normalize()`
   replaces internal `_resolveSelector`).
3. **Diff the tool list** to find new/renamed upstream tools:
   ```bash
   grep -rhoE "name: 'browser_[a-z_]+'" .local/playwright-core-upstream/packages/playwright-core/src/tools/backend/*.ts | sort -u > /tmp/upstream-tools.txt
   grep -rhoE "browser_[a-z_]+" src --include=*.ts | sort -u > /tmp/our-tools.txt
   comm -23 /tmp/upstream-tools.txt /tmp/our-tools.txt   # upstream-only → port candidates
   ```
4. **Port wanted tools** via the established pattern (new `src/tools/<cap>.ts`, register in
   `src/tools.ts`, gate by capability, fit the `expectation`/`Response` layer, adapt element targeting
   to our `selectors: ElementSelector[]`).
5. **Verify:** `tsc --noEmit`, `biome check`, the tool's spec on chromium/firefox/webkit, plus
   `node cli.js --help` smoke. Run the full `tests/` suite — a Playwright roll can change
   aria-snapshot formatting.
6. **Record it** in `CHANGELOG.md`.

## Porting conventions

- **Capabilities:** non-`core*` tags are opt-in via `--caps=<tag>` / `config.capabilities`. Upstream
  tags map to ours: `storage`, `network`, `testing`, `devtools`, `config` (add to the `ToolCapability`
  union in `config.d.ts` as needed).
- **Element targeting:** upstream uses `{ ref, selector, element }`; we use the typed
  `selectors: ElementSelector[]` (ref/role/css/text) resolved via `resolveFirstElement`
  (`src/tools/shared-element-utils.ts`). Never copy upstream's targeting verbatim.
- **File output:** upstream's `Response.addFileResult/addFileLink` have no direct equivalent; write via
  `context.outputFile()` + `node:fs` and return the path as a text result.
- **Don't adopt upstream's `browser_tabs` consolidation** — our four `browser_tab_*` tools are richer
  (per-tool `expectation`) and renaming is a breaking change.

## Current alignment

- **Aligned to:** Playwright `1.58.0-alpha-1766189059000` on `main`.
- **In progress:** roll to `1.61.0-alpha-1781023400000` on branch `chore/playwright-1.61-roll`
  (microsoft `v0.0.76` pin). See the port plan for the full migration checklist.
