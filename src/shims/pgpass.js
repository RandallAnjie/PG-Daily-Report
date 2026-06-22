// pgpass shim — node-postgres reaches for a ~/.pgpass file lookup
// when the caller hasn't passed an explicit password. Workers
// have no filesystem and we always pass PG_PASSWORD in env, so
// this code path is dead weight; stub it out to a no-op callback
// so the pg module loads without dragging in readline / fs / os.
//
// pgpass's exported function signature is `pgpass(config, cb)`;
// the callback receives the .pgpass-derived password (or empty
// when the file isn't found). Returning '' immediately lets pg
// proceed with whatever password the caller did pass.
export default function pgpass (_config, cb) {
  if (typeof cb === 'function') cb('')
}
