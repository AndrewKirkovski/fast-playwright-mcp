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
import {
  expectCodeAndResult,
  expectPageTitle,
  setServerContent,
} from './test-helpers.js';

// Regular expression for extracting ref from page state
const REF_PATTERN = /\[ref=([^\]]+)\]/;

// Top-level regex patterns for performance optimization
const ERROR_PATTERNS_REGEX = /not defined|Can't find variable/;

const evaluateTestCases = [
  {
    name: 'browser_evaluate',
    setup: null,
    evaluateArgs: {
      function: '() => document.title',
    },
    expectedCode: `await page.evaluate('() => document.title');`,
    expectedResult: `"Title"`,
    expectError: false,
  },
  {
    name: 'browser_evaluate (element)',
    setup: `<div style="background-color: red">Hello, world!</div>`,
    evaluateArgs: {
      function: 'element => element.textContent',
      needsRef: true,
    },
    expectedCode: `await page.getByText('Hello, world!').evaluate('element => element.textContent');`,
    expectedResult: `"Hello, world!"`,
    expectError: false,
  },
  {
    name: 'browser_evaluate (error)',
    setup: null,
    evaluateArgs: {
      function: '() => nonExistentVariable',
    },
    expectedCode: null,
    expectedResult: null,
    expectError: true,
    errorCheck: (errorText: string) => {
      expect(errorText).toContain('nonExistentVariable');
      expect(errorText).toMatch(ERROR_PATTERNS_REGEX);
    },
  },
];

// Helper function to test with element
async function testEvaluateWithElement(
  client: Client,
  server: import('./testserver/index.js').TestServer,
  setup: string,
  evaluateArgs: { function: string; needsRef?: boolean },
  expectedCode: string | null,
  expectedResult: string | null
) {
  setServerContent(server, '/', setup);
  const navResponse = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  interface ResponseContent {
    text?: string;
  }
  const content = navResponse.content?.[0] as ResponseContent | undefined;
  const pageState = content?.text;
  const refMatch = pageState?.match(REF_PATTERN);
  const actualRef = refMatch ? refMatch[1] : 'e1';

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: evaluateArgs.function,
      selectors: [{ ref: actualRef }],
    },
  });

  if (expectedCode && expectedResult) {
    expect(result).toHaveResponse(
      expectCodeAndResult(expectedCode, expectedResult)
    );
  }
}

// Helper function to test without element
async function testEvaluateWithoutElement(
  client: Client,
  server: import('./testserver/index.js').TestServer,
  evaluateArgs: { function: string; needsRef?: boolean },
  expectedCode: string | null,
  expectedResult: string | null,
  expectError: boolean,
  errorCheck?: (text: string) => void
) {
  expect(
    await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.HELLO_WORLD },
    })
  ).toHaveResponse(expectPageTitle());

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: evaluateArgs.function,
    },
  });

  if (expectError) {
    expect(result.isError).toBe(true);
    if (errorCheck) {
      errorCheck(result.content?.[0]?.text || '');
    }
  } else if (expectedCode && expectedResult) {
    expect(result).toHaveResponse(
      expectCodeAndResult(expectedCode, expectedResult)
    );
  }
}

test('browser_evaluate: diveInIframes without selectors warns it is a no-op', async ({
  client,
  server,
}) => {
  // .foo lives only inside the iframe; the top document has none. A bare
  // () => {...} always runs in the top frame, so diveInIframes can't help here.
  setServerContent(
    server,
    '/',
    `<div class="top">top</div><iframe srcdoc='<div class="foo">a</div><div class="foo">b</div>'></iframe>`
  );
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  const result = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: '() => document.querySelectorAll(".foo").length',
      diveInIframes: true,
    },
  });

  const text = result.content?.[0]?.text || '';
  expect(text).toContain('`diveInIframes` was ignored');
  expect(text).toContain('contentDocument');
});

for (const {
  name,
  setup,
  evaluateArgs,
  expectedCode,
  expectedResult,
  expectError,
  errorCheck,
} of evaluateTestCases) {
  test(name, async ({ client, server }) => {
    if (setup && evaluateArgs.needsRef) {
      await testEvaluateWithElement(
        client,
        server,
        setup,
        evaluateArgs,
        expectedCode,
        expectedResult
      );
    } else if (!setup) {
      await testEvaluateWithoutElement(
        client,
        server,
        evaluateArgs,
        expectedCode,
        expectedResult,
        expectError ?? false,
        errorCheck
      );
    }
  });
}
