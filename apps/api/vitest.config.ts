import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The identity tests are integration tests: they run against the real
    // Postgres from `docker compose up -d`, share one database, and truncate
    // between cases. Parallel test FILES would delete each other's fixtures
    // mid-assertion, producing failures that look like logic bugs.
    //
    // There is no mocked variant on purpose. The properties being proven here —
    // that a unique index stops a duplicate signup under concurrency, that a
    // conditional UPDATE adjudicates a refresh-token race — are database
    // behaviours. A fake would only assert that this file agrees with itself.
    fileParallelism: false,

    // Argon2id is deliberately slow (19 MiB, t=2), and a login test pays that
    // cost twice. Applying migrations against a cold container is slower still.
    // 120s accommodates heavy parallel load during `pnpm verify` — 47 test files
    // all running applyMigrations() against one Postgres instance, alongside
    // collab and realtime doing the same from their own packages.
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});
