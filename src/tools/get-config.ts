import { z } from 'zod';
import { defineTool } from './tool.js';

const getConfig = defineTool({
  capability: 'config',
  schema: {
    name: 'browser_get_config',
    title: 'Get config',
    description:
      'Get the resolved MCP config after merging CLI options, environment variables and config file',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: (context, _params, response) => {
    // Drop any function-valued fields (e.g. launchOptions.logger) so the
    // config serializes cleanly.
    const json = JSON.stringify(
      context.config,
      (_key, value) => (typeof value === 'function' ? undefined : value),
      2
    );
    response.addResult(json);
    return Promise.resolve();
  },
});

export default [getConfig];
