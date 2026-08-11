import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import { closeDatabase, eq, initializeDatabase, schema, withGlobalScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import * as directory from './directory.service.js';
import * as membership from './membership.service.js';
import * as profile from './profile.service.js';
import * as reporting from './reporting.service.js';

/**
 * People (Phase 11.5) against real Postgres — Waves 1 + 2
 * (ai/phase-11.5-people.md §5, §6).
 *
 * The properties worth a real database are the ones decided by something other
 * than this code: the composite foreign keys on `people.membership_profiles`
 * (a manager must be a membership IN THE SAME ORG — refused by the database,
 * not by a lookup), the tenant-isolation RLS on that table vs the deliberate
 * absence of RLS on `people.profiles`, the display-name expand step (a name
 * set through the NEW route lands in `people.profiles`, and the old
 * `auth.updateProfile` route is GONE), and the `profile.updated` event's
 * SYSTEM_ORG envelope.
 *
 * Fixture ids use the 0195ee08 prefix — the isolation mechanism is the
 * prefix, because turbo runs suites in parallel against one `taskflow_test`
 * (see chat.service.test.ts's header for the cautionary tale).
 */
const ALICE = unsafeAsId<'UserId'>('0195ee08-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee08-0000-7000-8000-000000000002');
const CAROL = unsafeAsId<'UserId'>('0195ee08-0000-7000-8000-000000000003');
/** Added to NO org by default — the "belongs to another tenant only" fixture. */
const DAVE = unsafeAsId<'UserId'>('0195ee08-0000-7000-8000-000000000004');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@people.test'],
  [BOB, 'bob@people.test'],
  [CAROL, 'carol@people.test'],
  [DAVE, 'dave@people.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee08-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];

async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error thrown';
  } catch (error) {
    return isAppError(error) ? error.code : `not an AppError: ${String(error)}`;
  }
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'people.membership_profiles',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** One org, ALICE the owner, BOB and CAROL members. DAVE is added ONLY when asked. */
async function scaffold(slug: string, withDave = false): Promise<OrgId> {
  const result = await orgs.createOrg(
    { name: `People ${slug}`, slug },
    { userId: ALICE, requestId },
  );
  created.push(result.orgId);

  for (const [userId, email] of USERS) {
    if (userId === ALICE) continue;
    if (userId === DAVE && !withDave) continue;
    await members.addMember(result.orgId, { email, role: 'member' }, { userId: ALICE, requestId });
  }
  return result.orgId;
}

const actor = (orgId: OrgId | null, userId: UserId = ALICE) => ({
  userId,
  orgId,
  requestId,
});

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'people-test' });
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('people.profile — Wave 1 personal fields', () => {
  it('returns the merged view with everything unset initially', async () => {
    await scaffold('profile-empty');
    const view = await profile.getProfile(ALICE);

    expect(view.email).toBe('alice@people.test');
    expect(view.displayName).toBeNull();
    expect(view.timezone).toBeNull();
    expect(view.workingHoursStart).toBeNull();
    expect(view.workingDays).toBeNull();
    expect(view.oooUntil).toBeNull();
    expect(view.emailVerified).toBe(true);
    expect(view.createdAt).toBeInstanceOf(Date);
  });

  it('sets display name, timezone, working hours and OOO in one patch', async () => {
    await scaffold('profile-set');
    const bus = new RecordingEventBus();

    const { changed } = await profile.updateProfile({ events: bus }, actor(null), {
      displayName: '  Alice Doe  ',
      timezone: 'America/Chicago',
      workingHoursStart: '09:00',
      workingHoursEnd: '17:30',
      workingDays: [1, 2, 3, 4, 5],
      oooUntil: '2026-09-01T00:00:00.000Z',
      oooMessage: 'On leave',
    });

    expect([...changed].sort()).toEqual([
      'displayName',
      'oooMessage',
      'oooUntil',
      'timezone',
      'workingDays',
      'workingHoursEnd',
      'workingHoursStart',
    ]);

    const view = await profile.getProfile(ALICE);
    expect(view.displayName).toBe('Alice Doe'); // trimmed
    expect(view.timezone).toBe('America/Chicago');
    expect(view.workingHoursStart).toBe('09:00:00'); // padded to Postgres time text
    expect(view.workingHoursEnd).toBe('17:30:00');
    expect(view.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(view.oooUntil?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(view.oooMessage).toBe('On leave');

    /* The event fires with a SYSTEM_ORG envelope — a profile fact is true of
       the person in every org, the identical sentinel the retired
       user.display_name_changed used. */
    const events = bus.events.filter((event) => event.name === 'profile.updated');
    expect(events).toHaveLength(1);
    expect(events[0]?.orgId).toBe('00000000-0000-7000-8000-000000000000');
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['userId']).toBe(ALICE);
    expect((payload['after'] as Record<string, unknown>)['displayName']).toBe('Alice Doe');
    expect((payload['before'] as Record<string, unknown>)['displayName']).toBeNull();
  });

  it('clears a field with null, and emits no event when nothing changed', async () => {
    await scaffold('profile-clear');
    const bus = new RecordingEventBus();
    const deps = { events: bus };

    await profile.updateProfile(deps, actor(null), { displayName: 'Alice Doe' });
    bus.events.length = 0;

    const noChange = await profile.updateProfile(deps, actor(null), { displayName: 'Alice Doe' });
    expect(noChange.changed).toEqual([]);
    expect(bus.events).toEqual([]);

    const cleared = await profile.updateProfile(deps, actor(null), { displayName: null });
    expect(cleared.changed).toEqual(['displayName']);
    expect((await profile.getProfile(ALICE)).displayName).toBeNull();
  });

  it('schedules OOO in advance with a start date', async () => {
    await scaffold('profile-ooo');
    await profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
      oooFrom: '2026-08-15T00:00:00.000Z',
      oooUntil: '2026-08-22T00:00:00.000Z',
      oooMessage: 'Vacation',
    });

    const view = await profile.getProfile(ALICE);
    expect(view.oooFrom?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(view.oooUntil?.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });

  it('refuses an impossible working-hours window with a validation error', async () => {
    await scaffold('profile-bad-hours');
    const code = await rejectionCode(() =>
      profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
        workingHoursStart: '17:00',
        workingHoursEnd: '09:00',
      }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('refuses a half-set window (start without end)', async () => {
    await scaffold('profile-half-window');
    const code = await rejectionCode(() =>
      profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
        workingHoursStart: '09:00',
      }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown timezone rather than storing a typo', async () => {
    await scaffold('profile-bad-tz');
    const code = await rejectionCode(() =>
      profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
        timezone: 'America/Nowhere',
      }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('refuses a scheduled OOO start without a return date', async () => {
    await scaffold('profile-ooo-no-end');
    const code = await rejectionCode(() =>
      profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
        oooFrom: '2026-08-15T00:00:00.000Z',
      }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('falls back to null — not UTC, not an error — when notification_prefs has no timezone', async () => {
    await scaffold('profile-tz-fallback');
    /* Earlier tests in this file wrote ALICE's profile row (they share the
       fixture user), so clear her own timezone first — this test is about the
       FALLBACK, not about a value already on the profile. */
    await profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
      timezone: null,
    });
    /* Phase 9's quiet-hours timezone column does not exist in this database,
       so §3.3's middle fallback rung resolves to null — the UI prompts for a
       timezone rather than inventing one. */
    const view = await profile.getProfile(ALICE);
    expect(view.timezone).toBeNull();
  });
});

describe('people.profile — the old auth.updateProfile route is gone (§3.2)', () => {
  it('rejects a call to the retired route', async () => {
    /* A stale client that kept calling auth.updateProfile must fail loudly,
       not silently write the old identity.users column. Asserted through the
       real router's manifest: the route must not exist anywhere — a
       route-removed assertion, not merely "the function is gone". */
    const { routeManifest } = await import('../trpc/manifest.js');
    const { testAppRouter } = await import('../testing/fixtures.js');
    const { router } = testAppRouter();

    const paths = routeManifest(router).map((entry) => entry.path);
    expect(paths).not.toContain('auth.updateProfile');
    expect(paths).toContain('people.profile.update');
  });
});

describe('people.profile — Wave 2 self-service job title (§3.6)', () => {
  it('lets a member set their own job title inside an org', async () => {
    const orgId = await scaffold('self-title');
    const bus = new RecordingEventBus();

    const { changed } = await profile.updateProfile({ events: bus }, actor(orgId, BOB), {
      jobTitle: 'Engineer',
      department: 'Engineering',
    });
    expect(changed).toEqual([]); // personal fields unchanged — jobTitle is a membership fact

    const member = await directory.getDirectoryMember(orgId, BOB);
    expect(member.jobTitle).toBe('Engineer');
    expect(member.department).toBe('Engineering');
  });

  it('refuses a job title with no org selected — there is no membership to write it to', async () => {
    const code = await rejectionCode(() =>
      profile.updateProfile({ events: new RecordingEventBus() }, actor(null, BOB), {
        jobTitle: 'Engineer',
      }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });
});

describe('people.directory — Wave 1 listing and detail', () => {
  it('lists every member with their merged profile', async () => {
    const orgId = await scaffold('directory-list');
    await profile.updateProfile({ events: new RecordingEventBus() }, actor(orgId, BOB), {
      displayName: 'Bob Builder',
      timezone: 'Europe/London',
    });

    const { members, nextCursor } = await directory.listDirectory(orgId, null, 50);
    const ids = members.map((member) => member.userId).sort();

    expect(ids).toEqual([ALICE, BOB, CAROL].sort());
    expect(nextCursor).toBeNull();
    const bob = members.find((member) => member.userId === BOB);
    expect(bob?.displayName).toBe('Bob Builder');
    expect(bob?.timezone).toBe('Europe/London');
    expect(bob?.role).toBe('member');
  });

  it('paginates with a user-id cursor and no ties', async () => {
    const orgId = await scaffold('directory-paging');

    const pageOne = await directory.listDirectory(orgId, null, 2);
    expect(pageOne.members).toHaveLength(2);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = await directory.listDirectory(orgId, pageOne.nextCursor, 2);
    expect(pageTwo.members).toHaveLength(1);
    expect(pageTwo.nextCursor).toBeNull();

    const ids = [...pageOne.members, ...pageTwo.members].map((member) => member.userId);
    expect(new Set(ids).size).toBe(3); // no duplicates, no gaps
  });

  it('resolves manager and direct reports for the org-chart view', async () => {
    const orgId = await scaffold('directory-chart');
    await profile.updateProfile({ events: new RecordingEventBus() }, actor(orgId, ALICE), {
      displayName: 'Alice Owner',
    });
    await reporting.setReportingLine(orgId, actor(orgId), { userId: BOB, managerUserId: ALICE });
    await reporting.setReportingLine(orgId, actor(orgId), { userId: CAROL, managerUserId: ALICE });

    const detail = await directory.getDirectoryMember(orgId, BOB);
    expect(detail.manager?.userId).toBe(ALICE);
    expect(detail.manager?.displayName).toBe('Alice Owner');

    const boss = await directory.getDirectoryMember(orgId, ALICE);
    expect(boss.directReports.map((report) => report.userId).sort()).toEqual([BOB, CAROL].sort());
  });

  it('answers NOT_FOUND for a member of another org', async () => {
    const orgA = await scaffold('directory-a');
    const orgB = await scaffold('directory-b', true); // DAVE joins org B only
    void orgB;
    const code = await rejectionCode(() => directory.getDirectoryMember(orgA, DAVE));
    expect(code).toBe('NOT_FOUND');
  });
});

describe('people.reportingLine — Wave 2 cycles and containment', () => {
  it('sets and clears a reporting line', async () => {
    const orgId = await scaffold('reporting-basic');

    const set = await reporting.setReportingLine(orgId, actor(orgId), {
      userId: BOB,
      managerUserId: ALICE,
    });
    expect(set).toEqual({ before: null, after: ALICE });

    const cleared = await reporting.setReportingLine(orgId, actor(orgId), {
      userId: BOB,
      managerUserId: null,
    });
    expect(cleared).toEqual({ before: ALICE, after: null });
  });

  it('refuses a direct self-report with a validation error, not a constraint-violation 500', async () => {
    const orgId = await scaffold('reporting-self');
    const code = await rejectionCode(() =>
      reporting.setReportingLine(orgId, actor(orgId), { userId: BOB, managerUserId: BOB }),
    );
    expect(code).toBe('VALIDATION_FAILED');
  });

  it('refuses a transitive cycle (A manages B, B manages A) with a validation error', async () => {
    const orgId = await scaffold('reporting-cycle');
    await reporting.setReportingLine(orgId, actor(orgId), { userId: BOB, managerUserId: ALICE });
    await reporting.setReportingLine(orgId, actor(orgId), { userId: CAROL, managerUserId: BOB });

    const code = await rejectionCode(() =>
      reporting.setReportingLine(orgId, actor(orgId), { userId: ALICE, managerUserId: CAROL }),
    );
    expect(code).toBe('VALIDATION_FAILED');

    /* And the three-deep chain back to the top. */
    const deep = await rejectionCode(() =>
      reporting.setReportingLine(orgId, actor(orgId), { userId: BOB, managerUserId: CAROL }),
    );
    expect(deep).toBe('VALIDATION_FAILED');
  });
});

describe('people.membership_profiles — containment and RLS (migration 0031)', () => {
  it('refuses a manager who is a member of a DIFFERENT org at the database', async () => {
    const orgA = await scaffold('fk-org-a');
    const orgB = await scaffold('fk-org-b', true); // DAVE joins org B only

    /* DAVE is a member of org B and NOT org A. An org-A profile row naming
       DAVE as manager must be refused by the composite FK (org_id,
       manager_user_id) -> memberships (org_id, user_id) — an id alone is not
       a membership. Proven with raw SQL as the migrator, because no service
       path can even construct the attempt (RLS scopes org A's writes to
       org A's rows before the FK is consulted).

       The insert runs SCOPED TO ORG A — a raw insert with app.org_id unset
       would fail RLS's WITH CHECK (org_id = NULL is UNKNOWN) BEFORE the FK
       is consulted, which proves nothing about the FK. Scoping to org A
       makes RLS pass and the composite FK the thing that refuses. */
    await admin.setOrg(orgA);
    const violated = await admin
      .query(
        `INSERT INTO people.membership_profiles (org_id, user_id, manager_user_id)
         VALUES ($1, $2, $3)`,
        [orgA, CAROL, DAVE],
      )
      .then(
        () => null,
        (error: unknown) => String(error),
      );

    expect(violated).toMatch(/foreign key|violates foreign key/i);
    void orgB;
  });

  it('isolates membership profiles by tenant — org B rows never surface in org A', async () => {
    const orgA = await scaffold('rls-a');
    const orgB = await scaffold('rls-b');

    /* BOB is a member of BOTH orgs. Give him an org-B manager only. */
    await reporting.setReportingLine(orgB, actor(orgB), { userId: BOB, managerUserId: ALICE });

    /* Org A's directory still lists BOB (he IS an org-A member) — but his
       org-B reporting line must not leak through the left join, which is
       scoped to org A's membership_profiles rows by RLS. */
    const { members } = await directory.listDirectory(orgA, null, 50);
    const bobInA = members.find((member) => member.userId === BOB);
    expect(bobInA?.managerUserId).toBeNull();
    expect(bobInA?.jobTitle).toBeNull();
  });

  it('leaves people.profiles readable for ANY caller — no RLS by design (§3.7)', async () => {
    await scaffold('no-rls');
    await profile.updateProfile({ events: new RecordingEventBus() }, actor(null, BOB), {
      displayName: 'Bob Builder',
    });

    /* A raw read of another user's profile row succeeds in any scope. If
       someone ever added a self-only policy to people.profiles, this query
       would return zero rows and the directory would break — which is exactly
       the regression the plan's §6 RLS-split test exists to catch. */
    const rows = await withGlobalScope(async (tx) =>
      tx
        .select({ displayName: schema.profiles.displayName })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, BOB)),
    );
    expect(rows[0]?.displayName).toBe('Bob Builder');
  });
});

describe('people.profile.exportMine — self-serve DSAR export (Phase 12 Wave 2 §3.6)', () => {
  it('exports the caller’s account data across every org, minus credentials', async () => {
    /* ALICE owns both orgs — the export must span them, with no org selected. */
    await scaffold('export-a');
    await scaffold('export-b');
    await profile.updateProfile({ events: new RecordingEventBus() }, actor(null), {
      displayName: 'Alice Owner',
      timezone: 'America/New_York',
    });

    /* A live session and a linked OAuth identity — inserted as the migrator:
       both tables carry no RLS and no service path is needed to seed them. */
    await admin.setOrg(null);
    await admin.query(
      `INSERT INTO identity.sessions (id, user_id, authenticated_at, expires_at, ip, user_agent, country)
       VALUES ($1, $2, now(), now() + interval '30 days', '203.0.113.9', 'DSAR test agent', 'US')`,
      ['0195ee08-0000-7000-8000-0000000000d1', ALICE],
    );
    await admin.query(
      `INSERT INTO identity.oauth_identities (id, user_id, provider, provider_user_id, email)
       VALUES ($1, $2, 'google', 'google-subject-1', 'alice@gmail.com')`,
      ['0195ee08-0000-7000-8000-0000000000d2', ALICE],
    );

    const bus = new RecordingEventBus();
    const data = await profile.exportMine({ events: bus }, { userId: ALICE, requestId });

    expect(data.account.email).toBe('alice@people.test');
    expect(data.account.displayName).toBe('Alice Owner');
    expect(data.account.emailVerified).toBe(true);

    /* Both memberships, joined with their org names — through the same
       self-read policies the org switcher uses. (No role assertions here:
       inline role comparisons are the one guardrail-7 ban, and the export's
       membership fact is the ORG list, not the role.) */
    const orgNames = data.memberships.map((membership) => membership.orgName);
    expect(orgNames.length).toBeGreaterThanOrEqual(2);
    expect(orgNames).toContain('People export-a');
    expect(orgNames).toContain('People export-b');

    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]).toMatchObject({ ip: '203.0.113.9', country: 'US' });

    /* Provider + email, never the provider's subject id. */
    expect(data.oauthIdentities).toHaveLength(1);
    expect(data.oauthIdentities[0]).toMatchObject({
      provider: 'google',
      email: 'alice@gmail.com',
    });

    expect(data.profile?.timezone).toBe('America/New_York');

    /* No credentials anywhere in the document — no password hash (never
       selected), no provider subject id (excluded by design), no token. */
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('google-subject-1');

    /* The event records that the export happened — never its contents. */
    expect(bus.events.some((event) => event.name === 'user.data_exported')).toBe(true);
  });
});

describe('people.membershipProfile.update — admin edits another member (Wave 2)', () => {
  it('sets another member’s job title and department', async () => {
    const orgId = await scaffold('admin-title');

    const { changed } = await membership.updateMembershipProfile(orgId, actor(orgId), CAROL, {
      jobTitle: 'Designer',
    });
    expect(changed).toEqual(['jobTitle']);

    const detail = await directory.getDirectoryMember(orgId, CAROL);
    expect(detail.jobTitle).toBe('Designer');
    expect(detail.department).toBeNull();
  });

  it('answers NOT_FOUND for a target who is not a member of this org', async () => {
    const orgA = await scaffold('admin-not-found'); // DAVE is not a member here
    const code = await rejectionCode(() =>
      membership.updateMembershipProfile(orgA, actor(orgA), DAVE, { jobTitle: 'X' }),
    );
    expect(code).toBe('NOT_FOUND');
  });
});
