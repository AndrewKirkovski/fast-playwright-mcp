import type * as playwright from 'playwright';
import { z } from 'zod';
import type { NetworkConditions } from '../context.js';
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

const cacheSet = defineTool({
  capability: 'network',
  // CDP Network.setCacheDisabled has no Firefox/WebKit equivalent.
  chromiumOnly: true,
  schema: {
    name: 'browser_cache_set',
    title: 'Toggle HTTP cache',
    description:
      'Enable or disable the browser HTTP cache, like DevTools "Disable cache". ' +
      'Chromium-only (Chrome/Edge) — uses CDP; not registered on Firefox/WebKit. ' +
      'Applies to all tabs and persists across navigations and new tabs. ' +
      'Independent of offline mode — do not combine with browser_network_state_set ' +
      'offline (toggling offline while a cache/throttle override is active can ' +
      'wedge requests); use browser_network_reset to clear.',
    inputSchema: z.object({
      enabled: z
        .boolean()
        .describe(
          'true: normal caching. false: disable the cache so every request hits the network.'
        ),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    await context.setCacheEnabled(params.enabled);
    response.addResult(`HTTP cache ${params.enabled ? 'enabled' : 'disabled'}`);
    response.addCode(
      `// CDP Network.setCacheDisabled { cacheDisabled: ${!params.enabled} }`
    );
  },
});

// Approximate throttling profiles (bytes/sec, ms), matching the de-facto
// Puppeteer/DevTools "Slow 3G" / "Fast 3G" values; 4G entries are reasonable
// approximations. Bandwidth is bytes/sec; latency is added round-trip ms.
const THROTTLE_PRESETS = {
  'slow-3g': {
    downloadThroughput: 50_000,
    uploadThroughput: 50_000,
    latency: 2000,
  },
  'fast-3g': {
    downloadThroughput: 180_000,
    uploadThroughput: 84_375,
    latency: 563,
  },
  'slow-4g': {
    downloadThroughput: 500_000,
    uploadThroughput: 375_000,
    latency: 60,
  },
  'fast-4g': {
    downloadThroughput: 2_500_000,
    uploadThroughput: 1_250_000,
    latency: 20,
  },
} as const;

const THROTTLE_PRESET_NAMES = [
  'none',
  'slow-3g',
  'fast-3g',
  'slow-4g',
  'fast-4g',
] as const;

function kbpsToBytesPerSec(kbps: number): number {
  return Math.round((kbps * 1000) / 8);
}

function resolveThrottle(params: {
  preset?: (typeof THROTTLE_PRESET_NAMES)[number];
  downloadKbps?: number;
  uploadKbps?: number;
  latencyMs?: number;
}): { conditions: NetworkConditions | undefined; label: string } {
  if (params.preset === 'none') {
    return { conditions: undefined, label: 'cleared (no throttling)' };
  }
  if (params.preset) {
    return {
      conditions: THROTTLE_PRESETS[params.preset],
      label: params.preset,
    };
  }
  const hasCustom =
    params.downloadKbps !== undefined ||
    params.uploadKbps !== undefined ||
    params.latencyMs !== undefined;
  if (!hasCustom) {
    throw new Error(
      'Specify a preset or at least one of downloadKbps / uploadKbps / latencyMs.'
    );
  }
  return {
    conditions: {
      downloadThroughput:
        params.downloadKbps === undefined
          ? -1
          : kbpsToBytesPerSec(params.downloadKbps),
      uploadThroughput:
        params.uploadKbps === undefined
          ? -1
          : kbpsToBytesPerSec(params.uploadKbps),
      latency: params.latencyMs ?? 0,
    },
    label: `${params.downloadKbps ?? 'unlimited'} kbps down / ${params.uploadKbps ?? 'unlimited'} kbps up / ${params.latencyMs ?? 0}ms`,
  };
}

const throttle = defineTool({
  capability: 'network',
  // CDP Network.emulateNetworkConditions has no Firefox/WebKit equivalent.
  chromiumOnly: true,
  schema: {
    name: 'browser_throttle',
    title: 'Throttle network',
    description:
      'Emulate slow/limited network via CDP (bandwidth + latency). ' +
      'Chromium-only (Chrome/Edge); not registered on Firefox/WebKit. ' +
      'Pass a preset (use "none" to clear) OR custom downloadKbps/uploadKbps/latencyMs. ' +
      'Applies to all tabs and persists across navigations and new tabs. ' +
      'Independent of offline mode — do not combine with browser_network_state_set ' +
      'offline (toggling offline while throttling is active can wedge requests); ' +
      'use browser_network_reset to clear.',
    inputSchema: z.object({
      preset: z
        .enum(THROTTLE_PRESET_NAMES)
        .optional()
        .describe(
          'Profile: "none" clears throttling; otherwise an approximate mobile profile. Ignores custom fields when set.'
        ),
      downloadKbps: z
        .number()
        .positive()
        .optional()
        .describe('Custom download cap in kilobits/sec (omit for unlimited)'),
      uploadKbps: z
        .number()
        .positive()
        .optional()
        .describe('Custom upload cap in kilobits/sec (omit for unlimited)'),
      latencyMs: z
        .number()
        .nonnegative()
        .optional()
        .describe('Custom added latency in milliseconds'),
    }),
    type: 'destructive',
  },
  handle: async (context, params, response) => {
    const { conditions, label } = resolveThrottle(params);
    await context.setNetworkConditions(conditions);
    response.addResult(`Network throttling: ${label}`);
    response.addCode(
      `// CDP Network.emulateNetworkConditions ${JSON.stringify(conditions ?? { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })}`
    );
  },
});

const networkReset = defineTool({
  capability: 'network',
  schema: {
    name: 'browser_network_reset',
    title: 'Reset network customizations',
    description:
      'Clear all network customizations in one call: remove every route, ' +
      're-enable the HTTP cache, clear throttling, and go back online. ' +
      'Useful because cache/throttle/offline otherwise persist across navigations.',
    inputSchema: z.object({}),
    type: 'destructive',
  },
  handle: async (context, _params, response) => {
    await context.resetNetwork();
    response.addResult(
      'Network reset: routes removed, cache enabled, throttling cleared, online.'
    );
  },
});

export default [requests, networkState, cacheSet, throttle, networkReset];
