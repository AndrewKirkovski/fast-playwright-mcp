import type * as playwright from 'playwright';
import { z } from 'zod';
import {
  filterNetworkRequests,
  type NetworkFilterOptions,
  type NetworkRequest,
} from '../utils/network-filter.js';
import { defineTabTool, defineTool } from './tool.js';

const networkFilterSchema = z.object({
  urlPatterns: z
    .array(z.string())
    .optional()
    .describe('URL patterns to filter (supports regex)'),
  excludeUrlPatterns: z
    .array(z.string())
    .optional()
    .describe('URL patterns to exclude (takes precedence)'),
  statusRanges: z
    .array(
      z.object({
        min: z.number().describe('Minimum status code'),
        max: z.number().describe('Maximum status code'),
      })
    )
    .optional()
    .describe('Status code ranges (e.g., [{min:200,max:299}])'),
  methods: z.array(z.string()).optional().describe('HTTP methods to filter'),
  maxRequests: z
    .number()
    .default(20)
    .describe('Max requests to return (default: 20)'),
  newestFirst: z
    .boolean()
    .default(true)
    .describe('Order by timestamp (default: newest first)'),
});

const requests = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description:
      'Returns network requests since loading the page with optional filtering',
    inputSchema: networkFilterSchema.partial(),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    try {
      const requestList = await Promise.resolve(tab.requests());
      const requestEntries = Array.from(requestList.entries());

      const filterOptions = buildFilterOptions(params);
      const result = processNetworkRequests(requestEntries, filterOptions);

      displayFilterSummary(
        response,
        filterOptions,
        result.filteredCount,
        result.totalCount
      );
      displayResults(response, result.filteredRequests, result.totalCount);
    } catch (error) {
      response.addResult(
        `Error retrieving network requests: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
});

function hasFilterOptions(options: NetworkFilterOptions): boolean {
  return !!(
    options.urlPatterns?.length ||
    options.excludeUrlPatterns?.length ||
    options.statusRanges?.length ||
    options.methods?.length ||
    (options.maxRequests && options.maxRequests !== 20)
  );
}

function applyFilters(
  requestList: [playwright.Request, playwright.Response | null][],
  options: NetworkFilterOptions
): [playwright.Request, playwright.Response | null][] {
  // Convert to NetworkRequest format and use existing filter utility
  const networkRequests: NetworkRequest[] = requestList.map(
    ([request, response]) => ({
      url: request.url(),
      method: request.method(),
      status: response?.status(),
      statusText: response?.statusText() || '',
      headers: response?.headers() || {},
      timestamp: Date.now(),
      duration: undefined,
    })
  );

  const filtered = filterNetworkRequests(networkRequests, options);

  // Map back to original format
  return requestList.filter(([request]) =>
    filtered.some(
      (f) => f.url === request.url() && f.method === request.method()
    )
  );
}

function buildFilterOptions(
  params: Record<string, unknown>
): NetworkFilterOptions {
  return {
    urlPatterns: params.urlPatterns as string[] | undefined,
    excludeUrlPatterns: params.excludeUrlPatterns as string[] | undefined,
    statusRanges: params.statusRanges as
      | { min: number; max: number }[]
      | undefined,
    methods: params.methods as string[] | undefined,
    maxRequests: (params.maxRequests as number) ?? 20,
    newestFirst: (params.newestFirst as boolean | undefined) ?? true,
  };
}

function processNetworkRequests(
  requestEntries: [playwright.Request, playwright.Response | null][],
  filterOptions: NetworkFilterOptions
) {
  const totalCount = requestEntries.length;
  let filteredRequests = applyFilters(requestEntries, filterOptions);

  // Apply sorting for backward compatibility
  if (hasFilterOptions(filterOptions) && filterOptions.newestFirst === false) {
    filteredRequests = filteredRequests.slice().reverse();
  }

  // Apply max requests limit
  if (
    filterOptions.maxRequests &&
    filteredRequests.length > filterOptions.maxRequests
  ) {
    filteredRequests = filteredRequests.slice(0, filterOptions.maxRequests);
  }

  return {
    filteredRequests,
    filteredCount: filteredRequests.length,
    totalCount,
  };
}

function displayFilterSummary(
  response: { addResult: (message: string) => void },
  filterOptions: NetworkFilterOptions,
  filteredCount: number,
  totalCount: number
) {
  if (!hasFilterOptions(filterOptions)) {
    return;
  }

  response.addResult(
    `Filter Summary: ${filteredCount}/${totalCount} requests match criteria`
  );

  if (filterOptions.urlPatterns?.length) {
    response.addResult(
      `  URL patterns: ${filterOptions.urlPatterns.join(', ')}`
    );
  }
  if (filterOptions.excludeUrlPatterns?.length) {
    response.addResult(
      `  Exclude URL patterns: ${filterOptions.excludeUrlPatterns.join(', ')}`
    );
  }
  if (filterOptions.statusRanges?.length) {
    response.addResult(
      `  Status ranges: ${filterOptions.statusRanges.map((r) => `${r.min}-${r.max}`).join(', ')}`
    );
  }
  if (filterOptions.methods?.length) {
    response.addResult(`  Methods: ${filterOptions.methods.join(', ')}`);
  }
  if (filterOptions.maxRequests && filterOptions.maxRequests !== 20) {
    response.addResult(`  maxRequests: ${filterOptions.maxRequests}`);
  }
  response.addResult('');
}

function displayResults(
  response: { addResult: (message: string) => void },
  filteredRequests: [playwright.Request, playwright.Response | null][],
  totalCount: number
) {
  for (const [req, res] of filteredRequests) {
    response.addResult(renderRequest(req, res));
  }

  if (filteredRequests.length === 0 && totalCount > 0) {
    response.addResult('No requests match the specified filter criteria.');
  }
}

function renderRequest(
  request: playwright.Request,
  response: playwright.Response | null
) {
  const result: string[] = [];
  result.push(`[${request.method().toUpperCase()}] ${request.url()}`);
  if (response) {
    result.push(`=> [${response.status()}] ${response.statusText()}`);
  }
  return result.join(' ');
}

const networkState = defineTool({
  capability: 'network',
  schema: {
    name: 'browser_network_state_set',
    title: 'Set network state',
    description: 'Toggle the browser between online and offline',
    inputSchema: z.object({
      state: z.enum(['online', 'offline']).describe('Network state to apply'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const offline = params.state === 'offline';
    await context.setOffline(offline);
    response.addResult(`Network state set to ${params.state}`);
    response.addCode(`await page.context().setOffline(${offline});`);
  },
});

export default [requests, networkState];
