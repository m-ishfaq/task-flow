import {
  InvalidTokenError,
  verifyAccessToken,
  type AccessTokenVerifyConfig,
} from '@taskflow/security';
import {
  MOBILE_CLIENT,
  OrgIdSchema,
  UserIdSchema,
  type OrgId,
  type PageId,
  type UserId,
} from '@taskflow/contracts';
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
 * has none of that as an input. `gateway.ts` is the thin adapter that pulls
 * the few fields this needs out of the real payload; everything worth
 * getting right is testable here without a WebSocket.
 *
 * **`isNativeClient`/`isSelfOrigin` (added for apps/mobile's Docs reader,
 * ai/phase-14-mobile.md §8) are ported VERBATIM from `apps/realtime/src/
 * auth.ts`, not reinvented.** That file's own real-device finding — an
 * off-browser WebSocket client with no `window.location` can synthesize an
 * `Origin` equal to its own connection target rather than omitting the
 * header — has no reason to be specific to Socket.io; `apps/collab` gets
 * the identical accommodation for the identical reason. This is the exact
 * kind of change CLAUDE.md's own review-surface list exists for: read this
 * file's diff in full before merging, and confirm the DB-backed
 * `authorize.test.ts`/`gateway.integration.test.ts` suites (which need
 * Docker, unavailable in the environment this change was written in) still
 * pass against real Postgres before shipping it.
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

/**
 * True when the connection carries the native client marker
 * (ai/phase-14-mobile.md §8) — the ONLY case in which a connection with no
 * `Origin` is let past the check below rather than refused. Ported verbatim
 * from `apps/realtime/src/auth.ts`'s `isNativeClient`, which is the file to
 * read for the full reasoning: this is NOT an origin check for native (the
 * header is exactly as forgeable by anyone else as it is by this app —
 * `verifyAccessToken`'s cryptographic check is what actually protects a
 * native connection), and it never weakens the browser path, since it is
 * only ever consulted when `Origin` is absent. `apps/collab` has the
 * identical off-browser-Origin gap `apps/realtime` already found and fixed;
 * this closes it here rather than leaving mobile Docs reading unreachable.
 */
export function isNativeClient(headerValue: string | null): boolean {
  return headerValue === MOBILE_CLIENT;
}

/**
 * True when `origin` names exactly the same host:port this REQUEST itself
 * arrived on — ported verbatim from `apps/realtime/src/auth.ts`'s
 * `isSelfOrigin`, confirmed there against a real Android device: with no
 * `window.location` to read a page origin from, an off-browser WebSocket
 * client can synthesize `Origin` from its own connection target rather than
 * omitting the header. Read together with `isNativeClient` above — both are
 * required before anything relaxes; a self-referential origin with no
 * marker, or a marker paired with a genuinely different origin, is refused
 * exactly as before.
 */
export function isSelfOrigin(origin: string, host: string | null): boolean {
  if (host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface AuthenticateInput {
  readonly token: string | undefined;
  readonly documentName: string;
  readonly origin: string | null;
  /** `requestParameters.get('orgId')` — see `document-name.ts` on why the org travels separately from the document name. */
  readonly orgIdParam: string | null;
  /** `requestHeaders.get(CLIENT_HEADER)` — null when absent. See `isNativeClient`'s own header for what this does and does not grant. */
  readonly nativeClientHeader: string | null;
  /** `requestHeaders.get('host')` — what `isSelfOrigin` compares a self-referential `Origin` against. */
  readonly host: string | null;
}

export interface AuthenticateOptions {
  /** RS256 public key only — this gateway verifies, it never mints a token. */
  readonly jwtPublicKey: AccessTokenVerifyConfig['publicKey'];
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
  if (input.origin !== null && input.origin !== '') {
    /* A real origin was presented. Checked exactly as always UNLESS it is
       both self-referential (isSelfOrigin) AND paired with the native
       marker — see that function's own comment for why that specific
       combination cannot come from a real browser. A forbidden origin with
       no native marker, or a native marker paired with a REAL (non-self)
       origin, is refused exactly as before. */
    const selfOriginNative =
      isSelfOrigin(input.origin, input.host) && isNativeClient(input.nativeClientHeader);
    if (!selfOriginNative && !originAllowed(input.origin, options.allowedOrigins)) {
      throw new CollabAuthError('forbidden_origin');
    }
  } else if (!isNativeClient(input.nativeClientHeader)) {
    // No origin and no native marker: the same refusal this file has
    // always given a caller with nothing to identify it.
    throw new CollabAuthError('forbidden_origin');
  }
  // else: no origin, but the caller identifies as native — see
  // isNativeClient's own comment for what this bearer-token-authenticated
  // allowance is, and is not, a substitute for.

  if (typeof input.token !== 'string' || input.token.length === 0) {
    throw new CollabAuthError('no_token');
  }

  let claims;
  try {
    claims = await verifyAccessToken(input.token, { publicKey: options.jwtPublicKey });
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
