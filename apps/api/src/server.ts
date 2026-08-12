import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { isDatabaseHealthy } from '@taskflow/db';
import { masterKeysFromBase64, newId, SoftwareKeyProvider } from '@taskflow/security';
import { ensureIdentityDataKey } from './identity/secret-key.js';
import { createAppRouter, type AppRouter } from './router.js';
import { buildWorkDeps } from './work/deps.js';
import { buildTelephonyDeps } from './telephony/deps.js';
import { buildRtcDeps } from './rtc/deps.js';
import { buildBillingDeps } from './billing/deps.js';
import { registerTelephonyWebhooks } from './telephony/webhook.routes.js';
import { assertRoutesDeclarePermissions } from './trpc/manifest.js';
import type { AuthenticatedPrincipal, RequestContext } from './trpc/context.js';
import { ORG_HEADER, resolveOrgMembership } from './tenancy/resolve.js';
import {
  clearRefreshCookieOptions,
  readRefreshCookie,
  refreshCookieOptions,
  serializeRefreshCookie,
} from './identity/cookies.js';
import { buildIdentityDeps, buildPasskeyDeps } from './identity/deps.js';
import { authenticateWithApiToken } from './identity/api-token-auth.js';
import type { OAuthDeps } from './identity/oauth.service.js';
import { authenticate, bearerToken } from './identity/authenticate.js';
import { createMailDelivery } from './identity/deliver.js';
import { createLogger } from '@taskflow/observability';
import { registerRateLimit } from './middleware/rate-limit.js';
import type { SlidingWindowLimiter } from './middleware/sliding-window.js';
import type { Env } from './config/env.js';
import type { EventBus } from '@taskflow/events';
import type { Mailer } from '@taskflow/mail';
import type { DeliverableLink } from './identity/identity.service.js';

/**
 * HTTP surface.
 *
 * Access tokens are verified here, on every request, by `authenticate`. What
 * that produces is a PRINCIPAL — a user, a session, and when they last proved a
 * credential. It is deliberately NOT a role: the token is signed by this API
 * and could carry one, and carrying one would mean a demotion took effect only
 * when the token expired, leaving a revoked admin with admin rights for the ten
 * minutes that matter most.
 *
 * The role therefore comes from a membership read, on every request, keyed by
 * the org named in a header. `withOrgContext` below is where that happens and
 * carries the reasoning for why an attacker-controlled header is safe input to
 * it.
 */

/**
 * Cookie lifetime, matching the refresh token's own 30 days.
 *
 * A cookie that outlives its token means the browser keeps presenting something
 * the server already rejects, and the user sees an unexplained sign-out loop
 * rather than a clean expiry.
 */
const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface BuildOptions {
  readonly env: Env;
  readonly events?: EventBus;
  readonly deliver?: (message: DeliverableLink) => Promise<void>;
  /** Replaces the SMTP transport while leaving the templates and queue in place. */
  readonly mailer?: Mailer;
  /** Injected so a test can assert against counters it controls. */
  readonly rateLimiter?: SlidingWindowLimiter;
  /**
   * Turns enforcement off while leaving the hooks installed.
   *
   * Used by the suites that make hundreds of calls from one address and are not
   * testing the limiter. Off by default, because a rate limit that defaults to
   * disabled is one deploy away from being disabled in production.
   */
  readonly rateLimitEnabled?: boolean;
}

export async function buildServer(options: BuildOptions): Promise<FastifyInstance> {
  const mail = resolveMail(options);
  const telephonyDeps = buildTelephonyDeps(options.env);
  const billingDeps = buildBillingDeps(options.env);
  const identityDeps = buildIdentityDeps({
    env: options.env,
    ...(options.events === undefined ? {} : { events: options.events }),
    deliver: mail.deliver,
  });
  const identityDataKey = await ensureIdentityDataKey(
    new SoftwareKeyProvider({
      masterKeys: masterKeysFromBase64({
        [options.env.MASTER_KEY_ID]: options.env.MASTER_KEY_BASE64,
      }),
      currentMasterKeyId: options.env.MASTER_KEY_ID,
    }),
  );
  /* Webhook registry keys. A separate provider from identity's (which wraps
     the identity data key under a different AAD domain) — same env, same
     constructor, and it keeps the two surfaces' wrapped blobs unambiguous.
     The worker builds its own from the same variables to decrypt at
     delivery. */
  const automationKeys = new SoftwareKeyProvider({
    masterKeys: masterKeysFromBase64({
      [options.env.MASTER_KEY_ID]: options.env.MASTER_KEY_BASE64,
    }),
    currentMasterKeyId: options.env.MASTER_KEY_ID,
  });
  const appRouter = createAppRouter({
    identity: identityDeps,
    identityDataKey,
    passkeys: buildPasskeyDeps(identityDeps, options.env),
    automation: { keys: automationKeys },
    work: buildWorkDeps(options.env),
    /* VAPID keys are optional (an instance without them is a valid deployment
       that simply does not send push); null is the honest answer the
       preferences page renders as "push unavailable on this server". */
    platform: { vapidPublicKey: options.env.VAPID_PUBLIC_KEY ?? null },
    /* Undefined when no carrier is configured. The routes exist either way and
       answer SERVICE_UNAVAILABLE — see telephony/router.ts. */
    telephony: telephonyDeps,
    /* Always built, unlike telephony: STUN with no TURN is a working
       deployment, so there is no "not configured" shape to answer with.
       Recording storage IS optional inside it — the recordings bucket is
       telephony's, shared rather than duplicated, and an instance without one
       answers SERVICE_UNAVAILABLE on the upload routes alone. */
    rtc: buildRtcDeps(options.env),
    oauth: buildOAuthDeps(options.env),
    /* Always built, like rtc: PAYMENTS_PROVIDER defaults to 'fake' rather
       than to an absent credential, so there is no "billing not configured"
       shape for the router to answer with — every org gets a real trial. */
    billing: billingDeps,
  });

  /* Guardrail 4, second half. Before a single connection is accepted: if any
     route reaches this point without declaring how it is reached, the process
     does not start. A test for this could be skipped; a boot failure cannot. */
  assertRoutesDeclarePermissions(appRouter);

  const app = Fastify({
    logger: { level: options.env.LOG_LEVEL },
    /* How far X-Forwarded-For is believed, from the validated environment and
       defaulting to "not at all". This was `true`, which is the setting that
       looks like it fixes client IPs behind a load balancer and actually lets
       any caller claim any address — see the note on TrustProxy in config/env.ts.
       Every per-IP limit below depends on this being right. */
    trustProxy: options.env.API_TRUST_PROXY,
    /* Fastify generates its own ids; ours are UUIDv7 so a log line sorts by time
       and joins to the audit log (§14). */
    genReqId: () => newId<'RequestId'>(),
    /* A body larger than this is a denial-of-service vector, not a document.
       File uploads never pass through the API — they go straight to object
       storage through a presigned URL (§8.4). */
    bodyLimit: 1_000_000,
    /* Fastify's router (find-my-way) bounds any single dynamic path segment
       to 100 characters by default — a ReDoS-style guard that has nothing to
       do with tRPC, and everything to do with how the fastify adapter
       reaches it: every batched query lands on ONE route, `/trpc/:path`,
       with every procedure name in the batch joined by commas into that
       single segment. A page firing eight or nine queries at once (an
       account page's own tab, a board's card panel) routinely produces a
       path segment past 150 characters with perfectly ordinary procedure
       names — no pathological input required — and the default answers
       every query in the batch with `414 FST_ERR_MAX_PARAM_LENGTH`, not just
       the one that pushed it over. `web/src/lib/trpc-client.ts`'s own
       `MAX_BATCH_URL_LENGTH` already promises the client will split a batch
       before its FULL url (this segment plus `?batch=1&input=...`) passes
       2000; matching that bound here means the client's promise and the
       server's limit describe the same guarantee instead of two independently
       chosen numbers that happen not to collide yet.

       This bug was found INDEPENDENTLY on two branches — Phase 7's line of
       work fixed it at 4096 and Phase 12 Wave 2's at 2000, which is how the
       two arrived at this file together. 2000 is the one kept, for the
       client-parity reason above; both regression tests are retained below
       in server.test.ts and pass under either bound, so the number is not
       what either test is really pinning — the ROUTING is.

       In `routerOptions` rather than the deprecated top-level form, which
       fastify@6 removes. */
    routerOptions: { maxParamLength: 2000 },
  });

  /* Registered BEFORE the tRPC plugin. Fastify hooks are inherited only by
     child contexts created after they are added, so registering this later
     would leave every /trpc route — the entire attack surface — unlimited,
     while the hooks still ran on the two health endpoints and looked fine. */
  registerRateLimit(app, {
    ...(options.rateLimiter === undefined ? {} : { limiter: options.rateLimiter }),
    ...(options.rateLimitEnabled === undefined ? {} : { enabled: options.rateLimitEnabled }),
  });

  /* Drains queued mail before the process exits. Without this, a deploy during
     a signup silently discards the verification link and the user is left with
     an account they cannot reach. */
  app.addHook('onClose', async () => {
    await mail.close();
  });

  app.get('/health/live', () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    // Readiness DOES check dependencies: an instance that cannot reach Postgres
    // should leave the load balancer rotation, which is the opposite of the
    // liveness answer above.
    const healthy = await isDatabaseHealthy();
    return healthy ? { status: 'ready' } : reply.status(503).send({ status: 'not-ready' });
  });

  /* Carrier webhooks (Phase 7 §3.11) — plain Fastify routes, registered BEFORE
     the tRPC plugin.
   *
   * Order matters for one specific reason: the tRPC adapter replaces the JSON
   * body parser with a pass-through, and these routes add their own
   * form-encoded parser. Registering them after would work today and is exactly
   * the kind of ordering nobody re-derives later.
   *
   * Only when a carrier is configured. Unlike the tRPC routes — whose SHAPE the
   * client generates from, so they must always exist — an HTTP endpoint has no
   * type to keep stable, and an unconfigured instance answering 404 on a
   * webhook path is better than one answering 503 to a carrier that will then
   * retry it for hours. */
  if (telephonyDeps !== undefined) {
    registerTelephonyWebhooks(app, { telephony: telephonyDeps });
  }

  await app.register(fastifyTRPCPlugin<AppRouter>, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,

      /**
       * Server-side error log.
       *
       * The client gets a generic message and a request id (§8.7), which means
       * the only place the real cause is ever recorded is here. Without this an
       * unexpected 500 is undiagnosable: the response deliberately says nothing,
       * and nothing else writes the stack down.
       *
       * `requestId` ties this line to the one the user can quote from their
       * screen, and to the audit entry for the same request (§14).
       */
      onError: ({ error, path, ctx }) => {
        app.log.error(
          {
            err: error,
            path,
            code: error.code,
            requestId: ctx?.requestId,
          },
          'trpc request failed',
        );
      },
      createContext: async ({ req, res }): Promise<RequestContext> => ({
        requestId: req.id as RequestContext['requestId'],
        principal: await authenticateRequest(req.headers.authorization, req.headers[ORG_HEADER], {
          jwtSecret: identityDeps.config.jwtSecret,
        }),
        refreshToken: readRefreshCookie(req.headers.cookie),
        ip: req.ip.length > 0 ? req.ip : null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,

        setRefreshCookie: (token) => {
          res.header(
            'set-cookie',
            token === null
              ? serializeRefreshCookie('', clearRefreshCookieOptions())
              : serializeRefreshCookie(token, refreshCookieOptions(REFRESH_COOKIE_MAX_AGE_SECONDS)),
          );
        },
      }),
    },
  });

  return app;
}

/**
 * Dispatches a request's `Authorization` header to the right authentication
 * path (ai/phase-10-automation.md §6.4).
 *
 * The bearer token's KIND is the discriminator: a `tf_pat_` token goes to
 * `authenticateWithApiToken`, everything else goes through the JWT path.
 *
 * The `startsWith` here is a cheap PRE-FILTER, not the authority — and it
 * MUST run on the PARSED bearer body, never on the raw header. The first
 * version checked `authorization.trim().startsWith('tf_pat_')`, and
 * `"Bearer tf_pat_…"` starts with `Bearer`, not `tf_pat_` — so every token
 * request fell through to the JWT path and answered UNAUTHENTICATED. Nothing
 * caught it: the slice-3 suite called `authenticateWithApiToken` directly,
 * which bypasses this dispatch entirely, and it took the HTTP round-trip
 * suite (slice 6) to make a real request. A misroute lands in the token
 * path, where `bearerToken` and `isTokenKind` re-check the parsed bearer and
 * refuse anything that is not genuinely a `tf_pat` — and a session JWT whose
 * base64url body happened to begin with the literal characters `tf_pat_` is
 * refused there too, rather than silently served, so the two paths agree on
 * what a bearer even is, fail-closed.
 *
 * The org resolution differs between the two paths and that is the point:
 *
 *  - the JWT path resolves the org from the `x-taskflow-org` header, because
 *    a session carries no org of its own;
 *  - the token path takes the org from the TOKEN and refuses a disagreeing
 *    header (decision 11) — a token is minted FOR an org, so the header is at
 *    most a confirmation, never a selector.
 */
async function authenticateRequest(
  authorization: string | undefined,
  orgHeader: string | string[] | undefined,
  config: { jwtSecret: Uint8Array },
): Promise<AuthenticatedPrincipal | null> {
  const bearer = bearerToken(authorization);
  if (bearer?.startsWith('tf_pat_') === true) {
    return authenticateWithApiToken(authorization, orgHeader);
  }
  return withOrgContext(await authenticate(authorization, config), orgHeader);
}

/**
 * Attaches the caller's organization membership to a principal, or leaves it null.
 *
 * The header naming the org is attacker-controlled, and it stays that way: it
 * selects a membership row and never becomes one. `resolveOrgMembership` reads
 * in `withUserScope(verifiedUserId)`, so the requested org id is a WHERE filter
 * and never reaches `app.org_id`; the ROLE comes from the row that lookup
 * returns. A caller naming an org they are not in matches nothing, `org` stays
 * null, and every permission-bearing route answers NOT_A_MEMBER.
 *
 * Absent or malformed header is the same as no membership rather than an error.
 * A request to `auth.login` or `auth.refresh` carries no org and must still
 * work, and self-scoped routes are defined by not needing one.
 *
 * A failure here is also treated as "no membership", not as a 500. If the
 * database is unreachable the caller cannot be authorized for anything anyway,
 * and the fail-closed answer is the one that does not hand an unauthenticated
 * caller a distinguishable error from a permission-bearing route.
 */
async function withOrgContext(
  principal: AuthenticatedPrincipal | null,
  header: string | string[] | undefined,
): Promise<AuthenticatedPrincipal | null> {
  if (principal === null) return null;

  const requested = Array.isArray(header) ? header[0] : header;
  if (typeof requested !== 'string' || requested.length === 0) return principal;

  try {
    const org = await resolveOrgMembership(principal.userId, requested);
    return org === null ? principal : { ...principal, org };
  } catch {
    return principal;
  }
}

/**
 * Builds OAuth's provider config from env, per provider independently — the
 * same "an unconfigured integration is a valid deployment" convention as
 * `platform.vapidPublicKey` above. A provider missing either half of its
 * client id/secret is simply absent from `providers`, and `oauth.service.ts`
 * refuses with `NOT_FOUND` rather than the app failing to boot.
 */
function buildOAuthDeps(env: Env): Omit<OAuthDeps, 'identity'> {
  return {
    providers: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
    /* Registered with each provider's own console ahead of time — this is the
       one value that has to match exactly what was registered there, since
       an OAuth authorization server refuses a redirect_uri it does not
       recognize verbatim. */
    redirectUri: (provider) => `${env.WEB_ORIGIN}/oauth/callback/${provider}`,
  };
}

/**
 * Decides who delivers mail, and who closes the queue.
 *
 * An injected `deliver` replaces the whole pipeline — that is what the test
 * suites use, because they need to read the token out of a link and a real
 * mailer will not hand one back. Otherwise the SMTP-backed queue is built HERE,
 * so exactly one thing owns it and that thing has an `onClose` hook to drain it.
 */
function resolveMail(options: BuildOptions): {
  deliver: (message: DeliverableLink) => Promise<void>;
  close: () => Promise<void>;
} {
  if (options.deliver !== undefined) {
    return { deliver: options.deliver, close: () => Promise.resolve() };
  }

  /* Its own logger rather than `app.log`: the queue is built before Fastify
     exists, because the router needs a `deliver` and the router is asserted
     before a connection is accepted. This one still goes through
     @taskflow/observability, so the redaction paths in §8.7 apply. */
  const logger = createLogger({ name: 'api-mail', level: options.env.LOG_LEVEL });

  const delivery = createMailDelivery({
    env: options.env,
    ...(options.mailer === undefined ? {} : { mailer: options.mailer }),
    onFailure: (failure) => {
      /* The only record that a user never got their link. No body and no token:
         a link in a log file is a credential in a log file, readable by anyone
         with log access and retained far longer than the token's own lifetime. */
      logger.error(
        { to: failure.to, subject: failure.subject, attempts: failure.attempts },
        'mail delivery abandoned',
      );
    },
  });

  return { deliver: delivery.deliver, close: () => delivery.queue.close() };
}
