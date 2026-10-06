// Bundles the CLI (and MCP server) into one self-contained ESM file.
import { build } from 'esbuild';
import { readFileSync, rmSync, statSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
await build({
  entryPoints: ['src/cli.ts'],
  outdir: 'dist',
  // The MCP server (and its SDK) loads only for `go-tokenless mcp`.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
  define: { 'process.env.GO_TOKENLESS_VERSION': JSON.stringify(version) },
  banner: { js: `#!/usr/bin/env node\n// go-tokenless (MIT) https://github.com/Continuous-Actions/go-tokenless. Generated file, do not edit.\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);` },
});
console.log(`dist/cli.js: ${statSync('dist/cli.js').size} bytes`);
