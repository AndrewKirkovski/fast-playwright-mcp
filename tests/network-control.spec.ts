/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from './fixtures.js';
import { setServerContent } from './test-helpers.js';

test.skip(({ mcpMode }) => Boolean(mcpMode), 'MCP mode only');

test('browser_route abort fails a matched request', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_route',
    arguments: {
      pattern: '**/api/fail',
      abort: true,
      abortErrorCode: 'connectionrefused',
    },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { try { await fetch('/api/fail'); return 'ok'; } catch { return 'failed'; } }",
    },
  });
  expect(result).toHaveResponse({ result: expect.stringContaining('failed') });

  const list = await client.callTool({
    name: 'browser_route_list',
    arguments: {},
  });
  expect(list).toHaveResponse({
    result: expect.stringContaining('abort=connectionrefused'),
  });
});

test('browser_route sets response headers on a mock', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
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
      responseHeaders: ['X-Test: yes'],
    },
  });

  const headerVal = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { const r = await fetch('/api/data'); return r.headers.get('x-test'); }",
    },
  });
  expect(headerVal).toHaveResponse({ result: expect.stringContaining('yes') });
});

test('browser_route modifyResponse overlays the real response body', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
  server.setContent('/api/real', '{"real":1}', 'application/json');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_route',
    arguments: {
      pattern: '**/api/real',
      modifyResponse: true,
      body: '{"overlaid":true}',
    },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { const r = await fetch('/api/real'); return await r.text(); }",
    },
  });
  expect(result).toHaveResponse({
    result: expect.stringContaining('overlaid'),
  });
});

test('browser_cache_set toggles the HTTP cache (chromium)', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({
    args: ['--caps=network', '--browser=chromium'],
  });
  setServerContent(server, '/', '<title>Net</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const off = await client.callTool({
    name: 'browser_cache_set',
    arguments: { enabled: false },
  });
  expect(off).toHaveResponse({
    result: expect.stringContaining('cache disabled'),
  });

  const on = await client.callTool({
    name: 'browser_cache_set',
    arguments: { enabled: true },
  });
  expect(on).toHaveResponse({
    result: expect.stringContaining('cache enabled'),
  });
});

test('browser_route adds request headers on the pass-through path', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
  // Echo back the value of an injected request header so we can assert it
  // actually reached the server through the fallback (header-edit) path.
  server.route('/echo', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`x-injected=${req.headers['x-injected'] ?? 'none'}`);
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  // No body/status/responseHeaders -> pass-through (fallback) with header edits.
  await client.callTool({
    name: 'browser_route',
    arguments: {
      pattern: '**/echo',
      headers: ['X-Injected: abc'],
    },
  });

  const echoed = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { const r = await fetch('/echo'); return await r.text(); }",
    },
  });
  expect(echoed).toHaveResponse({
    result: expect.stringContaining('x-injected=abc'),
  });
});

test('browser_throttle accepts presets, custom values, and none (chromium)', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({
    args: ['--caps=network', '--browser=chromium'],
  });
  setServerContent(server, '/', '<title>Net</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const preset = await client.callTool({
    name: 'browser_throttle',
    arguments: { preset: 'slow-3g' },
  });
  expect(preset).toHaveResponse({ result: expect.stringContaining('slow-3g') });

  const custom = await client.callTool({
    name: 'browser_throttle',
    arguments: { downloadKbps: 1000, latencyMs: 100 },
  });
  expect(custom).toHaveResponse({
    result: expect.stringContaining('1000 kbps down'),
  });

  const cleared = await client.callTool({
    name: 'browser_throttle',
    arguments: { preset: 'none' },
  });
  expect(cleared).toHaveResponse({
    result: expect.stringContaining('cleared'),
  });
});

test('browser_throttle errors when nothing is specified (chromium)', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({
    args: ['--caps=network', '--browser=chromium'],
  });
  setServerContent(server, '/', '<title>Net</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_throttle',
    arguments: {},
  });
  expect(result.isError).toBe(true);
});

test('cache/throttle tools are registered on chromium', async ({
  startClient,
}) => {
  const { client } = await startClient({
    args: ['--caps=network', '--browser=chromium'],
  });
  const toolNames = (await client.listTools()).tools.map((t) => t.name);
  expect(toolNames).toContain('browser_cache_set');
  expect(toolNames).toContain('browser_throttle');
});

test('cache/throttle tools are hidden on firefox', async ({ startClient }) => {
  const { client } = await startClient({
    args: ['--caps=network', '--browser=firefox'],
  });
  const toolNames = (await client.listTools()).tools.map((t) => t.name);
  expect(toolNames).not.toContain('browser_cache_set');
  expect(toolNames).not.toContain('browser_throttle');
});

test('browser_route removeHeaders drops a request header', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
  server.route('/echo2', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`x-drop=${req.headers['x-drop'] ?? 'none'}`);
  });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_route',
    arguments: { pattern: '**/echo2', removeHeaders: 'x-drop' },
  });

  const echoed = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function:
        "async () => { const r = await fetch('/echo2', { headers: { 'X-Drop': 'remove-me' } }); return await r.text(); }",
    },
  });
  expect(echoed).toHaveResponse({
    result: expect.stringContaining('x-drop=none'),
  });
});

test('browser_network_reset removes active routes', async ({
  startClient,
  server,
}) => {
  const { client } = await startClient({ args: ['--caps=network'] });
  setServerContent(server, '/', '<title>Net</title>');
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_route',
    arguments: {
      pattern: '**/api/x',
      body: '{"mock":1}',
      contentType: 'application/json',
    },
  });

  const reset = await client.callTool({
    name: 'browser_network_reset',
    arguments: {},
  });
  expect(reset).toHaveResponse({
    result: expect.stringContaining('Network reset'),
  });

  const list = await client.callTool({
    name: 'browser_route_list',
    arguments: {},
  });
  expect(list).toHaveResponse({
    result: expect.stringContaining('No active routes'),
  });
});
