import { z } from 'zod';
import { defineTool } from './tool.js';

const startTracing = defineTool({
  capability: 'devtools',
  schema: {
    name: 'browser_start_tracing',
    title: 'Start tracing',
    description:
      'Start recording a Playwright trace (screenshots + DOM snapshots). Conflicts with --save-trace.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },
  handle: async (context, _params, response) => {
    await context.startTracing();
    response.addResult(
      'Trace recording started. Call browser_stop_tracing to save it.'
    );
  },
});

const stopTracing = defineTool({
  capability: 'devtools',
  schema: {
    name: 'browser_stop_tracing',
    title: 'Stop tracing',
    description:
      'Stop trace recording and save it to a zip file in the output directory',
    inputSchema: z.object({
      filename: z
        .string()
        .optional()
        .describe('Output filename. Defaults to trace-<timestamp>.zip'),
    }),
    type: 'readOnly',
  },
  handle: async (context, params, response) => {
    const filename = params.filename ?? `trace-${Date.now()}.zip`;
    const path = await context.outputFile(filename);
    await context.stopTracing(path);
    response.addResult(
      `Trace saved to ${path}. Open it with: npx playwright show-trace ${path}`
    );
  },
});

export default [startTracing, stopTracing];
