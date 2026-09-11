import { backendVitestConfig } from '../vitest.shared.mts';

export default backendVitestConfig(import.meta.dirname, 'billing-service-e2e', {
  globalSetup: ['src/support/global-setup.ts', 'src/support/global-teardown.ts'],
  setupFiles: ['src/support/test-setup.ts'],
  passWithNoTests: true,
});
