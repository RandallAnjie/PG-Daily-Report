// esbuild wrapper. Bundles src/worker.js + postgres (porsager)
// into dist/_worker.js as a single ESM file, leaving node:* /
// cloudflare:* runtime imports external so workerd resolves them
// natively.
//
// dist/_worker.js path is the bigrandall pages-mode convention —
// the platform looks for it specifically at the output root.

import { build } from 'esbuild'

const NODE_BUILTINS = [
  'crypto', 'url', 'buffer', 'util', 'stream', 'events',
  'net', 'tls', 'string_decoder', 'querystring', 'path',
  'os', 'process', 'fs', 'dns', 'http', 'https', 'zlib',
  'assert', 'punycode', 'perf_hooks'
]

const external = [
  ...NODE_BUILTINS,
  ...NODE_BUILTINS.map((n) => `node:${n}`),
  'cloudflare:sockets',
  'cloudflare:email'
]

await build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/_worker.js',
  external,
  minify: false,
  sourcemap: false,
  logLevel: 'info'
})
