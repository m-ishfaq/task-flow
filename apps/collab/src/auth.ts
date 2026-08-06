import { InvalidTokenError, verifyAccessToken } from '@taskflow/security';
import { OrgIdSchema, UserIdSchema, type OrgId, type PageId, type UserId } from '@taskflow/contracts';
import { authorizeConnect } from './authorize.js';
import { parsePageDocumentName } from './document-name.js';

/**
 * The handshake — `apps/collab`'s perimeter, adapted from
 * `apps/realtime/src/auth.ts` to Hocuspocus's `onAuthenticate` hook shape
 * (ai/phase-6-docs.md §3.3).
 *
 * ⚠ Human-review surface, the moment this file exists (§6.2) — alongside
 * `apps/realtime/src/auth.ts` and `rooms.ts`. It decides who may open which
 * page, for the life of a sync session.
 *
 * `authenticateConnection` below takes a plain object rather than
 * Hocuspocus's own `onAuthenticatePayload`, deliberately: the real payload
 * carries a live `Headers`/`URLSearchParams`/socket machinery that only a
 * running server can produce, and this function's actual job — verify the
 * token, parse the document name, resolve authorization, decide read-only —
 * has none of that as an input. `main.ts` is the thin adapter that pulls the
 * few fields this needs out of the real payload; everything worth getting
 * right is testable here without a WebSocket.
 */

export class CollabAuthError extends Error {
  constructor(
    readonly refusal:
      | 'forbidden_origin'
      | 'no_token'
      | 'invalid_token'
      | 'invalid_document'
      | 'invalid_org'
      | 'refused',
  ) {
    /* One message for every refusal, matching `HandshakeError`'s reasoning in
       apps/realtime: the specific reason is for the server log, not for
       whoever is probing the endpoint. */
    super('Connection refused.');
    this.name = 'CollabAuthError';
  }
}

/**
 * True when this connection's `Origin` is one we serve. Identical control to
 * `apps/realtime/src/auth.ts`'s `originAllowed` — small enough, and specific
 * enough to each process's own request shape (a fetch-API `Headers` here vs.
 * a Socket.io handshake there), that sharing it would cost a new cross-app
 * export for three lines of logic.
 */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null || origin === '') return false;
  return allowed.includes(origin);
}

export interface AuthenticateInput {
  readonly token: string | undefined;
  readonly documentName: string;
  readonly origin: string | null;
  /** `requestParameters.get('orgId')` — see `document-name.ts` on why the org travels separately from the document name. */
  readonly orgIdParam: string | null;
}

export interface AuthenticateOptions {
  readonly jwtSecret: Uint8Array;
  readonly allowedOrigins: readonly string[];
}

export interface AuthenticatedConnection {
  readonly userId: UserId;
  readonly sessionId: string;
  readonly orgId: OrgId;
  readonly pageId: PageId;
  readonly readOnly: boolean;
}

/**
 * Verifies and authorizes a collab connection, or throws `CollabAuthError`.
 *
 * Mirrors `apps/realtime/src/rooms.ts`'s `authorizeJoin` composed with
 * `apps/realtime/src/auth.ts`'s `verifyHandshake`, in one function because
 * Hocuspocus has one hook (`onAuthenticate`) where Socket.io's protocol gives
 * two separate moments (connect, then join). There is nowhere in EITHER
 * protocol to assert an identity after this point — everything downstream
 * reads from what this function returns, never from a later message.
 */
export async function authenticateConnection(
  input: AuthenticateInput,
  options: AuthenticateOptions,
): Promise<AuthenticatedConnection> {
  if (!originAllowed(input.origin, options.allowedOrigins)) {
    throw new CollabAuthError('forbidden_origin');
  }

  if (typeof input.token !== 'string' || input.token.length === 0) {
    throw new CollabAuthError('no_token');
  }

  let claims;
  try {
    claims = await verifyAccessToken(input.token, { secret: options.jwtSecret });
  } catch (error) {
    if (error instanceof InvalidTokenError) throw new CollabAuthError('invalid_token');
    throw error;
  }

  const userId = UserIdSchema.safeParse(claims.userId);
  if (!userId.success) throw new CollabAuthError('invalid_token');

  const pageId = parsePageDocumentName(input.documentName);
  if (pageId === null) throw new CollabAuthError('invalid_document');

  const orgId = OrgIdSchema.safeParse(input.orgIdParam ?? undefined);
  if (!orgId.success) throw new CollabAuthError('invalid_org');

  /* Org and role are NOT read from the token, for the identical reason
     `verifyHandshake` ignores them: they were true when the token was minted,
     and re-resolving here (inside `authorizeConnect`) is what makes a
     demotion or a revoked grant take effect on the very next connection
     attempt rather than whenever the token happens to expire. */
  const authorization = await authorizeConnect(userId.data, orgId.data, pageId);

  if (!authorization.allowed) {
    throw new CollabAuthError('refused');
  }

  return {
    userId: userId.data,
    sessionId: claims.sessionId,
    orgId: orgId.data,
    pageId,
    readOnly: authorization.readOnly,
  };
}
