import { unsafeAsId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import {
  importAccessTokenPrivateKey,
  importAccessTokenPublicKey,
  masterKeysFromBase64,
  SoftwareKeyProvider,
} from '@taskflow/security';
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

/**
 * A fixed, real RS256 test key pair — generated once for this fixture file,
 * not per test run, the same "deterministic fixed bytes" spirit as
 * `MASTER_KEY_BASE64: Buffer.alloc(32, 1)` below. Unlike that one, this can't
 * be arbitrary bytes: `Base64PemKey` validates PEM shape, and real
 * sign/verify round trips in `authenticate.test.ts` etc. need a real,
 * matching key pair, not just something that passes the env schema.
 */
const TEST_JWT_PRIVATE_KEY_PEM_B64 =
  'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2d0lCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktrd2dnU2xBZ0VBQW9JQkFRRE1PeUtUZHpGTDUzR0cKMmNUeG8rMUV3ZGd3WFpWQWJ2b284S3JZSEt5RTVZMncva3pnVE4rSk0vVDVIWXd4ZXV3SE1lc2oxdlozbmZlcApoRno2RDU4SEFxWHZJL1NTcTdTaEY4TFM1NUJpMUk1SlFXN0dvQjB6MEYya01mN2xjQ0hnK0VWSHZaNGdCT1FzCjU1ZUR3L1JWVEs1S3k5VHRLMnFLOFk5R2N0cDJSdUZCbjFmakJ2ejN6ZnVjcTVhektRcXZ6M2RJTVJLTFdtdDUKU0J3dnJSMmk2OHVuNDlzWjdjWmZZQnNqWDZpWWY5Y0ZiK09UUTkzRngvcjUzdlA3cjhxbTZ0dUtqTTUwdnEvNQo5OCtMcTFGbEp3Z2NmWWJreGhmeTJQdkJqc2JoY3NZTTd5UUkweThnc04ybTE3ek5uaS9MZG5mUUdPRDV6V3p1CndUNzBleldIQWdNQkFBRUNnZ0VBRGJhUXlVY1JFOUFzRXNwdmkyd2U0K1dDTHlreGV0eVl4b1AyYk1Gc0loWkoKejg4YmVWb2dEbFhqUnBEaDEzYXgvMyt1RXI5OTJDVk91bDZ0WVlzSCtoQUc5VW84UTFidEwzM3Bjb0RpOUlmaQpML0FKVUtQeW9nYUZLeC9DUmtTanViZmg2d0hENnRGNVFyeWdNMVJHaFMyN2JFRklnRTVRZnBqZXJuUEswSE11CkdQU2tFUGgybHgrcWhka25oTUlvemo1b0dCL3FWS2VOMXNoRDZiSGdCdTVJVTQxN3JvZEQ3M1B1V044RENRYVgKaTcyMGZSQ1hNYnhxRVN0cmxYb2Z0bFNLRjFsQXhHNTgzTG5TWlV2S1kvdlJ1U1F2RDZPdDhDQms1Zm1SYVJZTwpEL3Uzc2hrUERkYU5KYStaKy8xbTRrSHVrNW1Kc3BYNEtaSE9yTHB1eVFLQmdRRDY3ZHRjbzJPcjZYbTBQdlpTCm5yYWNnTWF0YVZpMEg2WmhBRWxzdzB0UGFsQ1RVVTUzbCthb3Q5Qjk2czB6by9FUHdINWhvTHluTjlKVFdNWFMKZjdpd1VtWnN0Qm83L1Y3ZER6YXdOeXA0Ti9keEhwYzRvRGc5MDEwV1poQTRoZnh3bndmcEN4c1VITzJ0ZDQ4YgpicmtVdmhrVUtmUUVHc01ZRE5pR2d3Szh2d0tCZ1FEUVc3Rk9VUGp5YmM4VC94clkvQURJQ256cWF1NDNXaHlyClhaNExmT3FJa1U0MTBUTHAzT2FLTWwvemdaNkluY2d4Y3VNZi9tUXRNc3J2d3Z4b0ZmaldUQUpVSkV1SG9vMzQKQlRhaEZVR0srUnRjcFBTRWpqZ1JkWG9JYW1PZ3JHcEE4d3pORzk1Q2RxY0EwUGVjaVcxNXlBQm41Tm1uYmh6UgpIUVJQZHNtUk9RS0JnUUNZOUJ2ZW9BbkZaSSsyK3hvU3lvUHRhZUd4R3FIalNkZVZFU093bEdwM2dncVRnZUFlCnJnei9rdXdYbE9SNE1kcGpDNmI5dzRpN05SK1RobTB2SG9OcGx4Q3YraWh6b01JT1paT2tYandaQTZSazQ0eXkKQzVlOHQvWHFEVlNkMzY0OHgvTitiaktYVS9yYzNoL3hUTkNzZ0NPeFV0RlhIeWtFbysvb0xqdWc2UUtCZ1FDWAo5OGpDamx5RXRZS3IydzBCNWd2TDI1cHdmNzF2c2RIblMwalNxREdIbWpPcEhRUTlmbGpId3lZb3ZRbWNLeml3Cm1GTUFLdE4yQSszd0lnOW0rMStiTGFVbEtiUE5JY3JhY3pMOUdqdkwyUlVUNVZ4U3NraENzNlJtTHZLclpoVzUKZVl5RXJTYlc0eU83Zks2ZEJiOUxhNHlnT2xKbHcvSlFzeEZKeENJUVFRS0JnUUNqUGpWbDJMb3hvdWtFV3lJWAoyRnRDdnhCbkowVVJmSXMvaTVKRmt1YS85dWd5NVRLREVzV1pRRlBSR2psWmVMRFNra0E3dExzcndqWnZKOGcwCmVTVVd3V3lMdzZOUVBBT3pVYThPNTlyQ3VVa1czVmUvaFJTSXFQS3d5dWZkZ0JkZ09WdUNERTFKdGhROWtlYWsKaFRVQjJBejlrY3d5ZlBQVTRkSkh3bXdGSlE9PQotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0t';

const TEST_JWT_PUBLIC_KEY_PEM_B64 =
  'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUF6RHNpazNjeFMrZHhodG5FOGFQdApSTUhZTUYyVlFHNzZLUENxMkJ5c2hPV05zUDVNNEV6ZmlUUDArUjJNTVhyc0J6SHJJOWIyZDUzM3FZUmMrZytmCkJ3S2w3eVAwa3F1MG9SZkMwdWVRWXRTT1NVRnV4cUFkTTlCZHBESCs1WEFoNFBoRlI3MmVJQVRrTE9lWGc4UDAKVlV5dVNzdlU3U3RxaXZHUFJuTGFka2JoUVo5WDR3Yjg5ODM3bkt1V3N5a0tyODkzU0RFU2kxcHJlVWdjTDYwZApvdXZMcCtQYkdlM0dYMkFiSTErb21IL1hCVy9qazBQZHhjZjYrZDd6KzYvS3B1cmJpb3pPZEw2ditmZlBpNnRSClpTY0lISDJHNU1ZWDh0ajd3WTdHNFhMR0RPOGtDTk12SUxEZHB0ZTh6WjR2eTNaMzBCamcrYzFzN3NFKzlIczEKaHdJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0t';

export const TEST_ENV: Env = parseEnv({
  DATABASE_URL: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
  MASTER_KEY_ID: 'mk-test',
  MASTER_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
  JWT_PRIVATE_KEY: TEST_JWT_PRIVATE_KEY_PEM_B64,
  JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY_PEM_B64,
  JWT_STATE_SECRET: Buffer.alloc(32, 2).toString('base64'),
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

/**
 * Pre-imported once, top-level-await, so `testAppRouter` below can stay a
 * plain synchronous function — it is called unawaited at module scope all
 * over this test suite (`const { router } = testAppRouter();`), and making it
 * async would ripple into every one of those call sites for a value most of
 * them never look at directly.
 */
export const TEST_JWT_PRIVATE_KEY = await importAccessTokenPrivateKey(TEST_JWT_PRIVATE_KEY_PEM_B64);
/** The matching public half — for any test that verifies an access token directly. */
export const TEST_JWT_PUBLIC_KEY = await importAccessTokenPublicKey(TEST_JWT_PUBLIC_KEY_PEM_B64);

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
    jwtPrivateKey: TEST_JWT_PRIVATE_KEY,
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
          jwtStateSecret: deps.config.jwtStateSecret,
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
