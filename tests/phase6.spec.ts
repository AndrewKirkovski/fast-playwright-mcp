import { existsSync } from 'node:fs';
import { expect, test } from './fixtures';
import { setServerContent } from './test-helpers';

test.skip(({ mcpMode }) => mcpMode, 'MCP mode only');

const SAVED_TRACE_REGEX = /Trace saved to (.+?\.zip)/;

test('press_sequentially types into the focused input', async ({
  client,
  server,
}) => {
  setServerContent(server, '/', '<title>T</title><input autofocus />');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.querySelector("input").focus()' },
  });
  await client.callTool({
    name: 'browser_press_sequentially',
    arguments: { text: 'hello' },
  });
  const val = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => document.querySelector("input").value' },
  });
  expect(val).toHaveResponse({ result: expect.stringContaining('hello') });
});

test('console_clear empties the console buffer', async ({ client, server }) => {
  setServerContent(server, '/', '<title>C</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: "() => console.log('marker-xyz')" },
  });
  const before = await client.callTool({
    name: 'browser_console_messages',
    arguments: {},
  });
  expect(before).toHaveResponse({
    result: expect.stringContaining('marker-xyz'),
  });

  await client.callTool({ name: 'browser_console_clear', arguments: {} });
  const after = await client.callTool({
    name: 'browser_console_messages',
    arguments: {},
  });
  expect(after).toHaveResponse({
    result: expect.stringContaining('No console messages'),
  });
});

test('get_config returns the resolved config', async ({ startClient }) => {
  const { client } = await startClient({ args: ['--caps=config'] });
  const cfg = await client.callTool({
    name: 'browser_get_config',
    arguments: {},
  });
  expect(cfg).toHaveResponse({ result: expect.stringContaining('browser') });
});

test('generate_locator returns a locator string', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=testing'] });
  setServerContent(server, '/', '<title>G</title><button>Go</button>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  const loc = await client.callTool({
    name: 'browser_generate_locator',
    arguments: { selectors: [{ role: 'button', text: 'Go' }] },
  });
  expect(loc).toHaveResponse({ result: expect.stringContaining('getByRole') });
});

test('tracing start/stop saves a trace zip', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=devtools'] });
  setServerContent(server, '/', '<title>Tr</title><button>x</button>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  await client.callTool({ name: 'browser_start_tracing', arguments: {} });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  const stopped = await client.callTool({
    name: 'browser_stop_tracing',
    arguments: {},
  });
  const text = (stopped.content as { text?: string }[])
    .map((c) => c.text ?? '')
    .join('\n');
  const match = text.match(SAVED_TRACE_REGEX);
  if (!match) {
    throw new Error(`No trace path in response: ${text}`);
  }
  expect(existsSync(match[1].trim())).toBe(true);
});
