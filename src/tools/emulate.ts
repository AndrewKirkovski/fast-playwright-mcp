import type * as playwright from 'playwright';
import { z } from 'zod';
import { expectationSchema } from '../schemas/expectation.js';
import { defineTabTool } from './tool.js';

const colorSchemeEnum = z.enum(['light', 'dark', 'no-preference']);
const contrastEnum = z.enum(['no-preference', 'more']);
const forcedColorsEnum = z.enum(['active', 'none']);
const mediaEnum = z.enum(['screen', 'print']);
const reducedMotionEnum = z.enum(['reduce', 'no-preference']);

const emulateMediaSchema = z.object({
  colorScheme: colorSchemeEnum
    .nullable()
    .optional()
    .describe(
      'prefers-color-scheme. Pass null to disable emulation and fall back to system.'
    ),
  contrast: contrastEnum
    .nullable()
    .optional()
    .describe('prefers-contrast. Pass null to disable emulation.'),
  forcedColors: forcedColorsEnum
    .nullable()
    .optional()
    .describe('forced-colors. Pass null to disable emulation.'),
  media: mediaEnum
    .nullable()
    .optional()
    .describe(
      'CSS media type. "screen" or "print". Pass null to disable emulation.'
    ),
  reducedMotion: reducedMotionEnum
    .nullable()
    .optional()
    .describe('prefers-reduced-motion. Pass null to disable emulation.'),
  expectation: expectationSchema.describe('Page state after emulation change'),
});

type EmulateMediaOptions = NonNullable<
  Parameters<playwright.Page['emulateMedia']>[0]
>;

const emulateMedia = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_emulate_media',
    title: 'Emulate media features',
    description:
      'Emulate CSS media features (colorScheme, contrast, forcedColors, media, reducedMotion) via page.emulateMedia(). Pass null for a field to disable its emulation. Omit a field to leave it unchanged.',
    inputSchema: emulateMediaSchema,
    type: 'destructive',
  },
  handle: async (tab, params, response) => {
    const options: EmulateMediaOptions = {};
    if (params.colorScheme !== undefined) {
      options.colorScheme = params.colorScheme;
    }
    if (params.contrast !== undefined) {
      options.contrast = params.contrast;
    }
    if (params.forcedColors !== undefined) {
      options.forcedColors = params.forcedColors;
    }
    if (params.media !== undefined) {
      options.media = params.media;
    }
    if (params.reducedMotion !== undefined) {
      options.reducedMotion = params.reducedMotion;
    }

    if (Object.keys(options).length === 0) {
      response.addError(
        'Provide at least one of: colorScheme, contrast, forcedColors, media, reducedMotion.'
      );
      return;
    }

    response.addCode(`await page.emulateMedia(${JSON.stringify(options)});`);
    await tab.page.emulateMedia(options);
    response.addResult(
      `Emulated media: ${Object.entries(options)
        .map(([k, v]) => `${k}=${v === null ? 'null' : v}`)
        .join(', ')}`
    );
  },
});

export default [emulateMedia];
