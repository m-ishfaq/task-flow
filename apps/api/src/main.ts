import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { loadEnv } from './config/env.js';
import { buildServer } from './server.js';

/**
 * Process entry point.
 *
 * Everything that can fail because of a configuration mistake fails HERE, before
 * the first connection is accepted: the env schema, the database pool, and the
 * route manifest assertion inside `buildServer`. A server that starts and then
 * rejects every request is far harder to diagnose than one that refuses to start
 * and says why.
 */

const env = loadEnv();

initializeDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
  applicationName: 'taskflow-api',
});

const app = await buildServer({ env });

await app.listen({ port: env.API_PORT, host: env.API_HOST });

/**
 * Drain rather than drop.
 *
 * Without this, a deploy kills in-flight requests — including ones that have
 * already written to the database but not yet emitted their domain event, which
 * is precisely the state the transactional outbox exists to make impossible.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await closeDatabase();
      process.exit(0);
    })();
  });
}
