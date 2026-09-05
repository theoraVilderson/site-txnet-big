/**
 * Integration specs (`*.int.spec.ts`): they start a real Redis in a container,
 * so they are kept out of the unit run and given a container-sized timeout.
 *   npm run test:int
 */
module.exports = {
  displayName: 'auth-service:int',
  preset: '../jest.preset.js',
  rootDir: __dirname,
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }]
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['<rootDir>/src/**/*.int.spec.ts'],
  testTimeout: 180_000,
  coverageDirectory: '../coverage/auth-service-int'
};
