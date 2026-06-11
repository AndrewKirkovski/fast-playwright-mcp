import { z } from 'zod';
import { defineTool } from './tool.js';

// Keys whose values may carry credentials/secrets and must never be sent to the
// LLM. Matched case-insensitively; the whole value is replaced.
const SENSITIVE_KEYS = new Set([
  'password',
  'passphrase',
  'httpcredentials',
  'storagestate',
  'clientcertificates',
  'cdpheaders',
  'proxy',
  'secrets',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (typeof val === 'function') {
        continue;
      }
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? '[redacted]'
        : redact(val);
    }
    return out;
  }
  return value;
}

const getConfig = defineTool({
  capability: 'config',
  schema: {
    name: 'browser_get_config',
    title: 'Get config',
    description:
      'Get the resolved MCP config (with credential fields redacted) after merging CLI options, environment variables and config file',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: (context, _params, response) => {
    response.addResult(JSON.stringify(redact(context.config), null, 2));
    return Promise.resolve();
  },
});

export default [getConfig];
