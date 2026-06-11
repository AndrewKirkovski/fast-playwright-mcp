import type { Locator } from 'playwright';
import { z } from 'zod';

/**
 * Core selector types for the unified selector system
 */

/**
 * Reference-based selector using existing ref system
 */
export interface RefSelector {
  ref: string;
}

/**
 * ARIA role-based selector with optional text matching
 */
export interface RoleSelector {
  role: string;
  text?: string;
}

/**
 * CSS selector-based element selection
 */
export interface CSSSelector {
  css: string;
}

/**
 * Text-based selector with optional tag filtering
 */
export interface TextSelector {
  text: string;
  tag?: string;
}

/**
 * Unified element selector type supporting multiple selection strategies
 * @description Union type that enables flexible element selection through different methods
 */
export type ElementSelector =
  | RefSelector
  | RoleSelector
  | CSSSelector
  | TextSelector;

/**
 * Zod schemas for runtime validation of selectors
 */

export const refSelectorSchema = z.object({
  ref: z
    .string()
    .describe('System-generated element ID from previous tool results'),
});

export const roleSelectorSchema = z.object({
  role: z.string().describe('ARIA role to match (e.g., button, textbox, link)'),
  text: z
    .string()
    .optional()
    .describe('Optional text content to match within the role'),
});

export const cssSelectorSchema = z.object({
  css: z
    .string()
    .describe(
      'CSS selector string (e.g., "#id", ".class", "button[type=submit]")'
    ),
});

export const textSelectorSchema = z.object({
  text: z.string().describe('Text content to search for'),
  tag: z
    .string()
    .optional()
    .describe('Optional HTML tag to limit search scope'),
});

/**
 * Unified element selector schema with discriminated union validation
 */
export const elementSelectorSchema = z
  .union([
    refSelectorSchema,
    roleSelectorSchema,
    cssSelectorSchema,
    textSelectorSchema,
  ])
  .describe(
    'Element selector supporting ref, role, CSS, or text-based selection'
  );

/**
 * Opt-in flag shared by every selector-based tool. Off by default so behavior
 * matches upstream (top document only); set true to also search child iframes.
 */
export const diveInIframesSchema = z
  .boolean()
  .optional()
  .describe(
    'When true, css/role/text selectors also search inside child <iframe>s ' +
      '(including srcdoc), main frame first. Default false: only the top document is searched.'
  );

/**
 * Confidence level for selector resolution results
 */
export const SelectorConfidence = {
  HIGH: 0.9,
  MEDIUM: 0.7,
  LOW: 0.5,
  VERY_LOW: 0.3,
} as const;

export type SelectorConfidence =
  (typeof SelectorConfidence)[keyof typeof SelectorConfidence];

/**
 * Resolution strategy types for different selector approaches
 */
export const ResolutionStrategy = {
  REF: 'ref',
  CSS_PARALLEL: 'css_parallel',
  ROLE_SEQUENTIAL: 'role_sequential',
  TEXT_FALLBACK: 'text_fallback',
} as const;

export type ResolutionStrategy =
  (typeof ResolutionStrategy)[keyof typeof ResolutionStrategy];

/**
 * One hop in the iframe chain from the top document down to a matched element.
 * For opaque frames (e.g. `srcdoc`, where `url` is `about:srcdoc`) the standard
 * `<iframe>` attributes `name` / `title` / `id` are the only stable label — apps
 * are encouraged to set `title` (and/or `name`) to describe what they load.
 */
export interface FrameStep {
  /** The `<iframe>` `name` attribute (Playwright `frame.name()`), if set. */
  name?: string;
  /** The `<iframe>` `title` attribute — recommended label for srcdoc frames. */
  title?: string;
  /** The `<iframe>` `id` attribute, if set. */
  id?: string;
  /** The frame URL. `about:srcdoc` for srcdoc frames. */
  url?: string;
}

/**
 * Result of selector resolution containing locator and metadata
 */
export interface SelectorResolutionResult {
  /** Resolved Playwright locator */
  locator: Locator;
  /** Original selector used for resolution */
  selector: ElementSelector;
  /** Confidence score (0.0 - 1.0) */
  confidence: number;
  /** Resolution strategy used */
  strategy: ResolutionStrategy;
  /** Set when the match was found inside an iframe (diveInIframes). `path` lists
   *  each iframe from the top document down to the matched frame; `depth` =
   *  `path.length` (1 = a direct child iframe). Absent for top-document matches. */
  frame?: { depth: number; path: FrameStep[] };
  /** Alternative selectors if resolution failed or has low confidence */
  alternatives?: ElementSelector[];
  /** Time taken to resolve in milliseconds */
  resolutionTimeMs: number;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Batch resolution options for multiple selectors
 */
export interface BatchResolutionOptions {
  /** Maximum time to wait for resolution in milliseconds */
  timeoutMs?: number;
  /** Whether to continue resolving other selectors if one fails */
  continueOnError?: boolean;
  /** Strategy for parallel/sequential execution */
  executionStrategy?: 'parallel' | 'sequential' | 'hybrid';
  /** When true, css/role/text selectors also search child `<iframe>`s (main
   *  frame first). Default false — top-document only, matching upstream. */
  diveInIframes?: boolean;
}

/**
 * Categorized selectors for optimized resolution
 */
export interface CategorizedSelectors {
  refs: RefSelector[];
  css: CSSSelector[];
  roles: RoleSelector[];
  text: TextSelector[];
}

/**
 * Element metadata extracted during resolution
 */
export interface ElementMetadata {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isVisible: boolean;
  isEnabled: boolean;
}

/**
 * Enhanced selector resolution result with element metadata
 */
export interface EnhancedSelectorResult extends SelectorResolutionResult {
  /** Detailed element metadata */
  metadata?: ElementMetadata;
  /** Suggested improvements for better selector reliability */
  suggestions?: string[];
}

/**
 * Type guards for selector discrimination
 */
export function isRefSelector(
  selector: ElementSelector
): selector is RefSelector {
  return 'ref' in selector;
}

export function isRoleSelector(
  selector: ElementSelector
): selector is RoleSelector {
  return 'role' in selector;
}

export function isCSSSelector(
  selector: ElementSelector
): selector is CSSSelector {
  return 'css' in selector;
}

export function isTextSelector(
  selector: ElementSelector
): selector is TextSelector {
  return 'text' in selector && !('role' in selector);
}

/**
 * Validate an element selector
 */
export function validateElementSelector(selector: unknown): ElementSelector {
  return elementSelectorSchema.parse(selector);
}

/**
 * Check if a selector is valid
 */
export function isValidSelector(selector: unknown): boolean {
  try {
    elementSelectorSchema.parse(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Selector validation utilities grouped together for convenience
 */
export const SelectorValidator = {
  validateElementSelector,
  isValidSelector,
} as const;

/**
 * Common selector patterns and utilities
 */
export const SelectorPatterns = {
  /** Common ARIA roles for quick reference */
  ARIA_ROLES: [
    'button',
    'textbox',
    'link',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'tab',
    'tabpanel',
    'dialog',
    'alert',
    'menu',
    'menuitem',
    'table',
    'row',
    'cell',
    'heading',
  ] as const,

  /** Common CSS selector patterns */
  CSS_PATTERNS: {
    byId: (id: string) => `#${id}`,
    byClass: (className: string) => `.${className}`,
    byAttribute: (attr: string, value?: string) =>
      value ? `[${attr}="${value}"]` : `[${attr}]`,
    byDataTestId: (testId: string) => `[data-testid="${testId}"]`,
    byRole: (role: string) => `[role="${role}"]`,
  },
} as const;

export type AriaRole = (typeof SelectorPatterns.ARIA_ROLES)[number];
