// esbuild wrapper. Bundles src/worker.js + postgres (porsager)
// into dist/_worker.js as a single ESM file, leaving node:* /
// cloudflare:* runtime imports external so workerd resolves them
// natively.
//
// dist/_worker.js path is the bigrandall pages-mode convention —
// the platform looks for it specifically at the output root.

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Two classes of node-builtin module:
//
//   EXTERNAL — bigrandall's workerd build registers these under
//   the `node:` prefix via the `nodejs_compat` compatibility flag.
//   We rewrite bare imports (`import 'crypto'`) to `node:crypto`
//   and mark them external so the runtime resolves them.
//
//   SHIMMED — modules workerd does NOT register even with
//   nodejs_compat (`node:os`, `node:perf_hooks`, `node:fs` as of
//   the bigrandall build randall is running). We resolve these to
//   tiny in-source shims at src/shims/* that cover just the API
//   surface porsager/postgres actually touches. Module load
//   succeeds; the runtime never tries to find them externally.
//
// If a future workerd upgrade ships node:os, just move 'os' from
// SHIMMED to EXTERNAL and the runtime takes over.
const EXTERNAL_BUILTINS = [
  'crypto', 'url', 'buffer', 'util', 'stream', 'events',
  'net', 'tls', 'string_decoder', 'querystring', 'path',
  'process', 'dns', 'http', 'https', 'zlib',
  'assert', 'punycode'
]
const SHIMMED_BUILTINS = {
  os: path.resolve(__dirname, 'src/shims/os.js'),
  fs: path.resolve(__dirname, 'src/shims/fs.js'),
  perf_hooks: path.resolve(__dirname, 'src/shims/perf_hooks.js'),
  // node-postgres' transitive `pgpass` dep wants readline to scan
  // a ~/.pgpass file. We always pass PG_PASSWORD in env so the
  // lookup is dead code; the pgpass module itself is shimmed at
  // the package level (alias below), so this readline shim never
  // executes in practice — it's just here so module resolution
  // doesn't blow up if some other dep starts importing readline.
  readline: path.resolve(__dirname, 'src/shims/fs.js')
}

// Some transitive deps that are useless in workerd. Resolve them
// to a one-line shim instead of pulling them into the bundle.
const ALIAS_MODULES = {
  pgpass: path.resolve(__dirname, 'src/shims/pgpass.js'),
  // `pg-native` is node-postgres' optional libpq-based C binding.
  // Workerd can't load native add-ons. pg checks for it in a
  // try/catch at module load time and falls back to the JS
  // implementation when the require throws, so we point it at a
  // shim that always throws.
  'pg-native': path.resolve(__dirname, 'src/shims/pg-native.js')
}

const nodeResolvePlugin = {
  name: 'node-resolve',
  setup (build) {
    const externalRe = new RegExp(
      `^(node:)?(${EXTERNAL_BUILTINS.join('|')})$`
    )
    const shimRe = new RegExp(
      `^(node:)?(${Object.keys(SHIMMED_BUILTINS).join('|')})$`
    )

    // Shimmed first so a name in both lists prefers the shim.
    build.onResolve({ filter: shimRe }, (args) => {
      const m = args.path.match(shimRe)
      return { path: SHIMMED_BUILTINS[m[2]] }
    })

    build.onResolve({ filter: externalRe }, (args) => {
      const m = args.path.match(externalRe)
      return { path: `node:${m[2]}`, external: true }
    })

    build.onResolve({ filter: /^cloudflare:/ }, (args) => {
      return { path: args.path, external: true }
    })

    // Alias select transitive packages to local shims (e.g. pgpass).
    const aliasRe = new RegExp(`^(${Object.keys(ALIAS_MODULES).join('|')})$`)
    build.onResolve({ filter: aliasRe }, (args) => {
      return { path: ALIAS_MODULES[args.path] }
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
  plugins: [nodeResolvePlugin],
  // The bundle is ESM but pg (node-postgres) is a pure-CommonJS
  // package. esbuild faithfully reproduces every `require('node:
  // X')` it finds inside pg as a call to its own `__require`
  // helper — which, on workerd, throws "Dynamic require of …
  // is not supported" because workerd ESM has no runtime
  // `require`. We sidestep that by:
  //
  //   1. Statically importing every node-builtin module our deps
  //      actually use (the externals seen with
  //      `grep require dist/_worker.js`), so they're available at
  //      module load time without a dynamic require.
  //   2. Installing a `globalThis.require` shim that looks up the
  //      requested name in a pre-built table. esbuild's __require
  //      helper detects this via `typeof require !== "undefined"`
  //      and routes its calls through our shim.
  //   3. Also installing Buffer + process on globalThis since pg
  //      relies on Node's automatic globals for both.
  banner: {
    js:
      'import * as __M_buffer from "node:buffer";' +
      'import * as __M_crypto from "node:crypto";' +
      'import * as __M_dns from "node:dns";' +
      'import * as __M_events from "node:events";' +
      'import * as __M_net from "node:net";' +
      'import * as __M_stream from "node:stream";' +
      'import * as __M_tls from "node:tls";' +
      'import * as __M_util from "node:util";' +
      'const __NODE_MODS = {' +
        '"node:buffer": __M_buffer.default ?? __M_buffer,' +
        '"node:crypto": __M_crypto.default ?? __M_crypto,' +
        '"node:dns":    __M_dns.default    ?? __M_dns,' +
        '"node:events": __M_events.default ?? __M_events,' +
        '"node:net":    __M_net.default    ?? __M_net,' +
        '"node:stream": __M_stream.default ?? __M_stream,' +
        '"node:tls":    __M_tls.default    ?? __M_tls,' +
        '"node:util":   __M_util.default   ?? __M_util,' +
      '};' +
      'for (const k of Object.keys(__NODE_MODS)) ' +
        '__NODE_MODS[k.replace("node:","")] = __NODE_MODS[k];' +
      'globalThis.Buffer = __M_buffer.Buffer;' +
      'globalThis.process = globalThis.process || ' +
        '{ env: {}, platform: "linux", versions: { node: "22.0.0" } };' +
      'globalThis.require = (m) => {' +
        'if (__NODE_MODS[m]) return __NODE_MODS[m];' +
        'throw new Error("Dynamic require of \\""+m+"\\" not in node-mod table");' +
      '};'
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info'
})
