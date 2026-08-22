import proxyaddr from 'proxy-addr';
import type { Socket } from 'socket.io';
import type { IncomingMessage } from 'node:http';
import { InvalidTokenError, verifyAccessToken } from '@taskflow/security';
import { CLIENT_HEADER, MOBILE_CLIENT, UserIdSchema, type UserId } from '@taskflow/contracts';
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

export type HandshakeRefusal = 'no_token' | 'invalid_token' | 'forbidden_origin' | 'rate_limited';

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

  /* `proxy-addr`'s own `compile()` only understands a string or an array of
     them — passed a number it throws `TypeError: unsupported trust argument`,
     which would mean every handshake refused the instant `REALTIME_TRUST_PROXY`
     was set to a hop count, the single most likely value anyone configures. A
     numeric trust IS a real case `proxy-addr` supports, just not through
     `compile`: `proxyaddr(req, trust)` accepts a bare `(address, hop) => boolean`
     predicate directly, so a hop count becomes one without needing the library's
     string/CIDR path at all. This is the identical function Fastify's own
     `getTrustProxyFn` builds for the same input — `apps/api` gets it from
     `@fastify/proxy-addr` internally; this module has to build it by hand
     because there is no Fastify here to do it. */
  if (typeof value === 'number') return (_address, hop) => hop < value;

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

/**
 * True when the handshake carries the native client marker (ai/phase-14-mobile.md
 * §8) — the ONLY case in which a connection with no `Origin` is let past
 * `verifyHandshake` rather than refused.
 *
 * ## This is not "an origin check for native", and must never be sold as one
 *
 * A browser's `Origin` is unforgeable BY THE PAGE presenting it — the browser
 * itself attaches it, and no script running in that page can override or
 * suppress it. That is the entire reason `originAllowed` above is a meaningful
 * control. `CLIENT_HEADER` has none of that property: React Native has no
 * browser enforcing anything about what it sends, so this header is exactly as
 * easy for ANY caller — a rogue script, curl, a scanner — to set as it is for
 * our own app. Allow-listing a fixed "native origin" string here would be
 * dressing that up as a control it is not; this function deliberately does not
 * do that.
 *
 * What actually protects a native connection is unchanged and comes right
 * after this check: `verifyAccessToken` cryptographically verifies the bearer
 * token, which cannot be forged regardless of what any header claims. What the
 * origin check additionally buys a BROWSER — refusing a legitimate token
 * silently replayed from an unexpected web origin — has no equivalent native
 * threat today, because nothing on a phone ambiently attaches a stored
 * credential to an unrelated caller the way a cookie does; reaching a native
 * refresh token at all requires extracting it off the device. That is a
 * materially harder, different problem, and it is Wave 1b's device-bound
 * keypair (ai/phase-14-mobile.md §4.5) — not this header — that will make a
 * stolen native token provably inert elsewhere. Until that lands, this branch
 * is a deliberate, named INTERIM gap: revisit it once device binding ships.
 *
 * ## Why this never weakens the browser path
 *
 * `verifyHandshake` only consults this function when `Origin` is ABSENT. A
 * caller presenting a real (browser-attached) origin is checked by
 * `originAllowed` exactly as before, with no branch for this header at all —
 * a forbidden origin is refused regardless of what `CLIENT_HEADER` claims
 * alongside it, since nothing about a fake marker changes what a browser
 * actually sent.
 *
 * ## Confirmed against a real device (2026-08-22) — and the finding corrects this section
 *
 * This paragraph originally said the open question was "some other FIXED
 * value" `allowedOrigins` could simply list. A real Android device instead
 * showed `Origin: http://10.78.51.128:3001` — not fixed at all, but the exact
 * host:port the phone dialed, which is a different LAN IP on every machine
 * and meaningless in production. `engine.io-client` has no `window.location`
 * to read a genuine page origin from off-browser, and synthesizes one from
 * the connection's OWN target instead of omitting the header. Corrected in
 * place, per this repo's own "a status marker is a claim, not a fact"
 * discipline, rather than silently rewritten: `isSelfOrigin` below is the
 * actual fix, and it is deployment-independent for exactly the reason a
 * fixed allow-list entry could never be.
 */
export function isNativeClient(headers: Socket['handshake']['headers']): boolean {
  return headers[CLIENT_HEADER] === MOBILE_CLIENT;
}

/**
 * True when `origin` names exactly the same host:port this REQUEST itself
 * arrived on. Read this together with `isNativeClient`'s own "confirmed
 * against a real device" note above — this is what actually closes that
 * finding, and it does so without weakening the browser path at all.
 *
 * The reasoning `verifyHandshake` relies on: `apps/realtime` serves no HTML
 * of its own — nothing a browser could ever be "on" when it opens this
 * socket — so a real browser's Origin header (which reflects the PAGE it was
 * loaded from, attached by the browser itself, never the page's own script)
 * can never legitimately equal this server's own address. The only client
 * that produces that exact equality is one with no page to report an origin
 * for, echoing its own connection target back — precisely `engine.io-client`
 * off-browser. `verifyHandshake` still requires `isNativeClient` alongside
 * this before relaxing anything, so the two together grant NOTHING beyond
 * what an attacker could already do by omitting `Origin` entirely and
 * setting the (trivially forgeable, per `isNativeClient`'s own comment)
 * marker header — this only widens WHICH shape of that already-accepted
 * interim gap is recognized, not what it allows once recognized.
 */
export function isSelfOrigin(origin: string, headers: Socket['handshake']['headers']): boolean {
  const host = headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
  const origin = socket.handshake.headers.origin;

  if (origin !== undefined && origin !== '') {
    /* A real origin was presented. Checked exactly as always UNLESS it is
       both self-referential (isSelfOrigin) AND paired with the native marker
       — see that function's own comment for why that specific combination
       cannot come from a real browser. A forbidden origin with no native
       marker, or a native marker paired with a REAL (non-self) origin, is
       refused exactly as before: a browser can never claim to be native by
       adding a header, and a native client mis-forwarding some other origin
       gets no special treatment either. */
    const selfOriginNative =
      isSelfOrigin(origin, socket.handshake.headers) && isNativeClient(socket.handshake.headers);
    if (!selfOriginNative && !originAllowed(origin, options.allowedOrigins)) {
      throw new HandshakeError('forbidden_origin');
    }
  } else if (!isNativeClient(socket.handshake.headers)) {
    // No origin and no native marker: the same refusal this file has always
    // given a caller with nothing to identify it.
    throw new HandshakeError('forbidden_origin');
  }
  // else: no origin, but the caller identifies as native — see
  // isNativeClient's own comment for what this interim allowance is, and is
  // not, a substitute for.

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
