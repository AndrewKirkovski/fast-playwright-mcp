import { expect, test } from './fixtures';
import { HTML_TEMPLATES, setServerContent } from './test-helpers';

test.skip(({ mcpMode }) => mcpMode, 'MCP mode only');

test('browser_reload', async ({ client, server }) => {
  setServerContent(server, '/', HTML_TEMPLATES.BASIC_BUTTON);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_reload',
    arguments: {},
  });

  expect(response).toHaveResponse({
    code: 'await page.reload();',
    pageState: expect.stringContaining('- button "Submit"'),
  });
});

test('browser_keydown / browser_keyup', async ({ client, server }) => {
  setServerContent(server, '/', HTML_TEMPLATES.BASIC_TITLE_ONLY);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const down = await client.callTool({
    name: 'browser_keydown',
    arguments: { key: 'Shift' },
  });
  expect(down).toHaveResponse({ code: "await page.keyboard.down('Shift');" });

  const up = await client.callTool({
    name: 'browser_keyup',
    arguments: { key: 'Shift' },
  });
  expect(up).toHaveResponse({ code: "await page.keyboard.up('Shift');" });
});

test('browser_mouse_wheel scrolls the page (vision)', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=vision'] });
  setServerContent(
    server,
    '/',
    '<title>Scroll</title><body style="height: 3000px">tall page</body>'
  );
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const response = await client.callTool({
    name: 'browser_mouse_wheel',
    arguments: { deltaY: 200 },
  });
  expect(response).toHaveResponse({ code: 'await page.mouse.wheel(0, 200);' });

  const scrollY = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => window.scrollY' },
  });
  expect(scrollY).toHaveResponse({ result: '200' });
});
