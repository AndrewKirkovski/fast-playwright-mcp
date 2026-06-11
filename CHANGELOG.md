# Changelog

All notable changes to this fork — **[AndrewKirkovski/fast-playwright-mcp](https://github.com/AndrewKirkovski/fast-playwright-mcp)** — are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This fork descends from [`tontoko/fast-playwright-mcp`](https://github.com/tontoko/fast-playwright-mcp) `0.1.3`
(token optimization, batch execution, diagnostics, the unified selector system), which descends from
[`microsoft/playwright-mcp`](https://github.com/microsoft/playwright-mcp). Entries below cover what
**this** fork adds on top. See [`docs/UPSTREAM.md`](docs/UPSTREAM.md) for how we track upstream.

## [Unreleased]

### Added
- **iframe-piercing selectors** — opt-in `diveInIframes` (default off) on every selector-based tool
  (`browser_click`, `browser_type`, `browser_hover`, `browser_select_option`, `browser_drag`,
  element `browser_take_screenshot`, `browser_evaluate`, `browser_inspect_html`). When set, the
  `css`/`role`/`text` strategies search the main frame first, then fall back to child `<iframe>`s
  (incl. `about:srcdoc`). The action response notes the iframe path when a match is found in a frame.
- **`browser_emulate_media` tool** — emulate CSS media features via `page.emulateMedia()`
  (`colorScheme`, `contrast`, `forcedColors`, `media`, `reducedMotion`).
- **Per-workspace profile isolation** — the persistent browser profile is isolated per workspace with
  a lockfile pre-check, so concurrent sessions across projects don't collide on a shared profile.
- **`browser_find_elements` implicit ARIA roles** — role searches resolve implicit ARIA roles via
  `getByRole`, so a bare `<button>` matches `role: button` without an explicit `role` attribute.

### Fixed
- **element-discovery CSS selector generation** is now robust to modern markup: per-class
  `CSS.escape()` for Tailwind-style names (`hover:text-primary`, `text-[13px]`, `w-1/2`), `classList`
  instead of `className` (handles SVG `SVGAnimatedString`), and `try/catch` guards around selector
  strategies.

### Security
- Bumped `@modelcontextprotocol/sdk` `^1.16.0` → `^1.29.0` (resolved 1.29.0).
- Bumped `ws` `^8.18.1` → `^8.21.0`, clearing GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure).

### Changed
- **Rolled Playwright to `1.61.0-alpha-1781023400000`** (from `1.58.0-alpha-1766189059000`; tracks
  microsoft v0.0.76). 1.61 bundled playwright-core's internals and removed several internal methods
  this fork relied on. All internal reach-throughs are now centralized behind a typed declaration in
  `src/utils/playwright-internal.ts` (`asLocator`, `registry`, `registryDirectory`,
  `startTraceViewerServer` via `lib/coreBundle`), and snapshot / evaluate / code-gen moved onto public
  APIs: `page.ariaSnapshot({ mode: 'ai' })`, `page`/`locator.evaluate(fn, expr)`, and
  `locator.normalize()`. No behavioral changes to tools.

## [0.1.3] — baseline (inherited from tontoko/fast-playwright-mcp)

Token optimization (`expectation` parameter), image compression, `browser_batch_execute`, snapshot
control + diff detection, the diagnostic system (`browser_find_elements`, `browser_diagnose`),
`browser_inspect_html`, and the unified multi-strategy selector system. See the README for details.
