import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The same setting, for the same reason, as `apps/api/vitest.config.ts`.
     *
     * Several suites here run against the real Postgres from
     * `docker compose up -d`, and two of them write to ONE GLOBAL QUEUE:
     * `platform.outbox` is not tenant-partitioned from a consumer's point of
     * view, because a consumer drains every org by definition (§3.5). So
     * `relay.test.ts`, which asserts "the relay drained exactly the one event I
     * enqueued", and `gateway.integration.test.ts`, which enqueues its own
     * events to prove a broadcast arrives, are not independent — run in
     * parallel they drain each other's rows.
     *
     * That surfaced as `expected 3 to be 1`, which reads as a bug in the relay's
     * batching rather than as two test files sharing a queue. Worse, it is a
     * RACE: the suite passed cleanly several times before failing, so the
     * evidence pointed at flakiness in the code under test rather than at the
     * harness. A test that fails only sometimes gets re-run rather than
     * investigated, which is how a real defect eventually hides behind it.
     *
     * There is no mocked variant on purpose, matching apps/api's note: the
     * properties being proven — that `FOR UPDATE SKIP LOCKED` claims a disjoint
     * batch, that two consumers do not starve each other, that a real socket
     * receives a real broadcast written to a real outbox — are database and
     * network behaviours. A fake would only assert this file agrees with itself.
     */
    fileParallelism: false,

    /* Applying migrations against a cold container, plus booting a real gateway
       and waiting on real socket round-trips, both exceed the 5s default. 120s
       accommodates heavy parallel load during `pnpm verify` (48 tasks hitting the
       same Postgres) where the 60s default occasionally was not enough — the same
       flake apps/collab hit. */
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
