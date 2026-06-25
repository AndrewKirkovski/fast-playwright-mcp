import type * as playwright from 'playwright';
import { z } from 'zod';
import { expectationSchema } from '../schemas/expectation.js';
import {
  diveInIframesSchema,
  elementSelectorSchema,
} from '../types/selectors.js';
import { quote } from '../utils/codegen.js';
import { defineTabTool } from './tool.js';
import { generateLocator } from './utils.js';

// Enhanced selector schema for browser tools
const selectorsSchema = z
  .array(elementSelectorSchema)
  .min(1)
  .max(5)
  .describe(
    'Array of element selectors (max 5) supporting ref, role, CSS, or text-based selection'
  );

const evaluateSchema = z.object({
  function: z
    .string()
    .describe('JS function: () => {...} or (element) => {...}'),
  selectors: selectorsSchema
    .optional()
    .describe(
      'Optional element selectors. If provided, function receives element as parameter'
    ),
  // Override the shared description: on browser_evaluate the flag ONLY affects
  // selector resolution, never the document a bare () => {...} runs against.
  diveInIframes: diveInIframesSchema.describe(
    'Only affects `selectors` resolution (matching css/role/text inside child <iframe>s). ' +
      'It has NO effect on a bare `() => {...}` function — that ALWAYS runs in the top document, ' +
      "so `document.querySelector(...)` won't see iframe contents. To target an iframe, either pass " +
      '`selectors` with `diveInIframes: true` (the function then receives the matched element), or, ' +
      'for a same-origin iframe (including srcdoc), reach into it in your function, e.g. ' +
      "`() => { const d = document.querySelector('iframe')?.contentDocument ?? document; return d.querySelectorAll('.foo').length; }`."
  ),
  expectation: expectationSchema.describe(
    'Page state config. false for data extraction, true for DOM changes'
  ),
});
const evaluate = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_evaluate',
    title: 'Evaluate JavaScript',
    description:
      'Evaluate JavaScript expression on page or element and return result',
    inputSchema: evaluateSchema,
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    let locator: playwright.Locator | undefined;

    if (params.selectors && params.selectors.length > 0) {
      const resolutionResults = await tab.resolveElementLocators(
        params.selectors,
        { diveInIframes: params.diveInIframes }
      );
      const successfulResults = resolutionResults.filter(
        (r) => r.locator && !r.error
      );

      if (successfulResults.length === 0) {
        const errors = resolutionResults
          .map((r) => r.error || 'Unknown error')
          .join(', ');
        throw new Error(`Failed to resolve element selectors: ${errors}`);
      }

      locator = successfulResults[0].locator;
      response.addCode(
        `await page.${await generateLocator(locator)}.evaluate(${quote(params.function)});`
      );
    } else {
      if (params.diveInIframes) {
        // The flag is a no-op here (it only steers selector resolution), but an
        // agent that set it almost certainly expected iframe contents — say so
        // loudly instead of silently returning a top-document-only result.
        response.addResult(
          'Note: `diveInIframes` was ignored — it only affects `selectors` resolution, ' +
            'and this call has no `selectors`, so the function ran against the top document only. ' +
            'To target an iframe, either pass `selectors` with `diveInIframes: true` (the function ' +
            'then receives the matched element), or, for a same-origin iframe (including srcdoc), ' +
            'reach into it in your function, e.g. ' +
            "`() => { const d = document.querySelector('iframe')?.contentDocument ?? document; return d.querySelectorAll('.foo').length; }`."
        );
      }
      response.addCode(`await page.evaluate(${quote(params.function)});`);
    }

    await tab.waitForCompletion(async () => {
      try {
        // Playwright 1.61 removed the internal _evaluateFunction. Run the
        // caller's function string through the public evaluate() API,
        // constructing it inside the page context (mirrors upstream).
        let result: unknown;
        if (locator) {
          result = await locator.evaluate((element, expr) => {
            // biome-ignore lint/security/noGlobalEval: executes the caller's function string inside the page context
            const value = eval(`(${expr})`);
            return typeof value === 'function' ? value(element) : value;
          }, params.function);
        } else {
          result = await tab.page.evaluate((expr) => {
            // biome-ignore lint/security/noGlobalEval: executes the caller's function string inside the page context
            const value = eval(`(${expr})`);
            return typeof value === 'function' ? value() : value;
          }, params.function);
        }
        const stringifiedResult = JSON.stringify(result, null, 2);
        response.addResult(stringifiedResult ?? 'undefined');
      } catch (error) {
        response.addError(
          `JavaScript evaluation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  },
});
export default [evaluate];
