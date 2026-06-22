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
  // porsager/postgres reaches for two bare globals that Node
  // provides automatically but bigrandall's workerd doesn't expose
  // even under `nodejs_compat`:
  //
  //   Buffer  — used to encode every outgoing message frame.
  //             Sourced from `node:buffer`, which IS in the
  //             documented nodejs_compat surface.
  //   process — only `process.env.<PG…>` for default connection
  //             options when the caller doesn't pass them. We
  //             always pass them in src/worker.js openPg(), so a
  //             literal `{ env: {} }` stub satisfies the symbol
  //             lookup without dragging in node:process (which is
  //             absent on bigrandall).
  //
  // The banner sits at the very top of dist/_worker.js so it
  // executes before postgres' module evaluation reads either name.
  banner: {
    js:
      'import { Buffer } from "node:buffer"; ' +
      'globalThis.Buffer = Buffer; ' +
      'globalThis.process = globalThis.process || { env: {}, platform: "linux", versions: { node: "22.0.0" } };'
  },
  minify: false,
  sourcemap: false,
  logLevel: 'info'
})
