import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each package/app has its own suite; run them all from the root so CI has a
    // single command. `node` environment because the domain, policy, broker and
    // db packages are server-side and use node:crypto.
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/tests/**'],
    globals: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/index.ts'],
      thresholds: { lines: 70, functions: 70, branches: 65, statements: 70 },
    },
    sequence: {
      // Deterministic order so a flake is reproducible.
      shuffle: false,
    },
  },
});
