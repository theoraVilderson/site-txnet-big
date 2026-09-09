module.exports = {
  displayName: 'worker-service',
  preset: '../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }]
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // `*.int.spec.ts` needs Docker; it runs from jest.int.config.cts instead.
  testPathIgnorePatterns: ['/node_modules/', '\\.int\\.spec\\.ts$'],
  coverageDirectory: '../coverage/worker-service'
};
