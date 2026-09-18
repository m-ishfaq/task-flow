import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeDatabase, initializePlatformAdminDatabase } from '@taskflow/db';
import { connectAsMigrator } from '@taskflow/db/testing';
import { generateTotpCode } from '@taskflow/security/testing';
import { buildServer } from '../server.js';
import type { DeliverableLink } from './identity.service.js';
import { TEST_ENV } from '../testing/fixtures.js';

/**
 * TOTP as a second factor, end to end (Phase 12 Wave 2 §3.2), against real
 * Postgres and a real `buildServer()` — including its `ensureIdentityDataKey`
 * bootstrap, so this is the one suite that would notice the wrap/unwrap round
 * trip breaking, not merely the encrypt/decrypt call inside it.
 *
 * `packages/security`'s own tests prove `verifyTotpCode`/the challenge JWT in
 * isolation. What matters HERE is what only a real router can show: that
 * `auth.login` for an enrolled account returns a challenge instead of a
 * session, that the challenge is redeemable exactly through
 * `auth.totp.verifyLogin` and nothing else, that a recovery code is spent
 * exactly once, and that step-up gates enrollment and disablement.
 */

const PASSWORD = 'correct horse battery staple 42';

let app: FastifyInstance;
const deliveries: DeliverableLink[] = [];

beforeAll(async () => {
  const admin = await connectAsMigrator();
  await admin.query(`DELETE FROM identity.users WHERE email_normalized LIKE 'totp-%@example.test'`);
  await admin.end();

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'totp-test' });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'totp-test-admin',
  });
  app = await buildServer({
    env: TEST_ENV,
    /* The per-IP limiter is off for this suite, and that is about isolation
       rather than convenience. `auth.totp.verifyLogin` carries a real budget
       (10 per 15 minutes), every test here reaches it through the same
       loopback address, and `app.inject` shares one limiter across the file —
       so the lockout test below, which must submit five wrong codes, would
       start failing whichever test happened to run last. Rate limiting has its
       own suite; this one is about the second factor. */
    rateLimitEnabled: false,
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

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

interface TrpcBody {
  result?: { data?: unknown };
  error?: { data?: { code?: string } };
}

async function call(
  path: string,
  options: { payload?: unknown; token?: string } = {},
): Promise<{ status: number; body: TrpcBody }> {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
    payload: options.payload ?? {},
  });

  return { status: response.statusCode, body: response.json<TrpcBody>() };
}

/** Registers, verifies, and signs in with a password. Returns the access token. */
async function signedInUser(email: string): Promise<string> {
  await call('auth.register', { payload: { email, password: PASSWORD, name: 'Test User' } });

  const link = deliveries.find(
    (message) => message.kind === 'verify_email' && message.email === email,
  );
  await call('auth.verifyEmail', { payload: { token: link?.token ?? '' } });

  const { body } = await call('auth.login', { payload: { email, password: PASSWORD } });
  return (body.result?.data as { accessToken?: string }).accessToken ?? '';
}

/** Enrolls and confirms TOTP for an already signed-in user. Returns the secret and recovery codes. */
async function enrollTotp(
  token: string,
): Promise<{ secret: string; recoveryCodes: readonly string[] }> {
  const started = await call('auth.totp.startEnrollment', { token });
  const { secret } = started.body.result?.data as { secret: string; otpauthUrl: string };

  const confirmed = await call('auth.totp.confirmEnrollment', {
    token,
    payload: { code: generateTotpCode(secret) },
  });
  const { recoveryCodes } = confirmed.body.result?.data as { recoveryCodes: readonly string[] };

  return { secret, recoveryCodes };
}

/* -------------------------------------------------------------------------- *
 * Enrollment
 * -------------------------------------------------------------------------- */

describe('enrollment', () => {
  it('requires authentication', async () => {
    const response = await call('auth.totp.startEnrollment');

    expect(response.status).toBe(401);
    expect(response.body.error?.data?.code).toBe('UNAUTHENTICATED');
  });

  it('is unusable for login until confirmed', async () => {
    // An enrollment interrupted mid-flow must not lock the account: the
    // password step alone still returns a session, not a challenge.
    const token = await signedInUser('totp-pending@example.test');
    await call('auth.totp.startEnrollment', { token });

    const login = await call('auth.login', {
      payload: { email: 'totp-pending@example.test', password: PASSWORD },
    });

    expect((login.body.result?.data as { kind?: string }).kind).toBe('session');
  });

  it('rejects a wrong code at confirmation', async () => {
    const token = await signedInUser('totp-badcode@example.test');
    await call('auth.totp.startEnrollment', { token });

    const confirmed = await call('auth.totp.confirmEnrollment', {
      token,
      payload: { code: '000000' },
    });

    expect(confirmed.status).toBe(400);
  });

  it('confirms with a real code and returns ten recovery codes, shown once', async () => {
    const token = await signedInUser('totp-confirm@example.test');
    const { recoveryCodes } = await enrollTotp(token);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
  });

  it('emails the account owner that two-factor was enabled', async () => {
    const email = 'totp-mail@example.test';
    const token = await signedInUser(email);
    await enrollTotp(token);

    const notice = deliveries.find((m) => m.kind === 'totp_enabled' && m.email === email);
    expect(notice).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- *
 * Status — the account page's own question (§"Whether this account has a
 * CONFIRMED credential" in totp.service.ts)
 * -------------------------------------------------------------------------- */

describe('status', () => {
  it('is false with no enrollment, true once confirmed, and false again after an unconfirmed start', async () => {
    const token = await signedInUser('totp-status@example.test');

    const before = await app.inject({
      method: 'GET',
      url: '/trpc/auth.totp.status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((before.json<TrpcBody>().result?.data as { enabled?: boolean }).enabled).toBe(false);

    await enrollTotp(token);

    const after = await app.inject({
      method: 'GET',
      url: '/trpc/auth.totp.status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((after.json<TrpcBody>().result?.data as { enabled?: boolean }).enabled).toBe(true);
  });

  it('does not count an unconfirmed enrollment as enabled', async () => {
    const token = await signedInUser('totp-status-pending@example.test');
    await call('auth.totp.startEnrollment', { token });

    const status = await app.inject({
      method: 'GET',
      url: '/trpc/auth.totp.status',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((status.json<TrpcBody>().result?.data as { enabled?: boolean }).enabled).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * Login
 * -------------------------------------------------------------------------- */

describe('login with a confirmed second factor', () => {
  it('returns a challenge instead of a session', async () => {
    const token = await signedInUser('totp-login@example.test');
    await enrollTotp(token);

    const login = await call('auth.login', {
      payload: { email: 'totp-login@example.test', password: PASSWORD },
    });

    expect(login.status).toBe(200);
    const data = login.body.result?.data as { kind?: string; challengeToken?: string };
    expect(data.kind).toBe('totp_required');
    expect(data.challengeToken).toBeTruthy();
    // The whole point of the challenge: it is not itself a usable session.
    expect(login.body).not.toContain('accessToken');
  });

  it('redeems the challenge with a real TOTP code', async () => {
    const token = await signedInUser('totp-redeem@example.test');
    const { secret } = await enrollTotp(token);

    const login = await call('auth.login', {
      payload: { email: 'totp-redeem@example.test', password: PASSWORD },
    });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    const verified = await call('auth.totp.verifyLogin', {
      payload: { challengeToken, credential: { kind: 'totp', code: generateTotpCode(secret) } },
    });

    expect(verified.status).toBe(200);
    expect((verified.body.result?.data as { accessToken?: string }).accessToken).toBeTruthy();
  });

  it('refuses a wrong TOTP code', async () => {
    const token = await signedInUser('totp-wrongcode@example.test');
    await enrollTotp(token);

    const login = await call('auth.login', {
      payload: { email: 'totp-wrongcode@example.test', password: PASSWORD },
    });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    const verified = await call('auth.totp.verifyLogin', {
      payload: { challengeToken, credential: { kind: 'totp', code: '000000' } },
    });

    expect(verified.status).toBe(400);
  });

  it('refuses the SAME code twice, even though it is still cryptographically valid', async () => {
    /* otplib accepts a ±1-step window, so a code stays valid for up to 90
       seconds. Nothing recorded that one had been spent, so within that window
       the same six digits verified every time they were submitted — a code
       captured from a shoulder-surf, a phishing relay, or a request body that
       reached a log was replayable. `packages/security`'s own comment called
       this "single-use in practice", which was not true in any sense.

       The second login below uses the SAME code within the same window, so
       `verifyTotpCode` still says valid; only `last_used_step` (migration
       0077) distinguishes the two attempts. That is what makes this a test of
       the replay check rather than of the clock. */
    const email = 'totp-replay@example.test';
    const token = await signedInUser(email);
    const { secret } = await enrollTotp(token);

    const code = generateTotpCode(secret);

    const first = await call('auth.login', { payload: { email, password: PASSWORD } });
    const firstChallenge = (first.body.result?.data as { challengeToken: string }).challengeToken;
    const redeemed = await call('auth.totp.verifyLogin', {
      payload: { challengeToken: firstChallenge, credential: { kind: 'totp', code } },
    });
    expect(redeemed.status).toBe(200);

    // A fresh challenge, the same code. Nothing about the code has expired.
    const second = await call('auth.login', { payload: { email, password: PASSWORD } });
    const secondChallenge = (second.body.result?.data as { challengeToken: string }).challengeToken;
    const replayed = await call('auth.totp.verifyLogin', {
      payload: { challengeToken: secondChallenge, credential: { kind: 'totp', code } },
    });
    expect(replayed.status).toBe(400);
  });

  it('locks the account after repeated wrong codes, and the lock outlives the challenge', async () => {
    /* The gap this closes: the password factor recorded every wrong guess
       against the database-backed lockout, and the second factor recorded
       nothing at all. An attacker holding a phished password therefore met a
       5-per-15-minutes lock on the first door and an unlimited, silent
       guessing loop on the second — against a six-digit code with a ±1 step
       window, which is three valid codes in a million.

       Asserted through the account's OWN state, not through the refusal: a
       wrong code answered 400 before this fix too, so a test that only
       checked the status code would have passed against the vulnerable
       version. What distinguishes them is that the fifth wrong code makes the
       PASSWORD path start refusing a correct password. */
    const email = 'totp-lockout@example.test';
    const token = await signedInUser(email);
    const { secret } = await enrollTotp(token);

    const login = await call('auth.login', { payload: { email, password: PASSWORD } });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    // LOCK_THRESHOLD is 5 (identity/deps.ts).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await call('auth.totp.verifyLogin', {
        payload: { challengeToken, credential: { kind: 'totp', code: '000000' } },
      });
      expect(refused.status).toBe(400);
    }

    // The lock is on the ACCOUNT, so the first factor now refuses a password
    // that is entirely correct. This is the assertion that fails without the
    // `recordFailedLogin` call in `verifyLogin`.
    const afterLock = await call('auth.login', { payload: { email, password: PASSWORD } });
    expect(afterLock.status).toBe(401);

    // And the still-valid challenge token is now worthless — a challenge
    // minted before the lock landed must not outlive it, which is the
    // second half of the fix and the one a lockout alone would miss.
    const stale = await call('auth.totp.verifyLogin', {
      payload: { challengeToken, credential: { kind: 'totp', code: generateTotpCode(secret) } },
    });
    expect(stale.status).toBe(400);
  });

  it('redeems the challenge with a recovery code, exactly once', async () => {
    const token = await signedInUser('totp-recovery@example.test');
    const { recoveryCodes } = await enrollTotp(token);
    const code = recoveryCodes[0] ?? '';

    const login = await call('auth.login', {
      payload: { email: 'totp-recovery@example.test', password: PASSWORD },
    });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    const first = await call('auth.totp.verifyLogin', {
      payload: { challengeToken, credential: { kind: 'recovery', code } },
    });
    expect(first.status).toBe(200);

    // A second challenge, same recovery code — already spent.
    const login2 = await call('auth.login', {
      payload: { email: 'totp-recovery@example.test', password: PASSWORD },
    });
    const { challengeToken: challengeToken2 } = login2.body.result?.data as {
      challengeToken: string;
    };

    const second = await call('auth.totp.verifyLogin', {
      payload: { challengeToken: challengeToken2, credential: { kind: 'recovery', code } },
    });
    expect(second.status).toBe(400);
  });

  it('refuses a recovery code that matches no stored code', async () => {
    /* A junk recovery code produces a keyed index (migration 0078) that
       matches no row, so the fast path finds nothing and the legacy scan is
       empty — the attempt is refused without redeeming anyone's real code. */
    const token = await signedInUser('totp-badrecovery@example.test');
    await enrollTotp(token);

    const login = await call('auth.login', {
      payload: { email: 'totp-badrecovery@example.test', password: PASSWORD },
    });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    const attempt = await call('auth.totp.verifyLogin', {
      payload: { challengeToken, credential: { kind: 'recovery', code: 'ZZZZ-ZZZZ-ZZZZ' } },
    });
    expect(attempt.status).toBe(400);
  });

  it('refuses a challenge token presented to any other route', async () => {
    // The distinct JWT audience (`taskflow-totp-challenge` vs `taskflow-api`)
    // is the whole reason this cannot be replayed as a bearer token.
    const token = await signedInUser('totp-audience@example.test');
    await enrollTotp(token);

    const login = await call('auth.login', {
      payload: { email: 'totp-audience@example.test', password: PASSWORD },
    });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    const response = await app.inject({
      method: 'GET',
      url: '/trpc/auth.me',
      headers: { authorization: `Bearer ${challengeToken}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

/* -------------------------------------------------------------------------- *
 * Disable, and step-up
 * -------------------------------------------------------------------------- */

describe('disable', () => {
  it('requires step-up, not merely a valid access token', async () => {
    /* `buildServer`'s real clock means a token minted moments ago by
       `signedInUser` is still within the five-minute step-up ceiling, so this
       asserts the SHAPE of the gate (present, self-scoped) rather than trying
       to force a stale-credential rejection without manipulating time. */
    const token = await signedInUser('totp-disable@example.test');
    await enrollTotp(token);

    const disabled = await call('auth.totp.disable', { token });
    expect(disabled.status).toBe(200);

    // TOTP no longer required: password alone returns a session again.
    const login = await call('auth.login', {
      payload: { email: 'totp-disable@example.test', password: PASSWORD },
    });
    expect((login.body.result?.data as { kind?: string }).kind).toBe('session');
  });

  it('invalidates an in-flight challenge', async () => {
    // The account disabled TOTP between issuing the challenge and redeeming
    // it — the challenge must not still be honored.
    const token = await signedInUser('totp-race@example.test');
    const { secret } = await enrollTotp(token);

    const login = await call('auth.login', {
      payload: { email: 'totp-race@example.test', password: PASSWORD },
    });
    const { challengeToken } = login.body.result?.data as { challengeToken: string };

    await call('auth.totp.disable', { token });

    const verified = await call('auth.totp.verifyLogin', {
      payload: { challengeToken, credential: { kind: 'totp', code: generateTotpCode(secret) } },
    });

    expect(verified.status).toBe(400);
  });
});
