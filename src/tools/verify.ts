import type * as playwright from 'playwright';
import { z } from 'zod';
import type { Response } from '../response.js';
import type { Tab } from '../tab.js';
import {
  diveInIframesSchema,
  type ElementSelector,
  elementSelectorSchema,
} from '../types/selectors.js';
import { quote } from '../utils/codegen.js';
import { resolveFirstElement } from './shared-element-utils.js';
import { defineTabTool } from './tool.js';
import { generateLocator } from './utils.js';

const selectorsSchema = z
  .array(elementSelectorSchema)
  .min(1)
  .max(5)
  .describe('Element selectors (ref, role, css, or text), tried in order');

// Resolve the first matching element, turning a resolution failure into a
// clean assertion error on the response instead of a thrown exception.
async function resolveOrNull(
  tab: Tab,
  selectors: ElementSelector[],
  label: string,
  diveInIframes: boolean | undefined,
  response: Response
): Promise<playwright.Locator | null> {
  try {
    const { locator } = await resolveFirstElement(
      tab,
      selectors,
      label,
      diveInIframes
    );
    return locator;
  } catch (error) {
    response.addError(error instanceof Error ? error.message : String(error));
    return null;
  }
}

const verifyElementVisible = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_verify_element_visible',
    title: 'Verify element visible',
    description: 'Assert that an element is visible on the page',
    inputSchema: z.object({
      selectors: selectorsSchema,
      diveInIframes: diveInIframesSchema,
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const locator = await resolveOrNull(
      tab,
      params.selectors,
      'Element not found',
      params.diveInIframes,
      response
    );
    if (!locator) {
      return;
    }
    if (await locator.isVisible()) {
      response.addCode(
        `await expect(page.${await generateLocator(locator)}).toBeVisible();`
      );
      response.addResult('Done');
    } else {
      response.addError('Element resolved but is not visible');
    }
  },
});

const verifyTextVisible = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_verify_text_visible',
    title: 'Verify text visible',
    description:
      'Assert that text is visible on the page. Prefer browser_verify_element_visible when you know the element role.',
    inputSchema: z.object({
      text: z.string().describe('Text to verify is visible on the page'),
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const locator = tab.page.getByText(params.text).filter({ visible: true });
    if ((await locator.count()) > 0) {
      response.addCode(
        `await expect(page.getByText(${quote(params.text)})).toBeVisible();`
      );
      response.addResult('Done');
    } else {
      response.addError(`Text "${params.text}" is not visible on the page`);
    }
  },
});

const verifyListVisible = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_verify_list_visible',
    title: 'Verify list visible',
    description:
      'Assert that a list element (resolved by selectors) contains all of the given item texts',
    inputSchema: z.object({
      selectors: selectorsSchema,
      items: z
        .array(z.string())
        .min(1)
        .describe('Item texts that must all be present in the list'),
      diveInIframes: diveInIframesSchema,
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const locator = await resolveOrNull(
      tab,
      params.selectors,
      'List not found',
      params.diveInIframes,
      response
    );
    if (!locator) {
      return;
    }
    const counts = await Promise.all(
      params.items.map((item) =>
        locator.getByText(item, { exact: true }).count()
      )
    );
    const missing = params.items.filter((_, i) => counts[i] === 0);
    if (missing.length > 0) {
      response.addError(
        `List is missing items: ${missing.map(quote).join(', ')}`
      );
      return;
    }
    response.addCode(
      `await expect(page.${await generateLocator(locator)}).toContainText([${params.items
        .map(quote)
        .join(', ')}]);`
    );
    response.addResult('Done');
  },
});

const verifyValue = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_verify_value',
    title: 'Verify value',
    description: "Assert a form element's current value or checked state",
    inputSchema: z.object({
      selectors: selectorsSchema,
      type: z
        .enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider'])
        .describe('Element type'),
      value: z
        .string()
        .describe('Expected value. For checkbox/radio use "true"/"false".'),
      diveInIframes: diveInIframesSchema,
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const locator = await resolveOrNull(
      tab,
      params.selectors,
      'Element not found',
      params.diveInIframes,
      response
    );
    if (!locator) {
      return;
    }
    const source = `page.${await generateLocator(locator)}`;
    if (params.type === 'checkbox' || params.type === 'radio') {
      const checked = await locator.isChecked();
      if (checked !== (params.value === 'true')) {
        response.addError(
          `Expected checked=${params.value}, but got ${checked}`
        );
        return;
      }
      response.addCode(
        `await expect(${source}).${checked ? 'toBeChecked()' : 'not.toBeChecked()'};`
      );
    } else {
      const value = await locator.inputValue();
      if (value !== params.value) {
        response.addError(
          `Expected value ${quote(params.value)}, but got ${quote(value)}`
        );
        return;
      }
      response.addCode(
        `await expect(${source}).toHaveValue(${quote(params.value)});`
      );
    }
    response.addResult('Done');
  },
});

const generateLocatorTool = defineTabTool({
  capability: 'testing',
  schema: {
    name: 'browser_generate_locator',
    title: 'Generate locator',
    description:
      'Resolve the given selectors and return the Playwright locator string, for building test code',
    inputSchema: z.object({
      selectors: selectorsSchema,
      diveInIframes: diveInIframesSchema,
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const locator = await resolveOrNull(
      tab,
      params.selectors,
      'Element not found',
      params.diveInIframes,
      response
    );
    if (!locator) {
      return;
    }
    response.addResult(`page.${await generateLocator(locator)}`);
  },
});

export default [
  verifyElementVisible,
  verifyTextVisible,
  verifyListVisible,
  verifyValue,
  generateLocatorTool,
];
