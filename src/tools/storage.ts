import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type * as playwright from 'playwright';
import { z } from 'zod';
import { defineTabTool, defineTool } from './tool.js';

// ---------------------------------------------------------------------------
// Cookies (context level)
// ---------------------------------------------------------------------------

const cookieList = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_cookie_list',
    title: 'List cookies',
    description: 'List all cookies, optionally filtered by domain/path',
    inputSchema: z.object({
      domain: z
        .string()
        .optional()
        .describe('Filter cookies by domain substring'),
      path: z.string().optional().describe('Filter cookies by path prefix'),
    }),
    type: 'readOnly',
  },
  handle: async (context, params, response) => {
    const browserContext = await context.ensureBrowserContext();
    let cookies = await browserContext.cookies();
    const { domain, path } = params;
    if (domain) {
      cookies = cookies.filter((c) => c.domain.includes(domain));
    }
    if (path) {
      cookies = cookies.filter((c) => c.path.startsWith(path));
    }
    if (cookies.length === 0) {
      response.addResult('No cookies found');
    } else {
      response.addResult(
        cookies
          .map(
            (c) => `${c.name}=${c.value} (domain: ${c.domain}, path: ${c.path})`
          )
          .join('\n')
      );
    }
    response.addCode('await page.context().cookies();');
  },
});

const cookieGet = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_cookie_get',
    title: 'Get cookie',
    description: 'Get a specific cookie by name',
    inputSchema: z.object({
      name: z.string().describe('Cookie name to get'),
    }),
    type: 'readOnly',
  },
  handle: async (context, params, response) => {
    const browserContext = await context.ensureBrowserContext();
    const cookies = await browserContext.cookies();
    const cookie = cookies.find((c) => c.name === params.name);
    if (cookie) {
      response.addResult(
        `${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path}, httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure}, sameSite: ${cookie.sameSite})`
      );
    } else {
      response.addResult(`Cookie '${params.name}' not found`);
    }
    response.addCode('await page.context().cookies();');
  },
});

const cookieSet = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_cookie_set',
    title: 'Set cookie',
    description:
      'Set a cookie with optional flags (domain, path, expires, httpOnly, secure, sameSite). Domain defaults to the current page host.',
    inputSchema: z.object({
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
      domain: z.string().optional().describe('Cookie domain'),
      path: z.string().optional().describe('Cookie path'),
      expires: z
        .number()
        .optional()
        .describe('Expiration as a Unix timestamp (seconds)'),
      httpOnly: z
        .boolean()
        .optional()
        .describe('Whether the cookie is HTTP only'),
      secure: z.boolean().optional().describe('Whether the cookie is secure'),
      sameSite: z
        .enum(['Strict', 'Lax', 'None'])
        .optional()
        .describe('SameSite attribute'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const browserContext = await context.ensureBrowserContext();
    let domain = params.domain;
    if (!domain) {
      const url = context.currentTab()?.page.url();
      const host = url && url !== 'about:blank' ? new URL(url).hostname : '';
      if (!host) {
        response.addError(
          'Cookie domain is required when no page is loaded. Provide `domain` or navigate to a page first.'
        );
        return;
      }
      domain = host;
    }
    const cookie: Parameters<
      playwright.BrowserContext['addCookies']
    >[0][number] = {
      name: params.name,
      value: params.value,
      domain,
      path: params.path ?? '/',
      ...(params.expires === undefined ? {} : { expires: params.expires }),
      ...(params.httpOnly === undefined ? {} : { httpOnly: params.httpOnly }),
      ...(params.secure === undefined ? {} : { secure: params.secure }),
      ...(params.sameSite === undefined ? {} : { sameSite: params.sameSite }),
    };
    await browserContext.addCookies([cookie]);
    response.addResult(`Cookie '${params.name}' set`);
    response.addCode(
      `await page.context().addCookies([${JSON.stringify(cookie)}]);`
    );
  },
});

const cookieDelete = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_cookie_delete',
    title: 'Delete cookie',
    description: 'Delete a specific cookie by name',
    inputSchema: z.object({
      name: z.string().describe('Cookie name to delete'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const browserContext = await context.ensureBrowserContext();
    await browserContext.clearCookies({ name: params.name });
    response.addCode(
      `await page.context().clearCookies({ name: ${JSON.stringify(params.name)} });`
    );
  },
});

const cookieClear = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_cookie_clear',
    title: 'Clear cookies',
    description: 'Clear all cookies',
    inputSchema: z.object({}),
    type: 'destructive',
  },
  handle: async (context, _params, response) => {
    const browserContext = await context.ensureBrowserContext();
    await browserContext.clearCookies();
    response.addCode('await page.context().clearCookies();');
  },
});

// ---------------------------------------------------------------------------
// Web storage (localStorage / sessionStorage — page level)
// ---------------------------------------------------------------------------

type WebStorageKind = 'localStorage' | 'sessionStorage';

function listWebStorage(kind: WebStorageKind) {
  return defineTabTool({
    capability: 'storage',
    schema: {
      name: `browser_${kind === 'localStorage' ? 'localstorage' : 'sessionstorage'}_list`,
      title: `List ${kind}`,
      description: `List all ${kind} key-value pairs for the current origin`,
      inputSchema: z.object({}),
      type: 'readOnly',
    },
    handle: async (tab, _params, response) => {
      const items = await tab.page.evaluate((storageKind) => {
        const store = window[storageKind as 'localStorage' | 'sessionStorage'];
        const result: { key: string; value: string }[] = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key !== null) {
            result.push({ key, value: store.getItem(key) ?? '' });
          }
        }
        return result;
      }, kind);
      if (items.length === 0) {
        response.addResult(`No ${kind} items found`);
      } else {
        response.addResult(
          items.map((item) => `${item.key}=${item.value}`).join('\n')
        );
      }
      response.addCode(`await page.evaluate(() => ({ ...${kind} }));`);
    },
  });
}

function getWebStorage(kind: WebStorageKind) {
  return defineTabTool({
    capability: 'storage',
    schema: {
      name: `browser_${kind === 'localStorage' ? 'localstorage' : 'sessionstorage'}_get`,
      title: `Get ${kind} item`,
      description: `Get a ${kind} item by key`,
      inputSchema: z.object({ key: z.string().describe('Key to get') }),
      type: 'readOnly',
    },
    handle: async (tab, params, response) => {
      const value = await tab.page.evaluate(
        ({ storageKind, key }) =>
          window[storageKind as 'localStorage' | 'sessionStorage'].getItem(key),
        { storageKind: kind, key: params.key }
      );
      if (value === null) {
        response.addResult(`${kind} key '${params.key}' not found`);
      } else {
        response.addResult(`${params.key}=${value}`);
      }
      response.addCode(
        `await page.evaluate(() => ${kind}.getItem(${JSON.stringify(params.key)}));`
      );
    },
  });
}

function setWebStorage(kind: WebStorageKind) {
  return defineTabTool({
    capability: 'storage',
    schema: {
      name: `browser_${kind === 'localStorage' ? 'localstorage' : 'sessionstorage'}_set`,
      title: `Set ${kind} item`,
      description: `Set a ${kind} item`,
      inputSchema: z.object({
        key: z.string().describe('Key to set'),
        value: z.string().describe('Value to set'),
      }),
      type: 'destructive',
    },
    handle: async (tab, params, response) => {
      await tab.page.evaluate(
        ({ storageKind, key, value }) =>
          window[storageKind as 'localStorage' | 'sessionStorage'].setItem(
            key,
            value
          ),
        { storageKind: kind, key: params.key, value: params.value }
      );
      response.addCode(
        `await page.evaluate(() => ${kind}.setItem(${JSON.stringify(params.key)}, ${JSON.stringify(params.value)}));`
      );
    },
  });
}

function deleteWebStorage(kind: WebStorageKind) {
  return defineTabTool({
    capability: 'storage',
    schema: {
      name: `browser_${kind === 'localStorage' ? 'localstorage' : 'sessionstorage'}_delete`,
      title: `Delete ${kind} item`,
      description: `Delete a ${kind} item by key`,
      inputSchema: z.object({ key: z.string().describe('Key to delete') }),
      type: 'destructive',
    },
    handle: async (tab, params, response) => {
      await tab.page.evaluate(
        ({ storageKind, key }) =>
          window[storageKind as 'localStorage' | 'sessionStorage'].removeItem(
            key
          ),
        { storageKind: kind, key: params.key }
      );
      response.addCode(
        `await page.evaluate(() => ${kind}.removeItem(${JSON.stringify(params.key)}));`
      );
    },
  });
}

function clearWebStorage(kind: WebStorageKind) {
  return defineTabTool({
    capability: 'storage',
    schema: {
      name: `browser_${kind === 'localStorage' ? 'localstorage' : 'sessionstorage'}_clear`,
      title: `Clear ${kind}`,
      description: `Clear all ${kind} for the current origin`,
      inputSchema: z.object({}),
      type: 'destructive',
    },
    handle: async (tab, _params, response) => {
      await tab.page.evaluate((storageKind) => {
        window[storageKind as 'localStorage' | 'sessionStorage'].clear();
      }, kind);
      response.addCode(`await page.evaluate(() => ${kind}.clear());`);
    },
  });
}

// ---------------------------------------------------------------------------
// Storage state (auth/session snapshot + restore)
// ---------------------------------------------------------------------------

const storageState = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_storage_state',
    title: 'Save storage state',
    description:
      'Save storage state (cookies + local storage) to a JSON file in the output directory for later reuse with browser_set_storage_state',
    inputSchema: z.object({
      filename: z
        .string()
        .optional()
        .describe(
          'Output filename. Defaults to storage-state-<timestamp>.json'
        ),
    }),
    type: 'readOnly',
  },
  handle: async (context, params, response) => {
    const browserContext = await context.ensureBrowserContext();
    const state = await browserContext.storageState();
    const filename = params.filename ?? `storage-state-${Date.now()}.json`;
    const filePath = await context.outputFile(filename);
    await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    response.addResult(`Storage state saved to ${filePath}`);
    response.addCode(
      `await page.context().storageState({ path: ${JSON.stringify(filePath)} });`
    );
  },
});

const setStorageState = defineTool({
  capability: 'storage',
  schema: {
    name: 'browser_set_storage_state',
    title: 'Restore storage state',
    description:
      'Restore storage state (cookies + local storage) from a JSON file. Relative paths resolve against the output directory.',
    inputSchema: z.object({
      filename: z
        .string()
        .describe('Path to the storage state file to restore'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const browserContext = await context.ensureBrowserContext();
    const filePath = isAbsolute(params.filename)
      ? params.filename
      : await context.outputFile(params.filename);
    await browserContext.setStorageState(filePath);
    response.addResult(`Storage state restored from ${filePath}`);
    response.addCode(
      `await page.context().setStorageState(${JSON.stringify(filePath)});`
    );
  },
});

export default [
  cookieList,
  cookieGet,
  cookieSet,
  cookieDelete,
  cookieClear,
  listWebStorage('localStorage'),
  getWebStorage('localStorage'),
  setWebStorage('localStorage'),
  deleteWebStorage('localStorage'),
  clearWebStorage('localStorage'),
  listWebStorage('sessionStorage'),
  getWebStorage('sessionStorage'),
  setWebStorage('sessionStorage'),
  deleteWebStorage('sessionStorage'),
  clearWebStorage('sessionStorage'),
  storageState,
  setStorageState,
];
