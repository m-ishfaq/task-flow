import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, initializeDatabase, sql, withGlobalScope } from '@taskflow/db';
import { up } from '@taskflow/db/migrate';
import { RecordingEventBus } from '@taskflow/events';
import { verifyAccessToken } from '@taskflow/security';
import * as identity from './identity.service.js';
import type { IdentityDeps, RequestMeta, TokenPair } from './identity.service.js';
import * as sessions from './sessions.service.js';
import * as repo from './repository.js';
import { TEST_JWT_PRIVATE_KEY, TEST_JWT_PUBLIC_KEY } from '../testing/fixtures.js';

/**
 * Phase 12 Wave 2 §3.4 — impossible-travel detection and the device/session
 * inventory, against real Postgres, in the same discipline as
 * `identity.service.test.ts`: the properties that matter are database
 * behaviours (the flag is a stored column; a revoked session stops being
 * listed; a session id that is not yours revokes nothing).
 *
 * The geo LOOKUP is injected — these tests exercise the wiring and the
 * decision, not the geoip-lite data, which `geo.test.ts` pins separately.
 * Real IPs are used anyway so the "non-routable IP" and "null IP" paths are
 * honest about which inputs skip the lookup entirely.
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

let events: RecordingEventBus;
let delivered: {
  kind: string;
  token?: string;
  previousCountry?: string;
  newCountry?: string;
}[];
/** Mutable clock — advancing it is how \"too little time between logins\" is expressed. */
let now: Date;

/** IP → country for the injected lookup. Defaults to \"unknown for everything\". */
let countryByIp: Record<string, string | null>;

function deps(
  lookupCountry: IdentityDeps['lookupCountry'] = (ip) =>
    Promise.resolve(ip === null ? null : (countryByIp[ip] ?? null)),
): IdentityDeps {
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
    checkBreached: () => Promise.resolve({ status: 'ok' as const }),
    deliver: (message) => {
      delivered.push(message);
      return Promise.resolve();
    },
    lookupCountry,
    now: () => now,
  };
}

function meta(
  ip: string | null,
  userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
): RequestMeta {
  return { ip, userAgent };
}

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });
  initializeDatabase({ url: APP_URL, applicationName: 'sessions-travel-test' });
}, 60_000);

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  events = new RecordingEventBus();
  delivered = [];
  now = new Date('2026-08-10T10:00:00Z');
  countryByIp = {};

  await withGlobalScope(async (tx) => {
    await tx.execute(sql`
      DELETE FROM identity.users
      WHERE email_normalized LIKE 'it-%@example.test'
    `);
  });
});

/** Registers and verifies a scoped test account, returning its email. */
async function registeredUser(email: string): Promise<string> {
  await identity.register(deps(), { email, password: PASSWORD }, meta('203.0.113.5'));
  const link = delivered.find((message) => message.kind === 'verify_email');
  await identity.verifyEmail(deps(), { token: link?.token ?? '' });
  delivered.length = 0;
  events.events.length = 0;
  return email;
}

async function loginSession(email: string, requestMeta: RequestMeta): Promise<TokenPair> {
  const result = await identity.login(deps(), { email, password: PASSWORD }, requestMeta);
  if (result.kind !== 'session') {
    throw new Error(`expected a session, got a TOTP challenge`);
  }
  return result.pair;
}

async function userIdOf(pair: TokenPair): Promise<string> {
  return (await verifyAccessToken(pair.accessToken, { publicKey: TEST_JWT_PUBLIC_KEY })).userId;
}

async function storedSessions(
  userId: string,
): Promise<{ country: string | null; impossibleTravelAt: Date | null }[]> {
  return repo.listSessions(userId);
}

describe('impossible-travel detection at login (§3.4)', () => {
  it('stores the country on every login, even one never flagged', async () => {
    const email = await registeredUser('it-one@example.test');
    countryByIp = { '1.1.1.1': 'US' };

    const pair = await loginSession(email, meta('1.1.1.1'));
    const rows = await storedSessions(await userIdOf(pair));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.country).toBe('US');
    expect(rows[0]?.impossibleTravelAt).toBeNull();
    expect(events.names()).not.toContain('session.impossible_travel_detected');
  });

  it('flags a second country reached too fast, records it, and emits the event', async () => {
    const email = await registeredUser('it-two@example.test');
    countryByIp = { '1.1.1.1': 'US', '2.2.2.2': 'FR' };

    await loginSession(email, meta('1.1.1.1'));
    events.events.length = 0;

    now = new Date(now.getTime() + 60 * 60 * 1000); // one hour later
    const pair = await loginSession(email, meta('2.2.2.2'));
    const rows = await storedSessions(await userIdOf(pair));

    expect(rows).toHaveLength(2);
    const second = rows[0];
    expect(second?.country).toBe('FR');
    expect(second?.impossibleTravelAt).not.toBeNull();

    const flagged = events.events.find(
      (event) => event.name === 'session.impossible_travel_detected',
    );
    expect(flagged).toBeDefined();
    expect(flagged?.payload).toMatchObject({
      userId: await userIdOf(pair),
      sessionId: pair.sessionId,
      previousCountry: 'US',
      newCountry: 'FR',
    });

    /* The audit event alone reaches nobody but a log reader — the person
       whose account this is finds out only if they are actually emailed. */
    const mail = delivered.find((message) => message.kind === 'impossible_travel');
    expect(mail).toBeDefined();
    expect(mail?.previousCountry).toBe('US');
    expect(mail?.newCountry).toBe('FR');
  });

  it('does not flag the same country twice', async () => {
    const email = await registeredUser('it-same@example.test');
    countryByIp = { '1.1.1.1': 'US' };

    await loginSession(email, meta('1.1.1.1'));
    now = new Date(now.getTime() + 60 * 60 * 1000);
    const pair = await loginSession(email, meta('1.1.1.1'));
    const rows = await storedSessions(await userIdOf(pair));

    expect(rows[0]?.impossibleTravelAt).toBeNull();
    expect(events.names()).not.toContain('session.impossible_travel_detected');
    expect(delivered.some((message) => message.kind === 'impossible_travel')).toBe(false);
  });

  it('does not flag the same distance when enough time passed', async () => {
    const email = await registeredUser('it-slow@example.test');
    countryByIp = { '1.1.1.1': 'US', '2.2.2.2': 'FR' };

    await loginSession(email, meta('1.1.1.1'));
    now = new Date(now.getTime() + 12 * 60 * 60 * 1000); // a real overnight flight
    const pair = await loginSession(email, meta('2.2.2.2'));

    expect((await storedSessions(await userIdOf(pair)))[0]?.impossibleTravelAt).toBeNull();
    expect(events.names()).not.toContain('session.impossible_travel_detected');
  });

  it('does not flag when the previous session had no country to compare', async () => {
    const email = await registeredUser('it-prev@example.test');

    // First login with a null IP — no country stored, and (see next test) no
    // lookup is even attempted.
    await loginSession(email, meta(null));
    now = new Date(now.getTime() + 60 * 60 * 1000);

    countryByIp = { '2.2.2.2': 'FR' };
    const pair = await loginSession(email, meta('2.2.2.2'));

    expect((await storedSessions(await userIdOf(pair)))[0]?.impossibleTravelAt).toBeNull();
    expect(events.names()).not.toContain('session.impossible_travel_detected');
  });

  it('fails open when the geo lookup errors — a login must never break for geo', async () => {
    // `countryOfIp` (the production default) swallows load failures and
    // returns null; the wiring must survive even a lookup that throws, because
    // an informational control is never allowed to sit in the sign-in path.
    const email = await registeredUser('it-failopen@example.test');
    const throwing = deps(() => {
      throw new Error('geo database unavailable');
    });

    const first = await identity.login(throwing, { email, password: PASSWORD }, meta('1.1.1.1'));
    expect(first.kind).toBe('session');

    const second = await identity.login(throwing, { email, password: PASSWORD }, meta('2.2.2.2'));
    expect(second.kind).toBe('session');
    expect(events.names()).not.toContain('session.impossible_travel_detected');
  });

  it('does not flag when the new IP resolves to no country', async () => {
    const email = await registeredUser('it-nogeo@example.test');
    countryByIp = { '1.1.1.1': 'US' }; // 2.2.2.2 deliberately absent

    await loginSession(email, meta('1.1.1.1'));
    now = new Date(now.getTime() + 60 * 60 * 1000);
    const pair = await loginSession(email, meta('2.2.2.2'));

    const rows = await storedSessions(await userIdOf(pair));
    expect(rows[0]?.country).toBeNull();
    expect(rows[0]?.impossibleTravelAt).toBeNull();
    expect(events.names()).not.toContain('session.impossible_travel_detected');
  });
});

describe('device/session inventory (§3.4)', () => {
  it('lists the caller’s active sessions with labels, current flag, and push count', async () => {
    const email = await registeredUser('it-list@example.test');
    countryByIp = { '1.1.1.1': 'US' };

    const first = await loginSession(
      email,
      meta(
        '1.1.1.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ),
    );
    const second = await loginSession(
      email,
      meta('1.1.1.1', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Firefox/121'),
    );

    const userId = await userIdOf(second);
    const result = await sessions.list(deps(), userId, first.sessionId);

    expect(result.sessions).toHaveLength(2);
    const byId = new Map(result.sessions.map((row) => [row.id, row]));
    expect(byId.get(first.sessionId)?.isCurrent).toBe(true);
    expect(byId.get(second.sessionId)?.isCurrent).toBe(false);
    expect(byId.get(first.sessionId)?.label).toBe('Chrome on macOS');
    expect(byId.get(second.sessionId)?.label).toBe('Firefox on Linux');
    expect(byId.get(first.sessionId)?.country).toBe('US');
    expect(result.pushDeviceCount).toBe(0);
  });

  it('revokes one of the caller’s own sessions and emits an event', async () => {
    const email = await registeredUser('it-revoke@example.test');

    const first = await loginSession(email, meta('1.1.1.1'));
    const second = await loginSession(email, meta('1.1.1.1'));
    const userId = await userIdOf(second);
    events.events.length = 0;

    const result = await sessions.revoke(deps(), userId, first.sessionId, meta('1.1.1.1'));

    expect(result).toEqual({ status: 'revoked' });
    expect(await storedSessions(userId)).toHaveLength(1);
    expect(events.names()).toContain('session.revoked');
  });

  it('revokes nothing and leaks nothing for a session id that is not yours', async () => {
    const emailA = await registeredUser('it-a@example.test');
    const emailB = await registeredUser('it-b@example.test');

    const pairA = await loginSession(emailA, meta('1.1.1.1'));
    const pairB = await loginSession(emailB, meta('1.1.1.1'));
    const userIdA = await userIdOf(pairA);
    const userIdB = await userIdOf(pairB);

    const result = await sessions.revoke(deps(), userIdA, pairB.sessionId, meta('1.1.1.1'));

    // Same success answer either way — the caller must not learn whether a
    // guessed session id ever existed.
    expect(result).toEqual({ status: 'revoked' });
    expect(await storedSessions(userIdA)).toHaveLength(1);
    expect(await storedSessions(userIdB)).toHaveLength(1);
    expect(events.names()).not.toContain('session.revoked');
  });
});
