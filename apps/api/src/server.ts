import Fastify, { type FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { isDatabaseHealthy } from '@taskflow/db';
import { newId } from '@taskflow/security';
import { createAppRouter, type AppRouter } from './router.js';
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
import { authenticate } from './identity/authenticate.js';
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
  const identityDeps = buildIdentityDeps({
    env: options.env,
    ...(options.events === undefined ? {} : { events: options.events }),
    deliver: mail.deliver,
  });
  const appRouter = createAppRouter({
    identity: identityDeps,
    passkeys: buildPasskeyDeps(identityDeps, options.env),
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
        principal: await withOrgContext(
          await authenticate(req.headers.authorization, {
            jwtSecret: identityDeps.config.jwtSecret,
          }),
          req.headers[ORG_HEADER],
        ),
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
