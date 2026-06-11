import { expect, test } from './fixtures';
import { setServerContent } from './test-helpers';

test.skip(({ mcpMode }) => mcpMode, 'MCP mode only');

const FORM_HTML = `
  <title>Form</title>
  <form>
    <input type="text" aria-label="Name" />
    <input type="checkbox" aria-label="Subscribe" />
    <select aria-label="Color"><option>Red</option><option>Green</option></select>
  </form>
  <button type="submit">Submit</button>
`;

test('fill_form fills multiple fields, verify confirms them', async ({
  startClient,
  server,
}) => {
  // --caps=testing also includes all core tools (browser_fill_form is core).
  const { client } = await startClient({ args: ['--caps=testing'] });
  setServerContent(server, '/', FORM_HTML);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const filled = await client.callTool({
    name: 'browser_fill_form',
    arguments: {
      fields: [
        {
          name: 'Name',
          type: 'textbox',
          selectors: [{ css: 'input[aria-label="Name"]' }],
          value: 'Alice',
        },
        {
          name: 'Subscribe',
          type: 'checkbox',
          selectors: [{ css: 'input[aria-label="Subscribe"]' }],
          value: 'true',
        },
        {
          name: 'Color',
          type: 'combobox',
          selectors: [{ css: 'select[aria-label="Color"]' }],
          value: 'Green',
        },
      ],
    },
  });
  expect(filled).toHaveResponse({
    code: expect.stringContaining(".fill('Alice');"),
  });

  const nameValue = await client.callTool({
    name: 'browser_verify_value',
    arguments: {
      type: 'textbox',
      value: 'Alice',
      selectors: [{ css: 'input[aria-label="Name"]' }],
    },
  });
  expect(nameValue).toHaveResponse({ result: expect.stringContaining('Done') });

  const checkValue = await client.callTool({
    name: 'browser_verify_value',
    arguments: {
      type: 'checkbox',
      value: 'true',
      selectors: [{ css: 'input[aria-label="Subscribe"]' }],
    },
  });
  expect(checkValue).toHaveResponse({
    result: expect.stringContaining('Done'),
  });

  const elementVisible = await client.callTool({
    name: 'browser_verify_element_visible',
    arguments: { selectors: [{ role: 'button', text: 'Submit' }] },
  });
  expect(elementVisible).toHaveResponse({
    result: expect.stringContaining('Done'),
  });

  const textVisible = await client.callTool({
    name: 'browser_verify_text_visible',
    arguments: { text: 'Submit' },
  });
  expect(textVisible).toHaveResponse({
    result: expect.stringContaining('Done'),
  });
});

test('verify_value reports a mismatch', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--caps=testing'] });
  setServerContent(server, '/', FORM_HTML);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await client.callTool({
    name: 'browser_fill_form',
    arguments: {
      fields: [
        {
          name: 'Name',
          type: 'textbox',
          selectors: [{ css: 'input[aria-label="Name"]' }],
          value: 'Alice',
        },
      ],
    },
  });

  const wrong = await client.callTool({
    name: 'browser_verify_value',
    arguments: {
      type: 'textbox',
      value: 'Bob',
      selectors: [{ css: 'input[aria-label="Name"]' }],
    },
  });
  const text = (wrong.content as { text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');
  expect(text).toContain('Expected value');
});
