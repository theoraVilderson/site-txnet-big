/**
 * Runs before every backend spec file (`vitest.shared.mts` `setupFiles`).
 *
 * Under `test:affected` (VITEST_ISOLATE=0) spec files share a worker's module
 * cache. A file's `vi.mock` factories are its own, but the modules it loaded
 * through them stay cached: the next file then gets the previous file's fakes
 * — or keeps them where it wanted the real module. `grant-audit.spec.ts` and
 * `reseller-grants-bulk.spec.ts` failed each other that way, in one order or
 * the other (2026-09-28). Dropping the cache after each file ends that for
 * every spec, with no cleanup to remember per file; measured on billing-service
 * (1616 tests) at 12s with it against 13s without — the NestJS and
 * shared-core loads the shared worker saves stay saved.
 */
import { afterAll, vi } from 'vitest';

afterAll(() => {
  vi.resetModules();
});
