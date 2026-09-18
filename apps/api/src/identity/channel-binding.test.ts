import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
  sql,
  withGlobalScope,
} from '@taskflow/db';
import { up } from '@taskflow/db/migrate';
import { RecordingEventBus } from '@taskflow/events';
import { errors, isAppError } from '@taskflow/contracts';
import * as identity from './identity.service.js';
import type { DeliverableLink, IdentityDeps, TokenPair } from './identity.service.js';
import { TEST_JWT_PRIVATE_KEY } from '../testing/fixtures.js';

/**
 * Channel binding (ai/phase-14-mobile.md §4.3), against real Postgres.
 *
 * ⚠ Human-review surface (§2.2). This proves the one property only a real
 * database and the real migration can show: a session records which client
 * channel minted it, and the refresh path refuses a token presented on a
 * DIFFERENT channel — a browser cookie token cannot be exchanged on the native
 * body-delivery route, and a native token cannot be exchanged on the browser
 * cookie route. A fake would just agree with whatever this file assumed; the
 * `sessions.channel` column and its default only exist in the migration.
 *
 * The second assertion in each case is the one that matters most: the refusal
 * must NOT revoke the token. The channel check runs before the reuse/rotation
 * branch precisely so a wrong-channel probe cannot end a real user's session —
 * the same reasoning behind checking it first in `identity.service.refresh`.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

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

const JWT_STATE_SECRET = new Uint8Array(Buffer.alloc(32, 7));
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'channel@example.test';

let events: RecordingEventBus;
let delivered: DeliverableLink[];

function deps(): IdentityDeps {
  return {
    config: {
      jwtPrivateKey: TEST_JWT_PRIVATE_KEY,
      jwtStateSecret: JWT_STATE_SECRET,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      verificationTtlMs: 24 * 60 * 60 * 1000,
      passwordResetTtlMs: 60 * 60 * 1000,
      lockThreshold: 3,
      lockDurationMs: 15 * 60 * 1000,
      onBreachCheckUnavailable: 'allow',
    },
    events,
    checkBreached: () => Promise.resolve({ status: 'ok' }),
    deliver: (message) => {
      delivered.push(message);
      return Promise.resolve();
    },
  };
}

const meta = { ip: '203.0.113.5', userAgent: 'vitest' };

const codeOf = (error: unknown): string =>
  isAppError(error) ? error.code : `not an AppError: ${String(error)}`;

const codeOfRejection = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'no error',
    (error: unknown) => codeOf(error),
  );

/** The code a cross-channel (or expired/invalid) refusal surfaces as — no oracle. */
const REFUSED = codeOf(errors.tokenExpired());

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });
  initializeDatabase({ url: APP_URL, applicationName: 'channel-binding-test' });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'channel-binding-test-admin',
  });
}, 60_000);

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  events = new RecordingEventBus();
  delivered = [];
  // Scoped to this file's own fixture email so it never races a suite running
  // in parallel against the shared taskflow_test database (see the note in
  // identity.service.test.ts). Cascades to sessions and refresh tokens.
  await withGlobalScope(async (tx) => {
    await tx.execute(sql`DELETE FROM identity.users WHERE email_normalized = ${EMAIL}`);
  });
});

/** Registers + verifies the fixture account, then signs it in on `channel`. */
async function signIn(channel: 'browser' | 'native'): Promise<TokenPair> {
  await identity.register(deps(), { email: EMAIL, password: PASSWORD }, meta);
  const link = delivered.find((message) => message.kind === 'verify_email');
  await identity.verifyEmail(deps(), { token: link?.token ?? '' });

  const result = await identity.login(deps(), { email: EMAIL, password: PASSWORD }, meta, channel);
  if (result.kind !== 'session') throw new Error('expected a session, got a TOTP challenge');
  return result.pair;
}

describe('refresh channel binding', () => {
  it('a native session refreshes on the native route', async () => {
    const pair = await signIn('native');
    const next = await identity.refresh(
      deps(),
      { refreshToken: pair.refreshToken },
      meta,
      'native',
    );
    expect(next.refreshToken).not.toBe(pair.refreshToken); // rotated
    expect(next.accessToken.length).toBeGreaterThan(0);
  });

  it('refuses a native token on the browser route, and the token survives', async () => {
    const pair = await signIn('native');

    // Presented on the wrong (browser) route: refused, and — crucially — not revoked.
    expect(
      await codeOfRejection(
        identity.refresh(deps(), { refreshToken: pair.refreshToken }, meta, 'browser'),
      ),
    ).toBe(REFUSED);

    // The same token still refreshes on its own channel: the refusal above did
    // not rotate or revoke it.
    const next = await identity.refresh(
      deps(),
      { refreshToken: pair.refreshToken },
      meta,
      'native',
    );
    expect(next.refreshToken).not.toBe(pair.refreshToken);
  });

  it('refuses a browser token on the native route, and the token survives', async () => {
    const pair = await signIn('browser');

    expect(
      await codeOfRejection(
        identity.refresh(deps(), { refreshToken: pair.refreshToken }, meta, 'native'),
      ),
    ).toBe(REFUSED);

    const next = await identity.refresh(
      deps(),
      { refreshToken: pair.refreshToken },
      meta,
      'browser',
    );
    expect(next.refreshToken).not.toBe(pair.refreshToken);
  });
});
