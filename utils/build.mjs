// Build lib/ from src/ using esbuild (Node-only, no bun required).
//
// This is wired as the package `prepare` script so installing the fork straight
// from GitHub — `npx github:AndrewKirkovski/fast-playwright-mcp` — builds lib/
// during `npm install` (bun is not available in that environment). The dev loop
// can still use the faster `bun run build`; the two are equivalent (esbuild
// transpiles each src file 1:1 to lib/, preserving the .js import structure).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

await build({
  entryPoints: collectTsFiles('src'),
  outdir: 'lib',
  outbase: 'src',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // No `bundle: true` — transpile each file independently and keep imports
  // external, so the output mirrors src/ and resolves at runtime.
  logLevel: 'warning',
});
