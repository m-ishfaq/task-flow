import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { isDatabaseHealthy, recordOperationalEvent } from '@taskflow/db';
import {
  importAccessTokenPrivateKey,
  importAccessTokenPublicKey,
  masterKeysFromBase64,
  newId,
  SoftwareKeyProvider,
  type AccessTokenVerifyConfig,
} from '@taskflow/security';
import { ensureIdentityDataKey } from './identity/secret-key.js';
import { createAppRouter, type AppRouter } from './router.js';
import type { IntegrationDeps } from './automation/integration.service.js';
import { buildWorkDeps } from './work/deps.js';
import { buildTelephonyDeps } from './telephony/deps.js';
import { buildRtcDeps } from './rtc/deps.js';
import { buildBillingDeps } from './billing/deps.js';
import { registerTelephonyWebhooks } from './telephony/webhook.routes.js';
import { registerBillingWebhooks } from './billing/webhook.routes.js';
import { registerIntegrationWebhooks } from './automation/integration-webhooks.js';
import { registerCalendarFeedRoute } from './identity/calendar-feed-route.js';
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
import type { MailQueue } from '@taskflow/mail';
import { createLogger } from '@taskflow/observability';
import { registerRateLimit } from './middleware/rate-limit.js';
import { getSystemSettings } from './platform-admin/system-settings-cache.js';
import { isPlatformOperator } from './platform-admin/operator.js';
import { getResolvedBranding } from './platform-admin/branding-cache.js';
import type { SlidingWindowLimiter } from './middleware/sliding-window.js';
import type { Env } from './config/env.js';
import type { EventBus } from '@taskflow/events';
import type { KeyProvider } from '@taskflow/contracts';
import type { Mailer } from '@taskflow/mail';
import type { DeliverableLink } from './identity/identity.service.js';
import type { PendingEmailSend } from './platform/notification.projection.js';

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
  /**
   * `main.ts`'s `notificationMail.send` — threaded to `platformAdmin` for
   * operator broadcasts (`AppRouterDeps.platform`'s own comment). Optional:
   * a test that never calls a broadcast route need not construct a mailer.
   */
  readonly sendNotificationEmail?: (send: PendingEmailSend) => void;
}

export async function buildServer(options: BuildOptions): Promise<FastifyInstance> {
  /* Access token keys, imported once here rather than inside buildIdentityDeps
     — see that function's own comment on why it stays synchronous. The public
     key is held in THIS scope (not on identityDeps.config, which only carries
     the private/signing half) because `authenticateRequest` below verifies,
     and a verifier must never be handed something it could sign with. */
  const jwtPrivateKey = await importAccessTokenPrivateKey(options.env.JWT_PRIVATE_KEY);
  const jwtPublicKey = await importAccessTokenPublicKey(options.env.JWT_PUBLIC_KEY);

  const mail = resolveMail(options);
  const { productName } = await getResolvedBranding();
  const billingDeps = buildBillingDeps(options.env, mail.queue, productName);
  /* Built AFTER billing so the outbound paths can reach the same mailer the
     billing module uses: the 80%/100% usage alerts are billing email that
     happens to be triggered by a telephony action, and routing them through a
     second queue would give them a different sender and a different template
     base for no reason. */
  const telephonyDeps = buildTelephonyDeps(options.env, billingDeps.mail);
  const identityDeps = buildIdentityDeps({
    env: options.env,
    ...(options.events === undefined ? {} : { events: options.events }),
    deliver: mail.deliver,
    jwtPrivateKey,
    productName,
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
    /* `auth.calendarFeed.mint`'s own use — nowhere else in the identity
       router builds a URL. */
    webOrigin: options.env.WEB_ORIGIN,
    passkeys: buildPasskeyDeps(identityDeps, options.env, productName),
    /* §9 decision 3 — whether the cost-bearing telephony actions exist in the
       rule builder. OFF by default; see config/env.ts. The connectors (Wave 4
       slice 2, §7) ride in here too: the connector state is signed with the
       SAME state secret oauth.service.ts's sign-in state and the TOTP
       challenge use (JWT_STATE_SECRET, not a second env var) — never the
       access token's RS256 key pair, which only this API's own signing path
       touches. */
    automation: {
      keys: automationKeys,
      telephonyActionsEnabled: options.env.AUTOMATION_TELEPHONY_ACTIONS_ENABLED,
      integration: buildIntegrationDeps(options.env, {
        jwtStateSecret: identityDeps.config.jwtStateSecret,
        keys: automationKeys,
      }),
    },
    work: buildWorkDeps(options.env),
    /* VAPID keys are optional (an instance without them is a valid deployment
       that simply does not send push); null is the honest answer the
       preferences page renders as "push unavailable on this server". */
    platform: {
      vapidPublicKey: options.env.VAPID_PUBLIC_KEY ?? null,
      ...(options.sendNotificationEmail === undefined
        ? {}
        : { sendNotificationEmail: options.sendNotificationEmail }),
    },
    /* Undefined when no carrier is configured. The routes exist either way and
       answer SERVICE_UNAVAILABLE — see telephony/router.ts. */
    telephony: telephonyDeps,
    /* Always built, unlike telephony: STUN with no TURN is a working
       deployment, so there is no "not configured" shape to answer with.
       Recording storage IS optional inside it — the recordings bucket is
       telephony's, shared rather than duplicated, and an instance without one
       answers SERVICE_UNAVAILABLE on the upload routes alone. */
    rtc: buildRtcDeps(options.env),
    oauth: buildOAuthDeps(options.env, productName),
    /* Always built, like rtc: PAYMENTS_PROVIDER defaults to 'fake' rather
       than to an absent credential, so there is no "billing not configured"
       shape for the router to answer with — every org gets a real trial. */
    billing: billingDeps,
    productName,
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

  /* Maintenance mode gate — reads the cached system_settings value and returns
     503 for every non-operator, non-health-check request when maintenance_mode
     is true. Registered after rate limiting (so the limiter still counts
     maintenance-blocked requests) but before the tRPC plugin (so the block
     happens before any route handling). Operator requests pass through because
     the platform console must remain reachable during maintenance — an operator
     needs the console to flip the toggle back off. Health checks also pass
     through so load balancers can still detect a live process. */
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    if (url === '/health/live' || url === '/health/ready') return;

    let settings: Awaited<ReturnType<typeof getSystemSettings>> | null = null;
    try {
      settings = await getSystemSettings();
    } catch {
      /* Settings unreadable — fail open (allow the request through) rather
         than blocking the entire site on a settings-table outage. */
      return;
    }

    if (!settings.maintenanceMode) return;

    /* Endpoints that must stay reachable during maintenance:

       1. Auth endpoints — otherwise nobody can sign in (including operators
          who need to disable maintenance). These are publicRoute in the
          identity router: login, register, refresh, logout, OAuth callbacks,
          passkey ceremonies, TOTP verification, and password reset.

       2. Platform admin routes — the operator console must remain fully
          functional during maintenance so an operator can flip it off. These
          are already gated by platformRoute (operator + step-up), so letting
          them through the maintenance gate adds no risk. The web client uses
          cookie auth (no Authorization header), so the bearer-token bypass
          below never fires for normal browser requests.

       The tRPC client uses httpBatchLink which sends ALL requests to a single
       batch URL (/trpc). The URL may be exactly "/trpc" (no trailing slash) or
       "/trpc/..." depending on the request. We must check for both. */
    if (url === '/trpc' || url.startsWith('/trpc/')) {
      const AUTH_PATTERN = /\.(login|register|refresh|logout|verifyEmail|resendVerification|requestPasswordReset|resetPassword|callback|finishAuthentication|verifyLogin|start|providers)/;
      if (AUTH_PATTERN.test(url)) return;

      if (url.startsWith("/trpc/platformAdmin.")) return;
    }

    /* Operator requests with a bearer token also bypass maintenance —
       covers programmatic access (CLI, scripts, mobile) that uses the
       Authorization header rather than cookies. */
    const auth = request.headers.authorization;
    if (typeof auth === 'string' && auth.length > 0) {
      try {
        const principal = await authenticateRequest(auth, undefined, { jwtPublicKey });
        if (principal !== null && (await isPlatformOperator(principal.userId))) return;
      } catch {
        /* Invalid token — fall through to the 503 block. */
      }
    }

    await reply.status(503).send({
      status: 'maintenance',
      message: settings.maintenanceMessage,
    });
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

  /* Billing webhook (Phase 12 Wave 3 §3.5) — registered unconditionally,
     unlike telephony: billingDeps always exists (§3.3's "never returns
     undefined"), so this route always exists too, the same reasoning `rtc`
     is always built. Needs its own raw-body JSON parser for the identical
     reason telephony's needs its own form-encoded one. */
  registerBillingWebhooks(app, { billing: billingDeps });

  /* Connector inbound webhooks (Phase 10 Wave 4 slice 3, §7.3) — plain
     Fastify routes, for the same reason as the carrier webhooks above: the
     caller is Slack/GitHub, a third party with no session. Registered
     UNCONDITIONALLY, unlike the carrier routes: an unconfigured instance
     answers 503 on the Slack route (no signing secret) rather than a 404
     that a provider configured out-of-band would retry forever without a
     usable diagnosis. The routes read the raw body, so they must be
     registered before the tRPC plugin the same way the carrier routes are. */
  registerIntegrationWebhooks(app, {
    keys: automationKeys,
    slackSigningSecret: options.env.SLACK_SIGNING_SECRET,
  });

  /* The calendar feed (§4 of the product-brainstorm build) — a plain
     Fastify route for the identical "no session, no tRPC route kind fits"
     reason the webhooks above are plain routes, registered unconditionally
     like billing's: there is no "not configured" shape, an unknown token
     just answers 404. ⚠ human-review surface — see
     `identity/calendar-feed-route.ts`'s own header. */
  registerCalendarFeedRoute(app, { webOrigin: options.env.WEB_ORIGIN });

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
          jwtPublicKey,
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
 *  - the JWT path resolves the org from the `x-rinavai-org` header, because
 *    a session carries no org of its own;
 *  - the token path takes the org from the TOKEN and refuses a disagreeing
 *    header (decision 11) — a token is minted FOR an org, so the header is at
 *    most a confirmation, never a selector.
 */
async function authenticateRequest(
  authorization: string | undefined,
  orgHeader: string | string[] | undefined,
  config: { jwtPublicKey: AccessTokenVerifyConfig['publicKey'] },
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
 *
 * `nativeProviders` is a SEPARATE map, deliberately not derived from
 * `providers` (ai/phase-14-mobile.md §4.4): Google's native client is a
 * different registration with no secret (`NativeOAuthProviderCredentials`'s
 * own comment explains why), and GitHub's is a second, dedicated OAuth App
 * whose one callback URL is the native deep link rather than the web origin.
 * A deployment with only the browser pair configured simply has no native
 * OAuth — `apps/mobile`'s sign-in screen omits that provider's button.
 */
function buildOAuthDeps(env: Env, productName?: string): Omit<OAuthDeps, 'identity'> {
  return {
    providers: {
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {}),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
    nativeProviders: {
      ...(env.GOOGLE_NATIVE_CLIENT_ID ? { google: { clientId: env.GOOGLE_NATIVE_CLIENT_ID } } : {}),
      ...(env.GITHUB_NATIVE_CLIENT_ID && env.GITHUB_NATIVE_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_NATIVE_CLIENT_ID,
              clientSecret: env.GITHUB_NATIVE_CLIENT_SECRET,
            },
          }
        : {}),
    },
    /* Registered with each provider's own console ahead of time — this is the
       one value that has to match exactly what was registered there, since
       an OAuth authorization server refuses a redirect_uri it does not
       recognize verbatim. Native ignores `provider`: both providers' native
       clients redirect to the SAME custom-scheme deep link
       (`app.config.ts`'s `scheme: 'taskflow'`), disambiguated server-side by
       `state.provider` in `oauth.service.ts`'s `callback`, not by the URL. */
    redirectUri: (provider, channel) =>
      channel === 'native'
        ? 'taskflow://oauth-callback'
        : `${env.WEB_ORIGIN}/oauth/callback/${provider}`,
    ...(productName != null ? { productName } : {}),
  };
}

/**
 * Builds the connector (Slack/GitHub) OAuth wiring from env.
 *
 * A provider missing either half of its client id/secret is simply absent
 * from `providers`, and `integration.begin`/`complete` refuse with NOT_FOUND
 * rather than the app failing to boot — the `buildOAuthDeps` convention. The
 * webhook origin is optional for the same reason: an instance that never
 * exposes inbound connector routes hides webhook URLs instead of printing
 * ones that 404.
 */
function buildIntegrationDeps(
  env: Env,
  keys: { jwtStateSecret: Uint8Array; keys: KeyProvider },
): IntegrationDeps {
  return {
    providers: {
      ...(env.SLACK_CONNECTOR_CLIENT_ID && env.SLACK_CONNECTOR_CLIENT_SECRET
        ? {
            slack: {
              clientId: env.SLACK_CONNECTOR_CLIENT_ID,
              clientSecret: env.SLACK_CONNECTOR_CLIENT_SECRET,
            },
          }
        : {}),
      ...(env.GITHUB_CONNECTOR_CLIENT_ID && env.GITHUB_CONNECTOR_CLIENT_SECRET
        ? {
            github: {
              clientId: env.GITHUB_CONNECTOR_CLIENT_ID,
              clientSecret: env.GITHUB_CONNECTOR_CLIENT_SECRET,
            },
          }
        : {}),
    },
    /* Registered with each provider's console ahead of time — the one value
       that must match exactly, the buildOAuthDeps note. The connector
       callback is a DIFFERENT path from the sign-in callback by design:
       these two flows mint different state claims and must never be able to
       cross-complete. */
    redirectUri: (provider) => `${env.WEB_ORIGIN}/integrations/callback/${provider}`,
    webhookOrigin: env.INTEGRATION_WEBHOOK_ORIGIN,
    ...keys,
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
  /**
   * The underlying queue, for billing email (Phase 12 Wave 4).
   *
   * Exposed rather than building a SECOND queue: one queue means one retry
   * policy, one drain on shutdown, and one place where delivery outcomes reach
   * the operations dashboard. Undefined when a test injected its own
   * `deliver` — there is no queue in that case, and billing mail is simply
   * skipped rather than faked.
   */
  queue?: MailQueue | undefined;
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
         with log access and retained far longer than the token's own lifetime.
         `reason` IS safe to log — it is the SMTP transport's own error text
         ("535 authentication failed", ECONNREFUSED, ...), never anything about
         the message it failed to send. Without it, this line was the entire
         incident record and said nothing about WHY — see MailFailure's own
         comment in @taskflow/mail. */
      logger.error(
        {
          to: failure.to,
          subject: failure.subject,
          attempts: failure.attempts,
          reason: failure.reason,
        },
        'mail delivery abandoned',
      );
      /* recordOperationalEvent() never throws into its caller (its own
         comment) — a missing ops-events connection must not turn a mail
         failure into an unhandled rejection in the queue's background loop.
         `to`/`subject` only, the identical redaction the log line above
         already applies. */
      void recordOperationalEvent({
        kind: 'mail',
        outcome: 'failure',
        target: failure.to,
        detail: { subject: failure.subject, attempts: failure.attempts, reason: failure.reason },
      });
    },
    onSuccess: (success) => {
      void recordOperationalEvent({
        kind: 'mail',
        outcome: 'success',
        target: success.to,
        detail: { subject: success.subject },
      });
    },
  });

  /* The queue rides along so billing email shares it — one retry policy, one
     drain on shutdown, one path to the operations dashboard. */
  return {
    deliver: delivery.deliver,
    queue: delivery.queue,
    close: () => delivery.queue.close(),
  };
}
