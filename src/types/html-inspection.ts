import { z } from 'zod';
import type { ElementSelector } from './selectors.js';
import { diveInIframesSchema, elementSelectorSchema } from './selectors.js';

/**
 * HTML Inspection system types for detailed HTML structure retrieval
 */

/**
 * Output format options for HTML inspection
 */
export type HTMLInspectionFormat = 'html' | 'aria' | 'text';

/**
 * HTML inspection parameters for controlling extraction behavior
 */
export interface HTMLInspectionOptions {
  /** Element selectors to define inspection scope */
  selectors: ElementSelector[];
  /** Maximum hierarchy depth to extract (default: 2) */
  depth?: number;
  /** Whether to include computed CSS styles */
  includeStyles?: boolean;
  /** Maximum total size in bytes (default: 50KB) */
  maxSize?: number;
  /** Output format for extracted HTML */
  format?: HTMLInspectionFormat;
  /** Whether to include element attributes */
  includeAttributes?: boolean;
  /** Whether to preserve whitespace in text content */
  preserveWhitespace?: boolean;
  /** CSS selector to filter out unwanted elements */
  excludeSelector?: string;
  /** When true, resolve selectors across child iframes (main frame first). */
  diveInIframes?: boolean;
}

/**
 * Zod schema for HTML inspection options validation
 */
export const htmlInspectionOptionsSchema = z.object({
  selectors: z
    .array(elementSelectorSchema)
    .min(1)
    .describe('Array of element selectors to inspect'),
  depth: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .default(2)
    .describe('Maximum hierarchy depth to extract'),
  includeStyles: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include computed CSS styles'),
  maxSize: z
    .number()
    .min(1024)
    .max(500_000)
    .optional()
    .default(50_000)
    .describe('Maximum size in bytes (1KB-500KB)'),
  format: z
    .enum(['html', 'aria', 'text'])
    .optional()
    .default('html')
    .describe('Output format'),
  includeAttributes: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include element attributes'),
  preserveWhitespace: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preserve whitespace in content'),
  excludeSelector: z
    .string()
    .optional()
    .describe('CSS selector to exclude elements'),
  diveInIframes: diveInIframesSchema,
});

/**
 * Metadata for individual HTML elements
 */
export interface ElementInspectionMetadata {
  /** HTML tag name */
  tagName: string;
  /** Element attributes as key-value pairs */
  attributes: Record<string, string>;
  /** Text content of the element */
  textContent: string;
  /** Size of this element's HTML in bytes */
  sizeBytes: number;
  /** Element's bounding box if available */
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Computed styles if requested */
  computedStyles?: Record<string, string>;
  /** Element's role in accessibility tree */
  ariaRole?: string;
  /** Accessibility properties */
  ariaProperties?: Record<string, string>;
}

/**
 * Individual element inspection result
 */
export interface ElementInspectionResult {
  /** Extracted HTML content */
  html: string;
  /** Element metadata */
  metadata: ElementInspectionMetadata;
  /** Child elements if depth > 0 */
  children?: ElementInspectionResult[];
  /** Error message if extraction failed */
  error?: string;
  /** Original selector that matched this element */
  matchedSelector: ElementSelector;
}

/**
 * Complete HTML inspection result
 */
export interface HTMLInspectionResult {
  /** Map of selector index to element results */
  elements: Record<number, ElementInspectionResult>;
  /** Total size of extracted content in bytes */
  totalSizeBytes: number;
  /** Whether content was truncated due to size limits */
  truncated: boolean;
  /** Suggestions for better inspection if issues occurred */
  suggestions?: string[];
  /** Timing information */
  timing: {
    /** Total inspection time in milliseconds */
    totalMs: number;
    /** Time spent resolving selectors */
    selectorResolutionMs: number;
    /** Time spent extracting HTML */
    extractionMs: number;
  };
  /** Statistics about the inspection */
  stats: {
    /** Number of elements successfully inspected */
    elementsFound: number;
    /** Number of selectors that failed to match */
    selectorsNotFound: number;
    /** Average depth of extracted elements */
    averageDepth: number;
  };
}

/**
 * Options for controlling HTML extraction behavior
 */
export interface HTMLExtractionOptions {
  /** Maximum depth to traverse */
  maxDepth: number;
  /** Whether to include invisible elements */
  includeHidden?: boolean;
  /** Whether to include script and style tags */
  includeScripts?: boolean;
  /** Custom element filter function */
  elementFilter?: (element: Element) => boolean;
  /** Maximum number of child elements per parent */
  maxChildren?: number;
}

/**
 * Style collection options for CSS inspection
 */
export interface StyleCollectionOptions {
  /** Whether to include inherited styles */
  includeInherited?: boolean;
  /** Specific CSS properties to collect */
  properties?: string[];
  /** Whether to compute final values */
  computedOnly?: boolean;
}

/**
 * Size limitation configuration
 */
export interface SizeLimitConfig {
  /** Maximum total size in bytes */
  maxTotalBytes: number;
  /** Maximum size per element in bytes */
  maxElementBytes?: number;
  /** Strategy when size limit is exceeded */
  exceedStrategy: 'truncate' | 'skip' | 'compress';
  /** Priority elements that should not be truncated */
  prioritySelectors?: ElementSelector[];
}

/**
 * HTML inspection error types
 */
export const HTMLInspectionError = {
  SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND',
  SIZE_LIMIT_EXCEEDED: 'SIZE_LIMIT_EXCEEDED',
  EXTRACTION_TIMEOUT: 'EXTRACTION_TIMEOUT',
  INVALID_SELECTOR: 'INVALID_SELECTOR',
  DOM_ACCESS_ERROR: 'DOM_ACCESS_ERROR',
} as const;

export type HTMLInspectionError =
  (typeof HTMLInspectionError)[keyof typeof HTMLInspectionError];

/**
 * Detailed error information for HTML inspection failures
 */
export interface HTMLInspectionErrorDetails {
  type: HTMLInspectionError;
  message: string;
  selector?: ElementSelector;
  selectorIndex?: number;
  additionalInfo?: Record<string, unknown>;
}

/**
 * Progress callback interface for long-running inspections
 */
export interface HTMLInspectionProgress {
  /** Current step being executed */
  currentStep: 'resolving' | 'extracting' | 'processing';
  /** Number of selectors processed so far */
  processedSelectors: number;
  /** Total number of selectors */
  totalSelectors: number;
  /** Current size of extracted content */
  currentSize: number;
  /** Maximum allowed size */
  maxSize: number;
}

/**
 * Calculate approximate size of HTML content
 */
export function calculateHtmlSize(html: string): number {
  return new TextEncoder().encode(html).length;
}

/**
 * Truncate HTML content while preserving structure
 */
export function truncateHtml(
  html: string,
  maxSize: number
): { html: string; truncated: boolean } {
  if (calculateHtmlSize(html) <= maxSize) {
    return { html, truncated: false };
  }

  const truncated = html.substring(0, maxSize - 100); // Leave room for closing tags
  const lastTag = truncated.lastIndexOf('<');
  const safeHtml =
    lastTag > truncated.lastIndexOf('>')
      ? truncated.substring(0, lastTag)
      : truncated;

  return { html: `${safeHtml}<!-- TRUNCATED -->`, truncated: true };
}

/**
 * Validate inspection options
 */
export function validateHTMLInspectionOptions(
  options: unknown
): HTMLInspectionOptions {
  return htmlInspectionOptionsSchema.parse(options);
}

/**
 * Generate suggestions for better inspection results
 */
export function generateHTMLInspectionSuggestions(
  result: HTMLInspectionResult
): string[] {
  const suggestions: string[] = [];

  if (result.truncated) {
    suggestions.push(
      'Content was truncated. Consider reducing depth or using more specific selectors.'
    );
  }

  if (result.stats.selectorsNotFound > 0) {
    suggestions.push(
      'Some selectors did not match elements. Try using more specific or alternative selectors.'
    );
  }

  if (result.timing.totalMs > 5000) {
    suggestions.push(
      'Inspection took longer than expected. Consider reducing scope or depth.'
    );
  }

  if (result.stats.averageDepth > 5) {
    suggestions.push(
      'Deep element extraction detected. Consider limiting depth for better performance.'
    );
  }

  return suggestions;
}

/**
 * Utility functions grouped together for convenience
 */
export const HTMLInspectionUtils = {
  calculateHtmlSize,
  truncateHtml,
  validateOptions: validateHTMLInspectionOptions,
  generateSuggestions: generateHTMLInspectionSuggestions,
} as const;

/**
 * Constants for HTML inspection
 */
export const HTMLInspectionConstants = {
  /** Default maximum size in bytes (50KB) */
  DEFAULT_MAX_SIZE: 50_000,

  /** Default extraction depth */
  DEFAULT_DEPTH: 2,

  /** Maximum allowed depth */
  MAX_DEPTH: 10,

  /** Timeout for inspection operations in milliseconds */
  DEFAULT_TIMEOUT_MS: 10_000,

  /** Size thresholds for different warning levels */
  SIZE_THRESHOLDS: {
    WARNING: 30_000, // 30KB
    CRITICAL: 45_000, // 45KB
  },

  /** Common ARIA properties to extract */
  COMMON_ARIA_PROPERTIES: [
    'aria-label',
    'aria-describedby',
    'aria-hidden',
    'aria-expanded',
    'aria-selected',
    'aria-checked',
    'aria-disabled',
    'aria-required',
  ],
} as const;

// All types are already exported as interfaces above, no need for re-export
