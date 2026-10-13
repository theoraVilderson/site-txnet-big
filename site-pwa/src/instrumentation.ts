/**
 * Runs once when the Next server starts (Node runtime).
 *
 * Boots the locale gRPC client here so that:
 *  - every language is fetched *once* and held in this process's memory,
 *  - the Watch stream opens and updates arrive from locale-service on their own,
 *  - the boot cost does not land on the first visitor's request (why the
 *    panel's language came late after every restart).
 *
 * A failed boot here is only logged; `ensureReady` retries on the request
 * path, and rendering carries on with the fallback until then.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initStore } = await import("@/lib/locale-catalog");
  const { startWatching } = await import("@/lib/locale-watcher");

  try {
    await initStore();
    await startWatching();
    console.info("[locale] warmed at server boot");
  } catch (e) {
    console.error(
      "[locale] boot warm-up failed — will retry on first request",
      e,
    );
  }
}
