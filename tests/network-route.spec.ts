import { expect, test } from './fixtures';
import { setServerContent } from './test-helpers';

test.skip(({ mcpMode }) => mcpMode, 'MCP mode only');

test('browser_route mocks a request, then unroute removes it', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title><body>hi</body>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_route',
    arguments: {
      pattern: '**/api/data',
      body: '{"mocked":true}',
      contentType: 'application/json',
    },
  });

  const list = await client.callTool({
    name: 'browser_route_list',
    arguments: {},
  });
  expect(list).toHaveResponse({
    result: expect.stringContaining('**/api/data'),
  });

  const mocked = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { const r = await fetch('/api/data'); return await r.text(); }",
    },
  });
  expect(mocked).toHaveResponse({ result: expect.stringContaining('mocked') });

  const removed = await client.callTool({
    name: 'browser_unroute',
    arguments: { pattern: '**/api/data' },
  });
  expect(removed).toHaveResponse({
    result: expect.stringContaining('Removed 1 route'),
  });
});

test('browser_network_state_set offline makes requests fail', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const off = await client.callTool({
    name: 'browser_network_state_set',
    arguments: { state: 'offline' },
  });
  expect(off).toHaveResponse({ result: expect.stringContaining('offline') });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { try { await fetch('/'); return 'ok'; } catch { return 'failed'; } }",
    },
  });
  expect(result).toHaveResponse({ result: expect.stringContaining('failed') });
});
