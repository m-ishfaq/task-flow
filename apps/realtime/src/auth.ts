import proxyaddr from 'proxy-addr';
import type { Socket } from 'socket.io';
import type { IncomingMessage } from 'node:http';
import { InvalidTokenError, verifyAccessToken } from '@taskflow/security';
import { UserIdSchema, type UserId } from '@taskflow/contracts';
import type { TrustProxyValue } from '@taskflow/api/config/trust-proxy';

/**
 * The handshake — the gateway's perimeter (§3.2, §3.7, §3.8).
 *
 * ⚠ Adjacent to a human-review surface (§2.2): this decides the identity every
 * subsequent authorization check is evaluated against, for the entire life of a
 * connection.
 *
 * ## Identity is decided exactly once, here
 *
 * A socket lives for hours and carries no per-message header to re-resolve
 * against. So the token is verified once, at connect, and `{ userId, sessionId }`
 * is written to `socket.data` — a server-controlled property. Every handler for
 * the rest of that connection's life reads it from there.
 *
 * None of them ever reads a `userId` from a message. That is §3.7, and it is not
 * a hypothetical: "subscribe me to my own notifications", taking the id from the
 * payload, is the most damaging shape of Socket.io bug that shows up in real
 * deployments — looped over a range of ids it harvests every user's private data
 * from a socket that never proved any identity, and leaves nothing in an HTTP
 * audit log because no HTTP route was touched. The defence is structural: there
 * is no field in the wire contract where an identity could be asserted, and this
 * is the only place `socket.data.userId` is ever assigned.
 *
 * ## No org, and no role, at connect time
 *
 * Deliberately, and for the same reason `authenticate()` returns `org: null` on
 * the HTTP side. A role resolved at connect would be a role held for the life of
 * the connection — hours — so a demotion would not take effect until the user
 * happened to reconnect. Org and role are resolved per ROOM JOIN instead, from a
 * fresh membership read (§3.3).
 */

/** What a verified handshake establishes. Nothing else is trusted. */
export interface SocketIdentity {
  readonly userId: UserId;
  readonly sessionId: string;
  /** Epoch seconds at which the presented token expires. */
  readonly tokenExpiresAt: number;
}

export type HandshakeRefusal =
  | 'no_token'
  | 'invalid_token'
  | 'forbidden_origin'
  | 'rate_limited';

export class HandshakeError extends Error {
  constructor(readonly refusal: HandshakeRefusal) {
    /* One message for every refusal, matching `InvalidTokenError`'s reasoning:
       expired, malformed, wrong audience and disallowed origin must look
       identical to the caller. The specific reason is logged server-side, where
       it is useful to us and not to someone probing the handshake. */
    super('Connection refused.');
    this.name = 'HandshakeError';
  }
}

/**
 * The client's address, honouring the configured proxy trust.
 *
 * Uses `proxy-addr` — the same library Fastify uses internally — against the
 * same parsed `TrustProxy` value the API is configured with, so the two
 * processes cannot disagree about who a request came from. The default is
 * `false`, meaning the socket address, because trusting `X-Forwarded-For`
 * unconditionally makes every per-IP limit opt-out with one header.
 */
export function clientAddress(request: IncomingMessage, trustProxy: TrustProxyValue): string {
  /* `proxy-addr` accepts false | number | string and returns the socket address
     when nothing is trusted. The `?? 'unknown'` covers a request whose socket
     has already been destroyed, where the address is undefined — bucketing those
     together under one key is the conservative choice, since it means they share
     a budget rather than each getting a fresh one. */
  return proxyaddr(request, compileTrust(trustProxy)) || 'unknown';
}

/**
 * Turns the parsed env value into the predicate `proxy-addr` wants.
 *
 * Compiled once per call rather than cached because a handshake is not a hot
 * path and a stale compiled trust would be a security-relevant staleness.
 */
function compileTrust(value: TrustProxyValue): (address: string, hop: number) => boolean {
  if (value === false) return () => false;
  if (typeof value === 'number') return proxyaddr.compile(value);
  return proxyaddr.compile(value.split(',').map((entry) => entry.trim()));
}

/**
 * True when this handshake's `Origin` is one we serve.
 *
 * A page loaded from anywhere else must never get far enough to present a token.
 * This is NOT a substitute for XSS defences — a script running inside the app's
 * own origin in an already-authenticated tab holds a real token, which is what
 * the TipTap-only rich text and the `dangerouslySetInnerHTML` ban exist to
 * prevent — it is the narrower, cheaper control that stops a connection attempt
 * from a domain that was never supposed to reach this server.
 *
 * A MISSING origin is refused. Browsers always send one on a WebSocket upgrade;
 * a request without one is not a browser, and "allow it, it is probably a
 * server-side client" is how this check gets bypassed by anything that simply
 * omits the header.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === '') return false;
  return allowed.includes(origin);
}

export interface HandshakeOptions {
  readonly jwtSecret: Uint8Array;
  readonly allowedOrigins: readonly string[];
}

/**
 * Verifies a handshake, or throws `HandshakeError`.
 *
 * Refused — not accepted-then-limited. There is no anonymous state for a socket
 * to be in: nothing in Work happens without an org, and there is no
 * `publicRoute` equivalent here to carry over. A connection that never
 * authenticates has no work to do, and should not be able to open a socket and
 * sit on it seeing what it can reach.
 */
export async function verifyHandshake(
  socket: Socket,
  options: HandshakeOptions,
): Promise<SocketIdentity> {
  if (!originAllowed(socket.handshake.headers.origin, options.allowedOrigins)) {
    throw new HandshakeError('forbidden_origin');
  }

  /* Read from the `auth` payload, never the query string: query strings end up
     in proxy and server access logs, and an access token in a log file outlives
     the ten minutes it was supposed to be useful for. */
  const auth: unknown = socket.handshake.auth;
  const token =
    typeof auth === 'object' && auth !== null
      ? (auth as Record<string, unknown>)['token']
      : undefined;

  if (typeof token !== 'string' || token.length === 0) {
    throw new HandshakeError('no_token');
  }

  let claims;
  try {
    claims = await verifyAccessToken(token, { secret: options.jwtSecret });
  } catch (error) {
    if (error instanceof InvalidTokenError) throw new HandshakeError('invalid_token');
    throw error;
  }

  /* Branded at the trust boundary, exactly as the HTTP path does it. A `sub`
     claim that is not a well-formed id would otherwise flow into `loadTuples`
     as a raw string and compare unequal to every tuple subject — which denies,
     but denies for the wrong reason and would be baffling to debug. */
  const userId = UserIdSchema.safeParse(claims.userId);
  if (!userId.success) throw new HandshakeError('invalid_token');

  /* The org and role claims that may be present on the token are deliberately
     IGNORED. They were true when the token was minted, up to ten minutes ago;
     §3.3 re-reads both per room join so a demotion takes effect immediately.
     Reading them here would reintroduce exactly the staleness the HTTP path
     spends a database round-trip per request to avoid. */
  return {
    userId: userId.data,
    sessionId: claims.sessionId,
    tokenExpiresAt: expiryOf(token),
  };
}

/**
 * The token's `exp`, read back from the payload segment.
 *
 * Safe to parse without verifying here ONLY because `verifyAccessToken` has
 * already run and thrown on any failure — this is re-reading a claim from a
 * string already proven authentic, not trusting an unverified token. Returns 0
 * if the segment is unreadable, which makes the connection look already-expired
 * and triggers an immediate reauth rather than a very long-lived socket.
 */
function expiryOf(token: string): number {
  try {
    const segment = token.split('.')[1];
    if (segment === undefined) return 0;
    const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return 0;
    const exp = (decoded as Record<string, unknown>)['exp'];
    return typeof exp === 'number' ? exp : 0;
  } catch {
    return 0;
  }
}
