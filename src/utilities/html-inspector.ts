import type { Locator, Page } from 'playwright';
import {
  type FrameMatchSink,
  SelectorResolver,
} from '../services/selector-resolver.js';
import {
  type ElementInspectionMetadata,
  type ElementInspectionResult,
  generateHTMLInspectionSuggestions,
  HTMLInspectionConstants,
  type HTMLInspectionOptions,
  type HTMLInspectionResult,
  HTMLInspectionUtils,
  validateHTMLInspectionOptions,
} from '../types/html-inspection.js';
import type {
  ElementSelector,
  SelectorResolutionResult,
} from '../types/selectors.js';
import { tabDebug } from '../utils/log.js';

/**
 * CSS Selector suggestion with confidence scoring
 */
interface CSSSelectorSuggestion {
  selector: string;
  confidence: number;
  element: string;
  description: string;
}

/**
 * HTMLInspector provides intelligent HTML content extraction and analysis
 * Optimized for LLM consumption with size limits and depth controls
 */
export class HTMLInspector {
  private readonly selectorResolver: SelectorResolver;
  private readonly defaultOptions: Partial<HTMLInspectionOptions> = {
    depth: HTMLInspectionConstants.DEFAULT_DEPTH,
    maxSize: HTMLInspectionConstants.DEFAULT_MAX_SIZE,
    format: 'html',
    includeAttributes: true,
    includeStyles: false,
    preserveWhitespace: false,
  };

  constructor(page: Page, options: { onFrameMatch?: FrameMatchSink } = {}) {
    this.selectorResolver = new SelectorResolver(page, options);
  }

  /**
   * Process a single selector result and extract HTML
   */
  private async _processSelectorResult(
    index: number,
    selectorResult: SelectorResolutionResult,
    selector: ElementSelector,
    options: HTMLInspectionOptions,
    remainingSize: number
  ): Promise<{ element?: ElementInspectionResult; error?: boolean }> {
    if (selectorResult.error || selectorResult.confidence === 0) {
      tabDebug(`Selector ${index} failed to resolve: ${selectorResult.error}`);
      return { error: true };
    }

    try {
      const elementResult = await this._extractElementHTML(
        selectorResult.locator,
        selector,
        options,
        remainingSize
      );
      return { element: elementResult ?? undefined };
    } catch (error) {
      tabDebug(`Failed to extract HTML for selector ${index}:`, error);
      return { error: true };
    }
  }

  /**
   * Process all selector results sequentially
   */
  private async _processAllSelectors(
    selectorResults: SelectorResolutionResult[],
    selectors: ElementSelector[],
    options: HTMLInspectionOptions
  ): Promise<{
    elements: Record<number, ElementInspectionResult>;
    stats: {
      elementsFound: number;
      selectorsNotFound: number;
      totalDepth: number;
      totalSizeBytes: number;
      truncated: boolean;
    };
  }> {
    const elements: Record<number, ElementInspectionResult> = {};
    let totalSizeBytes = 0;
    let truncated = false;
    let elementsFound = 0;
    let selectorsNotFound = 0;
    let totalDepth = 0;
    const maxSize = options.maxSize ?? 50_000;

    // Process all selectors in parallel then filter by size
    const allResults = await Promise.all(
      selectorResults.map((selectorResult, i) =>
        this._processSelectorResult(
          i,
          selectorResult,
          selectors[i],
          options,
          maxSize
        ).then((result) => ({ index: i, result }))
      )
    );

    // Process results sequentially to respect size limits
    for (const { index, result } of allResults) {
      if (result.error) {
        selectorsNotFound++;
        continue;
      }

      if (
        result.element &&
        totalSizeBytes + result.element.metadata.sizeBytes <= maxSize
      ) {
        elements[index] = result.element;
        totalSizeBytes += result.element.metadata.sizeBytes;
        elementsFound++;
        totalDepth += this._calculateElementDepth(result.element);

        if (result.element.html.includes('<!-- TRUNCATED -->')) {
          truncated = true;
        }
      } else if (result.element) {
        truncated = true;
        tabDebug('Size limit reached, skipping remaining elements');
        break;
      }
    }

    return {
      elements,
      stats: {
        elementsFound,
        selectorsNotFound,
        totalDepth,
        totalSizeBytes,
        truncated,
      },
    };
  }

  /**
   * Main HTML extraction method with configurable options
   */
  async extractHTML(
    options: HTMLInspectionOptions
  ): Promise<HTMLInspectionResult> {
    const startTime = Date.now();

    // Validate and merge options
    const validatedOptions = validateHTMLInspectionOptions(options);
    const mergedOptions = { ...this.defaultOptions, ...validatedOptions };

    tabDebug(
      `Starting HTML extraction for ${mergedOptions.selectors.length} selectors`
    );

    try {
      // Resolve selectors first
      const selectorStartTime = Date.now();
      const selectorResults = await this.selectorResolver.resolveSelectors(
        mergedOptions.selectors,
        { continueOnError: true, diveInIframes: mergedOptions.diveInIframes }
      );
      const selectorResolutionMs = Date.now() - selectorStartTime;

      // Extract HTML for each resolved selector
      const extractionStartTime = Date.now();
      const { elements, stats } = await this._processAllSelectors(
        selectorResults,
        mergedOptions.selectors,
        mergedOptions
      );

      const extractionMs = Date.now() - extractionStartTime;
      const totalMs = Date.now() - startTime;

      const result: HTMLInspectionResult = {
        elements,
        totalSizeBytes: stats.totalSizeBytes,
        truncated: stats.truncated,
        timing: {
          totalMs,
          selectorResolutionMs,
          extractionMs,
        },
        stats: {
          elementsFound: stats.elementsFound,
          selectorsNotFound: stats.selectorsNotFound,
          averageDepth:
            stats.elementsFound > 0
              ? stats.totalDepth / stats.elementsFound
              : 0,
        },
      };

      // Generate suggestions
      result.suggestions = generateHTMLInspectionSuggestions(result);

      // Add performance suggestions
      if (result.timing.totalMs > 5000) {
        result.suggestions?.push(
          'Extraction took longer than expected. Consider reducing scope or depth.'
        );
      }
      if (
        result.totalSizeBytes > HTMLInspectionConstants.SIZE_THRESHOLDS.WARNING
      ) {
        result.suggestions?.push(
          'Large content detected. Consider reducing depth or using more specific selectors.'
        );
      }

      tabDebug(
        `HTML extraction completed in ${result.timing.totalMs}ms: ${result.stats.elementsFound} elements, ${result.totalSizeBytes} bytes`
      );
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      tabDebug('HTML extraction failed:', errorMessage);

      return {
        elements: {},
        totalSizeBytes: 0,
        truncated: false,
        suggestions: [`Extraction failed: ${errorMessage}`],
        timing: {
          totalMs: Date.now() - startTime,
          selectorResolutionMs: 0,
          extractionMs: 0,
        },
        stats: {
          elementsFound: 0,
          selectorsNotFound: options.selectors.length,
          averageDepth: 0,
        },
      };
    }
  }

  /**
   * Suggest CSS selectors based on extracted HTML structure
   */
  suggestCSSSelectors(
    inspectionResult: HTMLInspectionResult
  ): CSSSelectorSuggestion[] {
    const suggestions: CSSSelectorSuggestion[] = [];

    for (const elementResult of Object.values(inspectionResult.elements)) {
      const elementSuggestions =
        this._generateSelectorsForElement(elementResult);
      suggestions.push(...elementSuggestions);
    }

    // Sort by confidence and limit results
    return [...suggestions]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 20);
  }

  /**
   * Optimize HTML content for LLM consumption
   */
  async optimizeForLLM(
    inspectionResult: HTMLInspectionResult
  ): Promise<HTMLInspectionResult> {
    const optimizedElements: Record<number, ElementInspectionResult> = {};
    let totalSizeBytes = 0;

    // Process all elements in parallel for better performance
    const entries = Object.entries(inspectionResult.elements);
    const optimizedResults = await Promise.all(
      entries.map(async ([index, element]) => ({
        index: Number.parseInt(index, 10),
        element: await this._optimizeElementForLLM(element),
      }))
    );

    for (const { index, element } of optimizedResults) {
      optimizedElements[index] = element;
      totalSizeBytes += element.metadata.sizeBytes;
    }

    return {
      ...inspectionResult,
      elements: optimizedElements,
      totalSizeBytes,
    };
  }

  /**
   * Extract HTML content for a single element with depth control
   */
  private async _extractElementHTML(
    locator: Locator,
    selector: ElementSelector,
    options: HTMLInspectionOptions,
    remainingSizeBytes: number
  ): Promise<ElementInspectionResult | null> {
    try {
      // Get element count and handle multiple matches
      const count = await locator.count();
      if (count === 0) {
        return null;
      }

      // Use first element if multiple matches
      const element = locator.first();

      // Extract basic metadata
      const metadata = await this._extractElementMetadata(element);

      // Extract HTML content based on format
      let html: string;
      switch (options.format) {
        case 'text':
          html = await this._extractTextContent(element);
          break;
        case 'aria':
          html = await this._extractAriaContent(element);
          break;
        default:
          html = await this._extractHTMLContent(element, options);
          break;
      }

      // Apply size limits and truncation
      const sizeBytes = HTMLInspectionUtils.calculateHtmlSize(html);
      if (sizeBytes > remainingSizeBytes && remainingSizeBytes > 0) {
        const truncationResult = HTMLInspectionUtils.truncateHtml(
          html,
          remainingSizeBytes
        );
        html = truncationResult.html;
        metadata.sizeBytes = HTMLInspectionUtils.calculateHtmlSize(html);
      } else {
        metadata.sizeBytes = sizeBytes;
      }

      const result: ElementInspectionResult = {
        html,
        metadata,
        matchedSelector: selector,
      };

      // Extract children if depth allows
      if (options.depth && options.depth > 1) {
        result.children = await this._extractChildElements(
          element,
          options,
          remainingSizeBytes - metadata.sizeBytes
        );
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        html: '',
        metadata: {
          tagName: 'unknown',
          attributes: {},
          textContent: '',
          sizeBytes: 0,
        },
        matchedSelector: selector,
        error: errorMessage,
      };
    }
  }

  /**
   * Extract metadata from an element
   */
  private async _extractElementMetadata(
    locator: Locator
  ): Promise<ElementInspectionMetadata> {
    try {
      const [
        tagName,
        attributes,
        textContent,
        boundingBox,
        computedStyles,
        ariaRole,
        ariaProperties,
      ] = await Promise.all([
        locator.evaluate((el) => el.tagName.toLowerCase()),
        locator.evaluate((el) => {
          const attrs: Record<string, string> = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          return attrs;
        }),
        locator.textContent() || '',
        locator.boundingBox().catch(() => null),
        this._extractComputedStyles(locator),
        locator.evaluate((el) => el.getAttribute('role')),
        this._extractAriaProperties(locator),
      ]);

      return {
        tagName,
        attributes,
        textContent: textContent || '',
        sizeBytes: 0, // Will be calculated after HTML extraction
        boundingBox: boundingBox || undefined,
        computedStyles,
        ariaRole: ariaRole || undefined,
        ariaProperties,
      };
    } catch (error) {
      tabDebug('Failed to extract element metadata:', error);
      return {
        tagName: 'unknown',
        attributes: {},
        textContent: '',
        sizeBytes: 0,
      };
    }
  }

  /**
   * Extract HTML content with filtering and optimization
   */
  private async _extractHTMLContent(
    locator: Locator,
    options: HTMLInspectionOptions
  ): Promise<string> {
    return await locator.evaluate((el, opts) => {
      // Helper function to remove excluded elements
      const removeExcludedElements = (element: Element, selector?: string) => {
        if (!selector) {
          return;
        }
        const excluded = element.querySelectorAll(selector);
        for (const elem of excluded) {
          elem.remove();
        }
      };

      // Helper function to clean attributes
      const cleanAttributes = (element: Element) => {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_ELEMENT,
          null
        );
        const elements: Element[] = [];
        let node = walker.nextNode();
        while (node) {
          elements.push(node as Element);
          node = walker.nextNode();
        }

        const keepAttrs = [
          'id',
          'class',
          'role',
          'data-testid',
          'href',
          'src',
          'alt',
          'title',
        ];
        for (const elem of elements) {
          const toRemove = Array.from(elem.attributes)
            .filter((attr) => !keepAttrs.includes(attr.name))
            .map((attr) => attr.name);
          for (const name of toRemove) {
            elem.removeAttribute(name);
          }
        }
      };

      // Helper function to normalize whitespace
      const normalizeWhitespace = (element: Element) => {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
          null
        );
        const textNodes: Text[] = [];
        let node = walker.nextNode();
        while (node) {
          textNodes.push(node as Text);
          node = walker.nextNode();
        }
        for (const textNode of textNodes) {
          textNode.nodeValue = (textNode.nodeValue || '')
            .replace(/\s+/g, ' ')
            .trim();
        }
      };
      // Clone element to avoid modifying original
      const clone = el.cloneNode(true) as Element;

      // Remove excluded elements
      removeExcludedElements(clone, opts.excludeSelector);

      // Remove scripts and styles by default
      removeExcludedElements(clone, 'script, style');

      // Clean up attributes if not preserving all
      if (!opts.includeAttributes) {
        cleanAttributes(clone);
      }

      // Handle whitespace
      if (!opts.preserveWhitespace) {
        normalizeWhitespace(clone);
      }

      return clone.outerHTML;
    }, options);
  }

  /**
   * Extract text content only
   */
  private async _extractTextContent(locator: Locator): Promise<string> {
    const textContent = await locator.textContent();
    return textContent || '';
  }

  /**
   * Extract ARIA-focused content
   */
  private async _extractAriaContent(locator: Locator): Promise<string> {
    return await locator.evaluate((el) => {
      const role = el.getAttribute('role') || el.tagName.toLowerCase();
      const label =
        el.getAttribute('aria-label') || el.textContent?.trim() || '';

      return `${role}: ${label}`;
    });
  }

  /**
   * Extract child elements recursively with depth control
   */
  private async _processBatch(
    childElements: Locator[],
    tagNames: string[],
    startIdx: number,
    endIdx: number,
    childOptions: HTMLInspectionOptions,
    maxBytes: number
  ): Promise<ElementInspectionResult[]> {
    const promises: Promise<ElementInspectionResult | undefined>[] = [];

    for (let i = startIdx; i < endIdx && maxBytes > 0; i++) {
      const childSelector: ElementSelector = { css: tagNames[i] };
      promises.push(
        this._extractElementHTML(
          childElements[i],
          childSelector,
          childOptions,
          maxBytes
        ).then((result) => result ?? undefined)
      );
    }

    const results = await Promise.all(promises);
    return results.filter((r): r is ElementInspectionResult => r !== undefined);
  }

  private async _extractChildElements(
    parentLocator: Locator,
    options: HTMLInspectionOptions,
    remainingSizeBytes: number
  ): Promise<ElementInspectionResult[]> {
    try {
      const children: ElementInspectionResult[] = [];
      const childOptions = { ...options, depth: (options.depth || 1) - 1 };

      // Get direct children
      const childElements = await parentLocator.locator('> *').all();
      if (childElements.length === 0) {
        return children;
      }

      // Get all tag names first
      const tagNames = await Promise.all(
        childElements.map((child) =>
          child.evaluate((el) => el.tagName.toLowerCase())
        )
      );

      // Process all children at once to avoid await in loop
      const allResults = await this._processBatch(
        childElements,
        tagNames,
        0,
        childElements.length,
        childOptions,
        remainingSizeBytes
      );

      // Add results respecting size limit
      let currentRemainingBytes = remainingSizeBytes;
      for (const childResult of allResults) {
        if (currentRemainingBytes <= 0) {
          break;
        }
        if (childResult.metadata.sizeBytes <= currentRemainingBytes) {
          children.push(childResult);
          currentRemainingBytes -= childResult.metadata.sizeBytes;
        }
      }

      return children;
    } catch (error) {
      tabDebug('Failed to extract child elements:', error);
      return [];
    }
  }

  /**
   * Calculate element depth recursively
   */
  private _calculateElementDepth(element: ElementInspectionResult): number {
    if (!element.children || element.children.length === 0) {
      return 1;
    }

    const maxChildDepth = Math.max(
      ...element.children.map((child) => this._calculateElementDepth(child))
    );
    return 1 + maxChildDepth;
  }

  /**
   * Generate CSS selector suggestions for an element
   */
  private _generateSelectorsForElement(
    element: ElementInspectionResult
  ): CSSSelectorSuggestion[] {
    const suggestions: CSSSelectorSuggestion[] = [];
    const { tagName, attributes } = element.metadata;

    // ID-based selectors (highest confidence)
    if (attributes.id) {
      suggestions.push({
        selector: `#${attributes.id}`,
        confidence: 0.95,
        element: `${tagName}#${attributes.id}`,
        description: 'Unique ID selector (most reliable)',
      });
    }

    // Data-testid selectors (high confidence)
    if (attributes['data-testid']) {
      suggestions.push({
        selector: `[data-testid="${attributes['data-testid']}"]`,
        confidence: 0.9,
        element: `${tagName}[data-testid="${attributes['data-testid']}"]`,
        description: 'Test ID selector (very reliable)',
      });
    }

    // Class-based selectors (medium confidence)
    if (attributes.class) {
      const classes = attributes.class.split(' ').filter(Boolean);
      for (const className of classes) {
        suggestions.push({
          selector: `.${className}`,
          confidence: 0.7,
          element: `${tagName}.${className}`,
          description: 'Class selector (moderate reliability)',
        });
      }
    }

    // Role-based selectors
    if (attributes.role) {
      suggestions.push({
        selector: `[role="${attributes.role}"]`,
        confidence: 0.8,
        element: `${tagName}[role="${attributes.role}"]`,
        description: 'ARIA role selector (good for accessibility)',
      });
    }

    // Tag + attribute combinations
    for (const [attrName, attrValue] of Object.entries(attributes)) {
      if (
        !['id', 'class', 'role', 'data-testid'].includes(attrName) &&
        attrValue
      ) {
        suggestions.push({
          selector: `${tagName}[${attrName}="${attrValue}"]`,
          confidence: 0.6,
          element: `${tagName}[${attrName}="${attrValue}"]`,
          description: `Attribute selector (${attrName})`,
        });
      }
    }

    return suggestions;
  }

  /**
   * Optimize element content for LLM consumption
   */
  private async _optimizeElementForLLM(
    element: ElementInspectionResult
  ): Promise<ElementInspectionResult> {
    // Remove unnecessary attributes, clean whitespace, etc.
    let optimizedHtml = element.html;

    // Remove common noise attributes
    const noiseAttributes = ['style', 'onclick', 'onload', 'onchange'];
    for (const attr of noiseAttributes) {
      optimizedHtml = optimizedHtml.replace(
        new RegExp(`\\s+${attr}="[^"]*"`, 'g'),
        ''
      );
    }

    // Normalize whitespace
    optimizedHtml = optimizedHtml.replace(/\s+/g, ' ').trim();

    // Remove empty elements
    optimizedHtml = optimizedHtml.replace(/<(\w+)[^>]*>\s*<\/\1>/g, '');

    const optimizedElement = {
      ...element,
      html: optimizedHtml,
      metadata: {
        ...element.metadata,
        sizeBytes: HTMLInspectionUtils.calculateHtmlSize(optimizedHtml),
      },
    };

    // Recursively optimize children
    if (element.children) {
      optimizedElement.children = await Promise.all(
        element.children.map((child) => this._optimizeElementForLLM(child))
      );
    }

    return optimizedElement;
  }

  /**
   * Extract computed styles if requested
   */
  private async _extractComputedStyles(
    locator: Locator
  ): Promise<Record<string, string> | undefined> {
    try {
      return await locator.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        const styles: Record<string, string> = {};

        // Extract commonly useful style properties
        const importantProps = [
          'display',
          'visibility',
          'position',
          'width',
          'height',
          'color',
          'background-color',
          'font-size',
          'font-weight',
        ];

        for (const prop of importantProps) {
          styles[prop] = computed.getPropertyValue(prop);
        }

        return styles;
      });
    } catch {
      return;
    }
  }

  /**
   * Extract ARIA properties
   */
  private async _extractAriaProperties(
    locator: Locator
  ): Promise<Record<string, string> | undefined> {
    try {
      return await locator.evaluate((el) => {
        const ariaProps: Record<string, string> = {};

        // Extract common ARIA properties
        const commonAriaProps = [
          'aria-label',
          'aria-describedby',
          'aria-hidden',
          'aria-expanded',
          'aria-selected',
          'aria-checked',
          'aria-disabled',
          'aria-required',
        ];

        for (const prop of commonAriaProps) {
          const value = el.getAttribute(prop);
          if (value) {
            ariaProps[prop] = value;
          }
        }

        return Object.keys(ariaProps).length > 0 ? ariaProps : undefined;
      });
    } catch {
      return;
    }
  }
}
