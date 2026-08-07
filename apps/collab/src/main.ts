import { closeDatabase, initializeCollabDatabase, initializeDatabase } from '@taskflow/db';
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
 * TWO pools, mirroring `apps/realtime`'s own split — see `config/env.ts`'s
 * file header. `onAuthenticate` authorizes over the ORDINARY application
 * connection, under RLS, exactly as `apps/realtime`'s `rooms.ts` does; the
 * `taskflow_collab` connection exists for exactly one thing, persisting to
 * `docs.yjs_updates`/`docs.page_versions` in `beforeHandleMessage`.
 */

const env = loadEnv();

initializeDatabase({
  url: env.DATABASE_URL,
  maxConnections: env.DATABASE_POOL_MAX,
  applicationName: 'taskflow-collab-app',
});

initializeCollabDatabase({
  url: env.DATABASE_COLLAB_URL,
  applicationName: 'taskflow-collab',
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
