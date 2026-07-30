import { unsafeAsId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import { createAppRouter } from '../router.js';
import { buildIdentityDeps, buildPasskeyDeps } from '../identity/deps.js';
import { buildWorkDeps } from '../work/deps.js';
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
  DATABASE_URL: 'postgresql://taskflow_app:app-dev-secret@localhost:5432/taskflow',
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
    ...overrides,
  };
}

/** The real application router, wired with an in-test event recorder and no mail. */
export function testAppRouter(options: { deliver?: (m: DeliverableLink) => Promise<void> } = {}) {
  const events = new RecordingEventBus();
  const deps = buildIdentityDeps({
    env: TEST_ENV,
    events,
    deliver: options.deliver ?? (() => Promise.resolve()),
  });

  const passkeys = buildPasskeyDeps(deps, TEST_ENV);
  return {
    router: createAppRouter({ identity: deps, passkeys, work: buildWorkDeps(TEST_ENV) }),
    events,
    deps,
    passkeys,
  };
}
