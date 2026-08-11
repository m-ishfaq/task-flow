import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The same setting, for the same reason, as `apps/api`'s and
     * `apps/realtime`'s: suites here run against real Postgres and against ONE
     * GLOBAL QUEUE. `platform.outbox` is not tenant-partitioned from a
     * consumer's point of view — a consumer drains every org by definition — so
     * two files that each assert "the engine processed exactly the event I
     * enqueued" are not independent, and in parallel they drain each other's
     * rows.
     *
     * That failure presents as an off-by-N count, which reads as a batching bug
     * in the code under test rather than as two files sharing a queue, and it
     * is a RACE, so it passes several times before it fails. A test that fails
     * only sometimes gets re-run rather than investigated.
     */
    fileParallelism: false,

    /* Applying migrations against a cold container exceeds the 5s default. */
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
