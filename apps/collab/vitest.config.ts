import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The same settings, for the same reasons, as `apps/realtime/vitest.config.ts`.
     *
     * This suite is the sibling realtime's header describes: `authorize.test.ts`
     * and `gateway.integration.test.ts` hit the real Postgres from
     * `docker compose up -d`, and the integration suite boots a REAL
     * Hocuspocus gateway and drives it with the official `@hocuspocus/provider`
     * client over real WebSockets. Under `pnpm verify`'s 48-task parallel load
     * those round-trips regularly exceed vitest's 5-second default
     * `testTimeout` — surfaced as `Test timed out in 5000ms` in a test that
     * passes in isolation, which is the classic shape of a flake that gets
     * re-run rather than investigated. `testTimeout: 30_000` matches what the
     * realtime suite already needs for the identical reason.
     *
     * `fileParallelism: false` for the same reason realtime sets it: the suite
     * writes to ONE GLOBAL QUEUE (`platform.outbox` — `savePageVersion` and
     * `restorePageVersion` enqueue events), and a consumer drains every tenant
     * by design. Running this app's own test files against each other's rows
     * turns `expected 1 to be 0` into a race; serializing the app's files
     * removes the self-inflicted part of the contention (the cross-package
     * load from `pnpm verify` remains, which is what the longer timeout is for).
     */
    fileParallelism: false,

    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
