import "server-only";

/**
 * Live reload now comes from locale-service over the gRPC Watch stream, which is
 * opened by `initStore()` (via the vendored client's `ready()`). There is no
 * in-process file watcher any more.
 *
 * `startWatching` is kept so existing call sites (`ensureReady(startWatching)`)
 * keep working — it is a no-op.
 */
export async function startWatching(): Promise<void> {
  /* no-op: the locale client's Watch stream is already running */
}
