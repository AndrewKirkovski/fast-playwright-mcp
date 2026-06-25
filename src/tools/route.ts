import type * as playwright from 'playwright';
import { z } from 'zod';
import type { RouteEntry } from '../context.js';
import { defineTool } from './tool.js';

// Valid error codes for route.abort() (Playwright). Default is 'failed'.
const ABORT_ERROR_CODES = [
  'aborted',
  'accessdenied',
  'addressunreachable',
  'blockedbyclient',
  'blockedbyresponse',
  'connectionaborted',
  'connectionclosed',
  'connectionfailed',
  'connectionrefused',
  'connectionreset',
  'internetdisconnected',
  'namenotresolved',
  'timedout',
  'failed',
] as const;

function parseHeaderList(
  headers: string[] | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return;
  }
  return Object.fromEntries(
    headers.map((h) => {
      const colon = h.indexOf(':');
      if (colon === -1) {
        throw new Error(
          `Invalid header "${h}" — expected "Name: Value" format.`
        );
      }
      return [h.slice(0, colon).trim(), h.slice(colon + 1).trim()];
    })
  );
}

// Apply the request-header edits (add/remove) on top of the live request's
// headers. Shared by the pass-through (fallback) and modify-response paths.
function buildRequestHeaders(
  r: playwright.Route,
  addHeaders: Record<string, string> | undefined,
  removeHeaders: string[] | undefined
): Record<string, string> {
  let headers = { ...r.request().headers() };
  if (addHeaders) {
    headers = { ...headers, ...addHeaders };
  }
  if (removeHeaders) {
    const drop = new Set(removeHeaders.map((h) => h.toLowerCase()));
    headers = Object.fromEntries(
      Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase()))
    );
  }
  return headers;
}

const route = defineTool({
  capability: 'network',
  schema: {
    name: 'browser_route',
    title: 'Mock network requests',
    description:
      'Intercept requests matching a URL pattern. Modes (first match wins): ' +
      '(1) abort=true fails the request (simulate a network error); ' +
      '(2) modifyResponse=true fetches the real response, then overlays any ' +
      'status/body/contentType/responseHeaders you supply; ' +
      '(3) any of status/body/contentType/responseHeaders set returns a pure ' +
      'mock; (4) otherwise the request continues with request-header edits.',
    inputSchema: z.object({
      pattern: z
        .string()
        .describe('URL glob to match (e.g. "**/api/users", "**/*.{png,jpg}")'),
      abort: z
        .boolean()
        .optional()
        .describe('Fail the request instead of responding (network error)'),
      abortErrorCode: z
        .enum(ABORT_ERROR_CODES)
        .optional()
        .describe('Failure reason (requires abort=true; default "failed")'),
      modifyResponse: z
        .boolean()
        .optional()
        .describe(
          'Fetch the real response first, then overlay the fields below. Uses a ' +
            'server-side fetch, so it is not subject to throttle/offline, and it ' +
            'still honors --allowed-origins/--blocked-origins.'
        ),
      status: z
        .number()
        .optional()
        .describe('HTTP status to return (default 200 for a pure mock)'),
      body: z
        .string()
        .optional()
        .describe('Response body (text or JSON string)'),
      contentType: z
        .string()
        .optional()
        .describe('Content-Type header (e.g. "application/json")'),
      responseHeaders: z
        .array(z.string())
        .optional()
        .describe('Response headers to set, each "Name: Value"'),
      headers: z
        .array(z.string())
        .optional()
        .describe('Request headers to add, each "Name: Value"'),
      removeHeaders: z
        .string()
        .optional()
        .describe('Comma-separated request header names to remove'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const addHeaders = parseHeaderList(params.headers);
    const responseHeaders = parseHeaderList(params.responseHeaders);
    const removeHeaders = params.removeHeaders
      ? params.removeHeaders.split(',').map((h) => h.trim())
      : undefined;
    // Pure mock if the caller supplied any response-shaping field.
    const wantsMock =
      params.status !== undefined ||
      params.body !== undefined ||
      params.contentType !== undefined ||
      responseHeaders !== undefined;

    const handler = async (r: playwright.Route) => {
      if (params.abort) {
        await r.abort(params.abortErrorCode ?? 'failed');
        return;
      }
      if (params.modifyResponse) {
        // route.fetch() is a server-side request that bypasses the route-based
        // allowed/blocked-origins guard, so enforce the policy here.
        if (context.isRequestBlockedByPolicy(r.request().url())) {
          await r.abort('blockedbyclient');
          return;
        }
        const real = await r.fetch({
          headers: buildRequestHeaders(r, addHeaders, removeHeaders),
        });
        await r.fulfill({
          response: real,
          status: params.status,
          contentType: params.contentType,
          // Overlay onto the real response's headers (not replace them), so
          // setting one header keeps the rest of the upstream headers intact.
          headers: responseHeaders
            ? { ...real.headers(), ...responseHeaders }
            : undefined,
          body: params.body,
        });
        return;
      }
      if (wantsMock) {
        await r.fulfill({
          status: params.status ?? 200,
          contentType: params.contentType,
          headers: responseHeaders,
          body: params.body,
        });
        return;
      }
      // Use fallback (not continue) so other matching handlers — notably the
      // config's allowedOrigins/blockedOrigins routes registered earlier — still
      // run. continue() is terminal and would let a user route bypass a block.
      await r.fallback({
        headers: buildRequestHeaders(r, addHeaders, removeHeaders),
      });
    };

    const entry: RouteEntry = {
      pattern: params.pattern,
      abort: params.abort,
      abortErrorCode: params.abortErrorCode,
      status: params.status,
      body: params.body,
      contentType: params.contentType,
      responseHeaders,
      modifyResponse: params.modifyResponse,
      addHeaders,
      removeHeaders,
      handler,
    };
    await context.addRoute(entry);
    response.addResult(`Route added for pattern: ${params.pattern}`);
    response.addCode(
      `await page.context().route('${params.pattern}', async (route) => { /* ${describeMode(params.abort, params.modifyResponse, wantsMock)} */ });`
    );
  },
});

function describeMode(
  abort: boolean | undefined,
  modifyResponse: boolean | undefined,
  wantsMock: boolean
): string {
  if (abort) {
    return 'abort';
  }
  if (modifyResponse) {
    return 'modify real response';
  }
  if (wantsMock) {
    return 'mock';
  }
  return 'continue with header edits';
}

function routeEntryDetails(entry: RouteEntry): string[] {
  const details: string[] = [];
  if (entry.abort) {
    details.push(`abort=${entry.abortErrorCode ?? 'failed'}`);
  }
  if (entry.modifyResponse) {
    details.push('modifyResponse');
  }
  if (entry.status !== undefined) {
    details.push(`status=${entry.status}`);
  }
  if (entry.body !== undefined) {
    const preview =
      entry.body.length > 50 ? `${entry.body.slice(0, 50)}...` : entry.body;
    details.push(`body=${preview}`);
  }
  if (entry.contentType) {
    details.push(`contentType=${entry.contentType}`);
  }
  if (entry.responseHeaders) {
    details.push(`responseHeaders=${JSON.stringify(entry.responseHeaders)}`);
  }
  if (entry.addHeaders) {
    details.push(`addHeaders=${JSON.stringify(entry.addHeaders)}`);
  }
  if (entry.removeHeaders) {
    details.push(`removeHeaders=${entry.removeHeaders.join(',')}`);
  }
  return details;
}

const routeList = defineTool({
  capability: 'network',
  schema: {
    name: 'browser_route_list',
    title: 'List network routes',
    description: 'List all active network routes registered via browser_route',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: (context, _params, response) => {
    const routes = context.routes();
    if (routes.length === 0) {
      response.addResult('No active routes');
      return Promise.resolve();
    }
    const lines = routes.map((entry, i) => {
      const details = routeEntryDetails(entry);
      const detailsStr = details.length ? ` (${details.join(', ')})` : '';
      return `${i + 1}. ${entry.pattern}${detailsStr}`;
    });
    response.addResult(lines.join('\n'));
    return Promise.resolve();
  },
});

const unroute = defineTool({
  capability: 'network',
  schema: {
    name: 'browser_unroute',
    title: 'Remove network routes',
    description:
      'Remove network routes matching a pattern, or all routes if no pattern is given',
    inputSchema: z.object({
      pattern: z
        .string()
        .optional()
        .describe('URL pattern to remove (omit to remove all routes)'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const removed = await context.removeRoute(params.pattern);
    response.addResult(
      params.pattern
        ? `Removed ${removed} route(s) for pattern: ${params.pattern}`
        : `Removed all ${removed} route(s)`
    );
  },
});

export default [route, routeList, unroute];
