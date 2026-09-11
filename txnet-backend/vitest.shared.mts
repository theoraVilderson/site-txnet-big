/**
 * The one vitest setup every backend project shares; each project's
 * `vitest.config.mts` is a call to `backendVitestConfig`.
 *
 * SWC, not vite's default transformer: NestJS resolves constructor injection
 * from `emitDecoratorMetadata`, which oxc/esbuild do not emit — without it an
 * `AppModule` boots with `undefined` in every injected slot. SWC transpiles
 * without type-checking, as `ts-jest` with `isolatedModules` did; the type
 * check stays `npx tsc -p <project>/tsconfig.spec.json --noEmit` (AGENTS.md).
 */
import swc from 'unplugin-swc';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

type TestOptions = NonNullable<ViteUserConfig['test']>;

export function backendVitestConfig(root: string, name: string, test: TestOptions = {}) {
  return defineConfig({
    root,
    cacheDir: `../node_modules/.vite/${name}`,
    // `experimentalDecorators` / `emitDecoratorMetadata` are read from the
    // nearest tsconfig. Class fields stay assigned in the constructor, as tsc's
    // `es2015` target emits them.
    plugins: [swc.vite({ jsc: { target: 'es2022', transform: { useDefineForClassFields: false } } })],
    // `@txnet-backend/*` from tsconfig.base.json `paths`.
    resolve: { tsconfigPaths: true },
    test: {
      name,
      globals: true,
      environment: 'node',
      include: ['src/**/*.spec.ts'],
      // `*.int.spec.ts` needs Docker; it runs from <project>/vitest.int.config.mts (`npm run test:int`).
      exclude: ['**/node_modules/**', 'src/**/*.int.spec.ts'],
      coverage: { reportsDirectory: `../coverage/${name}` },
      ...test,
    },
  });
}
