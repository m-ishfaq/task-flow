import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { buildServer } from './server.js';
import type { DeliverableLink } from './identity/identity.service.js';
import type { Env } from './config/env.js';
import { TEST_ENV } from './testing/fixtures.js';

/**
 * HTTP-level tests.
 *
 * These exist because the caller-based tests in trpc/guardrails.test.ts bypass
 * the HTTP layer entirely, and the error SHAPE is produced there. The first real
 * boot of this server returned absolute filesystem paths in a 404 body — a
 * failure no unit test in this repo could have seen, because none of them went
 * through `errorFormatter`.
 *
 * `app.inject()` exercises the full request pipeline without opening a socket.
 */

/**
 * Shared with the other suites so there is one place a credential can be wrong.
 * An inline copy here previously carried a placeholder database password, which
 * surfaced as an opaque 500 rather than as a configuration error — exactly the
 * failure mode the onError log in server.ts now makes diagnosable.
 */
const env: Env = TEST_ENV;

let app: FastifyInstance;
const deliveries: DeliverableLink[] = [];

beforeAll(async () => {
  initializeDatabase({ url: env.DATABASE_URL, applicationName: 'server-test' });
  app = await buildServer({
    env,
    deliver: (message) => {
      deliveries.push(message);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe('health', () => {
  it('answers liveness without touching the database', async () => {
    // A liveness probe that checks Postgres restarts the API during a database
    // blip, turning a degradation into an outage.
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('tRPC surface', () => {
  it('serves a public route', async () => {
    const response = await app.inject({ method: 'GET', url: '/trpc/health.live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: { data: { status: 'ok' } } });
  });

  it('returns our error code for an unknown procedure', async () => {
    const response = await app.inject({ method: 'GET', url: '/trpc/nope.nothing' });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(404);
    // Inside `data`, because tRPC wraps the formatted shape in its own
    // `{ error: ... }` transport envelope.
    expect(body).toMatchObject({ error: { data: { code: 'NOT_FOUND', httpStatus: 404 } } });
  });

  it('never includes a stack trace in an error body', async () => {
    // The regression this file was written for. tRPC's default error shape
    // carries `stack` outside production, and an errorFormatter that spreads
    // `...shape` inherits it — leaking absolute paths and dependency versions to
    // an unauthenticated caller (§8.7).
    const response = await app.inject({ method: 'GET', url: '/trpc/nope.nothing' });
    const raw = response.body;

    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toMatch(/[A-Za-z]:\\/); // a Windows absolute path
    expect(raw).not.toMatch(/\/src\//);
  });

  it('carries a request id on every error', async () => {
    // Ties a user's screenshot to a log line and an audit entry (§14).
    const response = await app.inject({ method: 'GET', url: '/trpc/nope.nothing' });
    const body: { error?: { data?: { requestId?: string } } } = response.json();

    expect(typeof body.error?.data?.requestId).toBe('string');
    expect(body.error?.data?.requestId).not.toBe('');
    expect(body.error?.data?.requestId).not.toBe('unknown');
  });

  it('rejects an unauthenticated call to a protected route', async () => {
    // There are no protected routes yet, so this asserts the state that makes
    // that safe: anything not declared public is simply not reachable.
    const response = await app.inject({ method: 'GET', url: '/trpc/org.destroy' });
    expect(response.statusCode).toBe(404);
  });
});

describe('refresh cookie', () => {
  /**
   * The token-pair split only works if the refresh token reaches the browser as
   * an httpOnly cookie and NOT as JSON. These run through the real HTTP pipeline
   * because that is where the split is implemented — the caller-based tests
   * bypass it entirely.
   */

  async function register(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/trpc/auth.register',
      payload: { email, password: 'correct horse battery staple 42' },
    });

    const link = deliveries.find((message) => message.kind === 'verify_email');
    await app.inject({
      method: 'POST',
      url: '/trpc/auth.verifyEmail',
      payload: { token: link?.token ?? '' },
    });
    return email;
  }

  it('returns the refresh token in a cookie, never in the body', async () => {
    const email = await register('cookie-user@example.test');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password: 'correct horse battery staple 42' },
    });

    expect(response.statusCode).toBe(200);

    const setCookie = String(response.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('__Host-taskflow_refresh=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');

    // The body carries the short-lived half only. XSS can steal that for ten
    // minutes; it must not be able to steal the thing that mints new ones.
    const body = response.body;
    expect(body).toContain('accessToken');
    expect(body).not.toContain('refreshToken');
    expect(body).not.toContain('tf_rt_');
  });

  it('clears the cookie on logout', async () => {
    const response = await app.inject({ method: 'POST', url: '/trpc/auth.logout', payload: {} });

    const setCookie = String(response.headers['set-cookie'] ?? '');
    expect(setCookie).toContain('Max-Age=0');
  });
});

describe('bearer authentication', () => {
  /**
   * The end-to-end proof that the token this server issues is a token this
   * server accepts.
   *
   * Both halves existed and were unit-tested for a whole phase while the context
   * factory hardcoded `auth: null`, so nothing ever presented a real token to
   * the verifier. Everything was green.
   */

  async function loginFresh(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/trpc/auth.register',
      payload: { email, password: 'correct horse battery staple 42' },
    });

    const link = deliveries.find(
      (message) => message.kind === 'verify_email' && message.email === email,
    );
    await app.inject({
      method: 'POST',
      url: '/trpc/auth.verifyEmail',
      payload: { token: link?.token ?? '' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password: 'correct horse battery staple 42' },
    });

    const body: { result?: { data?: { accessToken?: string } } } = response.json();
    return body.result?.data?.accessToken ?? '';
  }

  it('accepts the access token it just issued on a self route', async () => {
    const accessToken = await loginFresh('bearer-user@example.test');
    expect(accessToken).not.toBe('');

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logoutEverywhere',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    // One live session — the one this test just created.
    expect(response.json()).toMatchObject({ result: { data: { revoked: 1 } } });
  });

  it('rejects the same route with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logoutEverywhere',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { data: { code: 'UNAUTHENTICATED' } } });
  });

  it('rejects a token whose signature has been altered', async () => {
    const accessToken = await loginFresh('forged-target@example.test');

    /* The FIRST character of the signature segment. The last one carries only 4
       significant bits of a 32-byte HS256 signature, so half the substitutions
       for it decode to the same bytes — flipping it produces a still-valid token
       and a test that passes at random. */
    const [header, payload, signature] = accessToken.split('.');
    const first = signature?.[0] === 'A' ? 'B' : 'A';
    const forged = `${header ?? ''}.${payload ?? ''}.${first}${signature?.slice(1) ?? ''}`;

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.logoutEverywhere',
      headers: { authorization: `Bearer ${forged}` },
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it('ignores a malformed token rather than failing the request', async () => {
    // A stale or garbled token must not break the route that would replace it,
    // or a client whose only problem is ten elapsed minutes can never recover.
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      headers: { authorization: 'Bearer garbage' },
      payload: { email: 'nobody@example.test', password: 'definitely the wrong one' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { data: { code: 'INVALID_CREDENTIALS' } } });
  });
});

describe('HTTP status mapping', () => {
  /**
   * Domain failures must carry the right STATUS, not just the right code.
   *
   * Every one of these answered 500 until an end-to-end run against the running
   * server exposed it — the error code in the body was correct throughout, which
   * is why the service tests and the caller tests both stayed green. A 500 tells
   * a client to retry, tells a load balancer the instance is unhealthy, and
   * lights up every 5xx alert, for a user mistyping their password.
   */

  it('returns 401 for bad credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email: 'nobody@example.test', password: 'definitely the wrong one' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { data: { code: 'INVALID_CREDENTIALS' } } });
  });

  it('returns 404 for a spent or unknown link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.verifyEmail',
      payload: { token: 'tf_ev_nonsense' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { data: { code: 'NOT_FOUND' } } });
  });

  it('returns 401 when refreshing without a cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/trpc/auth.refresh', payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { data: { code: 'TOKEN_EXPIRED' } } });
  });

  it('returns 400 for a password below the minimum length', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.register',
      payload: { email: 'short-pw@example.test', password: 'tooshort' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('never answers 5xx for a client mistake', async () => {
    // The property, stated once. Any of these returning 500 means an alert
    // fires and a load balancer starts pulling instances out of rotation.
    const clientMistakes = [
      { url: '/trpc/auth.login', payload: { email: 'x@y.test', password: 'wrong wrong wrong' } },
      { url: '/trpc/auth.verifyEmail', payload: { token: 'nope' } },
      {
        url: '/trpc/auth.resetPassword',
        payload: { token: 'nope', password: 'a valid length pw' },
      },
      { url: '/trpc/auth.refresh', payload: {} },
    ];

    for (const attempt of clientMistakes) {
      const response = await app.inject({ method: 'POST', ...attempt });
      expect(response.statusCode, attempt.url).toBeLessThan(500);
    }
  });
});
