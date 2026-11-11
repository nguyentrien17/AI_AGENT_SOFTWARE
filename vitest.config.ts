import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Web component tests are .tsx (React 19 automatic JSX runtime).
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/web/test/**/*.test.tsx'],
    // Node by default; web component tests opt in with `// @vitest-environment jsdom`.
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
