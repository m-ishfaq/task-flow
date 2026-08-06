import { Server } from '@hocuspocus/server';
import type { Logger } from '@taskflow/observability';
import { CollabAuthError, authenticateConnection } from './auth.js';
import { allowedOrigins, type Env } from './config/env.js';

/**
 * The collab gateway (ai/phase-6-docs.md §3.2, §3.3, Wave 1).
 *
 * Wave 1 ships the authorization spine only — `onAuthenticate` wired to
 * `authenticateConnection`, nothing else. No document persistence, no
 * `onStoreDocument`, no `docs.yjs_updates` writes: those are Wave 2's job,
 * once the recovery-path machinery (§3.7) exists to make a write durable.
 * A page opened through this server today syncs in memory, for the single
 * editor Wave 1's own tests exercise, and loses that state if the process
 * restarts — acceptable for proving the auth spine, not for a shipped
 * editing feature, which is exactly why §5 scopes live collaborative editing
 * to Wave 2 rather than calling this done.
 */

export interface Gateway {
  readonly server: Server;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

export interface BuildGatewayOptions {
  readonly env: Env;
  readonly logger: Logger;
}

export function buildGateway(options: BuildGatewayOptions): Gateway {
  const { env, logger } = options;

  const origins = allowedOrigins(env);
  const jwtSecret = Buffer.from(env.JWT_SECRET, 'base64');

  const server = new Server({
    port: env.COLLAB_PORT,
    address: env.COLLAB_HOST,
    quiet: true,

    async onAuthenticate(data) {
      let connection;
      try {
        connection = await authenticateConnection(
          {
            token: data.token,
            documentName: data.documentName,
            origin: data.requestHeaders.get('origin'),
            orgIdParam: data.requestParameters.get('orgId'),
          },
          { jwtSecret, allowedOrigins: origins },
        );
      } catch (error) {
        if (error instanceof CollabAuthError) {
          logger.warn(
            { refusal: error.refusal, documentName: data.documentName },
            'collab connection refused',
          );
        }
        throw error;
      }

      // Read-only enforcement is asserted server-side in `beforeHandleMessage`
      // once Wave 2 adds a write path — §3.3 flags Hocuspocus's own read-only
      // mode as unverified-as-server-enforced (§7.4, still open) and says the
      // enforcement has to live here regardless of which is true. Setting the
      // flag now is still correct: it is the one piece of that story Wave 1
      // CAN establish, and Wave 2 does not get to skip verifying the rest.
      data.connectionConfig.readOnly = connection.readOnly;

      // Carried to every later hook (Wave 2's onStoreDocument, in particular)
      // rather than re-derived — the same "resolved once, read everywhere"
      // discipline `socket.data.identity` follows in apps/realtime.
      data.context = {
        userId: connection.userId,
        orgId: connection.orgId,
        pageId: connection.pageId,
      };
    },
  });

  return {
    server,
    listen: async () => {
      await server.listen();
    },
    close: async () => {
      await server.destroy();
    },
  };
}
