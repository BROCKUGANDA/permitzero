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
    // The suite is bounded by the DATABASE, not by the CPU.
    //
    // Every test file opens its own pools against one PostgreSQL server:
    // a management pool of 1, a test pool of 5 and a runtime pool of 5. That
    // is about eleven connections per file, and PostgreSQL's default
    // `max_connections` is 100. So eight files in parallel is the most the
    // server can serve without queueing — and a queued connection waits
    // silently, which shows up as a sixty-second hook timeout in a test
    // that has nothing wrong with it.
    //
    // Four workers is about forty-four connections, which leaves room for
    // the server's own superuser reservations and for whatever else is
    // running against the same instance. The suite got slower in wall-clock
    // terms and stopped failing for a reason that had nothing to do with the
    // code under test.
    maxWorkers: 4,
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
