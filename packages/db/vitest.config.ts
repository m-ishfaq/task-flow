import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests here share one Postgres database and apply migrations in
    // beforeAll. Parallel test FILES would race on the migration tracking table
    // and on each other's fixture tables. Correctness matters more than the few
    // seconds parallelism would save on a suite this size.
    fileParallelism: false,

    // Applying migrations against a cold container is slower than the default.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
