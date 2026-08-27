import { Server } from '@hocuspocus/server';
import { CLIENT_HEADER, type OrgId, type PageId, type UserId } from '@taskflow/contracts';
import type { Logger } from '@taskflow/observability';
import { CollabAuthError, authenticateConnection } from './auth.js';
import { compactPage } from './compaction.js';
import { allowedOrigins, type Env } from './config/env.js';
import { appendUpdate, extractUpdateBytes } from './persist.js';
import { replayPage } from './replay.js';

/**
 * The collab gateway (ai/phase-6-docs.md §3.2, §3.3, §3.7, Wave 1 + Wave 2).
 *
 * Wave 1 shipped the authorization spine only. Wave 2 adds every write and
 * read-back path this process exists for: `beforeHandleMessage` durably
 * appends every incoming Yjs update to `docs.yjs_updates` BEFORE Hocuspocus
 * applies it or acknowledges it to the client (see `persist.ts`'s header for
 * why that hook and not the more obvious `onChange`); `onLoadDocument`
 * reconstructs a page's state from the last snapshot plus the WAL tail the
 * first time anyone opens it (`replay.ts`); `onStoreDocument` — Hocuspocus's
 * own debounced save-boundary hook — strips disallowed content from the LIVE
 * document and compacts the WAL into a fresh snapshot (`compaction.ts`).
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
            // See auth.ts's own header on why these two exist — the
            // apps/mobile Docs reader's native-client accommodation,
            // ported verbatim from apps/realtime/src/auth.ts.
            nativeClientHeader: data.requestHeaders.get(CLIENT_HEADER),
            host: data.requestHeaders.get('host'),
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
      // `connectionConfig` is the SAME object every later hook reads through
      // `hookPayload` — mutating a property on it here really does propagate.
      data.connectionConfig.readOnly = connection.readOnly;

      // `data` itself is NOT that same object: `hooks()` builds it fresh as
      // `{ ...hookPayload, ... }` for every hook, so assigning `data.context`
      // replaces a property on a throwaway copy and is silently lost — the
      // framework only threads context forward through this hook's RETURN
      // value, which it merges into the real `hookPayload.context` itself
      // (`onAuthenticatePayload.context` says `Promise<any>` for exactly this
      // reason). Confirmed against @hocuspocus/server@4.5.0's own compiled
      // `hooks()` after `onLoadDocument` observed an empty `context` here in
      // a real end-to-end run — every page open failed with `app.org_id`
      // unset, not merely a documentation gap the code happened to survive.
      return {
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

    /**
     * Runs once per document, the first time any connection requests it —
     * Hocuspocus caches the loaded `Y.Doc` in memory afterward, so this is
     * NOT called again per connection. `data.context` is populated by this
     * point regardless of which connection triggered the load: `onAuthenticate`
     * completes (and sets `hookPayload.context`) before `setUpNewConnection`
     * ever calls into document creation — confirmed directly in
     * @hocuspocus/server@4.5.0's own source, not assumed from the hook name
     * ordering alone.
     */
    async onLoadDocument(data) {
      await replayPage(data.document, data.context.orgId, data.context.pageId);
    },

    /**
     * Hocuspocus's own save-boundary hook, debounced at the library's
     * default (`debounce: 2000ms`, `maxDebounce: 10000ms` — a burst of
     * keystrokes settles 2s after the last one, or every 10s under
     * continuous typing, whichever comes first). `compactPage`'s own header
     * explains why this — not a standalone job — is where compaction runs:
     * `data.document` is the LIVE document, the only place the §7.3
     * content-strip can reach every currently connected client.
     */
    async onStoreDocument(data) {
      const result = await compactPage(
        data.document,
        data.lastContext.orgId,
        data.lastContext.pageId,
      );
      if (result.strippedNodes > 0 || result.strippedTextRuns > 0) {
        logger.warn(
          {
            pageId: data.lastContext.pageId,
            strippedNodes: result.strippedNodes,
            strippedTextRuns: result.strippedTextRuns,
          },
          'collab content guard stripped disallowed content from a live document',
        );
      }
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
