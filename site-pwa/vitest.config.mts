import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

// Specs live next to the code they cover (`src/**/*.test.ts`).
// `passWithNoTests` stays on so a filtered run never fails the build.
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**'],
    passWithNoTests: true,
    /**
     * Vitest's own default is 5000ms, which no longer clears the `waitFor`
     * ceiling in `vitest.setup.ts`: a spec whose assertion may poll for 5000ms
     * cannot live inside a 5000ms test. Measured 2026-09-21 on an idle machine,
     * the slowest spec in `financial/deposit/` already took 3077ms of that
     * default, so the budget was thin before anything else was running.
     *
     * A ceiling like the other one: a passing test never spends it.
     */
    testTimeout: 30_000,
  },
});
