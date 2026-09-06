/**
 * End-to-end specs for `auth-service`: the real app, over HTTP (supertest),
 * against a real Postgres and a real Redis in containers.
 *
 * They need Docker and take minutes, so they are their own project and are
 * not part of `nx run-many -t test`:
 *   npm run test:e2e            (or `npx nx e2e auth-service-e2e`)
 */
module.exports = {
  displayName: 'auth-service-e2e',
  preset: '../jest.preset.js',
  rootDir: __dirname,
  testEnvironment: 'node',
  globalSetup: '<rootDir>/src/support/global-setup.ts',
  globalTeardown: '<rootDir>/src/support/global-teardown.ts',
  setupFiles: ['<rootDir>/src/support/test-setup.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['<rootDir>/src/**/*.e2e.spec.ts'],
  // One database and one Redis are shared by the whole run, and every spec
  // wipes them between tests — so the files must not overlap in time.
  maxWorkers: 1,
  testTimeout: 120_000,
  coverageDirectory: '../coverage/auth-service-e2e',
};
