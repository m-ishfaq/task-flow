import { closeDatabase, initializeDatabase, initializeRealtimeDatabase } from '@taskflow/db';
import { importAccessTokenPublicKey } from '@taskflow/security';
import { createLogger } from '@taskflow/observability';
import { loadEnv } from './config/env.js';
import { buildGateway } from './gateway.js';

/**
 * Process entry point for the socket gateway.
 *
 * Everything that can fail because of a configuration mistake fails HERE, before
 * the first connection is accepted: the env schema (including §7.1's bounds on
 * the reauth lead time), both database pools, and `assertRoomTableIsSafe` inside
 * `buildGateway`. A gateway that starts and then refuses every handshake is far
 * harder to diagnose than one that refuses to start and says why.
 */

const env = loadEnv();

/* TWO pools, and the split is the security-relevant part.
 *
 * The application pool is what the gateway AUTHORIZES on: `resolveOrgMembership`
 * and `loadTuples` run through it, under RLS, as taskflow_app — the same role
 * and the same functions the API uses (§6.2). There is deliberately no
 * privileged path for the gateway to ask "may this user see this board".
 *
 * The realtime pool is what it DRAINS on, as taskflow_realtime, which can read
 * platform.outbox across orgs and write only its own dispatch rows. It can
 * reach no tenant table at all. */
initializeDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
  applicationName: 'taskflow-realtime-app',
});

initializeRealtimeDatabase({
  url: env.DATABASE_REALTIME_URL,
  applicationName: 'taskflow-realtime',
});

const logger = createLogger({ name: 'realtime', level: env.LOG_LEVEL });
/* Public key only — this process verifies access tokens, never mints one
   (packages/security/src/jwt.ts's file header). */
const jwtPublicKey = await importAccessTokenPublicKey(env.JWT_PUBLIC_KEY);
const gateway = buildGateway({ env, logger, jwtPublicKey });

await gateway.listen();
logger.info(
  { port: env.REALTIME_PORT, pollIntervalMs: env.REALTIME_POLL_INTERVAL_MS },
  'realtime gateway listening',
);

/**
 * Drain rather than drop.
 *
 * Closing the gateway before the pools means an in-flight drain finishes against
 * a live connection instead of failing partway — which would count as a dispatch
 * failure and increment `attempts` on events that were fine.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await gateway.close();
      await closeDatabase();
      process.exit(0);
    })();
  });
}
