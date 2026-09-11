/**
 * End-to-end specs for `auth-service`: the real app, over HTTP (supertest),
 * against a real Postgres and a real Redis in containers.
 *
 * They need Docker and take minutes, so they are their own project and are
 * not part of `nx run-many -t test`:
 *   npm run test:e2e            (or `npx nx e2e auth-service-e2e`)
 */
import { backendVitestConfig } from '../vitest.shared.mts';

export default backendVitestConfig(import.meta.dirname, 'auth-service-e2e', {
  include: ['src/**/*.e2e.spec.ts'],
  globalSetup: ['src/support/global-setup.ts', 'src/support/global-teardown.ts'],
  setupFiles: ['src/support/test-setup.ts'],
  // One database and one Redis are shared by the whole run, and every spec
  // wipes them between tests — so the files must not overlap in time.
  fileParallelism: false,
  testTimeout: 120_000,
  hookTimeout: 120_000,
});
