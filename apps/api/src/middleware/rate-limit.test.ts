import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { buildServer } from '../server.js';
import { SlidingWindowLimiter } from './sliding-window.js';
import { accountOf, proceduresOf } from './rate-limit.js';
import { TEST_ENV } from '../testing/fixtures.js';

/**
 * Rate limiting through the real HTTP pipeline (PLAN.md §8.9).
 *
 * The pure counter is tested in sliding-window.test.ts. What is tested HERE is
 * the wiring, which is where this kind of control usually fails: a hook
 * registered after the route it was meant to cover, a key that lets the caller
 * choose their own bucket, or a 429 that is sent and then ignored.
 */

describe('proceduresOf', () => {
  it('reads the procedure from a tRPC path', () => {
    expect(proceduresOf('/trpc/auth.login')).toEqual(['auth.login']);
  });

  it('reads every procedure from a batched path', () => {
    // Otherwise batching is a bypass: wrap the throttled procedure next to a
    // cheap one and the strict rule is never looked up.
    expect(proceduresOf('/trpc/auth.login,health.live?batch=1')).toEqual([
      'auth.login',
      'health.live',
    ]);
  });

  it('handles a percent-encoded path', () => {
    expect(proceduresOf('/trpc/auth.login%2Chealth.live?batch=1')).toEqual([
      'auth.login',
      'health.live',
    ]);
  });

  it('returns nothing for a non-tRPC path', () => {
    expect(proceduresOf('/health/live')).toEqual([]);
    expect(proceduresOf('/trpc/')).toEqual([]);
  });
});

describe('accountOf', () => {
  it('reads the email from a raw JSON string body', () => {
    /* The shape that actually arrives. The tRPC Fastify adapter swaps the JSON
       parser for a pass-through, so `request.body` on every /trpc route is text
       — and the object-only version of this function silently returned null for
       every real request, downgrading per-account keying to per-address. */
    expect(accountOf('{"email":"victim@example.test"}')).toBe('victim@example.test');
  });

  it('reads the email from a batched body', () => {
    expect(accountOf('{"0":{"email":"victim@example.test"}}')).toBe('victim@example.test');
  });

  it('normalizes the email so case cannot split the bucket', () => {
    // `Victim@example.test` and `victim@example.test` are one account, and must
    // be one rate limit key.
    expect(accountOf({ email: '  Victim@Example.test ' })).toBe('victim@example.test');
    expect(accountOf('{"email":"  Victim@Example.test "}')).toBe('victim@example.test');
  });

  it('ignores a body with no email', () => {
    expect(accountOf({ token: 'abc' })).toBeNull();
    expect(accountOf('{"token":"abc"}')).toBeNull();
    expect(accountOf(null)).toBeNull();
    expect(accountOf('not json at all')).toBeNull();
  });

  it('ignores a non-string email', () => {
    // A caller sending `email: {}` must not produce a key of "[object Object]"
    // that every such request then shares — or, worse, a distinct one per shape.
    expect(accountOf({ email: { toString: () => 'x' } })).toBeNull();
    expect(accountOf({ email: 42 })).toBeNull();
    expect(accountOf('{"email":42}')).toBeNull();
  });

  it('refuses to parse an oversized body', () => {
    // Parsing up to the 1 MB body limit inside the hook that exists to make
    // abuse cheap to refuse would be its own denial-of-service. Falling back to
    // address keying is the strict direction.
    const huge = `{"email":"a@b.test","pad":"${'x'.repeat(5_000)}"}`;
    expect(accountOf(huge)).toBeNull();
  });
});

describe('enforcement', () => {
  let app: FastifyInstance;
  const limiter = new SlidingWindowLimiter();

  beforeAll(async () => {
    initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'rate-limit-test' });
    app = await buildServer({ env: TEST_ENV, rateLimiter: limiter });
  });

  afterAll(async () => {
    await app.close();
    await closeDatabase();
  });

  async function login(email: string): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password: 'whatever it does not matter' },
    });
    return response.statusCode;
  }

  it('throttles repeated login attempts against one account', async () => {
    const email = 'throttle-me@example.test';

    // The §8.9 budget: five, then refused.
    for (let i = 0; i < 5; i += 1) {
      expect(await login(email), `attempt ${String(i + 1)}`).toBe(401);
    }

    expect(await login(email)).toBe(429);
  });

  it('does not throttle a different account from the same address', async () => {
    /* The reason the key is the account and not the address. A flat per-IP login
       limit is unusable behind office NAT: the sixth colleague to arrive in the
       morning cannot sign in. */
    expect(await login('someone-else@example.test')).toBe(401);
  });

  it('answers a /trpc route in the envelope a tRPC client can read', async () => {
    /**
     * This hook runs before tRPC, so it has to emit the shape belonging to the
     * route it refuses — and for `/trpc/*` that is tRPC's transport envelope,
     * NOT the REST `ApiError` one.
     *
     * It sent the REST shape everywhere until a real 429 reached a browser. The
     * tRPC client cannot parse it at all: it fails with "Unable to transform
     * response from server" and leaves `error.data` undefined, so the app showed
     * its generic "the server did not say what" for the one failure that says
     * precisely what, and ships a `retry-after` saying for how long.
     *
     * The earlier version of THIS TEST asserted the REST shape on a `/trpc`
     * route — it agreed with the bug, which is why nothing caught it. The fields
     * below are exactly what `TRPCClientError` reads.
     */
    const email = 'envelope@example.test';
    for (let i = 0; i < 5; i += 1) await login(email);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password: 'whatever it does not matter' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();

    const body: {
      error?: { message?: unknown; code?: unknown; data?: Record<string, unknown> };
    } = response.json();

    // A NUMBER at the top level — the JSON-RPC code. A string here is what made
    // the client refuse to transform the response.
    expect(typeof body.error?.code).toBe('number');
    expect(typeof body.error?.message).toBe('string');

    // And the domain fields where every other error in this API puts them.
    expect(body.error?.data?.['code']).toBe('RATE_LIMITED');
    expect(body.error?.data?.['httpStatus']).toBe(429);
    expect(typeof body.error?.data?.['requestId']).toBe('string');
    expect(typeof body.error?.data?.['retryAfterSeconds']).toBe('number');
  });

  it('actually stops the handler rather than decorating the response', async () => {
    /* The failure this exists for: a Fastify async hook that sends a reply but
       returns undefined lets the request continue to the route. The status says
       429, the login ran anyway, and the lockout counter still moved. */
    const email = 'stops-handler@example.test';
    for (let i = 0; i < 5; i += 1) await login(email);

    const before = limiter.size;
    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      payload: { email, password: 'whatever it does not matter' },
    });

    expect(response.statusCode).toBe(429);
    // A body that reached tRPC would carry tRPC's transport envelope instead.
    expect(response.json()).not.toHaveProperty('result');
    expect(limiter.size).toBe(before);
  });

  it('covers a batched call naming a throttled procedure', async () => {
    const email = 'batched@example.test';
    for (let i = 0; i < 5; i += 1) await login(email);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login,health.live?batch=1',
      payload: { email, password: 'whatever it does not matter' },
    });

    expect(response.statusCode).toBe(429);
  });

  it('leaves an unthrottled route alone', async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
    }
  });
});

describe('trust proxy', () => {
  it('does not let a caller-supplied X-Forwarded-For buy a fresh budget', async () => {
    /* The decisive test for the `trustProxy: true` this server shipped with.
       Under that setting each of these requests claims a different origin, so
       each gets its own 300-per-minute budget and none is ever refused — every
       per-IP limit in the system becomes opt-out by sending one header.

       With the env default of `false` they are all one address, so the global
       tier refuses once the budget is spent. */
    initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'proxy-test' });
    const app = await buildServer({ env: TEST_ENV });

    try {
      const statuses: number[] = [];
      for (let i = 0; i < 320; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/health/live',
          headers: { 'x-forwarded-for': `203.0.113.${String(i % 254)}` },
        });
        statuses.push(response.statusCode);
      }

      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await closeDatabase();
    }
  });
});
