import { expect, test } from './fixtures';
import { setServerContent } from './test-helpers';

test.skip(({ mcpMode }) => mcpMode, 'MCP mode only');

const SAVED_PATH_REGEX = /Storage state saved to (.+)/;

test('cookies: set, get, list, delete', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--caps=storage'] });
  setServerContent(server, '/', '<title>Cookies</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_cookie_set',
    arguments: { name: 'sid', value: 'abc123' },
  });

  const get = await client.callTool({
    name: 'browser_cookie_get',
    arguments: { name: 'sid' },
  });
  expect(get).toHaveResponse({ result: expect.stringContaining('sid=abc123') });

  const list = await client.callTool({
    name: 'browser_cookie_list',
    arguments: {},
  });
  expect(list).toHaveResponse({
    result: expect.stringContaining('sid=abc123'),
  });

  await client.callTool({
    name: 'browser_cookie_delete',
    arguments: { name: 'sid' },
  });
  const afterDelete = await client.callTool({
    name: 'browser_cookie_get',
    arguments: { name: 'sid' },
  });
  expect(afterDelete).toHaveResponse({
    result: expect.stringContaining('not found'),
  });
});

test('localStorage: set, get, list, clear', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--caps=storage'] });
  setServerContent(server, '/', '<title>LS</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_localstorage_set',
    arguments: { key: 'theme', value: 'dark' },
  });
  const get = await client.callTool({
    name: 'browser_localstorage_get',
    arguments: { key: 'theme' },
  });
  expect(get).toHaveResponse({ result: 'theme=dark' });

  const list = await client.callTool({
    name: 'browser_localstorage_list',
    arguments: {},
  });
  expect(list).toHaveResponse({
    result: expect.stringContaining('theme=dark'),
  });

  await client.callTool({
    name: 'browser_localstorage_clear',
    arguments: {},
  });
  const afterClear = await client.callTool({
    name: 'browser_localstorage_list',
    arguments: {},
  });
  expect(afterClear).toHaveResponse({
    result: expect.stringContaining('No localStorage items'),
  });
});

test('storage_state round-trips cookies', async ({ startClient, server }) => {
  const { client } = await startClient({ args: ['--caps=storage'] });
  setServerContent(server, '/', '<title>State</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_cookie_set',
    arguments: { name: 'auth', value: 'token42' },
  });
  const saved = await client.callTool({
    name: 'browser_storage_state',
    arguments: {},
  });
  expect(saved).toHaveResponse({
    result: expect.stringContaining('Storage state saved to'),
  });

  // Pass back the absolute path the save returned (the realistic flow).
  const savedText = (saved.content as { text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');
  const match = savedText.match(SAVED_PATH_REGEX);
  if (!match) {
    throw new Error(`No saved path in response: ${savedText}`);
  }
  const savedPath = match[1].trim();

  await client.callTool({ name: 'browser_cookie_clear', arguments: {} });
  await client.callTool({
    name: 'browser_set_storage_state',
    arguments: { filename: savedPath },
  });

  const get = await client.callTool({
    name: 'browser_cookie_get',
    arguments: { name: 'auth' },
  });
  expect(get).toHaveResponse({
    result: expect.stringContaining('auth=token42'),
  });
});
