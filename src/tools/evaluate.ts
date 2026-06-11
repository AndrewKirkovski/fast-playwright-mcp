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
  diveInIframes: diveInIframesSchema,
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
