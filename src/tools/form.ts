import { z } from 'zod';
import type { Response } from '../response.js';
import { expectationSchema } from '../schemas/expectation.js';
import type { Tab } from '../tab.js';
import {
  diveInIframesSchema,
  elementSelectorSchema,
} from '../types/selectors.js';
import { quote } from '../utils/codegen.js';
import {
  handleSnapshotExpectation,
  resolveFirstElement,
} from './shared-element-utils.js';
import { defineTabTool } from './tool.js';
import { generateLocator } from './utils.js';

const formFieldSchema = z.object({
  name: z.string().describe('Human-readable field name (for logs)'),
  type: z
    .enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider'])
    .describe('Field type'),
  selectors: z
    .array(elementSelectorSchema)
    .min(1)
    .max(5)
    .describe(
      'Selectors for this field (ref, role, css, or text), tried in order'
    ),
  value: z
    .string()
    .describe(
      'Value to fill. For checkbox/radio use "true"/"false"; for combobox use the visible option text.'
    ),
});

type FormField = z.infer<typeof formFieldSchema>;

async function fillField(
  tab: Tab,
  field: FormField,
  diveInIframes: boolean | undefined,
  response: Response
): Promise<void> {
  const { locator } = await resolveFirstElement(
    tab,
    field.selectors,
    `Failed to resolve field "${field.name}"`,
    diveInIframes
  );
  const source = `await page.${await generateLocator(locator)}`;
  if (field.type === 'textbox' || field.type === 'slider') {
    await locator.fill(field.value);
    response.addCode(`${source}.fill(${quote(field.value)});`);
  } else if (field.type === 'checkbox' || field.type === 'radio') {
    const checked = field.value === 'true';
    await locator.setChecked(checked);
    response.addCode(`${source}.setChecked(${checked});`);
  } else {
    await locator.selectOption({ label: field.value });
    response.addCode(
      `${source}.selectOption({ label: ${quote(field.value)} });`
    );
  }
}

const fillForm = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_fill_form',
    title: 'Fill form',
    description:
      'Fill multiple form fields in a single call. Token-efficient alternative to issuing separate type/select/check tools per field.',
    inputSchema: z.object({
      fields: z
        .array(formFieldSchema)
        .min(1)
        .describe('Fields to fill, in order'),
      diveInIframes: diveInIframesSchema,
      expectation: expectationSchema.describe('Page state after filling'),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    await tab.waitForCompletion(async () => {
      for (const field of params.fields) {
        // biome-ignore lint/nursery/noAwaitInLoop: fields fill sequentially by design — order matters and each fill can depend on prior page state
        await fillField(tab, field, params.diveInIframes, response);
      }
    });
    await handleSnapshotExpectation(tab, params.expectation, response);
  },
});
export default [fillForm];
