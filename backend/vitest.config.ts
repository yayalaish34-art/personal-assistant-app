import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 15_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }, // one Postgres DB — no parallel writers
    },
    // `npm test` loads .env, which says development. Everything in one fork
    // shares one rate-limit bucket, so the suite has to declare itself.
    env: { NODE_ENV: 'test' },
  },
});
