import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';
import { findProfile, type Profile } from './profiles.js';
import { pushSubscriptionsModule } from './modules/platform.push-subscriptions.js';
import { usersModule, type SeededUser } from './modules/identity.users.js';
import type { SeedContext, SeedDb } from './context.js';
import type { SeedModule } from './registry.js';

/**
 * `platform.push_subscriptions` fixtures.
 *
 * The module's whole reason for existing separately from `platform.notifications`
 * is that this table's RLS is keyed on `app.user_id`, not `app.org_id`, and
 * `ctx.orgScope` cannot express that (see the module's own header). So the
 * thing this suite has to prove that `rtc.test.ts`'s pattern does not is: the
 * `set_config('app.user_id', ...)` calls happen in the right order relative to
 * the insert, once per user, with the right id each time — a fake harness
 * cannot enforce RLS the way real Postgres would, so the ordering itself is
 * the property under test.
 */

interface CapturedQuery {
  readonly kind: 'query';
  readonly text: string;
  readonly values: readonly unknown[];
}

interface CapturedInsert {
  readonly kind: 'insert';
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly userIdAtInsertTime: string | null;
}

type CapturedEvent = CapturedQuery | CapturedInsert;

interface Harness {
  readonly ctx: SeedContext;
  readonly events: readonly CapturedEvent[];
  queries(): readonly CapturedQuery[];
  inserts(): readonly CapturedInsert[];
}

function harnessFor(profile: Profile, users: readonly SeededUser[], seed = 'push-test'): Harness {
  const events: CapturedEvent[] = [];
  let currentUserId: string | null = null;

  const db: SeedDb = {
    query: (text, values = []) => {
      events.push({ kind: 'query', text, values });
      const setUserMatch = /set_config\('app\.user_id'/.exec(text);
      if (setUserMatch) {
        const value = values[0];
        currentUserId = typeof value === 'string' && value !== '' ? value : null;
      }
      return Promise.resolve([]);
    },
    insert: (table, columns, rows) => {
      events.push({ kind: 'insert', table, columns, rows, userIdAtInsertTime: currentUserId });
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
    reseedPlans: false,
    storage: null,
    telephony: null,
    keys: null,
    payments: null,
    platformOperator: null,
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
    events,
    queries: () => events.filter((e): e is CapturedQuery => e.kind === 'query'),
    inserts: () => events.filter((e): e is CapturedInsert => e.kind === 'insert'),
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
    email: `user${String(index)}@rinavai.seed.test`,
  };
}

/* Enough users that the 0.4 subscription rate is overwhelmingly likely to
   produce at least one subscriber and at least one non-subscriber for the
   fixed test seed. */
const USERS = Array.from({ length: 20 }, (_, i) => user(i));

const DEMO = findProfile('demo');

describe('platform.push_subscriptions', () => {
  it('sets app.user_id to the row-owning user before that user is inserted, every time', async () => {
    const harness = harnessFor(DEMO, USERS);
    await pushSubscriptionsModule.seed(harness.ctx);

    const inserts = harness.inserts();
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) {
      expect(insert.table).toBe('platform.push_subscriptions');
      const userIdIndex = insert.columns.indexOf('user_id');
      for (const row of insert.rows) {
        expect(insert.userIdAtInsertTime).toBe(row[userIdIndex]);
      }
    }
  });

  it('immediately precedes every insert with clear-org then set-user for that same insert', async () => {
    const harness = harnessFor(DEMO, USERS);
    await pushSubscriptionsModule.seed(harness.ctx);

    const setOrgEmpty = `set_config('app.org_id', ''`;
    const setUser = `set_config('app.user_id'`;

    const events = harness.events;
    const insertIndices = events
      .map((event, index) => (event.kind === 'insert' ? index : -1))
      .filter((index) => index >= 0);
    expect(insertIndices.length).toBeGreaterThan(0);

    for (const insertIndex of insertIndices) {
      const insertEvent = events[insertIndex];
      if (insertEvent?.kind !== 'insert') throw new Error('unreachable');

      const setUserEvent = events[insertIndex - 1];
      const clearOrgEvent = events[insertIndex - 2];
      expect(setUserEvent?.kind).toBe('query');
      expect(clearOrgEvent?.kind).toBe('query');
      if (setUserEvent?.kind !== 'query' || clearOrgEvent?.kind !== 'query') continue;

      expect(setUserEvent.text.includes(setUser)).toBe(true);
      expect(setUserEvent.values[0]).toBe(insertEvent.userIdAtInsertTime);
      expect(clearOrgEvent.text.includes(setOrgEmpty)).toBe(true);
    }
  });

  it('resets app.user_id to empty after the run finishes', async () => {
    const harness = harnessFor(DEMO, USERS);
    await pushSubscriptionsModule.seed(harness.ctx);

    // the final reset passes '' as a literal in the SQL text itself, not as a
    // bound parameter — matching reset.ts's own precedent for the same call.
    const last = harness.queries().at(-1);
    expect(last?.text).toContain(`set_config('app.user_id', '', false)`);
    expect(last?.values).toEqual([]);
  });

  it('writes 1 or 2 devices per subscribed user, never more, never zero', async () => {
    const harness = harnessFor(DEMO, USERS);
    await pushSubscriptionsModule.seed(harness.ctx);

    for (const insert of harness.inserts()) {
      expect(insert.rows.length).toBeGreaterThanOrEqual(1);
      expect(insert.rows.length).toBeLessThanOrEqual(2);
    }
  });

  it('every row has a plausible, non-empty endpoint/p256dh/auth and a valid user agent label', async () => {
    const harness = harnessFor(DEMO, USERS);
    await pushSubscriptionsModule.seed(harness.ctx);

    const inserts = harness.inserts();
    const first = inserts[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const endpointIndex = first.columns.indexOf('endpoint');
    const p256dhIndex = first.columns.indexOf('p256dh');
    const authIndex = first.columns.indexOf('auth');
    const uaIndex = first.columns.indexOf('user_agent_label');

    for (const insert of inserts) {
      for (const row of insert.rows) {
        expect(String(row[endpointIndex])).toMatch(/^https:\/\//);
        expect(String(row[p256dhIndex]).length).toBe(87);
        expect(String(row[authIndex]).length).toBe(22);
        expect(String(row[uaIndex]).length).toBeGreaterThan(0);
      }
    }
  });

  it('writes nothing when there are no users', async () => {
    const harness = harnessFor(DEMO, []);
    const result = await pushSubscriptionsModule.seed(harness.ctx);

    expect(harness.inserts()).toEqual([]);
    expect(result).toEqual({ subscriptionCount: 0 });
  });

  it('is byte-for-byte reproducible from the same seed', async () => {
    const a = harnessFor(DEMO, USERS, 'reproducible');
    const b = harnessFor(DEMO, USERS, 'reproducible');
    await pushSubscriptionsModule.seed(a.ctx);
    await pushSubscriptionsModule.seed(b.ctx);
    expect(a.inserts().map((i) => i.rows)).toEqual(b.inserts().map((i) => i.rows));
  });
});
