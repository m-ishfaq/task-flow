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
import { generateTestDeviceKey, signWithTestDeviceKey } from '@taskflow/security/testing';
import * as identity from './identity.service.js';
import * as sessions from './sessions.service.js';
import * as repo from './repository.js';
import type { DeliverableLink, IdentityDeps, TokenPair } from './identity.service.js';
import { TEST_JWT_PRIVATE_KEY } from '../testing/fixtures.js';

/**
 * Device binding (ai/phase-14-mobile.md §4.5), against real Postgres.
 *
 * ⚠ Human-review surface (§2.2), same tier as `channel-binding.test.ts` — the
 * property under test (a session's key binds it against `identity.sessions`'
 * real, migrated columns, and `refresh()`'s signature check runs against a
 * real row) is not something a fake repository could show. Real P-256
 * keypairs and real DER signatures throughout, for the same reason
 * `packages/security/src/device-binding.test.ts` uses them: a mocked verify
 * side only proves the test agrees with itself.
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

const JWT_STATE_SECRET = new Uint8Array(Buffer.alloc(32, 9));
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'devicebinding@example.test';

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

const REFUSED = codeOf(errors.tokenExpired());
const CONFLICT = codeOf(errors.conflict());
const VALIDATION_FAILED = codeOf(errors.validation({}));

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });
  initializeDatabase({ url: APP_URL, applicationName: 'device-binding-test' });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'device-binding-test-admin',
  });
}, 60_000);

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  events = new RecordingEventBus();
  delivered = [];
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

/** Finds the userId for the fixture account — device-key routes are user-scoped. */
async function fixtureUserId(): Promise<string> {
  const user = await repo.findUserByEmail(repo.normalizeEmail(EMAIL));
  if (user === undefined) throw new Error('fixture user not found');
  return user.id;
}

describe('device binding', () => {
  it('a native session with no bound key refreshes with no signature required — unchanged legacy behaviour', async () => {
    const pair = await signIn('native');
    const next = await identity.refresh(
      deps(),
      { refreshToken: pair.refreshToken },
      meta,
      'native',
    );
    expect(next.refreshToken).not.toBe(pair.refreshToken);
  });

  it('registers a key, then requires a valid signature on every subsequent refresh', async () => {
    const pair = await signIn('native');
    const userId = await fixtureUserId();
    const deviceKey = generateTestDeviceKey();

    const bound = await sessions.registerDeviceKey(
      deps(),
      userId,
      pair.sessionId,
      deviceKey.publicKey,
    );
    expect(bound).toEqual({ status: 'bound' });
    expect(events.names()).toContain('session.device_key_registered');

    // No signature at all: refused, and the token is NOT rotated/revoked.
    expect(
      await codeOfRejection(
        identity.refresh(deps(), { refreshToken: pair.refreshToken }, meta, 'native'),
      ),
    ).toBe(REFUSED);

    // A signature from a DIFFERENT key: refused too — the stolen-token case.
    const attackerKey = generateTestDeviceKey();
    expect(
      await codeOfRejection(
        identity.refresh(
          deps(),
          {
            refreshToken: pair.refreshToken,
            deviceSignature: signWithTestDeviceKey(attackerKey, pair.refreshToken),
          },
          meta,
          'native',
        ),
      ),
    ).toBe(REFUSED);

    // The token survives both refusals above — neither rotated nor revoked it.
    const next = await identity.refresh(
      deps(),
      {
        refreshToken: pair.refreshToken,
        deviceSignature: signWithTestDeviceKey(deviceKey, pair.refreshToken),
      },
      meta,
      'native',
    );
    expect(next.refreshToken).not.toBe(pair.refreshToken);
  });

  it('resubmitting the SAME key succeeds silently and does not re-emit the event', async () => {
    const pair = await signIn('native');
    const userId = await fixtureUserId();
    const { publicKey } = generateTestDeviceKey();

    await sessions.registerDeviceKey(deps(), userId, pair.sessionId, publicKey);
    const secondCall = await sessions.registerDeviceKey(deps(), userId, pair.sessionId, publicKey);

    expect(secondCall).toEqual({ status: 'bound' });
    expect(events.names().filter((name) => name === 'session.device_key_registered')).toHaveLength(
      1,
    );
  });

  it('refuses to rebind an already-bound session to a DIFFERENT key', async () => {
    const pair = await signIn('native');
    const userId = await fixtureUserId();
    const { publicKey: first } = generateTestDeviceKey();
    const { publicKey: second } = generateTestDeviceKey();

    await sessions.registerDeviceKey(deps(), userId, pair.sessionId, first);

    expect(
      await codeOfRejection(sessions.registerDeviceKey(deps(), userId, pair.sessionId, second)),
    ).toBe(CONFLICT);
  });

  it('refuses to bind a device key to a BROWSER session', async () => {
    const pair = await signIn('browser');
    const userId = await fixtureUserId();
    const { publicKey } = generateTestDeviceKey();

    expect(
      await codeOfRejection(sessions.registerDeviceKey(deps(), userId, pair.sessionId, publicKey)),
    ).toBe(VALIDATION_FAILED);
  });

  it('refuses a malformed public key', async () => {
    const pair = await signIn('native');
    const userId = await fixtureUserId();

    expect(
      await codeOfRejection(
        sessions.registerDeviceKey(deps(), userId, pair.sessionId, {
          x: 'not-valid',
          y: 'not-valid',
        }),
      ),
    ).toBe(VALIDATION_FAILED);
  });
});
