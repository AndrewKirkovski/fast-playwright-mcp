import { z } from 'zod';
import { expectationSchema } from '../schemas/expectation.js';
import {
  diveInIframesSchema,
  elementSelectorSchema,
} from '../types/selectors.js';
import { quote } from '../utils/codegen.js';
import { generateKeyPressCode } from '../utils/common-formatters.js';
import {
  handleSnapshotExpectation,
  resolveFirstElement,
} from './shared-element-utils.js';
import { defineTabTool } from './tool.js';
import { generateLocator } from './utils.js';

const pressKey = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_press_key',
    title: 'Press a key',
    description: 'Press a key on the keyboard',
    inputSchema: z.object({
      key: z.string().describe('Key to press'),
      expectation: expectationSchema.describe(
        'Page state config. Use batch_execute for multiple keys'
      ),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    response.addCode(`// Press ${params.key}`);
    response.addCode(generateKeyPressCode(params.key));
    await tab.waitForCompletion(async () => {
      await tab.page.keyboard.press(params.key);
    });
    // If expectation includes snapshot, capture it now after navigation
    await handleSnapshotExpectation(tab, params.expectation, response);
  },
});
// Enhanced selector schema for browser tools
const selectorsSchema = z
  .array(elementSelectorSchema)
  .min(1)
  .max(5)
  .describe(
    'Array of element selectors (max 5) supporting ref, role, CSS, or text-based selection'
  );

const typeSchema = z.object({
  selectors: selectorsSchema,
  diveInIframes: diveInIframesSchema,
  text: z.string().describe('Text to type into the element'),
  submit: z.boolean().optional().describe('Press Enter after typing if true'),
  slowly: z
    .boolean()
    .optional()
    .describe('Type slowly for auto-complete if true'),
  expectation: expectationSchema.describe(
    'Page state config. Use batch_execute for forms'
  ),
});
const type = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_type',
    title: 'Type text',
    description: 'Type text into editable element',
    inputSchema: typeSchema,
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    const { locator } = await resolveFirstElement(
      tab,
      params.selectors,
      undefined,
      params.diveInIframes
    );

    await tab.waitForCompletion(async () => {
      if (params.slowly) {
        response.addCode(
          `await page.${await generateLocator(locator)}.pressSequentially(${quote(params.text)});`
        );
        await locator.pressSequentially(params.text);
      } else {
        response.addCode(
          `await page.${await generateLocator(locator)}.fill(${quote(params.text)});`
        );
        await locator.fill(params.text);
      }

      if (params.submit) {
        response.addCode(
          `await page.${await generateLocator(locator)}.press('Enter');`
        );
        await locator.press('Enter');
      }
    });

    await handleSnapshotExpectation(tab, params.expectation, response);
  },
});
const keydown = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_keydown',
    title: 'Press a key down',
    description:
      'Press and hold a key down without releasing it. Pair with browser_keyup for modifier combos (e.g. hold Shift, then click).',
    inputSchema: z.object({
      key: z
        .string()
        .describe(
          'Key to hold down, e.g. `Shift`, `Control`, `ArrowLeft`, or `a`'
        ),
      expectation: expectationSchema.describe('Page state config'),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    response.addCode(`await page.keyboard.down(${quote(params.key)});`);
    await tab.waitForCompletion(async () => {
      await tab.page.keyboard.down(params.key);
    });
    await handleSnapshotExpectation(tab, params.expectation, response);
  },
});
const keyup = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_keyup',
    title: 'Release a key',
    description: 'Release a key previously held down with browser_keydown',
    inputSchema: z.object({
      key: z
        .string()
        .describe(
          'Key to release, e.g. `Shift`, `Control`, `ArrowLeft`, or `a`'
        ),
      expectation: expectationSchema.describe('Page state config'),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    response.addCode(`await page.keyboard.up(${quote(params.key)});`);
    await tab.waitForCompletion(async () => {
      await tab.page.keyboard.up(params.key);
    });
    await handleSnapshotExpectation(tab, params.expectation, response);
  },
});
const pressSequentially = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_press_sequentially',
    title: 'Type text key by key',
    description:
      'Type text one character at a time via the keyboard (page-level, no element target). Use browser_type to fill a specific field.',
    inputSchema: z.object({
      text: z.string().describe('Text to type'),
      submit: z
        .boolean()
        .optional()
        .describe('Press Enter after typing if true'),
      expectation: expectationSchema.describe('Page state config'),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    response.addCode(`await page.keyboard.type(${quote(params.text)});`);
    await tab.waitForCompletion(async () => {
      await tab.page.keyboard.type(params.text);
      if (params.submit) {
        response.addCode("await page.keyboard.press('Enter');");
        await tab.page.keyboard.press('Enter');
      }
    });
    await handleSnapshotExpectation(tab, params.expectation, response);
  },
});
export default [pressKey, type, keydown, keyup, pressSequentially];
