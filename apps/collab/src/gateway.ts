import { Server } from '@hocuspocus/server';
import type { OrgId, PageId, UserId } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import { CollabAuthError, authenticateConnection } from './auth.js';
import { allowedOrigins, type Env } from './config/env.js';
import { appendUpdate, extractUpdateBytes } from './persist.js';

/**
 * The collab gateway (ai/phase-6-docs.md §3.2, §3.3, §3.7, Wave 1 + Wave 2).
 *
 * Wave 1 shipped the authorization spine only. Wave 2 adds the one write
 * path this whole process exists for: `beforeHandleMessage` durably appends
 * every incoming Yjs update to `docs.yjs_updates` BEFORE Hocuspocus applies
 * it or acknowledges it to the client — see `persist.ts`'s header for why
 * that hook and not the more obvious `onChange`. Document loading/replay
 * (`onLoadDocument`) and periodic compaction are separate concerns, wired in
 * `main.ts` and `compaction.ts` respectively — this file's only job is the
 * connection lifecycle: who may connect, and what happens to what they send.
 */

/** Carried on every connection from `onAuthenticate` onward — resolved once, read everywhere. */
export interface CollabContext {
  readonly userId: UserId;
  readonly orgId: OrgId;
  readonly pageId: PageId;
}

export interface Gateway {
  readonly server: Server<CollabContext>;
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

  const server = new Server<CollabContext>({
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

      // Read-only enforcement: confirmed server-side in Hocuspocus's own
      // protocol handling (ai/phase-6-docs.md §7.4, settled at Wave 2 start
      // by reading @hocuspocus/server's readSyncMessage directly) — a
      // read-only connection's incoming update is never applied, so setting
      // this flag correctly IS the enforcement, not merely a hint toward it.
      data.connectionConfig.readOnly = connection.readOnly;

      // Carried to every later hook — beforeHandleMessage below, in
      // particular — rather than re-derived, the same "resolved once, read
      // everywhere" discipline `socket.data.identity` follows in
      // apps/realtime.
      data.context = {
        userId: connection.userId,
        orgId: connection.orgId,
        pageId: connection.pageId,
      };
    },

    /**
     * The durability guarantee §3.7 names, made real. Runs — and is fully
     * awaited — before Hocuspocus applies this message to the document or
     * sends the client its sync-status ack (verified directly against
     * @hocuspocus/server@4.5.0's own ClientConnection.processMessages(); see
     * persist.ts's header for the full trace).
     *
     * `extractUpdateBytes` returns null for every message that is not an
     * actual content delta (awareness, ping, a bare syncStep1 request) —
     * those are not written here at all, which is correct: nothing about
     * them belongs in a replay log of page CONTENT.
     *
     * `connection.readOnly` is checked here explicitly, and it is not
     * redundant with the protocol-level enforcement §7.4 confirmed:
     * `beforeHandleMessage` runs BEFORE `readSyncMessage`'s own readOnly
     * check, which lives further down the same pipeline. Skipping this
     * guard would durably persist — and later REPLAY as if accepted — an
     * update the live document never actually applied, from a connection
     * that was never allowed to write at all. The WAL would then be the one
     * place a viewer's rejected edit silently took effect.
     */
    async beforeHandleMessage(data) {
      if (data.connection.readOnly) return;

      const update = extractUpdateBytes(data.update);
      if (update === null) return;

      await appendUpdate(data.context.orgId, data.context.pageId, update);
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
