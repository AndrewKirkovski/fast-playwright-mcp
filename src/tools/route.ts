import type * as playwright from 'playwright';
import { z } from 'zod';
import type { RouteEntry } from '../context.js';
import { defineTool } from './tool.js';

function parseHeaderList(
  headers: string[] | undefined
): Record<string, string> | undefined {
  if (!headers) {
    return;
  }
  return Object.fromEntries(
    headers.map((h) => {
      const colon = h.indexOf(':');
      return [h.slice(0, colon).trim(), h.slice(colon + 1).trim()];
    })
  );
}

const route = defineTool({
  capability: 'network',
  schema: {
    name: 'browser_route',
    title: 'Mock network requests',
    description:
      'Intercept requests matching a URL pattern. With body/status it fulfills a mock response; otherwise it continues the request with header edits.',
    inputSchema: z.object({
      pattern: z
        .string()
        .describe('URL glob to match (e.g. "**/api/users", "**/*.{png,jpg}")'),
      status: z
        .number()
        .optional()
        .describe('HTTP status to return (default 200)'),
      body: z
        .string()
        .optional()
        .describe('Response body (text or JSON string)'),
      contentType: z
        .string()
        .optional()
        .describe('Content-Type header (e.g. "application/json")'),
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
    const removeHeaders = params.removeHeaders
      ? params.removeHeaders.split(',').map((h) => h.trim())
      : undefined;

    const handler = async (r: playwright.Route) => {
      if (params.body !== undefined || params.status !== undefined) {
        await r.fulfill({
          status: params.status ?? 200,
          contentType: params.contentType,
          body: params.body,
        });
        return;
      }
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
      await r.continue({ headers });
    };

    const entry: RouteEntry = {
      pattern: params.pattern,
      status: params.status,
      body: params.body,
      contentType: params.contentType,
      addHeaders,
      removeHeaders,
      handler,
    };
    await context.addRoute(entry);
    response.addResult(`Route added for pattern: ${params.pattern}`);
    response.addCode(
      `await page.context().route('${params.pattern}', async (route) => { /* mock */ });`
    );
  },
});

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
      const details: string[] = [];
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
      if (entry.addHeaders) {
        details.push(`addHeaders=${JSON.stringify(entry.addHeaders)}`);
      }
      if (entry.removeHeaders) {
        details.push(`removeHeaders=${entry.removeHeaders.join(',')}`);
      }
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
