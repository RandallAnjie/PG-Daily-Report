// node:fs shim — workers have no filesystem, and porsager/postgres
// only touches `fs.readFile` to load SSL cert / key files when the
// caller passes a path-as-string in the `ssl` option. We pass
// `ssl: 'require'` (a flag, not a path), so this code path is
// never reached. Stub the symbol so module load succeeds; throw
// if anything actually calls it.
export function readFile (_path, _opts, cb) {
  const e = new Error('fs.readFile not available in workerd')
  if (typeof cb === 'function') cb(e)
  else throw e
}
export const readFileSync = () => { throw new Error('fs.readFileSync not available in workerd') }
export default { readFile, readFileSync }
