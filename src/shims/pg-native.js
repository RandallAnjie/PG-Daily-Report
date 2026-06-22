// pg-native shim — node-postgres optionally pulls in a C-bindings
// version of itself via libpq. workerd has no native add-on
// loading, so just throw and let pg's try/catch wrapper fall back
// to the pure-JS implementation. The throw message matches
// pg-native's real "module not installed" message close enough
// that pg's detection logic treats it as absent.
throw new Error("Cannot find module 'pg-native'")
