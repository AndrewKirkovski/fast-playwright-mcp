import { z } from 'zod';
import { expectationSchema } from '../schemas/expectation.js';
import {
  generateMouseClickCode,
  generateMouseDragCode,
  generateMouseMoveCode,
} from '../utils/common-formatters.js';
import { baseElementSchema } from './base-tool-handler.js';
import { defineTabTool } from './tool.js';

// Simplified element schema for mouse operations (no ref required)
const elementSchema = baseElementSchema
  .pick({ element: true })
  .required({ element: true });
const mouseMove = defineTabTool({
  capability: 'vision',
  schema: {
    name: 'browser_mouse_move_xy',
    title: 'Move mouse',
    description:
      'Move mouse to specific coordinates.Requires --caps=vision.x,y:coordinates.expectation:{includeSnapshot:false} for simple move,true to see hover effects.PREFER element-based interactions over coordinates when possible.',
    inputSchema: elementSchema.extend({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      expectation: expectationSchema,
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    response.addCode(`// Move mouse to (${params.x}, ${params.y})`);
    response.addCode(generateMouseMoveCode(params.x, params.y));
    await tab.waitForCompletion(async () => {
      await tab.page.mouse.move(params.x, params.y);
    });
  },
});
const mouseClick = defineTabTool({
  capability: 'vision',
  schema: {
    name: 'browser_mouse_click_xy',
    title: 'Click',
    description: 'Click at specific coordinates',
    inputSchema: elementSchema.extend({
      x: z.number().describe('X coordinate (requires --caps=vision)'),
      y: z.number().describe('Y coordinate (requires --caps=vision)'),
      expectation: expectationSchema.describe(
        'Page state after click. Prefer element ref over coords'
      ),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addCode(
      `// Click mouse at coordinates (${params.x}, ${params.y})`
    );
    response.addCode(generateMouseMoveCode(params.x, params.y));
    for (const code of generateMouseClickCode()) {
      response.addCode(code);
    }
    await tab.waitForCompletion(async () => {
      await tab.page.mouse.move(params.x, params.y);
      await tab.page.mouse.down();
      await tab.page.mouse.up();
    });
  },
});
const mouseDrag = defineTabTool({
  capability: 'vision',
  schema: {
    name: 'browser_mouse_drag_xy',
    title: 'Drag mouse',
    description: 'Drag from one coordinate to another',
    inputSchema: elementSchema.extend({
      startX: z.number().describe('Start X (requires --caps=vision)'),
      startY: z.number().describe('Start Y (requires --caps=vision)'),
      endX: z.number().describe('End X'),
      endY: z.number().describe('End Y'),
      expectation: expectationSchema.describe(
        'Page state after drag. Prefer element refs over coords'
      ),
    }),
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    for (const code of generateMouseDragCode(
      params.startX,
      params.startY,
      params.endX,
      params.endY
    )) {
      response.addCode(code);
    }
    await tab.waitForCompletion(async () => {
      await tab.page.mouse.move(params.startX, params.startY);
      await tab.page.mouse.down();
      await tab.page.mouse.move(params.endX, params.endY);
      await tab.page.mouse.up();
    });
  },
});
const mouseWheel = defineTabTool({
  capability: 'vision',
  schema: {
    name: 'browser_mouse_wheel',
    title: 'Scroll wheel',
    description:
      'Scroll the page with the mouse wheel by a pixel delta. Requires --caps=vision.',
    inputSchema: z.object({
      deltaX: z
        .number()
        .optional()
        .describe('Horizontal scroll in pixels (default 0)'),
      deltaY: z
        .number()
        .describe('Vertical scroll in pixels; positive scrolls down'),
      expectation: expectationSchema,
    }),
    type: 'readOnly',
  },
  handle: async (tab, params, response) => {
    const deltaX = params.deltaX ?? 0;
    response.addCode(`await page.mouse.wheel(${deltaX}, ${params.deltaY});`);
    await tab.waitForCompletion(async () => {
      await tab.page.mouse.wheel(deltaX, params.deltaY);
    });
  },
});
export default [mouseMove, mouseClick, mouseDrag, mouseWheel];
