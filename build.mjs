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

// porsager/postgres internals do bare `import 'os'` /
// `import 'perf_hooks'` rather than `node:os`. Workerd's
// `nodejs_compat` only registers the prefixed names — a bare
// `import 'os'` lands at `__user__/os` and crashes the isolate
// at first request with `No such module "__user__/os"`. Rewrite
// every bare builtin to its `node:` form before externalising it.
const nodePrefixPlugin = {
  name: 'node-prefix',
  setup (build) {
    const re = new RegExp(`^(${NODE_BUILTINS.join('|')})$`)
    build.onResolve({ filter: re }, (args) => {
      return { path: `node:${args.path}`, external: true }
    })
    build.onResolve({ filter: /^node:/ }, (args) => {
      return { path: args.path, external: true }
    })
    build.onResolve({ filter: /^cloudflare:/ }, (args) => {
      return { path: args.path, external: true }
    })
  }
}

await build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/_worker.js',
  plugins: [nodePrefixPlugin],
  minify: false,
  sourcemap: false,
  logLevel: 'info'
})
