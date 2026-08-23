import { unsafeAsId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import { createAppRouter } from '../router.js';
import { buildIdentityDeps, buildPasskeyDeps } from '../identity/deps.js';
import { buildWorkDeps } from '../work/deps.js';
import { buildRtcDeps } from '../rtc/deps.js';
import { buildBillingDeps } from '../billing/deps.js';
import type { OAuthDeps } from '../identity/oauth.service.js';
import type { AuthenticatedPrincipal, OrgMembership, RequestContext } from '../trpc/context.js';
import type { DeliverableLink } from '../identity/identity.service.js';
import { parseEnv, type Env } from '../config/env.js';

/**
 * Shared test fixtures.
 *
 * Kept in one place because the request context grows: every field added to
 * `RequestContext` would otherwise have to be added to a dozen inline literals,
 * and the usual response to that chore is to loosen the type.
 */

export const TEST_ENV: Env = parseEnv({
  DATABASE_URL: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
  MASTER_KEY_ID: 'mk-test',
  MASTER_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  JWT_SECRET: Buffer.alloc(32, 2).toString('base64'),
  MAIL_HOST: 'localhost',
  MAIL_PORT: '1025',
  MAIL_FROM: 'TaskFlow <no-reply@taskflow.test>',
  WEB_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'fatal',

  /* Object storage and the scanner, pointed at the local compose stack (§8.4).
     Real values rather than placeholders because the storage contract tests
     actually talk to MinIO — a fake endpoint here would make them fail in a way
     that looks like a bug in the provider. */
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'taskflow',
  STORAGE_SECRET_ACCESS_KEY: 'taskflow-dev-secret',
  STORAGE_BUCKET_ATTACHMENTS: 'taskflow-attachments',
  STORAGE_BUCKET_EXPORTS: 'taskflow-exports',

  /* BILLING_STRIPE_PRICE_ID_PRO was here until Phase 12 Wave 4, when the
     catalog moved into `billing.plans`/`billing.plan_prices`. Removing it from
     the env schema without removing it here would not have been a silent
     mismatch — `assertNoMisspelledVariables` refuses an unrecognized
     `BILLING_` name, so every suite importing this fixture failed to COLLECT
     with the variable named. That is the check working: an env value nothing
     reads is exactly what it exists to catch. Tests that need a sellable plan
     now seed a real catalog row (see org-billing.service.test.ts). */
  /* Likewise the webhook secret: FakePaymentProvider compares it literally
     rather than verifying a real HMAC, but the webhook ROUTE 404s with none
     configured at all (§3.5's own "no real endpoint here" answer) — so a
     value here is what makes the webhook path testable end-to-end without a
     Stripe account, not a real secret. */
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
});

export function testContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: unsafeAsId<'RequestId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000ff'),
    principal: null,
    refreshToken: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    // No response to write to under the in-process caller. Routes still call it,
    // so it must exist rather than be optional — an optional callback would let
    // a route silently skip setting the cookie in production too.
    setRefreshCookie: () => undefined,
    ...overrides,
  };
}

/**
 * A principal with an org membership — what a permission-bearing route needs.
 *
 * Phase 2's membership lookup produces this for real. Until then it is the only
 * way to exercise `route({ permission })` at all, since no token carries an org.
 */
export function testPrincipal(
  role: OrgMembership['role'],
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return {
    userId: unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001'),
    sessionId: unsafeAsId<'SessionId'>('018f4d1e-7c3a-7b2e-8f1a-000000000002'),
    authenticatedAt: new Date(),
    org: {
      orgId: unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-00000000000a'),
      role,
      tuples: [],
    },
    tokenScopes: null,
    ...overrides,
  };
}

/**
 * Fixed, deterministic — the same substitution `TEST_ENV.MASTER_KEY_BASE64`
 * already makes for the real KMS-backed key. `secret-key.test.ts` proves the
 * real `ensureIdentityDataKey` get-or-create dance against real Postgres
 * separately; nothing in a route-level test needs the wrap/unwrap round trip
 * itself, only a stable 32-byte key the same TOTP secret can round-trip
 * through `encryptString`/`decryptString` under.
 */
export const TEST_IDENTITY_DATA_KEY = Buffer.alloc(32, 7);

/**
 * No providers configured by default — matching `TEST_ENV` carrying no
 * `GOOGLE_CLIENT_ID`/`GITHUB_CLIENT_ID`, the same "an unset integration is a
 * valid deployment" case `buildServer`'s own `buildOAuthDeps` handles.
 * `oauth.service.test.ts` builds its own fully-configured `OAuthDeps`
 * directly rather than through this fixture, since it also needs to inject
 * `fetchImpl`/`verifyGoogleIdToken` stubs no router-level test needs.
 */
const NO_OAUTH_PROVIDERS: Omit<OAuthDeps, 'identity'> = {
  providers: {},
  nativeProviders: {},
  redirectUri: (provider) => `${TEST_ENV.WEB_ORIGIN}/oauth/callback/${provider}`,
};

/** The real application router, wired with an in-test event recorder and no mail. */
export function testAppRouter(
  options: {
    deliver?: (m: DeliverableLink) => Promise<void>;
    oauth?: Omit<OAuthDeps, 'identity'>;
  } = {},
) {
  const events = new RecordingEventBus();
  const deps = buildIdentityDeps({
    env: TEST_ENV,
    events,
    deliver: options.deliver ?? (() => Promise.resolve()),
  });

  const passkeys = buildPasskeyDeps(deps, TEST_ENV);
  /* The same fixed master key TEST_ENV carries — wrapped blobs created by
     this provider unwrap under the identical bytes in the worker's
     delivery-loop tests. Shared by the webhook registry and the connector
     flow, mirroring buildServer's `automationKeys`. */
  const automationKeys = new SoftwareKeyProvider({
    masterKeys: masterKeysFromBase64({
      [TEST_ENV.MASTER_KEY_ID]: TEST_ENV.MASTER_KEY_BASE64,
    }),
    currentMasterKeyId: TEST_ENV.MASTER_KEY_ID,
  });
  return {
    router: createAppRouter({
      identity: deps,
      identityDataKey: TEST_IDENTITY_DATA_KEY,
      passkeys,
      automation: {
        keys: automationKeys,
        /* TEST_ENV leaves the flag at its off-by-default value, so the fixture
           router's rule builder cannot save a cost-bearing telephony action —
           the same shape a default deployment has. A suite exercising those
           actions builds its own router with the flag on. */
        telephonyActionsEnabled: TEST_ENV.AUTOMATION_TELEPHONY_ACTIONS_ENABLED,
        /* No connector is configured in the fixture — the same "an unset
           integration is a valid deployment" case buildServer's provider
           builder handles. begin/complete answer NOT_FOUND; nothing else on
           the surface touches these. */
        integration: {
          providers: {},
          redirectUri: (provider) => `${TEST_ENV.WEB_ORIGIN}/integrations/callback/${provider}`,
          webhookOrigin: undefined,
          jwtSecret: deps.config.jwtSecret,
          keys: automationKeys,
        },
      },
      work: buildWorkDeps(TEST_ENV),
      platform: { vapidPublicKey: null },
      /* No carrier in the fixture. The telephony routes still exist and answer
         SERVICE_UNAVAILABLE — which is what the manifest assertion and the
         tenancy fuzz harness need them to do, since both enumerate every
         registered route. */
      telephony: undefined,
      /* STUN only, and no TURN secret — so `iceServers` answers with the STUN
         entry and never mints. The TURN gate has its own suite against a
         recording minter (`turn-gate.test.ts`); this fixture deliberately
         cannot spend, so no test that forgets to stub it can. */
      rtc: buildRtcDeps(TEST_ENV),
      oauth: options.oauth ?? NO_OAUTH_PROVIDERS,
      /* PAYMENTS_PROVIDER defaults to 'fake' in TEST_ENV (no Stripe account
         in CI) — the same in-memory FakePaymentProvider every billing route
         must work end-to-end against. */
      billing: buildBillingDeps(TEST_ENV),
    }),
    events,
    deps,
    passkeys,
  };
}
