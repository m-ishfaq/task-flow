import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@taskflow/events';
import { roleGrants, type Role } from '@taskflow/policy';
import { createRng } from './rng.js';
import { findProfile, type PeopleMix, type Profile } from './profiles.js';
import { peopleModule } from './modules/people.profiles.js';
import { orgsModule, type SeededMembership, type SeededOrg } from './modules/tenancy.orgs.js';
import type { SeedContext, SeedDb } from './context.js';
import type { SeedModule } from './registry.js';

/**
 * The People fixture, held to the invariants the DATABASE does not enforce.
 *
 * Migration 0031's composite FKs and CHECKs close the self-report and cross-
 * org-manager cases at the database, and `packages/db`'s suites prove those
 * on real Postgres. What the database does NOT constrain is the shape this
 * seeder exists to produce correctly: that the manager graph is acyclic (a
 * cycle is legal SQL — the SERVICE is the one that walks it, exactly as the
 * page tree's `ancestor_ids` is), and that the personal profile's windows
 * are the shapes the read path renders. So these tests re-derive the claims
 * from the rows the module actually writes, through the same fake context
 * docs.test.ts uses, and assert the properties no row-level check covers.
 *
 * No database. The RLS/constraint half is the database's own to prove.
 */

/* -------------------------------------------------------------------------- *
 * A fake context: captures what the module would have written.
 * -------------------------------------------------------------------------- */

interface CapturedInsert {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  /** The org scope in force — a missing one is the bug it catches. */
  readonly orgId: string | null;
}

interface Harness {
  readonly ctx: SeedContext;
  readonly inserts: CapturedInsert[];
  readonly events: DomainEvent[];
  rowsOf(table: string): readonly (readonly unknown[])[];
  columnsOf(table: string): readonly string[];
}

function harnessFor(
  profile: Profile,
  org: SeededOrg,
  seed = 'people-test',
  extraOrgs: readonly SeededOrg[] = [],
): Harness {
  const inserts: CapturedInsert[] = [];
  const events: DomainEvent[] = [];
  let currentOrg: string | null = null;

  const db: SeedDb = {
    query: () => Promise.resolve([]),
    insert: (table, columns, rows) => {
      inserts.push({ table, columns, rows, orgId: currentOrg });
      return Promise.resolve(rows.length);
    },
  };

  const outputs = new Map<SeedModule, unknown>();
  outputs.set(orgsModule, { orgs: [org, ...extraOrgs] });

  const ctx: SeedContext = {
    db,
    rng: createRng(seed),
    profile,
    now: new Date('2026-08-06T12:00:00.000Z'),
    chaos: false,
    storage: null,
    telephony: null,
    log: () => undefined,
    use: <Out>(module: SeedModule<Out>): Out => {
      if (!outputs.has(module)) throw new Error(`no output recorded for ${module.name}`);
      return outputs.get(module) as Out;
    },
    emit: (event) => events.push(event),
    bufferedEvents: () => events,
    orgScope: async (orgId, fn) => {
      const previous = currentOrg;
      currentOrg = orgId;
      try {
        return await fn();
      } finally {
        currentOrg = previous;
      }
    },
  };

  return {
    ctx,
    inserts,
    events,
    rowsOf: (table) => inserts.filter((i) => i.table === table).flatMap((i) => [...i.rows]),
    columnsOf: (table) => inserts.find((i) => i.table === table)?.columns ?? [],
  };
}

/* -------------------------------------------------------------------------- *
 * A tenant, small enough to read and complete enough to seed against.
 * -------------------------------------------------------------------------- */

function id(kind: string, index: number): string {
  return `00000000-0000-7000-8000-${kind}${String(index).padStart(8, '0')}`;
}

function membership(index: number, role: Role): SeededMembership {
  return {
    membershipId: id('4d', index),
    user: {
      id: id('55', index),
      name: {
        first: `First${String(index)}`,
        last: `Last${String(index)}`,
        full: `First${String(index)} Last${String(index)}`,
      },
      email: `user${String(index)}@taskflow.seed.test`,
    },
    role,
  };
}

const ORG_ID = id('a1', 1);

const MEMBERSHIPS: readonly SeededMembership[] = [
  membership(0, 'owner'),
  membership(1, 'admin'),
  membership(2, 'member'),
  membership(3, 'member'),
  membership(4, 'guest'),
];

function orgWith(): SeededOrg {
  const owner = MEMBERSHIPS[0];
  if (owner === undefined) throw new Error('fixture has no owner');
  return {
    id: ORG_ID,
    name: 'Test Org',
    slug: 'test-org',
    plan: {
      name: 'Test Org',
      slug: 'test-org',
      grants: 0,
      teams: [],
      members: MEMBERSHIPS.map((m, i) => ({ user: i, role: m.role })),
      channels: [],
      projects: [],
      spaces: [],
    },
    owner: owner.user,
    memberships: MEMBERSHIPS,
    teams: [],
    members: MEMBERSHIPS.map((m) => m.user),
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
  };
}

const DEMO = findProfile('demo');

/** Column-name → value, so assertions read as rows rather than as indices. */
function asRecords(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): readonly Record<string, unknown>[] {
  // `working_days::smallint[]` — the cast is part of the column spec, not the name.
  const names = columns.map((column) => column.split('::')[0] ?? column);
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

const USER_IDS = MEMBERSHIPS.map((m) => m.user.id);
const MEMBER_READ_HOLDERS = MEMBERSHIPS.filter((m) => roleGrants(m.role, 'member:read')).map(
  (m) => m.user.id,
);
const PLAN_INDEX = new Map(USER_IDS.map((userId, index) => [userId, index]));

async function seedPeople(
  mix: Partial<PeopleMix> = {},
  seed = 'people-test',
): Promise<{
  harness: Harness;
  profiles: readonly Record<string, unknown>[];
  membershipProfiles: readonly Record<string, unknown>[];
}> {
  const profile: Profile = { ...DEMO, people: { ...DEMO.people, ...mix } };
  const harness = harnessFor(profile, orgWith(), seed);
  await peopleModule.seed(harness.ctx);

  return {
    harness,
    profiles: asRecords(harness.columnsOf('people.profiles'), harness.rowsOf('people.profiles')),
    membershipProfiles: asRecords(
      harness.columnsOf('people.membership_profiles'),
      harness.rowsOf('people.membership_profiles'),
    ),
  };
}

/* -------------------------------------------------------------------------- *
 * The personal profile — people.profiles
 * -------------------------------------------------------------------------- */

describe('people.profiles — the personal profile', () => {
  it('writes at most one row per user, all referencing real users', async () => {
    const { profiles } = await seedPeople({ profileRate: 1 });

    const ids = profiles.map((row) => String(row['user_id']));
    expect(new Set(ids).size).toBe(ids.length);
    for (const userId of ids) expect(USER_IDS).toContain(userId);
  });

  it('writes ONE personal profile for a user shared across two orgs', async () => {
    /* The whole reason `usersById` exists (see the module header): the demo
       profile's cross-org users would otherwise be written twice and trip
       `profiles_pkey`. Their MEMBERSHIP rows must stay one per org — the
       personal profile is global, the org-scoped facts are not. */
    const shared = MEMBERSHIPS[1];
    const second = orgWith(); // same five users, a second tenant
    const profile: Profile = {
      ...DEMO,
      people: { ...DEMO.people, profileRate: 1, membershipProfileRate: 1 },
    };
    const harness = harnessFor(profile, orgWith(), 'two-org', [second]);
    await peopleModule.seed(harness.ctx);

    const profiles = asRecords(
      harness.columnsOf('people.profiles'),
      harness.rowsOf('people.profiles'),
    );
    expect(profiles.filter((row) => row['user_id'] === shared?.user.id)).toHaveLength(1);

    const membershipProfiles = asRecords(
      harness.columnsOf('people.membership_profiles'),
      harness.rowsOf('people.membership_profiles'),
    );
    expect(membershipProfiles.filter((row) => row['user_id'] === shared?.user.id)).toHaveLength(2);
  });

  it('produces a mix of present and absent rows under the demo rates', async () => {
    // profileRate 0.9 over 5 users with the fixed seed 'mix-e' draws 4
    // profiles — a deterministic mix, so the absent-row-is-all-null read
    // path has someone to answer null for in the same run as a populated
    // row. (The default test seed happens to roll all five, which proves
    // the rate but not the mix.)
    const { profiles } = await seedPeople({}, 'mix-e');
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.length).toBeLessThan(5);
  });

  it('never writes a blank display name, and stays under the 80-char CHECK', async () => {
    const { profiles } = await seedPeople({ profileRate: 1, displayNameRate: 1 });
    for (const row of profiles) {
      const name = String(row['display_name']);
      expect(name.trim().length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(80);
    }
  });

  it('writes only timezones the API would accept', async () => {
    /* Migration 0030's CHECK bounds length only — IANA names are not
       expressible in SQL, and the API is the validator (profile.service.ts's
       Intl.supportedValuesOf check). A seeded zone the service would refuse
       is a row the product could not have stored. */
    const { profiles } = await seedPeople({ profileRate: 1, timezoneRate: 1 });
    const valid = new Set(Intl.supportedValuesOf('timeZone'));
    for (const row of profiles) expect(valid.has(String(row['timezone']))).toBe(true);
  });

  it('keeps a working-hours window forward and its days within 1..7', async () => {
    const { profiles } = await seedPeople({ profileRate: 1, workingHoursRate: 1 });
    expect(profiles.length).toBeGreaterThan(0);

    for (const row of profiles) {
      const start = String(row['working_hours_start']);
      const end = String(row['working_hours_end']);
      expect(end > start).toBe(true); // profiles_working_window, mirrored
      const days = row['working_days'] as readonly number[];
      expect(days.length).toBeGreaterThan(0);
      for (const day of days) expect(day).toBeGreaterThanOrEqual(1);
      for (const day of days) expect(day).toBeLessThanOrEqual(7);
    }
  });

  it('keeps every OOO window running forward', async () => {
    const { profiles } = await seedPeople({ profileRate: 1, oooRate: 1 });
    expect(profiles.some((row) => row['ooo_from'] !== null)).toBe(true);

    for (const row of profiles) {
      const from = row['ooo_from'] as Date | null;
      const until = row['ooo_until'] as Date | null;
      if (from === null || until === null) continue;
      expect(from.getTime()).toBeLessThan(until.getTime()); // profiles_ooo_window
      const message = String(row['ooo_message']);
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(200);
    }
  });

  it('produces active, upcoming and past OOO windows across the default share', async () => {
    const { profiles } = await seedPeople({ profileRate: 1, oooRate: 1 });
    const now = new Date('2026-08-06T12:00:00.000Z').getTime();

    const states = profiles.map((row) => {
      const from = (row['ooo_from'] as Date | null)?.getTime() ?? null;
      const until = (row['ooo_until'] as Date | null)?.getTime() ?? null;
      if (from === null || until === null) return null;
      if (from <= now && now < until) return 'active';
      if (now < from) return 'upcoming';
      return 'past';
    });

    // oooActiveShare 0.5 with a fixed seed — the shapes, not the counts.
    expect(states.some((state) => state === 'active')).toBe(true);
    expect(
      states.some((state) => state === 'upcoming') || states.some((state) => state === 'past'),
    ).toBe(true);
  });

  it('writes the personal profile with NO org scope — the table has none', async () => {
    const { harness } = await seedPeople({ profileRate: 1 });
    const profileInsert = harness.inserts.find((i) => i.table === 'people.profiles');
    expect(profileInsert).toBeDefined();
    // identity.users' sibling: a no-tenant table written with the scope
    // cleared, exactly as that module does.
    expect(profileInsert?.orgId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * The membership profile — people.membership_profiles and the org chart
 * -------------------------------------------------------------------------- */

describe('people.membership_profiles — the org-scoped half', () => {
  it('writes every row inside an org scope, and only for real memberships', async () => {
    const { harness, membershipProfiles } = await seedPeople({ membershipProfileRate: 1 });
    expect(membershipProfiles.length).toBeGreaterThan(0);

    const insert = harness.inserts.find((i) => i.table === 'people.membership_profiles');
    expect(insert?.orgId).toBe(ORG_ID); // the composite FKs need the scope to see any rows

    const pairs = MEMBERSHIPS.map((m) => `${ORG_ID}:${m.user.id}`);
    for (const row of membershipProfiles) {
      expect(pairs).toContain(`${String(row['org_id'])}:${String(row['user_id'])}`);
    }
  });

  it('never lets a manager be the member themself', async () => {
    const { membershipProfiles } = await seedPeople({ membershipProfileRate: 1, managerRate: 1 });
    for (const row of membershipProfiles) {
      expect(row['manager_user_id']).not.toBe(row['user_id']); // the CHECK, mirrored
    }
  });

  it('draws every manager from an EARLIER plan index — the graph is acyclic by construction', async () => {
    /* The property the database cannot express: a cycle is legal SQL, and only
       the service's walk (reporting.service.ts) would catch it. The seeder
       must produce graphs a walk cannot fail on. */
    const { membershipProfiles } = await seedPeople({ membershipProfileRate: 1, managerRate: 1 });

    for (const row of membershipProfiles) {
      const manager = row['manager_user_id'];
      if (typeof manager !== 'string') continue;
      const ownIndex = PLAN_INDEX.get(String(row['user_id']));
      const managerIndex = PLAN_INDEX.get(manager);
      expect(ownIndex).toBeDefined();
      expect(managerIndex).toBeDefined();
      expect(managerIndex).toBeLessThan(ownIndex ?? -1);
    }
  });

  it('never lets a guest manage anyone', async () => {
    /* A guest's role grants nothing — decide.test.ts asserts it — so a guest
       in the manager column would be a person who cannot read the directory
       nonetheless standing at the top of the chart. */
    const { membershipProfiles } = await seedPeople({ membershipProfileRate: 1, managerRate: 1 });
    const managers = membershipProfiles
      .map((row) => row['manager_user_id'])
      .filter((manager): manager is string => manager !== null);
    for (const manager of managers) {
      expect(MEMBER_READ_HOLDERS).toContain(manager);
    }
  });

  it('gives the owner no manager — the root of the tree', async () => {
    const { membershipProfiles } = await seedPeople({ membershipProfileRate: 1, managerRate: 1 });
    const ownerRow = membershipProfiles.find((row) => row['user_id'] === MEMBERSHIPS[0]?.user.id);
    expect(ownerRow?.['manager_user_id']).toBeNull();
  });

  it('keeps a member with a manager and one without, under the demo rates', async () => {
    const { membershipProfiles } = await seedPeople({ membershipProfileRate: 1 });
    expect(membershipProfiles.some((row) => row['manager_user_id'] !== null)).toBe(true);
    expect(membershipProfiles.some((row) => row['manager_user_id'] === null)).toBe(true);
  });

  it('produces a mix of present and absent work phones, all E.164-valid, under the demo rates', async () => {
    /* The CHECK constraint itself (migration 0039), not a restatement of it —
       a passing test here and a failing INSERT against real Postgres would
       mean this regex drifted from the one the database actually enforces. */
    const E164 = /^\+[1-9][0-9]{1,14}$/;
    const { membershipProfiles } = await seedPeople({ membershipProfileRate: 1 });
    expect(membershipProfiles.some((row) => row['work_phone'] !== null)).toBe(true);
    expect(membershipProfiles.some((row) => row['work_phone'] === null)).toBe(true);
    for (const row of membershipProfiles) {
      const phone = row['work_phone'];
      if (phone !== null) expect(phone).toMatch(E164);
    }
  });

  it('writes no work phone when workPhoneRate is 0', async () => {
    const { membershipProfiles } = await seedPeople({
      membershipProfileRate: 1,
      workPhoneRate: 0,
    });
    expect(membershipProfiles.every((row) => row['work_phone'] === null)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Events
 * -------------------------------------------------------------------------- */

describe('people.profiles — events', () => {
  it('emits reporting_line.changed for exactly the managers it writes, attributed to the owner', async () => {
    const { harness, membershipProfiles } = await seedPeople({
      membershipProfileRate: 1,
      managerRate: 1,
    });
    const managed = membershipProfiles.filter((row) => row['manager_user_id'] !== null);

    const changed = harness.events.filter((event) => event.name === 'reporting_line.changed');
    expect(changed.length).toBe(managed.length);

    for (const event of changed) {
      const payload = event.payload as {
        readonly orgId: string;
        readonly userId: string;
        readonly before: string | null;
        readonly after: string | null;
      };
      expect(payload.orgId).toBe(ORG_ID); // org-scoped, outbox-safe
      expect(event.orgId).toBe(ORG_ID);
      expect(payload.before).toBeNull(); // a first write
      expect(event.actorId).toBe(MEMBERSHIPS[0]?.user.id); // admin-only operation

      const row = membershipProfiles.find((r) => r['user_id'] === payload.userId);
      expect(row?.['manager_user_id']).toBe(payload.after);
    }
  });

  it('emits membership_profile.updated with changed listing exactly the fields set, actor = self', async () => {
    const { harness, membershipProfiles } = await seedPeople({
      membershipProfileRate: 1,
      jobTitleRate: 1,
      departmentRate: 0, // every row has a title, none a department
      workPhoneRate: 0, // ...and none a work phone
    });
    const updated = harness.events.filter((event) => event.name === 'membership_profile.updated');
    expect(updated.length).toBe(membershipProfiles.length);

    for (const event of updated) {
      const payload = event.payload as {
        readonly orgId: string;
        readonly userId: string;
        readonly changed: readonly string[];
        readonly before: {
          readonly jobTitle: string | null;
          readonly department: string | null;
          readonly workPhone: string | null;
        };
        readonly after: {
          readonly jobTitle: string | null;
          readonly department: string | null;
          readonly workPhone: string | null;
        };
      };
      expect(payload.orgId).toBe(ORG_ID);
      expect(payload.changed).toEqual(['jobTitle']); // departmentRate 0
      expect(payload.before).toEqual({ jobTitle: null, department: null, workPhone: null });

      const row = membershipProfiles.find((r) => r['user_id'] === payload.userId);
      expect(row?.['job_title']).toBe(payload.after.jobTitle);
      expect(payload.after.department).toBeNull();
      expect(payload.after.workPhone).toBeNull(); // workPhoneRate 0
      expect(event.actorId).toBe(payload.userId); // self-service (§3.6)
    }
  });

  it('never emits profile.updated — SYSTEM_ORG cannot pass the outbox RLS', async () => {
    /* events.ts routes profile.updated through the in-memory bus for exactly
       this reason; a seeder that buffered it would trip platform.outbox's
       WITH CHECK on the way to the audit log. */
    const { harness } = await seedPeople({ profileRate: 1 });
    expect(harness.events.some((event) => event.name === 'profile.updated')).toBe(false);
  });

  it('buffers no events at all when nothing is written', async () => {
    const { harness } = await seedPeople({
      profileRate: 0,
      membershipProfileRate: 0,
      managerRate: 0,
    });
    expect(harness.events).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- *
 * Determinism and the profiles
 * -------------------------------------------------------------------------- */

describe('people.profiles — determinism and plans', () => {
  it('is byte-for-byte reproducible from the same seed', async () => {
    const first = await seedPeople({}, 'same');
    const second = await seedPeople({}, 'same');
    expect(first.profiles).toEqual(second.profiles);
    expect(first.membershipProfiles).toEqual(second.membershipProfiles);

    /* Events compared minus `id`: createEvent mints each id with
       @taskflow/security's newId(), which is random by design — the seeded
       ROW content is deterministic, the event envelope's identity is not,
       and asserting it would fail on the second run. Everything that makes
       an event meaningful — name, org, actor, time, payload — is. */
    const withoutId = (events: readonly DomainEvent[]) =>
      events.map((event) => ({
        name: event.name,
        orgId: event.orgId,
        actorId: event.actorId,
        occurredAt: event.occurredAt,
        payload: event.payload,
      }));
    expect(withoutId(first.harness.events)).toEqual(withoutId(second.harness.events));
  });

  it('differs between seeds', async () => {
    const first = await seedPeople({}, 'one');
    const second = await seedPeople({}, 'two');
    expect(first.profiles).not.toEqual(second.profiles);
  });

  it('gives every profile a mix whose rates are probabilities', () => {
    const { people } = DEMO;
    for (const rate of Object.values(people)) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the shapes the phase depends on somewhere in the demo profile', () => {
    // profileRate < 1 — the absent-row-is-all-null read path has a fixture.
    expect(DEMO.people.profileRate).toBeLessThan(1);
    // A live OOO example in every run, not a rare draw.
    expect(DEMO.people.oooRate).toBeGreaterThan(0);
    // An org chart that actually renders edges.
    expect(DEMO.people.managerRate).toBeGreaterThan(0);
  });
});
