module.exports = {
  displayName: 'auth-service',
  preset: '../jest.preset.js',
  testEnvironment: 'node',
  // `isolatedModules` transpiles without type-checking: the suite runs in ~19s
  // instead of ~44s, and a unit's folder in ~8s. The type check is not dropped,
  // it moved — `npx tsc -p auth-service/tsconfig.spec.json --noEmit`, once,
  // before an item is declared done (AGENTS.md). Do not "fix" this back.
  // `transpilation` is the newer name for it and ts-jest 29.4 does not know it.
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.spec.json', isolatedModules: true },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // `*.int.spec.ts` needs Docker; it runs from jest.int.config.cts instead.
  testPathIgnorePatterns: ['/node_modules/', '\\.int\\.spec\\.ts$'],
  coverageDirectory: '../coverage/auth-service'
};
