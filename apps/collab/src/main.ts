import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { createLogger } from '@taskflow/observability';
import { loadEnv } from './config/env.js';
import { buildGateway } from './gateway.js';

/**
 * Process entry point for the collab gateway.
 *
 * Mirrors `apps/realtime/src/main.ts`'s reasoning: everything that can fail
 * from a configuration mistake fails HERE, before the first connection is
 * accepted, rather than inside a live `onAuthenticate` call.
 *
 * One pool, not two — see `config/env.ts`'s file header. Wave 1's
 * `onAuthenticate` hook authorizes over the ORDINARY application connection,
 * under RLS, exactly as `apps/realtime`'s `rooms.ts` does. A second,
 * dedicated `taskflow_collab` pool arrives with Wave 2, when this process
 * first needs to WRITE.
 */

const env = loadEnv();

initializeDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
  applicationName: 'taskflow-collab-app',
});

const logger = createLogger({ name: 'collab', level: env.LOG_LEVEL });
const gateway = buildGateway({ env, logger });

await gateway.listen();
logger.info({ port: env.COLLAB_PORT }, 'collab gateway listening');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await gateway.close();
      await closeDatabase();
      process.exit(0);
    })();
  });
}
