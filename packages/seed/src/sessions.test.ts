import { describe, expect, it } from 'vitest';
import { assessImpossibleTravel } from '@taskflow/api/identity/geo';
import { createRng } from './rng.js';
import { findProfile, type Profile } from './profiles.js';
import { sessionsModule } from './modules/identity.sessions.js';
import { usersModule, type SeededUser } from './modules/identity.users.js';
import type { SeedContext, SeedDb } from './context.js';
import type { SeedModule } from './registry.js';

/**
 * `identity.sessions`/`identity.refresh_tokens` fixtures.
 *
 * The module's own header explains why `impossible_travel_at` is COMPUTED
 * from the real `assessImpossibleTravel` rather than faked — this suite
 * checks that computation against the identical function, not against a
 * reimplementation of the threshold, so a change to the real formula cannot
 * silently leave this fixture asserting something the real service no
 * longer would.
 */

interface CapturedInsert {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

interface Harness {
  readonly ctx: SeedContext;
  rowsOf(table: string): readonly (readonly unknown[])[];
  columnsOf(table: string): readonly string[];
}

function harnessFor(
  profile: Profile,
  users: readonly SeededUser[],
  seed = 'sessions-test',
): Harness {
  const inserts: CapturedInsert[] = [];

  const db: SeedDb = {
    query: () => Promise.resolve([]),
    insert: (table, columns, rows) => {
      inserts.push({ table, columns, rows });
      return Promise.resolve(rows.length);
    },
  };

  const outputs = new Map<SeedModule, unknown>();
  outputs.set(usersModule, { users, password: 'unused' });

  const ctx: SeedContext = {
    db,
    rng: createRng(seed),
    profile,
    now: new Date('2026-08-06T12:00:00.000Z'),
    chaos: false,
    storage: null,
    telephony: null,
    keys: null,
    log: () => undefined,
    use: <Out>(module: SeedModule<Out>): Out => {
      if (!outputs.has(module)) throw new Error(`no output recorded for ${module.name}`);
      return outputs.get(module) as Out;
    },
    emit: () => undefined,
    bufferedEvents: () => [],
    orgScope: async (_orgId, fn) => fn(),
  };

  return {
    ctx,
    rowsOf: (table) => inserts.filter((i) => i.table === table).flatMap((i) => [...i.rows]),
    columnsOf: (table) => inserts.find((i) => i.table === table)?.columns ?? [],
  };
}

function id(kind: string, index: number): string {
  return `00000000-0000-7000-8000-${kind}${String(index).padStart(8, '0')}`;
}

function user(index: number): SeededUser {
  return {
    id: id('55', index),
    name: {
      first: `First${String(index)}`,
      last: `Last${String(index)}`,
      full: `F${String(index)} L`,
    },
    email: `user${String(index)}@taskflow.seed.test`,
  };
}

const USERS = Array.from({ length: 12 }, (_, i) => user(i));

const DEMO = findProfile('demo');

describe('identity.sessions', () => {
  it('writes nothing when there are no users', async () => {
    const harness = harnessFor(DEMO, []);
    const result = await sessionsModule.seed(harness.ctx);

    expect(harness.rowsOf('identity.sessions')).toEqual([]);
    expect(result).toEqual({ sessionCount: 0, impossibleTravelCount: 0 });
  });

  it('guarantees at least one impossible-travel-flagged session across the run', async () => {
    const harness = harnessFor(DEMO, USERS);
    const result = await sessionsModule.seed(harness.ctx);

    expect(result.impossibleTravelCount).toBeGreaterThan(0);

    const columns = harness.columnsOf('identity.sessions');
    const flagIndex = columns.indexOf('impossible_travel_at');
    const flagged = harness.rowsOf('identity.sessions').filter((row) => row[flagIndex] !== null);
    expect(flagged.length).toBe(result.impossibleTravelCount);
  });

  it('gives the first user at least two sessions, in two different countries', async () => {
    const harness = harnessFor(DEMO, USERS);
    await sessionsModule.seed(harness.ctx);

    const columns = harness.columnsOf('identity.sessions');
    const userIdIndex = columns.indexOf('user_id');
    const countryIndex = columns.indexOf('country');

    const firstUserId = USERS[0]?.id;
    const firstUserSessions = harness
      .rowsOf('identity.sessions')
      .filter((row) => row[userIdIndex] === firstUserId);

    expect(firstUserSessions.length).toBeGreaterThanOrEqual(2);
    const countries = new Set(firstUserSessions.map((row) => row[countryIndex]));
    expect(countries.size).toBeGreaterThanOrEqual(2);
  });

  it('every session with country data satisfies assessImpossibleTravel exactly where it is flagged', async () => {
    const harness = harnessFor(DEMO, USERS);
    await sessionsModule.seed(harness.ctx);

    const columns = harness.columnsOf('identity.sessions');
    const userIdIndex = columns.indexOf('user_id');
    const authenticatedAtIndex = columns.indexOf('authenticated_at');
    const revokedAtIndex = columns.indexOf('revoked_at');
    const expiresAtIndex = columns.indexOf('expires_at');
    const countryIndex = columns.indexOf('country');
    const flagIndex = columns.indexOf('impossible_travel_at');

    const rows = harness.rowsOf('identity.sessions');

    for (const userRow of USERS) {
      const sessions = rows
        .filter((row) => row[userIdIndex] === userRow.id)
        .map((row) => ({
          authenticatedAt: row[authenticatedAtIndex] as Date,
          revokedAt: row[revokedAtIndex] as Date | null,
          expiresAt: row[expiresAtIndex] as Date,
          country: row[countryIndex] as string | null,
          flagged: row[flagIndex] !== null,
        }))
        .sort((a, b) => a.authenticatedAt.getTime() - b.authenticatedAt.getTime());

      for (let i = 0; i < sessions.length; i += 1) {
        const session = sessions[i];
        if (session === undefined) continue;

        const priors = sessions.slice(0, i);
        let mostRecent: { country: string; authenticatedAt: Date } | undefined;
        for (const prior of priors) {
          if (prior.revokedAt !== null) continue;
          if (prior.expiresAt.getTime() <= session.authenticatedAt.getTime()) continue;
          if (prior.country === null) continue;
          if (mostRecent === undefined || prior.authenticatedAt > mostRecent.authenticatedAt) {
            mostRecent = { country: prior.country, authenticatedAt: prior.authenticatedAt };
          }
        }

        let expectedFlag = false;
        if (
          session.country !== null &&
          mostRecent !== undefined &&
          mostRecent.country !== session.country
        ) {
          expectedFlag = assessImpossibleTravel({
            previous: mostRecent,
            newCountry: session.country,
            now: session.authenticatedAt,
          });
        }

        expect(session.flagged).toBe(expectedFlag);
      }
    }
  });

  it('every refresh_tokens row references a session this run actually wrote, one-to-one', async () => {
    const harness = harnessFor(DEMO, USERS);
    await sessionsModule.seed(harness.ctx);

    const sessionColumns = harness.columnsOf('identity.sessions');
    const sessionIdIndex = sessionColumns.indexOf('id');
    const sessionIds = harness.rowsOf('identity.sessions').map((row) => row[sessionIdIndex]);

    const tokenColumns = harness.columnsOf('identity.refresh_tokens');
    const tokenSessionIdIndex = tokenColumns.indexOf('session_id');
    const tokenSessionIds = harness
      .rowsOf('identity.refresh_tokens')
      .map((row) => row[tokenSessionIdIndex]);

    expect(tokenSessionIds.sort()).toEqual([...sessionIds].sort());
  });

  it('every revoked session has a matching revoked_reason and every active one has neither', async () => {
    const harness = harnessFor(DEMO, USERS);
    await sessionsModule.seed(harness.ctx);

    const columns = harness.columnsOf('identity.sessions');
    const revokedAtIndex = columns.indexOf('revoked_at');
    const revokedReasonIndex = columns.indexOf('revoked_reason');

    for (const row of harness.rowsOf('identity.sessions')) {
      const revokedAt = row[revokedAtIndex];
      const revokedReason = row[revokedReasonIndex];
      if (revokedAt === null) {
        expect(revokedReason).toBeNull();
      } else {
        expect(revokedReason).not.toBeNull();
      }
    }
  });

  it('never authenticates, is last seen, or expires-from in the future relative to now', async () => {
    const harness = harnessFor(DEMO, USERS);
    await sessionsModule.seed(harness.ctx);

    const columns = harness.columnsOf('identity.sessions');
    const authenticatedAtIndex = columns.indexOf('authenticated_at');
    const lastSeenAtIndex = columns.indexOf('last_seen_at');

    for (const row of harness.rowsOf('identity.sessions')) {
      expect((row[authenticatedAtIndex] as Date).getTime()).toBeLessThanOrEqual(
        harness.ctx.now.getTime(),
      );
      expect((row[lastSeenAtIndex] as Date).getTime()).toBeLessThanOrEqual(
        harness.ctx.now.getTime(),
      );
    }
  });

  it('is byte-for-byte reproducible from the same seed', async () => {
    const a = harnessFor(DEMO, USERS, 'reproducible');
    const b = harnessFor(DEMO, USERS, 'reproducible');
    await sessionsModule.seed(a.ctx);
    await sessionsModule.seed(b.ctx);
    expect(a.rowsOf('identity.sessions')).toEqual(b.rowsOf('identity.sessions'));
    expect(a.rowsOf('identity.refresh_tokens')).toEqual(b.rowsOf('identity.refresh_tokens'));
  });
});
