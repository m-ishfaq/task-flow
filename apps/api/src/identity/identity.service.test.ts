import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase, sql, withGlobalScope } from '@taskflow/db';
import { up } from '@taskflow/db/migrate';
import { RecordingEventBus } from '@taskflow/events';
import { isAppError } from '@taskflow/contracts';
import { verifyAccessToken } from '@taskflow/security';
import * as identity from './identity.service.js';
import type { DeliverableLink, IdentityDeps } from './identity.service.js';

/**
 * Identity integration tests (PLAN.md §8.1).
 *
 * Against real Postgres, for the same reason the RLS tests are: the properties
 * that matter here are database behaviours. That a duplicate signup is stopped
 * by a unique index rather than by a check-then-insert, and that two concurrent
 * refreshes are adjudicated by a conditional UPDATE, cannot be demonstrated
 * against a fake — a fake would agree with whatever this file assumed.
 *
 * ⚠ These cover a HUMAN REVIEW SURFACE (§2.2). A failure here is a credential
 * bug, not a flaky test.
 */

const APP_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://taskflow_app:app-dev-secret@localhost:5432/taskflow';
const MIGRATION_URL =
  process.env['DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5432/taskflow';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const JWT_SECRET = new Uint8Array(Buffer.alloc(32, 7));

let events: RecordingEventBus;
let delivered: DeliverableLink[];
let breachResult: Awaited<ReturnType<IdentityDeps['checkBreached']>>;

function deps(config: Partial<IdentityDeps['config']> = {}): IdentityDeps {
  return {
    config: {
      jwtSecret: JWT_SECRET,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      verificationTtlMs: 24 * 60 * 60 * 1000,
      passwordResetTtlMs: 60 * 60 * 1000,
      lockThreshold: 3,
      lockDurationMs: 15 * 60 * 1000,
      onBreachCheckUnavailable: 'allow',
      ...config,
    },
    events,
    checkBreached: () => Promise.resolve(breachResult),
    deliver: (message) => {
      delivered.push(message);
      return Promise.resolve();
    },
  };
}

const meta = { ip: '203.0.113.5', userAgent: 'vitest' };

/** A password long enough to pass the length rule and not in any corpus. */
const PASSWORD = 'correct horse battery staple 42';

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });
  initializeDatabase({ url: APP_URL, applicationName: 'identity-test' });
}, 60_000);

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  events = new RecordingEventBus();
  delivered = [];
  breachResult = { status: 'ok' };

  // DELETE, not TRUNCATE. taskflow_app is granted SELECT/INSERT/UPDATE/DELETE
  // and nothing else — TRUNCATE is a separate privilege it deliberately lacks,
  // which this fixture discovered by trying. The row-level delete cascades to
  // sessions, refresh tokens and one-time links through their foreign keys, so
  // it is one statement either way, and running the fixture with exactly the
  // privileges the application has is the more honest test anyway.
  await withGlobalScope(async (tx) => {
    await tx.execute(sql`DELETE FROM identity.users`);
  });
});

/** Registers and verifies an account, returning its email. */
async function registeredUser(email = 'alice@example.test'): Promise<string> {
  await identity.register(deps(), { email, password: PASSWORD }, meta);
  const link = delivered.find((message) => message.kind === 'verify_email');
  await identity.verifyEmail(deps(), { token: link?.token ?? '' });
  delivered.length = 0;
  events.events.length = 0;
  return email;
}

function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : `not an AppError: ${String(error)}`;
}

async function codeOfRejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'no error',
    (error: unknown) => codeOf(error),
  );
}

describe('registration', () => {
  it('creates an account and sends a verification link', async () => {
    const result = await identity.register(
      deps(),
      { email: 'alice@example.test', password: PASSWORD },
      meta,
    );

    expect(result).toEqual({ status: 'verification_sent' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('verify_email');
    expect(events.names()).toEqual(['user.registered']);
  });

  it('answers identically for an address that is already taken', async () => {
    // The property that matters most here. A distinct response is an
    // account-existence oracle available to anyone with a browser, and for a B2B
    // product the account list is the customer list.
    await identity.register(deps(), { email: 'alice@example.test', password: PASSWORD }, meta);
    delivered.length = 0;
    events.events.length = 0;

    const second = await identity.register(
      deps(),
      { email: 'alice@example.test', password: 'a completely different password' },
      meta,
    );

    expect(second).toEqual({ status: 'verification_sent' });
    // The real owner is told someone tried, which is also how a genuine
    // duplicate ever gets noticed.
    expect(delivered[0]?.kind).toBe('duplicate_registration');
    expect(delivered[0]?.token).toBeUndefined();
    // No event: nothing happened.
    expect(events.names()).toEqual([]);
  });

  it('does not overwrite the existing password on a duplicate', async () => {
    await registeredUser();
    await identity.register(
      deps(),
      { email: 'alice@example.test', password: 'hunter22 hunter22' },
      meta,
    );

    // The original password still works; the second registration changed nothing.
    await expect(
      identity.login(deps(), { email: 'alice@example.test', password: PASSWORD }, meta),
    ).resolves.toBeDefined();
  });

  it('treats addresses as case-insensitive', async () => {
    await identity.register(deps(), { email: 'Alice@Example.test', password: PASSWORD }, meta);
    delivered.length = 0;

    await identity.register(deps(), { email: 'alice@example.TEST', password: PASSWORD }, meta);
    expect(delivered[0]?.kind).toBe('duplicate_registration');
  });

  it('rejects a breached password', async () => {
    breachResult = { status: 'breached', count: 12_345 };

    expect(
      await codeOfRejection(
        identity.register(deps(), { email: 'bob@example.test', password: 'Summer2024!!' }, meta),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('rejects a short password before doing any work', async () => {
    expect(
      await codeOfRejection(
        identity.register(deps(), { email: 'bob@example.test', password: 'short' }, meta),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('can be configured to fail closed when the breach service is down', async () => {
    breachResult = { status: 'unavailable', reason: 'ENOTFOUND' };

    const strict = deps({ onBreachCheckUnavailable: 'deny' });
    expect(
      await codeOfRejection(
        identity.register(strict, { email: 'bob@example.test', password: PASSWORD }, meta),
      ),
    ).toBe('SERVICE_UNAVAILABLE');
  });

  it('allows registration when the breach service is down, by default', async () => {
    breachResult = { status: 'unavailable', reason: 'ENOTFOUND' };

    await expect(
      identity.register(deps(), { email: 'bob@example.test', password: PASSWORD }, meta),
    ).resolves.toEqual({ status: 'verification_sent' });
  });
});

describe('email verification', () => {
  it('verifies with the emailed token', async () => {
    await identity.register(deps(), { email: 'alice@example.test', password: PASSWORD }, meta);
    const token = delivered[0]?.token ?? '';

    await expect(identity.verifyEmail(deps(), { token })).resolves.toEqual({ status: 'verified' });
    expect(events.names()).toContain('user.email_verified');
  });

  it('refuses a second use of the same link', async () => {
    // Mail clients prefetch links and users double-tap. Only the conditional
    // UPDATE makes exactly one attempt win.
    await identity.register(deps(), { email: 'alice@example.test', password: PASSWORD }, meta);
    const token = delivered[0]?.token ?? '';

    await identity.verifyEmail(deps(), { token });
    expect(await codeOfRejection(identity.verifyEmail(deps(), { token }))).toBe('NOT_FOUND');
  });

  it('refuses an unknown or expired token with the same answer', async () => {
    expect(await codeOfRejection(identity.verifyEmail(deps(), { token: 'tf_ev_nonsense' }))).toBe(
      'NOT_FOUND',
    );
  });

  it('survives two simultaneous clicks', async () => {
    await identity.register(deps(), { email: 'alice@example.test', password: PASSWORD }, meta);
    const token = delivered[0]?.token ?? '';

    const outcomes = await Promise.allSettled([
      identity.verifyEmail(deps(), { token }),
      identity.verifyEmail(deps(), { token }),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('login', () => {
  it('issues a token pair', async () => {
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);

    expect(pair.accessToken.split('.')).toHaveLength(3);
    expect(pair.refreshToken.startsWith('tf_rt_')).toBe(true);
    expect(pair.expiresInSeconds).toBe(600);
    expect(events.names()).toContain('user.logged_in');
  });

  it('signs an access token this API accepts', async () => {
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);
    const claims = await verifyAccessToken(pair.accessToken, { secret: JWT_SECRET });

    expect(claims.sessionId).toBe(pair.sessionId);
    expect(typeof claims.userId).toBe('string');
  });

  it('gives the same error for a wrong password and an unknown address', async () => {
    const email = await registeredUser();

    const wrongPassword = await codeOfRejection(
      identity.login(deps(), { email, password: 'not the password at all' }, meta),
    );
    const unknownUser = await codeOfRejection(
      identity.login(deps(), { email: 'nobody@example.test', password: PASSWORD }, meta),
    );

    expect(wrongPassword).toBe('INVALID_CREDENTIALS');
    expect(unknownUser).toBe('INVALID_CREDENTIALS');
  });

  it('takes a comparable amount of time for both', async () => {
    // Skipping the hash for unknown accounts answers in ~1 ms instead of ~50 ms,
    // and that gap is a remotely measurable oracle for "is this registered".
    const email = await registeredUser();

    const startKnown = performance.now();
    await codeOfRejection(identity.login(deps(), { email, password: 'wrong password here' }, meta));
    const known = performance.now() - startKnown;

    const startUnknown = performance.now();
    await codeOfRejection(
      identity.login(
        deps(),
        { email: 'nobody@example.test', password: 'wrong password here' },
        meta,
      ),
    );
    const unknown = performance.now() - startUnknown;

    // Generous bounds — "same order of magnitude" is what defeats the oracle,
    // and a tight ratio would be flaky on a shared runner.
    expect(unknown).toBeGreaterThan(known * 0.25);
  });

  it('records a failure event even for an address that does not exist', async () => {
    // Credential stuffing against non-existent accounts is the reconnaissance
    // phase, and it is invisible without this.
    await codeOfRejection(
      identity.login(deps(), { email: 'nobody@example.test', password: PASSWORD }, meta),
    );

    expect(events.names()).toEqual(['user.login_failed']);
    expect(events.events[0]?.payload).toMatchObject({ userId: null, reason: 'no_such_user' });
  });

  it('refuses an unverified account, with a distinct error', async () => {
    // Distinct on purpose: the caller has proven they know the password, so
    // there is nothing left to disclose, and "check your mail" is the only
    // useful thing to say.
    await identity.register(deps(), { email: 'carol@example.test', password: PASSWORD }, meta);

    expect(
      await codeOfRejection(
        identity.login(deps(), { email: 'carol@example.test', password: PASSWORD }, meta),
      ),
    ).toBe('EMAIL_NOT_VERIFIED');
  });

  it('locks the account after repeated failures', async () => {
    const email = await registeredUser();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await codeOfRejection(identity.login(deps(), { email, password: 'wrong password' }, meta));
    }

    expect(events.names()).toContain('user.account_locked');

    // The correct password is now refused too — and with the SAME error, because
    // saying "locked" confirms the account exists and tells an attacker their
    // guessing is working.
    expect(await codeOfRejection(identity.login(deps(), { email, password: PASSWORD }, meta))).toBe(
      'INVALID_CREDENTIALS',
    );
  });

  it('counts failures atomically under concurrent guesses', async () => {
    // Read-modify-write in JS would let parallel attempts each read the same
    // count and write back the same value, losing increments — so the lockout
    // would never fire under exactly the load it exists to stop.
    //
    // The threshold is raised out of the way for this case. With the real one, a
    // lock lands mid-run and later attempts short-circuit before incrementing —
    // correct behaviour, but it makes the final count depend on scheduling and
    // says nothing about atomicity. Locking is asserted separately below.
    const email = await registeredUser();
    const noLock = deps({ lockThreshold: 1_000 });

    await Promise.all(
      Array.from({ length: 6 }, () =>
        codeOfRejection(identity.login(noLock, { email, password: 'wrong password' }, meta)),
      ),
    );

    const row = await withGlobalScope(async (tx) =>
      tx.execute(
        sql`SELECT failed_login_count FROM identity.users WHERE email_normalized = ${email}`,
      ),
    );
    expect(Number((row.rows[0] as { failed_login_count: string }).failed_login_count)).toBe(6);
  });

  it('stops counting once the account is locked', async () => {
    // A locked account short-circuits before the password is checked, so the
    // counter stops. That is deliberate: continuing to increment would let an
    // attacker extend someone's lockout indefinitely by keeping the guesses
    // coming.
    const email = await registeredUser();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await codeOfRejection(identity.login(deps(), { email, password: 'wrong password' }, meta));
    }

    const row = await withGlobalScope(async (tx) =>
      tx.execute(
        sql`SELECT failed_login_count, locked_until FROM identity.users WHERE email_normalized = ${email}`,
      ),
    );
    const state = row.rows[0] as { failed_login_count: string; locked_until: string | null };

    expect(Number(state.failed_login_count)).toBe(3); // the threshold, not 6
    expect(state.locked_until).not.toBeNull();
  });

  it('clears the failure count after a success', async () => {
    const email = await registeredUser();
    await codeOfRejection(identity.login(deps(), { email, password: 'wrong password' }, meta));
    await identity.login(deps(), { email, password: PASSWORD }, meta);

    const row = await withGlobalScope(async (tx) =>
      tx.execute(
        sql`SELECT failed_login_count FROM identity.users WHERE email_normalized = ${email}`,
      ),
    );
    expect(Number((row.rows[0] as { failed_login_count: string }).failed_login_count)).toBe(0);
  });
});

describe('refresh rotation and reuse detection', () => {
  it('rotates the token on every use', async () => {
    const email = await registeredUser();
    const first = await identity.login(deps(), { email, password: PASSWORD }, meta);
    const second = await identity.refresh(deps(), { refreshToken: first.refreshToken }, meta);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('does not advance the step-up clock', async () => {
    // Refreshing is not proof of a credential. Treating it as one would keep a
    // stolen session permanently eligible for step-up protected operations.
    const email = await registeredUser();
    const first = await identity.login(deps(), { email, password: PASSWORD }, meta);
    const before = (await verifyAccessToken(first.accessToken, { secret: JWT_SECRET }))
      .authenticatedAt;

    const second = await identity.refresh(deps(), { refreshToken: first.refreshToken }, meta);
    const after = (await verifyAccessToken(second.accessToken, { secret: JWT_SECRET }))
      .authenticatedAt;

    expect(after).toBe(before);
  });

  it('revokes the whole session when a token is replayed', async () => {
    // The core of §8.1. A refresh token is a bearer credential, so rotation
    // means a stolen one is good only until the victim's browser refreshes — at
    // which point one party presents an already-rotated token, which no
    // legitimate client can do.
    const email = await registeredUser();
    const first = await identity.login(deps(), { email, password: PASSWORD }, meta);
    const second = await identity.refresh(deps(), { refreshToken: first.refreshToken }, meta);

    // The attacker replays the token they captured.
    expect(
      await codeOfRejection(identity.refresh(deps(), { refreshToken: first.refreshToken }, meta)),
    ).toBe('TOKEN_REUSED');

    expect(events.names()).toContain('session.token_reuse_detected');

    // And the legitimate holder is logged out too. Both parties hold tokens from
    // the same chain and there is no way to tell which is which, so ending it
    // for both is the only safe move.
    expect(
      await codeOfRejection(identity.refresh(deps(), { refreshToken: second.refreshToken }, meta)),
    ).toBe('TOKEN_EXPIRED');
  });

  it('adjudicates two simultaneous refreshes of the same token', async () => {
    // Without `rotated_at IS NULL` in the UPDATE's WHERE clause, both would
    // succeed and issue two valid chains from one token — the exact condition
    // reuse detection exists to catch, missed by the mechanism meant to catch it.
    const email = await registeredUser();
    const first = await identity.login(deps(), { email, password: PASSWORD }, meta);

    const outcomes = await Promise.allSettled([
      identity.refresh(deps(), { refreshToken: first.refreshToken }, meta),
      identity.refresh(deps(), { refreshToken: first.refreshToken }, meta),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses an unknown token', async () => {
    expect(
      await codeOfRejection(identity.refresh(deps(), { refreshToken: 'tf_rt_nonsense' }, meta)),
    ).toBe('TOKEN_EXPIRED');
  });

  it('refuses a token from a revoked session', async () => {
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);
    await identity.logout(deps(), { refreshToken: pair.refreshToken });

    expect(
      await codeOfRejection(identity.refresh(deps(), { refreshToken: pair.refreshToken }, meta)),
    ).toBe('TOKEN_EXPIRED');
  });
});

describe('logout', () => {
  it('revokes the session and emits an event', async () => {
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);

    await expect(identity.logout(deps(), { refreshToken: pair.refreshToken })).resolves.toEqual({
      status: 'ok',
    });
    expect(events.names()).toContain('session.revoked');
  });

  it('reports success for a token that was never valid', async () => {
    // A distinct answer would let an unauthenticated caller probe which tokens
    // are live.
    await expect(identity.logout(deps(), { refreshToken: 'tf_rt_nope' })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('ends every session when logging out everywhere', async () => {
    const email = await registeredUser();
    const first = await identity.login(deps(), { email, password: PASSWORD }, meta);
    const second = await identity.login(deps(), { email, password: PASSWORD }, meta);

    const userId = (await verifyAccessToken(first.accessToken, { secret: JWT_SECRET })).userId;
    const result = await identity.logoutEverywhere(deps(), { userId });

    expect(result.revoked).toBe(2);
    for (const pair of [first, second]) {
      expect(
        await codeOfRejection(identity.refresh(deps(), { refreshToken: pair.refreshToken }, meta)),
      ).toBe('TOKEN_EXPIRED');
    }
  });
});

describe('password reset', () => {
  it('sends a link and lets the password be changed', async () => {
    const email = await registeredUser();

    await identity.requestPasswordReset(deps(), { email }, meta);
    const token = delivered.find((m) => m.kind === 'password_reset')?.token ?? '';

    await expect(
      identity.resetPassword(deps(), { token, password: 'a brand new passphrase' }),
    ).resolves.toEqual({ status: 'reset' });

    await expect(
      identity.login(deps(), { email, password: 'a brand new passphrase' }, meta),
    ).resolves.toBeDefined();
  });

  it('reports success for an address that is not registered', async () => {
    await expect(
      identity.requestPasswordReset(deps(), { email: 'nobody@example.test' }, meta),
    ).resolves.toEqual({ status: 'sent' });

    expect(delivered).toHaveLength(0);
    expect(events.names()).toEqual([]);
  });

  it('ends every existing session', async () => {
    // Someone resetting their password is often doing it because they believe
    // they are compromised. Leaving the attacker's session alive makes the reset
    // theatre.
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);

    await identity.requestPasswordReset(deps(), { email }, meta);
    const token = delivered.find((m) => m.kind === 'password_reset')?.token ?? '';
    await identity.resetPassword(deps(), { token, password: 'a brand new passphrase' });

    expect(
      await codeOfRejection(identity.refresh(deps(), { refreshToken: pair.refreshToken }, meta)),
    ).toBe('TOKEN_EXPIRED');
  });

  it('refuses a reused link', async () => {
    const email = await registeredUser();
    await identity.requestPasswordReset(deps(), { email }, meta);
    const token = delivered.find((m) => m.kind === 'password_reset')?.token ?? '';

    await identity.resetPassword(deps(), { token, password: 'a brand new passphrase' });
    expect(
      await codeOfRejection(
        identity.resetPassword(deps(), { token, password: 'another one here' }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('rejects a breached new password', async () => {
    const email = await registeredUser();
    await identity.requestPasswordReset(deps(), { email }, meta);
    const token = delivered.find((m) => m.kind === 'password_reset')?.token ?? '';

    breachResult = { status: 'breached', count: 99 };
    expect(
      await codeOfRejection(identity.resetPassword(deps(), { token, password: 'Password1234!' })),
    ).toBe('VALIDATION_FAILED');
  });

  it('clears a lockout, so a locked-out user can recover', async () => {
    const email = await registeredUser();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await codeOfRejection(identity.login(deps(), { email, password: 'wrong password' }, meta));
    }

    await identity.requestPasswordReset(deps(), { email }, meta);
    const token = delivered.find((m) => m.kind === 'password_reset')?.token ?? '';
    await identity.resetPassword(deps(), { token, password: 'a brand new passphrase' });

    await expect(
      identity.login(deps(), { email, password: 'a brand new passphrase' }, meta),
    ).resolves.toBeDefined();
  });
});

describe('credential hygiene', () => {
  it('never stores a token in plaintext', async () => {
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);

    const rows = await withGlobalScope(async (tx) =>
      tx.execute(sql`SELECT token_hash FROM identity.refresh_tokens`),
    );

    const stored = rows.rows.map((row) => (row as { token_hash: string }).token_hash);
    expect(stored).not.toContain(pair.refreshToken);
    expect(stored.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  it('never puts a credential in a domain event', async () => {
    // Events reach the audit log, the notification worker, and eventually an
    // analytics pipeline — three places a credential must never arrive.
    const email = await registeredUser();
    const pair = await identity.login(deps(), { email, password: PASSWORD }, meta);

    const serialized = JSON.stringify(events.events);
    expect(serialized).not.toContain(pair.refreshToken);
    expect(serialized).not.toContain(pair.accessToken);
    expect(serialized).not.toContain(PASSWORD);
  });

  it('stores an Argon2id hash, not the password', async () => {
    await registeredUser();

    const rows = await withGlobalScope(async (tx) =>
      tx.execute(sql`SELECT password_hash FROM identity.users`),
    );
    const hash = (rows.rows[0] as { password_hash: string }).password_hash;

    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).not.toContain(PASSWORD);
  });
});
