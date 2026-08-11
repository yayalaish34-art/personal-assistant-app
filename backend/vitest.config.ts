import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 15_000,
    pool: 'forks',
    // One Postgres DB — no parallel writers. This was `poolOptions.forks.
    // singleFork`, which Vitest 4 removed: the suite had quietly gone back to
    // running files in parallel against the one database.
    fileParallelism: false,
  },
});
