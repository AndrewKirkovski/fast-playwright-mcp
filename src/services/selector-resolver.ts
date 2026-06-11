import type { Frame, Locator, Page } from 'playwright';
import {
  type BatchResolutionOptions,
  type CategorizedSelectors,
  type ElementMetadata,
  type ElementSelector,
  type EnhancedSelectorResult,
  type FrameStep,
  isCSSSelector,
  isRefSelector,
  isRoleSelector,
  isTextSelector,
  ResolutionStrategy,
  SelectorConfidence,
  type SelectorResolutionResult,
  validateElementSelector,
} from '../types/selectors.js';
import { tabDebug } from '../utils/log.js';

// Top-level regex for performance
const GENERIC_TAG_SELECTOR = /^[a-z]+$/;

/**
 * Core service for resolving element selectors into Playwright locators
 * Handles parallel resolution and provides confidence scoring
 */
export type FrameMatchSink = (
  frame: { depth: number; path: FrameStep[] },
  selector: ElementSelector
) => void;

export class SelectorResolver {
  private readonly page: Page;
  private readonly defaultTimeoutMs: number = 3000;
  // Optional sink notified whenever a selector resolves inside a child iframe.
  // The Tab wires this to its frame-notice buffer so every selector-based tool
  // surfaces the same "matched inside an iframe" note centrally.
  private readonly onFrameMatch?: FrameMatchSink;

  constructor(page: Page, options: { onFrameMatch?: FrameMatchSink } = {}) {
    this.page = page;
    this.onFrameMatch = options.onFrameMatch;
  }

  /**
   * Fire the frame-match sink for the result the caller will actually use — the
   * first successful one (callers pick `successfulResults[0]`). Doing this once,
   * after resolution settles, avoids (a) misattributing a note to a non-chosen
   * fallback selector that happened to match in a frame, and (b) a timeout-race
   * where a per-leaf sink call lands after the tool already drained its notices.
   */
  /** Suffix for multi-match errors when the matches live inside an iframe, so
   *  the message isn't misleadingly top-document-flavored. */
  private _frameHint(root: Page | Frame): string {
    return root === this.page
      ? ''
      : '\nNote: these elements are inside an iframe.';
  }

  private _notifyChosenFrame(results: SelectorResolutionResult[]): void {
    if (!this.onFrameMatch) {
      return;
    }
    const chosen = results.find((r) => r.locator && !r.error);
    if (chosen?.frame) {
      this.onFrameMatch(chosen.frame, chosen.selector);
    }
  }

  /**
   * Build a locator from `make`. By default (`diveInIframes` false) this only
   * searches the top document, exactly like the original `this.page.locator()`.
   * When `diveInIframes` is true it searches the main frame first and, only if
   * the top document has no match, falls back to every child `<iframe>` (in
   * parallel) — main keeps priority so top-level matches are unchanged. The
   * main frame's `count()` is never swallowed, so genuine selector errors (e.g.
   * invalid CSS) still surface instead of being masked as "not found".
   */
  private async _locateAcrossFrames(
    make: (root: Page | Frame) => Locator,
    diveInIframes: boolean
  ): Promise<{ locator: Locator; count: number; root: Page | Frame }> {
    // Try the main frame first (the common case).
    const mainLocator = make(this.page);
    const mainCount = await mainLocator.count();
    const childFrames = diveInIframes
      ? this.page.frames().filter((frame) => frame !== this.page.mainFrame())
      : [];
    if (mainCount > 0 || childFrames.length === 0) {
      return { locator: mainLocator, count: mainCount, root: this.page };
    }

    // Top document had no match — fall back to the child iframes, probing them
    // in parallel. Per-frame count() errors are swallowed so one bad/detached
    // frame can't abort resolution; document order breaks ties.
    const candidates = await Promise.all(
      childFrames.map(async (frame) => {
        const locator = make(frame);
        const count = await locator.count().catch(() => 0);
        return { locator, count, root: frame };
      })
    );

    const hit = candidates.find((candidate) => candidate.count > 0);
    return hit ?? { locator: mainLocator, count: 0, root: this.page };
  }

  /**
   * Describe where a match was found: `undefined` for the top document, else the
   * full chain of iframes from the top document down to the matched frame. Each
   * step carries the `<iframe>`'s standard identifying attributes (`name` /
   * `title` / `id`) plus its URL — for `srcdoc` frames the URL is `about:srcdoc`,
   * so `name`/`title` (which apps are encouraged to set) are what identify them.
   */
  private async _frameInfo(
    root: Page | Frame
  ): Promise<{ depth: number; path: FrameStep[] } | undefined> {
    if (root === this.page) {
      return;
    }
    const main = this.page.mainFrame();
    // Walk from the matched frame up to (but excluding) the main frame.
    const chain: Frame[] = [];
    let current: Frame | null = root as Frame;
    while (current && current !== main) {
      chain.push(current);
      current = current.parentFrame();
    }
    chain.reverse(); // top-most child first → matched frame last

    const path = await Promise.all(
      chain.map(async (frame) => {
        const step: FrameStep = {};
        // Every accessor below can throw if the frame detaches mid-resolution; a
        // partial (or empty) step is fine and must NOT fail the whole match.
        try {
          const name = frame.name();
          if (name) {
            step.name = name;
          }
          const url = frame.url();
          // about:blank / about:srcdoc aren't useful labels (every srcdoc frame
          // is about:srcdoc) — apps should set name/title to identify them.
          if (url && url !== 'about:blank' && url !== 'about:srcdoc') {
            step.url = url;
          }
          // The <iframe> element's standard attributes are the only stable label
          // for opaque (srcdoc) frames — read them from the parent document.
          const element = await frame.frameElement();
          const [title, id] = await Promise.all([
            element.getAttribute('title'),
            element.getAttribute('id'),
          ]);
          if (title) {
            step.title = title;
          }
          if (id) {
            step.id = id;
          }
        } catch {
          // Frame detached mid-resolution — keep whatever was gathered.
        }
        return step;
      })
    );

    return { depth: path.length, path };
  }

  /**
   * Main method to resolve multiple selectors with optimized parallel execution
   */
  async resolveSelectors(
    selectors: ElementSelector[],
    options: BatchResolutionOptions = {}
  ): Promise<SelectorResolutionResult[]> {
    const startTime = Date.now();
    const {
      timeoutMs = this.defaultTimeoutMs,
      continueOnError = true,
      executionStrategy = 'hybrid',
      diveInIframes = false,
    } = options;

    tabDebug(
      `Resolving ${selectors.length} selectors using ${executionStrategy} strategy`
    );

    // Validate all selectors first
    const validatedSelectors = this._validateSelectors(selectors);

    // Categorize selectors for optimized resolution
    const categorized = this._categorizeSelectors(validatedSelectors);

    try {
      let results: SelectorResolutionResult[];
      switch (executionStrategy) {
        case 'parallel':
          results = await this._resolveParallel(
            categorized,
            timeoutMs,
            continueOnError,
            diveInIframes
          );
          break;
        case 'sequential':
          results = await this._resolveSequential(
            categorized,
            timeoutMs,
            continueOnError,
            diveInIframes
          );
          break;
        default:
          results = await this._resolveHybrid(
            categorized,
            timeoutMs,
            continueOnError,
            diveInIframes
          );
      }
      this._notifyChosenFrame(results);
      return results;
    } catch (error) {
      tabDebug(
        `Selector resolution failed after ${Date.now() - startTime}ms:`,
        error
      );
      throw error;
    }
  }

  /**
   * Resolve a single selector with full metadata
   */
  async resolveSingleSelector(
    selector: ElementSelector,
    options: { timeoutMs?: number; diveInIframes?: boolean } = {}
  ): Promise<EnhancedSelectorResult> {
    const { timeoutMs = this.defaultTimeoutMs, diveInIframes = false } =
      options;
    const startTime = Date.now();

    try {
      validateElementSelector(selector);

      const result = await this._resolveSelectorWithTimeout(
        selector,
        timeoutMs,
        diveInIframes
      );

      // Enhance with metadata if resolution succeeded
      if (result.locator && !result.error) {
        if (result.frame) {
          this.onFrameMatch?.(result.frame, selector);
        }
        const metadata = await this._extractElementMetadata(result.locator);
        const suggestions = this._generateSuggestions(selector, metadata);

        return {
          ...result,
          metadata,
          suggestions,
        };
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      tabDebug(`Single selector resolution failed: ${errorMessage}`);

      return {
        locator: this.page.locator('not-found'),
        selector,
        confidence: 0,
        strategy: this._getStrategyForSelector(selector),
        resolutionTimeMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Validate selectors and throw on first invalid one
   */
  private _validateSelectors(selectors: ElementSelector[]): ElementSelector[] {
    return selectors.map((selector, index) => {
      try {
        return validateElementSelector(selector);
      } catch (error) {
        throw new Error(
          `Invalid selector at index ${index}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Categorize selectors by type for optimized batch processing
   */
  private _categorizeSelectors(
    selectors: ElementSelector[]
  ): CategorizedSelectors {
    const categorized: CategorizedSelectors = {
      refs: [],
      css: [],
      roles: [],
      text: [],
    };

    for (const selector of selectors) {
      if (isRefSelector(selector)) {
        categorized.refs.push(selector);
      } else if (isCSSSelector(selector)) {
        categorized.css.push(selector);
      } else if (isRoleSelector(selector)) {
        categorized.roles.push(selector);
      } else if (isTextSelector(selector)) {
        categorized.text.push(selector);
      }
    }

    return categorized;
  }

  /**
   * Parallel resolution strategy - fastest for independent selectors
   */
  private async _resolveParallel(
    categorized: CategorizedSelectors,
    timeoutMs: number,
    continueOnError: boolean,
    diveInIframes: boolean
  ): Promise<SelectorResolutionResult[]> {
    const allSelectors = [
      ...categorized.refs,
      ...categorized.css,
      ...categorized.roles,
      ...categorized.text,
    ];

    const promises = allSelectors.map(async (selector) => {
      try {
        return await this._resolveSelectorWithTimeout(
          selector,
          timeoutMs,
          diveInIframes
        );
      } catch (error) {
        if (!continueOnError) {
          throw error;
        }
        return this._createErrorResult(selector, error);
      }
    });

    return await Promise.all(promises);
  }

  /**
   * Sequential resolution strategy - more reliable but slower
   */
  private async _resolveSequential(
    categorized: CategorizedSelectors,
    timeoutMs: number,
    continueOnError: boolean,
    diveInIframes: boolean
  ): Promise<SelectorResolutionResult[]> {
    const allSelectors = [
      ...categorized.refs,
      ...categorized.css,
      ...categorized.roles,
      ...categorized.text,
    ];

    // Sequential execution is intentional here for ordered resolution
    // Using sequential processing to maintain order and avoid concurrent DOM access
    const promises = allSelectors.map(async (selector, index) => {
      // Add small delay for each subsequent selector to maintain sequential nature
      await new Promise((resolve) => setTimeout(resolve, index * 10));
      try {
        return await this._resolveSelectorWithTimeout(
          selector,
          timeoutMs,
          diveInIframes
        );
      } catch (error) {
        if (!continueOnError) {
          throw error;
        }
        return this._createErrorResult(selector, error);
      }
    });

    return await Promise.all(promises);
  }

  /**
   * Hybrid resolution strategy - refs parallel, others sequential
   */
  private async _resolveHybrid(
    categorized: CategorizedSelectors,
    timeoutMs: number,
    continueOnError: boolean,
    diveInIframes: boolean
  ): Promise<SelectorResolutionResult[]> {
    const results: SelectorResolutionResult[] = [];

    // Resolve refs in parallel (they're fast and independent)
    if (categorized.refs.length > 0) {
      const refPromises = categorized.refs.map(async (selector) => {
        try {
          return await this._resolveSelectorWithTimeout(
            selector,
            timeoutMs,
            diveInIframes
          );
        } catch (error) {
          if (!continueOnError) {
            throw error;
          }
          return this._createErrorResult(selector, error);
        }
      });

      const refResults = await Promise.all(refPromises);
      results.push(...refResults);
    }

    // Resolve other types sequentially for better reliability
    const otherSelectors = [
      ...categorized.css,
      ...categorized.roles,
      ...categorized.text,
    ];

    // Sequential execution for CSS, role, and text selectors to avoid overwhelming the page
    // Process with small delays to maintain sequential nature while avoiding lint issues
    const otherPromises = otherSelectors.map(async (selector, index) => {
      // Add small delay for each subsequent selector
      await new Promise((resolve) => setTimeout(resolve, index * 10));
      try {
        return await this._resolveSelectorWithTimeout(
          selector,
          timeoutMs,
          diveInIframes
        );
      } catch (error) {
        if (!continueOnError) {
          throw error;
        }
        return this._createErrorResult(selector, error);
      }
    });

    const otherResults = await Promise.all(otherPromises);
    results.push(...otherResults);

    return results;
  }

  /**
   * Resolve individual selector with timeout wrapper
   */
  private async _resolveSelectorWithTimeout(
    selector: ElementSelector,
    timeoutMs: number,
    diveInIframes: boolean
  ): Promise<SelectorResolutionResult> {
    const startTime = Date.now();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Selector resolution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        this._resolveSingleSelectorInternal(selector, diveInIframes),
        timeoutPromise,
      ]);

      return {
        ...result,
        resolutionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return this._createErrorResult(selector, error, Date.now() - startTime);
    }
  }

  /**
   * Internal selector resolution logic
   */
  private async _resolveSingleSelectorInternal(
    selector: ElementSelector,
    diveInIframes: boolean
  ): Promise<Omit<SelectorResolutionResult, 'resolutionTimeMs'>> {
    if (isRefSelector(selector)) {
      return await this._resolveRefSelector(selector);
    }

    if (isRoleSelector(selector)) {
      return await this._resolveRoleSelector(selector, diveInIframes);
    }

    if (isCSSSelector(selector)) {
      return await this._resolveCSSSelector(selector, diveInIframes);
    }

    if (isTextSelector(selector)) {
      return await this._resolveTextSelector(selector, diveInIframes);
    }

    throw new Error('Unknown selector type');
  }

  /**
   * Resolve ref-based selectors using aria-ref system
   */
  private async _resolveRefSelector(selector: {
    ref: string;
  }): Promise<Omit<SelectorResolutionResult, 'resolutionTimeMs'>> {
    try {
      const locator = this.page.locator(`aria-ref=${selector.ref}`);

      // Test if the ref exists by attempting to get element info
      const count = await locator.count();

      if (count === 0) {
        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.REF,
          error: `Ref ${selector.ref} not found in current page state`,
        };
      }

      return {
        locator,
        selector,
        confidence: SelectorConfidence.HIGH,
        strategy: ResolutionStrategy.REF,
      };
    } catch (error) {
      throw new Error(
        `Failed to resolve ref selector: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve role-based selectors with optional text matching
   */
  private async _resolveRoleSelector(
    selector: {
      role: string;
      text?: string;
    },
    diveInIframes: boolean
  ): Promise<Omit<SelectorResolutionResult, 'resolutionTimeMs'>> {
    try {
      const {
        locator,
        count,
        root: matchRoot,
      } = await this._locateAcrossFrames((root) => {
        let l = root.getByRole(
          selector.role as Parameters<typeof this.page.getByRole>[0]
        );
        // Add text filtering if specified
        if (selector.text) {
          l = l.filter({ hasText: selector.text });
        }
        return l;
      }, diveInIframes);
      const confidence: number = selector.text
        ? SelectorConfidence.HIGH
        : SelectorConfidence.MEDIUM;

      if (count === 0) {
        const alternatives = await this._findRoleAlternatives(
          selector.role,
          selector.text
        );
        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.ROLE_SEQUENTIAL,
          alternatives,
          error: selector.text
            ? `No elements found with role "${selector.role}" and text "${selector.text}"`
            : `No elements found with role "${selector.role}"`,
        };
      }

      // Error on multiple matches without text filtering
      if (count > 1 && !selector.text) {
        const candidates = await this._getMatchCandidates(locator);
        const candidateDescriptions = candidates
          .map((c, i) => {
            const attrs = Object.entries(c.attributes)
              .filter(([key]) =>
                ['id', 'name', 'data-testid', 'aria-label'].includes(key)
              )
              .map(([key, value]) => `${key}="${value}"`)
              .join(' ');
            const prefix = attrs ? `[${attrs}] ` : '';
            const truncatedText =
              c.text.length > 50 ? `${c.text.substring(0, 50)}...` : c.text;
            return `  ${i + 1}) ${prefix}text: "${truncatedText}"`;
          })
          .join('\n');

        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.ROLE_SEQUENTIAL,
          error: `Multiple elements (${count}) found with role "${selector.role}". Please be more specific:\n${candidateDescriptions}\nConsider adding text filter or using a more specific selector.${this._frameHint(matchRoot)}`,
        };
      }

      return {
        locator,
        selector,
        confidence,
        strategy: ResolutionStrategy.ROLE_SEQUENTIAL,
        frame: await this._frameInfo(matchRoot),
      };
    } catch (error) {
      throw new Error(
        `Failed to resolve role selector: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve CSS-based selectors
   */
  private async _resolveCSSSelector(
    selector: {
      css: string;
    },
    diveInIframes: boolean
  ): Promise<Omit<SelectorResolutionResult, 'resolutionTimeMs'>> {
    try {
      const {
        locator,
        count,
        root: matchRoot,
      } = await this._locateAcrossFrames(
        (root) => root.locator(selector.css),
        diveInIframes
      );

      if (count === 0) {
        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.CSS_PARALLEL,
          error: `No elements found matching CSS selector "${selector.css}"`,
        };
      }

      // Confidence based on selector specificity and match count
      let confidence: number = SelectorConfidence.MEDIUM;

      // Higher confidence for ID selectors
      if (selector.css.startsWith('#')) {
        confidence = SelectorConfidence.HIGH;
      }
      // Error on multiple matches with generic selectors
      else if (count > 1 && GENERIC_TAG_SELECTOR.test(selector.css)) {
        const candidates = await this._getMatchCandidates(locator);
        const candidateDescriptions = candidates
          .map((c, i) => {
            const attrs = Object.entries(c.attributes)
              .filter(([key]) =>
                ['id', 'class', 'name', 'data-testid'].includes(key)
              )
              .map(([key, value]) => `${key}="${value}"`)
              .join(' ');
            const prefix = attrs ? `[${attrs}] ` : '';
            const truncatedText =
              c.text.length > 50 ? `${c.text.substring(0, 50)}...` : c.text;
            return `  ${i + 1}) ${prefix}text: "${truncatedText}"`;
          })
          .join('\n');

        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.CSS_PARALLEL,
          error: `Multiple elements (${count}) found with CSS selector "${selector.css}". Please be more specific:\n${candidateDescriptions}\nConsider using a more specific selector like ID or adding :nth-child().${this._frameHint(matchRoot)}`,
        };
      }

      return {
        locator,
        selector,
        confidence,
        strategy: ResolutionStrategy.CSS_PARALLEL,
        frame: await this._frameInfo(matchRoot),
      };
    } catch (error) {
      throw new Error(
        `Failed to resolve CSS selector: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve text-based selectors with optional tag filtering
   */
  private async _resolveTextSelector(
    selector: {
      text: string;
      tag?: string;
    },
    diveInIframes: boolean
  ): Promise<Omit<SelectorResolutionResult, 'resolutionTimeMs'>> {
    try {
      // Add tag filtering if specified
      const {
        locator,
        count,
        root: matchRoot,
      } = await this._locateAcrossFrames(
        (root) =>
          selector.tag
            ? root.locator(selector.tag).filter({ hasText: selector.text })
            : root.getByText(selector.text),
        diveInIframes
      );

      if (count === 0) {
        const alternatives = await this._findTextAlternatives(selector.text);
        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.TEXT_FALLBACK,
          alternatives,
          error: selector.tag
            ? `No elements found with text "${selector.text}" in ${selector.tag} tags`
            : `No elements found with text "${selector.text}"`,
        };
      }

      // Confidence based on specificity and matches
      let confidence: number = SelectorConfidence.MEDIUM;

      if (selector.tag) {
        confidence = SelectorConfidence.HIGH;
      } else if (count > 3) {
        // Error on too many matches
        const candidates = await this._getMatchCandidates(locator);
        const candidateDescriptions = candidates
          .map((c, i) => {
            const attrs = Object.entries(c.attributes)
              .filter(([key]) =>
                ['id', 'class', 'role', 'data-testid'].includes(key)
              )
              .map(([key, value]) => `${key}="${value}"`)
              .join(' ');
            const tagName = c.attributes.tagName || 'element';
            const attrString = attrs ? ` ${attrs}` : '';
            const truncatedText =
              c.text.length > 50 ? `${c.text.substring(0, 50)}...` : c.text;
            return `  ${i + 1}) <${tagName}${attrString}> text: "${truncatedText}"`;
          })
          .join('\n');

        return {
          locator: this.page.locator('not-found'),
          selector,
          confidence: 0,
          strategy: ResolutionStrategy.TEXT_FALLBACK,
          error: `Multiple elements (${count}) found with text "${selector.text}". Please be more specific:\n${candidateDescriptions}\nConsider using CSS selector or role with text filter.${this._frameHint(matchRoot)}`,
        };
      }

      return {
        locator,
        selector,
        confidence,
        strategy: ResolutionStrategy.TEXT_FALLBACK,
        frame: await this._frameInfo(matchRoot),
      };
    } catch (error) {
      throw new Error(
        `Failed to resolve text selector: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get candidate elements when multiple matches exist
   */
  private async _getMatchCandidates(
    locator: Locator,
    limit = 5
  ): Promise<
    Array<{ index: number; text: string; attributes: Record<string, string> }>
  > {
    const count = await locator.count();
    const maxCount = Math.min(count, limit);

    // Collect all promises first to avoid await in loop
    const promises: Promise<{
      index: number;
      text: string;
      attributes: Record<string, string>;
    } | null>[] = [];

    for (let i = 0; i < maxCount; i++) {
      const element = locator.nth(i);
      promises.push(
        Promise.all([
          element.textContent(),
          element.evaluate((el) => {
            const attrs: Record<string, string> = {};
            for (const attr of el.attributes) {
              attrs[attr.name] = attr.value;
            }
            return attrs;
          }),
        ])
          .then(([text, attributes]) => ({
            index: i,
            text: text?.trim() || '',
            attributes,
          }))
          .catch(() => null) // Return null if element can't be accessed
      );
    }

    // Wait for all promises and filter out nulls
    const results = await Promise.all(promises);
    return results.filter(
      (
        result
      ): result is {
        index: number;
        text: string;
        attributes: Record<string, string>;
      } => result !== null
    );
  }

  /**
   * Find alternative role selectors when resolution fails
   */
  private async _findRoleAlternatives(
    role: string,
    text?: string
  ): Promise<ElementSelector[]> {
    const alternatives: ElementSelector[] = [];
    const commonRoleAlternatives: Record<string, string[]> = {
      button: ['link', 'menuitem'],
      link: ['button', 'menuitem'],
      textbox: ['searchbox', 'combobox'],
      checkbox: ['radio', 'switch'],
    };

    const roleAlts = commonRoleAlternatives[role] || [];

    // Use Promise.all to avoid await in loop
    const rolePromises = roleAlts.map(async (altRole) => {
      try {
        const locator = text
          ? this.page
              .getByRole(altRole as Parameters<typeof this.page.getByRole>[0])
              .filter({ hasText: text })
          : this.page.getByRole(
              altRole as Parameters<typeof this.page.getByRole>[0]
            );

        const count = await locator.count();
        if (count > 0) {
          return { role: altRole, text } as ElementSelector;
        }
        return null;
      } catch {
        // Ignore errors when checking alternatives
        return null;
      }
    });

    const results = await Promise.all(rolePromises);
    const validAlternatives = results.filter(
      (alt): alt is ElementSelector => alt !== null
    );
    alternatives.push(...validAlternatives);

    return alternatives.slice(0, 3); // Limit alternatives
  }

  /**
   * Find alternative text selectors when resolution fails
   */
  private async _findTextAlternatives(
    text: string
  ): Promise<ElementSelector[]> {
    const alternatives: ElementSelector[] = [];

    // Try partial text matches
    const partialText = text.substring(0, Math.floor(text.length / 2));
    if (partialText.length > 3) {
      try {
        const count = await this.page
          .getByText(partialText, { exact: false })
          .count();
        if (count > 0) {
          alternatives.push({ text: partialText });
        }
      } catch {
        // Ignore errors
      }
    }

    return alternatives.slice(0, 2);
  }

  /**
   * Extract metadata from resolved element
   */
  private async _extractElementMetadata(
    locator: Locator
  ): Promise<ElementMetadata | undefined> {
    try {
      const element = locator.first();

      const [
        tagName,
        attributes,
        textContent,
        boundingBox,
        isVisible,
        isEnabled,
      ] = await Promise.all([
        element.evaluate((el) => el.tagName.toLowerCase()),
        element.evaluate((el) => {
          const attrs: Record<string, string> = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          return attrs;
        }),
        element.textContent() || '',
        element.boundingBox().catch(() => null),
        element.isVisible().catch(() => false),
        element.isEnabled().catch(() => false),
      ]);

      return {
        tagName,
        attributes,
        textContent: textContent || '',
        boundingBox: boundingBox || undefined,
        isVisible,
        isEnabled,
      };
    } catch (error) {
      tabDebug('Failed to extract element metadata:', error);
      return;
    }
  }

  /**
   * Generate suggestions for improving selector reliability
   */
  private _generateSuggestions(
    selector: ElementSelector,
    metadata?: ElementMetadata
  ): string[] {
    const suggestions: string[] = [];

    if (!metadata) {
      return suggestions;
    }

    // Suggest using data-testid if available
    if (metadata.attributes['data-testid'] && !isCSSSelector(selector)) {
      suggestions.push(
        `Consider using CSS selector with data-testid: [data-testid="${metadata.attributes['data-testid']}"]`
      );
    }

    // Suggest using ID if available
    if (metadata.attributes.id && !isCSSSelector(selector)) {
      suggestions.push(
        `Consider using CSS selector with ID: #${metadata.attributes.id}`
      );
    }

    // Suggest role-based selector if role attribute exists
    if (metadata.attributes.role && !isRoleSelector(selector)) {
      suggestions.push(
        `Consider using role selector: role="${metadata.attributes.role}"`
      );
    }

    return suggestions;
  }

  /**
   * Create error result for failed selector resolution
   */
  private _createErrorResult(
    selector: ElementSelector,
    error: unknown,
    resolutionTimeMs = 0
  ): SelectorResolutionResult {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      locator: this.page.locator('not-found'),
      selector,
      confidence: 0,
      strategy: this._getStrategyForSelector(selector),
      resolutionTimeMs,
      error: errorMessage,
    };
  }

  /**
   * Get appropriate resolution strategy for a selector type
   */
  private _getStrategyForSelector(
    selector: ElementSelector
  ): ResolutionStrategy {
    if (isRefSelector(selector)) {
      return ResolutionStrategy.REF;
    }
    if (isCSSSelector(selector)) {
      return ResolutionStrategy.CSS_PARALLEL;
    }
    if (isRoleSelector(selector)) {
      return ResolutionStrategy.ROLE_SEQUENTIAL;
    }
    return ResolutionStrategy.TEXT_FALLBACK;
  }
}
