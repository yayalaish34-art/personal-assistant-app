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
    // `npm test` loads .env, which says development. Everything in one fork
    // shares one rate-limit bucket, so the suite has to declare itself.
    // Secrets are test-only placeholders: the config loader enforces their
    // presence but tests never sign real tokens with them.
    env: {
      NODE_ENV: 'test',
      JWT_SECRET:
        process.env.JWT_SECRET ??
        'vitest-placeholder-secret-at-least-32-chars-long-aaaa',
      JWT_REFRESH_SECRET:
        process.env.JWT_REFRESH_SECRET ??
        'vitest-placeholder-refresh-secret-at-least-32-chars-long-bbbb',
    },
  },
});
