/**
 * Integration specs (`*.int.spec.ts`): they start a real server in a container
 * — Redis for the stores, Postgres for the tenant-isolation harness — so they
 * are kept out of the unit run and given a container-sized timeout.
 *   npm run test:int
 */
import { backendVitestConfig } from '../vitest.shared.mts';

export default backendVitestConfig(import.meta.dirname, 'auth-service-int', {
  include: ['src/**/*.int.spec.ts'],
  exclude: ['**/node_modules/**'],
  testTimeout: 180_000,
  hookTimeout: 180_000,
});
