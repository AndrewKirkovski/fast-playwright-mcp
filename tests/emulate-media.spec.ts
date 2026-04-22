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

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { expect, test } from './fixtures.js';
import { setServerContent } from './test-helpers.js';

const PAGE_HTML = `
  <title>Emulate Media Test</title>
  <script>
    globalThis.readMedia = () => ({
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      light: matchMedia('(prefers-color-scheme: light)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forced: matchMedia('(forced-colors: active)').matches,
      print: matchMedia('print').matches,
      screen: matchMedia('screen').matches,
    });
  </script>
  <body>ready</body>
`;

const RESULT_JSON_REGEX = /\{[\s\S]*?"dark"[\s\S]*?"screen"[\s\S]*?\}/;

type MediaSnapshot = {
  dark: boolean;
  light: boolean;
  reduced: boolean;
  forced: boolean;
  print: boolean;
  screen: boolean;
};

async function readMedia(client: Client): Promise<MediaSnapshot> {
  const resp = await client.callTool({
    name: 'browser_evaluate',
    arguments: { function: '() => readMedia()' },
  });
  const content = resp.content as Array<{ text?: string }> | undefined;
  const text = content?.[0]?.text ?? '';
  const match = text.match(RESULT_JSON_REGEX);
  if (!match) {
    throw new Error(`Could not parse readMedia result from: ${text}`);
  }
  return JSON.parse(match[0]) as MediaSnapshot;
}

test('browser_emulate_media applies colorScheme dark', async ({
  client,
  server,
}) => {
  setServerContent(server, '/', PAGE_HTML);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const before = await readMedia(client);
  expect(before.dark).toBe(false);
  expect(before.light).toBe(true);

  const toolResponse = await client.callTool({
    name: 'browser_emulate_media',
    arguments: { colorScheme: 'dark' },
  });
  expect(toolResponse).toHaveResponse({
    code: expect.stringContaining(
      `await page.emulateMedia({"colorScheme":"dark"});`
    ),
    result: expect.stringContaining('Emulated media: colorScheme=dark'),
  });

  const after = await readMedia(client);
  expect(after.dark).toBe(true);
  expect(after.light).toBe(false);
});

test('browser_emulate_media applies reducedMotion, forcedColors, media together', async ({
  client,
  server,
}) => {
  setServerContent(server, '/', PAGE_HTML);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_emulate_media',
    arguments: {
      reducedMotion: 'reduce',
      forcedColors: 'active',
      media: 'print',
    },
  });

  const after = await readMedia(client);
  expect(after.reduced).toBe(true);
  expect(after.forced).toBe(true);
  expect(after.print).toBe(true);
  expect(after.screen).toBe(false);
});

test('browser_emulate_media with null resets emulation', async ({
  client,
  server,
}) => {
  setServerContent(server, '/', PAGE_HTML);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  await client.callTool({
    name: 'browser_emulate_media',
    arguments: { colorScheme: 'dark' },
  });
  const afterDark = await readMedia(client);
  expect(afterDark.dark).toBe(true);

  await client.callTool({
    name: 'browser_emulate_media',
    arguments: { colorScheme: null },
  });
  const afterReset = await readMedia(client);
  expect(afterReset.dark).toBe(false);
  expect(afterReset.light).toBe(true);
});

test('browser_emulate_media errors when no fields provided', async ({
  client,
  server,
}) => {
  setServerContent(server, '/', PAGE_HTML);
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const resp = await client.callTool({
    name: 'browser_emulate_media',
    arguments: {},
  });
  const content = resp.content as Array<{ text?: string }> | undefined;
  const text = content?.[0]?.text ?? '';
  expect(text).toContain('Provide at least one of');
});
