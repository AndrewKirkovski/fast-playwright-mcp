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
- **New input / navigation tools** (ported from upstream): `browser_reload`; `browser_mouse_wheel`
  (wheel scroll by pixel delta; requires `--caps=vision`); and `browser_keydown` / `browser_keyup`
  (hold and release a key independently, enabling modifier combos like Shift-click).
- **Storage capability** (`--caps=storage`, opt-in) — 17 tools ported from upstream:
  - **Cookies**: `browser_cookie_list` / `_get` / `_set` / `_delete` / `_clear`.
  - **Web storage**: `browser_localstorage_*` and `browser_sessionstorage_*` (`list` / `get` / `set` /
    `delete` / `clear` each).
  - **Auth/session reuse**: `browser_storage_state` saves cookies + local storage to a JSON file and
    returns its path; `browser_set_storage_state` restores it (uses Playwright 1.61's
    `BrowserContext.setStorageState`).
- **`browser_fill_form`** (core) — fill multiple typed form fields (textbox/checkbox/radio/combobox/
  slider) in a single call, a token-efficient alternative to issuing separate type/select/check tools
  per field. Uses this fork's `selectors[]` targeting and supports `diveInIframes`.
- **Verify/assertion tools** (`--caps=testing`, opt-in) — `browser_verify_element_visible`,
  `browser_verify_text_visible`, `browser_verify_list_visible`, and `browser_verify_value`. Give an
  agent a definitive pass/fail signal (with a generated `expect(...)` snippet) without spending tokens
  on a snapshot to self-interpret.
- **Network routing / mocking** (`--caps=network`, opt-in) — `browser_route` (intercept a URL glob to
  fulfill a mock response or continue with header edits), `browser_route_list`, `browser_unroute`, and
  `browser_network_state_set` (toggle online/offline). Routes are tracked on the `Context` so they
  persist across navigations.
- **More ported tools**: `browser_press_sequentially` (page-level type, key-by-key) and
  `browser_console_clear` (core); `browser_generate_locator` (`--caps=testing`); `browser_get_config`
  (`--caps=config`, dumps the resolved config); and interactive tracing `browser_start_tracing` /
  `browser_stop_tracing` (`--caps=devtools`, saves a `.zip` trace; guarded against `--save-trace`).
  `browser_run_code` was intentionally **not** ported — it executes arbitrary Node code (not just
  page JS) and is a security escalation we chose not to enable by default.

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
