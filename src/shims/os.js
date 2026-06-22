// node:os shim — bigrandall's workerd build doesn't ship the
// `node:os` module even with `nodejs_compat`, so `import os from
// 'os'` resolves to nothing and the isolate crashes at load time
// with `No such module "node:os"`. porsager/postgres only ever
// reaches into `os.userInfo()` for a default username when none
// is configured; we always set `PG_USER` in env so that branch
// never fires, but we still need the symbol to exist so the
// module loads.
//
// Same shape as the Node API — `userInfo()` returns an object
// with `.username`. Everything else throws if called so a future
// dependency picking up extra os surface fails loudly instead of
// silently misbehaving.

function notImplemented (name) {
  return () => { throw new Error(`os.${name}() not implemented in workerd shim`) }
}

export function userInfo () {
  return { username: 'workerd', uid: 0, gid: 0, shell: null, homedir: '/' }
}

export const hostname = notImplemented('hostname')
export const platform = () => 'linux'
export const arch = () => 'x64'
export const release = () => '0.0.0'
export const networkInterfaces = () => ({})
export const cpus = () => []
export const totalmem = () => 0
export const freemem = () => 0
export const tmpdir = () => '/tmp'
export const homedir = () => '/'
export const type = () => 'Linux'
export const uptime = () => 0
export const loadavg = () => [0, 0, 0]
export const endianness = () => 'LE'

export default {
  userInfo, hostname, platform, arch, release, networkInterfaces,
  cpus, totalmem, freemem, tmpdir, homedir, type, uptime, loadavg,
  endianness
}
