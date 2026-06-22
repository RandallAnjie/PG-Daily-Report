// node:perf_hooks shim — bigrandall's workerd doesn't expose
// `node:perf_hooks`. porsager/postgres only uses
// `performance.now()` for reconnect-backoff timing; mapping it to
// `Date.now()` loses sub-millisecond precision but reconnect delays
// are measured in seconds anyway, so the imprecision is invisible.
export const performance = {
  now () { return Date.now() }
}
export default { performance }
