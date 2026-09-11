/**
 * Integration specs (`*.int.spec.ts`): a real Postgres in a container, built
 * from the committed migration history (`test-support/postgres-fixture.ts`).
 *   npm run test:int
 */
import { backendVitestConfig } from '../vitest.shared.mts';

export default backendVitestConfig(import.meta.dirname, 'billing-service-int', {
  include: ['src/**/*.int.spec.ts'],
  exclude: ['**/node_modules/**'],
  testTimeout: 180_000,
  hookTimeout: 180_000,
});
