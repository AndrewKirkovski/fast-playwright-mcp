/**
 * browser_find_elements Tool Tests
 */

import { expect, test } from './fixtures.js';
import {
  expectFindElementsNoMatches,
  expectFindElementsSuccess,
  FIND_ELEMENTS_HTML_TEMPLATES,
  setupFindElementsTest,
} from './test-helpers.js';

test('browser_find_elements - find by multiple criteria', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.MULTI_CRITERIA_ELEMENTS,
    {
      text: 'Submit',
      role: 'button',
    },
    { maxResults: 5 }
  );

  expectFindElementsSuccess(result);
});

test('browser_find_elements - find by tag name', async ({ client, server }) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.FORM_WITH_INPUTS,
    { tagName: 'input' },
    { maxResults: 10 }
  );

  expectFindElementsSuccess(result);
});

test('browser_find_elements - find by attributes', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.BUTTONS_WITH_DATA_ACTION,
    {
      attributes: {
        'data-action': 'save',
      },
    }
  );

  expectFindElementsSuccess(result);
});

test('browser_find_elements - handle no matches', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.NO_BUTTONS_CONTENT,
    { role: 'button' }
  );

  expectFindElementsNoMatches(result);
});

test('browser_find_elements - limit results', async ({ client, server }) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.MULTIPLE_BUTTONS(10),
    { tagName: 'button' },
    { maxResults: 3 }
  );

  expectFindElementsSuccess(result);
});

// Regression coverage for https://github.com/tontoko/fast-playwright-mcp/issues/27
// Previously findByRole used `page.$$('[role="${role}"]')` which only matched
// elements with an explicit role="" attribute, so <h1>, <p>, <hr>, a bare
// <button>, and <a href> were all invisible to role-based search.
test('browser_find_elements - role heading finds implicit h1/h2', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.IMPLICIT_ROLE_ELEMENTS,
    { role: 'heading' }
  );

  expectFindElementsSuccess(result);
  expect(result.content[0].text).toContain('Found 2 elements');
  expect(result.content[0].text).toContain('role match: "heading"');
});

test('browser_find_elements - role paragraph finds implicit p', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.IMPLICIT_ROLE_ELEMENTS,
    { role: 'paragraph' }
  );

  expectFindElementsSuccess(result);
  expect(result.content[0].text).toContain('Found 2 elements');
  expect(result.content[0].text).toContain('role match: "paragraph"');
});

test('browser_find_elements - role separator finds implicit hr', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.IMPLICIT_ROLE_ELEMENTS,
    { role: 'separator' }
  );

  expectFindElementsSuccess(result);
  expect(result.content[0].text).toContain('Found 1 elements');
  expect(result.content[0].text).toContain('role match: "separator"');
});

test('browser_find_elements - role button finds bare button and role=button div', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.IMPLICIT_ROLE_ELEMENTS,
    { role: 'button' }
  );

  expectFindElementsSuccess(result);
  expect(result.content[0].text).toContain('Found 2 elements');
  expect(result.content[0].text).toContain('role match: "button"');
});

test('browser_find_elements - role link finds implicit a[href]', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.IMPLICIT_ROLE_ELEMENTS,
    { role: 'link' }
  );

  expectFindElementsSuccess(result);
  expect(result.content[0].text).toContain('Found 1 elements');
  expect(result.content[0].text).toContain('role match: "link"');
});

test('browser_find_elements - unknown role returns no matches without throwing', async ({
  client,
  server,
}) => {
  const result = await setupFindElementsTest(
    client,
    server,
    FIND_ELEMENTS_HTML_TEMPLATES.IMPLICIT_ROLE_ELEMENTS,
    { role: 'not-a-real-role' }
  );

  expectFindElementsNoMatches(result);
});
